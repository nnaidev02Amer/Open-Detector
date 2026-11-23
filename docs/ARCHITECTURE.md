# Open Detector web application — architecture, API and methodology

This document describes the local web application built around two AI-text detectors: `followsci/bert-ai-text-detector`
(**Followsci BERT**, used throughout the application) and `fakespot-ai/roberta-base-ai-text-detection-v1` (**Fakespot RoBERTa**, used only by the
dual-model comparison page). It is an academic prototype that runs entirely on your own computer. Every figure quoted below is taken from the
files written by the evaluation scripts (`evaluation/results/metrics.json`, `evaluation/results/dual_metrics.json` and `dual_report.md`,
`evaluation/indomain/results/indomain_metrics.json` and `indomain_report.md`) or from the code; none is typed in from elsewhere. The main
[README](../README.md) gives the user-level description, and [DUAL_MODEL.md](DUAL_MODEL.md) the dual-model feature in brief.

## 1. Overview

```
 Browser (vanilla JS single-page app, no build step, no external assets)
 +--------------------------------------------------------------------------+
 |  /            new interface  (app/static/v2/...)  8 modules + #/dual page |
 |  /classic     original interface (app/static/index.html, app.js, styles.css) |
 +------------------------------^-------------------------------------------+
                                | JSON / multipart over http://127.0.0.1:8000
 +------------------------------+-------------------------------------------+
 | FastAPI  app/main.py        analyse, upload, history, reports (original API) |
 |          app/extra_api.py   stats, search, batch, model-info (additive API)  |
 |          app/dual_api.py    dual-model endpoints (additive API)              |
 |          app/extract.py     TXT / MD / DOCX / PDF -> text                    |
 |          app/history.py     SQLite store        app/reports.py  HTML report  |
 +--------------------------------------------------------------------------+
 | detector/ segmentation -> paragraph scoring -> aggregation (analysis.py)     |
 |           model.py   Followsci: BertForSequenceClassification, local, CPU   |
 |           dual.py    Fakespot loader, per-model thresholds, dual analysis    |
 +--------------------------------------------------------------------------+
        data/history.db (SQLite)             evaluation/ (datasets, results)
```

Design rules followed throughout:

* **One detection implementation.** Every input route (paste, TXT, MD, DOCX, PDF, batch, dual) ends in
  `detector.analyze_document()`. The new interface never scores anything in the browser.
* **Additive changes only.** The original detector, extraction, segmentation, thresholds, endpoints and the classic
  interface are unchanged; new endpoints, the dual-model module and the new frontend were added beside them.
* **Dual-model rules.** Both models score the *same* normalised text through the existing `analyze_document`, so paragraphs
  line up one to one. Each model has its own validated thresholds. **Probabilities are never averaged and there is no combined verdict;**
  the comparison only labels agreement. A failure in one model is reported in its own block and never blocks the other.
  Fakespot is loaded lazily on the first dual request and **from the local Hugging Face cache only** (`local_files_only=True`; the app never downloads it).
* **Local only.** The models run on this computer. No document text is sent anywhere.

## 2. Modules (new interface at `/`)

| Module | Route | What it does | Data source |
|---|---|---|---|
| Dashboard | `#/dashboard` | Totals, verdict mix, activity, score distribution, recent analyses | `GET /api/stats` |
| Detection Studio | `#/studio` | Paste text or upload PDF/DOCX/TXT/MD; progress; AI/human probability, verdict, statistics (Followsci) | `POST /api/analyze`, `/api/analyze-file` |
| Document Intelligence | `#/intelligence?id=` | Paragraph-by-paragraph view, highlighting, sentence context-window estimates, distributions | `GET /api/history/{id}` |
| Batch Analysis | `#/batch` | Up to 20 files per batch, per-file status, combined overview, previous batches | `POST/GET /api/batch` |
| History | `#/history` | Search, filter, sort, paginate, open, delete | `GET /api/history/search`, `DELETE /api/history/{id}` |
| Analytics | `#/analytics` | Distributions, trends, source breakdown, batch performance, with date/source filters | `GET /api/stats`, `GET /api/batch` |
| Report Center | `#/reports` | Print-ready reports for analyses and batches (browser Print → Save as PDF) | `GET /api/history/{id}`, `/api/batch/{id}`, existing `/api/report/{id}.html\|.json` |
| Model Information | `#/model` | Model facts, pipeline, bands, measured metrics (HC3/MAGE), weaknesses | `GET /api/model-info`, `GET /api/evaluation` |
| Dual-model comparison | `#/dual` | Followsci and Fakespot side by side: probabilities, verdicts, inference time, thresholds, per-paragraph agreement/disagreement | `GET /api/dual/status`, `POST /api/analyze-dual`, `POST /api/analyze-file-dual` |

