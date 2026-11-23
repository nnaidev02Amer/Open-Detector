// Model Information. Model facts come from GET /api/model-info (read from the loaded model); every evaluation figure comes
// unchanged from GET /api/evaluation, i.e. evaluation/results/metrics.json. Nothing on this page is typed in by hand
// except explanatory prose that contains no performance numbers.
import { api, getModelInfo } from "../api.js";
import { COLORS, bars, donut, legend, meter } from "../charts.js";
import { button, card, emptyState, fmtInt, h, loadingBlock, pageHead, pct, segmented, statCard, statSkeletons } from "../ui.js";

const f3 = (v) => (v == null ? "—" : Number(v).toFixed(3));
const DATASET_NOTES = {
  "HC3": "Human answers vs ChatGPT answers (finance, medicine, open Q&A, computer science).",
  "MAGE": "Human text vs text from many different LLMs.",
  "MAGE-OOD (unseen LLM)": "As MAGE, but the AI text comes from a generator not in MAGE's training split.",
  "All combined": "All of the above pooled.",
};

export async function render(root) {
  const head = pageHead({ eyebrow: "Transparency", title: "Model Information", lede: "What the detector is, how it scores text, how it performed in our own evaluation, and where it fails. Every number comes from the project's evaluation files or the loaded model." });
  root.replaceChildren(head, statSkeletons(4), h("div", { style: "height:18px" }), card("Loading", {}, loadingBlock(4)));
  let info, ev;
  try { [info, ev] = await Promise.all([getModelInfo(), api("/api/evaluation")]); }
  catch (e) { return root.replaceChildren(head, card(null, {}, emptyState({ error: true, title: "Could not load model information", text: e.message, action: button("Retry", { kind: "primary", onclick: () => render(root) }) }))); }
  const gap = () => h("div", { style: "height:18px" });
  root.replaceChildren(head, hero(info), gap(), pipeline(info), gap(), scores(info), gap(), ...(ev.available ? [performance(ev), gap()] : [card("Measured performance", {}, emptyState({ icon: "analytics", title: "No evaluation results available", text: "Run evaluation/evaluate.py to generate evaluation/results/metrics.json. No performance figures are shown without it." })), gap()]),
    weaknesses(info, ev), gap(), responsible());
}

/* ---------------------------------------------------------------- hero / facts */
function hero(info) {
  const m = info.model_facts, params = m.parameters;
  const facts = [["Architecture", m.class], ["Model type", m.model_type], ["Layers", m.num_hidden_layers], ["Hidden size", m.hidden_size], ["Attention heads", m.num_attention_heads], ["Parameters", `${(params / 1e6).toFixed(1)} M`],
    ["Output classes", `${m.num_labels} (human, AI)`], ["Max tokens per chunk", info.scoring.max_tokens_per_chunk], ["Device", info.device], ["Scores", info.calibrated ? `temperature-calibrated (T = ${info.temperature.toFixed(2)})` : "raw model output (uncalibrated)"]];
  return h("div", { class: "grid cols-2 model-hero" },
    card(null, { cls: "hero-card" }, h("p", { class: "eyebrow" }, "Current detector"), h("h2", { class: "model-name" }, info.model), h("p", { class: "muted" }, "A BERT sequence-classification model that outputs the probability a text is AI-generated. It runs locally on this computer; text is never sent anywhere."),
      h("div", { class: "actions" }, h("span", { class: "badge indigo" }, info.device.toUpperCase()), h("span", { class: "badge neutral" }, info.calibrated ? "Calibrated" : "Uncalibrated scores"))),
    card("Verified model facts", { sub: "Read from the loaded model's configuration" }, h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))]))));
}

/* ---------------------------------------------------------------- pipeline */
function pipeline(info) {
  const s = info.scoring;
  const steps = [
    ["Segment", `The text is split into paragraphs and sentences, keeping character offsets. Documents over ${fmtInt(s.max_document_words)} words are truncated.`],
    ["Score paragraphs", `Each paragraph of at least ${s.min_words_paragraph} words is scored by the model. Paragraphs over ${s.max_chunk_words} words are split into chunks of up to ${s.max_chunk_words} words (at most ${s.max_tokens_per_chunk} tokens each).`],
    ["Sentence windows", `Overlapping ${s.context_window_sentences}-sentence windows are scored too, to estimate which sentences drive a paragraph's score.`],
    ["Aggregate", `Paragraph scores are averaged, weighted by word count, into the document score. A document needs at least ${s.min_words_document} words to get a result.`]];
  return card("How text is processed", { sub: "The same pipeline for every input route (paste, TXT, MD, DOCX, PDF)" }, h("ol", { class: "stepper" }, ...steps.map(([t, d], i) => h("li", {}, h("span", { class: "step-n" }, i + 1), h("div", {}, h("b", {}, t), h("p", {}, d))))));
}

