// Batch Analysis, History (search/filter/sort/paginate/delete), Analytics vs the database, empty DB.
// Run through tests/e2e/run_e2e.ps1 (it prepares fixtures, a scratch database and the server). Needs Node 22+ and Google Chrome.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SP = process.argv[2], BASE = "http://127.0.0.1:8791", PORT = 9334;
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${SP}/chrome-e2e4`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
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
// Transient evaluate errors while a page is loading or re-rendering (e.g. document.body not ready right after navigation) are retried until the timeout.
const waitFor = async (expr, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (_) { /* page not ready yet: retry */ } await sleep(250); } throw new Error("timeout waiting for: " + expr); };
const shot = async (name, sel) => { if (sel) { await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:"start"})`); await sleep(400); } const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${SP}/${name}.png`, Buffer.from(r.result.data, "base64")); };
// Re-open a route via the router's synchronous "not found" page (#/blank) instead of #/dashboard, so a slow earlier page render cannot finish late and overwrite the target.
const go = async (hash) => { if ((await ev("location.hash")) === hash) { await ev("location.hash = '#/blank'"); await sleep(400); } await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(700); };
const click = (txt, sel = "button, a.btn") => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim().includes(${JSON.stringify(txt)})).click()`);
const api = async (p, o) => (await fetch(BASE + p, o)).json();
const setFiles = async (paths, sel) => { const doc = await send("DOM.getDocument"); const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: sel }); await send("DOM.setFileInputFiles", { files: paths, nodeId: q.result.nodeId }); await sleep(600); };
const setSelect = (matchValue, value) => ev(`(() => { const s=[...document.querySelectorAll('.filters select')].find(x=>[...x.options].some(o=>o.value===${JSON.stringify(matchValue)})); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail); };

await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Page.navigate", { url: BASE + "/#/history" });

// ===== EMPTY DATABASE =====
await waitFor("document.body.innerText.includes('No analyses yet')");
check("empty DB: history empty state", await ev("!!document.querySelector('.state .btn')"));
await go("#/analytics"); await waitFor("document.body.innerText.includes('No data to analyse yet')");
check("empty DB: analytics empty state, no charts, no fake data", await ev("document.body.innerText.includes('Nothing here is sample data') && !document.querySelector('svg.chart')"));
await go("#/batch"); await waitFor("document.body.innerText.includes('No batches yet')");
check("empty DB: no previous batches", true);
await shot("s4-empty-batch");

// ===== BATCH: mixed valid / invalid =====
writeFileSync(`${SP}/short.txt`, "far too short for the detector");
const paths = ["sample.txt", "sample.md", "sample.docx", "guide.pdf", "short.txt", "bad.exe", "empty.txt", "corrupt.pdf", "big.txt"].map((f) => `${SP}/${f}`);
await setFiles(paths, "#batchFiles");
check("batch: 9 files listed", (await ev("document.querySelectorAll('.file-list .file-card').length")) === 9);
const line = await ev("[...document.querySelectorAll('[role=status]')].map(e=>e.textContent).find(t=>t.includes('selected'))");
check("batch: counts line", line === "9 selected · 6 ready · 3 rejected", line);
const rej = await ev("[...document.querySelectorAll('.file-card.rejected')].map(c => c.querySelector('.title').textContent + ': ' + c.querySelector('.err-text').textContent)");
check("batch: rejected files show reasons", rej.length === 3 && rej.every((r) => r.length > 15), rej.join(" | "));
await shot("s4-batch-selected");
await ev("document.querySelector('.text-in').value = 'E2E batch'");
await click("Analyse batch");
await sleep(500);
check("batch: processing state shown", await ev("!!document.querySelector('.working') || document.body.innerText.includes('Individual results')"));
await waitFor("document.body.innerText.includes('Individual results')");
await sleep(500);
const batchId = new URLSearchParams((await ev("location.hash")).split("?")[1]).get("id");
const b = await api(`/api/batch/${batchId}`);
check("batch: permalink set in URL", !!batchId);
check("batch: 6 files sent, 3 rejected before upload", b.files === 6, `files=${b.files}`);
const cards = await ev("[...document.querySelectorAll('.stat .stat-value')].map(s => s.textContent)");
check("batch: stat cards == API summary", cards[0] == b.files && cards[1] == b.summary.documents && cards[2] == b.summary.failed_files, JSON.stringify(cards));
const rows = await ev("[...document.querySelectorAll('.ptable tbody tr')].map(r => [...r.children].map(c => c.innerText.trim().replace(/\\n/g,' ')))");
check("batch: one row per file", rows.length === 6, String(rows.length));
const statusByName = Object.fromEntries(rows.map((r) => [r[1].split(" ")[0], r[2]]));
check("batch: statuses correct", statusByName["sample.txt"] === "Scored" && statusByName["guide.pdf"] === "Scored" && statusByName["short.txt"] === "Too short" && statusByName["corrupt.pdf"] === "Failed", JSON.stringify(statusByName));
const apiScores = Object.fromEntries(b.items.filter((i) => i.overall_score != null).map((i) => [i.filename, Math.round(i.overall_score * 100) + "%"]));
const uiScores = Object.fromEntries(rows.filter((r) => /\d+%$/.test(r[4])).map((r) => [r[1].split(" ")[0], r[4].match(/(\d+%)$/)[1]]));
check("batch: per-file scores on screen == backend", JSON.stringify(apiScores) === JSON.stringify(uiScores), JSON.stringify(uiScores) + " vs " + JSON.stringify(apiScores));
check("batch: skipped (client-rejected) files listed", await ev("document.body.innerText.includes('Not uploaded') && document.body.innerText.includes('bad.exe')"));
check("batch: server failure reason shown", await ev("!!document.querySelector('.ptable .err-text')?.textContent.includes('Could not read the PDF')"));
await shot("s4-batch-result");
await click("Highest score first");
const order = (await ev("[...document.querySelectorAll('.ptable tbody tr')].map(r => parseFloat(r.children[4].innerText))")).filter((x) => !Number.isNaN(x));
check("batch: sort by highest score", order.length > 1 && order.every((v, i) => i === 0 || order[i - 1] >= v), order.join(","));
await click("Open", "a.btn");
await waitFor("document.body.innerText.includes('Overall analysis')");
check("batch -> Document Intelligence navigation", (await ev("location.hash")).startsWith("#/intelligence?id="));
await go("#/batch"); await waitFor("document.querySelector('a.pick')");
check("previous batches list shows the batch", (await ev("document.querySelector('a.pick .title').textContent")) === "E2E batch");
await ev("document.querySelector('a.pick').click()"); await waitFor("document.body.innerText.includes('Individual results')");
check("previous batch opens from the list", await ev("location.hash.startsWith('#/batch?id=')"));
await go("#/batch?id=nonexistent"); await waitFor("document.body.innerText.includes('Batch not found')");
check("unknown batch -> error state", true);

// ===== seed more analyses for pagination =====
for (let i = 1; i <= 14; i++) await api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: `Seed doc ${String(i).padStart(2, "0")}`, text: i % 2 ? "too short to be scored here" : "tiny" }) });
const total = (await api("/api/history/search?limit=1")).total;

// ===== HISTORY =====
await go("#/history"); await waitFor("document.querySelectorAll('tr.hrow').length > 0");
check("history: 10 rows on page 1", (await ev("document.querySelectorAll('tr.hrow').length")) === 10);
check("history: footer shows total", await ev(`document.querySelector('.pagination').innerText.includes('of ${total}')`), await ev("document.querySelector('.pagination .muted').textContent"));
await ev("[...document.querySelectorAll('.pg')].find(b => b.textContent === '2').click()"); await sleep(900);
const p2 = await ev("document.querySelectorAll('tr.hrow').length");
check("history: page 2 shows the remainder", p2 === Math.min(10, total - 10), `rows=${p2} total=${total}`);
check("history: URL keeps page", (await ev("location.hash")).includes("page=2"));
await ev("(() => { const i=document.querySelector('.filters input[type=search]'); i.value='Seed doc 0'; i.dispatchEvent(new Event('input')); })()"); await sleep(1300);
const found = await ev("[...document.querySelectorAll('tr.hrow .title')].map(t => t.textContent)");
check("history: search by name", found.length === 9 && found.every((t) => t.startsWith("Seed doc 0")), found.join(","));
const hh = await ev("location.hash");
check("history: search resets to page 1 and is in the URL", hh.includes("q=Seed") && !hh.includes("page="), hh);
await setSelect("oldest", "oldest"); await sleep(900);
const oldest = await ev("[...document.querySelectorAll('tr.hrow .title')].map(t => t.textContent)");
check("history: sort oldest first", oldest[0] === "Seed doc 01" && oldest[oldest.length - 1] === "Seed doc 09", oldest.join(","));
await click("Clear filters"); await sleep(900);
await setSelect("likely_ai", "likely_ai"); await sleep(900);
const ai = await api("/api/history/search?verdict=likely_ai&limit=50");
const aiRows = await ev("[...document.querySelectorAll('tr.hrow')].length");
check("history: verdict filter == API", aiRows === Math.min(10, ai.total), `rows ${aiRows} api ${ai.total}`);
await click("Clear filters"); await sleep(800);
await setSelect("pdf", "pdf"); await sleep(900);
const pdfApi = await api("/api/history/search?source=pdf");
check("history: source filter == API", (await ev("document.querySelectorAll('tr.hrow').length")) === pdfApi.total, `api ${pdfApi.total}`);
await click("Clear filters"); await sleep(800);
await ev("(() => { const i=document.querySelectorAll('.filters input[type=date]')[0]; i.value='2099-01-01'; i.dispatchEvent(new Event('change')); })()"); await sleep(900);
check("history: no-match empty state with clear button", await ev("document.body.innerText.includes('No analyses match these filters') && !!document.querySelector('.state .btn')"));
await click("Clear filters", ".state .btn"); await sleep(900);
check("history: clearing restores results", (await ev("document.querySelectorAll('tr.hrow').length")) === 10);
await setSelect("score_desc", "score_desc"); await sleep(900);
const sc = await ev("[...document.querySelectorAll('tr.hrow .sc-cell b')].map(b=>parseFloat(b.textContent))");
check("history: sort by score descending", sc.length > 1 && sc.every((v, i) => i === 0 || sc[i - 1] >= v), sc.join(","));
const hashNow = await ev("location.hash");
await send("Page.navigate", { url: BASE + "/" + hashNow }); await waitFor("document.querySelectorAll('tr.hrow').length > 0");
check("history: filters survive a reload", await ev("[...document.querySelectorAll('.filters select')].some(s => s.value==='score_desc')"));
await ev("document.getElementById('searchInput').value='Seed doc 14'; document.getElementById('searchForm').dispatchEvent(new Event('submit',{cancelable:true}))"); await sleep(1400);
check("header search opens History filtered", (await ev("[...document.querySelectorAll('tr.hrow .title')].map(t=>t.textContent).join()")) === "Seed doc 14");
const before = (await api("/api/history/search?limit=1")).total;
await ev("document.querySelector('tr.hrow .btn-danger-ghost').click()"); await waitFor("!!document.querySelector('.modal')");
check("delete: confirmation dialog shown", await ev("document.querySelector('.modal h3').textContent.includes('Delete')"));
await shot("s4-history-delete-dialog");
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(500);
check("delete: Escape cancels (nothing deleted)", !(await ev("!!document.querySelector('.modal')")) && (await api("/api/history/search?limit=1")).total === before);
await ev("document.querySelector('tr.hrow .btn-danger-ghost').click()"); await waitFor("!!document.querySelector('.modal')");
await click("Delete", ".modal .btn-danger"); await sleep(1300);
check("delete: confirmed removes it from the database", (await api("/api/history/search?limit=1")).total === before - 1);
check("delete: row gone from the table", (await ev("document.querySelectorAll('tr.hrow').length")) === 0);
await click("Clear filters"); await sleep(900);
await shot("s4-history");

// ===== ANALYTICS vs DATABASE =====
await go("#/analytics"); await waitFor("document.querySelectorAll('.stat').length >= 4 && document.querySelector('svg.chart')");
await sleep(700);
const st = await api("/api/stats"), bl = await api("/api/batch");
const vals = await ev("[...document.querySelectorAll('.stat .stat-value')].map(s => s.textContent)");
check("analytics: total analyses == DB", vals[0].replace(/,/g, "") == st.documents, `${vals[0]} vs ${st.documents}`);
check("analytics: scored == DB", vals[1].replace(/,/g, "") == st.scored, `${vals[1]} vs ${st.scored}`);
check("analytics: mean score == DB", vals[2] === (st.mean_score * 100).toFixed(1) + "%", vals[2]);
check("analytics: batch performance count == batch API", (await ev("[...document.querySelectorAll('.mini-stat b')][0]?.textContent")) === String(bl.length));
const legendVals = await ev("[...document.querySelectorAll('.legend b')].slice(0,3).map(b => +b.textContent)");
check("analytics: verdict donut legend == DB", JSON.stringify(legendVals) === JSON.stringify([st.verdicts.likely_human, st.verdicts.uncertain, st.verdicts.likely_ai]), legendVals.join(","));
check("analytics: thin-data warning shown when few scored docs", st.scored >= 5 || (await ev("document.body.innerText.includes('Distributions and trends need more data')")));
await shot("s4-analytics");
await ev("(() => { const s=document.querySelector('.analytics-filters select'); s.value='pdf'; s.dispatchEvent(new Event('change')); })()"); await sleep(1300);
const stPdf = await api("/api/stats?source=pdf");
check("analytics: source filter == API", (await ev("document.querySelector('.stat .stat-value').textContent")).replace(/,/g, "") == stPdf.documents, String(stPdf.documents));
await ev("(() => { const s=document.querySelector('.analytics-filters select'); s.value=''; s.dispatchEvent(new Event('change')); })()"); await sleep(900);
await click("Custom"); await sleep(300);
await ev("(() => { const i=document.querySelectorAll('.custom-range input'); i[0].value='2099-01-01'; i[0].dispatchEvent(new Event('change')); })()"); await sleep(1100);
check("analytics: empty selection explained", await ev("document.body.innerText.includes('No analyses in this selection') && document.body.innerText.includes('in total')"));
await click("Show all time", ".state .btn"); await sleep(1100);
check("analytics: recovers via 'Show all time'", (await ev("document.querySelectorAll('.stat').length")) >= 4);
await click("Last 7 days"); await sleep(1100);
const iso = (d) => d.toISOString().slice(0, 10);
const st7 = await api(`/api/stats?date_from=${iso(new Date(Date.now() - 6 * 864e5))}&date_to=${iso(new Date())}`);
check("analytics: 'Last 7 days' == API", (await ev("document.querySelector('.stat .stat-value').textContent")).replace(/,/g, "") == st7.documents);

// ===== RESPONSIVE =====
for (const [name, w, hgt] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
  if (name === "mobile") await send("Emulation.setDeviceMetricsOverride", { width: w, height: hgt, deviceScaleFactor: 2, mobile: true });
  for (const route of ["#/batch", "#/history", "#/analytics"]) {
    await go(route); await sleep(1800);
    check(`${name}: ${route} has no horizontal page overflow`, await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"));
    if (name === "mobile") await shot(`s4-mobile-${route.slice(2)}`);
  }
}
await go("#/batch?id=" + batchId); await sleep(1600);
check("mobile: batch detail has no overflow", await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"));
await shot("s4-mobile-batch-detail");
await send("Emulation.clearDeviceMetricsOverride");
check("no console errors / exceptions", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 400));
writeFileSync(`${SP}/e2e4-results.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close(); chrome.kill(); process.exit(results.some((r) => !r.ok) ? 1 : 0);