The dual-model page is an extra route registered in `main.js` (like `#/design`) and linked from the sidebar footer; it is not one of the eight
modules in the main navigation. A component gallery (`#/design`) is reachable by URL only; its charts use clearly labelled synthetic values and it never
shows analysis data.

### File layout

```
app/
  main.py  extra_api.py  dual_api.py  extract.py  history.py  reports.py
  static/
    index.html app.js styles.css     <- classic interface (unchanged)
    v2/index.html                    <- new interface shell
    v2/css/  theme.css components.css studio.css stage4.css report.css dual.css
    v2/js/   main.js (router, shell) api.js ui.js charts.js icons.js logic.js parts.js report.js state.js
    v2/js/pages/  dashboard studio intelligence batch history analytics reports model design dual
detector/   __init__.py model.py dual.py thresholds.json segmentation.py analysis.py cli.py
evaluation/ collect_data.py evaluate.py dual_eval.py data/ results/
evaluation/indomain/  collect_human.py build_dataset.py eval_indomain.py dataset.jsonl mixed_docs.jsonl results/ README.md
tests/      pytest suite (incl. test_dual.py) + tests/e2e browser scripts
docs/       this file, DUAL_MODEL.md
images/ui/  screenshots (taken before the dual-model page was added)
```

## 3. Storage

SQLite file `data/history.db` (override with the `OPEN_DETECTOR_DB` environment variable).

| Table | Purpose |
|---|---|
| `analyses` | One row per analysed document: id, UTC time, title, source (`paste`, `txt`, `docx`, `pdf`), words, status, score, verdict, full text, full detector result (JSON). Original table, unchanged. |
| `batches`, `batch_items` | Added for batch analysis; created with `CREATE TABLE IF NOT EXISTS`. A batch item refers to an analysis by id, so deleting an analysis leaves a "removed" marker in the batch. |

Dual-model results (`/api/analyze-dual`, `/api/analyze-file-dual`) are **not** stored: they are returned to the caller only, because the
`analyses` table holds one score per analysis. Batch analysis, history, analytics and reports use Followsci only.

## 4. API overview

Interactive documentation: `http://127.0.0.1:8000/api/docs` (FastAPI/OpenAPI). The list below matches the application's OpenAPI schema.

| Method & path | Purpose |
|---|---|
| `GET /api/status` | Followsci model name, device, calibration flag, verdict bands, minimum word count |
| `POST /api/analyze` | `{text, title?}` → analysis record (`id`, `result`, …); stores it |
| `POST /api/analyze-file` | multipart `file` (+ `title?`) → analysis record; PDF/DOCX/TXT/MD, ≤ 10 MB |
| `GET /api/history` · `GET /api/history/{id}` | Recent list · one full record |
| `DELETE /api/history/{id}` · `DELETE /api/history` | Delete one · clear all |
| `GET /api/history/search` | `q`, `verdict`, `source`, `status`, `date_from`, `date_to`, `min_score`, `max_score`, `sort`, `limit`, `offset` → `{total, items}` |
| `GET /api/stats` | Dashboard/analytics aggregates; optional `date_from`, `date_to`, `source` |
| `POST /api/batch` · `GET /api/batch` · `GET /api/batch/{id}` · `DELETE /api/batch/{id}` | Batch analysis (≤ 20 files); list; detail; remove the grouping only |
| `GET /api/report/{id}.html` (`?download=true`) · `GET /api/report/{id}.json` | Original single-analysis reports |
| `GET /api/model-info` | Model facts read from the loaded model, scoring constants, limitations, evaluation summary |
| `GET /api/evaluation` | The contents of `evaluation/results/metrics.json` |
| `GET /api/dual/status` | Both models: loaded or not, error, load time, thresholds, licence card, parameters, server memory (does not load a model) |
| `POST /api/analyze-dual` | `{text, title?}` → both models on identical text; **not stored** (same 300,000-character limit as `/api/analyze`) |
| `POST /api/analyze-file-dual` | multipart `file` (+ `title?`) → same for an uploaded file (PDF/DOCX/TXT/MD, ≤ 10 MB); **not stored** |
| `GET /` · `GET /classic` | New interface · original interface |

