"""Regression tests: AI-written text inside a PDF must be analysed the same way as the same text pasted.

Bug: PDF text lost its paragraph structure (one blob per page), had running headers/footers spliced into
sentences, and sentences were cut at page breaks, which pushed AI paragraphs towards 'human' / 'uncertain'.
Also fixed: split_paragraphs() failed when a paragraph ended with trailing whitespace before a blank line.
"""
import re

import pytest

from app.extract import extract_text
from detector import analyze_document
from detector.segmentation import split_paragraphs
from pdf_factory import paragraphs_pdf, two_column_pdf

AI_PARAGRAPHS = [
    "Artificial intelligence has emerged as a transformative force across numerous sectors, offering significant "
    "opportunities for enhancing efficiency, productivity, and innovation. Furthermore, it is essential to recognize "
    "that the effective integration of these technologies requires a comprehensive and multifaceted approach that "
    "carefully balances technical capabilities with ethical considerations. Moreover, stakeholders must collaborate "
    "to ensure that the benefits of artificial intelligence are distributed equitably across diverse communities.",
    "In conclusion, the integration of renewable energy sources into existing power grids presents both substantial "
    "opportunities and notable challenges that warrant careful consideration by policymakers. Additionally, it is "
    "important to note that technological advancements, regulatory frameworks, and public awareness all play a "
    "crucial role in shaping the transition towards a more sustainable and resilient energy infrastructure for the "
    "benefit of future generations.",
    "Effective communication is a fundamental skill that plays a pivotal role in both personal and professional "
    "contexts. By actively listening, expressing ideas clearly, and demonstrating empathy, individuals can foster "
    "stronger relationships and promote mutual understanding. Furthermore, it is worth emphasizing that continuous "
    "practice and self-reflection are essential for developing the nuanced communication abilities required in "
    "today's increasingly interconnected and rapidly evolving world.",
    "Climate change represents one of the most pressing challenges facing humanity in the twenty-first century, with "
    "far-reaching implications for ecosystems, economies, and societies worldwide. It is therefore imperative that "
    "governments, businesses, and individuals work together to implement comprehensive strategies aimed at reducing "
    "greenhouse gas emissions, enhancing adaptive capacity, and fostering sustainable development across all regions.",
]
HUMAN_PARAGRAPHS = [
    "we ran the thing three times and honestly the third run was weird, loss went up after epoch 4 and i have no idea "
    "why. maybe the lr? i tried halving it but then it just crawled. my labmate thinks the data loader was shuffling "
    "wrong, which, ok, possible, but i checked twice and it looked fine to me. anyway i'm rerunning overnight.",
    "Got to the cabin around nine, Dave had already lit the stove and was complaining about the firewood again. "
    "Nobody slept much; the wind kept banging something loose on the roof. In the morning we found it was just the "
    "lid of the old rain barrel, rolled halfway across the yard, which cheered everyone up more than it should have.",
]


def norm(s: str) -> str:
    # the test PDFs use a font without an explicit encoding, so pypdf decodes ' as a typographic apostrophe
    s = s.replace("’", "'").replace("�", "'")
    return re.sub(r"\s+", " ", s).strip()


def pdf_text(paragraphs, **kw):
    text, kind = extract_text("doc.pdf", paragraphs_pdf(paragraphs, **kw))
    assert kind == "pdf"
    return text.replace("’", "'")  # synthetic test font decodes ' as a typographic apostrophe


# ---------------- extraction (model-free) ----------------
def test_pdf_paragraphs_are_reconstructed():
    text = pdf_text(AI_PARAGRAPHS, lines_per_page=14)  # several pages, paragraphs cross page breaks
    got = [norm(p) for p in text.split("\n\n")]
    assert got == [norm(p) for p in AI_PARAGRAPHS]


def test_headers_footers_and_page_numbers_removed():
    text = pdf_text(AI_PARAGRAPHS, lines_per_page=14)
    assert "Quarterly Review" not in text
    assert not re.search(r"Page \d+ of \d+", text)


def test_sentence_split_by_page_break_is_rejoined():
    text = pdf_text(AI_PARAGRAPHS, lines_per_page=5)
    assert "Quarterly Review" not in text
    # every original sentence must appear intact (no fragment stranded across a page boundary)
    for p in AI_PARAGRAPHS:
        for sent in re.split(r"(?<=[.!?]) ", p):
            assert norm(sent) in norm(text)


def test_indented_paragraphs_without_gaps():
    # several pages (a repeated header can only be recognised when the document has more than one page)
    data = paragraphs_pdf(AI_PARAGRAPHS, indent_first=18, gap=False, lines_per_page=9)
    text, _ = extract_text("doc.pdf", data)
    assert [norm(p) for p in text.split("\n\n")] == [norm(p) for p in AI_PARAGRAPHS]


def test_pdf_without_headers_still_works():
    text = pdf_text(AI_PARAGRAPHS, header=None, footer=None)
    assert len(text.split("\n\n")) == len(AI_PARAGRAPHS)


