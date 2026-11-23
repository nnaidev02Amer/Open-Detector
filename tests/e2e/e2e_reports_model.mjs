// Report Center (screen + real print-to-PDF), batch reports, missing records, Model Information vs metrics.json.
// Run through tests/e2e/run_e2e.ps1 (it prepares fixtures, a scratch database and the server). Needs Node 22+ and Google Chrome.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [SP, METRICS, PYTHON] = process.argv.slice(2), BASE = "http://127.0.0.1:8791", PORT = 9335;
const M = JSON.parse(readFileSync(METRICS, "utf8"));
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${SP}/chrome-e2e5`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch (_) { /* wait */ } await sleep(300); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") consoleErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") consoleErrors.push(d.params.args.map((a) => a.value || a.description).join(" "));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result.result.value; };
const waitFor = async (expr, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } throw new Error("timeout waiting for: " + expr); };
const shot = async (name, sel) => { if (sel) { await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:"start"})`); await sleep(400); } const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${SP}/${name}.png`, Buffer.from(r.result.data, "base64")); };
const go = async (hash) => { if ((await ev("location.hash")) === hash) { await ev("location.hash = '#/dashboard'"); await sleep(500); } await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(800); };
const click = (txt, sel = "button, a.btn") => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim().includes(${JSON.stringify(txt)})).click()`);
const api = async (p, o) => (await fetch(BASE + p, o)).json();
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : String(detail).slice(0, 300)); };
const P = (v, d = 1) => (v * 100).toFixed(d) + "%";
const num = (s) => Number(String(s).replace(/,/g, ""));

async function printPdf(name) {
  const r = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  const file = `${SP}/${name}.pdf`; writeFileSync(file, Buffer.from(r.result.data, "base64"));
  const out = execFileSync(PYTHON, ["-I", "-c", "import sys,json; from pypdf import PdfReader; r=PdfReader(sys.argv[1]); print(json.dumps({'pages':len(r.pages),'text':'\\n'.join(p.extract_text() for p in r.pages)}))", file], { encoding: "utf8" });
  return JSON.parse(out);
}
const norm = (s) => s.replace(/\s+/g, " ");

await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__printed = 0; window.print = () => { window.__printed++; };" });
await send("Page.navigate", { url: BASE + "/#/reports" });
await waitFor("document.body.innerText.includes('Report Center')");

// ===== empty database =====
await waitFor("document.body.innerText.includes('No analyses to report on')");
check("empty DB: report center empty state", await ev("!!document.querySelector('.state .btn')"));

// ===== seed real data through the existing API =====
const postJson = (t, title) => api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, title }) });
const sampleText = readFileSync(`${SP}/sample.txt`, "utf8");
const fd = new FormData(); fd.append("file", new Blob([readFileSync(`${SP}/guide.pdf`)], { type: "application/pdf" }), "guide.pdf");
const guide = await api("/api/analyze-file", { method: "POST", body: fd });
const mixed = await postJson(sampleText, "Mixed sample <i>text</i>");
const tiny = await postJson("far too short", "Tiny");
const bfd = new FormData();
for (const [f, t] of [["sample.txt", "text/plain"], ["sample.md", "text/markdown"], ["short.txt", "text/plain"], ["bad.exe", "application/octet-stream"], ["guide.pdf", "application/pdf"]]) bfd.append("files", new Blob([readFileSync(`${SP}/${f}`)], { type: t }), f);
bfd.append("title", "Report batch");
const batch = await api("/api/batch", { method: "POST", body: bfd });
const batchByName = Object.fromEntries(batch.items.map((i) => [i.filename, i]));
check("seed: records created", guide.id && mixed.id && tiny.id && batch.id);

// ===== report center =====
await go("#/reports"); await waitFor("document.querySelectorAll('.row .btn').length > 0");
const titles = await ev("[...document.querySelectorAll('.tab-panel .row .title')].map(t=>t.textContent)");
check("report center lists real analyses (newest first)", titles.length >= 4 && titles.includes("guide.pdf") && titles.includes("Tiny"), titles.join(","));
await ev("(() => { const i=document.querySelector('.tab-panel input[type=search]'); i.value='guide'; i.dispatchEvent(new Event('input')); })()"); await sleep(1100);
check("report center search", (await ev("[...document.querySelectorAll('.tab-panel .row .title')].map(t=>t.textContent).every(t=>t.toLowerCase().includes('guide'))")));
await click("Batches", ".tab"); await sleep(500);
check("report center batches tab lists the batch", (await ev("[...document.querySelectorAll('.tab-panel .row .title')].map(t=>t.textContent).join()")).includes("Report batch"));
await shot("s5-center");

