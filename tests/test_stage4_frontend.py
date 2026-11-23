"""Stage 4 frontend logic (js/logic.js under Node): batch validation, pagination maths, filter -> query mapping, date ranges."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

V2 = Path(__file__).resolve().parents[1] / "app" / "static" / "v2"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="Node.js not installed")


def js(expr: str):
    url = (V2 / "js" / "logic.js").resolve().as_uri()
    r = subprocess.run([NODE, "--input-type=module", "-e", f'import * as L from "{url}"; console.log(JSON.stringify({expr}));'],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_validate_batch_mixed_files():
    files = [{"name": "a.pdf", "size": 10}, {"name": "b.exe", "size": 10}, {"name": "c.txt", "size": 0}, {"name": "d.md", "size": 5},
             {"name": "e.docx", "size": 11 * 1024 * 1024}, {"name": "f.DOCX", "size": 9}]
    r = js(f"(() => {{ const v = L.validateBatch({json.dumps(files)}); return {{s: v.items.map(i => i.status), ready: v.ready.length, rej: v.rejected.length, why: v.rejected.map(i => i.reason)}}; }})()")
    assert r["s"] == ["ready", "rejected", "rejected", "ready", "rejected", "ready"]
    assert r["ready"] == 3 and r["rej"] == 3 and all(r["why"])
    assert "not supported" in r["why"][0] and "empty" in r["why"][1] and "larger" in r["why"][2]


def test_validate_batch_enforces_file_limit_and_empty_input():
    many = [{"name": f"f{i}.txt", "size": 5} for i in range(23)]
    r = js(f"(() => {{ const v = L.validateBatch({json.dumps(many)}); return [v.ready.length, v.rejected.length, v.rejected[0].reason]; }})()")
    assert r[0] == 20 and r[1] == 3 and "20-file" in r[2]
    assert js("L.validateBatch([]).items.length") == 0 and js("L.validateBatch(null).ready.length") == 0


def test_page_info_and_window():
    assert js("L.pageInfo(0, 10, 0)") == {"page": 1, "pages": 1, "from": 0, "to": 0}
    assert js("L.pageInfo(25, 10, 0)") == {"page": 1, "pages": 3, "from": 1, "to": 10}
    assert js("L.pageInfo(25, 10, 20)") == {"page": 3, "pages": 3, "from": 21, "to": 25}
    assert js("L.pageInfo(25, 10, 999)")["page"] == 3                                  # offset past the end is clamped
    assert js("L.pageWindow(1, 3)") == [1, 2, 3]
    assert js("L.pageWindow(5, 12)") == [1, "…", 4, 5, 6, "…", 12]
    assert js("L.pageWindow(1, 12)") == [1, 2, "…", 12] and js("L.pageWindow(12, 12)") == [1, "…", 11, 12]


def test_search_params_mapping():
    p = js('L.searchParams({q: "abc", verdict: "likely_ai", source: "", status: "ok", date_from: "2026-01-01", date_to: "", sort: "score_desc"}, 25, 3)')
    assert p == {"limit": 25, "offset": 50, "sort": "score_desc", "q": "abc", "verdict": "likely_ai", "status": "ok", "date_from": "2026-01-01"}
    assert js("L.searchParams({}, 10, 1)") == {"limit": 10, "offset": 0, "sort": "newest"}
    assert js("L.searchParams({}, 10, -4).offset") == 0
    assert js('L.hasFilters({q: "", sort: "oldest"})') is False and js('L.hasFilters({verdict: "uncertain"})') is True


def test_date_range_is_utc_and_inclusive():
    r = js('L.dateRange(7, new Date("2026-11-20T23:30:00Z"))')
    assert r == {"date_from": "2026-11-14", "date_to": "2026-11-20"}                   # 7 calendar days including today
    assert js('L.dateRange(1, new Date("2026-11-20T00:10:00Z"))') == {"date_from": "2026-11-20", "date_to": "2026-11-20"}
    assert js("L.dateRange(null)") == {"date_from": "", "date_to": ""}
    assert js('L.dateRange(30, new Date("2026-03-05T12:00:00Z"))')["date_from"] == "2026-02-04"   # crosses a month boundary


def test_failure_rate():
    batches = [{"files": 10, "summary": {"failed_files": 2}}, {"files": 10, "summary": {"failed_files": 0}}]
    assert js(f"L.failureRate({json.dumps(batches)})") == pytest.approx(0.1)
    assert js("L.failureRate([])") is None
