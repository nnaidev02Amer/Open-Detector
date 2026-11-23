# Dual-model detection (Phase 1)

Runs **Followsci BERT** (the existing detector) and **Fakespot RoBERTa** (`fakespot-ai/roberta-base-ai-text-detection-v1`,
from the local Hugging Face cache; never downloaded by the app) on identical text and shows both results side by side.

## Rules
- Both models are scored by the existing `analyze_document` (same extraction, segmentation, chunking and paragraph scoring).
- **No averaging and no combined verdict.** Each model decides alone with its own thresholds. The comparison only reports
  agreement (`agree_ai`, `agree_human`, `agree_uncertain`), `partial` (one model uncertain) or `disagree`, per paragraph and for the document.
- A model that fails to load or to run is reported in its own block (`status: "error"`); the other still returns.
- Existing endpoints, history, `/classic` and Followsci scoring are unchanged. Dual results are not stored in history.
  For Followsci the response also carries `shipped_verdict`, the verdict the existing app gives for the same text.

## Use
UI: sidebar footer, **Dual-model compare** (`#/dual`). API:
`GET /api/dual/status`, `POST /api/analyze-dual {"text": ...}`, `POST /api/analyze-file-dual` (multipart `file`: PDF, DOCX, TXT, MD).
Fakespot loads on the first dual request (about 1.4 s) and stays in memory.

## Thresholds
`evaluation/dual_eval.py` splits `eval_set.jsonl` 50/50 (seed 13, stratified by dataset, subset and label) into validation and
test halves, scores both models on identical texts, and chooses each model's thresholds **on the validation half only**:
*AI at or above* = validation false-positive rate <= 5%; *human below* = still keeps >= 95% of validation AI texts above it.
Results are then measured on the untouched test half (`evaluation/results/dual_report.md`, `dual_metrics.json`).
Output: `detector/thresholds.json`. If it is missing, the UI shows the thresholds as "not validated (defaults)".
Reproduce: `.\.venv\Scripts\python.exe evaluation\dual_eval.py` (Fakespot scoring of 3,300 texts takes roughly 40 minutes on CPU; cached afterwards).

## Measured on the test half (n = 1,653; validated thresholds)
| Model | Accuracy | Precision | Recall | F1 | AUROC | FPR | FNR |
|---|---|---|---|---|---|---|---|
| Followsci BERT | 65.5% | 90.3% | 34.7% | 50.2% | 78.1% | 3.7% | 65.3% |
| Fakespot RoBERTa | 90.7% | 94.8% | 86.1% | 90.2% | 95.8% | 4.7% | 13.9% |

Per-dataset and per-style tables, the paragraph vs document comparison and caveats are in `dual_report.md`.
These datasets (HC3, MAGE) are not modern assistant-written educational documents; re-validate on in-domain text.

## Models
| | Followsci BERT | Fakespot RoBERTa |
|---|---|---|
| Licence (model card) | MIT | Apache-2.0 |
| Base | bert-base-uncased | roberta-base |
| Parameters | 109.5 M | 124.6 M (about 500 MB fp32) |
| transformers 5.23.0 / torch 2.15.0 (CPU) | compatible | compatible (label order verified at load: 0 = human, 1 = AI) |

Fakespot's card suggests a `clean_text` helper; it is deliberately not applied so both models see identical input.
Licences and model-card facts were read from the Hugging Face pages on 2026-11-21 and are not re-checked at runtime.
Both licences are declared in the model cards (`license: mit` for Followsci, `license: apache-2.0` for Fakespot). Neither model repository contains a separate `LICENSE` or `NOTICE` file
(re-confirmed 2026-11-23), and neither card names a copyright holder. Model cards: <https://huggingface.co/followsci/bert-ai-text-detector> and
<https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1>; Fakespot's technical report is in <https://github.com/FakespotAILabs/ApolloDFT>. No model weights are bundled in this repository.

## Resources (this machine: 12 logical cores, CPU only, idle)
Server memory 833 MB with Followsci only, 1.40 GB with both models. Inference per model: about 0.7 s for one 90-word paragraph,
4.5-4.8 s for about 900 words, 14-15 s for about 2,600 words (the two models run one after the other, so total time is about their sum).
