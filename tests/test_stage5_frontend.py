"""Stage 5 static frontend checks: print stylesheet, routing, safe rendering. (Rendered output and real printing are
verified in the browser test, which prints the report to PDF and compares the text with the stored result.)"""
import re
from pathlib import Path

V2 = Path(__file__).resolve().parents[1] / "app" / "static" / "v2"
read = lambda p: (V2 / p).read_text(encoding="utf-8")


def test_print_stylesheet_hides_app_chrome_and_sets_page():
    css = read("css/report.css")
    assert "@media print" in css and "@page" in css and "size: A4" in css
    printed = css[css.index("@media print"):css.index("/* ---------- Model Information")]
    for sel in (".sidebar", ".topbar", ".report-toolbar", ".scrim"):
        assert sel in printed, sel
    assert "display: none" in printed and "print-color-adjust: exact" in printed
    assert "break-inside: avoid" in css                         # rows / charts are not split across pages


def test_report_sheet_is_light_and_chart_text_is_forced_readable():
    css = read("css/report.css")
    assert "background: #fff" in css and ".report .chart text" in css and "!important" in css
    assert "animation: none !important" in css                  # charts must not print mid-animation


def test_pages_registered_and_stylesheet_linked():
    main, html = read("js/main.js"), read("index.html")
    assert 'render: reports' in main and 'render: model' in main and "stubPage" not in main
    assert "/static/v2/css/report.css" in html
    reports = read("js/pages/reports.js")
    for needle in ("window.print()", "/api/report/", ".json", "ctx.query.get(\"batch\")", "not available"):
        assert needle in reports, needle


def test_report_views_use_existing_endpoints_and_no_scoring_code():
    for name in ("js/report.js", "js/pages/reports.js", "js/pages/model.js"):
        src = read(name)
        assert "Math.exp" not in src and ".predict(" not in src and "logit" not in src.lower(), name      # no second scoring implementation (prose may mention softmax)
    assert "loadAnalysis" in read("js/pages/reports.js") and "getBatch" in read("js/pages/reports.js")


def test_untrusted_text_is_never_inserted_as_html():
    # report.js / model.js may use `html:` only for chart SVG built by charts.js (which escapes labels), never for document text
    for name in ("js/report.js", "js/pages/model.js", "js/pages/reports.js"):
        for line in read(name).splitlines():
            if "html:" in line:
                assert re.search(r"html: *(bars|donut|legend|meter|svg|'<svg)|svg\(", line) or "r-mark" in line, f"{name}: {line.strip()[:120]}"


def test_report_buttons_added_to_other_pages():
    assert "#/reports?id=" in read("js/pages/intelligence.js")
    assert "#/reports?batch=" in read("js/pages/batch.js")