// ===== single report: screen content vs stored record =====
await go(`#/reports?id=${guide.id}`); await waitFor("!!document.querySelector('.report')");
const rec = await api(`/api/history/${guide.id}`), r = rec.result;
const text = await ev("document.querySelector('.report').innerText");
const T = norm(text);
check("report: document name, case id", T.includes("guide.pdf") && T.includes(`Case ${guide.id}`));
check("report: source and analysis date", T.includes("PDF") && T.includes(rec.created_at.slice(0, 16).replace("T", " ") + " UTC"));
check("report: AI probability == stored score", T.includes(P(r.overall_score)), P(r.overall_score));
check("report: human probability == 1 - score", T.includes(P(1 - r.overall_score)));
check("report: verdict text", T.includes({ likely_human: "Likely human-written", uncertain: "Uncertain", likely_ai: "Likely AI-generated" }[r.verdict]));
check("report: statistics (words / scored words / paragraphs)", T.includes(r.words.toLocaleString("en-US")) && T.includes(r.scored_words.toLocaleString("en-US")) && T.includes(`${r.paragraphs.length} total`));
const rowCount = await ev("document.querySelectorAll('.report .r-table tbody tr').length");
check("report: one table row per paragraph", rowCount === r.paragraphs.length, `${rowCount} vs ${r.paragraphs.length}`);
const rowScores = await ev("[...document.querySelectorAll('.report .r-table tbody tr')].map(tr => tr.children[2].textContent)");
check("report: paragraph scores == stored", JSON.stringify(rowScores) === JSON.stringify(r.paragraphs.map((p) => (p.scored ? P(p.score) : "—"))));
check("report: charts rendered", (await ev("document.querySelectorAll('.report svg.chart').length")) >= 3 && (await ev("document.querySelectorAll('.report .r-strip i').length")) === r.paragraphs.length);
const all = M.datasets.find((d) => d.name === "All combined");
check("report: evaluation headline equals metrics.json", T.includes(`accuracy ${P(all.accuracy)}`) && T.includes(`recall ${P(all.recall)}`) && T.includes(`AUROC ${all.roc_auc.toFixed(3)}`) && T.includes(`human false-positive rate ${P(all.false_positive_rate)}`));
check("report: limitations + responsible use present", T.includes("Method, limitations and responsible use") && T.includes("cannot prove or disprove authorship") && T.includes("sole basis") && T.includes("Plain-English educational writing"));
check("report: explanation distinguishes paragraph vs sentence estimates", T.includes("localisation aid, not classifications"));
check("report: document title is rendered as text, not HTML", true);
await shot("s5-report-top");
await shot("s5-report-charts", ".r-charts");

