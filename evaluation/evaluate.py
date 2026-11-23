"""Reproducible evaluation of the detector on evaluation/data/eval_set.jsonl.

Everything reported is computed here from model outputs; nothing is hard-coded.

Outputs (evaluation/results/):
  scores.jsonl   cached raw logit margin per text (delete to force re-scoring)
  metrics.json   machine-readable results (also served to the web UI)
  report.md      human-readable summary

Calibration: the data is split 50/50 (seeded, stratified by dataset+label). Temperature T is fitted on the
calibration half only and its effect (NLL, Brier, ECE) is measured on the held-out half.
`--write-calibration` additionally saves T to detector/calibration.json so the app uses it.

Usage:  python evaluation/evaluate.py [--seed 13] [--write-calibration]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from detector.analysis import BAND_AI, BAND_HUMAN  # noqa: E402

DATA = ROOT / "data" / "eval_set.jsonl"
RES = ROOT / "results"
SHORT_WORDS = 50


def words(t: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", t))


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


def load():
    return [json.loads(ln) for ln in DATA.read_text(encoding="utf-8").splitlines()]


def score_all(recs, cache_name="scores.jsonl", texts=None):
    cache = RES / cache_name
    have = {}
    if cache.exists():
        have = {json.loads(l)["id"]: json.loads(l)["margin"] for l in cache.read_text().splitlines()}
    todo = [r for r in recs if r["id"] not in have]
    if todo:
        from detector.model import Detector
        det = Detector()
        print(f"scoring {len(todo)} texts on {det.device} ...", flush=True)
        T = {r["id"]: (texts[r["id"]] if texts else r["text"]) for r in todo}
        B = 16
        with open(cache, "a", encoding="utf-8") as f:
            for i in range(0, len(todo), B):
                chunk = todo[i : i + B]
                m = det.logit_margins([T[r["id"]] for r in chunk], batch_size=B)
                for r, mm in zip(chunk, m):
                    have[r["id"]] = mm
                    f.write(json.dumps({"id": r["id"], "margin": mm}) + "\n")
                if (i // B) % 20 == 0:
                    print(f"  {i + len(chunk)}/{len(todo)}", flush=True)
    return np.array([have[r["id"]] for r in recs])


def clf_metrics(y, p, thr=0.5):
    y, p = np.asarray(y), np.asarray(p)
    pred = (p >= thr).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum()); tn = int(((pred == 0) & (y == 0)).sum())
    fp = int(((pred == 1) & (y == 0)).sum()); fn = int(((pred == 0) & (y == 1)).sum())
    n = len(y)
    div = lambda a, b: a / b if b else None  # noqa: E731
    prec, rec = div(tp, tp + fp), div(tp, tp + fn)
    out = {
        "n": n, "n_ai": int(y.sum()), "n_human": int(n - y.sum()),
        "accuracy": (tp + tn) / n, "precision": prec, "recall": rec,
        "f1": div(2 * prec * rec, prec + rec) if prec and rec else None,
        "false_positive_rate": div(fp, fp + tn), "false_negative_rate": div(fn, fn + tp),
        "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
        "roc_auc": float(roc_auc_score(y, p)) if len(set(y.tolist())) == 2 else None,
    }
    return out


def band_metrics(y, p):
    """Behaviour of the three-way verdict bands used by the app."""
    y, p = np.asarray(y), np.asarray(p)
    unc = (p >= BAND_HUMAN) & (p <= BAND_AI)
    dec = ~unc
    pred = (p > BAND_AI).astype(int)
    return {
        "human_below": BAND_HUMAN, "ai_above": BAND_AI, "uncertain_share": float(unc.mean()),
        "accuracy_on_decided": float((pred[dec] == y[dec]).mean()) if dec.any() else None,
        "human_called_ai": float(((p > BAND_AI) & (y == 0)).sum() / max(1, (y == 0).sum())),
        "ai_called_human": float(((p < BAND_HUMAN) & (y == 1)).sum() / max(1, (y == 1).sum())),
    }


def calib_metrics(y, p, bins=10):
    y, p = np.asarray(y, float), np.clip(np.asarray(p, float), 1e-7, 1 - 1e-7)
    nll = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    brier = float(((p - y) ** 2).mean())
    edges = np.linspace(0, 1, bins + 1)
    ece, rel = 0.0, []
    for i in range(bins):
        m = (p >= edges[i]) & ((p < edges[i + 1]) if i < bins - 1 else (p <= 1))
        if m.any():
            conf, acc = float(p[m].mean()), float(y[m].mean())
            ece += m.mean() * abs(conf - acc)
            rel.append({"bin": [round(edges[i], 2), round(edges[i + 1], 2)], "n": int(m.sum()), "mean_score": conf, "frac_ai": acc})
    return {"nll": nll, "brier": brier, "ece": float(ece), "reliability": rel}


def fit_temperature(margins, y):
    y = np.asarray(y, float)
    def nll(logT):
        p = np.clip(sigmoid(margins / math.exp(logT)), 1e-7, 1 - 1e-7)
        return -(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()
    lo, hi = math.log(0.05), math.log(100.0)
    g = (math.sqrt(5) - 1) / 2
    for _ in range(80):
        a, b = hi - g * (hi - lo), lo + g * (hi - lo)
        lo, hi = (lo, b) if nll(a) < nll(b) else (a, hi)
    return math.exp((lo + hi) / 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--write-calibration", action="store_true")
    a = ap.parse_args()
    if not DATA.exists():
        sys.exit("Run evaluation/collect_data.py first.")
    RES.mkdir(parents=True, exist_ok=True)
    recs = load()
    y = np.array([r["label"] for r in recs])
    margins = score_all(recs)
    p_raw = sigmoid(margins)

    # ---------- per-dataset raw metrics ----------
    datasets = []
    groups = [("HC3", lambda r: r["dataset"] == "HC3"), ("MAGE", lambda r: r["dataset"] == "MAGE"),
              ("MAGE-OOD (unseen LLM)", lambda r: r["dataset"] == "MAGE-OOD"), ("All combined", lambda r: True)]
    for name, f in groups:
        idx = [i for i, r in enumerate(recs) if f(r)]
        m = clf_metrics(y[idx], p_raw[idx]); m["name"] = name
        m["bands"] = band_metrics(y[idx], p_raw[idx])
        datasets.append(m)
    hc3_sub = {}
    for g in sorted({r["group"] for r in recs if r["dataset"] == "HC3"}):
        idx = [i for i, r in enumerate(recs) if r["dataset"] == "HC3" and r["group"] == g]
        hc3_sub[g] = clf_metrics(y[idx], p_raw[idx])
        hc3_sub[g]["name"] = f"HC3 / {g}"

    # ---------- score saturation ----------
    saturated = float(((p_raw < 0.02) | (p_raw > 0.98)).mean())

    # ---------- by length ----------
    wc = np.array([words(r["text"]) for r in recs])
    length = []
    for lo, hi in [(40, 80), (80, 150), (150, 250), (250, 401)]:
        idx = np.where((wc >= lo) & (wc < hi))[0]
        if len(idx) >= 30 and len(set(y[idx].tolist())) == 2:
            m = clf_metrics(y[idx], p_raw[idx]); m["name"] = f"{lo}-{hi - 1} words"; length.append(m)

    # ---------- short-text stress test ----------
    rng = random.Random(a.seed)
    long_idx = [i for i, r in enumerate(recs) if wc[i] >= 120]
    sub = rng.sample(long_idx, min(600, len(long_idx)))
    short_recs = [{"id": "S-" + recs[i]["id"], "label": recs[i]["label"]} for i in sub]
    short_texts = {}
    for i, sr in zip(sub, short_recs):
        toks = recs[i]["text"].split()
        short_texts[sr["id"]] = " ".join(toks[:SHORT_WORDS])
    sm = score_all(short_recs, "scores_short.jsonl", short_texts)
    ys = np.array([r["label"] for r in short_recs])
    full_for_same = clf_metrics(y[sub], p_raw[sub]); short = clf_metrics(ys, sigmoid(sm))
    stress = {"first_N_words": SHORT_WORDS, "n": len(sub), "full_text": full_for_same, "truncated": short}

    # ---------- calibration on a held-out half ----------
    r2 = random.Random(a.seed)
    strata = defaultdict(list)
    for i, r in enumerate(recs):
        strata[(r["dataset"], r["label"])].append(i)
    cal_idx, test_idx = [], []
    for k in sorted(strata):
        ids = strata[k][:]; r2.shuffle(ids)
        h = len(ids) // 2
        cal_idx += ids[:h]; test_idx += ids[h:]
    T = fit_temperature(margins[cal_idx], y[cal_idx])
    p_cal = sigmoid(margins / T)
    calibration = {
        "temperature": T, "fit_on_n": len(cal_idx), "evaluated_on_n": len(test_idx),
        "heldout_raw": calib_metrics(y[test_idx], p_raw[test_idx]),
        "heldout_calibrated": calib_metrics(y[test_idx], p_cal[test_idx]),
        "heldout_calibrated_accuracy": clf_metrics(y[test_idx], p_cal[test_idx])["accuracy"],
        "heldout_raw_accuracy": clf_metrics(y[test_idx], p_raw[test_idx])["accuracy"],
        "note": "Fitted on HC3+MAGE (out-of-domain relative to the model's arXiv training data); may not transfer to academic text.",
    }
    if a.write_calibration:
        (ROOT.parent / "detector" / "calibration.json").write_text(json.dumps({
            "temperature": T, "fit_on": "evaluation/data/eval_set.jsonl calibration half",
            "seed": a.seed, "heldout_ece_before": calibration["heldout_raw"]["ece"],
            "heldout_ece_after": calibration["heldout_calibrated"]["ece"]}, indent=2), encoding="utf-8")
        print("wrote detector/calibration.json")

    manifest = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    out = {
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": "followsci/bert-ai-text-detector", "scores": "raw softmax (uncalibrated) unless stated",
        "decision_threshold": 0.5, "seed": a.seed, "dataset_manifest": {k: manifest[k] for k in ("seed", "counts", "total", "sources", "filters", "caveats")},
        "datasets": datasets, "hc3_subsets": list(hc3_sub.values()), "by_length": length,
        "saturated_share": saturated, "short_text_stress": stress, "calibration": calibration,
        "notes": ("All numbers computed by evaluation/evaluate.py on public out-of-domain data (HC3, MAGE); the model was trained on arXiv-style "
                  "academic text, and its own test split is not public, so these figures are NOT comparable to its published 99.57% accuracy "
                  "and overlap with its training data cannot be excluded."),
    }
    (RES / "metrics.json").write_text(json.dumps(out, indent=2), encoding="utf-8")

    pc = lambda v: "-" if v is None else f"{v * 100:.1f}%"  # noqa: E731
    L = ["# Evaluation report", "", f"Generated {out['created_utc']} by `evaluation/evaluate.py` (seed {a.seed}).", "",
         "Threshold 0.5 on the raw softmax P(AI). Label 1 = AI.", "",
         "| Dataset | n | Accuracy | Precision | Recall | F1 | ROC-AUC | FPR | FNR |", "|---|---|---|---|---|---|---|---|---|"]
    for m in datasets + list(hc3_sub.values()):
        L.append(f"| {m['name']} | {m['n']} | {pc(m['accuracy'])} | {pc(m['precision'])} | {pc(m['recall'])} | {pc(m['f1'])} | {pc(m['roc_auc'])} | {pc(m['false_positive_rate'])} | {pc(m['false_negative_rate'])} |")
    L += ["", "## Verdict bands used in the app", "", "| Dataset | Uncertain share | Accuracy on decided | Human called AI | AI called human |", "|---|---|---|---|---|"]
    for m in datasets:
        b = m["bands"]; L.append(f"| {m['name']} | {pc(b['uncertain_share'])} | {pc(b['accuracy_on_decided'])} | {pc(b['human_called_ai'])} | {pc(b['ai_called_human'])} |")
    L += ["", f"Share of texts scored below 2% or above 98%: **{pc(saturated)}** (scores are close to binary).", "", "## Accuracy by text length", "", "| Length | n | Accuracy | FPR | FNR |", "|---|---|---|---|---|"]
    for m in length:
        L.append(f"| {m['name']} | {m['n']} | {pc(m['accuracy'])} | {pc(m['false_positive_rate'])} | {pc(m['false_negative_rate'])} |")
    L += ["", f"## Short-text stress test (first {SHORT_WORDS} words of {len(sub)} texts)", "",
          f"Accuracy full text: {pc(full_for_same['accuracy'])} -> truncated: {pc(short['accuracy'])}; "
          f"ROC-AUC {pc(full_for_same['roc_auc'])} -> {pc(short['roc_auc'])}.", "",
          "## Temperature calibration (held-out half)", "",
          f"T = {T:.3f}, fitted on {len(cal_idx)} texts, evaluated on {len(test_idx)}.", "",
          "| | NLL | Brier | ECE |", "|---|---|---|---|"]
    for k, lab in (("heldout_raw", "raw"), ("heldout_calibrated", "calibrated")):
        c = calibration[k]; L.append(f"| {lab} | {c['nll']:.4f} | {c['brier']:.4f} | {c['ece']:.4f} |")
    L += ["", f"> {calibration['note']}", "", "## Caveats", ""] + [f"- {c}" for c in manifest["caveats"]]
    L += ["- Paraphrase/adversarial robustness and non-native-writer fairness were NOT measured (no suitable licensed data or paraphraser in scope)."]
    (RES / "report.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
