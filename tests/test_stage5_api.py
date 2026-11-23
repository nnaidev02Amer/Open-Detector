"""Stage 5 backend checks: report endpoints (existing) for present / deleted / missing records, and that every model and
evaluation figure the Model Information page can show equals the original evaluation/results/metrics.json or the loaded model."""
import json
import os
import re
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "test_stage5.db"))

from fastapi.testclient import TestClient  # noqa: E402

from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
METRICS = ROOT / "evaluation" / "results" / "metrics.json"
V2 = ROOT / "app" / "static" / "v2"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _analyze(client, text, title):
    r = client.post("/api/analyze", json={"text": text, "title": title})
    assert r.status_code == 200
    return r.json()


# ------------------------------------------------------------------ existing report endpoints
def test_report_endpoints_for_existing_analysis(client):
    rec = _analyze(client, AI_TEXT + "\n\n" + HUMAN_TEXT, "Report <b>test</b>")
    rid = rec["id"]
    html = client.get(f"/api/report/{rid}.html")
    assert html.status_code == 200 and "<b>test</b>" not in html.text and "&lt;b&gt;test&lt;/b&gt;" in html.text       # title is escaped
    assert f"{rec['result']['overall_score'] * 100:.1f}%" in html.text                                                    # the stored score is what is printed
    dl = client.get(f"/api/report/{rid}.html", params={"download": "true"})
    assert "attachment" in dl.headers["content-disposition"] and rid in dl.headers["content-disposition"]
    js = client.get(f"/api/report/{rid}.json")
    assert js.status_code == 200 and js.json()["id"] == rid and js.json()["result"]["overall_score"] == rec["result"]["overall_score"]
    stored = client.get(f"/api/history/{rid}").json()                                     # the record the new Report view renders from
    assert stored["result"] == js.json()["result"] and stored["text"] == js.json()["text"]


def test_report_for_missing_and_deleted_records(client):
    for url in ("/api/report/doesnotexist.html", "/api/report/doesnotexist.json", "/api/history/doesnotexist", "/api/batch/doesnotexist"):
        assert client.get(url).status_code == 404, url
    rec = _analyze(client, AI_TEXT, "to be deleted")
    assert client.get(f"/api/report/{rec['id']}.html").status_code == 200
    assert client.delete(f"/api/history/{rec['id']}").status_code == 200
    assert client.get(f"/api/report/{rec['id']}.html").status_code == 404
    assert client.get(f"/api/report/{rec['id']}.json").status_code == 404
    assert client.get(f"/api/history/{rec['id']}").status_code == 404


def test_batch_record_after_member_deletion_is_report_safe(client):
    files = [("files", ("one.txt", AI_TEXT.encode(), "text/plain")), ("files", ("two.txt", HUMAN_TEXT.encode(), "text/plain")), ("files", ("bad.exe", b"MZ", "application/octet-stream"))]
    b = client.post("/api/batch", files=files, data={"title": "report batch"}).json()
    ids = {i["filename"]: i["analysis_id"] for i in b["items"]}
    assert client.delete(f"/api/history/{ids['one.txt']}").status_code == 200
    after = client.get(f"/api/batch/{b['id']}").json()
    by = {i["filename"]: i for i in after["items"]}
    assert by["one.txt"]["status"] == "deleted" and by["one.txt"]["analysis_id"] == ids["one.txt"]       # kept so a report can say "removed"
    assert by["two.txt"]["status"] == "ok" and by["bad.exe"]["status"] == "error" and by["bad.exe"]["error"]
    assert after["summary"]["scored"] == 1 and after["summary"]["failed_files"] == 1
    assert client.get(f"/api/history/{ids['one.txt']}").status_code == 404            # the UI must handle this per item


# ------------------------------------------------------------------ model info / evaluation figures
def _pct(d, keys):
    return {k: d[k] for k in keys}


