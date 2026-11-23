// Dashboard: every figure comes from GET /api/stats (computed from the stored analyses). Nothing is hard-coded.
import { getStats } from "../api.js";
import { bars, COLORS, donut, legend, line } from "../charts.js";
import { SOURCE_LABEL } from "../logic.js";
import { button, card, emptyState, fmtDate, fmtInt, h, pageHead, pct, plural, statCard, statSkeletons, loadingBlock, verdictBadge } from "../ui.js";

export async function render(root) {
  root.replaceChildren(
    pageHead({ eyebrow: "Overview", title: "Dashboard", lede: "A live summary of every document analysed on this computer. All figures are computed from the local analysis history." }),
    statSkeletons(), h("div", { style: "height:18px" }), card("Loading", {}, loadingBlock(4)));
  let s;
  try { s = await getStats(); }
  catch (e) { return root.replaceChildren(pageHead({ eyebrow: "Overview", title: "Dashboard" }), card(null, {}, emptyState({ title: "Could not load statistics", text: e.message, error: true, action: button("Retry", { kind: "primary", onclick: () => render(root) }) }))); }

  const head = pageHead({
    eyebrow: "Overview", title: "Dashboard", lede: "A live summary of every document analysed on this computer. All figures are computed from the local analysis history.",
    actions: [button("New analysis", { kind: "primary", icon: "studio", href: "#/studio" }), button("Classic interface", { kind: "ghost", icon: "external", href: "/classic" })],
  });
  if (s.empty) {
    return root.replaceChildren(head, card(null, {}, emptyState({
      title: "No analyses yet", text: "Run your first analysis and this dashboard will fill with real statistics. Nothing here is sample data.",
      action: button("Analyse a document", { kind: "primary", icon: "studio", href: "#/studio" }),
    })));
  }

  const aiShare = s.scored ? s.verdicts.likely_ai / s.scored : null;
  const stats = h("div", { class: "grid cols-4" },
    statCard({ label: "Documents analysed", value: fmtInt(s.documents), hint: `${fmtInt(s.total_words)} words in total`, icon: "doc" }),
    statCard({ label: "Scored documents", value: fmtInt(s.scored), hint: s.insufficient_text ? `${fmtInt(s.insufficient_text)} too short to score` : "all had enough text", icon: "gauge" }),
    statCard({ label: "Average AI score", value: pct(s.mean_score), hint: s.scored ? `range ${pct(s.min_score, 0)} – ${pct(s.max_score, 0)}` : "no scored documents", icon: "analytics" }),
    statCard({ label: "Flagged likely AI", value: pct(aiShare, 0), hint: `${fmtInt(s.verdicts.likely_ai)} of ${fmtInt(s.scored)} scored`, icon: "flag" }));

  const vItems = [
    { label: "Likely human", value: s.verdicts.likely_human, color: COLORS.human },
    { label: "Uncertain", value: s.verdicts.uncertain, color: COLORS.uncertain },
    { label: "Likely AI", value: s.verdicts.likely_ai, color: COLORS.ai }];
  const binLabels = Array.from({ length: s.histogram_bins }, (_, i) => `${i * 10}`);
  const days = s.activity_by_day;

  const activity = card("Analysis activity", { sub: "Documents analysed per day" },
    days.length ? h("div", { html: bars(days.map((d) => d.count), { labels: days.map((d) => d.date.slice(5)), height: 210, label: "Documents analysed per day" }) })
      : emptyState({ title: "No activity", text: "Nothing to chart yet." }));
  const verdicts = card("Verdict overview", { sub: "Scored documents by verdict band" },
    s.scored ? h("div", { class: "donut-wrap" }, h("div", { html: donut(vItems, { centerValue: s.scored, centerLabel: "scored", label: "Verdict overview" }) }), h("div", { html: legend(vItems) }))
      : emptyState({ title: "Nothing scored yet", text: "Documents shorter than the minimum length are not scored." }));
  const dist = card("Score distribution", { sub: "Document AI score, 10% bins" },
    h("div", { html: bars(s.score_histogram, { labels: binLabels, height: 200, label: "Distribution of document AI scores" }) }),
    h("p", { class: "muted", style: "font-size:12.5px;margin:10px 0 0" }, "Scores are the model's raw output and tend to sit near 0% or 100%; they are not calibrated probabilities."));
  const trend = card("Average score by day", { sub: "Mean AI score of scored documents" },
    days.some((d) => d.mean_score != null) ? h("div", { html: line(days.map((d) => ({ x: d.date.slice(5), y: d.mean_score })), { yMax: 1, yFormat: (v) => Math.round(v * 100) + "%", height: 200, label: "Average AI score per day" }) })
      : emptyState({ title: "No scored days", text: "A trend appears once documents have been scored." }));
  const recent = card("Recent analyses", { sub: "Latest documents" },
    h("div", { class: "list" }, ...s.recent.map((r) => h("a", { class: "row pick", href: `#/intelligence?id=${encodeURIComponent(r.id)}` },
      h("div", { class: "grow" }, h("div", { class: "title", title: r.title }, r.title), h("div", { class: "meta" }, `${fmtDate(r.created_at)} · ${fmtInt(r.words)} words · ${r.source}`)),
      verdictBadge(r.verdict), h("div", { class: "score" }, pct(r.overall_score, 0))))));
  const bySrc = card("Documents by source", { sub: "Upload type and pasted text" },
    h("div", { class: "list" }, ...s.by_source.map((x) => h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, SOURCE_LABEL[x.source] || x.source), h("div", { class: "meta" }, plural(x.count, "document"))), h("div", { class: "score" }, pct(x.mean_score, 0))))));

  root.replaceChildren(head, stats, h("div", { style: "height:18px" }),
    h("div", { class: "grid split" }, activity, verdicts), h("div", { style: "height:18px" }),
    h("div", { class: "grid cols-2" }, dist, trend), h("div", { style: "height:18px" }),
    h("div", { class: "grid split" }, recent, bySrc));
}
