// Detection Analytics: every figure comes from GET /api/stats (filtered server-side) and GET /api/batch.
import { getStatsFiltered, listBatches } from "../api.js";
import { COLORS, bars, donut, legend, line } from "../charts.js";
import { SOURCE_LABEL, SOURCE_OPTIONS, dateRange, failureRate } from "../logic.js";
import { badge, button, card, emptyState, fmtDate, fmtInt, h, loadingBlock, pageHead, pct, plural, statCard, statSkeletons } from "../ui.js";
import { verdictStack } from "./batch.js";

const RANGES = [["7", "Last 7 days", 7], ["30", "Last 30 days", 30], ["all", "All time", null], ["custom", "Custom", undefined]];
const MIN_SCORED = 5;

export function render(root) {
  let range = "all", from = "", to = "", source = "", seq = 0;
  const seg = h("div", { class: "segmented", role: "group", "aria-label": "Date range" }, ...RANGES.map(([id, label]) => h("button", { type: "button", "data-id": id, "aria-pressed": String(id === range), onclick: () => setRange(id) }, label)));
  const dFrom = h("input", { type: "date", "aria-label": "From date" }), dTo = h("input", { type: "date", "aria-label": "To date" });
  const src = h("select", { "aria-label": "Source type" }, h("option", { value: "" }, "All source types"), ...SOURCE_OPTIONS.map(([v, l]) => h("option", { value: v }, l)));
  const custom = h("div", { class: "custom-range", hidden: true }, h("label", { class: "field" }, h("span", {}, "From (UTC)"), dFrom), h("label", { class: "field" }, h("span", {}, "To (UTC)"), dTo));
  function setRange(id) {
    range = id; seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    custom.hidden = id !== "custom";
    if (id !== "custom") { const d = dateRange(RANGES.find((r) => r[0] === id)[2]); from = d.date_from; to = d.date_to; dFrom.value = from; dTo.value = to; load(); }
  }
  dFrom.addEventListener("change", () => { from = dFrom.value; load(); }); dTo.addEventListener("change", () => { to = dTo.value; load(); });
  src.addEventListener("change", () => { source = src.value; load(); });
  const body = h("div", { "aria-live": "polite" });
  root.replaceChildren(pageHead({ eyebrow: "Trends", title: "Detection Analytics", lede: "Distributions and trends computed from the analyses stored on this computer. Dates are UTC." }),
    card(null, { cls: "filter-card" }, h("div", { class: "filters analytics-filters" }, h("div", { class: "field" }, h("span", {}, "Date range"), seg), custom, h("label", { class: "field" }, h("span", {}, "Source type"), src))), h("div", { style: "height:18px" }), body);

  async function load() {
    const mine = ++seq;
    body.replaceChildren(statSkeletons(4), h("div", { style: "height:18px" }), card("Loading", {}, loadingBlock(4)));
    let s, batches;
    try { [s, batches] = await Promise.all([getStatsFiltered({ date_from: from, date_to: to, source }), listBatches()]); }
    catch (e) { if (mine === seq) body.replaceChildren(card(null, {}, emptyState({ error: true, title: "Could not load analytics", text: e.message, action: button("Retry", { kind: "primary", onclick: load }) }))); return; }
    if (mine !== seq) return;
    if (s.total_in_database === 0) return body.replaceChildren(card(null, {}, emptyState({ icon: "analytics", title: "No data to analyse yet", text: "Analytics are computed from your stored analyses. Nothing here is sample data.", action: button("Open Detection Studio", { kind: "primary", icon: "studio", href: "#/studio" }) })));
    const inRange = batches.filter((b) => (!from || b.created_at.slice(0, 10) >= from) && (!to || b.created_at.slice(0, 10) <= to));
    if (s.empty) return body.replaceChildren(card(null, {}, emptyState({ icon: "search", title: "No analyses in this selection", text: `There are ${fmtInt(s.total_in_database)} analyses in total, but none match the current date range and source type.`, action: button("Show all time", { kind: "primary", onclick: () => { src.value = ""; source = ""; setRange("all"); } }) })), batchCard(inRange));
    const thin = s.scored < MIN_SCORED, aiShare = s.scored ? s.verdicts.likely_ai / s.scored : null;
    const vItems = [{ label: "Likely human", value: s.verdicts.likely_human, color: COLORS.human }, { label: "Uncertain", value: s.verdicts.uncertain, color: COLORS.uncertain }, { label: "Likely AI", value: s.verdicts.likely_ai, color: COLORS.ai }];
    const days = s.activity_by_day, labels = Array.from({ length: s.histogram_bins }, (_, i) => `${i * 10}`);
    const stats = h("div", { class: "grid cols-4" },
      statCard({ label: "Total analyses", value: fmtInt(s.documents), hint: `${fmtInt(s.total_words)} words · ${fmtInt(s.total_in_database)} in database`, icon: "doc" }),
      statCard({ label: "Scored documents", value: fmtInt(s.scored), hint: s.insufficient_text ? `${fmtInt(s.insufficient_text)} too short to score` : "all had enough text", icon: "gauge" }),
      statCard({ label: "Average AI score", value: pct(s.mean_score), hint: s.scored ? `range ${pct(s.min_score, 0)} – ${pct(s.max_score, 0)}` : "nothing scored", icon: "analytics" }),
      statCard({ label: "Flagged likely AI", value: pct(aiShare, 0), hint: `${fmtInt(s.verdicts.likely_ai)} of ${fmtInt(s.scored)} scored`, icon: "flag" }));
    const note = thin ? h("div", { class: "notice warn", style: "margin-bottom:18px" }, `Only ${s.scored} scored ${s.scored === 1 ? "document" : "documents"} in this selection. Distributions and trends need more data before they say much.`) : null;
    const verdicts = card("Verdict distribution", { sub: "Scored documents by verdict band" }, s.scored
      ? h("div", { class: "donut-wrap" }, h("div", { html: donut(vItems, { centerValue: s.scored, centerLabel: "scored", label: "Verdict distribution" }) }), h("div", { html: legend(vItems) })) : emptyState({ title: "Nothing scored", text: "No scored documents in this selection." }));
    const dist = card("Score distribution", { sub: "Document AI score, 10% bins" }, s.scored ? h("div", { html: bars(s.score_histogram, { labels, height: 210, label: "Score distribution" }) }) : emptyState({ title: "No scores", text: "Nothing to chart." }),
      h("p", { class: "muted small", style: "margin:10px 0 0" }, "Raw model scores cluster near 0% or 100%; they are not calibrated probabilities."));
    const activity = card("Analysis activity", { sub: "Documents analysed per day" }, h("div", { html: bars(days.map((d) => d.count), { labels: days.map((d) => d.date.slice(5)), height: 210, label: "Analyses per day" }) }),
      days.length < 2 ? h("p", { class: "muted small", style: "margin:10px 0 0" }, "Activity over time needs analyses on at least two different days.") : null);
    const trend = card("Average score by day", { sub: "Mean AI score of scored documents" }, days.filter((d) => d.mean_score != null).length >= 2
      ? h("div", { html: line(days.map((d) => ({ x: d.date.slice(5), y: d.mean_score })), { yMax: 1, yFormat: (v) => Math.round(v * 100) + "%", height: 210, label: "Mean AI score per day" }) })
      : emptyState({ icon: "analytics", title: "Not enough days", text: "A trend line needs scored documents on at least two different days." }));
    const bySrc = card("Source-type breakdown", { sub: "Verdict mix per source" }, h("div", { class: "list" }, ...s.by_source.map((x) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "title" }, SOURCE_LABEL[x.source] || x.source), h("div", { class: "meta" }, `${plural(x.count, "document")} · mean score ${pct(x.mean_score, 0)}`)), h("div", { class: "mini wide" }, verdictStack(x.verdicts))))));
    const paras = card("Paragraph score distribution", { sub: `${fmtInt(s.paragraphs_scored)} scored paragraphs` }, s.paragraphs_scored ? h("div", { html: bars(s.paragraph_score_histogram, { labels, height: 210, label: "Paragraph score distribution" }) }) : emptyState({ title: "No paragraphs", text: "Nothing scored." }),
      s.mean_ai_paragraph_share != null ? h("p", { class: "muted small", style: "margin:10px 0 0" }, `On average ${pct(s.mean_ai_paragraph_share, 0)} of a document's scored paragraphs are classed likely AI.`) : null);
    const recent = card("Recent analyses", { sub: "Latest in this selection" }, h("div", { class: "list" }, ...s.recent.map((r) => h("a", { class: "row pick", href: `#/intelligence?id=${encodeURIComponent(r.id)}` },
      h("div", { class: "grow" }, h("div", { class: "title", title: r.title }, r.title), h("div", { class: "meta" }, `${fmtDate(r.created_at)} · ${fmtInt(r.words)} words`)), r.verdict ? badge(r.verdict.replace("likely_", "Likely ").replace("uncertain", "Uncertain").replace("Likely human", "Likely human"), r.verdict === "likely_ai" ? "ai" : r.verdict === "likely_human" ? "human" : "uncertain") : badge("Too short", "neutral"), h("div", { class: "score" }, pct(r.overall_score, 0))))));
    const gap = () => h("div", { style: "height:18px" });
    body.replaceChildren(...[note, stats, gap(), h("div", { class: "grid cols-2" }, verdicts, dist), gap(), h("div", { class: "grid cols-2" }, activity, trend), gap(), h("div", { class: "grid cols-2" }, bySrc, paras), gap(), batchCard(inRange), gap(), recent].filter(Boolean));
  }

  function batchCard(list) {
    if (!list.length) return card("Batch performance", { sub: "Batch runs in the selected dates (source filter does not apply)" }, emptyState({ icon: "batch", title: "No batches in this period", text: "Run a batch in Batch Analysis to see performance here.", action: button("Open Batch Analysis", { href: "#/batch" }) }));
    const files = list.reduce((a, b) => a + b.files, 0), failed = list.reduce((a, b) => a + (b.summary.failed_files || 0), 0), scored = list.reduce((a, b) => a + b.summary.scored, 0), fr = failureRate(list);
    return card("Batch performance", { sub: "Batch runs in the selected dates (source filter does not apply)" },
      h("div", { class: "grid cols-4 tight" }, ...[["Batches", fmtInt(list.length)], ["Files submitted", fmtInt(files)], ["Scored documents", fmtInt(scored)], ["File failure rate", pct(fr, 0), `${failed} failed of ${files}`]].map(([k, v, hint]) => h("div", { class: "mini-stat" }, h("span", {}, k), h("b", {}, v), hint ? h("em", {}, hint) : null))),
      h("div", { class: "table-scroll", style: "margin-top:16px" }, h("table", { class: "ptable" }, h("thead", {}, h("tr", {}, ...["Batch", "Date", "Files", "Scored", "Failed", "Mean score", "Verdict mix"].map((t, i) => h("th", { scope: "col", class: i >= 2 && i <= 4 ? "num" : "" }, t)))),
        h("tbody", {}, ...list.slice(0, 10).map((b) => h("tr", {}, h("td", { class: "doc-cell" }, h("a", { class: "title link", href: `#/batch?id=${encodeURIComponent(b.id)}` }, b.title)), h("td", { class: "nowrap" }, fmtDate(b.created_at)), h("td", { class: "num" }, b.files), h("td", { class: "num" }, b.summary.scored), h("td", { class: "num" }, b.summary.failed_files || 0), h("td", {}, pct(b.summary.mean_score, 0)), h("td", {}, h("div", { class: "mini wide" }, verdictStack(b.summary.verdicts)))))))));
  }
  setRange("all");
}
