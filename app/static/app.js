"use strict";
const $ = (id) => document.getElementById(id);
const VIEWS = ["analyze", "review", "history", "method"];
let status = null;
let current = null;           // record currently under review
let pickedFile = null;

/* ---------------- helpers ---------------- */
const pct = (v, d = 0) => (v == null ? "--" : (v * 100).toFixed(d) + "%");
const VERDICT = { likely_human: "Likely human-written", uncertain: "Uncertain", likely_ai: "Likely AI-generated" };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function scoreColor(s) {
  if (s == null) return "transparent";
  const a = Math.min(0.55, Math.abs(s - 0.5) * 1.2).toFixed(2);
  return s >= 0.5 ? `rgba(var(--ai-rgb), ${a})` : `rgba(var(--human-rgb), ${a})`;
}
function solidColor(s) {
  const b = status ? status.bands : { human_below: .35, ai_above: .65 };
  return s < b.human_below ? "var(--human)" : s > b.ai_above ? "var(--ai)" : "var(--mid)";
}
async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); } catch (e) { throw new Error("Cannot reach the local server. Is it still running?"); }
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

/* ---------------- routing ---------------- */
function show(view) {
  if (!VIEWS.includes(view)) view = "analyze";
  VIEWS.forEach((v) => { $("view-" + v).hidden = v !== view; });
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
  if (view === "history") loadHistory();
  if (view === "method") loadMethod();
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

/* ---------------- theme ---------------- */
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("od-theme", t); } catch (_) {} }
$("themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  setTheme(cur === "dark" ? "light" : "dark");
};
try { const t = localStorage.getItem("od-theme"); if (t) setTheme(t); } catch (_) {}

/* ---------------- status ---------------- */
async function loadStatus() {
  const chip = $("modelChip");
  try {
    status = await api("/api/status");
    chip.textContent = `model ready · ${status.device} · ${status.calibrated ? "calibrated" : "raw scores"}`;
    chip.className = "chip ok";
    $("wordHint").textContent = `minimum ${status.min_words} words`;
  } catch (e) { chip.textContent = "server offline"; chip.className = "chip bad"; return; }
  try { const m = await api("/api/evaluation"); if (m.available) status.eval = m; } catch (_) {}
}

/* ---------------- intake ---------------- */
function updateWords() {
  const n = (($("textInput").value.match(/\b[\w'’-]+\b/g)) || []).length;
  $("wordCount").textContent = `${n.toLocaleString()} words`;
  const min = status ? status.min_words : 40, hint = $("wordHint");
  hint.className = "mono small meter " + (n >= 100 ? "ok" : n >= min ? "warn" : "");
  hint.textContent = n >= 100 ? "good length" : n >= min ? "short - results less reliable" : `minimum ${min} words`;
}
$("textInput").addEventListener("input", updateWords);
const drop = $("drop");
drop.onclick = () => $("fileInput").click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } };
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]); });
$("fileInput").onchange = (e) => { if (e.target.files[0]) pickFile(e.target.files[0]); };
function pickFile(f) {
  pickedFile = f; $("fileName").textContent = f.name; $("fileChip").hidden = false;
  if (!$("titleInput").value) $("titleInput").value = f.name;
}
function dropFile() { pickedFile = null; $("fileInput").value = ""; $("fileChip").hidden = true; }
$("fileClear").onclick = dropFile;
$("clearBtn").onclick = () => { $("textInput").value = ""; $("titleInput").value = ""; dropFile(); $("intakeError").hidden = true; updateWords(); };

function setBusy(on) { $("busy").hidden = !on; $("runBtn").disabled = on; }
function intakeError(msg) { const e = $("intakeError"); e.textContent = msg; e.hidden = !msg; }