/* ---------------------------------------------------------------- score meanings + bands */
function scores(info) {
  const b = info.scoring.bands, hb = b.human_below * 100, ab = b.ai_above * 100;
  const bandsBar = h("div", { class: "bands" }, h("div", { class: "scale-track" }, h("i", { class: "z-human", style: `width:${hb}%` }), h("i", { class: "z-unc", style: `width:${ab - hb}%` }), h("i", { class: "z-ai", style: `width:${100 - ab}%` })),
    h("div", { class: "band-legend" }, h("span", { class: "bl human" }, `Likely human: below ${pct(b.human_below, 0)}`), h("span", { class: "bl unc" }, `Uncertain: ${pct(b.human_below, 0)} to ${pct(b.ai_above, 0)}`), h("span", { class: "bl ai" }, `Likely AI: above ${pct(b.ai_above, 0)}`)));
  return h("div", { class: "grid cols-2" },
    card("Understanding the scores", { sub: "Three different things are shown in the app" }, h("div", { class: "score-kinds" },
      h("div", { class: "kind doc" }, h("b", {}, "Document score"), h("p", {}, "The word-weighted mean of the paragraph scores. This is the headline number and decides the verdict.")),
      h("div", { class: "kind par" }, h("b", {}, "Paragraph score"), h("p", {}, "The model's direct output for one paragraph (or the weighted mean of its chunks). Paragraphs under the minimum length are not scored.")),
      h("div", { class: "kind snt" }, h("b", {}, "Sentence context-window estimate"), h("p", {}, "Each sentence takes the mean of the overlapping sentence-window scores that cover it. It is an estimate used for highlighting, not a classification of that sentence.")))),
    card("Classification bands", { sub: "Fixed in the detector; not tuned on any data" }, bandsBar,
      h("p", { class: "muted small", style: "margin-top:14px" }, "AI and human probability are the model's two-class output and sum to 100%. The bands are heuristic cut-offs, not fitted thresholds. Evaluation metrics below use a plain 50% threshold.")));
}

/* ---------------------------------------------------------------- measured performance */
function metricCards(d) {
  const mk = (label, v, hint, icon) => statCard({ label, value: v, hint, icon });
  return h("div", { class: "grid cols-4" },
    mk("Accuracy", pct(d.accuracy), `n = ${fmtInt(d.n)} (${fmtInt(d.n_ai)} AI, ${fmtInt(d.n_human)} human)`, "gauge"), mk("Precision", pct(d.precision), "of texts called AI, how many were AI", "flag"),
    mk("Recall", pct(d.recall), "of AI texts, how many were caught", "analytics"), mk("F1 score", pct(d.f1), "balance of precision and recall", "gauge"),
    mk("AUROC", f3(d.roc_auc), "ranking quality (0.5 = chance, 1 = perfect)", "analytics"), mk("Human false-positive rate", pct(d.false_positive_rate), "human texts wrongly called AI", "alert"),
    mk("False-negative rate", pct(d.false_negative_rate), "AI texts missed", "alert"), mk("Texts evaluated", fmtInt(d.n), "this dataset", "doc"));
}
function confusion(d) {
  const c = d.confusion;
  return h("table", { class: "confusion", "aria-label": "Confusion matrix" }, h("thead", {}, h("tr", {}, h("th", {}), h("th", { scope: "col" }, "Predicted human"), h("th", { scope: "col" }, "Predicted AI"))),
    h("tbody", {}, h("tr", {}, h("th", { scope: "row" }, "Actually human"), h("td", { class: "ok" }, fmtInt(c.tn)), h("td", { class: "bad" }, fmtInt(c.fp))), h("tr", {}, h("th", { scope: "row" }, "Actually AI"), h("td", { class: "bad" }, fmtInt(c.fn)), h("td", { class: "ok" }, fmtInt(c.tp)))));
}
function subTable(rows, firstLabel) {
  return h("div", { class: "table-scroll" }, h("table", { class: "ptable" }, h("thead", {}, h("tr", {}, ...[firstLabel, "n", "Recall", "False-positive rate", "Precision", "F1", "AUROC"].map((t, i) => h("th", { scope: "col", class: i === 1 ? "num" : "" }, t)))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, h("td", { class: "doc-cell" }, h("b", {}, r.name)), h("td", { class: "num" }, fmtInt(r.n)),
      h("td", { class: r.recall < 0.5 ? "warn-cell" : "" }, pct(r.recall)), h("td", { class: r.false_positive_rate > 0.1 ? "warn-cell" : "" }, pct(r.false_positive_rate)), h("td", {}, pct(r.precision)), h("td", {}, pct(r.f1)), h("td", {}, f3(r.roc_auc)))))));
}

