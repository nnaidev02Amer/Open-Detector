"""Download small, licensed subsets of public datasets and build a reproducible evaluation set.

Sources (licences verified on the Hugging Face dataset cards / API, 2026-11):
  * Hello-SimpleAI/HC3  - CC-BY-SA-4.0 - human vs ChatGPT answers (we use 4 subsets, ~18 MB; Reddit ELI5 skipped)
  * yaful/MAGE          - Apache-2.0   - human vs 27 LLMs; we use test.csv (72 MB) and the small OOD file (2 MB)

Output (evaluation/data/):
  raw/...             downloaded files (kept so re-runs do not re-download)
  eval_set.jsonl      one record per text: id, text, label (1 = AI, 0 = human), dataset, group
  manifest.json       seed, sizes, counts, URLs, licences, SHA-256 of every raw file

Usage:  python evaluation/collect_data.py [--seed 13] [--hc3-per-class 250] [--mage-per-class 500] [--ood-per-class 150]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import random
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

csv.field_size_limit(2**30)
ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"
HF = "https://huggingface.co/datasets"

HC3_FILES = ["wiki_csai", "finance", "medicine", "open_qa"]
MIN_WORDS, MAX_WORDS = 40, 400   # same minimum the application enforces; cap keeps within the 512-token window


def words(t: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", t))


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  have {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "open-detector-evaluation"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest.with_suffix(".part"), "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    dest.with_suffix(".part").replace(dest)
    print(f"  saved {dest.name} ({dest.stat().st_size/1e6:.1f} MB)")
    return dest


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def clean(t: str) -> str:
    return re.sub(r"[ \t]+", " ", t.replace("\r", "")).strip()


def load_hc3() -> list[dict]:
    recs = []
    for name in HC3_FILES:
        p = download(f"{HF}/Hello-SimpleAI/HC3/resolve/main/{name}.jsonl", RAW / "hc3" / f"{name}.jsonl")
        for ln in p.read_text(encoding="utf-8").splitlines():
            row = json.loads(ln)
            for t in row.get("human_answers", []):
                recs.append(dict(text=clean(t), label=0, dataset="HC3", group=name))
            for t in row.get("chatgpt_answers", []):
                recs.append(dict(text=clean(t), label=1, dataset="HC3", group=name))
    return recs


def load_mage(fname: str, dataset: str) -> list[dict]:
    p = download(f"{HF}/yaful/MAGE/resolve/main/{fname}", RAW / "mage" / fname)
    rows = list(csv.DictReader(io.StringIO(p.read_text(encoding="utf-8-sig"), newline="")))
    # Verify the label convention from the data instead of assuming it: the `src` column names the writer.
    votes = defaultdict(Counter)
    for r in rows:
        votes[r["label"]]["human" if "human" in r["src"].lower() else "machine"] += 1
    print(f"  {fname}: label vs src -> {({k: dict(v) for k, v in votes.items()})}")
    human_label = max(votes, key=lambda k: votes[k]["human"] / max(1, sum(votes[k].values())))
    machine_label = [k for k in votes if k != human_label][0]
    ok = votes[human_label]["human"] > 0.95 * sum(votes[human_label].values()) and \
        votes[machine_label]["machine"] > 0.95 * sum(votes[machine_label].values())
    if not ok:
        sys.exit(f"Cannot establish MAGE label convention for {fname}; refusing to guess.")
    return [dict(text=clean(r["text"]), label=0 if r["label"] == human_label else 1, dataset=dataset,
                 group=r["src"].split("_")[0]) for r in rows]


def sample(recs: list[dict], per_class: int, rng: random.Random, strat: str = "group") -> list[dict]:
    """Up to `per_class` records per label, spread evenly over the groups (e.g. HC3 subsets)."""
    recs = [r for r in recs if MIN_WORDS <= words(r["text"]) <= MAX_WORDS]
    seen, uniq = set(), []
    for r in recs:
        k = r["text"][:300]
        if k not in seen:
            seen.add(k); uniq.append(r)
    out = []
    for label in (0, 1):
        by_group = defaultdict(list)
        for r in uniq:
            if r["label"] == label:
                by_group[r[strat]].append(r)
        for g in by_group.values():
            rng.shuffle(g)
        groups = sorted(by_group)
        quota = per_class // max(1, len(groups))
        taken = []
        for g in groups:
            taken += by_group[g][:quota]
        # top up from leftovers if some group was small
        left = [r for g in groups for r in by_group[g][quota:]]
        rng.shuffle(left)
        taken += left[: per_class - len(taken)]
        out += taken
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--hc3-per-class", type=int, default=250, help="per label, per HC3 subset (approx. total/4)")
    ap.add_argument("--mage-per-class", type=int, default=500)
    ap.add_argument("--ood-per-class", type=int, default=150)
    a = ap.parse_args()
    rng = random.Random(a.seed)

    print("HC3 (CC-BY-SA-4.0)")
    hc3 = sample(load_hc3(), a.hc3_per_class * len(HC3_FILES), rng)
    print("MAGE test.csv (Apache-2.0)")
    mage = sample(load_mage("test.csv", "MAGE"), a.mage_per_class, rng)
    print("MAGE OOD set, unseen generator (Apache-2.0)")
    ood = sample(load_mage("test_ood_set_gpt.csv", "MAGE-OOD"), a.ood_per_class, rng)

    allrecs = hc3 + mage + ood
    for i, r in enumerate(allrecs):
        r["id"] = f"{r['dataset']}-{i:05d}"
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "eval_set.jsonl", "w", encoding="utf-8") as f:
        for r in allrecs:
            f.write(json.dumps({k: r[k] for k in ("id", "text", "label", "dataset", "group")}, ensure_ascii=False) + "\n")

    counts = Counter((r["dataset"], "AI" if r["label"] else "human") for r in allrecs)
    manifest = {
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": a.seed,
        "filters": {"min_words": MIN_WORDS, "max_words": MAX_WORDS, "dedupe": "first 300 characters"},
        "label": "1 = AI-generated, 0 = human-written",
        "counts": {f"{d}/{l}": n for (d, l), n in sorted(counts.items())},
        "total": len(allrecs),
        "sources": [
            {"name": "HC3", "url": "https://huggingface.co/datasets/Hello-SimpleAI/HC3", "license": "CC-BY-SA-4.0",
             "subsets": HC3_FILES, "generators": ["ChatGPT (GPT-3.5, early 2023)"]},
            {"name": "MAGE", "url": "https://huggingface.co/datasets/yaful/MAGE", "license": "Apache-2.0",
             "files": ["test.csv", "test_ood_set_gpt.csv"], "generators": ["27 LLMs (see MAGE paper)"]},
        ],
        "raw_sha256": {str(p.relative_to(ROOT)): sha256(p) for p in sorted(RAW.rglob("*")) if p.is_file()},
        "caveats": [
            "None of these datasets is arXiv-style academic prose; they are out-of-domain for the model.",
            "The model's own training/test split is not public, so overlap with these public datasets cannot be ruled out.",
            "HC3 AI text is from ChatGPT (2023); newer LLMs may behave differently.",
        ],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nWrote {len(allrecs)} records -> {OUT / 'eval_set.jsonl'}")
    for k, v in manifest["counts"].items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
