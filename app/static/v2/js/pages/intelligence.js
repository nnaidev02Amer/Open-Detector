// Document Intelligence: paragraph-level view of one stored analysis. Every value shown is read from the detector's
// stored result (GET /api/history/{id}); explanations are generated from those values only (see logic.js).
import { recentHistory } from "../api.js";
import { COLORS, bars, donut, legend, meter } from "../charts.js";
import { DEFAULT_BANDS, MIN_PARAGRAPH_WORDS, bandOf, histogram, humanProbability, paragraphExplanation, paragraphSummary, paragraphText, preview, sentenceStats } from "../logic.js";
import { resultHead } from "../parts.js";
import { lastId, loadAnalysis, setLastId } from "../state.js";
import { button, card, emptyState, fmtDate, fmtInt, h, loadingBlock, pageHead, pct, segmented, statCard, statSkeletons, tabs, verdictBadge } from "../ui.js";

const BAND_CLASS = { human: "human", uncertain: "uncertain", ai: "ai", none: "skipped" };

export async function render(root, ctx) {
  const wantPick = ctx.query.get("pick") === "1", id = ctx.query.get("id") || (wantPick ? null : lastId());
  const head = (extra) => pageHead({ eyebrow: "Inspect", title: "Document Intelligence", lede: "Paragraph-by-paragraph analysis of one document, with highlighting, score distribution and plain-language explanations of each result.", actions: extra });
  if (!id) return picker(root, head, wantPick ? "Choose a document" : "No document selected yet");
  root.replaceChildren(head(), statSkeletons(4), h("div", { style: "height:18px" }), card("Loading", {}, loadingBlock(4)));
  let rec;
  try { rec = await loadAnalysis(id); }
  catch (e) { return picker(root, head, "That analysis could not be opened", e.message); }
  setLastId(rec.id);
  view(root, rec, head);
}

/* ---------- document picker (real stored analyses) ---------- */
async function picker(root, head, title, error) {
  root.replaceChildren(head(), card(null, {}, loadingBlock(3)));
  let list;
  try { list = (await recentHistory(12)).items; } catch (e) { return root.replaceChildren(head(), card(null, {}, emptyState({ error: true, title: "Could not load your analyses", text: e.message }))); }
  if (!list.length) return root.replaceChildren(head(), card(null, {}, emptyState({ icon: "intelligence", title: "No analyses yet", text: "Analyse a document in Detection Studio and it will appear here with a full paragraph breakdown.", action: button("Open Detection Studio", { kind: "primary", icon: "studio", href: "#/studio" }) })));
  root.replaceChildren(head(), card(title, { sub: error || "Pick a stored analysis to inspect" },
    h("div", { class: "list" }, ...list.map((r) => h("a", { class: "row pick", href: `#/intelligence?id=${encodeURIComponent(r.id)}` },
      h("div", { class: "grow" }, h("div", { class: "title", title: r.title }, r.title), h("div", { class: "meta" }, `${fmtDate(r.created_at)} · ${fmtInt(r.words)} words · ${r.source}`)),
      verdictBadge(r.verdict), h("div", { class: "score" }, pct(r.overall_score, 0)))))));
}

