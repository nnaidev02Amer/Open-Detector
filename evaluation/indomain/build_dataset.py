"""Assemble the in-domain evaluation dataset from human.jsonl (dated human sources) and the AI paragraphs written in-session.

Output (evaluation/indomain/):  dataset.jsonl, mixed_docs.jsonl, dataset_report.json
Design:
  * every human text has an AI counterpart on the same topic and in the same style (topic-matched, so topic is not a shortcut);
  * the split is by TOPIC (train 50% / val 20% / test 30%, stratified by style group, seed 13): both labels of a topic share a split;
  * leakage checks: topic overlap, exact duplicates, 8-gram Jaccard across splits and between AI and human texts of a topic;
  * mixed documents (4 paragraphs, 1-3 of them AI) are built inside each split from that split's paragraphs only.
"""
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from ai_wiki_a import AI_A  # noqa: E402
from ai_wiki_b import AI_B  # noqa: E402
from ai_tech_conv import AI_CONV, AI_TECH  # noqa: E402

SEED = 13
SPLITS = [("train", 0.5), ("val", 0.2), ("test", 0.3)]
GENERATOR = "claude-sonnet-5.5 (written in-session by the assistant, 2026-11-21)"
WIKI_AI = {**AI_A, **AI_B}


def words(t):
    return len(t.split())


