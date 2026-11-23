"""Model loading and batched inference.

Uses exactly the same model, tokenizer and label convention as the original
``example_usage.py`` (label 0 = human, label 1 = AI, max_length = 512).
"""
from __future__ import annotations

import json
import math
import os
import threading
from pathlib import Path
from typing import List, Optional

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import torch  # noqa: E402
from transformers import BertForSequenceClassification, BertTokenizer  # noqa: E402

MODEL_NAME = "followsci/bert-ai-text-detector"
MAX_LENGTH = 512
CALIBRATION_FILE = Path(__file__).with_name("calibration.json")


def load_calibration() -> Optional[dict]:
    """Return the fitted calibration (written by evaluation/evaluate.py), or None."""
    try:
        data = json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
        if float(data["temperature"]) > 0:
            return data
    except (OSError, ValueError, KeyError):
        pass
    return None


class Detector:
    def __init__(self, model_name: str = MODEL_NAME, device: Optional[str] = None):
        self.model_name = model_name
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = BertTokenizer.from_pretrained(model_name)
        self.model = BertForSequenceClassification.from_pretrained(model_name)
        self.model.to(self.device).eval()
        self._lock = threading.Lock()
        cal = load_calibration()
        self.temperature: float = float(cal["temperature"]) if cal else 1.0
        self.calibrated: bool = cal is not None

    @torch.no_grad()
    def logit_margins(self, texts: List[str], batch_size: int = 16) -> List[float]:
        """Raw logit margin (logit_AI - logit_human) for each text."""
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))  # less padding
        margins = [0.0] * len(texts)
        for s in range(0, len(order), batch_size):
            idx = order[s : s + batch_size]
            enc = self.tokenizer(
                [texts[i] for i in idx],
                return_tensors="pt",
                truncation=True,
                max_length=MAX_LENGTH,
                padding=True,
            ).to(self.device)
            with self._lock:
                logits = self.model(**enc).logits
            for j, i in enumerate(idx):
                margins[i] = float(logits[j, 1] - logits[j, 0])
        return margins

    def predict(self, texts: List[str], batch_size: int = 16, raw: bool = False) -> List[float]:
        """P(AI) for each text. Uses temperature scaling if a calibration file exists."""
        t = 1.0 if raw else self.temperature
        return [1.0 / (1.0 + math.exp(-m / t)) for m in self.logit_margins(texts, batch_size)]


_instance: Optional[Detector] = None
_instance_lock = threading.Lock()


def get_detector() -> Detector:
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = Detector()
        return _instance
