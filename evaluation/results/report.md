# Evaluation report

Generated 2026-11-23T06:52:14+00:00 by `evaluation/evaluate.py` (seed 13).

Threshold 0.5 on the raw softmax P(AI). Label 1 = AI.

| Dataset | n | Accuracy | Precision | Recall | F1 | ROC-AUC | FPR | FNR |
|---|---|---|---|---|---|---|---|---|
| HC3 | 2000 | 76.7% | 86.7% | 63.1% | 73.0% | 88.4% | 9.7% | 36.9% |
| MAGE | 1000 | 51.2% | 58.3% | 8.4% | 14.7% | 53.6% | 6.0% | 91.6% |
| MAGE-OOD (unseen LLM) | 300 | 63.0% | 85.5% | 31.3% | 45.9% | 77.9% | 5.3% | 68.7% |
| All combined | 3300 | 67.7% | 84.2% | 43.6% | 57.5% | 76.8% | 8.2% | 56.4% |
| HC3 / finance | 508 | 67.5% | 97.8% | 34.8% | 51.3% | 91.5% | 0.8% | 65.2% |
| HC3 / medicine | 503 | 75.9% | 97.1% | 53.2% | 68.7% | 92.6% | 1.6% | 46.8% |
| HC3 / open_qa | 488 | 80.5% | 76.1% | 90.4% | 82.6% | 90.1% | 29.8% | 9.6% |
| HC3 / wiki_csai | 501 | 83.0% | 90.2% | 74.0% | 81.3% | 92.9% | 8.0% | 26.0% |

## Verdict bands used in the app

| Dataset | Uncertain share | Accuracy on decided | Human called AI | AI called human |
|---|---|---|---|---|
| HC3 | 0.4% | 76.8% | 9.7% | 36.5% |
| MAGE | 0.2% | 51.1% | 6.0% | 91.6% |
| MAGE-OOD (unseen LLM) | 0.3% | 63.2% | 5.3% | 68.0% |
| All combined | 0.4% | 67.8% | 8.2% | 56.1% |

Share of texts scored below 2% or above 98%: **89.7%** (scores are close to binary).

## Accuracy by text length

| Length | n | Accuracy | FPR | FNR |
|---|---|---|---|---|
| 40-79 words | 843 | 68.3% | 16.7% | 67.2% |
| 80-149 words | 936 | 75.0% | 6.1% | 47.8% |
| 150-249 words | 1004 | 65.4% | 1.3% | 49.1% |
| 250-400 words | 517 | 58.0% | 0.4% | 78.3% |

## Short-text stress test (first 50 words of 600 texts)

Accuracy full text: 68.2% -> truncated: 67.5%; ROC-AUC 87.6% -> 81.8%.

## Temperature calibration (held-out half)

T = 12.251, fitted on 1650 texts, evaluated on 1650.

| | NLL | Brier | ECE |
|---|---|---|---|
| raw | 2.9021 | 0.3157 | 0.3144 |
| calibrated | 0.6192 | 0.2142 | 0.1099 |

> Fitted on HC3+MAGE (out-of-domain relative to the model's arXiv training data); may not transfer to academic text.

## Caveats

- None of these datasets is arXiv-style academic prose; they are out-of-domain for the model.
- The model's own training/test split is not public, so overlap with these public datasets cannot be ruled out.
- HC3 AI text is from ChatGPT (2023); newer LLMs may behave differently.
- Paraphrase/adversarial robustness and non-native-writer fairness were NOT measured (no suitable licensed data or paraphraser in scope).
