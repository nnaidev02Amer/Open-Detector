"""Evaluate the two EXISTING detectors (Followsci BERT, Fakespot RoBERTa) on the in-domain dataset. No training, no tuning of models.

Operating points (all measured on the held-out TEST split; "all splits" rows are valid too because nothing is fitted there):
  default   : AI if P(AI) >= 0.5
  phase1    : the thresholds validated in Phase 1 on HC3+MAGE (detector/thresholds.json), AI if margin >= ai_above
  reselect  : a threshold re-selected on the in-domain VALIDATION split (target FPR <= 5%), then measured on TEST
Also: per-style results, bootstrap 95% CIs, a length-only baseline, mixed human/AI documents through the real app pipeline
(paragraph segmentation + aggregation), and an error analysis.
Outputs: evaluation/indomain/results/{indomain_scores.jsonl, indomain_metrics.json, indomain_report.md}
"""
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "evaluation"))
from evaluate import clf_metrics  # noqa: E402

RES = HERE / "results"
RES.mkdir(exist_ok=True)
STYLES = ["simple_english", "conversational", "formal", "technical"]
NAMES = {"followsci": "Followsci BERT", "fakespot": "Fakespot RoBERTa"}
TARGET_FPR = 0.05


def pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def load(name):
    return [json.loads(l) for l in (HERE / name).read_text(encoding="utf-8").splitlines()]


def score_all(recs):
    cache_f = RES / "indomain_scores.jsonl"
    cache = {}
    if cache_f.exists():
        for l in cache_f.read_text().splitlines():
            d = json.loads(l)
            cache[(d["model"], d["id"])] = d["margin"]
    from detector.dual import SLOTS
    for key in ("followsci", "fakespot"):
        todo = [r for r in recs if (key, r["id"]) not in cache]
        if not todo:
            continue
        det = SLOTS[key].get()
        print(f"{key}: scoring {len(todo)} texts", flush=True)
        ms = det.logit_margins([r["text"] for r in todo], batch_size=8)
        with open(cache_f, "a", encoding="utf-8") as f:
            for r, m in zip(todo, ms):
                cache[(key, r["id"])] = m
                f.write(json.dumps({"model": key, "id": r["id"], "margin": m}) + "\n")
    return cache


def pick_threshold(y, m):
    """Lowest margin with validation FPR <= TARGET_FPR (strictly above the (1-FPR) quantile of human margins)."""
    y, m = np.asarray(y), np.asarray(m)
    return float(np.quantile(m[y == 0], 1 - TARGET_FPR, method="higher")) + 1e-6


def met(y, m, thr):
    return clf_metrics(list(y), list(m), thr)


def boot(y, m, thr, n=2000, seed=13):
    y, m = np.asarray(y), np.asarray(m)
    rng = np.random.default_rng(seed)
    h, a = np.where(y == 0)[0], np.where(y == 1)[0]
    out = {"auroc": [], "recall": [], "fpr": []}
    for _ in range(n):
        i = np.concatenate([rng.choice(h, len(h)), rng.choice(a, len(a))])
        yy, mm = y[i], m[i]
        out["auroc"].append(roc_auc_score(yy, mm))
        out["recall"].append((mm[yy == 1] >= thr).mean())
        out["fpr"].append((mm[yy == 0] >= thr).mean())
    return {k: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] for k, v in out.items()}


def ci(c):
    return f"{100 * c[0]:.0f}-{100 * c[1]:.0f}%"