The dual endpoints return `{title, source, text, models, comparison, memory_mb}`. `models.followsci` and `models.fakespot` each carry `status`
(`ok`, `insufficient_text` or `error`), `error`, `inference_ms`, `load_ms`, `device`, `thresholds`, `card` (licence, base model), `document`
(`p_ai`, `p_human`, `verdict`, `ai_paragraph_share`, `scored_paragraphs`, `scored_words`, `words`; Followsci also `shipped_verdict`, the verdict the existing app
gives) and `paragraphs` (`index`, `start`, `end`, `words`, `scored`, `p_ai`, `p_human`, `verdict`). `comparison` is `null` unless both models returned `ok`; otherwise it has
`document.relation` and `delta_p_ai`, a per-paragraph `relation`, `paragraph_counts` and a note. Relations are `agree_ai`, `agree_human`, `agree_uncertain`, `partial`
(one model uncertain), `disagree` and `not_compared`. There is deliberately no combined score or verdict field. A model failure still returns HTTP 200 with that
model's `status: "error"`.

Errors are JSON `{"detail": "…"}` with 400 (bad input or unreadable file), 404 (unknown id), 413 (too large), 422 (invalid
parameters).

## 5. How scoring works

1. **Segment** — text is split into paragraphs and sentences (character offsets kept). Documents over 20,000 words are
   truncated (the result is flagged `truncated`).
2. **Score paragraphs** — each paragraph of at least 25 words is scored by the BERT classifier (labels: 0 = human,
   1 = AI; `max_length` 512 tokens). Paragraphs over 300 words are scored in chunks of up to 300 words and combined by
   word count. Shorter paragraphs are not scored.
3. **Sentence context windows** — overlapping 3-sentence windows are scored too; a sentence's value is the mean of the
   windows covering it. These are *estimates used for highlighting*, not classifications. Paragraphs of three sentences
   or fewer simply show the paragraph score.
4. **Aggregate** — the document score is the word-weighted mean of paragraph scores. A document needs at least 40 words.
5. **Verdict bands** (heuristic, not fitted): below 0.35 *likely human*, above 0.65 *likely AI*, otherwise *uncertain*.

"AI probability" is the model's softmax output for class 1 and "human probability" is `1 − AI probability`. They are the
model's two-class output and are **not calibrated probabilities of authorship** (see saturation below).

### 5.1 Dual-model scoring and thresholds

The steps above apply to each model separately: `detector/dual.py` calls the existing `analyze_document` once per model with the same normalised text, so
segmentation, chunking and paragraph/document aggregation are identical, and the document score of each model is the word-weighted mean of *that model's* paragraph scores.
Fakespot is wrapped by `HFDetector` (an `AutoModelForSequenceClassification` loaded with `local_files_only=True`); its label order (0 = human, 1 = AI) is checked from the
model config when it loads. Fakespot's suggested `clean_text` helper is not applied, so both models see identical input.

Each model's verdict uses its own rule from `detector/thresholds.json`: *likely AI* if P(AI) is at or above `ai_at_or_above`, *likely human* if below `human_below`, otherwise
*uncertain* (if the file is missing, Followsci falls back to its shipped bands and Fakespot to 0.5, and the response marks the thresholds `validated: false`).
`evaluation/dual_eval.py` writes the file from a validation split only (50/50 stratified split of the evaluation set, seed 13): *AI* = lowest score with validation false-positive rate at most 5%;
*human* = highest score keeping at least 95% of validation AI texts at or above it (never above the AI threshold). The resulting thresholds, as P(AI), are:

| Model | likely human below | likely AI at or above | share of test texts "uncertain" |
|---|---|---|---|
| Followsci BERT | 0.000002128 | 0.9927 | 71.0% |
| Fakespot RoBERTa | 0.4333 | 0.9941 | 18.6% |

Followsci's scores are so extreme that these thresholds leave it "uncertain" for most texts, so its dual-view verdict can differ from the existing app's verdict (bands 0.35 / 0.65), which is returned alongside as `shipped_verdict`.
Memory and speed measured on the development machine (CPU only, idle): server memory about 0.83 GB with Followsci only, 1.40 GB with both; Fakespot loads in about 1.4 s;
a 90-word paragraph takes about 0.7 s per model, about 900 words 4.5 to 4.8 s per model; the two models run one after the other.

