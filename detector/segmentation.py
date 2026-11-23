"""Paragraph / sentence splitting that keeps character offsets into the original text."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

_ABBREV = {
    "e.g", "i.e", "etc", "vs", "fig", "figs", "eq", "eqs", "al", "dr", "mr", "mrs", "ms", "prof",
    "sec", "no", "vol", "cf", "approx", "ref", "refs", "inc", "ltd", "st", "jr", "sr", "resp",
}
_BOUNDARY = re.compile(r"([.!?]+[\"'”’)\]]*)(\s+)(?=[\"'“‘(\[]?[A-Z0-9])")


@dataclass
class Span:
    start: int
    end: int
    text: str


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", text))


def split_paragraphs(text: str) -> List[Span]:
    """Paragraphs are blocks separated by blank lines. If the text has no blank lines
    but several long single-line paragraphs, split on newlines instead."""
    spans: List[Span] = []
    for m in re.finditer(r"\S(?:.*?\S)?(?=\s*\n\s*\n|\s*\Z)", text, flags=re.S):
        spans.append(Span(m.start(), m.end(), m.group()))
    if len(spans) == 1 and "\n" in spans[0].text:
        lines = list(re.finditer(r"[^\n]*\S[^\n]*", text))
        if sum(1 for m in lines if word_count(m.group()) >= 15) >= 2:
            spans = [Span(m.start(), m.start() + len(m.group().rstrip()), m.group().rstrip()) for m in lines]
    return spans


def split_sentences(par: Span) -> List[Span]:
    """Split a paragraph into sentences. Offsets are relative to the full document."""
    t = par.text
    cuts = [0]
    for m in _BOUNDARY.finditer(t):
        before = t[: m.start(1)]
        last_word = re.findall(r"([A-Za-z.]+)$", before)
        if last_word and last_word[0].lower().rstrip(".") in _ABBREV and m.group(1).startswith("."):
            continue
        if re.search(r"\b[A-Z]$", before) and m.group(1) == ".":  # initials: "J. Smith"
            continue
        cuts.append(m.end())
    cuts.append(len(t))
    out: List[Span] = []
    for a, b in zip(cuts, cuts[1:]):
        seg = t[a:b]
        stripped = seg.strip()
        if not stripped:
            continue
        lead = len(seg) - len(seg.lstrip())
        out.append(Span(par.start + a + lead, par.start + a + lead + len(stripped), stripped))
    return out
