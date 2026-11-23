# Dual-model evaluation

Generated 2026-11-23T06:52:38+00:00 (seed 13) by `evaluation/dual_eval.py`. Validation n=1647, test n=1653; disjoint, stratified by dataset/subset/label. Thresholds were chosen on the validation half only (AI above = validation FPR <= 5%; human below = keeps >= 95% of validation AI). All results below are on the TEST half.

## Test split, validated thresholds (AI if margin >= ai_above)

| Model | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN | FP | FN | TP |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Followsci BERT | 65.5% | 90.3% | 34.7% | 50.2% | 78.1% | 3.7% | 65.3% | 796 | 31 | 539 | 287 |
| Fakespot RoBERTa | 90.7% | 94.8% | 86.1% | 90.2% | 95.8% | 4.7% | 13.9% | 788 | 39 | 115 | 711 |

## Same test split at the default cut-off (P(AI) >= 0.5), for reference

| Model | Acc | Recall | FPR | AUROC |
|---|---|---|---|---|
| Followsci BERT | 68.4% | 44.9% | 8.1% | 78.1% |
| Fakespot RoBERTa | 82.8% | 95.6% | 30.1% | 95.8% |

## Thresholds (P(AI)) and three-way verdicts on test

| Model | human below | AI at or above | uncertain share | human->AI | human->uncertain | AI->human | AI->uncertain |
|---|---|---|---|---|---|---|---|
| Followsci BERT | 2.128e-06 | 0.9927 | 71.0% | 3.7% | 81.4% | 4.7% | 60.5% |
| Fakespot RoBERTa | 0.4333 | 0.9941 | 18.6% | 4.7% | 27.3% | 4.1% | 9.8% |

## Followsci BERT: test results by dataset / writing style

| Subset | n | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN/FP/FN/TP |
|---|---|---|---|---|---|---|---|---|---|
| HC3 | 1001 | 72.5% | 90.6% | 50.2% | 64.6% | 89.3% | 5.2% | 49.8% | 475/26/249/251 |
| MAGE | 500 | 52.4% | 77.3% | 6.8% | 12.5% | 55.9% | 2.0% | 93.2% | 245/5/233/17 |
| MAGE-OOD | 152 | 62.5% | 100.0% | 25.0% | 40.0% | 77.6% | 0.0% | 75.0% | 76/0/57/19 |
| HC3/wiki_csai | 251 | 80.9% | 93.3% | 66.4% | 77.6% | 93.7% | 4.8% | 33.6% | 120/6/42/83 |
| HC3/finance | 254 | 62.2% | 96.8% | 24.0% | 38.5% | 92.5% | 0.8% | 76.0% | 128/1/95/30 |
| HC3/medicine | 252 | 63.5% | 100.0% | 26.4% | 41.8% | 94.0% | 0.0% | 73.6% | 127/0/92/33 |
| HC3/open_qa | 244 | 84.0% | 84.7% | 84.0% | 84.3% | 92.9% | 16.0% | 16.0% | 100/19/20/105 |
| ALL | 1653 | 65.5% | 90.3% | 34.7% | 50.2% | 78.1% | 3.7% | 65.3% | 796/31/539/287 |

## Fakespot RoBERTa: test results by dataset / writing style

| Subset | n | Acc | Prec | Recall | F1 | AUROC | FPR | FNR | TN/FP/FN/TP |
|---|---|---|---|---|---|---|---|---|---|
| HC3 | 1001 | 97.9% | 97.6% | 98.2% | 97.9% | 99.6% | 2.4% | 1.8% | 489/12/9/491 |
| MAGE | 500 | 76.0% | 90.6% | 58.0% | 70.7% | 82.9% | 6.0% | 42.0% | 235/15/105/145 |
| MAGE-OOD | 152 | 91.4% | 86.2% | 98.7% | 92.0% | 98.7% | 15.8% | 1.3% | 64/12/1/75 |
| HC3/wiki_csai | 251 | 98.4% | 96.9% | 100.0% | 98.4% | 99.9% | 3.2% | 0.0% | 122/4/0/125 |
| HC3/finance | 254 | 98.0% | 98.4% | 97.6% | 98.0% | 99.2% | 1.6% | 2.4% | 127/2/3/122 |
| HC3/medicine | 252 | 99.6% | 100.0% | 99.2% | 99.6% | 99.8% | 0.0% | 0.8% | 127/0/1/124 |
| HC3/open_qa | 244 | 95.5% | 95.2% | 96.0% | 95.6% | 99.5% | 5.0% | 4.0% | 113/6/5/120 |
| ALL | 1653 | 90.7% | 94.8% | 86.1% | 90.2% | 95.8% | 4.7% | 13.9% | 788/39/115/711 |

## Paragraph level vs document level (test)

Document level uses pseudo-documents of 4 same-label test texts, aggregated by word-weighted mean probability (approximation of the app's rule). Same thresholds as paragraph level, no re-tuning.

| Model | Level | n | Acc | Recall | FPR | AUROC |
|---|---|---|---|---|---|---|
| Followsci BERT | paragraph | 1653 | 65.5% | 34.7% | 3.7% | 78.1% |
| Followsci BERT | document | 399 | 59.9% | 20.0% | 0.0% | 83.4% |
| Fakespot RoBERTa | paragraph | 1653 | 90.7% | 86.1% | 4.7% | 95.8% |
| Fakespot RoBERTa | document | 399 | 87.5% | 75.0% | 0.0% | 98.8% |

## Caveats

- Datasets are HC3 (2023 ChatGPT) and MAGE; not educational PDFs written by modern assistants. Training data of both models is not fully public, so overlap cannot be excluded.
- Thresholds chosen on ~1,650 texts; expect them to move with new data. Re-validate on in-domain text before relying on them.
- Paraphrase attacks and fairness for non-native writers were not measured. No result here supports a claim of 100% accuracy.