## 6. Evaluation methodology

`evaluation/collect_data.py` and `evaluation/evaluate.py` build and score a fixed evaluation set (seed 13). Nothing is
tuned on it; the decision threshold is a plain 0.5 on the raw softmax probability.

| Dataset | Content | Licence |
|---|---|---|
| HC3 (4 subsets: finance, medicine, open_qa, wiki_csai) | Human answers vs ChatGPT (2023) answers | CC-BY-SA-4.0 |
| MAGE | Human text vs text from many LLMs | Apache-2.0 |
| MAGE-OOD | Human text vs text from an LLM not seen in the standard MAGE test (`test_ood_set_gpt`) | Apache-2.0 |

Results (from `evaluation/results/metrics.json`, generated 2026-11-23T06:52:14+00:00):

| Dataset | n (AI / human) | Accuracy | Precision | Recall | F1 | AUROC | False-positive rate |
|---|---|---|---|---|---|---|---|
| HC3 | 2,000 (1,000 / 1,000) | 76.7% | 86.7% | 63.1% | 73.0% | 0.884 | 9.7% |
| MAGE | 1,000 (500 / 500) | 51.2% | 58.3% | 8.4% | 14.7% | 0.536 | 6.0% |
| MAGE-OOD (unseen LLM) | 300 (150 / 150) | 63.0% | 85.5% | 31.3% | 45.9% | 0.779 | 5.3% |
| All combined | 3,300 (1,650 / 1,650) | 67.7% | 84.2% | 43.6% | 57.5% | 0.768 | 8.2% |

| HC3 subset | n (AI / human) | Accuracy | Precision | Recall | F1 | AUROC | False-positive rate |
|---|---|---|---|---|---|---|---|
| HC3 / finance | 508 (250 / 258) | 67.5% | 97.8% | 34.8% | 51.3% | 0.915 | 0.8% |
| HC3 / medicine | 503 (250 / 253) | 75.9% | 97.1% | 53.2% | 68.7% | 0.926 | 1.6% |
| HC3 / open_qa | 488 (250 / 238) | 80.5% | 76.1% | 90.4% | 82.6% | 0.901 | 29.8% |
| HC3 / wiki_csai | 501 (250 / 251) | 83.0% | 90.2% | 74.0% | 81.3% | 0.929 | 8.0% |

| Text length | n (AI / human) | Accuracy | Precision | Recall | F1 | AUROC | False-positive rate |
|---|---|---|---|---|---|---|---|
| 40-79 words | 843 (250 / 593) | 68.3% | 45.3% | 32.8% | 38.1% | 0.579 | 16.7% |
| 80-149 words | 936 (425 / 511) | 75.0% | 87.7% | 52.2% | 65.5% | 0.794 | 6.1% |
| 150-249 words | 1,004 (699 / 305) | 65.4% | 98.9% | 50.9% | 67.2% | 0.896 | 1.3% |
| 250-400 words | 517 (276 / 241) | 58.0% | 98.4% | 21.7% | 35.6% | 0.836 | 0.4% |

89.7% of evaluated texts scored below 2% or above 98%, i.e. scores are close to binary.

The application's Model Information page shows these same figures, read from the same file; an automated test compares every
displayed value with `metrics.json`.

### 6.1 Dual-model evaluation (validation and test splits)

`evaluation/dual_eval.py` scores both models on the same 3,300 texts, chooses each model's thresholds on the validation half (n = 1,647) and reports on the disjoint test half (n = 1,653); output in
`evaluation/results/dual_report.md` and `dual_metrics.json`. Positive class = AI.

| Model (own validated thresholds) | Accuracy | Precision | Recall | F1 | AUROC | FPR | FNR |
|---|---|---|---|---|---|---|---|
| Followsci BERT | 65.5% | 90.3% | 34.7% | 50.2% | 78.1% | 3.7% | 65.3% |
| Fakespot RoBERTa | 90.7% | 94.8% | 86.1% | 90.2% | 95.8% | 4.7% | 13.9% |

