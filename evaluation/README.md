# Evaluation

Reproducible, measured evaluation of the two detectors used by Open Detector: `followsci/bert-ai-text-detector` (Followsci BERT)
and `fakespot-ai/roberta-base-ai-text-detection-v1` (Fakespot RoBERTa). No number in this project is typed in by
hand: everything in `results/` and `indomain/results/` is produced by the scripts below.

| Part | Scripts | What it measures | Output |
|---|---|---|---|
| 1. Public benchmarks, Followsci only | `collect_data.py`, `evaluate.py` | Followsci on HC3 + MAGE at a plain 0.5 threshold, calibration | `results/metrics.json`, `report.md` |
| 2. Dual-model evaluation | `dual_eval.py` | Both models on the same HC3 + MAGE texts, thresholds chosen on a validation split and measured on a separate test split | `detector/thresholds.json`, `results/dual_metrics.json`, `results/dual_report.md` |
| 3. In-domain evaluation | `indomain/collect_human.py`, `build_dataset.py`, `eval_indomain.py` | Both existing models on 236 educational/technical texts (simple English, formal, technical, conversational) plus mixed documents | `indomain/results/indomain_report.md`, `indomain_metrics.json` |

## Datasets (licences checked on the Hugging Face dataset cards)

| Dataset | Licence | What we use | Size downloaded |
|---|---|---|---|
| [HC3](https://huggingface.co/datasets/Hello-SimpleAI/HC3) | CC-BY-SA-4.0 | `wiki_csai`, `finance`, `medicine`, `open_qa` (human vs ChatGPT answers; Reddit ELI5 skipped) | ~18 MB |
| [MAGE](https://huggingface.co/datasets/yaful/MAGE) | Apache-2.0 | `test.csv` and `test_ood_set_gpt.csv` (human vs 27 LLMs; second file has an unseen generator) | ~74 MB |

Raw downloads are cached in `evaluation/data/raw/`, which is **git-ignored and not committed** (like `evaluation/indomain/raw/`). The sampled evaluation set
`data/eval_set.jsonl` and `data/manifest.json` are committed, so every scoring and evaluation script below runs on a fresh clone without the raw files; only
`collect_data.py` and `indomain/collect_human.py` need network access and re-create the raw caches. Share-alike (CC-BY-SA) applies to HC3
derivatives: cite the source if you redistribute `eval_set.jsonl`.

## 1. Public benchmarks (Followsci)

```powershell
.\.venv\Scripts\python.exe evaluation\collect_data.py     # download + sample (seed 13) -> data/eval_set.jsonl, manifest.json
.\.venv\Scripts\python.exe evaluation\evaluate.py         # score (~25 min on CPU), metrics -> results/
```
Scores are cached in `results/scores*.jsonl`; delete them to force re-scoring. `collect_data.py` verifies the MAGE
label convention from the data (label 1 = human, 0 = machine) rather than assuming it.

Outputs: `results/report.md` (readable), `results/metrics.json` (also shown on the app's Model Information page),
`data/manifest.json` (seed, counts, source URLs, SHA-256 of every raw file).

**Calibration.** `evaluate.py` fits a temperature on half of the data and measures it on the other half. By default it does **not**
change the app. `--write-calibration` writes `detector/calibration.json`, after which the app serves calibrated scores.
It is deliberately off: the fit uses out-of-domain data and would push almost every score into the "uncertain" band.

## 2. Dual-model evaluation (validation and test splits)

```powershell
.\.venv\Scripts\python.exe evaluation\dual_eval.py        # needs results\scores.jsonl from evaluate.py, and Fakespot in the local Hugging Face cache
```
- The 3,300-text evaluation set is split 50/50 (seed 13, stratified by dataset, subset and label) into a **validation** half and a **test** half; no text is in both.
- Both models are scored on identical texts. Followsci scores come from `results/scores.jsonl`; Fakespot scores are computed (about 40 minutes or more on CPU) and cached in `results/scores_fakespot.jsonl`.
  Fakespot is loaded from the local cache only (nothing is downloaded); cache it once with `.\.venv\Scripts\hf.exe download fakespot-ai/roberta-base-ai-text-detection-v1`.
- **Independent thresholds**, chosen per model on the validation half only: *likely AI* = the lowest score with validation false-positive rate at most 5%; *likely human* = the highest score that still keeps at least 95% of validation AI texts at or above it (never above the AI threshold); in between is *uncertain*.
- Every reported number (accuracy, precision, recall, F1, AUROC, false-positive and false-negative rate, confusion matrices, per dataset and subset, paragraph level versus an approximate document level) is measured on the **test** half.
- **Warning:** this script rewrites `detector/thresholds.json`, which the application reads for its per-model verdicts. Re-running it can change what the dual-model page shows.

Outputs: `detector/thresholds.json`, `results/dual_metrics.json`, `results/dual_report.md`, `results/scores_fakespot.jsonl` (cache).

## 3. In-domain evaluation (educational and technical writing)

Public benchmarks are not the target domain, so `indomain/` holds a dataset built for it (details, provenance and licences: [indomain/README.md](indomain/README.md)):
236 paragraph-length texts (118 human, 118 AI) in four styles, plus 56 mixed human/AI documents of 4 paragraphs.
- **Human text** comes from dated sources before 2022-06-01 (Simple English and English Wikipedia revisions, CPython documentation, Stack Exchange answers), with revision or answer ids stored.
- **AI text** was written by one assistant (Claude) for the same topics and styles; the three files `ai_wiki_a.py`, `ai_wiki_b.py` and `ai_tech_conv.py` hold it with the prompt style recorded.
- **Splits** are by topic (train 116 / validation 46 / test 74, seed 13), so both labels of a topic share a split; `dataset_report.json` records the leakage checks (topic overlap, duplicate texts, 8-gram overlap).

```powershell
.\.venv\Scripts\python.exe evaluation\indomain\collect_human.py   # network: Wikipedia + Stack Exchange APIs -> human.jsonl (raw responses cached in indomain\raw\, git-ignored)
.\.venv\Scripts\python.exe evaluation\indomain\build_dataset.py   # -> dataset.jsonl, mixed_docs.jsonl, dataset_report.json (works offline from the committed human.jsonl)
.\.venv\Scripts\python.exe evaluation\indomain\eval_indomain.py   # both models, unchanged; needs both in the local cache and detector\thresholds.json
```
`eval_indomain.py` evaluates both **existing** models (no training, no fine-tuning) at three operating points: default (P(AI) >= 0.5), the thresholds validated in part 2, and a threshold re-selected on the in-domain validation split.
It reports results on the held-out **test** split with bootstrap confidence intervals, per writing style, a length-only baseline, an error analysis, mixed documents run through the real application pipeline, and one reference document (the study-guide PDF
fixture, which is not part of the dataset and whose AI authorship is reported by the project, not independently verified). The `train` split is not used by any evaluation; it is reserved for possible future work.

Outputs: `indomain/results/indomain_report.md`, `indomain/results/indomain_metrics.json`, `indomain/results/indomain_scores.jsonl` (cache).

## Important caveats
- The HC3/MAGE datasets are **not** arXiv-style academic prose, so they are out-of-domain for Followsci. Results here are
  not comparable to the model card's 99.57%, which comes from an unreleased in-domain split.
- Neither model's training data is fully public, so overlap with HC3/MAGE cannot be excluded.
- The dual-model thresholds were chosen on about 1,650 HC3/MAGE texts and should be re-validated on in-domain text before relying on them.
- The in-domain AI text comes from a **single generator** and the sample is small (test split: 37 texts per class), so confidence intervals are wide. The human text is encyclopedic, documentation or forum prose, not student writing.
- Paraphrase attacks, humanized text and fairness for non-native writers were **not** measured.
- HC3's AI text is 2023 ChatGPT; newer LLMs may behave differently.
- Nothing here supports a claim that either detector reliably identifies all AI-generated text.
