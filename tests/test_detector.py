"""Tests that load the real model (slow on first run; weights are cached afterwards)."""
import torch
from transformers import BertForSequenceClassification, BertTokenizer

from conftest import AI_TEXT, HUMAN_TEXT
from detector import analyze_document
from detector.model import MODEL_NAME


def test_parity_with_original_example(detector):
    """Our wrapper must give the same numbers as the original example_usage.py logic."""
    tok = BertTokenizer.from_pretrained(MODEL_NAME)
    model = BertForSequenceClassification.from_pretrained(MODEL_NAME).eval()
    for text in (AI_TEXT, HUMAN_TEXT):
        inputs = tok(text, return_tensors="pt", truncation=True, max_length=512)
        with torch.no_grad():
            ref = torch.nn.functional.softmax(model(**inputs).logits, dim=-1)[0][1].item()
        ours = detector.predict([text], raw=True)[0]
        assert abs(ref - ours) < 1e-4


def test_batch_matches_single(detector):
    single = [detector.predict([t], raw=True)[0] for t in (AI_TEXT, HUMAN_TEXT)]
    batch = detector.predict([AI_TEXT, HUMAN_TEXT], raw=True)
    assert all(abs(a - b) < 1e-3 for a, b in zip(single, batch))


def test_direction_on_obvious_examples(detector):
    ai, human = detector.predict([AI_TEXT, HUMAN_TEXT], raw=True)
    assert ai > human


def test_insufficient_text(detector):
    r = analyze_document("Too short to judge.", detector)
    assert r.status == "insufficient_text" and r.overall_score is None


def test_document_analysis_structure(detector):
    doc = AI_TEXT + "\n\n" + HUMAN_TEXT + "\n\n" + AI_TEXT
    r = analyze_document(doc, detector)
    assert r.status == "ok"
    assert len(r.paragraphs) == 3
    assert 0 <= r.overall_score <= 1
    for p in r.paragraphs:
        assert p.scored and p.sentences
        for s in p.sentences:
            assert doc[s.start:s.end] == s.text
            assert 0 <= s.score <= 1
    # mixed document: the human paragraph should score below the AI paragraphs
    assert r.paragraphs[1].score < r.paragraphs[0].score


def test_long_document_is_fully_covered(detector):
    doc = "\n\n".join([AI_TEXT] * 12)
    r = analyze_document(doc, detector)
    assert r.scored_words == r.words
    assert len(r.paragraphs) == 12
