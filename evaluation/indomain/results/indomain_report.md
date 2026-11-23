# In-domain evaluation (Phase 2)

Generated 2026-11-21T08:45:50+00:00 by `evaluation/indomain/eval_indomain.py`. Models: the two existing detectors, unchanged. Dataset: 236 paragraph-length texts (118 human, 118 AI), split by topic into train 116 / validation 46 / **held-out test 74**. Train is not used here (reserved for any future fine-tuning). Headline numbers are on the TEST split; thresholds are never tuned on it.

## Test split (n = 74: 37 human, 37 AI)

| Model | Operating point | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN/FP/FN/TP |
|---|---|---|---|---|---|---|---|---|---|
| Followsci BERT | default (P(AI) >= 0.5) | 63.5% | 91.7% | 29.7% | 44.9% | 65.9% | 2.7% | 70.3% | 36/1/26/11 |
| Followsci BERT | Phase-1 thresholds | 62.2% | 90.9% | 27.0% | 41.7% | 65.9% | 2.7% | 73.0% | 36/1/27/10 |
| Followsci BERT | re-selected on in-domain validation | 63.5% | 91.7% | 29.7% | 44.9% | 65.9% | 2.7% | 70.3% | 36/1/26/11 |
| Fakespot RoBERTa | default (P(AI) >= 0.5) | 62.2% | 58.2% | 86.5% | 69.6% | 78.4% | 62.2% | 13.5% | 14/23/5/32 |
| Fakespot RoBERTa | Phase-1 thresholds | 71.6% | 83.3% | 54.1% | 65.6% | 78.4% | 10.8% | 45.9% | 33/4/17/20 |
| Fakespot RoBERTa | re-selected on in-domain validation | 66.2% | 100.0% | 32.4% | 49.0% | 78.4% | 0.0% | 67.6% | 37/0/25/12 |

95% bootstrap confidence intervals (test, 2,000 resamples): the test split is small, so these are wide.

| Model | Operating point | AUROC | Recall | FPR |
|---|---|---|---|---|
| Followsci BERT | default (P(AI) >= 0.5) | 53-78% | 16-46% | 0-8% |
| Followsci BERT | Phase-1 thresholds | 53-78% | 14-43% | 0-8% |
| Followsci BERT | re-selected on in-domain validation | 53-78% | 16-46% | 0-8% |
| Fakespot RoBERTa | default (P(AI) >= 0.5) | 68-88% | 76-97% | 46-76% |
| Fakespot RoBERTa | Phase-1 thresholds | 68-88% | 38-70% | 3-22% |
| Fakespot RoBERTa | re-selected on in-domain validation | 68-88% | 19-49% | 0-0% |

Thresholds (logit margin): Followsci BERT: default 0, Phase-1 +4.91, re-selected -2.08; Fakespot RoBERTa: default 0, Phase-1 +5.13, re-selected +7.04

## All 236 texts, fixed operating points (nothing is fitted here, so every split is valid evaluation data; larger n)

| Model | Operating point | Acc | Prec | Recall | F1 | AUROC | FPR | FNR |
|---|---|---|---|---|---|---|---|---|
| Followsci BERT | default (P(AI) >= 0.5) | 62.7% | 89.5% | 28.8% | 43.6% | 65.8% | 3.4% | 71.2% |
| Followsci BERT | Phase-1 thresholds | 60.6% | 90.3% | 23.7% | 37.6% | 65.8% | 2.5% | 76.3% |
| Fakespot RoBERTa | default (P(AI) >= 0.5) | 63.6% | 59.1% | 88.1% | 70.7% | 80.4% | 61.0% | 11.9% |
| Fakespot RoBERTa | Phase-1 thresholds | 73.3% | 85.7% | 55.9% | 67.7% | 80.4% | 9.3% | 44.1% |

## By writing style (all 236 texts; default threshold and Phase-1 thresholds)

| Model | Style | n (human/AI) | Default: recall / FPR / AUROC | Phase-1: recall / FPR |
|---|---|---|---|---|
| Followsci BERT | simple_english | 36/36 | 2.8% / 5.6% / 59.3% | 2.8% / 5.6% |
| Followsci BERT | conversational | 25/25 | 0.0% / 0.0% / 59.4% | 0.0% / 0.0% |
| Followsci BERT | formal | 36/36 | 88.9% / 2.8% / 95.8% | 72.2% / 2.8% |
| Followsci BERT | technical | 21/21 | 4.8% / 4.8% / 52.8% | 4.8% / 0.0% |
| Fakespot RoBERTa | simple_english | 36/36 | 100.0% / 75.0% / 86.9% | 72.2% / 16.7% |
| Fakespot RoBERTa | conversational | 25/25 | 80.0% / 52.0% / 77.1% | 32.0% / 0.0% |
| Fakespot RoBERTa | formal | 36/36 | 97.2% / 47.2% / 93.4% | 86.1% / 13.9% |
| Fakespot RoBERTa | technical | 21/21 | 61.9% / 71.4% / 53.5% | 4.8% / 0.0% |

Same, test split only:

| Model | Style | n (human/AI) | Default: recall / FPR | Phase-1: recall / FPR | Re-selected: recall / FPR |
|---|---|---|---|---|---|
| Followsci BERT | simple_english | 11/11 | 9.1% / 9.1% | 9.1% / 9.1% | 9.1% / 9.1% |
| Followsci BERT | conversational | 8/8 | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |
| Followsci BERT | formal | 11/11 | 81.8% / 0.0% | 72.7% / 0.0% | 81.8% / 0.0% |
| Followsci BERT | technical | 7/7 | 14.3% / 0.0% | 14.3% / 0.0% | 14.3% / 0.0% |
| Fakespot RoBERTa | simple_english | 11/11 | 100.0% / 72.7% | 72.7% / 9.1% | 54.5% / 0.0% |
| Fakespot RoBERTa | conversational | 8/8 | 62.5% / 62.5% | 12.5% / 0.0% | 0.0% / 0.0% |
| Fakespot RoBERTa | formal | 11/11 | 100.0% / 54.5% | 90.9% / 27.3% | 54.5% / 0.0% |
| Fakespot RoBERTa | technical | 7/7 | 71.4% / 57.1% | 14.3% / 0.0% | 0.0% / 0.0% |

## Error analysis (AI texts only, all splits, Phase-1 thresholds)

Missed = scored below the AI threshold. Share of texts with each feature:

| Model | Group | n | uses 'you' | contraction | '!' | first person | mean words |
|---|---|---|---|---|---|---|---|
| Followsci BERT | caught | 28 | 0.0% | 21.4% | 0.0% | 0.0% | 82 |
| Followsci BERT | missed | 90 | 37.8% | 12.2% | 8.9% | 8.9% | 87 |
| Fakespot RoBERTa | caught | 66 | 28.8% | 13.6% | 4.5% | 4.5% | 86 |
| Fakespot RoBERTa | missed | 52 | 28.8% | 15.4% | 9.6% | 9.6% | 85 |

Human texts wrongly flagged as AI (Phase-1 thresholds): Followsci BERT: 3 (form-wiki_industrial_revolution-hu, simp-wiki_ecosystem-hu, simp-wiki_renaissance-hu); Fakespot RoBERTa: 11 (form-wiki_artificial_intelligence-hu, form-wiki_ecosystem-hu, form-wiki_evolution-hu, form-wiki_gravity-hu, form-wiki_immune_system-hu, simp-wiki_atom-hu, simp-wiki_gravity-hu, simp-wiki_operating_system-hu, simp-wiki_renaissance-hu, simp-wiki_solar_system-hu, simp-wiki_vaccine-hu)

Length-only baseline AUROC (word count alone, all texts): 54.9% (50% would mean length carries no signal; values far from 50% would indicate a length shortcut in the dataset).

## Mixed human/AI documents (4 paragraphs each, real app pipeline, Phase-1 thresholds)

| Model | Paragraphs scored | AI paragraphs flagged | human paragraphs flagged AI | AI paragraphs called human | human paragraphs called human |
|---|---|---|---|---|---|
| Followsci BERT | 224 | 27.3% | 1.0% | 11.6% | 24.3% |
| Fakespot RoBERTa | 224 | 59.5% | 10.7% | 7.4% | 35.9% |

Document-level verdict by how many of the 4 paragraphs are AI (counts of documents):

| Model | AI paragraphs | docs | likely AI | uncertain | likely human | mean doc P(AI) | mean share of paragraphs flagged AI |
|---|---|---|---|---|---|---|---|
| Followsci BERT | 1 of 4 | 9 | 0 | 9 | 0 | 16.4% | 13.9% |
| Followsci BERT | 2 of 4 | 29 | 0 | 29 | 0 | 13.0% | 12.1% |
| Followsci BERT | 3 of 4 | 18 | 0 | 18 | 0 | 23.9% | 20.8% |
| Fakespot RoBERTa | 1 of 4 | 9 | 0 | 9 | 0 | 75.5% | 30.6% |
| Fakespot RoBERTa | 2 of 4 | 29 | 1 | 27 | 1 | 72.5% | 29.3% |
| Fakespot RoBERTa | 3 of 4 | 18 | 1 | 17 | 0 | 83.6% | 52.8% |

## Reference document: the guide PDF in tests/fixtures (reported by the project as AI-written; not independently verified, not part of the dataset)

| Model | Document P(AI) | Verdict (Phase-1 thresholds) | Paragraphs scored / flagged AI | Highest paragraph P(AI) |
|---|---|---|---|---|
| Followsci BERT | 0.1% | uncertain | 11 / 0 | 1.7% |
| Fakespot RoBERTa | 19.3% | likely_human | 11 / 0 | 58.9% |

## Caveats

- **One AI generator family.** All AI text was written by one assistant (Claude) in this session; it is modern assistant style, which is the target, but results may differ for other generators (GPT, Gemini, Llama, ...).
- **Human text is expert/encyclopedic or forum prose** from dated pre-ChatGPT sources; it is not student writing. Student and non-native-English writing was not measured.
- **Small sample** (118 texts per class; test 37 per class). Confidence intervals are wide; treat differences of a few points as noise.
- Human technical paragraphs are mid-document excerpts of reference text, AI technical paragraphs are self-contained, a possible confound for that style.
- No paraphrased or humanized AI text was tested.
