"""Collect HUMAN-written educational/technical paragraphs with verifiable provenance (all pre-ChatGPT).

Sources (nothing here is model-generated):
  simple_english : Simple English Wikipedia, last revision before 2022-06-01 (revision id + timestamp stored)
  formal         : English Wikipedia, last revision before 2022-06-01
  technical      : CPython 3.11 documentation text (pydoc_data.topics, written by the Python community)
  conversational : Stack Exchange answers (cs, physics, biology), created AND last edited before 2022-06-01, score >= 15
ChatGPT was released 2022-11-30; the cut-off leaves a 6-month safety margin.
Raw API responses are cached in indomain/raw/. Output: indomain/human.jsonl
"""
import gzip, hashlib, html, json, re, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"; RAW.mkdir(exist_ok=True)
UA = "OpenDetectorResearch/1.0 (local academic evaluation; no personal data)"
CUTOFF_ISO, CUTOFF_TS = "2022-06-01T00:00:00Z", 1654041600   # 2022-06-01 UTC
MIN_W, MAX_W = 55, 170

TOPICS = ["Photosynthesis", "Gravity", "Volcano", "Democracy", "Inflation", "Vaccine", "DNA", "Algorithm", "Internet",
          "Cryptography", "Machine learning", "Database", "Operating system", "Computer virus", "Climate change", "Evolution",
          "Black hole", "Electricity", "Magnetism", "Antibiotic", "Immune system", "Plate tectonics", "Solar System", "Atom",
          "Industrial Revolution", "Renaissance", "Supply and demand", "Web browser", "Programming language", "Artificial intelligence",
          "Respiration", "Ecosystem", "Probability", "Statistics", "Telescope", "Cell (biology)", "Protein",
          "Computer memory", "Search engine"]


def get(url, cache_key):
    f = RAW / (hashlib.sha1(cache_key.encode()).hexdigest()[:16] + ".json")
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
            break
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or attempt == 5:
                raise
            wait = int(e.headers.get("Retry-After", "0") or 0) or 15 * (attempt + 1)
            print(f"  rate limited, waiting {wait}s", flush=True)
            time.sleep(min(wait, 120))
    f.write_text(data.decode("utf-8"), encoding="utf-8")
    time.sleep(1.5)
    return json.loads(data)


def wiki_revision(lang, title):
    q = urllib.parse.urlencode({"action": "query", "prop": "revisions", "titles": title, "rvlimit": 1, "rvstart": CUTOFF_ISO, "rvdir": "older",
                                "rvprop": "timestamp|ids|content", "rvslots": "main", "format": "json", "formatversion": 2, "redirects": 1})
    j = get(f"https://{lang}.wikipedia.org/w/api.php?{q}", f"{lang}:{title}:{CUTOFF_ISO}")
    try:
        p = j["query"]["pages"][0]
        rv = p["revisions"][0]
        return p["title"], rv["revid"], rv["timestamp"], rv["slots"]["main"]["content"]
    except (KeyError, IndexError):
        return None


def strip_nested(s, o, c):
    pat = re.compile(re.escape(o) + "(?:(?!" + re.escape(o) + "|" + re.escape(c) + ").)*" + re.escape(c), re.S)
    while True:
        n = pat.sub("", s)
        if n == s:
            return s
        s = n