def main():
    recs = load("dataset.jsonl")
    mixed = load("mixed_docs.jsonl")
    scores = score_all(recs)
    th = json.loads((ROOT / "detector" / "thresholds.json").read_text())["models"]
    P1 = {k: v["ai_above_margin"] for k, v in th.items()}
    split = {s: [r for r in recs if r["split"] == s] for s in ("train", "val", "test")}
    M = {k: {r["id"]: scores[(k, r["id"])] for r in recs} for k in NAMES}
    res = {"created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n": {s: len(v) for s, v in split.items()}, "models": {}}
    L = []

    def arr(rs, k):
        return [r["label"] for r in rs], [M[k][r["id"]] for r in rs]

    for k in NAMES:
        yv, mv = arr(split["val"], k)
        thr = {"default": 0.0, "phase1": P1[k], "reselect": pick_threshold(yv, mv)}
        out = {"thresholds_margin": thr, "test": {}, "all": {}, "by_style_test": {}, "by_style_all": {}, "ci_test": {}}
        yt, mt = arr(split["test"], k)
        ya, ma = arr(recs, k)
        for op, t in thr.items():
            out["test"][op] = met(yt, mt, t)
            out["all"][op] = met(ya, ma, t)
            out["ci_test"][op] = boot(yt, mt, t)
            for st in STYLES:
                rt = [r for r in split["test"] if r["style"] == st]
                ra = [r for r in recs if r["style"] == st]
                out["by_style_test"].setdefault(op, {})[st] = met(*arr(rt, k), t)
                out["by_style_all"].setdefault(op, {})[st] = met(*arr(ra, k), t)
        res["models"][k] = out

    # ---- length-only baseline --------------------------------------------------------------------------
    wl = [r["words"] for r in recs]
    res["length_only_auroc_all"] = float(roc_auc_score([r["label"] for r in recs], wl))

    # ---- report: headline ------------------------------------------------------------------------------
    n = res["n"]
    L.append(f"# In-domain evaluation (Phase 2)\n\nGenerated {res['created_utc']} by `evaluation/indomain/eval_indomain.py`. Models: the two existing detectors, unchanged. "
             f"Dataset: {len(recs)} paragraph-length texts (118 human, 118 AI), split by topic into train {n['train']} / validation {n['val']} / **held-out test {n['test']}**. "
             "Train is not used here (reserved for any future fine-tuning). Headline numbers are on the TEST split; thresholds are never tuned on it.\n")
    L.append("## Test split (n = %d: %d human, %d AI)\n" % (n["test"], sum(r["label"] == 0 for r in split["test"]), sum(r["label"] == 1 for r in split["test"])))
    L.append("| Model | Operating point | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN/FP/FN/TP |\n|---|---|---|---|---|---|---|---|---|---|")
    labels = {"default": "default (P(AI) >= 0.5)", "phase1": "Phase-1 thresholds", "reselect": "re-selected on in-domain validation"}
    for k in NAMES:
        for op in ("default", "phase1", "reselect"):
            t = res["models"][k]["test"][op]
            c = t["confusion"]
            L.append(f"| {NAMES[k]} | {labels[op]} | {pct(t['accuracy'])} | {pct(t['precision'])} | {pct(t['recall'])} | {pct(t['f1'])} | {pct(t['roc_auc'])} | {pct(t['false_positive_rate'])} | {pct(t['false_negative_rate'])} | {c['tn']}/{c['fp']}/{c['fn']}/{c['tp']} |")
    L.append("\n95% bootstrap confidence intervals (test, 2,000 resamples): the test split is small, so these are wide.\n\n| Model | Operating point | AUROC | Recall | FPR |\n|---|---|---|---|---|")
    for k in NAMES:
        for op in ("default", "phase1", "reselect"):
            c = res["models"][k]["ci_test"][op]
            L.append(f"| {NAMES[k]} | {labels[op]} | {ci(c['auroc'])} | {ci(c['recall'])} | {ci(c['fpr'])} |")
    L.append("\nThresholds (logit margin): " + "; ".join(f"{NAMES[k]}: default 0, Phase-1 {res['models'][k]['thresholds_margin']['phase1']:+.2f}, re-selected {res['models'][k]['thresholds_margin']['reselect']:+.2f}" for k in NAMES))

    L.append(f"\n## All {len(recs)} texts, fixed operating points (nothing is fitted here, so every split is valid evaluation data; larger n)\n")
    L.append("| Model | Operating point | Acc | Prec | Recall | F1 | AUROC | FPR | FNR |\n|---|---|---|---|---|---|---|---|---|")
    for k in NAMES:
        for op in ("default", "phase1"):
            t = res["models"][k]["all"][op]
            L.append(f"| {NAMES[k]} | {labels[op]} | {pct(t['accuracy'])} | {pct(t['precision'])} | {pct(t['recall'])} | {pct(t['f1'])} | {pct(t['roc_auc'])} | {pct(t['false_positive_rate'])} | {pct(t['false_negative_rate'])} |")

    L.append("\n## By writing style (all %d texts; default threshold and Phase-1 thresholds)\n" % len(recs))
    L.append("| Model | Style | n (human/AI) | Default: recall / FPR / AUROC | Phase-1: recall / FPR |\n|---|---|---|---|---|")
    for k in NAMES:
        for st in STYLES:
            d, p = res["models"][k]["by_style_all"]["default"][st], res["models"][k]["by_style_all"]["phase1"][st]
            L.append(f"| {NAMES[k]} | {st} | {d['n_human']}/{d['n_ai']} | {pct(d['recall'])} / {pct(d['false_positive_rate'])} / {pct(d['roc_auc'])} | {pct(p['recall'])} / {pct(p['false_positive_rate'])} |")
    L.append("\nSame, test split only:\n\n| Model | Style | n (human/AI) | Default: recall / FPR | Phase-1: recall / FPR | Re-selected: recall / FPR |\n|---|---|---|---|---|---|")
    for k in NAMES:
        for st in STYLES:
            b = res["models"][k]["by_style_test"]
            d, p, r_ = b["default"][st], b["phase1"][st], b["reselect"][st]
            L.append(f"| {NAMES[k]} | {st} | {d['n_human']}/{d['n_ai']} | {pct(d['recall'])} / {pct(d['false_positive_rate'])} | {pct(p['recall'])} / {pct(p['false_positive_rate'])} | {pct(r_['recall'])} / {pct(r_['false_positive_rate'])} |")

    # ---- error analysis ----------------------------------------------------------------------------------
    def feats(t):
        return {"words": len(t.split()), "you": bool(re.search(r"\byou(r)?\b", t, re.I)), "contraction": bool(re.search(r"\w'(s|t|re|ve|ll|d|m)\b", t)),
                "exclaim": "!" in t, "first_person": bool(re.search(r"\b(I|I'm|I've|my|we)\b", t))}
    L.append("\n## Error analysis (AI texts only, all splits, Phase-1 thresholds)\n\nMissed = scored below the AI threshold. Share of texts with each feature:\n\n| Model | Group | n | uses 'you' | contraction | '!' | first person | mean words |\n|---|---|---|---|---|---|---|---|")
    res["error_analysis"] = {}
    for k in NAMES:
        ai = [r for r in recs if r["label"] == 1]
        for g, sel in (("caught", [r for r in ai if M[k][r["id"]] >= P1[k]]), ("missed", [r for r in ai if M[k][r["id"]] < P1[k]])):
            if not sel:
                continue
            f = [feats(r["text"]) for r in sel]
            row = {key: float(np.mean([x[key] for x in f])) for key in f[0]}
            res["error_analysis"][f"{k}/{g}"] = {"n": len(sel), **row}
            L.append(f"| {NAMES[k]} | {g} | {len(sel)} | {pct(row['you'])} | {pct(row['contraction'])} | {pct(row['exclaim'])} | {pct(row['first_person'])} | {row['words']:.0f} |")
    hu = [r for r in recs if r["label"] == 0]
    res["human_false_positives_phase1"] = {k: [r["id"] for r in hu if M[k][r["id"]] >= P1[k]] for k in NAMES}
    L.append("\nHuman texts wrongly flagged as AI (Phase-1 thresholds): " + "; ".join(f"{NAMES[k]}: {len(v)} ({', '.join(v) if v else 'none'})" for k, v in res["human_false_positives_phase1"].items()))
    L.append(f"\nLength-only baseline AUROC (word count alone, all texts): {pct(res['length_only_auroc_all'])} (50% would mean length carries no signal; values far from 50% would indicate a length shortcut in the dataset).")

    # ---- mixed documents through the real app pipeline -------------------------------------------------------
    from detector.dual import analyze_dual
    L.append("\n## Mixed human/AI documents (4 paragraphs each, real app pipeline, Phase-1 thresholds)\n")
    mrows, md = [], defaultdict(lambda: defaultdict(list))
    for d in mixed:
        j = analyze_dual(d["text"])
        for k in NAMES:
            m = j["models"][k]
            if m["status"] != "ok":
                continue
            ps = m["paragraphs"]
            for p, lab in zip(ps, d["labels"]):
                if p["scored"]:
                    mrows.append((k, lab, p["verdict"]))
            md[k][d["ai_paragraphs"]].append((m["document"]["verdict"], m["document"]["p_ai"], m["document"]["ai_paragraph_share"]))
    res["mixed"] = {"n_docs": len(mixed)}
    L.append("| Model | Paragraphs scored | AI paragraphs flagged | human paragraphs flagged AI | AI paragraphs called human | human paragraphs called human |\n|---|---|---|---|---|---|")
    for k in NAMES:
        r = [x for x in mrows if x[0] == k]
        a = [x for x in r if x[1] == 1]; h = [x for x in r if x[1] == 0]
        L.append(f"| {NAMES[k]} | {len(r)} | {pct(np.mean([x[2] == 'likely_ai' for x in a]))} | {pct(np.mean([x[2] == 'likely_ai' for x in h]))} | {pct(np.mean([x[2] == 'likely_human' for x in a]))} | {pct(np.mean([x[2] == 'likely_human' for x in h]))} |")
    L.append("\nDocument-level verdict by how many of the 4 paragraphs are AI (counts of documents):\n\n| Model | AI paragraphs | docs | likely AI | uncertain | likely human | mean doc P(AI) | mean share of paragraphs flagged AI |\n|---|---|---|---|---|---|---|---|")
    for k in NAMES:
        for kk in sorted(md[k]):
            v = md[k][kk]
            cnt = {x: sum(1 for t in v if t[0] == x) for x in ("likely_ai", "uncertain", "likely_human")}
            L.append(f"| {NAMES[k]} | {kk} of 4 | {len(v)} | {cnt['likely_ai']} | {cnt['uncertain']} | {cnt['likely_human']} | {pct(np.mean([t[1] for t in v]))} | {pct(np.mean([t[2] for t in v]))} |")
            res["mixed"][f"{k}/{kk}"] = {"docs": len(v), **cnt, "mean_p_ai": float(np.mean([t[1] for t in v])), "mean_ai_share": float(np.mean([t[2] for t in v]))}

    # ---- the user's guide PDF (provenance unverified: reported as AI-written) -------------------------------
    from app.extract import extract_text
    pdf = ROOT / "tests" / "fixtures" / "Browser_Fingerprinting_Project_Simple_Guide.pdf"
    j = analyze_dual(extract_text(pdf.name, pdf.read_bytes())[0])
    L.append("\n## Reference document: the guide PDF in tests/fixtures (reported by the project as AI-written; not independently verified, not part of the dataset)\n\n| Model | Document P(AI) | Verdict (Phase-1 thresholds) | Paragraphs scored / flagged AI | Highest paragraph P(AI) |\n|---|---|---|---|---|")
    for k in NAMES:
        m = j["models"][k]
        sc = [p for p in m["paragraphs"] if p["scored"]]
        L.append(f"| {NAMES[k]} | {pct(m['document']['p_ai'])} | {m['document']['verdict']} | {len(sc)} / {sum(p['verdict'] == 'likely_ai' for p in sc)} | {pct(max(p['p_ai'] for p in sc))} |")
    res["guide_pdf"] = {k: {"p_ai": j["models"][k]["document"]["p_ai"], "verdict": j["models"][k]["document"]["verdict"]} for k in NAMES}

    L.append("\n## Caveats\n\n- **One AI generator family.** All AI text was written by one assistant (Claude) in this session; it is modern assistant style, which is the target, but results may differ for other generators (GPT, Gemini, Llama, ...).\n"
             "- **Human text is expert/encyclopedic or forum prose** from dated pre-ChatGPT sources; it is not student writing. Student and non-native-English writing was not measured.\n"
             "- **Small sample** (118 texts per class; test 37 per class). Confidence intervals are wide; treat differences of a few points as noise.\n"
             "- Human technical paragraphs are mid-document excerpts of reference text, AI technical paragraphs are self-contained, a possible confound for that style.\n"
             "- No paraphrased or humanized AI text was tested.\n")
    (RES / "indomain_metrics.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    (RES / "indomain_report.md").write_text("\n".join(L), encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
