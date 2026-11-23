"""FastAPI application: JSON API + static single-page frontend."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from detector import analyze_document, get_detector
from detector.analysis import BAND_AI, BAND_HUMAN, MIN_WORDS_DOCUMENT
from detector.model import MODEL_NAME

from .dual_api import router as dual_router
from .extra_api import build_router
from .extract import ExtractionError, extract_text
from .history import HistoryStore
from .reports import render_report

STATIC = Path(__file__).with_name("static")
MAX_TEXT_CHARS = 300_000

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the model once at start so the first request is not slow.
    await asyncio.to_thread(get_detector)
    yield


app = FastAPI(title="Open Detector", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json", lifespan=lifespan)
store = HistoryStore()


@app.get("/api/status")
def status() -> dict:
    d = get_detector()
    return {
        "model": MODEL_NAME, "device": d.device, "calibrated": d.calibrated, "temperature": d.temperature,
        "bands": {"human_below": BAND_HUMAN, "ai_above": BAND_AI}, "min_words": MIN_WORDS_DOCUMENT,
    }


def _run(text: str, title: str, source: str) -> dict:
    text = text.strip()
    if not text:
        raise HTTPException(400, "No text provided.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text is longer than {MAX_TEXT_CHARS:,} characters.")
    result = analyze_document(text).to_dict()
    aid = store.add(title or "Untitled", source, text, result)
    return {"id": aid, "title": title or "Untitled", "source": source, "text": text, "result": result}


# Stage 1 additions (stats, search, batch, model info). Registered before /api/history/{aid} so /api/history/search matches first.
app.include_router(build_router(store, _run))
app.include_router(dual_router)   # dual-model comparison (additive)


@app.get("/classic")
def classic() -> FileResponse:
    """The original interface, kept available while the new UI is built."""
    return FileResponse(STATIC / "index.html")


@app.post("/api/analyze")
async def analyze(payload: dict) -> dict:
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "Field 'text' (string) is required.")
    title = str(payload.get("title") or "Pasted text")[:120]
    return await asyncio.to_thread(_run, text, title, "paste")


@app.post("/api/analyze-file")
async def analyze_file(file: UploadFile = File(...), title: Optional[str] = Form(None)) -> dict:
    data = await file.read()
    try:
        text, kind = extract_text(file.filename or "", data)
    except ExtractionError as e:
        raise HTTPException(400, str(e))
    return await asyncio.to_thread(_run, text, (title or file.filename or "Upload")[:120], kind)


@app.get("/api/history")
def history() -> list:
    return store.list()


@app.get("/api/history/{aid}")
def history_item(aid: str) -> dict:
    rec = store.get(aid)
    if not rec:
        raise HTTPException(404, "Not found.")
    return rec


@app.delete("/api/history/{aid}")
def history_delete(aid: str) -> dict:
    if not store.delete(aid):
        raise HTTPException(404, "Not found.")
    return {"deleted": aid}


@app.delete("/api/history")
def history_clear() -> dict:
    store.clear()
    return {"cleared": True}


@app.get("/api/report/{aid}.html")
def report_html(aid: str, download: bool = False) -> Response:
    rec = store.get(aid)
    if not rec:
        raise HTTPException(404, "Not found.")
    headers = {"Content-Disposition": f'attachment; filename="open-detector-{aid}.html"'} if download else {}
    return HTMLResponse(render_report(rec), headers=headers)


@app.get("/api/report/{aid}.json")
def report_json(aid: str) -> Response:
    rec = store.get(aid)
    if not rec:
        raise HTTPException(404, "Not found.")
    return JSONResponse(rec, headers={"Content-Disposition": f'attachment; filename="open-detector-{aid}.json"'})


@app.get("/api/evaluation")
def evaluation() -> dict:
    """Measured results written by evaluation/evaluate.py ({"available": false} until it has been run)."""
    import json
    f = Path(__file__).resolve().parents[1] / "evaluation" / "results" / "metrics.json"
    if not f.exists():
        return {"available": False}
    return {"available": True, **json.loads(f.read_text(encoding="utf-8"))}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "v2" / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
