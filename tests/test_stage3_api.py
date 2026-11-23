"""Stage 3 backend-facing checks for Detection Studio / Document Intelligence.

The new UI adds no detection code: it calls /api/analyze and /api/analyze-file. These tests prove the results returned
for every input route (paste, TXT, MD, DOCX, PDF) are identical to calling the existing detector directly, and that
empty input, invalid files and large documents are handled.
"""
import io
import os
import tempfile
import time

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "test_stage3.db"))

from fastapi.testclient import TestClient  # noqa: E402

from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from app.extract import MAX_UPLOAD_BYTES, extract_text  # noqa: E402
from app.main import MAX_TEXT_CHARS, app  # noqa: E402
from detector import analyze_document  # noqa: E402
from test_api import _mini_pdf  # noqa: E402

DOC = AI_TEXT + "\n\n" + HUMAN_TEXT


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _same(a: dict, b: dict):
    assert a["status"] == b["status"] == "ok"
    assert a["overall_score"] == pytest.approx(b["overall_score"], abs=1e-9)
    assert a["verdict"] == b["verdict"] and a["words"] == b["words"] and a["scored_words"] == b["scored_words"]
    assert len(a["paragraphs"]) == len(b["paragraphs"])
    for p, q in zip(a["paragraphs"], b["paragraphs"]):
        assert (p["start"], p["end"], p["words"], p["scored"]) == (q["start"], q["end"], q["words"], q["scored"])
        assert p["score"] == pytest.approx(q["score"], abs=1e-9)
        assert [s["score"] for s in p["sentences"]] == pytest.approx([s["score"] for s in q["sentences"]], abs=1e-9)


def test_paste_matches_direct_detector_call(client):
    api = client.post("/api/analyze", json={"text": DOC, "title": "paste"}).json()["result"]
    _same(api, analyze_document(DOC.strip()).to_dict())
    assert api["bands"] == {"human_below": 0.35, "ai_above": 0.65}              # bands the UI draws are the detector's own
    assert api["verdict"] in ("likely_human", "uncertain", "likely_ai")


@pytest.mark.parametrize("name", ["note.txt", "note.md"])
def test_txt_and_md_upload_match_paste(client, name):
    paste = client.post("/api/analyze", json={"text": DOC}).json()
    up = client.post("/api/analyze-file", files={"file": (name, DOC.encode(), "text/plain")}, data={"title": name})
    assert up.status_code == 200, up.text
    assert up.json()["source"] == "txt" and up.json()["title"] == name
    _same(up.json()["result"], paste["result"])


def test_markdown_syntax_does_not_break_analysis(client):
    md = "# A heading\n\n" + AI_TEXT + "\n\n## Another\n\n" + HUMAN_TEXT + "\n"
    r = client.post("/api/analyze-file", files={"file": ("n.md", md.encode(), "text/markdown")})
    assert r.status_code == 200 and r.json()["result"]["status"] == "ok"


def test_docx_upload_matches_extracted_text(client):
    from docx import Document
    d = Document(); d.add_paragraph(AI_TEXT); d.add_paragraph(HUMAN_TEXT)
    buf = io.BytesIO(); d.save(buf)
    up = client.post("/api/analyze-file", files={"file": ("a.docx", buf.getvalue(), "application/octet-stream")}).json()
    text, kind = extract_text("a.docx", buf.getvalue())
    assert up["source"] == kind == "docx" and len(up["result"]["paragraphs"]) == 2
    _same(up["result"], analyze_document(text.strip()).to_dict())


def test_pdf_upload_matches_extracted_text(client):
    pdf = _mini_pdf((AI_TEXT + " " + HUMAN_TEXT).replace("(", "").replace(")", ""))
    up = client.post("/api/analyze-file", files={"file": ("a.pdf", pdf, "application/pdf")}).json()
    text, kind = extract_text("a.pdf", pdf)
    assert up["source"] == kind == "pdf"
    _same(up["result"], analyze_document(text.strip()).to_dict())


def test_real_guide_pdf_matches_direct_call(client):
    from pathlib import Path
    pdf = Path(__file__).parent / "fixtures" / "Browser_Fingerprinting_Project_Simple_Guide.pdf"
    up = client.post("/api/analyze-file", files={"file": (pdf.name, pdf.read_bytes(), "application/pdf")}).json()
    text, _ = extract_text(pdf.name, pdf.read_bytes())
    _same(up["result"], analyze_document(text.strip()).to_dict())
    assert up["result"]["paragraphs"] and all(p["sentences"] for p in up["result"]["paragraphs"] if p["scored"])


