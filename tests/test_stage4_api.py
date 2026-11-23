"""Stage 4 backend checks.

Part 1 (no model): a hand-built database with KNOWN rows, so every statistic, filter, sort and page can be verified
against numbers computed by hand, plus empty-database behaviour.
Part 2 (real detector): mixed valid/invalid batch, each result compared with calling the detector directly.
"""
import json
import os
import sqlite3
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "test_stage4_main.db"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.extra_api import build_router  # noqa: E402
from app.history import HistoryStore  # noqa: E402

# (created_at, title, source, words, status, score, verdict)
ROWS = [
    ("2026-11-10T09:00:00+00:00", "alpha essay", "paste", 100, "ok", 0.10, "likely_human"),
    ("2026-11-10T15:30:00+00:00", "Beta report.pdf", "pdf", 200, "ok", 0.90, "likely_ai"),
    ("2026-11-11T08:00:00+00:00", "gamma notes.pdf", "pdf", 300, "ok", 0.50, "uncertain"),
    ("2026-11-12T10:00:00+00:00", "delta thesis.docx", "docx", 400, "ok", 0.20, "likely_human"),
    ("2026-11-12T11:00:00+00:00", "epsilon tiny.txt", "txt", 10, "insufficient_text", None, None),
    ("2026-11-15T12:00:00+00:00", "zeta 100%_sure", "paste", 500, "ok", 0.95, "likely_ai"),
]


def _result(words, status, score, verdict):
    ok = status == "ok"
    paras = [{"index": 0, "start": 0, "end": 5, "words": words, "score": score, "scored": ok, "sentences": []}]
    return {"status": status, "message": "", "words": words, "scored_words": words if ok else 0, "overall_score": score, "verdict": verdict,
            "ai_paragraph_share": (1.0 if verdict == "likely_ai" else 0.0) if ok else None, "paragraphs": paras, "calibrated": False,
            "temperature": 1.0, "model": "test", "truncated": False, "bands": {"human_below": 0.35, "ai_above": 0.65}}


def _build(path, rows):
    store = HistoryStore(path)
    ids = []
    for created, title, src, words, status, score, verdict in rows:
        aid = store.add(title, src, "text " * 5, _result(words, status, score, verdict))
        with sqlite3.connect(path) as c:
            c.execute("UPDATE analyses SET created_at=? WHERE id=?", (created, aid))
        ids.append(aid)
    app = FastAPI()
    app.include_router(build_router(store, lambda text, title, source: {"id": store.add(title, source, text, _result(50, "ok", 0.5, "uncertain"))}))
    return store, app, ids


@pytest.fixture()
def seeded(tmp_path):
    store, app, ids = _build(tmp_path / "s.db", ROWS)
    return TestClient(app), store, ids


@pytest.fixture()
def empty(tmp_path):
    store, app, _ = _build(tmp_path / "e.db", [])
    return TestClient(app), store


# ---------------------------------------------------------------- empty database
def test_empty_database(empty):
    c, _ = empty
    s = c.get("/api/stats").json()
    assert s["empty"] is True and s["documents"] == 0 and s["total_in_database"] == 0 and s["scored"] == 0
    assert s["mean_score"] is None and s["recent"] == [] and s["by_source"] == [] and s["activity_by_day"] == []
    assert sum(s["score_histogram"]) == 0 and sum(s["paragraph_score_histogram"]) == 0
    r = c.get("/api/history/search").json()
    assert r["total"] == 0 and r["items"] == []
    assert c.get("/api/batch").json() == []
    assert c.get("/api/batch/nope").status_code == 404