$("runBtn").onclick = async () => {
  intakeError("");
  const text = $("textInput").value.trim();
  if (!pickedFile && !text) return intakeError("Paste some text or choose a file first.");
  setBusy(true);
  try {
    let rec;
    if (pickedFile) {
      const fd = new FormData(); fd.append("file", pickedFile);
      if ($("titleInput").value) fd.append("title", $("titleInput").value);
      rec = await api("/api/analyze-file", { method: "POST", body: fd });
    } else {
      rec = await api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, title: $("titleInput").value || "Pasted text" }) });
    }
    renderReview(rec);
    location.hash = "review";
  } catch (e) { intakeError(e.message); }
  finally { setBusy(false); }
};

/* ---------------- review ---------------- */
function renderReview(rec) {
  current = rec;
  const r = rec.result;
  $("reviewEmpty").hidden = true; $("reviewBody").hidden = false;
  $("revTitle").textContent = rec.title;
  $("revMeta").textContent = `Case ${rec.id} · ${(rec.source || "").toUpperCase()} · ${r.words.toLocaleString()} words`;
  $("stWords").textContent = r.words.toLocaleString();
  $("stScored").textContent = r.scored_words.toLocaleString();
  $("stPars").textContent = r.paragraphs.length;
  const ok = r.status === "ok";
  $("revInsufficient").hidden = ok;
  if (!ok) $("revInsufficient").textContent = r.message;
  $("dash").style.display = ok ? "" : "none";
  $("stripPanel").style.display = ok ? "" : "none";
  $("scoreBig").textContent = ok ? pct(r.overall_score) : "--";
  const tag = $("verdictTag"); tag.textContent = ok ? VERDICT[r.verdict] : "No result"; tag.className = "verdict-tag " + (r.verdict || "");
  let cav = r.truncated ? "Document was very long; only the first ~20,000 words were analysed." : r.message;
  const all = status && status.eval && status.eval.datasets.find((d) => d.name === "All combined");
  if (ok && all) cav += ` On our out-of-domain test set this model was right ${(all.accuracy * 100).toFixed(0)}% of the time (see Method), so treat this as a weak signal.`;
  $("scoreCaveat").textContent = cav;
  $("stFlag").textContent = ok ? `${Math.round(r.ai_paragraph_share * 100)}%` : "-";
  $("calNote").textContent = r.calibrated ? "calibrated on our held-out evaluation split" : "a calibrated probability";
  if (!r.calibrated) $("calNote").textContent = "not a calibrated probability";
  if (ok) { drawSpectrum(r); drawStrip(r); drawHist(r); }
  drawDoc(rec);
  const id = rec.id;
  $("dlHtml").href = `/api/report/${id}.html`;
  $("dlHtmlFile").href = `/api/report/${id}.html?download=true`;
  $("dlJson").href = `/api/report/${id}.json`;
}

function drawSpectrum(r) {
  const sp = $("spectrum"); sp.replaceChildren();
  const b = r.bands, z = el("div", "zone");
  z.style.left = b.human_below * 100 + "%"; z.style.width = (b.ai_above - b.human_below) * 100 + "%"; sp.appendChild(z);
  [0, .25, .5, .75, 1].forEach((t) => { const k = el("div", "tick"); k.style.left = t * 100 + "%"; sp.appendChild(k); });
  const m = el("div", "marker"); m.dataset.v = pct(r.overall_score); m.style.left = "50%"; sp.appendChild(m);
  requestAnimationFrame(() => requestAnimationFrame(() => { m.style.left = r.overall_score * 100 + "%"; }));
  $("bandLabelMid").textContent = `uncertain ${b.human_below * 100}–${b.ai_above * 100}%`;
}

function drawStrip(r) {
  const st = $("strip"); st.replaceChildren();
  st.appendChild(el("div", "half"));
  r.paragraphs.forEach((p) => {
    const col = el("div", "bar-col" + (p.scored ? "" : " skip"));
    col.title = p.scored ? `Paragraph ${p.index + 1}: ${pct(p.score)} AI-style, ${p.words} words` : `Paragraph ${p.index + 1}: too short to score (${p.words} words)`;
    const i = el("i"); i.style.setProperty("--c", p.scored ? solidColor(p.score) : "var(--rule)");
    i.style.height = "0%"; col.appendChild(i);
    col.appendChild(el("span", null, String(p.index + 1)));
    col.onclick = () => { const t = document.getElementById("par-" + p.index); t.scrollIntoView({ behavior: "smooth", block: "center" }); t.classList.remove("flash"); void t.offsetWidth; t.classList.add("flash"); };
    st.appendChild(col);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (p.scored) i.style.height = Math.max(3, p.score * 100) + "%"; }));
  });
}

