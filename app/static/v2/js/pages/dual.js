// Dual-model comparison: Followsci BERT and Fakespot RoBERTa on identical input, side by side.
// Nothing is scored in the browser. There is deliberately NO combined score or verdict: each model decides alone,
// with its own thresholds, and this page only shows where the two independent results agree or disagree.
import { api } from "../api.js";
import { MAX_TEXT_CHARS, MIN_WORDS, countChars, countWords, formatBytes, validateFile, validateText } from "../logic.js";
import { badge, button, card, emptyState, fmtInt, h, pageHead, pct, progressBar, tabs, verdictBadge } from "../ui.js";

const REL = {
  agree_ai: ["Both: AI", "ai"], agree_human: ["Both: human", "human"], agree_uncertain: ["Both: uncertain", "uncertain"],
  partial: ["One uncertain", "uncertain"], disagree: ["Disagree", "ai"], not_compared: ["Not compared", "neutral"],
};
const ms = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const snip = (t, n = 140) => { const s = (t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const relBadge = (k) => { const [l, c] = REL[k] || REL.not_compared; return badge(l, c); };
const post = (path, body) => api(path, body);

export function render(root) {
  let mode = "paste", picked = null, busy = false;
  const ta = h("textarea", { class: "editor", spellcheck: "false", "aria-label": "Text to compare", placeholder: "Paste the text to analyse with both models." });
  const count = h("span", { class: "hint", role: "status" });
  ta.addEventListener("input", () => { const w = countWords(ta.value); count.textContent = w === 0 ? `Minimum ${MIN_WORDS} words` : w < MIN_WORDS ? `${MIN_WORDS - w} more words needed` : `${w.toLocaleString()} words · ${countChars(ta.value).toLocaleString()} characters`; });
  count.textContent = `Minimum ${MIN_WORDS} words`;
  const input = h("input", { type: "file", accept: ".txt,.md,.docx,.pdf", hidden: true });
  const fileMsg = h("div", { class: "field-error", role: "alert", hidden: true }), fileName = h("div", { class: "muted small" });
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Upload a TXT, MD, DOCX or PDF file" },
    h("strong", {}, "Click to choose a PDF, DOCX, TXT or MD file"), h("span", { class: "muted" }, "up to 10 MB"), input);
  function pick(f) {
    fileMsg.hidden = true; const v = validateFile(f);
    if (!v.ok) { picked = null; fileName.textContent = ""; fileMsg.textContent = v.error; fileMsg.hidden = false; return; }
    picked = f; fileName.textContent = `${f.name} · ${formatBytes(f.size)}`;
  }
  input.addEventListener("change", () => input.files[0] && pick(input.files[0]));
  drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files[0]) pick(e.dataTransfer.files[0]); });

  const msg = h("div", { class: "field-error", role: "alert", hidden: true });
  const runBtn = button("Compare both models", { kind: "primary", icon: "studio", onclick: run });
  const modeTabs = tabs([{ id: "paste", label: "Paste text", render: () => h("div", {}, ta, h("div", { class: "counters" }, count)) },
    { id: "upload", label: "Upload file", render: () => h("div", {}, drop, fileMsg, fileName) }], { onChange: (id) => { mode = id; msg.hidden = true; } });
  const host = h("div", { class: "result-host", "aria-live": "polite" });
  root.replaceChildren(
    pageHead({ eyebrow: "Compare", title: "Dual-model comparison", lede: "Run Followsci BERT and Fakespot RoBERTa on the same text. Each model decides independently with its own validated thresholds; probabilities are never averaged and there is no combined verdict." }),
    card("Input", { sub: "Analysed on this computer. Dual results are not saved to history." }, modeTabs.el, msg, h("div", { class: "actions", style: "margin-top:16px" }, runBtn)), host);

  const fail = (t) => { msg.textContent = t; msg.hidden = false; };
  async function run() {
    if (busy) return; msg.hidden = true; let job;
    if (mode === "paste") {
      const v = validateText(ta.value); if (!v.ok) return fail(v.message);
      job = () => post("/api/analyze-dual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ta.value, title: "Pasted text" }) });
    } else {
      if (!picked) return fail("Choose a file to upload first.");
      const fd = new FormData(); fd.append("file", picked);
      job = () => post("/api/analyze-file-dual", { method: "POST", body: fd });
    }
    busy = true; runBtn.disabled = true;
    host.replaceChildren(card(null, { cls: "working" }, h("div", { class: "working-row" }, h("span", { class: "spinner" }),
      h("div", {}, h("b", {}, "Running both models…"), h("div", { class: "muted" }, "The first run also loads the second model into memory, which can take a little longer."))), progressBar("Analysing")));
    try { show(await job()); } catch (e) {
      host.replaceChildren(card(null, {}, emptyState({ error: true, title: "The comparison failed", text: e.message, action: button("Try again", { kind: "primary", onclick: run }) })));
    } finally { busy = false; runBtn.disabled = false; }
  }

  function modelCard(m) {
    const t = m.thresholds || {}, head = h("div", { class: "model-head" }, h("h3", {}, m.name), m.status === "ok" ? verdictBadge(m.document.verdict) : badge(m.status === "error" ? "Failed" : "Not scored", m.status === "error" ? "ai" : "neutral"));
    const card_ = m.card || {};
    const facts = h("dl", { class: "kv" },
      h("dt", {}, "Inference time"), h("dd", {}, ms(m.inference_ms)),
      h("dt", {}, "Verdict thresholds"), h("dd", {}, `human < ${pct(t.human_below, 2)} · AI ≥ ${pct(t.ai_at_or_above, 2)}`),
      h("dt", {}, "Thresholds"), h("dd", {}, t.validated ? "validated on a separate split" : "not validated (defaults)"),
      h("dt", {}, "Licence"), h("dd", {}, card_.licence || "—"),
      h("dt", {}, "Device"), h("dd", {}, m.device || "—"));
    if (m.status === "error") return card(null, {}, head, h("div", { class: "model-error", role: "alert" }, m.error), h("p", { class: "muted small" }, "The other model's result is still shown."), facts);
    if (m.status !== "ok") return card(null, {}, head, emptyState({ icon: "alert", title: "No result", text: m.message || "" }), facts);
    const d = m.document;
    return card(null, {}, head,
      h("div", { class: "big-prob" }, h("div", {}, h("b", {}, pct(d.p_ai)), h("span", {}, "AI probability")), h("div", {}, h("b", {}, pct(d.p_human)), h("span", {}, "Human probability"))),
      facts,
      h("dl", { class: "kv" },
        h("dt", {}, "Paragraphs flagged AI"), h("dd", {}, `${pct(d.ai_paragraph_share, 0)} of ${d.scored_paragraphs} scored`),
        d.shipped_verdict ? h("dt", {}, "Existing app verdict") : null, d.shipped_verdict ? h("dd", {}, verdictBadge(d.shipped_verdict)) : null));
  }

  function show(rec) {
    const a = rec.models.followsci, b = rec.models.fakespot, cmp = rec.comparison;
    const parts = [];
    if (cmp) {
      const rel = cmp.document.relation, kind = rel.startsWith("agree") ? "agree" : rel === "partial" ? "partial" : "disagree";
      const text = rel === "disagree" ? "The models disagree on this document." : rel === "partial" ? "One model is uncertain; the other has decided." : "The models agree on the document verdict.";
      parts.push(h("div", { class: `agree-banner ${kind}` }, relBadge(rel), h("b", {}, text),
        h("span", { class: "muted" }, `Difference in AI probability (Followsci − Fakespot): ${(cmp.document.delta_p_ai * 100).toFixed(1)} points`)));
    } else if (a.status === "ok" || b.status === "ok") {
      parts.push(h("div", { class: "agree-banner partial" }, badge("Not compared", "neutral"), h("b", {}, "Only one model produced a result, so there is nothing to compare.")));
    }
    parts.push(h("div", { class: "dual-grid" }, modelCard(a), modelCard(b)));
    if (cmp) {
      const c = cmp.paragraph_counts, text = rec.text;
      let only = false;
      const body = h("tbody");
      const pa = a.paragraphs, pb = b.paragraphs;
      function fill() {
        body.replaceChildren(...cmp.paragraphs.filter((p) => !only || p.relation === "disagree" || p.relation === "partial").map((p) => {
          const x = pa[p.index], y = pb[p.index];
          return h("tr", { class: p.relation === "disagree" ? "row-disagree" : p.relation === "partial" ? "row-partial" : "" },
            h("td", { class: "num" }, String(p.index + 1)), h("td", { class: "snip" }, snip(text.slice(x.start, x.end))),
            h("td", { class: "num" }, x.scored ? pct(x.p_ai) : "—"), h("td", {}, x.scored ? verdictBadge(x.verdict) : "—"),
            h("td", { class: "num" }, y.scored ? pct(y.p_ai) : "—"), h("td", {}, y.scored ? verdictBadge(y.verdict) : "—"), h("td", {}, relBadge(p.relation)));
        }));
        if (!body.children.length) body.append(h("tr", {}, h("td", { colspan: "7", class: "muted" }, "No paragraphs match.")));
      }
      const toggle = h("label", { class: "muted small" }, h("input", { type: "checkbox", onchange: (e) => { only = e.target.checked; fill(); } }), " Show only disagreements and partial agreements");
      fill();
      const scored = Object.entries(c).filter(([k]) => k !== "not_compared").reduce((s, [, v]) => s + v, 0);
      parts.push(card("Paragraph-level comparison", { sub: `${fmtInt(scored)} paragraphs scored by both · ${fmtInt(c.disagree || 0)} disagree · ${fmtInt(c.partial || 0)} one uncertain · ${fmtInt((c.agree_ai || 0) + (c.agree_human || 0) + (c.agree_uncertain || 0))} agree` }, toggle,
        h("div", { class: "table-wrap" }, h("table", { class: "dual-table" },
          h("thead", {}, h("tr", {}, ...["#", "Paragraph", "Followsci AI", "Followsci", "Fakespot AI", "Fakespot", "Agreement"].map((t) => h("th", {}, t)))), body))));
    }
    parts.push(h("p", { class: "muted small" }, cmp?.note || "Each model decides independently. Scores are signals, not proof of authorship.",
      rec.memory_mb ? ` Server memory in use: ${Math.round(rec.memory_mb)} MB.` : ""));
    host.replaceChildren(h("div", { class: "result" }, ...parts));
    host.querySelector(".result")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
