"""Dual-model evaluation: Followsci BERT vs Fakespot RoBERTa on identical data, with separate validation/test splits.

* The evaluation set (evaluation/data/eval_set.jsonl) is split 50/50, seeded and stratified by (dataset, group, label)
  into a VALIDATION half and a TEST half. No text is in both.
* For each model independently, thresholds are chosen on the validation half only:
    - ai_above    : the lowest logit margin with validation false-positive rate <= 5%  (texts above it are "likely AI")
    - human_below : the highest logit margin that still keeps >= 95% of validation AI texts at or above it
                    (texts below it are "likely human"; in between is "uncertain"). Never above ai_above.
* Every number reported as a result is then measured on the TEST half. Nothing is tuned on it.
* Document level is approximated by building pseudo-documents of 4 same-label test texts and aggregating the
  word-weighted mean probability (the app's rule when each text is one chunk).
No training and no download: models load from the local Hugging Face cache; Followsci scores come from
results/scores.jsonl (produced by evaluate.py), Fakespot scores are cached in results/scores_fakespot.jsonl.

Outputs: detector/thresholds.json, results/dual_metrics.json, results/dual_report.md
Usage:   python evaluation/dual_eval.py [--seed 13]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
sys.path.insert(0, str(ROOT))
from evaluate import clf_metrics, load, sigmoid  # noqa: E402

RES = ROOT / "results"
TARGET_FPR, TARGET_RECALL, DOC_SIZE = 0.05, 0.95, 4


def read_cache(name):
    f = RES / name
    return {json.loads(l)["id"]: json.loads(l)["margin"] for l in f.read_text().splitlines()} if f.exists() else {}


def score_fakespot(recs):
    cache, f = read_cache("scores_fakespot.jsonl"), RES / "scores_fakespot.jsonl"
    todo = [r for r in recs if r["id"] not in cache]
    if todo:
        from detector.dual import HFDetector
        det = HFDetector()
        print(f"Fakespot: scoring {len(todo)} texts on {det.device} ...", flush=True)
        B = 16
        with open(f, "a", encoding="utf-8") as fh:
            for i in range(0, len(todo), B):
                chunk = todo[i:i + B]
                for r, m in zip(chunk, det.logit_margins([r["text"] for r in chunk], batch_size=B)):
                    cache[r["id"]] = m
                    fh.write(json.dumps({"id": r["id"], "margin": m}) + "\n")
                if (i // B) % 20 == 0:
                    print(f"  {i + len(chunk)}/{len(todo)}", flush=True)
    return cache


def split(recs, seed):
    rng, strata = random.Random(seed), defaultdict(list)
    for r in recs:
        strata[(r["dataset"], r["group"], r["label"])].append(r)
    val, test = [], []
    for key in sorted(strata):
        items = strata[key][:]
        rng.shuffle(items)
        h = len(items) // 2
        val += items[:h]
        test += items[h:]
    return val, test


def choose_thresholds(y, m):
    y, m = np.asarray(y), np.asarray(m)
    ai_above = float(np.quantile(m[y == 0], 1 - TARGET_FPR, method="higher")) + 1e-6   # margin >= this  <=> margin > quantile
    human_below = float(np.quantile(m[y == 1], 1 - TARGET_RECALL, method="lower"))
    return min(human_below, ai_above), ai_above


def three_way(y, m, lo, hi):
    y, m = np.asarray(y), np.asarray(m)
    ai, hu = m >= hi, m < lo
    unc = ~ai & ~hu
    return {"uncertain_share": float(unc.mean()),
            "human_called_ai": float(ai[y == 0].mean()), "human_uncertain": float(unc[y == 0].mean()),
            "ai_called_human": float(hu[y == 1].mean()), "ai_uncertain": float(unc[y == 1].mean()),
            "accuracy_on_decided": float(((ai[~unc]) == (y[~unc] == 1)).mean()) if (~unc).any() else None}


def per_group(recs, ym, hi):
    out = {}
    for name, sel in [("HC3", lambda r: r["dataset"] == "HC3"), ("MAGE", lambda r: r["dataset"] == "MAGE"),
                      ("MAGE-OOD", lambda r: r["dataset"] == "MAGE-OOD")] + \
                     [("HC3/" + g, (lambda g: lambda r: r["dataset"] == "HC3" and r["group"] == g)(g))
                      for g in ("wiki_csai", "finance", "medicine", "open_qa")] + [("ALL", lambda r: True)]:
        idx = [i for i, r in enumerate(recs) if sel(r)]
        out[name] = clf_metrics([recs[i]["label"] for i in idx], [ym[i] for i in idx], hi)
    return out


def pseudo_docs(recs, margins, seed):
    rng, strata = random.Random(seed), defaultdict(list)
    for r, m in zip(recs, margins):
        strata[(r["dataset"], r["group"], r["label"])].append((r, m))
    docs = []
    for key in sorted(strata):
        items = strata[key][:]
        rng.shuffle(items)
        for i in range(0, len(items) - DOC_SIZE + 1, DOC_SIZE):
            g = items[i:i + DOC_SIZE]
            w = np.array([max(1, len(r["text"].split())) for r, _ in g], float)
            p = np.array([sigmoid(m) for _, m in g])
            docs.append((key[2], float((p * w).sum() / w.sum())))
    return docs


def pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=13)
    seed = ap.parse_args().seed
    recs = load()
    fol = read_cache("scores.jsonl")
    if len(fol) < len(recs):
        sys.exit("Followsci scores missing: run evaluation/evaluate.py first.")
    fak = score_fakespot(recs)
    val, test = split(recs, seed)
    assert not ({r["id"] for r in val} & {r["id"] for r in test})
    scores = {"followsci": fol, "fakespot": fak}
    names = {"followsci": "Followsci BERT", "fakespot": "Fakespot RoBERTa"}
    metrics, thr_out = {}, {}
    for k, sc in scores.items():
        yv, mv = [r["label"] for r in val], [sc[r["id"]] for r in val]
        yt, mt = [r["label"] for r in test], [sc[r["id"]] for r in test]
        lo, hi = choose_thresholds(yv, mv)
        v_bin, t_bin = clf_metrics(yv, mv, hi), clf_metrics(yt, mt, hi)
        docs = pseudo_docs(test, mt, seed)
        dy = [d[0] for d in docs]; dp = np.array([d[1] for d in docs])
        pl, ph = sigmoid(lo), sigmoid(hi)
        doc = clf_metrics(dy, dp, ph)
        doc["uncertain_share"] = float(((dp >= pl) & (dp < ph)).mean())
        metrics[k] = {"thresholds_margin": {"human_below": lo, "ai_above": hi}, "thresholds_p_ai": {"human_below": pl, "ai_at_or_above": ph},
                      "validation": v_bin, "test": t_bin, "test_three_way": three_way(yt, mt, lo, hi),
                      "test_by_group": per_group(test, mt, hi), "test_at_0.5": clf_metrics(yt, mt, 0.0),
                      "test_document_level": doc, "n_documents": len(docs)}
        thr_out[k] = {"human_below_margin": lo, "ai_above_margin": hi,
                      "validation": {"n": v_bin["n"], "fpr": v_bin["false_positive_rate"], "recall": v_bin["recall"]},
                      "test": {"n": t_bin["n"], "fpr": t_bin["false_positive_rate"], "recall": t_bin["recall"], "roc_auc": t_bin["roc_auc"]}}
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (ROOT.parent / "detector" / "thresholds.json").write_text(json.dumps({
        "created_utc": created, "seed": seed, "target_fpr_validation": TARGET_FPR, "target_recall_validation": TARGET_RECALL,
        "method": "evaluation/dual_eval.py: thresholds chosen on the validation split only; test split untouched",
        "models": thr_out}, indent=2), encoding="utf-8")
    (RES / "dual_metrics.json").write_text(json.dumps({"created_utc": created, "seed": seed, "n_validation": len(val), "n_test": len(test),
                                                       "models": metrics}, indent=2), encoding="utf-8")

    L = [f"# Dual-model evaluation\n\nGenerated {created} (seed {seed}) by `evaluation/dual_eval.py`. Validation n={len(val)}, test n={len(test)}; "
         "disjoint, stratified by dataset/subset/label. Thresholds were chosen on the validation half only "
         f"(AI above = validation FPR <= {TARGET_FPR:.0%}; human below = keeps >= {TARGET_RECALL:.0%} of validation AI). "
         "All results below are on the TEST half.\n"]
    L.append("## Test split, validated thresholds (AI if margin >= ai_above)\n\n| Model | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN | FP | FN | TP |\n|---|---|---|---|---|---|---|---|---|---|---|---|")
    for k in scores:
        t = metrics[k]["test"]; c = t["confusion"]
        L.append(f"| {names[k]} | {pct(t['accuracy'])} | {pct(t['precision'])} | {pct(t['recall'])} | {pct(t['f1'])} | {pct(t['roc_auc'])} | {pct(t['false_positive_rate'])} | {pct(t['false_negative_rate'])} | {c['tn']} | {c['fp']} | {c['fn']} | {c['tp']} |")
    L.append("\n## Same test split at the default cut-off (P(AI) >= 0.5), for reference\n\n| Model | Acc | Recall | FPR | AUROC |\n|---|---|---|---|---|")
    for k in scores:
        t = metrics[k]["test_at_0.5"]
        L.append(f"| {names[k]} | {pct(t['accuracy'])} | {pct(t['recall'])} | {pct(t['false_positive_rate'])} | {pct(t['roc_auc'])} |")
    L.append("\n## Thresholds (P(AI)) and three-way verdicts on test\n\n| Model | human below | AI at or above | uncertain share | human->AI | human->uncertain | AI->human | AI->uncertain |\n|---|---|---|---|---|---|---|---|")
    for k in scores:
        p, w = metrics[k]["thresholds_p_ai"], metrics[k]["test_three_way"]
        L.append(f"| {names[k]} | {p['human_below']:.4g} | {p['ai_at_or_above']:.4g} | {pct(w['uncertain_share'])} | {pct(w['human_called_ai'])} | {pct(w['human_uncertain'])} | {pct(w['ai_called_human'])} | {pct(w['ai_uncertain'])} |")
    for k in scores:
        L.append(f"\n## {names[k]}: test results by dataset / writing style\n\n| Subset | n | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN/FP/FN/TP |\n|---|---|---|---|---|---|---|---|---|---|")
        for g, t in metrics[k]["test_by_group"].items():
            c = t["confusion"]
            L.append(f"| {g} | {t['n']} | {pct(t['accuracy'])} | {pct(t['precision'])} | {pct(t['recall'])} | {pct(t['f1'])} | {pct(t['roc_auc'])} | {pct(t['false_positive_rate'])} | {pct(t['false_negative_rate'])} | {c['tn']}/{c['fp']}/{c['fn']}/{c['tp']} |")
    L.append(f"\n## Paragraph level vs document level (test)\n\nDocument level uses pseudo-documents of {DOC_SIZE} same-label test texts, aggregated by word-weighted mean probability "
             "(approximation of the app's rule). Same thresholds as paragraph level, no re-tuning.\n\n| Model | Level | n | Acc | Recall | FPR | AUROC |\n|---|---|---|---|---|---|---|")
    for k in scores:
        t, d = metrics[k]["test"], metrics[k]["test_document_level"]
        L.append(f"| {names[k]} | paragraph | {t['n']} | {pct(t['accuracy'])} | {pct(t['recall'])} | {pct(t['false_positive_rate'])} | {pct(t['roc_auc'])} |")
        L.append(f"| {names[k]} | document | {d['n']} | {pct(d['accuracy'])} | {pct(d['recall'])} | {pct(d['false_positive_rate'])} | {pct(d['roc_auc'])} |")
    L.append("\n## Caveats\n\n- Datasets are HC3 (2023 ChatGPT) and MAGE; not educational PDFs written by modern assistants. Training data of both models is not fully public, so overlap cannot be excluded.\n"
             "- Thresholds chosen on ~1,650 texts; expect them to move with new data. Re-validate on in-domain text before relying on them.\n"
             "- Paraphrase attacks and fairness for non-native writers were not measured. No result here supports a claim of 100% accuracy.\n")
    (RES / "dual_report.md").write_text("\n".join(L), encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