def test_stored_record_has_everything_document_intelligence_needs(client):
    rec = client.post("/api/analyze", json={"text": DOC, "title": "di"}).json()
    got = client.get(f"/api/history/{rec['id']}").json()
    assert got["text"] == DOC.strip()
    for p in got["result"]["paragraphs"]:
        assert got["text"][p["start"]:p["end"]].strip()                         # offsets index the stored text
        for s in p["sentences"]:
            assert got["text"][s["start"]:s["end"]] == s["text"]
    assert got["result"]["ai_paragraph_share"] is not None


# ------------------------------------------------------------- bad input
def test_empty_and_whitespace_input(client):
    assert client.post("/api/analyze", json={"text": ""}).status_code == 400
    assert client.post("/api/analyze", json={"text": " \n\t "}).status_code == 400
    assert client.post("/api/analyze", json={"text": 5}).status_code == 400
    assert client.post("/api/analyze-file", files={"file": ("e.txt", b"", "text/plain")}).status_code == 400
    assert client.post("/api/analyze-file", files={"file": ("w.txt", b"   \n  ", "text/plain")}).status_code == 400
    assert client.post("/api/analyze-file").status_code == 422                   # no file field at all


def test_short_text_is_withheld_not_scored(client):
    r = client.post("/api/analyze", json={"text": "Only a few words here."}).json()["result"]
    assert r["status"] == "insufficient_text" and r["overall_score"] is None and r["verdict"] is None and r["message"]


@pytest.mark.parametrize("name,data", [("x.exe", b"MZ\x90"), ("x.png", b"\x89PNG"), ("noext", b"hello"), ("x.doc", b"old"),
                                       ("bad.docx", b"not a zip"), ("bad.pdf", b"%PDF-1.4 broken"), ("x.txt.exe", b"hi")])
def test_invalid_files_rejected_with_message(client, name, data):
    r = client.post("/api/analyze-file", files={"file": (name, data, "application/octet-stream")})
    assert r.status_code == 400 and isinstance(r.json()["detail"], str) and r.json()["detail"]


def test_image_only_pdf_has_clear_error(client):
    blank = _mini_pdf("")                                                         # valid PDF, no selectable text
    r = client.post("/api/analyze-file", files={"file": ("scan.pdf", blank, "application/pdf")})
    assert r.status_code == 400 and ("No selectable text" in r.json()["detail"] or "Could not read" in r.json()["detail"])


# ------------------------------------------------------------- large documents
def test_limits_over_the_wire(client):
    too_long = "word " * (MAX_TEXT_CHARS // 5 + 10)
    r = client.post("/api/analyze", json={"text": too_long})
    assert r.status_code == 413 and "characters" in r.json()["detail"]
    big = b"a" * (MAX_UPLOAD_BYTES + 1)
    r = client.post("/api/analyze-file", files={"file": ("big.txt", big, "text/plain")})
    assert r.status_code == 400 and "10 MB" in r.json()["detail"]


def test_long_documents_are_truncated_and_flagged(client, monkeypatch):
    import detector.analysis as an
    monkeypatch.setattr(an, "MAX_DOCUMENT_WORDS", 160)                            # same code path as the real 20,000-word cap
    text = "\n\n".join([AI_TEXT, HUMAN_TEXT] * 4)
    r = client.post("/api/analyze", json={"text": text}).json()["result"]
    assert r["truncated"] is True and r["words"] <= 160 and r["status"] == "ok"
    normal = client.post("/api/analyze", json={"text": DOC}).json()["result"]
    assert normal["truncated"] is False


def test_multi_paragraph_large_document_completes(client):
    text = "\n\n".join([AI_TEXT, HUMAN_TEXT] * 18)                                 # ~2,100 words, 36 paragraphs
    t0 = time.time()
    r = client.post("/api/analyze", json={"text": text, "title": "large"})
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    assert res["status"] == "ok" and res["words"] > 2000 and len(res["paragraphs"]) == 36 and not res["truncated"]
    assert time.time() - t0 < 300
    # identical paragraphs must score identically regardless of position (no hidden state between paragraphs)
    ai_scores = {round(p["score"], 6) for p in res["paragraphs"][0::2]}
    assert len(ai_scores) == 1