def ngrams(t, n=8):
    w = re.findall(r"\w+", t.lower())
    return {tuple(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}


def jacc(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def main():
    human = [json.loads(l) for l in (ROOT / "human.jsonl").read_text(encoding="utf-8").splitlines()]
    for r in human:
        r["text"] = r["text"].replace("�", "'").replace("’", "'").replace("“", '"').replace("”", '"')
        r["words"] = words(r["text"])
    seen, h2 = set(), []
    for r in human:                                  # one answer per Stack Exchange question
        if r["style"] == "conversational":
            if r["topic"] in seen:
                continue
            seen.add(r["topic"])
        h2.append(r)
    human = h2

    recs = []
    for r in human:
        recs.append(dict(topic=r["topic"], style=r["style"], label=0, text=r["text"], source=r["source"], generator=None,
                         provenance={k: r.get(k) for k in ("title", "revid", "timestamp", "license")}))
    missing = []
    for r in human:
        t, st = r["topic"], r["style"]
        if st in ("simple_english", "formal"):
            name = next((k for k in WIKI_AI if "wiki:" + k.lower().replace(" ", "_") == t), None)
            ai = WIKI_AI[name][0 if st == "simple_english" else 1] if name else None
        elif st == "technical":
            ai = AI_TECH.get(t)
        else:
            ai = AI_CONV.get(t)
        if not ai:
            missing.append((t, st))
            continue
        recs.append(dict(topic=t, style=st, label=1, text=ai, source="AI-generated", generator=GENERATOR,
                         provenance={"title": r["title"], "prompt_style": {"simple_english": "explain simply for a beginner", "formal": "formal encyclopedic paragraph",
                                                                         "technical": "Python language reference style", "conversational": "friendly Stack Exchange answer"}[st]}))
    if missing:
        print("no AI counterpart for:", missing)
    # drop human texts whose AI counterpart is missing (keep the design balanced)
    keep = {(t, s) for t, s in {(r["topic"], r["style"]) for r in recs if r["label"] == 1}}
    recs = [r for r in recs if (r["topic"], r["style"]) in keep]

    # ---- split by topic, stratified by style group -------------------------------------------------
    rng = random.Random(SEED)
    groups = defaultdict(list)
    for t in sorted({r["topic"] for r in recs}):
        groups[t.split(":")[0]].append(t)
    split_of = {}
    for g, topics in groups.items():
        rng.shuffle(topics)
        n = len(topics)
        n_tr, n_va = round(n * SPLITS[0][1]), round(n * SPLITS[1][1])
        for i, t in enumerate(topics):
            split_of[t] = "train" if i < n_tr else "val" if i < n_tr + n_va else "test"
    for i, r in enumerate(sorted(recs, key=lambda x: (x["topic"], x["style"], x["label"]))):
        r["split"] = split_of[r["topic"]]
        r["id"] = f"{r['style'][:4]}-{r['topic'].replace(':', '_')}-{'ai' if r['label'] else 'hu'}"
        r["words"] = words(r["text"])
    recs.sort(key=lambda r: r["id"])

    # ---- leakage / sanity checks -------------------------------------------------------------------
    rep = {"seed": SEED, "generator": GENERATOR, "counts": {}, "checks": {}}
    for sp in ("train", "val", "test"):
        c = Counter((r["style"], r["label"]) for r in recs if r["split"] == sp)
        rep["counts"][sp] = {"total": sum(c.values()), "human": sum(v for (s, l), v in c.items() if l == 0), "ai": sum(v for (s, l), v in c.items() if l == 1),
                             "by_style": {s: {"human": c[(s, 0)], "ai": c[(s, 1)]} for s in ("simple_english", "formal", "technical", "conversational")}}
    topics = {sp: {r["topic"] for r in recs if r["split"] == sp} for sp in ("train", "val", "test")}
    rep["checks"]["topic_overlap"] = {f"{a}&{b}": len(topics[a] & topics[b]) for a, b in (("train", "val"), ("train", "test"), ("val", "test"))}
    texts = [r["text"] for r in recs]
    rep["checks"]["exact_duplicate_texts"] = len(texts) - len(set(texts))
    grams = {r["id"]: ngrams(r["text"]) for r in recs}
    worst = {}
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        best = (0.0, None)
        for x in (r for r in recs if r["split"] == a):
            for y in (r for r in recs if r["split"] == b):
                j = jacc(grams[x["id"]], grams[y["id"]])
                if j > best[0]:
                    best = (round(j, 3), [x["id"], y["id"]])
        worst[f"{a}&{b}"] = best
    rep["checks"]["max_8gram_jaccard_across_splits"] = worst
    cp = 0.0
    by_topic = defaultdict(list)
    for r in recs:
        by_topic[(r["topic"], r["style"])].append(r)
    for (t, s), rs in by_topic.items():
        h = next(r for r in rs if r["label"] == 0); a = next(r for r in rs if r["label"] == 1)
        cp = max(cp, jacc(grams[h["id"]], grams[a["id"]]))
    rep["checks"]["max_8gram_jaccard_ai_vs_human_same_topic"] = round(cp, 3)
    ml = defaultdict(list)
    for r in recs:
        ml[(r["style"], r["label"])].append(r["words"])
    rep["length_words_mean"] = {f"{s}/{'ai' if l else 'human'}": round(sum(v) / len(v), 1) for (s, l), v in sorted(ml.items())}
    rep["human_provenance_cutoff"] = "all human sources dated before 2022-06-01 (ChatGPT released 2022-11-30)"

    # ---- mixed documents ---------------------------------------------------------------------------
    mixed = []
    mrng = random.Random(SEED + 1)
    for sp, n_docs in (("train", 24), ("val", 12), ("test", 24)):
        pool_h = [r for r in recs if r["split"] == sp and r["label"] == 0]
        pool_a = [r for r in recs if r["split"] == sp and r["label"] == 1]
        for d in range(n_docs):
            k = mrng.choice([1, 2, 2, 3])                       # AI paragraphs in a 4-paragraph document
            picks = [mrng.choice(pool_a) for _ in range(k)] + [mrng.choice(pool_h) for _ in range(4 - k)]
            mrng.shuffle(picks)
            if len({p["id"] for p in picks}) < 4:
                continue
            mixed.append(dict(id=f"mixed-{sp}-{d:02d}", split=sp, ai_paragraphs=k, paragraph_ids=[p["id"] for p in picks],
                              labels=[p["label"] for p in picks], text="\n\n".join(p["text"] for p in picks)))
    rep["mixed_documents"] = dict(Counter(m["split"] for m in mixed))

    (ROOT / "dataset.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs), encoding="utf-8")
    (ROOT / "mixed_docs.jsonl").write_text("\n".join(json.dumps(m, ensure_ascii=False) for m in mixed), encoding="utf-8")
    (ROOT / "dataset_report.json").write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
