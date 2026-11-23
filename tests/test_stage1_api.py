"""Stage 1 backend tests: /classic, /api/stats, /api/history/search, /api/batch, /api/model-info.

Uses a temporary database (never data/history.db). Assertions are relative/unique-title based so they stay
correct whichever test module created the app first.
"""
import os
import tempfile
import uuid

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "test_stage1.db"))

from fastapi.testclient import TestClient  # noqa: E402

from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from app.extra_api import _hist, _summary  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    from pathlib import Path
    real = Path(__file__).resolve().parents[1] / "data" / "history.db"
    assert Path(os.environ["OPEN_DETECTOR_DB"]).resolve() != real        # never the real database
    with TestClient(app) as c:
        yield c


def _analyze(client, text, title):
    r = client.post("/api/analyze", json={"text": text, "title": title})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------ pure helpers
def test_histogram_and_empty_summary():
    assert _hist([0.0, 0.05, 0.5, 0.99, 1.0]) == [2, 0, 0, 0, 0, 1, 0, 0, 0, 2]
    s = _summary([])
    assert s["documents"] == 0 and s["mean_score"] is None and sum(s["score_histogram"]) == 0


def test_summary_counts_and_mean():
    rows = [dict(status="ok", overall_score=0.9, verdict="likely_ai", words=100),
            dict(status="ok", overall_score=0.1, verdict="likely_human", words=50),
            dict(status="insufficient_text", overall_score=None, verdict=None, words=5)]
    s = _summary(rows)
    assert s["documents"] == 3 and s["scored"] == 2 and s["insufficient_text"] == 1
    assert s["verdicts"] == {"likely_human": 1, "uncertain": 0, "likely_ai": 1}
    assert s["mean_score"] == pytest.approx(0.5) and s["total_words"] == 155


# ------------------------------------------------------------------ routes
def test_classic_serves_original_ui(client):
    a = client.get("/classic")
    assert a.status_code == 200 and "Open Detector" in a.text and "/static/app.js" in a.text
    # since Stage 2, "/" serves the new interface (covered in test_frontend_shell.py)
    assert client.get("/").status_code == 200


def test_stats_reflect_stored_analyses(client):
    before = client.get("/api/stats").json()
    _analyze(client, AI_TEXT, "stats-ai-" + uuid.uuid4().hex[:6])
    _analyze(client, HUMAN_TEXT, "stats-human-" + uuid.uuid4().hex[:6])
    _analyze(client, "too short", "stats-short-" + uuid.uuid4().hex[:6])
    after = client.get("/api/stats").json()
    assert after["documents"] == before["documents"] + 3
    assert after["scored"] == before["scored"] + 2
    assert after["insufficient_text"] == before["insufficient_text"] + 1
    assert sum(after["verdicts"].values()) == after["scored"]
    assert sum(after["score_histogram"]) == after["scored"]
    assert sum(d["count"] for d in after["activity_by_day"]) == after["documents"]
    assert sum(s["count"] for s in after["by_source"]) == after["documents"]
    assert after["empty"] is False and len(after["recent"]) <= 8
    if after["scored"]:
        assert 0 <= after["mean_score"] <= 1


