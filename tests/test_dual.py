"""Dual-model detection: Followsci BERT + Fakespot RoBERTa on identical input.

Runs both real models (Fakespot loads from the local Hugging Face cache; nothing is downloaded or trained).
"""
import io
import os
import tempfile

import pytest

os.environ["OPEN_DETECTOR_DB"] = os.path.join(tempfile.mkdtemp(), "test_dual.db")

from fastapi.testclient import TestClient  # noqa: E402

from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from pdf_factory import paragraphs_pdf  # noqa: E402
from app.main import app  # noqa: E402
from detector import dual  # noqa: E402

PARAS = [
    AI_TEXT,
    "Furthermore, the deployment of automated assessment systems necessitates rigorous validation procedures to ensure "
    "that outcomes remain consistent, transparent, and defensible across heterogeneous student populations and "
    "institutional contexts. Consequently, stakeholders should establish clear governance structures.",
    HUMAN_TEXT,
]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _docx(paras):
    from docx import Document
    d = Document()
    for p in paras:
        d.add_paragraph(p)
    b = io.BytesIO(); d.save(b)
    return b.getvalue()


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def test_pasted_text_runs_both_models_side_by_side(client):
    j = _ok(client.post("/api/analyze-dual", json={"text": "\n\n".join(PARAS)}))
    assert set(j["models"]) == {"followsci", "fakespot"}
    for m in j["models"].values():
        assert m["status"] == "ok" and m["inference_ms"] > 0
        d = m["document"]
        assert abs(d["p_ai"] + d["p_human"] - 1) < 1e-9 and d["verdict"] in ("likely_ai", "likely_human", "uncertain")
        assert m["thresholds"]["human_below"] <= m["thresholds"]["ai_at_or_above"]
        assert m["card"]["licence"]
    # both models saw the same paragraphs
    a, b = j["models"]["followsci"]["paragraphs"], j["models"]["fakespot"]["paragraphs"]
    assert [(p["start"], p["end"]) for p in a] == [(p["start"], p["end"]) for p in b] and len(a) == 3
    assert len(j["comparison"]["paragraphs"]) == 3 and j["comparison"]["document"]["relation"]


def test_never_a_combined_score_or_verdict(client):
    j = _ok(client.post("/api/analyze-dual", json={"text": "\n\n".join(PARAS)}))
    blob = str(sorted(j.keys())) + str(sorted(j["comparison"].keys())) + str(sorted(j["comparison"]["document"].keys()))
    for bad in ("combined", "average", "mean", "ensemble", "final"):
        assert bad not in blob.lower()
    assert "verdict" not in j and "verdict" not in j["comparison"]


def test_followsci_result_matches_the_existing_endpoint(client):
    text = "\n\n".join(PARAS)
    old = _ok(client.post("/api/analyze", json={"text": text}))["result"]
    new = _ok(client.post("/api/analyze-dual", json={"text": text}))["models"]["followsci"]
    assert new["document"]["p_ai"] == pytest.approx(old["overall_score"], abs=1e-9)
    assert new["document"]["shipped_verdict"] == old["verdict"]
    assert [p["p_ai"] for p in new["paragraphs"]] == pytest.approx([p["score"] for p in old["paragraphs"]], abs=1e-9)


def test_all_input_formats_give_identical_results(client):
    text = "\n\n".join(PARAS)
    base = _ok(client.post("/api/analyze-dual", json={"text": text}))
    files = {
        "t.txt": text.encode(), "t.md": text.encode(), "t.docx": _docx(PARAS),
        "t.pdf": paragraphs_pdf(PARAS),
    }
    for name, data in files.items():
        j = _ok(client.post("/api/analyze-file-dual", files={"file": (name, data, "application/octet-stream")}))
        assert j["source"] in ("txt", "docx", "pdf"), name
        for k in ("followsci", "fakespot"):
            assert j["models"][k]["status"] == "ok", (name, k)
            assert j["models"][k]["document"]["p_ai"] == pytest.approx(base["models"][k]["document"]["p_ai"], abs=0.02), (name, k)