# ---------------------------------------------------------------- stats vs hand-computed values
def test_unfiltered_stats_match_known_rows(seeded):
    c, _, _ = seeded
    s = c.get("/api/stats").json()
    assert (s["documents"], s["scored"], s["insufficient_text"], s["total_in_database"]) == (6, 5, 1, 6)
    assert s["verdicts"] == {"likely_human": 2, "uncertain": 1, "likely_ai": 2}
    assert s["mean_score"] == pytest.approx((0.10 + 0.90 + 0.50 + 0.20 + 0.95) / 5)
    assert (s["min_score"], s["max_score"], s["total_words"]) == (0.10, 0.95, 1510)
    assert s["score_histogram"] == [0, 1, 1, 0, 0, 1, 0, 0, 0, 2]     # 0.10->bin1, 0.20->bin2, 0.50->bin5, 0.90 and 0.95->bin9
    assert [(d["date"], d["count"]) for d in s["activity_by_day"]] == [("2026-11-10", 2), ("2026-11-11", 1), ("2026-11-12", 2), ("2026-11-15", 1)]
    assert s["activity_by_day"][0]["mean_score"] == pytest.approx(0.5) and s["activity_by_day"][3]["mean_score"] == pytest.approx(0.95)
    by = {x["source"]: x for x in s["by_source"]}
    assert by["paste"]["count"] == 2 and by["paste"]["mean_score"] == pytest.approx(0.525)
    assert by["paste"]["verdicts"] == {"likely_human": 1, "uncertain": 0, "likely_ai": 1}
    assert by["pdf"]["verdicts"] == {"likely_human": 0, "uncertain": 1, "likely_ai": 1}
    assert by["txt"]["mean_score"] is None and by["txt"]["verdicts"] == {"likely_human": 0, "uncertain": 0, "likely_ai": 0}
    assert [r["title"] for r in s["recent"]][:2] == ["zeta 100%_sure", "epsilon tiny.txt"]       # newest first
    assert s["paragraphs_scored"] == 5 and s["filters"] == {"date_from": None, "date_to": None, "source": None}


def test_stats_filters(seeded):
    c, _, _ = seeded
    s = c.get("/api/stats", params={"date_from": "2026-11-11", "date_to": "2026-11-12"}).json()
    assert (s["documents"], s["scored"], s["insufficient_text"]) == (3, 2, 1) and s["total_in_database"] == 6
    assert s["mean_score"] == pytest.approx(0.35) and [d["date"] for d in s["activity_by_day"]] == ["2026-11-11", "2026-11-12"]
    s = c.get("/api/stats", params={"source": "pdf"}).json()
    assert s["documents"] == 2 and s["verdicts"] == {"likely_human": 0, "uncertain": 1, "likely_ai": 1} and [x["source"] for x in s["by_source"]] == ["pdf"]
    s = c.get("/api/stats", params={"date_to": "2026-11-10"}).json()
    assert s["documents"] == 2 and s["mean_score"] == pytest.approx(0.5)                              # whole of the end day is included
    s = c.get("/api/stats", params={"date_from": "2026-11-15", "source": "paste"}).json()
    assert s["documents"] == 1 and s["verdicts"]["likely_ai"] == 1
    none = c.get("/api/stats", params={"date_from": "2027-01-01"}).json()
    assert none["empty"] is True and none["documents"] == 0 and none["total_in_database"] == 6          # "no match" differs from "no data"
    assert c.get("/api/stats", params={"source": "exe"}).status_code == 422
    assert c.get("/api/stats", params={"date_from": "11/11/2026"}).status_code == 422


# ---------------------------------------------------------------- history search / sort / paginate / delete
def test_search_filters_and_sorting(seeded):
    c, _, _ = seeded
    g = lambda **p: c.get("/api/history/search", params=p).json()
    assert g(q="BETA")["total"] == 1                                         # case-insensitive
    assert g(q="100%")["total"] == 1 and g(q="%")["total"] == 1 and g(q="_")["total"] == 1   # wildcards matched literally, not as patterns
    assert g(q="nomatch")["total"] == 0
    assert g(source="pdf")["total"] == 2 and g(verdict="likely_ai")["total"] == 2 and g(status="insufficient_text")["total"] == 1
    assert g(date_from="2026-11-11", date_to="2026-11-12")["total"] == 3
    assert g(verdict="likely_ai", source="pdf")["total"] == 1                # filters combine with AND
    titles = lambda **p: [i["title"] for i in g(**p)["items"]]
    assert titles(sort="newest")[0] == "zeta 100%_sure" and titles(sort="oldest")[0] == "alpha essay"
    assert titles(sort="score_desc", status="ok")[0] == "zeta 100%_sure" and titles(sort="score_asc", status="ok")[0] == "alpha essay"
    assert titles(sort="words_desc")[:2] == ["zeta 100%_sure", "delta thesis.docx"]
    assert titles(sort="title")[0] == "alpha essay"


def test_pagination_is_consistent(seeded):
    c, _, _ = seeded
    seen, total = [], None
    for off in (0, 4):
        r = c.get("/api/history/search", params={"limit": 4, "offset": off, "sort": "oldest"}).json()
        total = r["total"]; seen += [i["id"] for i in r["items"]]
    assert total == 6 and len(seen) == 6 and len(set(seen)) == 6              # pages are disjoint and complete
    assert c.get("/api/history/search", params={"limit": 4, "offset": 8}).json()["items"] == []
    assert c.get("/api/history/search", params={"limit": 500}).status_code == 422 and c.get("/api/history/search", params={"offset": -1}).status_code == 422