| Test subset | Followsci recall / FPR / AUROC | Fakespot recall / FPR / AUROC |
|---|---|---|
| HC3 | 50.2% / 5.2% / 89.3% | 98.2% / 2.4% / 99.6% |
| MAGE | 6.8% / 2.0% / 55.9% | 58.0% / 6.0% / 82.9% |
| MAGE-OOD | 25.0% / 0.0% / 77.6% | 98.7% / 15.8% / 98.7% |

At the default 0.5 cut-off on the same test half, Fakespot's false-positive rate was 30.1% (recall 95.6%) and Followsci's 8.1% (recall 44.9%). A document-level approximation (pseudo-documents of
four same-label texts, word-weighted mean probability) gave recall 20.0% / 75.0% at FPR 0% for Followsci / Fakespot. The same caveats apply: the datasets are not the target domain, the models' training data is not fully public,
and the thresholds come from about 1,650 texts.

### 6.2 In-domain evaluation (236 educational/technical texts)

`evaluation/indomain/` holds a dataset built for the target use (details and provenance: `evaluation/indomain/README.md`): 118 human and 118 AI paragraphs in four styles (simple English 36/36, formal 36/36,
technical 21/21, conversational 25/25), human text dated before 2022-06-01 (Simple English and English Wikipedia revisions, CPython documentation, Stack Exchange answers) and AI text written by one assistant (Claude)
for the same topics. The split is by topic: train 116 / validation 46 / test 74 (0 shared topics, 0 duplicate texts, maximum cross-split 8-gram overlap 0.007); 56 mixed documents of 4 paragraphs (1 to 3 AI) are
built inside the splits. The train split is not used by any evaluation. `evaluation/indomain/eval_indomain.py` evaluates both existing models, unchanged, at three operating points:
default (P(AI) ≥ 0.5), the Phase-1 thresholds above, and a threshold re-selected on the in-domain validation split.

Test split (37 human, 37 AI; 95% bootstrap intervals roughly 10 to 20 points wide):

| Model and operating point | Accuracy | Precision | Recall | F1 | AUROC | FPR |
|---|---|---|---|---|---|---|
| Followsci, default 0.5 | 63.5% | 91.7% | 29.7% | 44.9% | 65.9% | 2.7% |
| Followsci, Phase-1 thresholds | 62.2% | 90.9% | 27.0% | 41.7% | 65.9% | 2.7% |
| Fakespot, default 0.5 | 62.2% | 58.2% | 86.5% | 69.6% | 78.4% | 62.2% |
| Fakespot, Phase-1 thresholds | 71.6% | 83.3% | 54.1% | 65.6% | 78.4% | 10.8% |
| Fakespot, re-selected on in-domain validation | 66.2% | 100% | 32.4% | 49.0% | 78.4% | 0.0% |

By style, all 236 texts (nothing is fitted, so every split is valid evaluation data), Phase-1 thresholds, AUROC / recall:

| Style | Followsci | Fakespot | Fakespot FPR at default 0.5 |
|---|---|---|---|
| Formal | 95.8% / 72.2% | 93.4% / 86.1% | 47.2% |
| Simple English | 59.3% / 2.8% | 86.9% / 72.2% | 75.0% |
| Conversational | 59.4% / 0.0% | 77.1% / 32.0% | 52.0% |
| Technical | 52.8% / 4.8% | 53.5% / 4.8% | 71.4% |

Over all 236 texts, with Phase-1 thresholds, Followsci had recall 23.7% at FPR 2.5% and Fakespot recall 55.9% at FPR 9.3% (11 of 118 human texts flagged). Through the real application pipeline, the 56 mixed documents
received a document verdict of "likely AI" in 0 cases with Followsci and 2 with Fakespot (mean document P(AI) 72 to 84% for Fakespot, still below its AI threshold). The repository's study-guide PDF fixture
(reported as AI-written; not independently verified, not part of the dataset): Followsci document score 0.1%, Fakespot 19.3%, neither flagged. Caveats: one AI generator family; human text is encyclopedic, documentation or forum prose, not
student writing; small sample; human technical paragraphs are mid-document excerpts while AI ones are self-contained; no paraphrased or humanized text was tested.

## 7. Known limitations

* **Out-of-domain evaluation.** Followsci was trained on arXiv-style academic text. None of the public datasets above (HC3, MAGE) is that
  domain, so the figures do **not** reproduce, and must not be compared with, the accuracy claimed on the upstream model
  card for its own (unreleased) in-domain split. Fakespot's card gives no accuracy figures or training data.
