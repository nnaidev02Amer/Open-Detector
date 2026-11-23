"""Document-level wrapper around the original followsci/bert-ai-text-detector model."""
from .model import MODEL_NAME, Detector, get_detector
from .analysis import analyze_document, DocumentAnalysis

__all__ = ["MODEL_NAME", "Detector", "get_detector", "analyze_document", "DocumentAnalysis"]
