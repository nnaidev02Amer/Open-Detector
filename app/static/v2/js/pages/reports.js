// Report Center: pick a stored analysis or batch, preview a print-ready report, then Print / Save as PDF in the browser.
// Data: GET /api/history/{id} (+ existing /api/report/{id}.html|.json downloads), GET /api/batch[/{id}], /api/model-info, /api/evaluation.
import { api, getModelInfo, searchHistoryPage, listBatches, getBatch } from "../api.js";
import { loadAnalysis } from "../state.js";
import { buildBatchReport, buildReport, fmtUtc } from "../report.js";
import { badge, button, card, emptyState, fmtDate, fmtInt, h, loadingBlock, pageHead, pagination, pct, tabs, verdictBadge } from "../ui.js";

const PAGE = 8;

export async function render(root, ctx) {
  const id = ctx.query.get("id"), batch = ctx.query.get("batch");
  if (id) return showAnalysis(root, id, ctx.query);
  if (batch) return showBatch(root, batch, ctx.query);
  return center(root);
}

/* ---------------------------------------------------------------- shared loaders */
async function support() {
  const [info, evalData] = await Promise.allSettled([getModelInfo(), api("/api/evaluation")]);
  return { info: info.status === "fulfilled" ? info.value : null, evalData: evalData.status === "fulfilled" && evalData.value.available ? evalData.value : null };
}

function toolbar({ back, extra = [], onPrint }) {
  return h("div", { class: "report-toolbar" }, h("div", { class: "actions" }, button("Report Center", { kind: "ghost", icon: "reports", href: "#/reports" }), ...(back ? [button(back.label, { kind: "ghost", href: back.href })] : [])),
    h("div", { class: "actions" }, ...extra, button("Print / Save as PDF", { kind: "primary", icon: "doc", onclick: onPrint })));
}

function missing(root, what, text) {
  root.replaceChildren(pageHead({ eyebrow: "Report", title: `${what} not found` }), card(null, {}, emptyState({ error: true, title: `${what} not available`, text, action: button("Back to Report Center", { kind: "primary", href: "#/reports" }) })));
}

/* ---------------------------------------------------------------- single analysis */
async function showAnalysis(root, id, query) {
  root.replaceChildren(pageHead({ eyebrow: "Report", title: "Analysis report" }), card(null, {}, loadingBlock(5)));
  let rec;
  try { rec = await loadAnalysis(id); }
  catch (e) { return missing(root, "Analysis", /not found/i.test(e.message) ? "This analysis does not exist. It may have been deleted from History." : e.message); }
  const sup = await support();
  let includeText = query.get("text") === "1";
  const sheet = h("div", { class: "report-wrap" });
  const paint = () => sheet.replaceChildren(buildReport(rec, { ...sup, includeText }));
  const cb = h("input", { type: "checkbox", id: "incText", checked: includeText, onchange: () => { includeText = cb.checked; paint(); } });
  paint();
  root.replaceChildren(toolbar({
    back: { label: "Document Intelligence", href: `#/intelligence?id=${encodeURIComponent(rec.id)}` }, onPrint: () => window.print(),
    extra: [h("label", { class: "check" }, cb, "Include full text appendix"), button("Download HTML", { kind: "ghost", size: "sm", href: `/api/report/${encodeURIComponent(rec.id)}.html?download=true` }), button("Download JSON", { kind: "ghost", size: "sm", href: `/api/report/${encodeURIComponent(rec.id)}.json` })],
  }), sheet);
  if (query.get("print") === "1") setTimeout(() => window.print(), 500);
}

/* ---------------------------------------------------------------- batch */
async function showBatch(root, bid, query) {
  root.replaceChildren(pageHead({ eyebrow: "Report", title: "Batch report" }), card(null, {}, loadingBlock(5)));
  let b;
  try { b = await getBatch(bid); } catch (e) { return missing(root, "Batch", /not found/i.test(e.message) ? "This batch does not exist. It may have been removed." : e.message); }
  const ids = b.items.map((i) => i.analysis_id).filter(Boolean);
  const [sup, recs] = await Promise.all([support(), Promise.allSettled(ids.map((x) => loadAnalysis(x)))]);
  const map = new Map(ids.map((x, i) => [x, recs[i].status === "fulfilled" ? recs[i].value : null]));
  let includeDetail = query.get("detail") !== "0";
  const sheet = h("div", { class: "report-wrap" });
  const paint = () => sheet.replaceChildren(buildBatchReport(b, map, { ...sup, includeDetail }));
  const cb = h("input", { type: "checkbox", id: "incDetail", checked: includeDetail, onchange: () => { includeDetail = cb.checked; paint(); } });
  paint();
  root.replaceChildren(toolbar({ back: { label: "Batch results", href: `#/batch?id=${encodeURIComponent(b.id)}` }, onPrint: () => window.print(), extra: [h("label", { class: "check" }, cb, "Include per-document paragraph profiles")] }), sheet);
  if (query.get("print") === "1") setTimeout(() => window.print(), 500);
}