def wikitext_paragraphs(src):
    s = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    s = re.sub(r"<ref[^>]*?/>", "", s)
    s = re.sub(r"<ref[^>]*?>.*?</ref>", "", s, flags=re.S)
    s = strip_nested(s, "{{", "}}")
    s = re.sub(r"\{\|.*?\|\}", "", s, flags=re.S)
    s = re.sub(r"\[\[(?:File|Image|Category|Media):(?:[^\[\]]|\[\[[^\]]*\]\])*\]\]", "", s, flags=re.I)
    s = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+ ([^\]]*)\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\]", "", s)
    s = re.sub(r"'{2,}", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    out = []
    for blk in re.split(r"\n\s*\n", s):
        blk = blk.strip()
        if re.match(r"==+\s*(References|Other websites|See also|Notes|Related pages|Sources|Footnotes|External links)", blk, re.I):
            break
        if not blk or blk[0] in "*#:;|=!{}" or re.search(r"[|{}<>\[\]]", blk) or "\n" in blk:
            continue
        w = len(blk.split())
        if MIN_W <= w <= MAX_W and blk.rstrip()[-1] in ".!?\")" and not re.search(r"\b\d{4}\b.*\b\d{4}\b.*\b\d{4}\b", blk):
            out.append(blk)
    return out


def collect_wikipedia(rows):
    kept = 0
    for t in TOPICS:
        res = {}
        for lang in ("simple", "en"):
            r = wiki_revision(lang, t)
            if not r:
                break
            title, revid, ts, text = r
            ps = wikitext_paragraphs(text)
            if not ps:
                break
            res[lang] = (title, revid, ts, ps[0])
        if len(res) != 2:
            print("skip topic", t)
            continue
        topic = "wiki:" + t.lower().replace(" ", "_")
        for lang, style in (("simple", "simple_english"), ("en", "formal")):
            title, revid, ts, p = res[lang]
            rows.append(dict(topic=topic, style=style, label=0, source=f"{lang}.wikipedia.org", title=title, revid=revid, timestamp=ts,
                             license="CC BY-SA 3.0/4.0", text=p, words=len(p.split())))
        kept += 1
    print("wikipedia topics kept:", kept)


def collect_python(rows, n=24):
    import pydoc_data.topics as T
    cand = []
    for k, v in sorted(T.topics.items()):
        for blk in re.split(r"\n\s*\n", v):
            p = " ".join(blk.split())
            if MIN_W <= len(p.split()) <= MAX_W and re.match(r"[A-Z]", p) and p.endswith(".") and not re.search(r"[>|]{2}|^\W|::|\*\*|``|=\s|_[a-z]+_", p) \
                    and len(re.findall(r"[A-Za-z ,.'-]", p)) > 0.93 * len(p):
                cand.append((k, p))
                break
    step = max(1, len(cand) // n)
    for k, p in cand[::step][:n]:
        rows.append(dict(topic="py:" + k, style="technical", label=0, source="CPython 3.11 docs (pydoc_data.topics)", title=k, revid=None,
                         timestamp="2022-10 (Python 3.11 release)", license="PSF", text=p, words=len(p.split())))
    print("python topics:", len(cand[::step][:n]))


def clean_se(body):
    b = re.sub(r"<pre.*?</pre>", " ", body, flags=re.S)
    b = re.sub(r"<(code|blockquote)[^>]*>.*?</\1>", " ", b, flags=re.S)
    paras = [html.unescape(re.sub(r"<[^>]+>", "", p)).strip() for p in re.findall(r"<p>(.*?)</p>", b, flags=re.S)]
    paras = [" ".join(p.split()) for p in paras if p and "$" not in p and not re.search(r"https?://", p)]
    out = []
    for p in paras:
        out.append(p)
        if len(" ".join(out).split()) >= 70:
            break
    t = " ".join(out)
    return t if t and MIN_W <= len(t.split()) <= MAX_W + 30 and t[-1] in ".!?" else None


def collect_se(rows, per_site=9):
    for site in ("cs.stackexchange", "physics.stackexchange", "biology.stackexchange"):
        q = urllib.parse.urlencode({"pagesize": 100, "order": "desc", "sort": "votes", "todate": CUTOFF_TS, "site": site, "filter": "withbody", "min": 15})
        j = get(f"https://api.stackexchange.com/2.3/answers?{q}", f"se:{site}:{CUTOFF_TS}")
        picked = []
        for a in j.get("items", []):
            if a.get("last_edit_date", 0) >= CUTOFF_TS or a["creation_date"] >= CUTOFF_TS:
                continue
            t = clean_se(a["body"])
            if t:
                picked.append((a, t))
            if len(picked) >= per_site * 3:
                break
        ids = ";".join(str(a["question_id"]) for a, _ in picked)
        qj = get(f"https://api.stackexchange.com/2.3/questions/{ids}?site={site}&filter=default", f"seq:{site}:{ids}")
        titles = {x["question_id"]: html.unescape(x["title"]) for x in qj.get("items", [])}
        n = 0
        for a, t in picked:
            if a["question_id"] not in titles or n >= per_site:
                continue
            rows.append(dict(topic=f"se:{site.split('.')[0]}:{a['question_id']}", style="conversational", label=0, source=site + ".com", title=titles[a["question_id"]],
                             revid=a["answer_id"], timestamp=time.strftime("%Y-%m-%d", time.gmtime(a.get("last_edit_date", a["creation_date"]))),
                             license=a.get("content_license", "CC BY-SA"), text=t, words=len(t.split())))
            n += 1
        print(site, "answers kept:", n)


if __name__ == "__main__":
    rows = []
    collect_wikipedia(rows)
    collect_python(rows)
    collect_se(rows)
    seen, out = set(), []
    for r in rows:
        k = r["text"][:120]
        if k not in seen:
            seen.add(k)
            out.append(r)
    (ROOT / "human.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out), encoding="utf-8")
    from collections import Counter
    print(len(out), "human texts", dict(Counter(r["style"] for r in out)))
