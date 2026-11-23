"""Dual-model detection: run Followsci BERT and Fakespot RoBERTa on identical text, side by side.

Design rules (see docs/DUAL_MODEL.md):
* Each model is scored independently with the EXISTING ``analyze_document`` (same extraction, segmentation and
  paragraph/chunk scoring for both). Nothing here changes how Followsci is scored.
* Probabilities are NEVER averaged across models and there is NO combined verdict. The comparison only reports
  where the two independent verdicts agree or disagree.
* Each model has its own decision thresholds (``detector/thresholds.json``, written by ``evaluation/dual_eval.py``
  from a validation split and then measured on a separate test split).
* A failure in one model never blocks the other.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from .analysis import BAND_AI, BAND_HUMAN, analyze_document, verdict_for
from .model import MODEL_NAME as FOLLOWSCI_NAME
from .model import MAX_LENGTH, get_detector

FAKESPOT_NAME = "fakespot-ai/roberta-base-ai-text-detection-v1"
THRESHOLDS_FILE = Path(__file__).with_name("thresholds.json")

# Facts copied from the Hugging Face model cards (checked 2026-11-21); the loaded weights are read at runtime.
MODEL_CARDS = {
    "followsci": {"licence": "MIT", "base": "google-bert/bert-base-uncased",
                  "url": "https://huggingface.co/followsci/bert-ai-text-detector",
                  "note": "Trained on arXiv paragraphs vs LLM text; card warns of degradation on casual text."},
    "fakespot": {"licence": "Apache-2.0", "base": "FacebookAI/roberta-base",
                 "url": "https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1",
                 "note": "Card gives no training data or accuracy figures; says the score is a likelihood, "
                         "not the share of AI text, and that longer inputs are more accurate."},
}


# ----------------------------------------------------------------------------------------------------------------
# Fakespot (generic Hugging Face sequence classifier with the same interface analyze_document needs)
# ----------------------------------------------------------------------------------------------------------------
class HFDetector:
    """AutoModel classifier exposing the subset of ``detector.model.Detector`` used by ``analyze_document``.

    Label convention is verified from the model config (index 1 must be the AI class). Weights are loaded from the
    local Hugging Face cache only: this never downloads anything.
    """

    calibrated = False
    temperature = 1.0

    def __init__(self, model_name: str = FAKESPOT_NAME, device: Optional[str] = None, local_files_only: bool = True):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self._torch = torch
        self.model_name = model_name
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = AutoTokenizer.from_pretrained(model_name, local_files_only=local_files_only)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_name, local_files_only=local_files_only)
        labels = {int(k): str(v).lower() for k, v in self.model.config.id2label.items()}
        if labels.get(1) != "ai" or labels.get(0) != "human":
            raise RuntimeError(f"Unexpected label order {labels}; expected {{0: human, 1: ai}}.")
        self.model.to(self.device).eval()
        self._lock = threading.Lock()

    def logit_margins(self, texts: List[str], batch_size: int = 16) -> List[float]:
        torch = self._torch
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        margins = [0.0] * len(texts)
        with torch.no_grad():
            for s in range(0, len(order), batch_size):
                idx = order[s:s + batch_size]
                enc = self.tokenizer([texts[i] for i in idx], return_tensors="pt", truncation=True,
                                     max_length=MAX_LENGTH, padding=True).to(self.device)
                with self._lock:
                    logits = self.model(**enc).logits
                for j, i in enumerate(idx):
                    margins[i] = float(logits[j, 1] - logits[j, 0])
        return margins

    def predict(self, texts: List[str], batch_size: int = 16, raw: bool = False) -> List[float]:
        return [1.0 / (1.0 + math.exp(-max(-50.0, min(50.0, m)))) for m in self.logit_margins(texts, batch_size)]


# ----------------------------------------------------------------------------------------------------------------
# Model registry (lazy, independent, failures are reported not raised)
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class ModelSlot:
    key: str
    title: str
    name: str
    factory: Callable[[], object]
    obj: Optional[object] = None
    error: Optional[str] = None
    load_ms: Optional[float] = None

    def __post_init__(self):
        self.lock = threading.Lock()

    def get(self):
        """Return the loaded detector or raise. A failed load is retried on the next call."""
        with self.lock:
            if self.obj is None:
                t0 = time.perf_counter()
                try:
                    self.obj = self.factory()
                    self.error = None
                    self.load_ms = (time.perf_counter() - t0) * 1000
                except Exception as e:  # noqa: BLE001 - any load problem is reported per model
                    self.error = f"{type(e).__name__}: {e}"
                    raise
            return self.obj


SLOTS: Dict[str, ModelSlot] = {
    "followsci": ModelSlot("followsci", "Followsci BERT", FOLLOWSCI_NAME, get_detector),
    "fakespot": ModelSlot("fakespot", "Fakespot RoBERTa", FAKESPOT_NAME, HFDetector),
}


def rss_mb() -> Optional[float]:
    """Resident memory of this process in MB (stdlib only)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            pmc = PMC(); pmc.cb = ctypes.sizeof(PMC)
            k32, ps = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            ps.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            ps.GetProcessMemoryInfo.restype = wintypes.BOOL
            ok = ps.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return pmc.WorkingSetSize / 1e6 if ok else None
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:  # noqa: BLE001
        return None