/* ---------------------------------------------------------------- Report Center home */
function center(root) {
  let q = "", page = 1, seq = 0, timer = null;
  const search = h("input", { type: "search", class: "text-in", placeholder: "Search analyses by document name…", "aria-label": "Search analyses" });
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); page = 1; loadA(); }, 300); });
  const aHost = h("div"), bHost = h("div");

  async function loadA() {
    const mine = ++seq; aHost.replaceChildren(loadingBlock(3));
    let r;
    try { r = await searchHistoryPage({ q, limit: PAGE, offset: (page - 1) * PAGE, sort: "newest" }); }
    catch (e) { if (mine === seq) aHost.replaceChildren(emptyState({ error: true, title: "Could not load analyses", text: e.message, action: button("Retry", { kind: "primary", onclick: loadA }) })); return; }
    if (mine !== seq) return;
    if (!r.total) return aHost.replaceChildren(q ? emptyState({ icon: "search", title: "No analyses match", text: `Nothing matches “${q}”.` }) : emptyState({ icon: "reports", title: "No analyses to report on", text: "Analyse a document first; every analysis can then be turned into a report.", action: button("Open Detection Studio", { kind: "primary", href: "#/studio" }) }));
    aHost.replaceChildren(h("div", { class: "list" }, ...r.items.map((a) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "title", title: a.title }, a.title), h("div", { class: "meta" }, `${fmtDate(a.created_at)} · ${fmtInt(a.words)} words · ${a.source}`)),
      a.verdict ? verdictBadge(a.verdict) : badge("Too short", "neutral"), h("div", { class: "score" }, pct(a.overall_score, 0)),
      h("div", { class: "actions nowrap" }, button("View report", { size: "sm", href: `#/reports?id=${encodeURIComponent(a.id)}` }), button("Print", { size: "sm", kind: "ghost", href: `#/reports?id=${encodeURIComponent(a.id)}&print=1` }))))),
      h("div", { class: "table-foot flat" }, pagination({ total: r.total, limit: PAGE, offset: (page - 1) * PAGE, onPage: (p) => { page = p; loadA(); } })));
  }
  async function loadB() {
    bHost.replaceChildren(loadingBlock(3));
    let list;
    try { list = await listBatches(); } catch (e) { return bHost.replaceChildren(emptyState({ error: true, title: "Could not load batches", text: e.message, action: button("Retry", { kind: "primary", onclick: loadB }) })); }
    if (!list.length) return bHost.replaceChildren(emptyState({ icon: "batch", title: "No batches yet", text: "Run a batch in Batch Analysis to create batch reports.", action: button("Open Batch Analysis", { kind: "primary", href: "#/batch" }) }));
    bHost.replaceChildren(h("div", { class: "list" }, ...list.map((b) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "title", title: b.title }, b.title), h("div", { class: "meta" }, `${fmtDate(b.created_at)} · ${b.files} files · ${b.summary.scored} scored${b.summary.failed_files ? ` · ${b.summary.failed_files} failed` : ""}`)),
      h("div", { class: "score" }, pct(b.summary.mean_score, 0)),
      h("div", { class: "actions nowrap" }, button("View report", { size: "sm", href: `#/reports?batch=${encodeURIComponent(b.id)}` }), button("Print", { size: "sm", kind: "ghost", href: `#/reports?batch=${encodeURIComponent(b.id)}&print=1` }))))));
  }
  const t = tabs([{ id: "a", label: "Analyses", render: () => h("div", {}, search, h("div", { style: "height:12px" }), aHost) }, { id: "b", label: "Batches", render: () => bHost }]);
  root.replaceChildren(pageHead({ eyebrow: "Export", title: "Report Center", lede: "Turn any saved analysis or batch into a print-ready report. Use your browser's Print dialog and choose “Save as PDF”." }),
    h("div", { class: "grid split" }, card("Choose a report", { sub: "Reports are generated from your saved results; nothing is re-scored." }, t.el),
      card("What a report contains", {}, h("ul", { class: "bullets" },
        h("li", {}, "Document name, date, source and statistics"),
        h("li", {}, "AI and human probability, verdict and explanation"),
        h("li", {}, "Charts and paragraph-level results"),
        h("li", {}, "Model, evaluation figures, limitations and responsible-use notes"),
        h("li", {}, "For batches: combined overview and every file's result")))));
  loadA(); loadB();
}
