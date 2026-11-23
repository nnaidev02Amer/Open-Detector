import io
import os
import tempfile

import pytest

os.environ["OPEN_DETECTOR_DB"] = os.path.join(tempfile.mkdtemp(), "test_history.db")

from fastapi.testclient import TestClient  # noqa: E402

from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _mini_pdf(text: str) -> bytes:
    """Hand-built single-page PDF with selectable text (no extra library needed)."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) > 80:
            lines.append(cur); cur = ""
        cur += (" " if cur else "") + w
    lines.append(cur)
    stream = "BT /F1 10 Tf 40 780 Td 12 TL " + " ".join(f"({ln}) Tj T*" for ln in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


def test_status_and_index(client):
    s = client.get("/api/status").json()
    assert s["model"] == "followsci/bert-ai-text-detector"
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200


def test_analyze_paste_and_history_roundtrip(client):
    doc = AI_TEXT + "\n\n" + HUMAN_TEXT
    r = client.post("/api/analyze", json={"text": doc, "title": "t1"})
    assert r.status_code == 200
    rec = r.json()
    assert rec["result"]["status"] == "ok" and len(rec["result"]["paragraphs"]) == 2
    hist = client.get("/api/history").json()
    assert any(h["id"] == rec["id"] for h in hist)
    got = client.get(f"/api/history/{rec['id']}").json()
    assert got["text"] == doc.strip()
    assert got["result"]["overall_score"] == rec["result"]["overall_score"]


def test_reports(client):
    rec = client.post("/api/analyze", json={"text": AI_TEXT, "title": "<script>x</script>"}).json()
    h = client.get(f"/api/report/{rec['id']}.html")
    assert h.status_code == 200 and "<script>x" not in h.text and "&lt;script&gt;" in h.text
    assert "attachment" in client.get(f"/api/report/{rec['id']}.html?download=true").headers["content-disposition"]
    j = client.get(f"/api/report/{rec['id']}.json")
    assert j.json()["id"] == rec["id"]
    assert client.get("/api/report/nope.html").status_code == 404


def test_validation(client):
    assert client.post("/api/analyze", json={"text": "   "}).status_code == 400
    assert client.post("/api/analyze", json={}).status_code == 400
    short = client.post("/api/analyze", json={"text": "Too short."}).json()
    assert short["result"]["status"] == "insufficient_text"


def test_upload_txt_docx_pdf(client):
    r = client.post("/api/analyze-file", files={"file": ("a.txt", AI_TEXT.encode(), "text/plain")})
    assert r.status_code == 200 and r.json()["result"]["status"] == "ok"

    from docx import Document
    d = Document(); d.add_paragraph(AI_TEXT); d.add_paragraph(HUMAN_TEXT)
    buf = io.BytesIO(); d.save(buf)
    r = client.post("/api/analyze-file", files={"file": ("b.docx", buf.getvalue(), "application/octet-stream")})
    assert r.status_code == 200 and len(r.json()["result"]["paragraphs"]) == 2

    r = client.post("/api/analyze-file", files={"file": ("c.pdf", _mini_pdf(AI_TEXT.replace("(", "").replace(")", "")), "application/pdf")})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["words"] > 40


def test_upload_rejections(client):
    assert client.post("/api/analyze-file", files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 400
    assert client.post("/api/analyze-file", files={"file": ("bad.docx", b"notadocx", "application/octet-stream")}).status_code == 400
    assert client.post("/api/analyze-file", files={"file": ("bad.pdf", b"notapdf", "application/pdf")}).status_code == 400


def test_delete_and_clear(client):
    rec = client.post("/api/analyze", json={"text": AI_TEXT}).json()
    assert client.delete(f"/api/history/{rec['id']}").status_code == 200
    assert client.delete(f"/api/history/{rec['id']}").status_code == 404
    client.delete("/api/history")
    assert client.get("/api/history").json() == []


def test_evaluation_endpoint_absent_until_run(client):
    from pathlib import Path
    f = Path(__file__).resolve().parents[1] / "evaluation" / "results" / "metrics.json"
    r = client.get("/api/evaluation")
    assert r.status_code == 200 and r.json()["available"] == f.exists()