def test_body_numbers_not_mistaken_for_page_numbers():
    paras = ["The 2024 survey covered 1500 respondents across 12 regions and was repeated in 2025 with similar results "
             "reported by independent reviewers who checked the methodology carefully and found no major issues.",
             "Results were stable. " * 12]
    text = pdf_text(paras, header=None, footer=None)
    for token in ("2024", "1500", "12 regions", "2025"):
        assert token in text


def test_two_column_page_falls_back_without_losing_text():
    left = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon."
    right = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen."
    text, _ = extract_text("cols.pdf", two_column_pdf(left, right))
    words = set(text.lower().replace(".", "").split())
    assert {"alpha", "upsilon", "one", "seventeen"} <= words


def test_unreadable_layout_never_breaks_extraction(monkeypatch):
    import app.extract as ex
    monkeypatch.setattr(ex, "_pdf_text_with_paragraphs", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    text = pdf_text(AI_PARAGRAPHS)
    assert "Artificial intelligence" in text  # falls back to the original plain extraction


# ---------------- segmentation bug ----------------
def test_paragraphs_with_trailing_whitespace_are_kept_separate():
    text = "First paragraph here. \n\nSecond paragraph here.  \n \nThird one."
    assert [p.text for p in split_paragraphs(text)] == ["First paragraph here.", "Second paragraph here.", "Third one."]
    assert len(split_paragraphs("Only one paragraph, with trailing space. ")) == 1


# ---------------- end-to-end with the real model ----------------
def test_pdf_gives_same_analysis_as_pasted_text(detector):
    pasted = "\n\n".join(AI_PARAGRAPHS)
    from_pdf = pdf_text(AI_PARAGRAPHS, lines_per_page=14)
    a, b = analyze_document(pasted, detector), analyze_document(from_pdf, detector)
    assert a.status == b.status == "ok"
    assert len(a.paragraphs) == len(b.paragraphs) == len(AI_PARAGRAPHS)
    assert abs(a.overall_score - b.overall_score) < 0.02       # same text -> same score (no forcing)
    assert a.verdict == b.verdict
    for pa, pb in zip(a.paragraphs, b.paragraphs):
        assert abs(pa.score - pb.score) < 0.05


def test_human_pdf_still_reads_as_human(detector):
    pasted = "\n\n".join(HUMAN_PARAGRAPHS)
    from_pdf = pdf_text(HUMAN_PARAGRAPHS, lines_per_page=8)
    a, b = analyze_document(pasted, detector), analyze_document(from_pdf, detector)
    assert a.verdict == b.verdict
    assert abs(a.overall_score - b.overall_score) < 0.02
    assert b.overall_score < 0.35                                # existing behaviour preserved


def test_ai_pdf_is_not_downgraded_by_extraction(detector):
    """The original bug: paste says AI, PDF says human/uncertain."""
    pasted = analyze_document("\n\n".join(AI_PARAGRAPHS), detector)
    pdf = analyze_document(pdf_text(AI_PARAGRAPHS, lines_per_page=6), detector)  # many short pages
    assert pasted.verdict == "likely_ai"
    assert pdf.verdict == pasted.verdict
    # no AI paragraph may be turned into a 'human' one by the PDF route
    assert all(p.score > 0.65 for p in pasted.paragraphs)
    assert all(p.score > 0.65 for p in pdf.paragraphs)


# ---------------- real-world AI text (HC3 ChatGPT answers from the evaluation set) ----------------
def _hc3_ai_documents(n_docs=3, per_doc=7):
    """Deterministic multi-paragraph documents of real ChatGPT text; skipped when the data is not downloaded."""
    import json
    from pathlib import Path
    f = Path(__file__).resolve().parents[1] / "evaluation" / "data" / "eval_set.jsonl"
    if not f.exists():
        pytest.skip("evaluation data not downloaded (run evaluation/collect_data.py)")
    rows = [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines()]
    texts = [r["text"] for r in rows if r["dataset"] == "HC3" and r["label"] == 1 and "\n" not in r["text"]
             and 90 <= len(r["text"].split()) <= 220]
    return [texts[i * per_doc:(i + 1) * per_doc] for i in range(n_docs)]


def test_real_chatgpt_text_scores_the_same_in_pdf_and_pasted(detector):
    import detector.analysis as an
    old_window, an.WINDOW = an.WINDOW, 10 ** 6   # sentence windows do not affect paragraph/overall scores
    try:
        for paras in _hc3_ai_documents():
            a = analyze_document("\n\n".join(paras), detector)
            b = analyze_document(pdf_text(paras, lines_per_page=12, indent_first=0), detector)
            assert len(a.paragraphs) == len(b.paragraphs) == len(paras)
            assert abs(a.overall_score - b.overall_score) < 0.02
            for pa, pb in zip(a.paragraphs, b.paragraphs):
                assert abs(pa.score - pb.score) < 0.05
    finally:
        an.WINDOW = old_window
