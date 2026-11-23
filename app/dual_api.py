"""Dual-model endpoints: Followsci BERT and Fakespot RoBERTa on identical input, side by side.

Purely additive; the existing /api/analyze* endpoints, history and Followsci scoring are untouched. Dual results are
returned to the caller and are NOT written to the history database (its schema holds one score per analysis).
Each model fails independently: a failed model is reported in its own block while the other still returns.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from detector.dual import analyze_dual, status as dual_status

from .extract import ExtractionError, extract_text

MAX_TEXT_CHARS = 300_000
router = APIRouter()


def _run(text: str, title: str, source: str) -> dict:
    text = text.strip()
    if not text:
        raise HTTPException(400, "No text provided.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text is longer than {MAX_TEXT_CHARS:,} characters.")
    return {"title": title or "Untitled", "source": source, **analyze_dual(text)}


@router.get("/api/dual/status")
def status() -> dict:
    return dual_status()


@router.post("/api/analyze-dual")
async def analyze_dual_text(payload: dict) -> dict:
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "Field 'text' (string) is required.")
    return await asyncio.to_thread(_run, text, str(payload.get("title") or "Pasted text")[:120], "paste")


@router.post("/api/analyze-file-dual")
async def analyze_dual_file(file: UploadFile = File(...), title: Optional[str] = Form(None)) -> dict:
    data = await file.read()
    try:
        text, kind = extract_text(file.filename or "", data)
    except ExtractionError as e:
        raise HTTPException(400, str(e))
    return await asyncio.to_thread(_run, text, (title or file.filename or "Upload")[:120], kind)