def test_search_filters_sort_and_pagination(client):
    tag = uuid.uuid4().hex[:8]
    _analyze(client, AI_TEXT, f"{tag}-alpha")
    _analyze(client, HUMAN_TEXT, f"{tag}-beta")
    _analyze(client, "too short", f"{tag}-gamma")
    r = client.get("/api/history/search", params={"q": tag}).json()
    assert r["total"] == 3 and len(r["items"]) == 3
    assert {i["title"] for i in r["items"]} == {f"{tag}-alpha", f"{tag}-beta", f"{tag}-gamma"}
    asc = client.get("/api/history/search", params={"q": tag, "status": "ok", "sort": "score_asc"}).json()["items"]
    assert [i["overall_score"] for i in asc] == sorted(i["overall_score"] for i in asc) and len(asc) == 2
    assert client.get("/api/history/search", params={"q": tag, "status": "insufficient_text"}).json()["total"] == 1
    page = client.get("/api/history/search", params={"q": tag, "limit": 2, "offset": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 1
    v = asc[0]["verdict"]
    only = client.get("/api/history/search", params={"q": tag, "verdict": v}).json()["items"]
    assert only and all(i["verdict"] == v for i in only)
    band = client.get("/api/history/search", params={"q": tag, "min_score": 0.0, "max_score": 1.0}).json()
    assert band["total"] == 2                       # NULL-score (insufficient text) rows are excluded by a score filter
    assert client.get("/api/history/search", params={"q": "%"}).json()["total"] == 0   # LIKE wildcards are escaped
    assert client.get("/api/history/search", params={"date_from": "2999-01-01"}).json()["total"] == 0


def test_search_rejects_bad_parameters_and_existing_history_routes_still_work(client):
    assert client.get("/api/history/search", params={"verdict": "nope"}).status_code == 422
    assert client.get("/api/history/search", params={"sort": "drop table"}).status_code == 422
    assert client.get("/api/history/search", params={"min_score": 5}).status_code == 422
    assert client.get("/api/history/search", params={"date_from": "yesterday"}).status_code == 422
    rec = _analyze(client, HUMAN_TEXT, "route-check")
    assert client.get(f"/api/history/{rec['id']}").json()["id"] == rec["id"]    # {aid} route not shadowed
    assert client.get("/api/history/doesnotexist").status_code == 404
    assert isinstance(client.get("/api/history").json(), list)


def test_batch_mixed_files_and_overview(client):
    files = [("files", ("ai.txt", AI_TEXT.encode(), "text/plain")),
             ("files", ("human.txt", HUMAN_TEXT.encode(), "text/plain")),
             ("files", ("tiny.txt", b"too short", "text/plain")),
             ("files", ("bad.exe", b"MZ\x00\x00", "application/octet-stream"))]
    r = client.post("/api/batch", files=files, data={"title": "stage1 batch"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["title"] == "stage1 batch" and b["files"] == 4 and len(b["items"]) == 4
    by = {i["filename"]: i for i in b["items"]}
    assert by["ai.txt"]["status"] == "ok" and by["human.txt"]["status"] == "ok"
    assert by["tiny.txt"]["status"] == "insufficient_text"
    assert by["bad.exe"]["status"] == "error" and by["bad.exe"]["error"] and by["bad.exe"]["analysis_id"] is None
    s = b["summary"]
    assert s["documents"] == 3 and s["scored"] == 2 and s["failed_files"] == 1 and sum(s["verdicts"].values()) == 2
    assert s["mean_score"] == pytest.approx((by["ai.txt"]["overall_score"] + by["human.txt"]["overall_score"]) / 2)
    assert len(b["ranked_by_score"]) == 2
    top = client.get(f"/api/history/{b['ranked_by_score'][0]}").json()
    assert top["overall_score"] == max(by["ai.txt"]["overall_score"], by["human.txt"]["overall_score"])
    # batch members are ordinary history entries, identical to a single analysis
    single = _analyze(client, AI_TEXT, "single-ai")
    assert single["result"]["overall_score"] == pytest.approx(by["ai.txt"]["overall_score"])
    # retrieval, listing, deletion
    assert client.get(f"/api/batch/{b['id']}").json()["id"] == b["id"]
    assert any(x["id"] == b["id"] for x in client.get("/api/batch").json())
    # deleting an analysis is reflected in the batch overview; deleting the batch keeps analyses
    assert client.delete(f"/api/history/{by['ai.txt']['analysis_id']}").status_code == 200
    after = client.get(f"/api/batch/{b['id']}").json()
    assert after["summary"]["scored"] == 1 and {i["filename"]: i["status"] for i in after["items"]}["ai.txt"] == "deleted"
    assert client.delete(f"/api/batch/{b['id']}").status_code == 200
    assert client.get(f"/api/batch/{b['id']}").status_code == 404
    assert client.get(f"/api/history/{by['human.txt']['analysis_id']}").status_code == 200
    assert client.delete(f"/api/batch/{b['id']}").status_code == 404


def test_batch_limits(client):
    assert client.post("/api/batch").status_code == 422
    many = [("files", (f"f{i}.txt", HUMAN_TEXT.encode(), "text/plain")) for i in range(21)]
    assert client.post("/api/batch", files=many).status_code == 413


def test_model_info_matches_evaluation_file(client):
    import json
    from app.extra_api import EVAL_FILE
    m = client.get("/api/model-info").json()
    assert m["model"] == "followsci/bert-ai-text-detector"
    assert m["scoring"]["bands"] == {"human_below": 0.35, "ai_above": 0.65}
    assert m["limitations"] and "not proof" in m["limitations"][0]
    if EVAL_FILE.exists():
        raw = json.loads(EVAL_FILE.read_text(encoding="utf-8"))
        ev = m["evaluation"]
        assert ev["available"] and [d["n"] for d in ev["datasets"]] == [d["n"] for d in raw["datasets"]]
        assert ev["datasets"][0]["recall"] == raw["datasets"][0]["recall"]       # copied, not recomputed or rounded
        assert ev["saturated_share"] == raw["saturated_share"] and ev["caveats"]
        for w in ev["weaknesses"]:
            assert "recall" in w or "false-positive" in w
        mage = next(d for d in raw["datasets"] if d["name"] == "MAGE")
        assert mage["recall"] < 0.5 and any("MAGE" in w for w in ev["weaknesses"])   # the weakness is surfaced
    else:
        assert m["evaluation"] == {"available": False}
