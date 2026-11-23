// Report builders (pure DOM, no network). Every figure comes from a stored analysis record
// (GET /api/history/{id}), a batch record (GET /api/batch/{id}) or /api/model-info + /api/evaluation. Nothing is recomputed
// with new scoring logic; only counts, shares and histograms over the stored scores are derived.
import { COLORS, bars, donut, legend } from "./charts.js";
import { DEFAULT_BANDS, MIN_PARAGRAPH_WORDS, SOURCE_LABEL, bandOf, BAND_LABEL, histogram, humanProbability, paragraphExplanation, paragraphSummary, paragraphText, preview, sentenceStats, verdictExplanation } from "./logic.js";
import { scaleGauge } from "./parts.js";
import { h } from "./ui.js";

const P = (v, d = 1) => (v == null ? "—" : (v * 100).toFixed(d) + "%");
const N = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US"));
export const fmtUtc = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? String(iso) : d.toISOString().slice(0, 16).replace("T", " ") + " UTC"; };
const VERDICT_TEXT = { likely_human: "Likely human-written", uncertain: "Uncertain", likely_ai: "Likely AI-generated" };
const chip = (verdict) => h("span", { class: `r-badge ${verdict === "likely_human" ? "human" : verdict === "likely_ai" ? "ai" : verdict ? "unc" : "none"}` }, VERDICT_TEXT[verdict] || "Not scored");
const bandChip = (band) => chip({ human: "likely_human", ai: "likely_ai", uncertain: "uncertain" }[band]);
const sec = (num, title, ...kids) => h("section", { class: "r-sec" }, h("h2", {}, h("span", { class: "r-num" }, num), title), ...kids);
const kv = (rows) => h("table", { class: "r-kv" }, h("tbody", {}, ...rows.map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, v)))));
const chartBox = (title, node, note) => h("figure", { class: "r-chart" }, h("figcaption", {}, title), node, note ? h("p", { class: "r-note" }, note) : null);
const svg = (html) => h("div", { html });