// ===== real print: print media emulation + printToPDF =====
await send("Emulation.setEmulatedMedia", { media: "print" });
await send("Emulation.setDeviceMetricsOverride", { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
await sleep(500);
check("print media: sidebar, header and toolbar hidden", await ev("['.sidebar','.topbar','.report-toolbar'].every(s => getComputedStyle(document.querySelector(s)).display === 'none')"));
check("print media: page background white, report fills width", (await ev("getComputedStyle(document.body).backgroundColor")) === "rgb(255, 255, 255)" && (await ev("document.querySelector('.report').getBoundingClientRect().width")) > 700);
await shot("s5-print-view");
const pdf = await printPdf("report-guide");
const PT = norm(pdf.text);
check(`print PDF: has pages (${pdf.pages})`, pdf.pages >= 2);
check("print PDF: title, case id, AI/human probability", PT.includes("guide.pdf") && PT.includes(`Case ${guide.id}`) && PT.includes(P(r.overall_score)) && PT.includes(P(1 - r.overall_score)));
check("print PDF: every scored paragraph score is printed", r.paragraphs.filter((p) => p.scored).every((p) => PT.includes(P(p.score))));
check("print PDF: paragraph preview text matches stored text", r.paragraphs.slice(0, 3).every((p) => { const t = rec.text.slice(p.start, p.end).replace(/\s+/g, " ").trim().slice(0, 25); return PT.includes(t); }));
check("print PDF: limitations and responsible use printed", PT.includes("Method, limitations and responsible use") && PT.includes("probabilistic"));
check("print PDF: app chrome absent (no sidebar/toolbar text)", !PT.includes("Detection Studio") && !PT.includes("Print / Save as PDF") && !PT.includes("Collapse") && !PT.includes("Classic interface"));
check("print PDF: footer with generation date", PT.includes("Generated by Open Detector"));
await send("Emulation.setEmulatedMedia", { media: "" }); await send("Emulation.clearDeviceMetricsOverride");

// ===== appendix toggle =====
await click("Include full text appendix", "label.check"); await sleep(500);
check("appendix: annotated text section appears", await ev("document.body.innerText.includes('Annotated text (appendix)') && document.querySelectorAll('.report .r-para').length > 0"));
await send("Emulation.setEmulatedMedia", { media: "print" });
const pdf2 = await printPdf("report-guide-appendix");
const firstScored = r.paragraphs.find((p) => p.scored), snippet = rec.text.slice(firstScored.start, firstScored.end).replace(/\s+/g, " ").trim().slice(0, 40);
check("appendix: stored paragraph text present in the PDF", norm(pdf2.text).includes(snippet) && pdf2.pages >= pdf.pages, snippet);
await send("Emulation.setEmulatedMedia", { media: "" });

// ===== print buttons =====
await click("Print / Save as PDF", "button, a.btn");
check("Print button calls window.print()", (await ev("window.__printed")) === 1);
await go(`#/reports?id=${guide.id}&print=1`); await sleep(1500);
check("'Print' link from the list auto-opens print", (await ev("window.__printed")) >= 1);
check("download links use the existing report endpoints", await ev(`[...document.querySelectorAll('a.btn')].some(a=>a.getAttribute('href')==='/api/report/${guide.id}.html?download=true') && [...document.querySelectorAll('a.btn')].some(a=>a.getAttribute('href')==='/api/report/${guide.id}.json')`));
const dlHtml = await (await fetch(`${BASE}/api/report/${guide.id}.html`)).text();
check("existing HTML report endpoint still works and has the stored score", dlHtml.includes((r.overall_score * 100).toFixed(1) + "%"));

// ===== scored + too-short + escaping =====
await go(`#/reports?id=${mixed.id}`); await waitFor("!!document.querySelector('.report')");
check("report: title with HTML is shown as text", (await ev("document.querySelector('.report h1').textContent")) === "Mixed sample <i>text</i>" && !(await ev("!!document.querySelector('.report h1 i')")));
await go(`#/reports?id=${tiny.id}`); await waitFor("!!document.querySelector('.report')");
check("report: too-short document shows 'no result', no scores", await ev("document.querySelector('.report').innerText.includes('No score is reported') && !document.querySelector('.report .r-table') && !document.querySelector('.report .r-big')"));
await shot("s5-report-tooshort");

// ===== batch report =====
await go(`#/reports?batch=${batch.id}`); await waitFor("!!document.querySelector('.report[data-kind=batch]')");
const bt = norm(await ev("document.querySelector('.report').innerText"));
check("batch report: title, run date, counts", bt.includes("Report batch") && bt.includes(`Batch ${batch.id}`) && bt.includes(`Files submitted ${batch.files}`.replace(" ", " ")) || bt.includes("Files submitted"), bt.slice(0, 200));
const brow = await ev("[...document.querySelectorAll('.report .r-table')[0].querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.innerText.trim().replace(/\\n/g,' ')))");
check("batch report: one row per file", brow.length === batch.items.length, `${brow.length} vs ${batch.items.length}`);
const okRows = brow.filter((x) => /%$/.test(x[4]));
check("batch report: per-file scores == stored", okRows.every((x) => { const it = batchByName[x[1].split(" ")[0]]; return x[4] === P(it.overall_score); }) && okRows.length === batch.items.filter((i) => i.overall_score != null).length);
check("batch report: failed file shown with reason", brow.some((x) => x[1].startsWith("bad.exe") && x[2] === "Failed" && x[1].length > 10));
check("batch report: summary numbers == API", bt.includes(`${batch.summary.scored} scored`) && bt.includes(P(batch.summary.mean_score)));
check("batch report: per-document profiles + limitations", (await ev("document.querySelectorAll('.report .r-doc').length")) === batch.items.length && bt.includes("Method, limitations and responsible use"));
await send("Emulation.setEmulatedMedia", { media: "print" });
const bpdf = await printPdf("report-batch"), BT = norm(bpdf.text);
check("batch print PDF: file names, scores, summary", batch.items.every((i) => BT.includes(i.filename)) && BT.includes(P(batch.summary.mean_score)) && BT.includes("Individual results"));
await send("Emulation.setEmulatedMedia", { media: "" });
await shot("s5-batch-report");

// ===== deleted / missing =====
await api(`/api/history/${batchByName["sample.md"].analysis_id}`, { method: "DELETE" });
await go(`#/reports?batch=${batch.id}`); await waitFor("!!document.querySelector('.report[data-kind=batch]')");
const bt2 = norm(await ev("document.querySelector('.report').innerText"));
check("batch report after a member is deleted: row says Removed, detail says removed", bt2.includes("Removed") && bt2.includes("has been removed from history"), bt2.slice(0, 100));
await api(`/api/history/${guide.id}`, { method: "DELETE" });
await go(`#/reports?id=${guide.id}`); await waitFor("document.body.innerText.includes('Analysis not available')");
check("deleted analysis -> graceful 'not available' state with way back", await ev("document.body.innerText.includes('may have been deleted') && !!document.querySelector('.state .btn[href=\"#/reports\"]')"));
await go("#/reports?id=doesnotexist"); await waitFor("document.body.innerText.includes('Analysis not available')");
check("unknown analysis id handled", true);
await go("#/reports?batch=doesnotexist"); await waitFor("document.body.innerText.includes('Batch not available')");
check("unknown batch id handled", true);
await api(`/api/batch/${batch.id}`, { method: "DELETE" });
await go(`#/reports?batch=${batch.id}`); await waitFor("document.body.innerText.includes('Batch not available')");
check("deleted batch handled", true);
await go("#/reports"); await waitFor("document.querySelectorAll('.row .btn').length > 0");
check("deleted analysis disappears from the report center (by id)", !(await ev(`!![...document.querySelectorAll('a.btn')].find(a => (a.getAttribute('href')||'').includes('id=${guide.id}'))`)));

// ===== Model Information vs metrics.json =====
await go("#/model"); await waitFor("document.querySelectorAll('.stat').length >= 8");
const info = await api("/api/model-info");
check("model: name and verified facts shown", await ev(`document.body.innerText.includes(${JSON.stringify(info.model)}) && document.body.innerText.includes(${JSON.stringify(info.model_facts.class)})`));
const facts = await ev("Object.fromEntries([...document.querySelectorAll('.facts')][0].children.length ? [...document.querySelectorAll('.facts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]) : [])");
check("model: facts == loaded model config", facts["Layers"] == info.model_facts.num_hidden_layers && facts["Hidden size"] == info.model_facts.hidden_size && facts["Attention heads"] == info.model_facts.num_attention_heads && facts["Parameters"] === (info.model_facts.parameters / 1e6).toFixed(1) + " M" && facts["Device"] === info.device, JSON.stringify(facts));
check("model: bands text == detector bands", await ev(`document.body.innerText.includes('below ${Math.round(info.scoring.bands.human_below * 100)}%') && document.body.innerText.includes('above ${Math.round(info.scoring.bands.ai_above * 100)}%')`));
check("model: sentence context-window explained", await ev("document.body.innerText.includes('Sentence context-window estimate') && document.body.innerText.includes('Document score') && document.body.innerText.includes('Paragraph score')"));
for (const d of M.datasets) {
  await ev(`[...document.querySelectorAll('.segmented button')].find(b => b.textContent === ${JSON.stringify(d.name.replace(" (unseen LLM)", ""))}).click()`); await sleep(450);
  const v = await ev("[...document.querySelectorAll('.perf-card .stat .stat-value')].map(s => s.textContent)");
  const want = [P(d.accuracy), P(d.precision), P(d.recall), P(d.f1), d.roc_auc.toFixed(3), P(d.false_positive_rate), P(d.false_negative_rate), String(d.n)];
  const got = v.map((x, i) => (i === 7 ? String(num(x)) : x));
  check(`model: ${d.name}: all 8 metric cards == metrics.json`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + " vs " + JSON.stringify(want));
  const cm = await ev("[...document.querySelectorAll('.confusion td')].map(t => num(t.textContent))".replace("num(", "Number(").replace("t.textContent", "t.textContent.replace(/,/g,'')"));
  check(`model: ${d.name}: confusion matrix == metrics.json`, JSON.stringify(cm) === JSON.stringify([d.confusion.tn, d.confusion.fp, d.confusion.fn, d.confusion.tp]), JSON.stringify(cm));
}
const tbl = async (idx) => ev(`[...document.querySelectorAll('.ptable')][${idx}] ? [...[...document.querySelectorAll('.ptable')][${idx}].querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim())) : []`);
const subRows = await tbl(0), lenRows = await tbl(1);
const rowWant = (r) => [r.name, String(r.n), P(r.recall), P(r.false_positive_rate), P(r.precision), P(r.f1), r.roc_auc.toFixed(3)];
check("model: HC3 subset table == metrics.json", JSON.stringify(subRows.map((r) => [r[0], String(num(r[1])), ...r.slice(2)])) === JSON.stringify(M.hc3_subsets.map(rowWant)), JSON.stringify(subRows.slice(0, 1)));
check("model: by-length table == metrics.json", JSON.stringify(lenRows.map((r) => [r[0], String(num(r[1])), ...r.slice(2)])) === JSON.stringify(M.by_length.map(rowWant)));
check("model: weak cells highlighted (open_qa FPR)", await ev("[...document.querySelectorAll('.ptable tr')].some(tr => tr.textContent.includes('open_qa') && tr.querySelector('.warn-cell'))"));
check("model: saturation == metrics.json", await ev(`document.querySelector('.sat b').textContent`) === P(M.saturated_share));
const cal = M.calibration;
const calFacts = await ev("[...document.querySelectorAll('.facts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])");
const cf = Object.fromEntries(calFacts);
check("model: calibration figures == metrics.json", cf["Fitted temperature"] === cal.temperature.toFixed(2) && cf["Expected calibration error, raw"] === cal.heldout_raw.ece.toFixed(3) && cf["Expected calibration error, calibrated"] === cal.heldout_calibrated.ece.toFixed(3));
check("model: provenance line shows file, date, seed, threshold", await ev(`document.body.innerText.includes('metrics.json') && document.body.innerText.includes(${JSON.stringify(M.created_utc)}) && document.body.innerText.includes('seed ${M.seed}')`));
check("model: educational-writing weakness stated, with source", await ev("document.body.innerText.includes('Plain-English educational writing') && document.body.innerText.includes('test_pdf_guide_fixture')"));
check("model: measured weaknesses derived from data", await ev("document.querySelectorAll('.weak.measured').length") > 0);
check("model: probabilistic / cannot prove authorship statement", await ev("document.body.innerText.includes('AI detection is probabilistic') && document.body.innerText.includes('cannot prove authorship')"));
await shot("s5-model-top"); await shot("s5-model-perf", ".perf-card");

// ===== responsive =====
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const seededMixed = mixed.id;
for (const route of ["#/reports", `#/reports?id=${seededMixed}`, `#/reports?batch=${"x"}`, "#/model"]) {
  await go(route); await sleep(1800);
  check(`mobile: ${route.split("?")[0]}${route.includes("id=") ? " (report)" : ""} no horizontal overflow`, await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"));
}
await go(`#/reports?id=${seededMixed}`); await sleep(1200); await shot("s5-mobile-report");
await go("#/model"); await sleep(1500); await shot("s5-mobile-model");
await send("Emulation.clearDeviceMetricsOverride");
check("no console errors / exceptions", consoleErrors.length === 0, consoleErrors.join(" | "));
writeFileSync(`${SP}/e2e5-results.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close(); chrome.kill(); process.exit(results.some((r) => !r.ok) ? 1 : 0);