def test_delete_is_reflected_everywhere(seeded):
    c, store, ids = seeded
    assert store.delete(ids[1]) is True                                      # same operation DELETE /api/history/{id} performs
    assert c.get("/api/history/search").json()["total"] == 5
    s = c.get("/api/stats").json()
    assert s["documents"] == 5 and s["verdicts"]["likely_ai"] == 1 and s["total_in_database"] == 5
    assert all(r["id"] != ids[1] for r in s["recent"])


def test_batch_summary_counts_in_listing(seeded):
    c, store, ids = seeded
    # a batch referencing two real rows and one failed file, created through the real batch endpoint with a fake runner
    files = [("files", ("a.txt", b"hello world " * 20, "text/plain")), ("files", ("b.txt", b"more words " * 20, "text/plain")), ("files", ("c.exe", b"MZ", "application/octet-stream"))]
    b = c.post("/api/batch", files=files, data={"title": "t"}).json()
    assert b["files"] == 3 and b["summary"]["documents"] == 2 and b["summary"]["failed_files"] == 1
    lst = c.get("/api/batch").json()
    assert len(lst) == 1 and lst[0]["summary"]["failed_files"] == 1 and lst[0]["title"] == "t"


# ---------------------------------------------------------------- real detector: mixed batch
@pytest.fixture(scope="module")
def real():
    from app.main import app
    with TestClient(app) as c:
        yield c


def test_mixed_batch_matches_detector_and_reports_each_failure(real):
    from conftest import AI_TEXT, HUMAN_TEXT
    from detector import analyze_document
    from docx import Document
    import io
    from test_api import _mini_pdf
    d = Document(); d.add_paragraph(AI_TEXT); d.add_paragraph(HUMAN_TEXT)
    buf = io.BytesIO(); d.save(buf)
    files = [("files", ("one.txt", AI_TEXT.encode(), "text/plain")), ("files", ("two.md", ("# T\n\n" + HUMAN_TEXT).encode(), "text/markdown")),
             ("files", ("three.docx", buf.getvalue(), "application/octet-stream")),
             ("files", ("four.pdf", _mini_pdf(AI_TEXT.replace("(", "").replace(")", "")), "application/pdf")),
             ("files", ("short.txt", b"far too short", "text/plain")), ("files", ("bad.exe", b"MZ", "application/octet-stream")),
             ("files", ("corrupt.pdf", b"%PDF-1.4 broken", "application/pdf")), ("files", ("empty.txt", b"", "text/plain"))]
    b = real.post("/api/batch", files=files, data={"title": "mixed"}).json()
    by = {i["filename"]: i for i in b["items"]}
    assert [by[n]["status"] for n in ("one.txt", "two.md", "three.docx", "four.pdf")] == ["ok"] * 4
    assert by["short.txt"]["status"] == "insufficient_text"
    assert all(by[n]["status"] == "error" and by[n]["error"] for n in ("bad.exe", "corrupt.pdf", "empty.txt"))
    s = b["summary"]
    assert (s["documents"], s["scored"], s["insufficient_text"], s["failed_files"]) == (5, 4, 1, 3) and b["files"] == 8
    # every scored result equals a direct call to the existing detector on the same text
    for name in ("one.txt", "two.md", "three.docx", "four.pdf"):
        rec = real.get(f"/api/history/{by[name]['analysis_id']}").json()
        direct = analyze_document(rec["text"]).to_dict()
        assert rec["result"]["overall_score"] == pytest.approx(direct["overall_score"], abs=1e-9), name
        assert by[name]["overall_score"] == pytest.approx(direct["overall_score"], abs=1e-9)
        assert by[name]["verdict"] == direct["verdict"]
    assert s["mean_score"] == pytest.approx(sum(by[n]["overall_score"] for n in ("one.txt", "two.md", "three.docx", "four.pdf")) / 4)
    assert sum(s["verdicts"].values()) == 4 and sum(s["score_histogram"]) == 4
    # stats endpoint on the real app agrees with the history listing
    st = real.get("/api/stats").json()
    assert st["documents"] == real.get("/api/history/search", params={"limit": 1}).json()["total"]