def test_evaluation_endpoint_is_the_original_file_unchanged(client):
    raw = json.loads(METRICS.read_text(encoding="utf-8"))
    api = client.get("/api/evaluation").json()
    assert api.pop("available") is True and api == raw


def test_model_info_evaluation_figures_equal_metrics_json(client):
    raw = json.loads(METRICS.read_text(encoding="utf-8"))
    ev = client.get("/api/model-info").json()["evaluation"]
    keys = ("name", "n", "n_ai", "n_human", "accuracy", "precision", "recall", "f1", "roc_auc", "false_positive_rate", "false_negative_rate", "confusion")
    for section in ("datasets", "hc3_subsets", "by_length"):
        assert len(ev[section]) == len(raw[section]) > 0
        for got, want in zip(ev[section], raw[section]):
            assert got == {k: want[k] for k in keys}, (section, want["name"])                 # identical values, nothing rounded or recomputed
    assert ev["saturated_share"] == raw["saturated_share"] and ev["decision_threshold"] == raw["decision_threshold"] == 0.5
    assert ev["created_utc"] == raw["created_utc"] and ev["seed"] == raw["seed"]
    assert ev["caveats"] == raw["dataset_manifest"]["caveats"]


def test_metrics_are_internally_consistent_with_their_confusion_matrices():
    raw = json.loads(METRICS.read_text(encoding="utf-8"))
    for d in raw["datasets"] + raw["hc3_subsets"] + raw["by_length"]:
        c = d["confusion"]
        assert c["tp"] + c["fn"] == d["n_ai"] and c["tn"] + c["fp"] == d["n_human"] and sum(c.values()) == d["n"], d["name"]
        assert d["recall"] == pytest.approx(c["tp"] / (c["tp"] + c["fn"]), abs=1e-3)
        assert d["false_positive_rate"] == pytest.approx(c["fp"] / (c["fp"] + c["tn"]), abs=1e-3)
        assert d["precision"] == pytest.approx(c["tp"] / (c["tp"] + c["fp"]), abs=1e-3)


def test_model_facts_come_from_the_loaded_model(client):
    from detector import get_detector
    d = get_detector()
    info = client.get("/api/model-info").json()
    f, cfg = info["model_facts"], d.model.config
    assert f["class"] == type(d.model).__name__ == "BertForSequenceClassification"
    assert (f["num_hidden_layers"], f["hidden_size"], f["num_attention_heads"], f["num_labels"]) == (cfg.num_hidden_layers, cfg.hidden_size, cfg.num_attention_heads, cfg.num_labels) == (12, 768, 12, 2)
    assert f["parameters"] == sum(p.numel() for p in d.model.parameters())
    assert info["device"] == d.device and info["model"] == "followsci/bert-ai-text-detector"
    status = client.get("/api/status").json()
    assert status["device"] == info["device"] and status["bands"] == info["scoring"]["bands"]
    assert info["scoring"]["max_tokens_per_chunk"] == 512
    assert info["known_issues"] and all(i["source"] and i["text"] for i in info["known_issues"])


def test_known_issue_about_educational_writing_is_backed_by_the_repo():
    info_src = (ROOT / "app" / "extra_api.py").read_text(encoding="utf-8")
    cited = re.findall(r'"source": "(tests/[^ ]+)', info_src)
    assert cited and all((ROOT / c).is_file() for c in cited)
    assert "KNOWN MODEL LIMITATION" in (ROOT / "tests" / "test_pdf_guide_fixture.py").read_text(encoding="utf-8")


def test_model_page_has_no_hard_coded_performance_numbers():
    for name in ("pages/model.js", "report.js"):
        src = (V2 / "js" / name).read_text(encoding="utf-8")
        assert not re.search(r"\b\d{1,3}\.\d%", src), name                                 # no literal percentages like 63.1%
        assert not re.search(r"(accuracy|recall|precision|auroc|f1)\W{1,6}0\.\d{2,}", src, re.I), name