function performance(ev) {
  const sets = ev.datasets, host = h("div"), names = sets.map((d) => d.name);
  const show = (name) => { const d = sets.find((x) => x.name === name); host.replaceChildren(h("p", { class: "muted", style: "margin:0 0 14px" }, DATASET_NOTES[name] || ""), metricCards(d), h("div", { style: "height:18px" }), h("div", { class: "grid cols-2" }, card("Confusion matrix", { sub: `${name}, threshold 0.5` }, confusion(d)), compare(sets, name))); };
  const seg = segmented(sets.map((d) => ({ id: d.name, label: d.name.replace(" (unseen LLM)", "") })), names[names.length - 1], show);
  show(names[names.length - 1]);
  const prov = h("p", { class: "muted small" }, `Source: evaluation/results/metrics.json · generated ${ev.created_utc} · seed ${ev.seed} · decision threshold ${ev.decision_threshold} on the raw softmax probability. `, ev.notes);
  const subs = card("Educational and explanatory text (HC3 subsets)", { sub: "Highlighted cells: recall under 50% or false-positive rate over 10%" }, subTable(ev.hc3_subsets, "Subset"),
    h("p", { class: "muted small", style: "margin:12px 0 0" }, "Subsets of explanatory, question-answer style writing are the closest thing in this evaluation to educational text. Behaviour differs sharply between them, which is why a single overall number can mislead."));
  const lens = card("Accuracy by text length", { sub: "Shorter texts are harder" }, subTable(ev.by_length, "Length"));
  const sat = card("Score saturation", { sub: "How close to 0% or 100% the scores sit" }, h("div", { class: "sat" }, h("b", {}, pct(ev.saturated_share)), h("span", {}, "of evaluated texts scored below 2% or above 98%.")), h("div", { html: meter(ev.saturated_share) }),
    h("p", { class: "muted small", style: "margin:12px 0 0" }, "Near-binary scores mean a displayed percentage says little about confidence, which is why scores should not be read as calibrated probabilities."));
  const cal = ev.calibration, calCard = card("Calibration check", { sub: "Temperature scaling fitted on half the data, evaluated on the other half" }, h("dl", { class: "facts" },
    h("dt", {}, "Fitted temperature"), h("dd", {}, cal.temperature.toFixed(2)), h("dt", {}, "Expected calibration error, raw"), h("dd", {}, f3(cal.heldout_raw.ece)), h("dt", {}, "Expected calibration error, calibrated"), h("dd", {}, f3(cal.heldout_calibrated.ece)), h("dt", {}, "Fit / evaluated on"), h("dd", {}, `${fmtInt(cal.fit_on_n)} / ${fmtInt(cal.evaluated_on_n)} texts`)),
    h("p", { class: "muted small", style: "margin:12px 0 0" }, cal.note, " The app does not apply this calibration."));
  return h("section", {}, card("Measured performance", { sub: "Our own evaluation on public datasets; not the model's training domain", cls: "perf-card" }, h("div", { class: "perf-head" }, seg.el), host, h("div", { style: "height:12px" }), prov),
    h("div", { style: "height:18px" }), subs, h("div", { style: "height:18px" }), h("div", { class: "grid cols-2" }, lens, h("div", { class: "stack" }, sat, calCard)));
}
function compare(sets, current) {
  const labels = sets.map((d) => d.name.replace(" (unseen LLM)", "").replace("All combined", "All"));
  return card("Across datasets", { sub: "Recall and false-positive rate, %" }, h("div", { class: "stack" },
    h("div", {}, h("div", { class: "mini-title" }, "Recall"), h("div", { html: bars(sets.map((d) => +(d.recall * 100).toFixed(1)), { labels, height: 150, yMax: 100, colors: sets.map((d) => (d.name === current ? COLORS.indigoSoft : "#3b4a8f")), label: "Recall by dataset" }) })),
    h("div", {}, h("div", { class: "mini-title" }, "False-positive rate"), h("div", { html: bars(sets.map((d) => +(d.false_positive_rate * 100).toFixed(1)), { labels, height: 150, yMax: 100, colors: sets.map((d) => (d.name === current ? COLORS.ai : "#7a3550")), label: "False-positive rate by dataset" }) }))));
}

/* ---------------------------------------------------------------- weaknesses */
function weaknesses(info, ev) {
  const ev_ = info.evaluation;
  const items = [
    ...info.known_issues.map((i) => h("div", { class: "weak" }, h("b", {}, i.title), h("p", {}, i.text), h("span", { class: "src" }, `Source: ${i.source}`))),
    ...(ev_.weaknesses || []).map((w) => h("div", { class: "weak measured" }, h("b", {}, "Measured weakness"), h("p", {}, w), h("span", { class: "src" }, "Source: evaluation/results/metrics.json"))),
    ...info.limitations.map((t) => h("div", { class: "weak" }, h("p", {}, t))),
    ...((ev_.caveats || []).map((t) => h("div", { class: "weak" }, h("b", {}, "Evaluation caveat"), h("p", {}, t)))),
  ];
  return card("Known weaknesses and limitations", { sub: "Stated plainly" }, h("div", { class: "weak-grid" }, ...items));
}

function responsible() {
  return card("Interpreting results responsibly", { cls: "caution-card" }, h("ul", { class: "bullets big" },
    h("li", {}, h("b", {}, "AI detection is probabilistic. "), "A score is a statistical signal about writing style. It is not a measurement of who wrote a text."),
    h("li", {}, h("b", {}, "It cannot prove authorship. "), "Human writing can look AI-like and AI writing can look human-like, especially when it is short, edited, paraphrased, plain educational prose, or written by a non-native English speaker."),
    h("li", {}, h("b", {}, "Use it as one input only. "), "Never use a detector score as the sole basis for an academic-integrity or disciplinary decision.")));
}