function drawHist(r) {
  const h = $("hist"); h.replaceChildren();
  const bins = new Array(10).fill(0); let tot = 0;
  r.paragraphs.forEach((p) => p.sentences.forEach((s) => { if (s.scored) { bins[Math.min(9, Math.floor(s.score * 10))]++; tot++; } }));
  const max = Math.max(1, ...bins);
  bins.forEach((n, i) => {
    const d = el("div"); d.style.height = Math.max(2, (n / max) * 100) + "%"; d.style.setProperty("--c", solidColor((i + .5) / 10));
    d.dataset.n = n || ""; d.title = `${i * 10}–${i * 10 + 10}% : ${n} sentences`; h.appendChild(d);
  });
}

function drawDoc(rec) {
  const doc = $("doc"); doc.replaceChildren();
  const text = rec.text;
  rec.result.paragraphs.forEach((p) => {
    const para = el("div", "para"); para.id = "par-" + p.index;
    const g = el("div", "gutter"); g.style.setProperty("--c", p.scored ? solidColor(p.score) : "var(--rule)");
    g.appendChild(el("b", null, p.scored ? pct(p.score) : "skipped")); g.appendChild(document.createTextNode("¶" + (p.index + 1)));
    para.appendChild(g);
    let pos = p.start;
    p.sentences.forEach((s) => {
      if (s.start > pos) para.appendChild(document.createTextNode(text.slice(pos, s.start)));
      const sp = el("span", "s", s.text);
      if (s.scored) {
        sp.style.background = scoreColor(s.score);
        if (s.score > status.bands.ai_above) sp.classList.add("hl-ai");
        else if (s.score < status.bands.human_below) sp.classList.add("hl-human");
        sp.dataset.tip = `${pct(s.score)} AI-style (context estimate)`;
      } else { sp.classList.add("unscored"); sp.dataset.tip = "Not scored: paragraph too short"; }
      para.appendChild(sp); pos = s.end;
    });
    if (pos < p.end) para.appendChild(document.createTextNode(text.slice(pos, p.end)));
    doc.appendChild(para);
  });
}
$("hlToggle").onchange = (e) => $("doc").classList.toggle("nohl", !e.target.checked);
$("printBtn").onclick = () => window.print();

// tooltip
const tip = el("div", "tip"); tip.hidden = true; document.body.appendChild(tip);
document.addEventListener("mouseover", (e) => { const s = e.target.closest && e.target.closest(".s"); if (!s) { tip.hidden = true; return; } tip.textContent = s.dataset.tip; tip.hidden = false; });
document.addEventListener("mousemove", (e) => { if (!tip.hidden) { tip.style.left = Math.min(innerWidth - 270, e.clientX + 14) + "px"; tip.style.top = e.clientY + 18 + "px"; } });