/* ---------- main view ---------- */
function view(root, rec, head) {
  const r = rec.result, bands = r.bands || DEFAULT_BANDS, ok = r.status === "ok";
  const actions = [button("Detection Studio", { kind: "ghost", icon: "studio", href: "#/studio" }), button("Choose another", { kind: "ghost", icon: "history", href: "#/intelligence?pick=1" }), button("Report", { kind: "primary", icon: "reports", href: `#/reports?id=${encodeURIComponent(rec.id)}` })];
  const meta = h("p", { class: "muted small meta-line" }, `Case ${rec.id} · ${rec.source.toUpperCase()} · ${fmtDate(rec.created_at)} · ${fmtInt(r.words)} words`);
  if (!ok) return root.replaceChildren(head(actions), meta, card(null, {}, emptyState({ icon: "alert", title: "This document has no result", text: r.message })));

  const ps = paragraphSummary(r);
  let selected = null, mode = "paragraph";
  const hosts = new Set();                           // detail panels to refresh when the selection changes
  const select = (i) => { selected = selected === i ? null : i; hosts.forEach((fn) => fn()); document.querySelectorAll(".para").forEach((el) => el.classList.toggle("selected", +el.dataset.i === selected)); document.querySelectorAll("tr.prow").forEach((el) => el.classList.toggle("selected", +el.dataset.i === selected)); };

  /* summary */
  const summary = card("Overall analysis", { sub: "Document score = mean of the paragraph scores, weighted by word count" }, resultHead(rec));
  const stats = h("div", { class: "grid cols-4" },
    statCard({ label: "Words", value: fmtInt(r.words), hint: r.truncated ? "only the first 20,000 words analysed" : "in the document", icon: "words" }),
    statCard({ label: "Scored words", value: fmtInt(r.scored_words), hint: `${pct(r.words ? r.scored_words / r.words : 0, 0)} of all words`, icon: "gauge" }),
    statCard({ label: "Paragraphs", value: fmtInt(ps.total), hint: `${ps.scored} scored · ${ps.skipped} under ${MIN_PARAGRAPH_WORDS} words`, icon: "intelligence" }),
    statCard({ label: "Paragraph mix", value: `${ps.counts.ai} / ${ps.counts.uncertain} / ${ps.counts.human}`, hint: "AI / uncertain / human paragraphs", icon: "flag" }));

  /* the key distinction the user asked for */
  const explainer = h("div", { class: "distinction" },
    h("div", {}, h("b", {}, "Paragraph score"), h("p", {}, "The detector's output for a whole paragraph (paragraphs over 300 words are scored in chunks and combined by word count). This is what the document score and the verdict are built from.")),
    h("div", {}, h("b", {}, "Sentence estimate"), h("p", {}, "Each sentence shows the mean score of the overlapping 3-sentence windows that cover it. It is an estimate for localisation, not a classification; paragraphs of 3 sentences or fewer simply show the paragraph score.")));

  /* detail panel (one instance per tab, all driven by `selected`) */
  function detailPanel() {
    const box = h("aside", { class: "detail", "aria-live": "polite" });
    const draw = () => {
      if (selected == null) return box.replaceChildren(emptyState({ icon: "intelligence", title: "Select a paragraph", text: "Click a paragraph to see its score, probabilities and an explanation." }));
      const p = r.paragraphs[selected], band = bandOf(p.score, bands), ss = sentenceStats(p);
      const kids = [h("div", { class: "detail-head" }, h("h3", {}, `Paragraph ${p.index + 1}`), p.scored ? verdictBadge(band === "human" ? "likely_human" : band === "ai" ? "likely_ai" : "uncertain") : h("span", { class: "badge neutral" }, "Not scored"))];
      if (p.scored) kids.push(h("div", { class: "prob-row small" }, h("div", {}, h("span", { class: "k" }, "AI probability"), h("b", { class: "ai-t" }, pct(p.score))), h("div", {}, h("span", { class: "k" }, "Human probability"), h("b", { class: "human-t" }, pct(humanProbability(p.score))))), h("div", { html: meter(p.score) }));
      kids.push(h("p", { class: "explain" }, paragraphExplanation(p, r)));
      kids.push(h("dl", { class: "kv" }, h("dt", {}, "Words"), h("dd", {}, fmtInt(p.words)), h("dt", {}, "Sentences"), h("dd", {}, fmtInt(p.sentences.length))));
      if (p.scored && ss) kids.push(h("div", { class: "sent-stats" }, h("b", {}, "Sentence context-window estimates"), h("p", { class: "muted small" }, `Across ${ss.n} sentences: lowest ${pct(ss.min, 0)}, mean ${pct(ss.mean, 0)}, highest ${pct(ss.max, 0)}. These are estimates, separate from the paragraph score above.`)));
      kids.push(h("div", { class: "sent-list" }, ...p.sentences.map((s, k) => h("div", { class: `sent band-${BAND_CLASS[s.scored ? bandOf(s.score, bands) : "none"]}` }, h("span", { class: "sn" }, k + 1), h("span", { class: "st" }, preview(s.text, 110)), h("span", { class: "ss" }, s.scored ? pct(s.score, 0) : "—")))));
      box.replaceChildren(...kids);
    };
    hosts.add(draw); draw();
    return box;
  }

  /* tab 1: annotated document */
  function docTab() {
    hosts.clear();
    const legendEl = h("div", { class: "legend-inline" }, ...[["human", "Likely human"], ["uncertain", "Uncertain"], ["ai", "Likely AI"], ["skipped", `Not scored (<${MIN_PARAGRAPH_WORDS} words)`]].map(([c, l]) => h("span", {}, h("i", { class: `sw ${c}` }), l)));
    const docEl = h("div", { class: "doc" });
    const paint = () => docEl.replaceChildren(...r.paragraphs.map((p) => paragraphBlock(p)));
    function paragraphBlock(p) {
      const band = p.scored ? bandOf(p.score, bands) : "none", cls = BAND_CLASS[band];
      const body = h("div", { class: "para-body" });
      if (mode === "sentence" && p.scored) {
        let pos = p.start;
        for (const s of p.sentences) {
          if (s.start > pos) body.append(rec.text.slice(pos, s.start));
          const sb = s.scored ? BAND_CLASS[bandOf(s.score, bands)] : "skipped";
          body.append(h("span", { class: `snt snt-${sb}`, title: s.scored ? `${pct(s.score, 0)} AI (context-window estimate)` : "not scored" }, s.text));
          pos = s.end;
        }
        if (pos < p.end) body.append(rec.text.slice(pos, p.end));
      } else body.textContent = paragraphText(rec, p);
      return h("div", { class: `para band-${cls}${selected === p.index ? " selected" : ""}`, "data-i": p.index, tabindex: "0", role: "button", "aria-label": `Paragraph ${p.index + 1}`,
        onclick: () => select(p.index), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(p.index); } } },
        h("div", { class: "para-tag" }, h("span", {}, `¶ ${p.index + 1}`), h("b", {}, p.scored ? pct(p.score, 0) : "skipped")), body);
    }
    const seg = segmented([{ id: "paragraph", label: "Paragraph scores" }, { id: "sentence", label: "Sentence estimates" }], mode, (m) => { mode = m; paint(); });
    paint();
    return h("div", {}, h("div", { class: "toolbar" }, seg.el, legendEl),
      h("p", { class: "muted small" }, mode === "paragraph" ? "Each paragraph is tinted by its own score." : "Sentences are tinted by their context-window estimate.", " Colours are repeated as underline styles (dotted = human-like, solid = AI-like)."),
      h("div", { class: "grid detail-grid" }, docEl, detailPanel()));
  }

  /* tab 2: paragraph table */
  function tableTab() {
    hosts.clear();
    let sort = { key: "index", dir: 1 };
    const tbody = h("tbody"), th = {};
    const rows = () => [...r.paragraphs].sort((a, b) => { const va = sort.key === "score" ? (a.score ?? -1) : sort.key === "words" ? a.words : a.index, vb = sort.key === "score" ? (b.score ?? -1) : sort.key === "words" ? b.words : b.index; return (va - vb) * sort.dir; });
    function paint() {
      Object.entries(th).forEach(([k, el]) => el.setAttribute("aria-sort", sort.key === k ? (sort.dir > 0 ? "ascending" : "descending") : "none"));
      tbody.replaceChildren(...rows().map((p) => {
        const band = p.scored ? bandOf(p.score, bands) : "none";
        return h("tr", { class: `prow${selected === p.index ? " selected" : ""}`, "data-i": p.index, tabindex: "0", onclick: () => select(p.index), onkeydown: (e) => { if (e.key === "Enter") select(p.index); } },
          h("td", { class: "num" }, p.index + 1), h("td", { class: "pv" }, preview(paragraphText(rec, p), 100)), h("td", { class: "num" }, fmtInt(p.words)),
          h("td", { class: "sc" }, p.scored ? h("div", { class: "sc-cell" }, h("div", { html: meter(p.score) }), h("b", {}, pct(p.score, 0))) : h("span", { class: "muted" }, "—")),
          h("td", {}, p.scored ? verdictBadge(band === "human" ? "likely_human" : band === "ai" ? "likely_ai" : "uncertain") : h("span", { class: "badge neutral" }, "Not scored")));
      }));
    }
    const sortable = (key, label, cls = "") => { const b = h("button", { type: "button", class: "sort", onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : (key === "index" ? 1 : -1) }; paint(); } }, label); th[key] = h("th", { class: cls, scope: "col" }, b); return th[key]; };
    const table = h("table", { class: "ptable" }, h("thead", {}, h("tr", {}, sortable("index", "#", "num"), h("th", { scope: "col" }, "Paragraph"), sortable("words", "Words", "num"), sortable("score", "AI score"), h("th", { scope: "col" }, "Result"))), tbody);
    paint();
    return h("div", { class: "grid detail-grid" }, h("div", { class: "table-scroll" }, table), detailPanel());
  }

  /* tab 3: distribution */
  function distTab() {
    hosts.clear();
    const scored = r.paragraphs.filter((p) => p.scored), sentScores = scored.flatMap((p) => p.sentences.filter((s) => s.scored).map((s) => s.score));
    const labels = Array.from({ length: 10 }, (_, i) => `${i * 10}`);
    const words = { human: 0, uncertain: 0, ai: 0 };
    scored.forEach((p) => { words[bandOf(p.score, bands)] += p.words; });
    const wItems = [{ label: "Likely human", value: words.human, color: COLORS.human }, { label: "Uncertain", value: words.uncertain, color: COLORS.uncertain }, { label: "Likely AI", value: words.ai, color: COLORS.ai }];
    const strip = h("div", { class: "pstrip", role: "list" }, ...r.paragraphs.map((p) => {
      const band = p.scored ? bandOf(p.score, bands) : "none";
      return h("button", { type: "button", role: "listitem", class: `pbar band-${BAND_CLASS[band]}`, title: p.scored ? `Paragraph ${p.index + 1}: ${pct(p.score)} AI · ${p.words} words` : `Paragraph ${p.index + 1}: not scored`, style: `height:${p.scored ? Math.max(6, p.score * 100) : 6}%`, onclick: () => { select(p.index); tabsCtl.select("doc"); } });
    }));
    return h("div", { class: "grid cols-2" },
      card("Paragraph score distribution", { sub: `${scored.length} scored paragraphs, 10% bins` }, h("div", { html: bars(histogram(scored.map((p) => p.score)), { labels, height: 200, label: "Paragraph score distribution" }) }),
        h("p", { class: "muted small", style: "margin:10px 0 0" }, "Raw model scores cluster near 0% or 100%; see Model Information.")),
      card("Words by paragraph verdict", { sub: "Share of scored words" }, h("div", { class: "donut-wrap" }, h("div", { html: donut(wItems, { centerValue: fmtInt(r.scored_words), centerLabel: "words", label: "Words by verdict" }) }), h("div", { html: legend(wItems.map((i) => ({ ...i, value: fmtInt(i.value) }))) }))),
      card("Paragraph profile", { sub: "One bar per paragraph in reading order — click to inspect" }, strip),
      card("Sentence estimate distribution", { sub: `${sentScores.length} context-window estimates (not paragraph scores)` }, h("div", { html: bars(histogram(sentScores), { labels, height: 200, label: "Sentence estimate distribution" }) })));
  }

  const tabsCtl = tabs([{ id: "doc", label: "Annotated document", render: docTab }, { id: "table", label: "Paragraphs", render: tableTab }, { id: "dist", label: "Distribution", render: distTab }], { initial: "doc" });
  root.replaceChildren(head(actions), meta, summary, h("div", { style: "height:16px" }), stats, h("div", { style: "height:16px" }), explainer, h("div", { style: "height:16px" }), card(null, { cls: "tabcard" }, tabsCtl.el));
}
