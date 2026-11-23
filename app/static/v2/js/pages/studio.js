// Detection Studio: paste text or upload a file, run the EXISTING backend analysis (/api/analyze, /api/analyze-file),
// show the detector's actual result. No scoring happens in the browser.
import { analyzeFile, analyzeText } from "../api.js";
import { MAX_TEXT_CHARS, MIN_WORDS, countChars, countWords, formatBytes, paragraphSummary, validateFile, validateText } from "../logic.js";
import { resultHead } from "../parts.js";
import { icon } from "../icons.js";
import { setLastId } from "../state.js";
import { badge, button, card, emptyState, fmtInt, h, pageHead, pct, progressBar, statCard, tabs, toast } from "../ui.js";

export function render(root) {
  let picked = null, mode = "paste", busy = false, seq = 0;

  /* ---------- paste panel ---------- */
  const ta = h("textarea", { class: "editor", id: "studioText", spellcheck: "false", "aria-label": "Text to analyse", placeholder: "Paste the text to examine here. The detector works best on English, paragraph-length prose of 100+ words." });
  const words = h("b", {}, "0"), chars = h("b", {}, "0"), hint = h("span", { class: "hint", role: "status" });
  const fill = h("i"), minMeter = h("div", { class: "minmeter", title: `Minimum ${MIN_WORDS} words` }, fill);
  const counters = h("div", { class: "counters" }, h("span", {}, words, " words"), h("span", {}, chars, " characters"), minMeter, hint);
  const pastePanel = h("div", {}, ta, counters);
  function updateCounts() {
    const w = countWords(ta.value), c = countChars(ta.value), v = validateText(ta.value);
    words.textContent = w.toLocaleString(); chars.textContent = c.toLocaleString();
    fill.style.width = Math.min(100, (w / MIN_WORDS) * 100) + "%"; minMeter.classList.toggle("ok", w >= MIN_WORDS);
    hint.className = "hint " + (c > MAX_TEXT_CHARS ? "err" : v.level === "warn" && w > 0 ? "warn" : "");
    hint.textContent = c > MAX_TEXT_CHARS ? `Over the ${MAX_TEXT_CHARS.toLocaleString()}-character limit` : w === 0 ? `Minimum ${MIN_WORDS} words` : w < MIN_WORDS ? `${MIN_WORDS - w} more words needed` : "Ready";
  }
  ta.addEventListener("input", updateCounts);

  /* ---------- upload panel ---------- */
  const input = h("input", { type: "file", accept: ".txt,.md,.docx,.pdf", hidden: true, id: "studioFile" });
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Upload a TXT, MD, DOCX or PDF file" },
    h("div", { class: "drop-icon", html: icon("doc") }), h("strong", {}, "Drop a document here, or click to browse"),
    h("span", { class: "muted" }, "PDF · DOCX · TXT · MD — up to 10 MB"), input);
  const fileHost = h("div", { class: "file-host" }), fileErr = h("div", { class: "field-error", role: "alert", hidden: true });
  const uploadPanel = h("div", {}, drop, fileErr, fileHost);
  function showFileError(msg) { fileErr.textContent = msg || ""; fileErr.hidden = !msg; }
  function pick(f) {
    showFileError("");
    const v = validateFile(f);
    if (!v.ok) { picked = null; fileHost.replaceChildren(); showFileError(v.error); return; }
    picked = f;
    fileHost.replaceChildren(h("div", { class: "file-card" },
      h("div", { class: "file-ico", html: icon("doc") }),
      h("div", { class: "grow" }, h("div", { class: "title", title: f.name }, f.name), h("div", { class: "meta" }, `${v.kind} · ${formatBytes(f.size)}`)),
      badge(v.ext.slice(1).toUpperCase(), "indigo"), badge("Ready", "human"),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { picked = null; input.value = ""; fileHost.replaceChildren(); showFileError(""); } }, "Remove")));
  }
  input.addEventListener("change", () => input.files[0] && pick(input.files[0]));
  const openPicker = () => input.click();
  drop.addEventListener("click", (e) => { if (e.target !== input) openPicker(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => {
    const fs = [...(e.dataTransfer?.files || [])];
    if (fs.length > 1) toast("Only one file at a time here. Using the first one.");
    if (fs[0]) pick(fs[0]);
  });

  /* ---------- input card + run ---------- */
  const titleIn = h("input", { class: "text-in", type: "text", maxlength: "120", placeholder: "Document title (optional)", "aria-label": "Document title" });
  const msg = h("div", { class: "field-error", role: "alert", hidden: true });
  const runBtn = button("Run analysis", { kind: "primary", icon: "studio", onclick: run });
  const clearBtn = button("Clear", { kind: "ghost", onclick: clearAll });
  const modeTabs = tabs([{ id: "paste", label: "Paste text", render: () => pastePanel }, { id: "upload", label: "Upload file", render: () => uploadPanel }], { onChange: (id) => { mode = id; msg.hidden = true; } });
  const inputCard = card("Input", { sub: "Paste text or upload a document. It is analysed on this computer." }, titleIn, modeTabs.el, msg,
    h("div", { class: "actions", style: "margin-top:16px" }, runBtn, clearBtn));

  const side = h("div", { class: "stack" },
    card("How it works", {}, h("ol", { class: "steps" },
      h("li", {}, h("b", {}, "Segment"), " — the document is split into paragraphs and sentences."),
      h("li", {}, h("b", {}, "Score"), " — each paragraph of 25 or more words (long ones in chunks of up to 300) is scored by the local detector model."),
      h("li", {}, h("b", {}, "Aggregate"), " — paragraph scores are combined, weighted by word count, into one document score."))),
    card("Good to know", {}, h("ul", { class: "bullets" },
      h("li", {}, `Results need at least ${MIN_WORDS} words; short texts are unreliable.`),
      h("li", {}, "Scanned PDFs (images without selectable text) cannot be read."),
      h("li", {}, "Every analysis is saved to your local history."),
      h("li", {}, "The score is a signal, not proof of authorship."))));

  const resultHost = h("div", { class: "result-host", "aria-live": "polite" });
  root.replaceChildren(
    pageHead({ eyebrow: "Analyse", title: "Detection Studio", lede: "Paste text or upload a PDF, DOCX, TXT or Markdown file and run the detector. Results come from the same backend as the classic interface." }),
    h("div", { class: "grid split" }, inputCard, side), resultHost);
  updateCounts();

  function clearAll() {
    ta.value = ""; picked = null; input.value = ""; fileHost.replaceChildren(); showFileError(""); msg.hidden = true; titleIn.value = ""; resultHost.replaceChildren(); updateCounts();
  }
  function fail(text) { msg.textContent = text; msg.hidden = false; }

  /* ---------- run ---------- */
  async function run() {
    if (busy) return;
    msg.hidden = true;
    let job;
    if (mode === "paste") {
      const v = validateText(ta.value);
      if (!v.ok) return fail(v.message);
      job = () => analyzeText(ta.value, titleIn.value.trim());
    } else {
      if (!picked) return fail(fileErr.textContent || "Choose a file to upload first.");
      const v = validateFile(picked);
      if (!v.ok) return fail(v.error);
      job = () => analyzeFile(picked, titleIn.value.trim());
    }
    busy = true; runBtn.disabled = true; clearBtn.disabled = true; const mine = ++seq;
    const t0 = performance.now(), elapsed = h("span", { class: "mono" }, "0 s");
    const timer = setInterval(() => { if (!root.isConnected) return clearInterval(timer); elapsed.textContent = `${Math.round((performance.now() - t0) / 1000)} s`; }, 500);
    resultHost.replaceChildren(card(null, { cls: "working" },
      h("div", { class: "working-row" }, h("span", { class: "spinner" }), h("div", {}, h("b", {}, "Analysing document…"), h("div", { class: "muted" }, "Reading, segmenting and scoring on this computer. Long documents take longer. Elapsed ", elapsed))),
      progressBar("Analysing")));
    try {
      const rec = await job();
      if (mine !== seq) return;
      setLastId(rec.id);
      renderResult(rec);
    } catch (e) {
      resultHost.replaceChildren(h("div", { class: "result" }, card(null, {}, emptyState({ error: true, title: "The analysis failed", text: e.message, action: button("Try again", { kind: "primary", onclick: run }) }))));
    } finally { clearInterval(timer); busy = false; runBtn.disabled = false; clearBtn.disabled = false; }
  }

  /* ---------- results ---------- */
  function renderResult(rec) {
    const r = rec.result, host = resultHost;
    const actions = h("div", { class: "actions" }, button("Open Document Intelligence", { kind: "primary", icon: "intelligence", href: `#/intelligence?id=${encodeURIComponent(rec.id)}` }),
      button("Analyse another", { kind: "ghost", onclick: () => { clearAll(); window.scrollTo({ top: 0, behavior: "smooth" }); } }));
    if (r.status !== "ok") {
      host.replaceChildren(h("div", { class: "result" }, card("Result", { sub: rec.title }, emptyState({ icon: "alert", title: "No result for this document", text: r.message }),
        h("p", { class: "muted center" }, `${fmtInt(r.words)} words found · saved to history`), h("div", { class: "actions center" }, actions))));
      host.querySelector(".result")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const ps = paragraphSummary(r), head = resultHead(rec);
    const stats = h("div", { class: "grid cols-4" },
      statCard({ label: "Words", value: fmtInt(r.words), hint: `${fmtInt(r.scored_words)} words scored`, icon: "words" }),
      statCard({ label: "Paragraphs", value: fmtInt(ps.total), hint: `${ps.scored} scored · ${ps.skipped} too short`, icon: "intelligence" }),
      statCard({ label: "Paragraphs flagged AI", value: pct(r.ai_paragraph_share, 0), hint: `${ps.counts.ai} of ${ps.scored} scored paragraphs`, icon: "flag" }),
      statCard({ label: "Scores", value: r.calibrated ? "Calibrated" : "Raw", hint: r.model, icon: "model" }));
    const notes = [];
    if (r.truncated) notes.push(h("div", { class: "notice warn" }, "This document was very long, so only the first 20,000 words were analysed."));
    notes.push(h("p", { class: "muted small" }, "AI and human probability are the model's two-class output (they sum to 100%). They are not calibrated probabilities, and this score is a signal rather than proof of authorship. See Model Information for measured accuracy."));
    host.replaceChildren(h("div", { class: "result" },
      card("Result", { sub: `Saved to history · case ${rec.id}`, actions }, head), h("div", { style: "height:18px" }), stats, h("div", { style: "height:14px" }), ...notes));
    host.querySelector(".result")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
