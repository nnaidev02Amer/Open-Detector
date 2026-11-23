"""Stage 2 frontend checks: routes, asset references, JS syntax (via Node if installed) and chart builder output."""
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("OPEN_DETECTOR_DB", os.path.join(tempfile.mkdtemp(), "test_frontend.db"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

V2 = Path(__file__).resolve().parents[1] / "app" / "static" / "v2"
JS_FILES = sorted(V2.rglob("*.js"))
NODE = shutil.which("node")
MODULE_IDS = ["dashboard", "studio", "intelligence", "batch", "analytics", "history", "reports", "model"]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_root_is_new_ui_and_classic_is_original(client):
    new, old = client.get("/"), client.get("/classic")
    assert new.status_code == 200 and old.status_code == 200 and new.text != old.text
    assert "/static/v2/js/main.js" in new.text and 'type="module"' in new.text
    assert "/static/app.js" in old.text and "/static/styles.css" in old.text          # original page, untouched
    assert old.text == (V2.parent / "index.html").read_text(encoding="utf-8")
    assert client.get("/static/app.js").status_code == 200 and client.get("/static/styles.css").status_code == 200


def test_every_v2_asset_is_served_and_has_the_right_type(client):
    paths = sorted(p for p in V2.rglob("*") if p.is_file())
    assert len(paths) >= 11
    for p in paths:
        url = "/static/v2/" + p.relative_to(V2).as_posix()
        r = client.get(url)
        assert r.status_code == 200, url
        if p.suffix == ".js":
            assert "javascript" in r.headers["content-type"], url      # required for <script type="module">


def test_html_references_and_js_imports_resolve():
    html = (V2 / "index.html").read_text(encoding="utf-8")
    for ref in re.findall(r'(?:href|src)="(/static/v2/[^"]+)"', html):
        assert (V2 / ref.removeprefix("/static/v2/")).is_file(), ref
    for f in JS_FILES:
        for spec in re.findall(r'(?:import|export)[^;]*?from\s+"(\.[^"]+)"', f.read_text(encoding="utf-8")):
            assert (f.parent / spec).resolve().is_file(), f"{f.name}: {spec}"


def test_no_external_resources_and_no_dependencies():
    for f in list(V2.rglob("*.js")) + list(V2.rglob("*.css")) + [V2 / "index.html"]:
        for url in re.findall(r"https?://[^\s\"')]+", f.read_text(encoding="utf-8")):
            assert "www.w3.org" in url, f"external resource in {f.name}: {url}"     # only SVG namespace URIs allowed
    assert not list(V2.rglob("package.json")) and not list(V2.rglob("node_modules"))


def test_all_planned_modules_are_in_navigation():
    main = (V2 / "js" / "main.js").read_text(encoding="utf-8")
    for mid in MODULE_IDS:
        assert f'id: "{mid}"' in main, mid
    assert "ROUTES.design = design" in main


def test_no_hardcoded_statistics_in_dashboard():
    src = (V2 / "js" / "pages" / "dashboard.js").read_text(encoding="utf-8")
    assert "getStats()" in src and "Math.random" not in src
    assert not re.search(r"value:\s*[\"']?\d", src)          # no literal numbers fed to stat cards


@pytest.mark.skipif(not NODE, reason="Node.js not installed")
@pytest.mark.parametrize("f", JS_FILES, ids=lambda p: p.name)
def test_js_syntax(f):
    r = subprocess.run([NODE, "--check", str(f)], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr


def _charts(expr: str):
    url = (V2 / "js" / "charts.js").resolve().as_uri()
    script = f'import * as C from "{url}"; console.log(JSON.stringify({expr}));'
    r = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.mark.skipif(not NODE, reason="Node.js not installed")
def test_chart_builders_handle_edge_cases():
    outs = _charts("""[
      C.donut([]), C.donut([{label:"a",value:0,color:"#fff"}]), C.donut([{label:"<script>x</script>",value:3,color:"#fff"},{label:"b",value:1,color:"#000"}],{centerValue:"4"}),
      C.bars([]), C.bars([0,0,0]), C.bars([1,5,3],{labels:["a","b","<i>"]}),
      C.line([]), C.line([{x:"a",y:0.4}]), C.line([{x:"a",y:0.1},{x:"b",y:null},{x:"c",y:0.9},{x:"d",y:0.2}],{yMax:1}),
      C.meter(-3), C.meter(7), C.meter(NaN), C.donut([{label:"n",value:"abc",color:"#fff"}])]""")
    assert len(outs) == 13
    for o in outs:
        assert "NaN" not in o and "undefined" not in o and "Infinity" not in o
    assert "<script>" not in outs[2] and "&lt;script&gt;" in outs[2]          # data labels are escaped
    assert "<i>" not in outs[5] and "&lt;i&gt;" in outs[5]
    assert outs[2].count('class="seg"') == 2 and outs[0].count('class="seg"') == 0
    assert outs[5].count('class="bar"') == 3
    assert outs[8].count('class="pt"') == 3 and outs[8].count("M") >= 2          # null value breaks the line into two segments
    assert 'aria-valuenow="0"' in outs[9] and 'aria-valuenow="100"' in outs[10] and 'aria-valuenow="0"' in outs[11]


@pytest.mark.skipif(not NODE, reason="Node.js not installed")
def test_donut_segment_math():
    svg = _charts('C.donut([{label:"a",value:1,color:"#111"},{label:"b",value:3,color:"#222"}],{size:200,thickness:16})')
    assert "a: 1 (25%)" in svg and "b: 3 (75%)" in svg
