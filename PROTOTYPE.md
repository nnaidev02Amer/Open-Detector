# Open Detector - final-year prototype layer

Added on top of the original repository. The original Followsci detector, extraction, segmentation, thresholds, endpoints and the
original web interface are unchanged (`example_usage.py` still works; the original interface is served at `/classic`).
A **dual-model comparison** (Followsci BERT + Fakespot RoBERTa on the same input, side by side) was added beside them.
Full documentation: [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DUAL_MODEL.md`](docs/DUAL_MODEL.md) and the "Web Application" section of `README_EN.md`.

## Run the web app
```powershell
cd Open-Detector     # the repository folder (skip if you are already inside it)
.\run.ps1            # then open http://127.0.0.1:8000   (new UI at /, dual-model page at /#/dual, original UI at /classic, API docs at /api/docs)
```
(equivalent: `.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`)

Followsci downloads automatically on first start. Fakespot is **never downloaded by the app** and is loaded from the local Hugging Face cache on the first dual-model request.
Cache it once while online (needed only for the dual-model page; if it is missing, that page reports an error for that model and everything else works):
```powershell
.\.venv\Scripts\hf.exe download fakespot-ai/roberta-base-ai-text-detection-v1
```
Measured on the development machine (CPU only): server memory about 0.83 GB with Followsci only and about 1.4 GB with both models.

## Other commands
```powershell
.\.venv\Scripts\python.exe -m detector.cli path\to\file.txt     # terminal scoring (Followsci only)
.\.venv\Scripts\python.exe -m pytest tests -q                   # backend + frontend logic tests, incl. tests\test_dual.py (see tests/ for the list)
.\tests\e2e\run_e2e.ps1                                         # real-browser checks on a throw-away database (Node 22+, Chrome)
.\.venv\Scripts\python.exe evaluation\collect_data.py           # build evaluation set (see evaluation/README.md)
.\.venv\Scripts\python.exe evaluation\evaluate.py               # Followsci metrics on HC3 + MAGE -> evaluation/results/
.\.venv\Scripts\python.exe evaluation\dual_eval.py              # both models, validation/test split -> detector\thresholds.json, evaluation\results\dual_report.md
.\.venv\Scripts\python.exe evaluation\indomain\eval_indomain.py # both models on the 236-text in-domain set -> evaluation\indomain\results\
```

## Layout
- `detector/` - Followsci model wrapper (`model.py`), segmentation, document analysis (3-sentence context windows), optional calibration, and the dual-model module (`dual.py`: Fakespot loader,
  per-model thresholds, dual analysis, agreement) with its validated thresholds in `thresholds.json`
- `app/` - FastAPI backend: `main.py` (analyse, upload, history, reports), `extra_api.py` (stats, search, batch, model info), `dual_api.py` (dual-model endpoints),
  SQLite history, TXT/DOCX/PDF extraction, original HTML report
- `app/static/` - original interface (`index.html`, `app.js`, `styles.css`) and the new interface in `v2/`
  (8 modules: dashboard, studio, document intelligence, batch, history, analytics, report center, model information; plus the dual-model comparison page `#/dual`, linked from the sidebar footer)
- `evaluation/` - dataset collection and evaluation scripts (`evaluate.py`, `dual_eval.py`), results, methodology; `evaluation/indomain/` - the in-domain educational/technical dataset (236 texts), its builders and evaluation
- `tests/` - pytest suite and `tests/e2e/` browser scripts
- `docs/` - architecture, API reference, methodology and limitations (`ARCHITECTURE.md`), the dual-model feature (`DUAL_MODEL.md`); `images/ui/` - screenshots (taken before the dual-model page was added)

History is stored in `data/history.db` (local only). Batch tables (`batches`, `batch_items`) are created beside the original
`analyses` table. Dual-model results are returned to the caller and are **not** stored. There is intentionally no text-rewriting / humanizer feature.

## Status
Academic prototype. The application ships two unmodified upstream models: `followsci/bert-ai-text-detector` (used everywhere) and `fakespot-ai/roberta-base-ai-text-detection-v1`
(dual-model page only); no fine-tuning has been run and no fine-tuned model exists. Each model decides independently with its own validated thresholds; probabilities are never averaged
and there is no combined verdict. Measured accuracy is modest (see the evaluation tables in `README.md`): on the 236-text in-domain set both models are weak on simple-English, conversational and technical
text, Followsci in particular, and neither flags mixed human/AI documents reliably. The detector does not reliably identify AI-generated text. Results are probabilistic signals, never proof of authorship.
Planned, not implemented: a larger, more varied in-domain dataset (more AI generators, student writing, paraphrased text), and fine-tuning only after that.
