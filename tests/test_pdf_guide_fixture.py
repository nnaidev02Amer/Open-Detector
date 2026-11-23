"""Regression tests built on a real failing document: Browser_Fingerprinting_Project_Simple_Guide.pdf
(5 pages: title, numbered sections with 'Think:' lines, a two-column glossary table, running header/footer).

Investigation result (see the project notes): extraction and segmentation are faithful; the detector model itself
scores every substantive paragraph of this plain-English study guide at ~0 (P(AI) 0.0000-0.017). These tests pin down
what the pipeline must do correctly and document the model limitation instead of hiding it.
"""
import os
import re
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "guide_test.db"))  # never the user's archive

from fastapi.testclient import TestClient  # noqa: E402

from app.extract import extract_text  # noqa: E402
from app.main import app  # noqa: E402
from detector import analyze_document  # noqa: E402
from detector.analysis import MIN_WORDS_PARAGRAPH  # noqa: E402

GUIDE = Path(__file__).parent / "fixtures" / "Browser_Fingerprinting_Project_Simple_Guide.pdf"
HEADINGS = ["Tab-by-tab guide", "1. Overview", "2. Privacy & Consent", "3. History", "4. Experiments",
            "5. Experiments", "6. Experiments", "7. Fingerprint Distinguishability", "8. Recommendations",
            "9. Research Export", "Important words in simple English"]


@pytest.fixture(scope="module")
def guide_text():
    text, kind = extract_text(GUIDE.name, GUIDE.read_bytes())
    assert kind == "pdf"
    return text


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------------- extraction ----------------
def test_running_header_and_page_numbers_do_not_leak(guide_text):
    """The glossary page (a table) falls back to plain extraction; its header used to stay in the text."""
    assert "Simple Study Guide" not in guide_text
    assert not re.search(r"\bPage \d\b", guide_text)


def test_headings_present_in_reading_order(guide_text):
    pos = []
    for h in HEADINGS:
        m = re.search(r"(^|\n\n)" + re.escape(h), guide_text)
        assert m, f"heading missing or not at a paragraph start: {h!r}"
        pos.append(m.start())
    assert pos == sorted(pos)


def test_section_bodies_and_think_lines_preserved(guide_text):
    assert guide_text.count("Think:") == 9
    for phrase in ("A-B-A method", "same application origin", "Research Export", "Phase 3"):
        assert phrase in guide_text


def test_glossary_table_text_preserved(guide_text):
    glossary = guide_text.split("\n\nImportant words in simple English")[1]
    for term in ("Word Simple meaning", "Fingerprint", "Attribute / signal"):
        assert term in glossary
    assert len(glossary.split()) > 250


def test_numeric_table_cells_are_not_treated_as_boilerplate():
    """Bare numbers must survive on fallback (table/column) pages."""
    from pdf_factory import two_column_pdf
    left = "Item 1 2024 12 7 500 3 9 Item 2 2025 14 8 600 4 10 Item 3 2026 16 9 700 5 11 Item 4 2027 18 10 800"
    right = "Total 42 55 61 77 88 99 Notes 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26"
    text, _ = extract_text("t.pdf", two_column_pdf(left, right))
    for token in ("2024", "500", "800", "99"):
        assert token in text


# ---------------- pipeline ----------------
def test_upload_and_pasted_text_give_identical_results(client, guide_text):
    up = client.post("/api/analyze-file", files={"file": (GUIDE.name, GUIDE.read_bytes(), "application/pdf")}).json()
    pasted = client.post("/api/analyze", json={"text": guide_text, "title": "guide"}).json()
    a, b = up["result"], pasted["result"]
    assert a["status"] == b["status"] == "ok"
    assert (a["words"], a["scored_words"], len(a["paragraphs"])) == (b["words"], b["scored_words"], len(b["paragraphs"]))
    assert a["overall_score"] == pytest.approx(b["overall_score"], abs=1e-6)
    assert [p["score"] for p in a["paragraphs"]] == pytest.approx([p["score"] for p in b["paragraphs"]], abs=1e-6)


def test_unscored_words_are_exactly_the_short_paragraphs(detector, guide_text):
    """Why ~200 words are 'not scored': headings / 'Think:' lines / short paragraphs fall under the 25-word rule."""
    r = analyze_document(guide_text, detector)
    for p in r.paragraphs:
        assert p.scored == (p.words >= MIN_WORDS_PARAGRAPH)
    assert r.words - r.scored_words == sum(p.words for p in r.paragraphs if p.words < MIN_WORDS_PARAGRAPH)
    assert 150 < r.words - r.scored_words < 260
    assert r.scored_words > 0.7 * r.words


def test_pipeline_reports_the_model_output_unchanged(detector, guide_text):
    """Each paragraph's reported score is exactly what the model returns for that paragraph (no distortion)."""
    r = analyze_document(guide_text, detector)
    checked = 0
    for p in r.paragraphs:
        if p.scored and p.words <= 300:           # longer paragraphs are chunked, so not a single model call
            direct = detector.predict([guide_text[p.start:p.end]])[0]
            assert p.score == pytest.approx(direct, abs=1e-3)
            checked += 1
    assert checked >= 10


# ---------------- documented model limitation ----------------
@pytest.mark.xfail(strict=False, reason=(
    "KNOWN MODEL LIMITATION, not an extraction bug: every substantive paragraph of this plain-English study guide "
    "scores P(AI) < 0.02 (document 0.002). The detector was trained on arXiv-style text and recognised only ~8% of "
    "MAGE AI text in our evaluation. If this test ever XPASSes the model/pipeline behaviour has changed."))
def test_model_flags_this_study_guide_as_ai(detector, guide_text):
    assert analyze_document(guide_text, detector).verdict == "likely_ai"
