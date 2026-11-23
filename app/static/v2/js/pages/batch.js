// Batch Analysis: one request to the existing POST /api/batch, then results read from the batch record it returns.
import { analyzeBatch, deleteBatch, getBatch, listBatches } from "../api.js";
import { COLORS, bars, donut, legend, meter } from "../charts.js";
import { MAX_BATCH_FILES, formatBytes, validateBatch } from "../logic.js";
import { icon } from "../icons.js";
import { badge, button, card, confirmDialog, emptyState, fmtDate, fmtInt, h, loadingBlock, pageHead, pct, progressBar, statCard, statSkeletons, toast, verdictBadge } from "../ui.js";

export async function render(root, ctx) {
  const id = ctx.query.get("id");
  return id ? detail(root, id) : home(root);
}

/* ---------------------------------------------------------------- shared pieces */
export function verdictStack(v) {
  const n = (v.likely_human || 0) + (v.uncertain || 0) + (v.likely_ai || 0);
  if (!n) return h("span", { class: "muted small" }, "—");
  const seg = (k, c) => (v[k] ? h("i", { class: c, style: `width:${(v[k] / n) * 100}%`, title: `${v[k]} ${k.replace("likely_", "likely ")}` }) : null);
  return h("div", { class: "stack-bar", role: "img", "aria-label": `${v.likely_human} human, ${v.uncertain} uncertain, ${v.likely_ai} AI` }, seg("likely_human", "h"), seg("uncertain", "u"), seg("likely_ai", "a"));
}

const STATUS = {
  ok: ["Scored", "human"], insufficient_text: ["Too short", "uncertain"], error: ["Failed", "ai"], deleted: ["Removed", "neutral"],
};
const statusBadge = (s) => { const [t, k] = STATUS[s] || [s, "neutral"]; return badge(t, k); };

function resultView(b, { skipped = [], onDelete, onNew } = {}) {
  const s = b.summary, v = s.verdicts, items = b.items;
  let order = "file";
  const vItems = [{ label: "Likely human", value: v.likely_human, color: COLORS.human }, { label: "Uncertain", value: v.uncertain, color: COLORS.uncertain }, { label: "Likely AI", value: v.likely_ai, color: COLORS.ai }];
  const failed = s.failed_files || 0;
  const stats = h("div", { class: "grid cols-4" },
    statCard({ label: "Files in batch", value: fmtInt(b.files), hint: skipped.length ? `${skipped.length} more skipped before upload` : "all sent for analysis", icon: "batch" }),
    statCard({ label: "Completed", value: fmtInt(s.documents), hint: `${fmtInt(s.scored)} scored · ${fmtInt(s.insufficient_text)} too short`, icon: "gauge" }),
    statCard({ label: "Failed", value: fmtInt(failed), hint: failed ? "see reasons below" : "no failures", icon: "alert" }),
    statCard({ label: "Average AI score", value: pct(s.mean_score), hint: s.scored ? `range ${pct(s.min_score, 0)} – ${pct(s.max_score, 0)}` : "nothing scored", icon: "analytics" }));
  const overview = h("div", { class: "grid cols-2", style: "margin-top:18px" },
    card("Verdict distribution", { sub: "Scored documents in this batch" }, s.scored
      ? h("div", { class: "donut-wrap" }, h("div", { html: donut(vItems, { centerValue: s.scored, centerLabel: "scored", label: "Batch verdict distribution" }) }), h("div", { html: legend(vItems) }))
      : emptyState({ title: "Nothing scored", text: "Failed or too-short documents have no verdict." })),
    card("Score distribution", { sub: "Document AI score, 10% bins" }, s.scored
      ? h("div", { html: bars(s.score_histogram, { labels: Array.from({ length: s.histogram_bins }, (_, i) => `${i * 10}`), height: 190, label: "Batch score distribution" }) })
      : emptyState({ title: "No scores yet", text: "Nothing to chart." })));
  const tbody = h("tbody");
  const rows = () => (order === "score" ? [...items].sort((a, c) => (c.overall_score ?? -1) - (a.overall_score ?? -1)) : items);
  const paint = () => tbody.replaceChildren(...rows().map((i) => h("tr", {},
    h("td", { class: "num idx", "data-label": "#" }, i.position + 1),
    h("td", { class: "doc-cell", "data-label": "File" }, h("div", { class: "title", title: i.filename }, i.filename), i.error ? h("div", { class: "err-text" }, i.error) : h("div", { class: "meta" }, i.source ? i.source.toUpperCase() : "")),
    h("td", { "data-label": "Status" }, statusBadge(i.status)), h("td", { class: "num", "data-label": "Words" }, fmtInt(i.words)),
    h("td", { class: "sc", "data-label": "AI score" }, i.overall_score != null ? h("div", { class: "sc-cell" }, h("div", { html: meter(i.overall_score) }), h("b", {}, pct(i.overall_score, 0))) : h("span", { class: "muted" }, "—")),
    h("td", { "data-label": "Verdict" }, i.verdict ? verdictBadge(i.verdict) : h("span", { class: "muted" }, "—")),
    h("td", { class: "act" }, i.analysis_id && i.status !== "deleted" ? h("a", { class: "btn btn-sm", href: `#/intelligence?id=${encodeURIComponent(i.analysis_id)}` }, "Open") : null))));
  const seg = h("div", { class: "segmented" }, ...[["file", "File order"], ["score", "Highest score first"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === order), onclick: (e) => { order = k; seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); paint(); } }, l)));
  paint();
  const table = card("Individual results", { sub: "Every file in the batch", actions: seg },
    h("div", { class: "table-scroll" }, h("table", { class: "ptable stack-m" }, h("thead", {}, h("tr", {}, ...["#", "File", "Status", "Words", "AI score", "Verdict", ""].map((t, i) => h("th", { scope: "col", class: i === 0 || i === 3 ? "num" : "" }, t)))), tbody)));
  const skippedCard = skipped.length ? card("Not uploaded", { sub: "Rejected by the pre-upload check" }, h("div", { class: "list" }, ...skipped.map((x) => h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, x.file.name), h("div", { class: "err-text" }, x.reason)), badge("Skipped", "neutral"))))) : null;
  const acts = h("div", { class: "actions" }, onNew ? button("New batch", { kind: "primary", icon: "batch", onclick: onNew }) : button("New batch", { kind: "primary", icon: "batch", href: "#/batch" }),
    button("Batch report", { kind: "ghost", icon: "reports", href: `#/reports?batch=${encodeURIComponent(b.id)}` }), button("View in History", { kind: "ghost", icon: "history", href: "#/history" }), onDelete ? button("Remove this batch", { kind: "ghost", onclick: onDelete }) : null);
  return h("div", {}, h("p", { class: "muted small meta-line" }, `Batch ${b.id} · ${fmtDate(b.created_at)}`), stats, overview, h("div", { style: "height:18px" }), table, skippedCard ? h("div", { style: "height:18px" }) : null, skippedCard, h("div", { style: "height:18px" }), acts);
}