/* ---------------- archive ---------------- */
async function loadHistory() {
  const body = $("ledger").tBodies[0]; body.replaceChildren();
  let rows = [];
  try { rows = await api("/api/history"); } catch (e) { rows = []; }
  $("histEmpty").hidden = rows.length > 0; $("ledger").hidden = rows.length === 0;
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "mono", r.created_at.replace("T", " ").replace("+00:00", "")));
    tr.appendChild(el("td", null, r.title));
    tr.appendChild(el("td", "mono", r.source));
    tr.appendChild(el("td", "num", r.words.toLocaleString()));
    tr.appendChild(el("td", "num", r.overall_score == null ? "--" : pct(r.overall_score, 1)));
    const v = el("td"); v.appendChild(el("span", "pill " + (r.verdict || "none"), r.verdict ? VERDICT[r.verdict] : "no result")); tr.appendChild(v);
    const del = el("td"); const b = el("button", "link", "delete");
    b.onclick = async (e) => { e.stopPropagation(); if (confirm("Delete this analysis?")) { await api("/api/history/" + r.id, { method: "DELETE" }); loadHistory(); } };
    del.appendChild(b); tr.appendChild(del);
    tr.onclick = async () => { try { renderReview(await api("/api/history/" + r.id)); location.hash = "review"; } catch (e) { alert(e.message); } };
    body.appendChild(tr);
  });
}
$("clearHistory").onclick = async () => { if (confirm("Delete ALL saved analyses? This cannot be undone.")) { await api("/api/history", { method: "DELETE" }); loadHistory(); } };

/* ---------------- method ---------------- */
async function loadMethod() {
  if (!status) await loadStatus();
  if (status) {
    $("mModel").textContent = status.model;
    const kv = $("mConfig"); kv.replaceChildren();
    [["Device", status.device], ["Score type", status.calibrated ? `temperature-calibrated (T=${status.temperature.toFixed(3)})` : "raw softmax (uncalibrated)"],
     ["Human band", `below ${status.bands.human_below * 100}%`], ["AI band", `above ${status.bands.ai_above * 100}%`],
     ["Minimum length", `${status.min_words} words`], ["Window", "3 sentences"]].forEach(([k, v]) => {
      const d = el("div"); d.appendChild(el("dt", null, k)); d.appendChild(el("dd", null, v)); kv.appendChild(d); });
  }
  const eb = $("evalBody"); eb.replaceChildren();
  try {
    const m = await api("/api/evaluation");
    if (!m.available) throw new Error("none");
    eb.className = ""; eb.appendChild(renderEval(m));
  } catch (e) {
    eb.className = "small muted";
    eb.textContent = "No evaluation has been run yet. Run evaluation/evaluate.py to generate measured results; nothing is shown here until real numbers exist.";
  }
}
function renderEval(m) {
  const wrap = el("div");
  const t = el("table", "eval-table"); const head = el("tr");
  ["Dataset", "n", "Accuracy", "Precision", "Recall", "F1", "ROC-AUC"].forEach((h) => head.appendChild(el("th", null, h)));
  t.appendChild(head);
  (m.datasets || []).forEach((d) => {
    const tr = el("tr");
    [d.name, d.n, ...["accuracy", "precision", "recall", "f1", "roc_auc"].map((k) => (d[k] == null ? "-" : (d[k] * 100).toFixed(1) + "%"))].forEach((v) => tr.appendChild(el("td", null, String(v))));
    t.appendChild(tr);
  });
  wrap.appendChild(t);
  const lines = [];
  if (m.saturated_share != null) lines.push(`${(m.saturated_share * 100).toFixed(0)}% of scores fall below 2% or above 98%: the output is close to binary, so a score is not a graded confidence.`);
  const c = m.calibration;
  if (c) lines.push(`Temperature scaling (T=${c.temperature.toFixed(1)}) would cut held-out calibration error from ${c.heldout_raw.ece.toFixed(2)} to ${c.heldout_calibrated.ece.toFixed(2)}, but it was fitted on out-of-domain data and is therefore not applied; the app shows raw scores.`);
  const st = m.short_text_stress;
  if (st) lines.push(`Using only the first ${st.first_N_words} words of each text lowered ROC-AUC from ${(st.full_text.roc_auc * 100).toFixed(0)}% to ${(st.truncated.roc_auc * 100).toFixed(0)}%.`);
  if (m.notes) lines.push(m.notes);
  lines.forEach((l) => wrap.appendChild(el("p", "small muted", l)));
  return wrap;
}

/* ---------------- init ---------------- */
loadStatus().then(updateWords);
show(location.hash.slice(1) || "analyze");
updateWords();