function head(title, subtitle, rows) {
  return h("header", { class: "r-head" },
    h("div", { class: "r-brand" }, h("span", { class: "r-mark", html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h8"/></svg>' }), h("span", {}, "Open Detector"), h("em", {}, "AI text analysis report")),
    h("h1", {}, title), subtitle ? h("p", { class: "r-sub" }, subtitle) : null, kv(rows));
}

/** Methods, limitations and responsible-use text, populated from /api/model-info and /api/evaluation when available. */
export function limitationsSection(num, info, evalData) {
  const kids = [];
  if (!info) {
    kids.push(h("p", { class: "r-note" }, "Model information could not be loaded for this report. The general cautions below still apply."));
  } else {
    const sc = info.scoring, all = (evalData?.datasets || []).find((d) => d.name === "All combined");
    kids.push(kv([
      ["Model", `${info.model} (${info.model_facts?.class || info.architecture})`],
      ["Device", info.device], ["Scores", info.calibrated ? "temperature-calibrated" : "raw model output, not calibrated"],
      ["Verdict bands", `Likely human below ${P(sc.bands.human_below, 0)}; likely AI above ${P(sc.bands.ai_above, 0)}; uncertain in between`],
      ["Processing", `Paragraphs of at least ${sc.min_words_paragraph} words are scored (chunks of up to ${sc.max_chunk_words} words, up to ${sc.max_tokens_per_chunk} tokens); documents need at least ${sc.min_words_document} words.`],
      ["Sentence estimates", `Mean of overlapping ${sc.context_window_sentences}-sentence window scores. They are estimates for localisation, not classifications.`],
    ]));
    if (all) kids.push(h("p", { class: "r-note" }, `Measured performance of this model on our own out-of-domain evaluation (${N(all.n)} texts, all datasets combined, threshold 0.5): accuracy ${P(all.accuracy)}, precision ${P(all.precision)}, recall ${P(all.recall)}, F1 ${P(all.f1)}, AUROC ${all.roc_auc.toFixed(3)}, human false-positive rate ${P(all.false_positive_rate)}. These datasets are not the model's training domain, so this is not comparable to any published accuracy.`));
    kids.push(h("h3", {}, "Limitations"), h("ul", { class: "r-list" }, ...info.limitations.map((t) => h("li", {}, t)), ...(info.known_issues || []).map((i) => h("li", {}, h("b", {}, i.title + ". "), i.text))));
  }
  kids.push(h("h3", {}, "Responsible use"), h("ul", { class: "r-list" },
    h("li", {}, "AI-text detection is probabilistic. A score is a statistical signal about writing style, not evidence of who wrote a text."),
    h("li", {}, "This report cannot prove or disprove authorship. Human writing can score as AI-like and AI writing as human-like."),
    h("li", {}, "Short, edited, paraphrased, non-native-English and plain educational writing are especially unreliable."),
    h("li", {}, "Do not use this report as the sole basis for an academic-integrity or disciplinary decision; combine it with other evidence and a conversation with the author.")));
  return sec(num, "Method, limitations and responsible use", ...kids);
}

function footer(extra) {
  return h("footer", { class: "r-foot" }, h("span", {}, `Generated by Open Detector (local academic prototype) on ${fmtUtc(new Date().toISOString())}`), extra ? h("span", {}, extra) : null);
}

/* ------------------------------------------------------------------ single analysis */
export function buildReport(rec, { info, evalData, includeText = false } = {}) {
  const r = rec.result, ok = r.status === "ok", bands = r.bands || DEFAULT_BANDS;
  const root = h("article", { class: "report", "data-kind": "analysis", "data-id": rec.id });
  root.append(head(rec.title, `Case ${rec.id}`, [
    ["Document", rec.title], ["Source", SOURCE_LABEL[rec.source] || rec.source], ["Analysed", fmtUtc(rec.created_at)],
    ["Words", N(r.words)], ["Model", r.model]]));
  if (!ok) {
    root.append(sec("1", "Summary", h("div", { class: "r-summary none" }, h("div", {}, chip(null), h("p", {}, r.message))), h("p", { class: "r-note" }, `${N(r.words)} words were found. No score is reported because the detector withholds a result for texts this short.`)),
      limitationsSection("2", info, evalData), footer(`Case ${rec.id}`));
    return root;
  }
  const ps = paragraphSummary(r), human = humanProbability(r.overall_score), band = bandOf(r.overall_score, bands);
  const flagged = r.ai_paragraph_share;
  root.append(sec("1", "Summary",
    h("div", { class: `r-summary band-${band}` },
      h("div", { class: "r-big" }, h("div", {}, h("span", { class: "k" }, "AI probability"), h("b", { class: "ai" }, P(r.overall_score))), h("div", {}, h("span", { class: "k" }, "Human probability"), h("b", { class: "human" }, P(human))), h("div", {}, h("span", { class: "k" }, "Verdict"), chip(r.verdict))),
      scaleGauge(r.overall_score, bands, "Document score"),
      h("p", { class: "r-explain" }, verdictExplanation(r))),
    h("p", { class: "r-note" }, "AI and human probability are the model's two-class output and sum to 100%. They are not calibrated probabilities of authorship.")));
  root.append(sec("2", "Document statistics", kv([
    ["Total words", N(r.words)], ["Scored words", `${N(r.scored_words)} (${P(r.words ? r.scored_words / r.words : 0, 0)} of all words)`],
    ["Paragraphs", `${N(ps.total)} total · ${N(ps.scored)} scored · ${N(ps.skipped)} under ${MIN_PARAGRAPH_WORDS} words (not scored)`],
    ["Paragraph verdicts", `${ps.counts.human} likely human · ${ps.counts.uncertain} uncertain · ${ps.counts.ai} likely AI`],
    ["Paragraphs flagged likely AI", P(flagged, 0)], ["Scores", r.calibrated ? "temperature-calibrated" : "raw model output"],
    ["Truncated", r.truncated ? "Yes — only the first 20,000 words were analysed" : "No"]])));

  const scored = r.paragraphs.filter((p) => p.scored), words = { human: 0, uncertain: 0, ai: 0 };
  scored.forEach((p) => { words[bandOf(p.score, bands)] += p.words; });
  const wItems = [{ label: "Likely human", value: words.human, color: COLORS.human }, { label: "Uncertain", value: words.uncertain, color: COLORS.uncertain }, { label: "Likely AI", value: words.ai, color: COLORS.ai }];
  const aiHuman = [{ label: "AI probability", value: r.overall_score, color: COLORS.ai }, { label: "Human probability", value: human, color: COLORS.human }];
  const labels = Array.from({ length: 10 }, (_, i) => `${i * 10}`);
  const strip = h("div", { class: "r-strip", role: "img", "aria-label": "Paragraph profile" }, ...r.paragraphs.map((p) => h("i", { class: `b-${p.scored ? bandOf(p.score, bands) : "none"}`, style: `height:${p.scored ? Math.max(6, p.score * 100) : 6}%`, title: p.scored ? `Paragraph ${p.index + 1}: ${P(p.score)}` : `Paragraph ${p.index + 1}: not scored` })));
  root.append(sec("3", "Charts", h("div", { class: "r-charts" },
    chartBox("AI versus human probability", h("div", { class: "r-donut" }, svg(donut(aiHuman, { size: 170, centerValue: P(r.overall_score, 0), centerLabel: "AI score", label: "AI versus human probability" })), svg(legend(aiHuman.map((i) => ({ ...i, value: P(i.value) })))))),
    chartBox("Words by paragraph verdict", h("div", { class: "r-donut" }, svg(donut(wItems, { size: 170, centerValue: N(r.scored_words), centerLabel: "scored words", label: "Words by verdict" })), svg(legend(wItems.map((i) => ({ ...i, value: N(i.value) })))))),
    chartBox("Paragraph score distribution", svg(bars(histogram(scored.map((p) => p.score)), { labels, height: 170, label: "Paragraph score distribution" })), `${scored.length} scored paragraphs, 10% bins.`),
    chartBox("Paragraph profile", strip, "One bar per paragraph in reading order; bar height is the AI score; grey bars were not scored."))));

  const rows = r.paragraphs.map((p) => {
    const b = p.scored ? bandOf(p.score, bands) : "none";
    return h("tr", {}, h("td", { class: "n" }, p.index + 1), h("td", { class: "n" }, N(p.words)), h("td", { class: "n" }, p.scored ? P(p.score) : "—"), h("td", { class: "n" }, p.scored ? P(humanProbability(p.score)) : "—"),
      h("td", {}, p.scored ? bandChip(b) : h("span", { class: "r-badge none" }, "Not scored")), h("td", { class: "pv" }, preview(paragraphText(rec, p), 150)));
  });
  const sAll = r.paragraphs.flatMap((p) => (p.scored ? p.sentences.filter((s) => s.scored && s.score != null).map((s) => s.score) : []));
  root.append(sec("4", "Paragraph-level results",
    h("table", { class: "r-table" }, h("thead", {}, h("tr", {}, ...["#", "Words", "AI score", "Human", "Verdict", "Paragraph (start)"].map((t, i) => h("th", { scope: "col", class: i < 4 ? "n" : "" }, t)))), h("tbody", {}, ...rows)),
    h("p", { class: "r-note" }, `Paragraph scores are the detector's output for each whole paragraph and are what the document score is built from. ${sAll.length ? `Sentence context-window estimates (not shown per row) range from ${P(Math.min(...sAll), 0)} to ${P(Math.max(...sAll), 0)} across ${sAll.length} sentences; they are a localisation aid, not classifications.` : ""}`)));

  let n = 5;
  if (includeText) {
    root.append(sec(String(n++), "Annotated text (appendix)", h("div", { class: "r-text" }, ...r.paragraphs.map((p) => {
      const b = p.scored ? bandOf(p.score, bands) : "none";
      return h("div", { class: `r-para b-${b}` }, h("span", { class: "tag" }, `¶ ${p.index + 1} · ${p.scored ? P(p.score, 0) : "not scored"}`), paragraphText(rec, p));
    }))));
  }
  root.append(limitationsSection(String(n), info, evalData), footer(`Case ${rec.id}`));
  return root;
}

/* ------------------------------------------------------------------ batch */
/** records: Map analysisId -> stored record or null (missing). */
export function buildBatchReport(batch, records, { info, evalData, includeDetail = true } = {}) {
  const s = batch.summary, v = s.verdicts, root = h("article", { class: "report", "data-kind": "batch", "data-id": batch.id });
  root.append(head(batch.title, `Batch ${batch.id}`, [["Batch", batch.title], ["Run", fmtUtc(batch.created_at)], ["Files submitted", N(batch.files)], ["Completed", `${N(s.documents)} (${N(s.scored)} scored, ${N(s.insufficient_text)} too short)`], ["Failed", N(s.failed_files)]]));
  const vItems = [{ label: "Likely human", value: v.likely_human, color: COLORS.human }, { label: "Uncertain", value: v.uncertain, color: COLORS.uncertain }, { label: "Likely AI", value: v.likely_ai, color: COLORS.ai }];
  root.append(sec("1", "Batch summary", kv([
    ["Files submitted", N(batch.files)], ["Analysed", N(s.documents)], ["Scored", N(s.scored)], ["Too short to score", N(s.insufficient_text)], ["Failed", N(s.failed_files)],
    ["Average AI score", P(s.mean_score)], ["Score range", s.scored ? `${P(s.min_score)} – ${P(s.max_score)}` : "—"], ["Verdicts", `${v.likely_human} likely human · ${v.uncertain} uncertain · ${v.likely_ai} likely AI`], ["Total words", N(s.total_words)]]),
    h("div", { class: "r-charts" },
      chartBox("Verdict distribution", s.scored ? h("div", { class: "r-donut" }, svg(donut(vItems, { size: 170, centerValue: s.scored, centerLabel: "scored", label: "Batch verdict distribution" })), svg(legend(vItems))) : h("p", { class: "r-note" }, "Nothing was scored.")),
      chartBox("Score distribution", s.scored ? svg(bars(s.score_histogram, { labels: Array.from({ length: s.histogram_bins }, (_, i) => `${i * 10}`), height: 170, label: "Batch score distribution" })) : h("p", { class: "r-note" }, "Nothing was scored."), "Document AI score, 10% bins."))));
  const rows = batch.items.map((i) => h("tr", {}, h("td", { class: "n" }, i.position + 1), h("td", { class: "pv" }, i.filename, i.error ? h("div", { class: "r-err" }, i.error) : null),
    h("td", {}, { ok: "Scored", insufficient_text: "Too short", error: "Failed", deleted: "Removed" }[i.status] || i.status), h("td", { class: "n" }, N(i.words)),
    h("td", { class: "n" }, i.overall_score != null ? P(i.overall_score) : "—"), h("td", { class: "n" }, i.overall_score != null ? P(1 - i.overall_score) : "—"), h("td", {}, i.verdict ? chip(i.verdict) : "—")));
  root.append(sec("2", "Individual results", h("table", { class: "r-table" }, h("thead", {}, h("tr", {}, ...["#", "File", "Status", "Words", "AI score", "Human", "Verdict"].map((t, i) => h("th", { scope: "col", class: [0, 3, 4, 5].includes(i) ? "n" : "" }, t)))), h("tbody", {}, ...rows))));
  let n = 3;
  if (includeDetail) {
    const blocks = batch.items.map((i) => {
      const rec = i.analysis_id ? records.get(i.analysis_id) : null;
      if (!rec) return h("div", { class: "r-doc" }, h("h3", {}, `${i.position + 1}. ${i.filename}`), h("p", { class: "r-note" }, i.error ? `Not analysed: ${i.error}` : "This analysis record has been removed from history, so no detail is available."));
      const r = rec.result;
      if (r.status !== "ok") return h("div", { class: "r-doc" }, h("h3", {}, `${i.position + 1}. ${i.filename}`), h("p", { class: "r-note" }, r.message));
      const bands = r.bands || DEFAULT_BANDS, ps = paragraphSummary(r);
      return h("div", { class: "r-doc" }, h("h3", {}, `${i.position + 1}. ${i.filename}`, " ", chip(r.verdict)),
        kv([["AI / human probability", `${P(r.overall_score)} / ${P(1 - r.overall_score)}`], ["Words", `${N(r.words)} (${N(r.scored_words)} scored)`], ["Paragraphs", `${ps.total} total · ${ps.scored} scored · ${ps.counts.ai} likely AI · ${ps.counts.uncertain} uncertain · ${ps.counts.human} likely human`]]),
        h("div", { class: "r-strip small", "aria-label": "Paragraph profile" }, ...r.paragraphs.map((p) => h("i", { class: `b-${p.scored ? bandOf(p.score, bands) : "none"}`, style: `height:${p.scored ? Math.max(6, p.score * 100) : 6}%`, title: p.scored ? P(p.score) : "not scored" }))));
    });
    root.append(sec(String(n++), "Per-document paragraph profiles", h("p", { class: "r-note" }, "One bar per paragraph in reading order; height is the AI score; grey bars were not scored."), ...blocks));
  }
  root.append(limitationsSection(String(n), info, evalData), footer(`Batch ${batch.id}`));
  return root;
}