/* ---------------------------------------------------------------- batch detail (#/batch?id=) */
async function detail(root, id) {
  const head = (t) => pageHead({ eyebrow: "Batch", title: t || "Batch results", actions: [button("All batches", { kind: "ghost", icon: "batch", href: "#/batch" })] });
  root.replaceChildren(head(), statSkeletons(4), h("div", { style: "height:18px" }), card("Loading", {}, loadingBlock(4)));
  let b;
  try { b = await getBatch(id); } catch (e) { return root.replaceChildren(head(), card(null, {}, emptyState({ error: true, title: "Batch not found", text: e.message, action: button("Back to batches", { kind: "primary", href: "#/batch" }) }))); }
  root.replaceChildren(head(b.title), resultView(b, {
    onDelete: async () => { if (await confirmDialog({ title: "Remove this batch?", text: "Only the grouping is removed. The individual analyses stay in your history.", confirmLabel: "Remove batch", danger: true })) { await deleteBatch(b.id); toast("Batch removed"); location.hash = "#/batch"; } },
  }));
}

/* ---------------------------------------------------------------- batch home */
function home(root) {
  let files = [], busy = false;
  const input = h("input", { type: "file", multiple: true, accept: ".txt,.md,.docx,.pdf", hidden: true, id: "batchFiles" });
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Choose or drop several documents" },
    h("div", { class: "drop-icon", html: icon("batch") }), h("strong", {}, "Drop several documents here, or click to browse"),
    h("span", { class: "muted" }, `PDF · DOCX · TXT · MD — up to ${MAX_BATCH_FILES} files, 10 MB each`), input);
  const listHost = h("div", { class: "file-list" }), summary = h("div", { class: "muted small", role: "status" });
  const titleIn = h("input", { class: "text-in", type: "text", maxlength: "120", placeholder: "Batch name (optional)", "aria-label": "Batch name" });
  const runBtn = button("Analyse batch", { kind: "primary", icon: "batch", onclick: run }), clearBtn = button("Clear", { kind: "ghost", onclick: () => { files = []; paint(); } });
  const resultHost = h("div", { "aria-live": "polite" });
  const previous = h("div");

  const key = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  function add(list) {
    const seen = new Set(files.map(key)); let dup = 0;
    for (const f of list) { if (seen.has(key(f))) dup++; else { files.push(f); seen.add(key(f)); } }
    if (dup) toast(`${dup} duplicate file${dup > 1 ? "s" : ""} ignored.`);
    paint();
  }
  const vb = () => validateBatch(files);
  function paint(state) {
    const v = vb();
    runBtn.disabled = busy || !v.ready.length; clearBtn.disabled = busy;
    summary.textContent = files.length ? `${files.length} selected · ${v.ready.length} ready · ${v.rejected.length} rejected` : "";
    listHost.replaceChildren(...v.items.map((it) => {
      const st = busy && it.status === "ready" ? h("span", { class: "badge indigo" }, h("span", { class: "spinner", style: "width:11px;height:11px;border-width:2px" }), " Analysing") : it.status === "ready" ? badge("Ready", "human") : badge("Rejected", "ai");
      return h("div", { class: `file-card compact ${it.status}` }, h("div", { class: "file-ico", html: icon("doc") }),
        h("div", { class: "grow" }, h("div", { class: "title", title: it.file.name }, it.file.name), h("div", { class: it.status === "rejected" ? "err-text" : "meta" }, it.status === "rejected" ? it.reason : `${it.kind} · ${formatBytes(it.file.size)}`)),
        st, busy ? null : h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": `Remove ${it.file.name}`, onclick: () => { files = files.filter((f) => f !== it.file); paint(); } }, "Remove"));
    }));
  }
  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  drop.addEventListener("click", (e) => { if (e.target !== input && !busy) input.click(); });
  drop.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !busy) { e.preventDefault(); input.click(); } });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (!busy) add([...(e.dataTransfer?.files || [])]); });

  async function run() {
    const v = vb(); if (busy || !v.ready.length) return;
    busy = true; paint();
    const t0 = performance.now(), elapsed = h("span", { class: "mono" }, "0 s"), timer = setInterval(() => { if (!root.isConnected) return clearInterval(timer); elapsed.textContent = `${Math.round((performance.now() - t0) / 1000)} s`; }, 500);
    resultHost.replaceChildren(card(null, { cls: "working" }, h("div", { class: "working-row" }, h("span", { class: "spinner" }),
      h("div", {}, h("b", {}, `Analysing ${v.ready.length} document${v.ready.length > 1 ? "s" : ""}…`), h("div", { class: "muted" }, "Files are processed one after another on this computer; results appear when the whole batch finishes. Elapsed ", elapsed))), progressBar("Analysing batch")));
    try {
      const b = await analyzeBatch(v.ready.map((x) => x.file), titleIn.value.trim());
      history.replaceState(null, "", `#/batch?id=${encodeURIComponent(b.id)}`);   // permalink; no re-render
      resultHost.replaceChildren(resultView(b, { skipped: v.rejected, onNew: () => { files = []; titleIn.value = ""; resultHost.replaceChildren(); history.replaceState(null, "", "#/batch"); paint(); loadPrevious(); window.scrollTo({ top: 0, behavior: "smooth" }); } }));
      resultHost.firstChild.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(`Batch finished: ${b.summary.documents} analysed, ${b.summary.failed_files} failed`);
      loadPrevious();
    } catch (e) {
      resultHost.replaceChildren(card(null, {}, emptyState({ error: true, title: "The batch failed", text: e.message, action: button("Try again", { kind: "primary", onclick: run }) })));
    } finally { clearInterval(timer); busy = false; paint(); }
  }

  async function loadPrevious() {
    previous.replaceChildren(card("Previous batches", {}, loadingBlock(2)));
    let list;
    try { list = await listBatches(); } catch (e) { return previous.replaceChildren(card("Previous batches", {}, emptyState({ error: true, title: "Could not load batches", text: e.message, action: button("Retry", { onclick: loadPrevious }) }))); }
    if (!list.length) return previous.replaceChildren(card("Previous batches", { sub: "Your earlier batch runs" }, emptyState({ icon: "batch", title: "No batches yet", text: "Run a batch above and it will be saved here." })));
    previous.replaceChildren(card("Previous batches", { sub: `${list.length} saved` }, h("div", { class: "list" }, ...list.map((b) => h("a", { class: "row pick", href: `#/batch?id=${encodeURIComponent(b.id)}` },
      h("div", { class: "grow" }, h("div", { class: "title", title: b.title }, b.title), h("div", { class: "meta" }, `${fmtDate(b.created_at)} · ${b.files} files · ${b.summary.scored} scored${b.summary.failed_files ? ` · ${b.summary.failed_files} failed` : ""}`)),
      h("div", { class: "mini" }, verdictStack(b.summary.verdicts)), h("div", { class: "score" }, pct(b.summary.mean_score, 0)))))));
  }

  const inputCard = card("Select documents", { sub: "Each file is validated here first, then analysed together." }, drop, summary, listHost, titleIn, h("div", { class: "actions", style: "margin-top:14px" }, runBtn, clearBtn));
  const side = card("How batches work", {}, h("ul", { class: "bullets" },
    h("li", {}, `Up to ${MAX_BATCH_FILES} files per batch, same formats as Detection Studio.`),
    h("li", {}, "A file that cannot be read fails on its own; the rest still finish."),
    h("li", {}, "Every document is also saved in History and opens in Document Intelligence."),
    h("li", {}, "Results are the same as analysing each file individually.")));
  root.replaceChildren(pageHead({ eyebrow: "Analyse many", title: "Batch Analysis", lede: "Analyse several documents at once and compare them in a combined overview." }),
    h("div", { class: "grid split" }, inputCard, side), resultHost, h("div", { style: "height:18px" }), previous);
  paint(); loadPrevious();
}
