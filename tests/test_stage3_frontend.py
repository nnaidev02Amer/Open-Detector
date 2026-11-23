"""Stage 3 frontend logic checks: js/logic.js runs under Node and is compared with the Python detector's own behaviour."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from detector.analysis import verdict_for
from detector.segmentation import word_count

V2 = Path(__file__).resolve().parents[1] / "app" / "static" / "v2"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="Node.js not installed")


def js(expr: str):
    url = (V2 / "js" / "logic.js").resolve().as_uri()
    r = subprocess.run([NODE, "--input-type=module", "-e", f'import * as L from "{url}"; console.log(JSON.stringify({expr}));'],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


SAMPLES = ["Hello world", "It's a well-known fact—really.", "Numbers 123 and 4,567 appear; so do don’t and co-operate.",
           "  leading   and trailing   ", "", "One\ntwo\n\nthree\tfour", "snake_case_word and CamelCase"]


def test_word_count_matches_backend():
    got = js(f"{json.dumps(SAMPLES)}.map(L.countWords)")
    assert got == [word_count(s) for s in SAMPLES]


def test_band_classification_matches_detector_verdicts():
    grid = [0.0, 0.1, 0.3499, 0.35, 0.3501, 0.5, 0.6499, 0.65, 0.6501, 0.9, 1.0]
    mapping = {"human": "likely_human", "uncertain": "uncertain", "ai": "likely_ai"}
    got = js(f"{json.dumps(grid)}.map((s) => L.bandOf(s))")
    assert [mapping[b] for b in got] == [verdict_for(s) for s in grid]
    assert js("L.bandOf(null)") == "none"


def test_probabilities_sum_to_one():
    for s in (0.0, 0.123, 0.5, 0.999):
        assert js(f"L.humanProbability({s}) + {s}") == pytest.approx(1.0)
    assert js("L.humanProbability(null)") is None


def test_file_validation():
    cases = [({"name": "a.pdf", "size": 100}, True), ({"name": "A.DOCX", "size": 100}, True), ({"name": "n.txt", "size": 1}, True),
             ({"name": "n.md", "size": 1}, True), ({"name": "n.exe", "size": 5}, False), ({"name": "noext", "size": 5}, False),
             ({"name": "e.txt", "size": 0}, False), ({"name": "big.pdf", "size": 10 * 1024 * 1024 + 1}, False),
             ({"name": "edge.pdf", "size": 10 * 1024 * 1024}, True), ({"name": "x.txt.exe", "size": 5}, False), (None, False)]
    got = js(f"{json.dumps([c for c, _ in cases])}.map((f) => L.validateFile(f))")
    for (c, expect), g in zip(cases, got):
        assert g["ok"] is expect, (c, g)
        if not expect:
            assert g["error"]
    assert got[0]["kind"] == "PDF document" and got[3]["kind"] == "Markdown"


def test_text_validation():
    r = js('[L.validateText(""), L.validateText("   "), L.validateText("too short"), L.validateText("word ".repeat(60)), L.validateText("x".repeat(300001))]')
    assert [(x["ok"], x["level"]) for x in r] == [(False, "error"), (False, "error"), (True, "warn"), (True, "ok"), (False, "error")]


def test_explanations_use_only_returned_values():
    result = {"status": "ok", "overall_score": 0.8123, "calibrated": False, "scored_words": 400, "bands": {"human_below": 0.35, "ai_above": 0.65},
              "message": "m"}
    par = {"index": 0, "words": 100, "score": 0.9, "scored": True, "sentences": []}
    skipped = {"index": 1, "words": 10, "score": None, "scored": False, "sentences": []}
    v = js(f"L.verdictExplanation({json.dumps(result)})")
    assert "81.2%" in v and "65.0%" in v and "not calibrated" in v
    p = js(f"L.paragraphExplanation({json.dumps(par)}, {json.dumps(result)})")
    assert "90.0%" in p and "100 words" in p and "25.0%" in p and "Likely AI" in p      # 100 of 400 scored words
    s = js(f"L.paragraphExplanation({json.dumps(skipped)}, {json.dumps(result)})")
    assert "Not scored" in s and "10 words" in s and "25" in s
    unc = dict(result, overall_score=0.5)
    assert "no verdict is given" in js(f"L.verdictExplanation({json.dumps(unc)})")
    assert js(f"L.verdictExplanation({json.dumps({'status': 'insufficient_text', 'message': 'too short'})})") == "too short"


def test_histogram_summary_and_sentence_stats():
    assert js("L.histogram([0, 0.05, 0.1, 0.55, 0.999, 1, NaN])") == [2, 1, 0, 0, 0, 1, 0, 0, 0, 2]
    result = {"bands": {"human_below": 0.35, "ai_above": 0.65}, "paragraphs": [
        {"scored": True, "score": 0.9}, {"scored": True, "score": 0.1}, {"scored": True, "score": 0.5}, {"scored": False, "score": None}]}
    s = js(f"L.paragraphSummary({json.dumps(result)})")
    assert s == {"total": 4, "scored": 3, "skipped": 1, "counts": {"human": 1, "uncertain": 1, "ai": 1}}
    par = {"sentences": [{"scored": True, "score": 0.2}, {"scored": True, "score": 0.6}, {"scored": False, "score": None}]}
    st = js(f"L.sentenceStats({json.dumps(par)})")
    assert st["n"] == 2 and st["min"] == 0.2 and st["max"] == 0.6 and st["mean"] == pytest.approx(0.4)
    assert js('L.sentenceStats({sentences: []})') is None


def test_formatting_helpers():
    assert js('[L.formatBytes(512), L.formatBytes(2048), L.formatBytes(5*1024*1024)]') == ["512 B", "2.0 KB", "5.0 MB"]
    assert js('L.preview("a  b\\n c", 90)') == "a b c" and len(js('L.preview("x".repeat(300), 50)')) == 50
