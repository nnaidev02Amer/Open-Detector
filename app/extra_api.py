"""Stage 1 additions: dashboard statistics, history search, batch analysis and model information.

Purely additive. Every number returned here is computed from the stored `analyses` table or from
evaluation/results/metrics.json; nothing is hard-coded or invented. Existing endpoints are untouched.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from detector.analysis import (BAND_AI, BAND_HUMAN, MAX_CHUNK_WORDS, MAX_DOCUMENT_WORDS, MIN_WORDS_DOCUMENT,
                               MIN_WORDS_PARAGRAPH, WINDOW)
from detector.model import MAX_LENGTH, MODEL_NAME

from .extract import ExtractionError, extract_text

MAX_BATCH_FILES = 20
HIST_BINS = 10
EVAL_FILE = Path(__file__).resolve().parents[1] / "evaluation" / "results" / "metrics.json"
SORTS = {
    "newest": "created_at DESC, rowid DESC", "oldest": "created_at ASC, rowid ASC",
    "score_desc": "overall_score DESC, rowid DESC", "score_asc": "overall_score ASC, rowid DESC",
    "words_desc": "words DESC, rowid DESC", "title": "title COLLATE NOCASE ASC, rowid DESC",
}


def _hist(values: List[float]) -> List[int]:
    bins = [0] * HIST_BINS
    for v in values:
        bins[min(HIST_BINS - 1, max(0, int(v * HIST_BINS)))] += 1
    return bins


def _summary(rows: List[dict]) -> dict:
    """Combined overview of analysis rows (dicts with status, overall_score, verdict, words)."""
    ok = [r for r in rows if r["status"] == "ok" and r["overall_score"] is not None]
    verdicts = {"likely_human": 0, "uncertain": 0, "likely_ai": 0}
    for r in ok:
        verdicts[r["verdict"]] += 1
    scores = [r["overall_score"] for r in ok]
    return {
        "documents": len(rows), "scored": len(ok), "insufficient_text": len(rows) - len(ok),
        "verdicts": verdicts,
        "mean_score": (sum(scores) / len(scores)) if scores else None,
        "min_score": min(scores) if scores else None, "max_score": max(scores) if scores else None,
        "total_words": sum(r["words"] for r in rows),
        "score_histogram": _hist(scores), "histogram_bins": HIST_BINS,
    }


def _model_facts(d) -> dict:
    """Facts read directly from the loaded model object (nothing is assumed)."""
    cfg = d.model.config
    return {
        "class": type(d.model).__name__, "model_type": cfg.model_type, "num_labels": cfg.num_labels,
        "id2label": {str(k): v for k, v in cfg.id2label.items()}, "hidden_size": cfg.hidden_size,
        "num_hidden_layers": cfg.num_hidden_layers, "num_attention_heads": cfg.num_attention_heads,
        "max_position_embeddings": cfg.max_position_embeddings, "vocab_size": cfg.vocab_size,
        "parameters": sum(p.numel() for p in d.model.parameters()),
    }


def build_router(store, run_analysis: Callable[[str, str, str], dict]) -> APIRouter:
    """`store` is the app's HistoryStore; `run_analysis(text, title, source)` is main._run (same path as /api/analyze)."""
    router = APIRouter()

    with store._conn() as c:  # additive tables; the `analyses` table is not altered
        c.execute("""CREATE TABLE IF NOT EXISTS batches (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, files INTEGER NOT NULL, summary TEXT NOT NULL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS batch_items (
            batch_id TEXT NOT NULL, position INTEGER NOT NULL, filename TEXT NOT NULL,
            analysis_id TEXT, error TEXT, PRIMARY KEY (batch_id, position))""")

    # ------------------------------------------------------------------ stats
    @router.get("/api/stats")
    def stats(
        date_from: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        date_to: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        source: Optional[str] = Query(None, pattern="^(paste|txt|docx|pdf)$"),
    ) -> dict:
        """Statistics over stored analyses. Optional filters (all additive; no filter = everything, as before)."""
        where, args = [], []
        if date_from:
            where.append("substr(created_at,1,10) >= ?"); args.append(date_from)
        if date_to:
            where.append("substr(created_at,1,10) <= ?"); args.append(date_to)
        if source:
            where.append("source = ?"); args.append(source)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with store._conn() as c:
            total_in_db = c.execute("SELECT COUNT(*) FROM analyses").fetchone()[0]
            rows = [dict(r) for r in c.execute(
                "SELECT id, created_at, title, source, words, status, overall_score, verdict, result FROM analyses " + clause
                + " ORDER BY created_at DESC, rowid DESC", args)]
        recent = [{k: r[k] for k in ("id", "created_at", "title", "source", "words", "status", "overall_score", "verdict")} for r in rows[:8]]
        para_scores, ai_shares = [], []
        for r in rows:
            try:
                res = json.loads(r.pop("result"))
            except ValueError:
                continue
            if r["status"] == "ok":
                para_scores += [p["score"] for p in res.get("paragraphs", []) if p.get("scored") and p.get("score") is not None]
                if res.get("ai_paragraph_share") is not None:
                    ai_shares.append(res["ai_paragraph_share"])
        by_day, by_source = {}, {}
        for r in rows:
            d = by_day.setdefault(r["created_at"][:10], {"date": r["created_at"][:10], "count": 0, "_s": []})
            d["count"] += 1
            if r["status"] == "ok" and r["overall_score"] is not None:
                d["_s"].append(r["overall_score"])
            s = by_source.setdefault(r["source"], [])
            if r["status"] == "ok" and r["overall_score"] is not None:
                s.append(r["overall_score"])
        activity = [{"date": d["date"], "count": d["count"], "mean_score": (sum(d["_s"]) / len(d["_s"])) if d["_s"] else None}
                    for d in sorted(by_day.values(), key=lambda x: x["date"])]
        def _verdicts(src):
            v = {"likely_human": 0, "uncertain": 0, "likely_ai": 0}
            for r in rows:
                if r["source"] == src and r["status"] == "ok" and r["verdict"] in v:
                    v[r["verdict"]] += 1
            return v
        sources = [{"source": k, "count": sum(1 for r in rows if r["source"] == k),
                    "mean_score": (sum(v) / len(v)) if v else None, "verdicts": _verdicts(k)} for k, v in sorted(by_source.items())]
        out = _summary(rows)
        out.update({
            "empty": len(rows) == 0, "activity_by_day": activity, "by_source": sources,
            "paragraph_score_histogram": _hist(para_scores), "paragraphs_scored": len(para_scores),
            "mean_ai_paragraph_share": (sum(ai_shares) / len(ai_shares)) if ai_shares else None,
            "recent": recent, "total_in_database": total_in_db,
            "filters": {"date_from": date_from, "date_to": date_to, "source": source},
        })
        return out

    # ----------------------------------------------------------------- search
    @router.get("/api/history/search")
    def history_search(
        q: Optional[str] = None, verdict: Optional[str] = Query(None, pattern="^(likely_human|uncertain|likely_ai)$"),
        source: Optional[str] = None, status: Optional[str] = Query(None, pattern="^(ok|insufficient_text)$"),
        date_from: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        date_to: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        min_score: Optional[float] = Query(None, ge=0, le=1), max_score: Optional[float] = Query(None, ge=0, le=1),
        sort: str = Query("newest", pattern="^(newest|oldest|score_desc|score_asc|words_desc|title)$"),
        limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
    ) -> dict:
        where, args = [], []
        if q:
            esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("title LIKE ? ESCAPE '\\'"); args.append(f"%{esc}%")
        for col, val in (("verdict", verdict), ("source", source), ("status", status)):
            if val:
                where.append(f"{col} = ?"); args.append(val)
        if date_from:
            where.append("created_at >= ?"); args.append(date_from)
        if date_to:
            where.append("substr(created_at,1,10) <= ?"); args.append(date_to)
        if min_score is not None:
            where.append("overall_score >= ?"); args.append(min_score)
        if max_score is not None:
            where.append("overall_score <= ?"); args.append(max_score)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        with store._conn() as c:
            total = c.execute(f"SELECT COUNT(*) FROM analyses {clause}", args).fetchone()[0]
            rows = c.execute(
                f"SELECT id, created_at, title, source, words, status, overall_score, verdict FROM analyses {clause} "
                f"ORDER BY {SORTS[sort]} LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        return {"total": total, "limit": limit, "offset": offset, "items": [dict(r) for r in rows]}

    # ------------------------------------------------------------------ batch
    def _batch_record(c: sqlite3.Connection, bid: str) -> Optional[dict]:
        b = c.execute("SELECT * FROM batches WHERE id=?", (bid,)).fetchone()
        if not b:
            return None
        items = []
        for it in c.execute("SELECT * FROM batch_items WHERE batch_id=? ORDER BY position", (bid,)):
            row = {"position": it["position"], "filename": it["filename"], "error": it["error"], "analysis_id": it["analysis_id"]}
            a = c.execute("SELECT created_at, source, words, status, overall_score, verdict FROM analyses WHERE id=?",
                          (it["analysis_id"],)).fetchone() if it["analysis_id"] else None
            row.update(dict(a) if a else {"words": None, "status": "error" if it["error"] else "deleted",
                                          "overall_score": None, "verdict": None})
            items.append(row)
        # the summary is recomputed from the live rows so deleted analyses never linger in the overview
        live = [i for i in items if i["analysis_id"] and i["status"] in ("ok", "insufficient_text")]
        return {"id": b["id"], "created_at": b["created_at"], "title": b["title"], "files": b["files"],
                "summary": {**_summary(live), "failed_files": sum(1 for i in items if i["error"])},
                "items": items, "ranked_by_score": [i["analysis_id"] for i in sorted(
                    (i for i in live if i["overall_score"] is not None), key=lambda i: -i["overall_score"])]}

    @router.post("/api/batch")
    async def batch_analyze(files: List[UploadFile] = File(...), title: Optional[str] = Form(None)) -> dict:
        if not files:
            raise HTTPException(400, "No files provided.")
        if len(files) > MAX_BATCH_FILES:
            raise HTTPException(413, f"At most {MAX_BATCH_FILES} files per batch.")
        bid = uuid.uuid4().hex[:12]
        results = []
        for pos, f in enumerate(files):
            name = (f.filename or f"file-{pos + 1}")[:120]
            try:
                text, kind = extract_text(name, await f.read())
                rec = await asyncio.to_thread(run_analysis, text, name, kind)
                results.append((pos, name, rec["id"], None))
            except ExtractionError as e:
                results.append((pos, name, None, str(e)))
            except HTTPException as e:
                results.append((pos, name, None, str(e.detail)))
            except Exception as e:  # noqa: BLE001 - one bad file must not abort the batch
                results.append((pos, name, None, f"Unexpected error: {type(e).__name__}"))
        with store._lock, store._conn() as c:
            c.execute("INSERT INTO batches VALUES (?,?,?,?,?)",
                      (bid, datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       (title or f"Batch of {len(files)} documents")[:120], len(files), "{}"))
            c.executemany("INSERT INTO batch_items VALUES (?,?,?,?,?)", [(bid, p, n, a, e) for p, n, a, e in results])
            return _batch_record(c, bid)

    @router.get("/api/batch")
    def batch_list() -> list:
        with store._conn() as c:
            ids = [r[0] for r in c.execute("SELECT id FROM batches ORDER BY created_at DESC, rowid DESC LIMIT 100")]
            out = []
            for i in ids:
                rec = _batch_record(c, i)
                out.append({k: rec[k] for k in ("id", "created_at", "title", "files", "summary")})
        return out

    @router.get("/api/batch/{bid}")
    def batch_get(bid: str) -> dict:
        with store._conn() as c:
            rec = _batch_record(c, bid)
        if not rec:
            raise HTTPException(404, "Not found.")
        return rec

    @router.delete("/api/batch/{bid}")
    def batch_delete(bid: str) -> dict:
        """Removes the batch grouping only; the individual analyses stay in the history."""
        with store._lock, store._conn() as c:
            n = c.execute("DELETE FROM batches WHERE id=?", (bid,)).rowcount
            c.execute("DELETE FROM batch_items WHERE batch_id=?", (bid,))
        if not n:
            raise HTTPException(404, "Not found.")
        return {"deleted": bid}

    # ------------------------------------------------------------- model info
    @router.get("/api/model-info")
    def model_info() -> dict:
        from detector import get_detector
        d = get_detector()
        info = {
            "model": MODEL_NAME, "architecture": "BERT sequence classifier (binary: human / AI)", "device": d.device,
            "calibrated": d.calibrated, "temperature": d.temperature,
            "scoring": {"max_tokens_per_chunk": MAX_LENGTH, "max_chunk_words": MAX_CHUNK_WORDS, "context_window_sentences": WINDOW,
                        "min_words_document": MIN_WORDS_DOCUMENT, "min_words_paragraph": MIN_WORDS_PARAGRAPH,
                        "max_document_words": MAX_DOCUMENT_WORDS,
                        "bands": {"human_below": BAND_HUMAN, "ai_above": BAND_AI}},
            "limitations": [
                "The score is a stylometric signal, not proof of authorship, and can be wrong.",
                "The model was trained on arXiv-style academic prose; the evaluation datasets are out-of-domain for it.",
                "Short texts (under about 80 words), non-native English, heavily edited and paraphrased text are unreliable.",
                "Highlighting shows 3-sentence context-window estimates, not per-sentence classifications.",
                "Scores are close to binary (see saturation below), so a high or low percentage is not a calibrated probability.",
                "Do not use this tool as the sole basis for an academic-integrity decision.",
            ],
            "evaluation": {"available": False},
            "model_facts": _model_facts(d),
            "known_issues": [
                {"title": "Plain-English educational writing is often scored as human",
                 "text": "The project's own AI-written study-guide fixture is scored as human-written by this model. The test suite records this as a known model limitation, "
                         "not an extraction bug (tests/test_pdf_guide_fixture.py).",
                 "source": "tests/test_pdf_guide_fixture.py (expected-failure test)"},
                {"title": "Trained on arXiv-style academic text",
                 "text": "Academic-paper prose is the model's training domain. Casual, tutorial, glossary or Q&A-style writing is out-of-domain.",
                 "source": "evaluation/results/metrics.json notes"},
            ],
        }
        if EVAL_FILE.exists():
            m = json.loads(EVAL_FILE.read_text(encoding="utf-8"))
            keep = ("name", "n", "n_ai", "n_human", "accuracy", "precision", "recall", "f1", "roc_auc",
                    "false_positive_rate", "false_negative_rate", "confusion")
            ds = [{k: x.get(k) for k in keep} for x in m.get("datasets", [])]
            weaknesses = []
            for x in ds + [{k: y.get(k) for k in keep} for y in m.get("hc3_subsets", [])]:
                if x["recall"] is not None and x["recall"] < 0.5:
                    weaknesses.append(f"Low recall on {x['name']} (n={x['n']}): only {x['recall']*100:.1f}% of AI texts detected.")
                if x["false_positive_rate"] is not None and x["false_positive_rate"] > 0.10:
                    weaknesses.append(f"High false-positive rate on {x['name']} (n={x['n']}): {x['false_positive_rate']*100:.1f}% of human texts flagged as AI.")
            info["evaluation"] = {
                "available": True, "created_utc": m.get("created_utc"), "decision_threshold": m.get("decision_threshold"),
                "seed": m.get("seed"), "datasets": ds,
                "hc3_subsets": [{k: x.get(k) for k in keep} for x in m.get("hc3_subsets", [])],
                "by_length": [{k: x.get(k) for k in keep} for x in m.get("by_length", [])],
                "saturated_share": m.get("saturated_share"), "caveats": m.get("dataset_manifest", {}).get("caveats", []),
                "notes": m.get("notes"), "weaknesses": weaknesses,
            }
        return info

    return router