# ----------------------------------------------------------------------------------------------------------------
# Thresholds
# ----------------------------------------------------------------------------------------------------------------
def _sigmoid(m: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-50.0, min(50.0, m))))


def load_thresholds() -> dict:
    """Per-model decision rule {human_below, ai_at_or_above} in P(AI), plus provenance.

    Falls back to Followsci's shipped bands and a plain 0.5 for Fakespot (flagged ``validated: false``)
    when ``thresholds.json`` has not been produced by evaluation/dual_eval.py.
    """
    out = {
        "followsci": {"human_below": BAND_HUMAN, "ai_at_or_above": BAND_AI, "validated": False,
                      "source": "shipped bands (detector/analysis.py)"},
        "fakespot": {"human_below": 0.5, "ai_at_or_above": 0.5, "validated": False,
                     "source": "default 0.5 (no validated thresholds file)"},
    }
    try:
        data = json.loads(THRESHOLDS_FILE.read_text(encoding="utf-8"))
        for key, v in data.get("models", {}).items():
            if key in out:
                out[key] = {"human_below": _sigmoid(v["human_below_margin"]), "ai_at_or_above": _sigmoid(v["ai_above_margin"]),
                            "human_below_margin": v["human_below_margin"], "ai_above_margin": v["ai_above_margin"],
                            "validated": True, "source": data.get("method", "evaluation/dual_eval.py"),
                            "validation": v.get("validation"), "test": v.get("test")}
    except (OSError, ValueError, KeyError):
        pass
    return out


def verdict_with(rule: dict, p: float) -> str:
    if p >= rule["ai_at_or_above"]:
        return "likely_ai"
    if p < rule["human_below"]:
        return "likely_human"
    return "uncertain"


