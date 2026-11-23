"""Build small text PDFs for tests (no extra libraries): paragraphs wrapped into lines, with a running
header and footer on every page, paragraph gaps, and paragraphs that continue across page breaks."""
from __future__ import annotations

import textwrap
from typing import List, Optional


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(pages: List[List[tuple]]) -> bytes:
    """pages: one list of (x, y, text) per page (PDF coordinates, origin bottom-left)."""
    objs: List[str] = []
    n = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    font_obj = 3 + 2 * n
    for i, lines in enumerate(pages):
        stream = "BT /F1 11 Tf " + " ".join(f"1 0 0 1 {x} {y} Tm ({_esc(t)}) Tj" for x, y, t in lines) + " ET"
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R "
                    f"/Resources << /Font << /F1 {font_obj} 0 R >> >> >>")
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


def paragraphs_pdf(paragraphs: List[str], lines_per_page: int = 28, width: int = 88, indent_first: int = 0,
                   header: Optional[str] = "Quarterly Review - Draft", footer: Optional[str] = "Page {n} of {total}",
                   gap: bool = True) -> bytes:
    """Lay paragraphs out line by line. A paragraph may continue on the next page."""
    flow = []  # ("line", text, indent) or ("gap",)
    for p in paragraphs:
        wrapped = textwrap.wrap(p.replace(" ", " "), width=width, break_on_hyphens=False)
        for k, ln in enumerate(wrapped):
            flow.append(("line", ln, indent_first if (k == 0 and indent_first) else 0))
        if gap:
            flow.append(("gap",))
    pages, cur = [], []
    count = 0
    for item in flow:
        if count >= lines_per_page:
            pages.append(cur); cur, count = [], 0
        cur.append(item); count += 1
    if cur:
        pages.append(cur)
    total = len(pages)
    out = []
    for i, items in enumerate(pages, 1):
        lines = []
        if header:
            lines.append((72, 760, header))
        y = 720
        for it in items:
            if it[0] == "line":
                lines.append((72 + it[2], y, it[1]))
            y -= 14
        if footer:
            lines.append((72, 40, footer.format(n=i, total=total)))
        out.append(lines)
    return build_pdf(out)


def two_column_pdf(left: str, right: str) -> bytes:
    lines = []
    y = 700
    for a, b in zip(textwrap.wrap(left, 34), textwrap.wrap(right, 34)):
        lines.append((72, y, a)); lines.append((330, y, b)); y -= 14
    return build_pdf([lines])
