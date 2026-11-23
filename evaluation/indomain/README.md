# In-domain evaluation set (Phase 2)

236 paragraph-length texts (118 human, 118 AI) in four styles, built to test detectors on **educational and technical writing**
(the target use) instead of HC3/MAGE. Evaluation only: nothing here trains or changes a model or the app.

| Style | Human source (all dated before 2022-06-01; ChatGPT: 2022-11-30) | AI counterpart (same topic) |
|---|---|---|
| simple_english (36) | Simple English Wikipedia, last revision before 2022-06-01 (revision id stored) | "Explain <topic> simply for a beginner" |
| formal (36) | English Wikipedia, last revision before 2022-06-01 | "Formal encyclopedic paragraph about <topic>" |
| technical (21) | CPython 3.11 language-reference text (`pydoc_data.topics`) | "Python reference style" explanation |
| conversational (25) | Stack Exchange answers (cs, physics, biology), created **and** last edited before 2022-06-01, score >= 15 | friendly answer to the same question title |

**Label verification.** Human: every text carries source, title, revision/answer id and timestamp in `dataset.jsonl` (`provenance`).
AI: every AI text was written by one assistant (Claude) in this session for this purpose, with the prompt style recorded; none is copied
from any source (max 8-gram overlap with its human counterpart 0.058). AI paragraphs for four Python topics were rewritten after the first
overlap check flagged near-copies.

**Splits** (by topic, seed 13; both labels of a topic share a split): train 116 / validation 46 / test 74, plus 56 mixed documents
(4 paragraphs, 1-3 AI). Checks in `dataset_report.json`: 0 topics shared across splits, 0 duplicate texts, max cross-split 8-gram Jaccard 0.007.

**Reproduce** (needs network only for step 1; raw API responses are cached in `raw/`):
```
python evaluation/indomain/collect_human.py     # human.jsonl
python evaluation/indomain/build_dataset.py     # dataset.jsonl, mixed_docs.jsonl, dataset_report.json
python evaluation/indomain/eval_indomain.py     # results/indomain_report.md, indomain_metrics.json
```
Licences: Wikipedia CC BY-SA 3.0/4.0, Stack Exchange CC BY-SA (per answer), CPython docs PSF. Redistribute with attribution and share-alike.
Limits: one AI generator, expert/forum human prose (not student writing), small sample, no paraphrased or humanized text.
