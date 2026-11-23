"""Self-contained HTML report for one analysis (printable to PDF from the browser)."""
from __future__ import annotations

from html import escape

VERDICT_LABEL = {"likely_human": "Likely human-written", "uncertain": "Uncertain", "likely_ai": "Likely AI-generated"}


def _tint(score):
    if score is None:
        return "transparent"
    # ink-blue (human) -> neutral -> vermilion (AI); alpha grows with distance from 0.5
    a = min(0.55, abs(score - 0.5) * 1.2)
    rgb = "196,69,43" if score >= 0.5 else "38,84,124"
    return f"rgba({rgb},{a:.2f})"


def render_report(rec: dict) -> str:
    r, text = rec["result"], rec["text"]
    pieces = []
    for p in r["paragraphs"]:
        inner, pos = [], p["start"]
        for s in p["sentences"]:
            inner.append(escape(text[pos:s["start"]]))
            title = f'{s["score"]*100:.0f}% AI (context estimate)' if s["scored"] else "not scored"
            inner.append(f'<span style="background:{_tint(s["score"])}" title="{title}">{escape(s["text"])}</span>')
            pos = s["end"]
        inner.append(escape(text[pos:p["end"]]))
        tag = f'<span class="ps">{p["score"]*100:.0f}%</span>' if p["scored"] else '<span class="ps">skipped</span>'
        pieces.append(f'<p>{tag}{"".join(inner)}</p>')

    if r["status"] == "ok":
        head = (f'<div class="big">{r["overall_score"]*100:.1f}%</div>'
                f'<div class="v">{VERDICT_LABEL[r["verdict"]]}</div>')
    else:
        head = f'<div class="v">No result</div><p>{escape(r["message"])}</p>'
    cal = "temperature-calibrated" if r["calibrated"] else "raw, uncalibrated"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Open Detector report - {escape(rec["title"])}</title>
<style>
body{{font:16px/1.65 Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d1b17;background:#faf7f0}}
h1{{font-size:14px;letter-spacing:.14em;text-transform:uppercase;font-family:Consolas,monospace;margin:0 0 4px}}
.meta{{font:12px Consolas,monospace;color:#6b655a;margin-bottom:24px}}
.big{{font:700 56px Consolas,monospace}} .v{{font:600 18px Consolas,monospace;margin-bottom:8px}}
.box{{border:1px solid #1d1b17;padding:16px 20px;margin-bottom:24px}}
p{{position:relative;margin:0 0 1em;padding-left:56px}}
.ps{{position:absolute;left:0;font:11px Consolas,monospace;color:#6b655a}}
.note{{font:12px/1.5 Consolas,monospace;color:#6b655a;border-top:1px solid #cfc8b8;margin-top:32px;padding-top:12px}}
</style></head><body>
<h1>Open Detector - analysis report</h1>
<div class="meta">{escape(rec["title"])} &middot; {escape(rec["created_at"])} UTC &middot; {r["words"]} words &middot; id {escape(rec["id"])}</div>
<div class="box">{head}
<div class="meta">Model {escape(r["model"])} &middot; scores {cal}</div></div>
{"".join(pieces)}
<div class="note"><b>How to read this.</b> Highlighting shows context-window estimates (3-sentence windows),
not per-sentence classifications; the model was trained on paragraph-length academic text. Blue = more
human-like, red = more AI-like, stronger tint = further from 50%. The score is a stylometric signal, not proof of
authorship, and can be wrong - especially for short texts, non-native English writing and heavily edited text.
Do not use it as the sole basis for any academic-integrity decision.</div>
</body></html>"""