# ----------------------------------------------------------------------------------------------------------------
# Analysis
# ----------------------------------------------------------------------------------------------------------------
def _one_model(slot: ModelSlot, text: str, rule: dict) -> dict:
    base = {"key": slot.key, "name": slot.title, "model": slot.name, "thresholds": rule,
            "card": MODEL_CARDS[slot.key], "status": "error", "error": None, "inference_ms": None,
            "load_ms": None, "document": None, "paragraphs": []}
    try:
        det = slot.get()
    except Exception as e:  # noqa: BLE001
        base["error"] = f"Model could not be loaded ({slot.error or e})"
        return base
    base["load_ms"] = slot.load_ms
    base["device"] = getattr(det, "device", None)
    try:
        t0 = time.perf_counter()
        a = analyze_document(text, det)
        base["inference_ms"] = (time.perf_counter() - t0) * 1000
    except Exception as e:  # noqa: BLE001
        base["error"] = f"Inference failed ({type(e).__name__}: {e})"
        return base
    base["status"] = a.status
    base["message"] = a.message
    pars = []
    for p in a.paragraphs:
        pars.append({"index": p.index, "start": p.start, "end": p.end, "words": p.words, "scored": p.scored,
                     "p_ai": p.score, "p_human": (1 - p.score) if p.score is not None else None,
                     "verdict": verdict_with(rule, p.score) if p.score is not None else None})
    base["paragraphs"] = pars
    if a.status == "ok":
        scored = [p for p in pars if p["scored"]]
        base["document"] = {
            "p_ai": a.overall_score, "p_human": 1 - a.overall_score, "verdict": verdict_with(rule, a.overall_score),
            "ai_paragraph_share": sum(p["verdict"] == "likely_ai" for p in scored) / len(scored),
            "scored_paragraphs": len(scored), "scored_words": a.scored_words, "words": a.words,
        }
        if slot.key == "followsci":     # what the existing app reports for the same text (unchanged behaviour)
            base["document"]["shipped_verdict"] = verdict_for(a.overall_score)
    return base


def _pair(v1: Optional[str], v2: Optional[str]) -> str:
    if v1 is None or v2 is None:
        return "not_compared"
    if v1 == v2:
        return {"likely_ai": "agree_ai", "likely_human": "agree_human"}.get(v1, "agree_uncertain")
    if "uncertain" in (v1, v2):
        return "partial"
    return "disagree"


def compare(a: dict, b: dict) -> Optional[dict]:
    """Agreement report between two independent model results. Never produces a combined score or verdict."""
    if a["status"] != "ok" or b["status"] != "ok":
        return None
    da, db = a["document"], b["document"]
    pars = []
    for pa, pb in zip(a["paragraphs"], b["paragraphs"]):
        pars.append({"index": pa["index"], "relation": _pair(pa["verdict"], pb["verdict"]) if pa["scored"] and pb["scored"] else "not_compared",
                     "delta_p_ai": (pa["p_ai"] - pb["p_ai"]) if pa["scored"] and pb["scored"] else None})
    counts: Dict[str, int] = {}
    for p in pars:
        counts[p["relation"]] = counts.get(p["relation"], 0) + 1
    return {
        "document": {"relation": _pair(da["verdict"], db["verdict"]), "delta_p_ai": da["p_ai"] - db["p_ai"],
                     "a": a["key"], "b": b["key"]},
        "paragraphs": pars, "paragraph_counts": counts,
        "note": "Each model decides independently with its own thresholds. Probabilities are not averaged and there is no combined verdict.",
    }


def analyze_dual(text: str) -> dict:
    text = text.strip().replace("\r\n", "\n").replace("\r", "\n")   # same normalisation analyze_document applies
    rules = load_thresholds()
    results = [_one_model(SLOTS[k], text, rules[k]) for k in ("followsci", "fakespot")]
    return {"text": text, "models": {r["key"]: r for r in results}, "comparison": compare(*results),
            "memory_mb": rss_mb()}


def status() -> dict:
    """Light-weight status; does not load a model that is not loaded yet."""
    rules = load_thresholds()
    from . import model as _followsci_module   # the app already holds Followsci once get_detector() has run
    out = {}
    for k, s in SLOTS.items():
        obj = s.obj if s.obj is not None else (_followsci_module._instance if k == "followsci" else None)
        info = {"key": k, "name": s.title, "model": s.name, "loaded": obj is not None, "error": s.error,
                "load_ms": s.load_ms, "thresholds": rules[k], "card": MODEL_CARDS[k]}
        if obj is not None:
            m = getattr(obj, "model", None)
            if m is not None:
                n = sum(p.numel() for p in m.parameters())
                info.update(parameters=n, weights_mb_fp32=n * 4 / 1e6, device=getattr(obj, "device", None))
        out[k] = info
    return {"models": out, "memory_mb": rss_mb()}
