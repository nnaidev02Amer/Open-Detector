"""Text extraction from uploaded TXT / DOCX / PDF files."""
from __future__ import annotations

import io
import re
from collections import Counter
from typing import Tuple

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class ExtractionError(ValueError):
    pass


def extract_text(filename: str, data: bytes) -> Tuple[str, str]:
    """Return (text, kind). Raises ExtractionError with a user-readable message."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise ExtractionError("File is larger than 10 MB.")
    name = (filename or "").lower()
    if name.endswith(".txt") or name.endswith(".md"):
        for enc in ("utf-8-sig", "utf-16", "cp1252"):
            try:
                return data.decode(enc), "txt"
            except UnicodeError:
                continue
        raise ExtractionError("Could not decode the text file.")
    if name.endswith(".docx"):
        try:
            from docx import Document
            doc = Document(io.BytesIO(data))
        except Exception as e:  # noqa: BLE001 - library raises many types
            raise ExtractionError("Could not read the DOCX file (is it a valid .docx?).") from e
        parts = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n\n".join(parts), "docx"
    if name.endswith(".pdf"):
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise ExtractionError("The PDF is password-protected.")
            pages = [(pg.extract_text() or "").strip() for pg in reader.pages]
        except ExtractionError:
            raise
        except Exception as e:  # noqa: BLE001
            raise ExtractionError("Could not read the PDF file.") from e
        text = "\n\n".join(p for p in pages if p)
        if not text.strip():
            raise ExtractionError("No selectable text found in the PDF (scanned PDFs are not supported).")
        try:
            rebuilt = _pdf_text_with_paragraphs(reader, pages)
        except Exception:  # noqa: BLE001 - any layout problem: keep the plain extraction below
            rebuilt = None
        return (rebuilt if rebuilt and rebuilt.strip() else _unwrap_pdf_lines(text)), "pdf"
    raise ExtractionError("Unsupported file type. Upload a .txt, .docx or .pdf file.")


# --------------------------------------------------------------------------------------
# PDF paragraph reconstruction.
# Plain PDF text has only line breaks, so every page used to become one giant "paragraph" with
# running headers/footers spliced into the sentences. The detector model is trained on
# paragraph-level text, so that distorted its scores. We rebuild paragraphs from pypdf's layout
# mode (vertical gaps / indentation), drop headers, footers and page numbers repeated across
# pages, and re-join sentences split by a page break. Pages we cannot analyse reliably
# (multi-column, tables) fall back to the plain extraction for that page.
# --------------------------------------------------------------------------------------
_PAGE_NUM = re.compile(r"^(?:page\s*)?[-–—\[(]?\s*\d{1,4}\s*(?:of\s*\d{1,4})?\s*[-–—\])]?$", re.I)
_SENT_END = re.compile(r"[.!?:][\"'”’)\]]*$")
_EDGE_LINES = 3


def _norm_line(s: str) -> str:
    return re.sub(r"\d+", "#", " ".join(s.split())).lower()


def _join_lines(lines):
    joined = ""
    for ln in lines:
        if joined.endswith("-") and ln[:1].islower():
            joined = joined[:-1] + ln
        else:
            joined = (joined + " " + ln).strip()
    return joined


def _edge_indexes(lines):
    nz = [i for i, ln in enumerate(lines) if ln.strip()]
    return nz[:_EDGE_LINES] + nz[-_EDGE_LINES:]


def _page_paragraphs(lines):
    """Paragraphs for one page from layout lines, or None if the page is not single-column prose."""
    body = [ln for ln in lines if ln.strip()]
    if not body:
        return []
    if sum(1 for ln in body if re.search(r"\S {6,}\S", ln)) > 0.2 * len(body):
        return None  # columns or table-like layout
    indents = Counter(len(ln) - len(ln.lstrip()) for ln in body)
    margin = indents.most_common(1)[0][0]
    paras, cur, prev = [], [], None
    for ln in lines:
        if not ln.strip():
            if cur:
                paras.append(cur); cur = []
            prev = None
            continue
        indent = len(ln) - len(ln.lstrip())
        if cur and indent >= margin + 2 and prev is not None and _SENT_END.search(prev):
            paras.append(cur); cur = []
        cur.append(ln.strip())
        prev = ln.strip()
    if cur:
        paras.append(cur)
    return [_join_lines(p) for p in paras if p]


def _pdf_text_with_paragraphs(reader, plain_pages):
    raw = [(pg.extract_text(extraction_mode="layout") or "").replace("\r", "").split("\n") for pg in reader.pages]
    n = len(raw)
    # repeated running headers / footers (same text once digits are ignored) and bare page numbers
    seen = Counter()
    for lines in raw:
        seen.update({_norm_line(lines[i]) for i in _edge_indexes(lines)})
    need = max(2, n // 2)
    drop = [{i for i in _edge_indexes(lines)
             if (n >= 2 and seen[_norm_line(lines[i])] >= need) or _PAGE_NUM.match(lines[i].strip())}
            for lines in raw]
    # running header/footer texts, so the same lines can also be removed from pages that fall back to plain text
    # (a header such as "Title        Page 4" is one wide layout line but two lines in plain text, so compare fragments)
    boiler = {_norm_line(frag) for lines, d in zip(raw, drop) for i in d for frag in re.split(r"\s{3,}", lines[i])}
    boiler = {b for b in boiler if re.search(r"[a-z]", b)}  # never treat bare numbers (table cells) as boilerplate
    pages = []
    for lines, d, plain in zip(raw, drop, plain_pages):
        paras = _page_paragraphs([ln for i, ln in enumerate(lines) if i not in d])
        if paras is None:  # fall back to plain text for this page (tables / columns), minus running headers/footers
            kept = "\n".join(ln for ln in plain.split("\n") if _norm_line(ln) not in boiler)
            paras = [p for p in _unwrap_pdf_lines(kept).split("\n\n") if p]
        pages.append(paras)
    out = []
    for paras in pages:
        for k, p in enumerate(paras):
            if k == 0 and out and not _SENT_END.search(out[-1]) and p[:1].islower():
                out[-1] = _join_lines([out[-1], p])  # sentence continued across a page break
            else:
                out.append(p)
    return "\n\n".join(out)


def _unwrap_pdf_lines(text: str) -> str:
    """PDF text has hard line breaks inside paragraphs; join them, keep blank-line breaks."""
    out = []
    for block in text.replace("\r", "").split("\n\n"):
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        joined = ""
        for ln in lines:
            if joined.endswith("-") and ln[:1].islower():
                joined = joined[:-1] + ln
            else:
                joined = (joined + " " + ln).strip()
        if joined:
            out.append(joined)
    return "\n\n".join(out)