def test_each_model_fails_independently(client, monkeypatch):
    text = "\n\n".join(PARAS)

    def boom():
        raise RuntimeError("weights missing")
    for broken, healthy in (("fakespot", "followsci"), ("followsci", "fakespot")):
        monkeypatch.setattr(dual.SLOTS[broken], "obj", None)
        monkeypatch.setattr(dual.SLOTS[broken], "factory", boom)
        j = _ok(client.post("/api/analyze-dual", json={"text": text}))
        assert j["models"][broken]["status"] == "error" and "weights missing" in j["models"][broken]["error"]
        assert j["models"][healthy]["status"] == "ok" and j["models"][healthy]["document"]
        assert j["comparison"] is None
        monkeypatch.undo()


def test_inference_failure_is_contained(client, monkeypatch):
    class Bad:
        device = "cpu"; calibrated = False; temperature = 1.0; model_name = "bad"
        def predict(self, *a, **k):
            raise RuntimeError("cuda exploded")
    monkeypatch.setattr(dual.SLOTS["fakespot"], "obj", Bad())
    j = _ok(client.post("/api/analyze-dual", json={"text": "\n\n".join(PARAS)}))
    assert j["models"]["fakespot"]["status"] == "error" and "cuda exploded" in j["models"]["fakespot"]["error"]
    assert j["models"]["followsci"]["status"] == "ok"


def test_short_text_and_input_validation(client):
    j = _ok(client.post("/api/analyze-dual", json={"text": "Too short to score."}))
    assert all(m["status"] == "insufficient_text" for m in j["models"].values()) and j["comparison"] is None
    assert client.post("/api/analyze-dual", json={"text": "   "}).status_code == 400
    assert client.post("/api/analyze-dual", json={"nope": 1}).status_code == 400
    assert client.post("/api/analyze-dual", json={"text": "x" * 300_001}).status_code == 413
    assert client.post("/api/analyze-file-dual", files={"file": ("a.exe", b"x", "application/octet-stream")}).status_code == 400


def test_status_reports_memory_licence_and_thresholds(client):
    client.post("/api/analyze-dual", json={"text": "\n\n".join(PARAS)})
    s = _ok(client.get("/api/dual/status"))
    assert s["models"]["fakespot"]["loaded"] and s["models"]["fakespot"]["parameters"] > 1e8
    assert s["models"]["fakespot"]["card"]["licence"] == "Apache-2.0" and s["models"]["followsci"]["card"]["licence"] == "MIT"
    assert s["memory_mb"] is not None and s["memory_mb"] > 300          # both models resident
    assert s["models"]["followsci"]["loaded"] and s["models"]["fakespot"]["thresholds"]["validated"]


def test_compare_logic_and_threshold_rules():
    def mk(key, verdicts):
        return {"key": key, "status": "ok", "document": {"verdict": verdicts[0], "p_ai": 0.9 if verdicts[0] == "likely_ai" else 0.1},
                "paragraphs": [{"index": i, "scored": True, "verdict": v, "p_ai": 0.9 if v == "likely_ai" else 0.1} for i, v in enumerate(verdicts)]}
    c = dual.compare(mk("a", ["likely_ai", "likely_ai", "uncertain", "likely_human"]), mk("b", ["likely_ai", "likely_human", "likely_ai", "likely_human"]))
    assert [p["relation"] for p in c["paragraphs"]] == ["agree_ai", "disagree", "partial", "agree_human"]
    assert c["document"]["relation"] == "agree_ai"
    assert dual.compare({"status": "error"}, mk("b", ["likely_ai"])) is None
    rule = {"human_below": 0.2, "ai_at_or_above": 0.8}
    assert [dual.verdict_with(rule, p) for p in (0.1, 0.5, 0.8, 0.99)] == ["likely_human", "uncertain", "likely_ai", "likely_ai"]


def test_existing_features_and_classic_still_served(client):
    assert client.get("/classic").status_code == 200 and client.get("/").status_code == 200
    assert client.get("/api/status").json()["model"] == "followsci/bert-ai-text-detector"
    assert client.get("/static/v2/js/pages/dual.js").status_code == 200 and client.get("/static/v2/css/dual.css").status_code == 200
