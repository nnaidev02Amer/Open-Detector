"""Document-level analysis.

Design note
-----------
The underlying model was trained on *paragraph-level* text, so scoring isolated
sentences would be out-of-distribution. Instead we:

1. score every paragraph (long paragraphs are split into <= ~300-word chunks);
2. score overlapping windows of ``WINDOW`` consecutive sentences inside each paragraph;
3. give each sentence the mean score of the windows that cover it.

Sentence scores are therefore *context-window estimates*, not per-sentence classifications.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

from .model import Detector, get_detector
from .segmentation import Span, split_paragraphs, split_sentences, word_count

WINDOW = 3
MIN_WORDS_DOCUMENT = 40      # below this the result is withheld as unreliable
MIN_WORDS_PARAGRAPH = 25     # shorter paragraphs are not scored on their own
MAX_CHUNK_WORDS = 300
MAX_DOCUMENT_WORDS = 20000

# Heuristic decision bands (NOT fitted thresholds; see evaluation/ for measured behaviour).
BAND_HUMAN = 0.35
BAND_AI = 0.65


def verdict_for(p: float) -> str:
    if p < BAND_HUMAN:
        return "likely_human"
    if p > BAND_AI:
        return "likely_ai"
    return "uncertain"


@dataclass
class SentenceResult:
    start: int
    end: int
    text: str
    score: Optional[float]
    scored: bool


@dataclass
class ParagraphResult:
    index: int
    start: int
    end: int
    words: int
    score: Optional[float]
    scored: bool
    sentences: List[SentenceResult] = field(default_factory=list)


@dataclass
class DocumentAnalysis:
    status: str                       # "ok" | "insufficient_text"
    message: str
    words: int
    scored_words: int
    overall_score: Optional[float]
    verdict: Optional[str]
    ai_paragraph_share: Optional[float]
    paragraphs: List[ParagraphResult]
    calibrated: bool
    temperature: float
    model: str
    truncated: bool = False
    bands: Dict[str, float] = field(default_factory=lambda: {"human_below": BAND_HUMAN, "ai_above": BAND_AI})

    def to_dict(self) -> dict:
        return asdict(self)


def _chunk_sentences(sents: List[Span]) -> List[List[Span]]:
    chunks, cur, n = [], [], 0
    for s in sents:
        w = word_count(s.text)
        if cur and n + w > MAX_CHUNK_WORDS:
            chunks.append(cur)
            cur, n = [], 0
        cur.append(s)
        n += w
    if cur:
        chunks.append(cur)
    return chunks


def analyze_document(text: str, detector: Optional[Detector] = None) -> DocumentAnalysis:
    det = detector or get_detector()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    total_words = word_count(text)
    truncated = False
    if total_words > MAX_DOCUMENT_WORDS:
        cut = len(text) * MAX_DOCUMENT_WORDS // total_words
        nl = text.rfind("\n", 0, cut)
        text = text[: nl if nl > 0 else cut]
        total_words = word_count(text)
        truncated = True

    base = dict(calibrated=det.calibrated, temperature=det.temperature, model=det.model_name, truncated=truncated)
    if total_words < MIN_WORDS_DOCUMENT:
        return DocumentAnalysis(
            status="insufficient_text",
            message=f"Only {total_words} words. At least {MIN_WORDS_DOCUMENT} are needed for a meaningful result; "
                    "the detector was trained on paragraph-length academic text.",
            words=total_words, scored_words=0, overall_score=None, verdict=None,
            ai_paragraph_share=None, paragraphs=[], **base,
        )

    # ---- segmentation -------------------------------------------------
    paragraphs: List[ParagraphResult] = []
    par_sents: List[List[Span]] = []
    for i, p in enumerate(split_paragraphs(text)):
        par_sents.append(split_sentences(p))
        paragraphs.append(ParagraphResult(i, p.start, p.end, word_count(p.text), None, False, []))

    # ---- build every text we need to score, in one batch -----------------
    jobs: List[str] = []
    chunk_jobs: Dict[int, List[tuple]] = {}   # paragraph idx -> [(job idx, words)]
    window_jobs: Dict[int, List[tuple]] = {}  # paragraph idx -> [(job idx, first sent, last sent)]
    for pi, (par, sents) in enumerate(zip(paragraphs, par_sents)):
        if par.words < MIN_WORDS_PARAGRAPH or not sents:
            continue
        for ch in _chunk_sentences(sents):
            chunk_text = text[ch[0].start : ch[-1].end]
            chunk_jobs.setdefault(pi, []).append((len(jobs), word_count(chunk_text)))
            jobs.append(chunk_text)
        if len(sents) > WINDOW:
            for a in range(0, len(sents) - WINDOW + 1):
                w = sents[a : a + WINDOW]
                if sum(word_count(s.text) for s in w) > MAX_CHUNK_WORDS:
                    continue
                window_jobs.setdefault(pi, []).append((len(jobs), a, a + WINDOW - 1))
                jobs.append(text[w[0].start : w[-1].end])

    scores = det.predict(jobs) if jobs else []

    # ---- assemble --------------------------------------------------------
    scored_words = 0
    weighted = 0.0
    for pi, (par, sents) in enumerate(zip(paragraphs, par_sents)):
        chunks = chunk_jobs.get(pi)
        if chunks:
            tw = sum(w for _, w in chunks)
            par.score = sum(scores[j] * w for j, w in chunks) / tw
            par.scored = True
            scored_words += par.words
            weighted += par.score * par.words
        sent_scores: List[List[float]] = [[] for _ in sents]
        for j, a, b in window_jobs.get(pi, []):
            for k in range(a, b + 1):
                sent_scores[k].append(scores[j])
        for k, s in enumerate(sents):
            if sent_scores[k]:
                sc, ok = sum(sent_scores[k]) / len(sent_scores[k]), True
            elif par.scored:  # short paragraph / no window: inherit paragraph score
                sc, ok = par.score, True
            else:
                sc, ok = None, False
            par.sentences.append(SentenceResult(s.start, s.end, s.text, sc, ok))

    if scored_words < MIN_WORDS_DOCUMENT:
        return DocumentAnalysis(
            status="insufficient_text",
            message="The text is split into paragraphs that are too short to score reliably "
                    f"(paragraphs under {MIN_WORDS_PARAGRAPH} words are skipped).",
            words=total_words, scored_words=scored_words, overall_score=None, verdict=None,
            ai_paragraph_share=None, paragraphs=paragraphs, **base,
        )

    overall = weighted / scored_words
    scored_pars = [p for p in paragraphs if p.scored]
    share = sum(1 for p in scored_pars if verdict_for(p.score) == "likely_ai") / len(scored_pars)
    msg = ("Scores are raw, uncalibrated model outputs." if not det.calibrated
           else "Scores are temperature-calibrated on the held-out evaluation split.")
    return DocumentAnalysis(
        status="ok", message=msg, words=total_words, scored_words=scored_words,
        overall_score=overall, verdict=verdict_for(overall), ai_paragraph_share=share,
        paragraphs=paragraphs, **base,
    )