* **Weak recall on several generators.** Followsci's recall is 8.4% on MAGE and 31.3% on the unseen-generator set; it
  misses most AI text from those sources (Fakespot, with its own thresholds, did better on the same test half: see 6.1).
* **Educational / plain-English writing.** In HC3, behaviour on explanatory text varies widely (`open_qa`: 90.4% recall but a 29.8% false-positive rate for Followsci; `finance`: 34.8% recall). On the in-domain set, Followsci recalls almost none of the AI text in simple-English (2.8%), conversational (0%) and technical (4.8%) styles, and Fakespot flags many human texts at its default cut-off. The repository's AI-written study-guide PDF fixture is scored as human by Followsci; the test suite records this as an expected failure (`tests/test_pdf_guide_fixture.py`), not an extraction bug, and Fakespot does not flag it either.
* **Short texts** (under about 80 words), edited or paraphrased text, and non-native English writing are unreliable.
* **Dataset overlap** with the model's own training data cannot be excluded (its split is not public). HC3 AI text is from
  2023 ChatGPT; newer LLMs may behave differently.
* **Sentence highlighting** is a context-window estimate, not a per-sentence classification.
* **Batch progress** is not per-file: `POST /api/batch` returns when the whole batch has finished.
* **No fine-tuning has been performed.** A local fine-tuning experiment was prepared outside this application
  (`../local_finetune/`) but not run, so the shipped models and all numbers above are for the unmodified upstream models (Followsci and Fakespot).
* **Dual-model limits.** Neither model reliably flags mixed human/AI documents (0 of 56 "likely AI" document verdicts for Followsci, 2 of 56 for Fakespot); technical text is near chance for both (AUROC about 53%); a re-selected in-domain
  threshold did not improve results, so the limit is how well each model ranks AI above human text, not where the cut-off sits. The validated thresholds were chosen on out-of-domain data and should be re-validated on in-domain text.
* **Single AI generator, small in-domain sample.** All in-domain AI text comes from one assistant (Claude); human text is encyclopedic, documentation or forum prose. Not measured: paraphrased or humanized text, non-native-English and student writing, other generators.
* **Dual results are not stored** in history, and batch analysis, analytics and reports use Followsci only.
* **Fakespot requires a local cache.** It is never downloaded by the application; without a cached copy the dual page reports an error for that model and the rest of the application is unaffected.
* **Planned, not implemented:** a larger in-domain dataset with several AI generators, student writing and paraphrased text; fine-tuning only after that (no fine-tuned model has been produced or used); a decision on how Followsci's verdict is presented in the dual view.

## 8. Responsible use

AI-text detection is probabilistic. A score is a statistical signal about writing style; it cannot prove or disprove who
wrote a text, and it can be wrong in both directions. It must not be used as the sole basis for an academic-integrity or
disciplinary decision. Use it, if at all, as one input alongside other evidence and a conversation with the author.

This applies to both models and to the dual-model page. Agreement between the two models is not confirmation: their errors were not measured to be independent, and both are weak on simple-English, conversational and technical text. The detector must not be described as able to identify all AI-generated text.

## 9. Testing

* `python -m pytest tests -q` — backend and static-frontend tests (API behaviour, extraction, segmentation, regression
  of the existing detector output, hand-built databases with known statistics, Node-executed frontend logic, print
  stylesheet checks, and comparison of displayed metrics with `metrics.json`).
* `tests/e2e/run_e2e.ps1` — real-browser (Chrome) checks against a throw-away database: uploads of every format, batch
  runs with invalid files, history filters and deletion, analytics versus database values, printing reports to PDF and
  comparing the PDF text with stored results, every metric on the Model Information page versus `metrics.json`, mobile
  layouts, and a scan of all routes for stray `null`/`undefined` text.

`tests/test_dual.py` covers the dual-model feature with both real models: pasted text, TXT, MD, DOCX and PDF giving matching results, no combined score or verdict in any response, Followsci's dual result matching `/api/analyze`,
independent failure handling (load failure and inference failure of either model), short-text and input validation, status/licence/memory reporting, the agreement logic and threshold rules, and that `/classic`, `/` and the existing status endpoint still work.
Last full pytest run (2026-11-21): 145 passed, 1 expected failure (`tests/test_pdf_guide_fixture.py`). The browser (`tests/e2e`) checks were not part of that run; the dual-model page was checked once by hand in headless Chrome at desktop and mobile widths.

