// Detection Studio + Document Intelligence: paste, TXT/MD/DOCX/PDF uploads, validation, mobile, drawer.
// Run through tests/e2e/run_e2e.ps1 (it prepares fixtures, a scratch database and the server). Needs Node 22+ and Google Chrome.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SP = process.argv[2], BASE = "http://127.0.0.1:8791", PORT = 9333;
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${SP}/chrome-e2e`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
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
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
const waitFor = async (expr, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } throw new Error("timeout waiting for: " + expr); };
const shot = async (name, sel) => { if (sel) { await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:"start"})`); await sleep(500); } const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${SP}/${name}.png`, Buffer.from(r.result.data, "base64")); };
const go = async (hash) => { if (await ev("location.hash") === hash) { await ev("location.hash = '#/dashboard'"); await sleep(500); } await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(600); };
const setFile = async (path) => { const doc = await send("DOM.getDocument"); const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#studioFile" }); await send("DOM.setFileInputFiles", { files: [path], nodeId: q.result.nodeId }); await sleep(400); };
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail); };

await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Page.navigate", { url: BASE + "/#/studio" }); await waitFor("!!document.querySelector('#studioText')");

// ---- empty state / empty input
check("empty dashboard shows honest empty state", (await (async () => { await go("#/dashboard"); await waitFor("document.body.innerText.includes('No analyses yet')"); return await ev("document.body.innerText.includes('Nothing here is sample data')"); })()));
await go("#/studio"); await waitFor("!!document.querySelector('#studioText')");
await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
check("empty input -> error message", await ev("document.querySelector('.field-error:not([hidden])')?.textContent.includes('Paste some text')"));

// ---- counters + short text warning
await ev(`(()=>{const t=document.querySelector('#studioText'); t.value='only a handful of words here'; t.dispatchEvent(new Event('input'));})()`);
check("counters update", await ev("document.querySelector('.counters').innerText.includes('6 words') && document.querySelector('.counters .hint').textContent.includes('more words needed')"));
await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
await waitFor("document.querySelector('.result')");
check("short text -> no result state (not scored)", await ev("document.querySelector('.result .state h3')?.textContent.includes('No result')"), await ev("document.querySelector('.result')?.innerText.slice(0,120)"));

// ---- paste real text
const fs = await import("node:fs"); const aiText = fs.readFileSync(`${SP}/sample.txt`, "utf8");
await go("#/studio"); await waitFor("!!document.querySelector('#studioText')");
await ev(`(()=>{const t=document.querySelector('#studioText'); t.value=${JSON.stringify(aiText)}; t.dispatchEvent(new Event('input')); document.querySelector('.text-in').value='E2E paste';})()`);
await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
check("progress shown while running", await ev("!!document.querySelector('.working, .progress, .result')"));
await waitFor("document.querySelector('.result .result-main')");
await shot("e2e-studio-result");
const dom = await ev(`(()=>({ai: document.querySelector('.ai-t').textContent, human: document.querySelector('.human-t').textContent, badge: document.querySelector('.result .badge').textContent,
  href: [...document.querySelectorAll('a.btn')].find(a=>a.textContent.includes('Document Intelligence')).getAttribute('href')}))()`);
const recId = new URLSearchParams(dom.href.split("?")[1]).get("id");
const api = await (await fetch(`${BASE}/api/history/${recId}`)).json();
const s = api.result.overall_score;
check("AI probability on screen == backend score", dom.ai === (s * 100).toFixed(1) + "%", `${dom.ai} vs ${(s * 100).toFixed(1)}%`);
check("human probability == 1 - score", dom.human === ((1 - s) * 100).toFixed(1) + "%", dom.human);
check("verdict badge == backend verdict", dom.badge === { likely_human: "Likely human", uncertain: "Uncertain", likely_ai: "Likely AI" }[api.result.verdict], dom.badge);
check("saved with the typed title", api.title === "E2E paste");

// ---- uploads
const uploads = [["sample.txt", "txt"], ["sample.md", "txt"], ["sample.docx", "docx"], ["guide.pdf", "pdf"]];
const recs = {};
for (const [f, src] of uploads) {
  await go("#/studio"); await waitFor("!!document.querySelector('.tab')");
  await ev("[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Upload')).click()"); await waitFor("!!document.querySelector('#studioFile')");
  await setFile(`${SP}/${f}`);
  check(`${f}: file card shown`, await ev(`document.querySelector('.file-card .title')?.textContent === ${JSON.stringify(f)}`));
  await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
  await waitFor("document.querySelector('.result .result-main, .result .state')");
  const href = await ev("[...document.querySelectorAll('a.btn')].find(a=>a.textContent.includes('Document Intelligence')).getAttribute('href')");
  const rid = new URLSearchParams(href.split("?")[1]).get("id"); const rec = await (await fetch(`${BASE}/api/history/${rid}`)).json(); recs[f] = rec;
  check(`${f}: analysed, source=${src}`, rec.result.status === "ok" && rec.source === src, `score ${rec.result.overall_score?.toFixed(4)}`);
  const shown = await ev("document.querySelector('.ai-t').textContent");
  check(`${f}: screen == backend`, shown === (rec.result.overall_score * 100).toFixed(1) + "%", shown);
}
check("txt, md(+headings) both analysed", recs["sample.txt"].result.status === "ok" && recs["sample.md"].result.status === "ok");

// ---- invalid / empty / huge files (client-side validation)
for (const [f, expect] of [["bad.exe", "not supported"], ["empty.txt", "empty"], ["big.txt", "limit"]]) {
  await go("#/studio"); await waitFor("!!document.querySelector('.tab')");
  await ev("[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Upload')).click()"); await waitFor("!!document.querySelector('#studioFile')");
  await setFile(`${SP}/${f}`);
  check(`${f}: rejected with message`, await ev(`(document.querySelector('.field-error:not([hidden])')?.textContent||'').includes(${JSON.stringify(expect)}) && !document.querySelector('.file-card')`), await ev("document.querySelector('.field-error:not([hidden])')?.textContent"));
  await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
  check(`${f}: run blocked`, await ev("!document.querySelector('.result')"));
}
// server-side error surfaced in the UI: corrupt pdf passes the client check but fails on the server
writeFileSync(`${SP}/corrupt.pdf`, "%PDF-1.4 broken");
await go("#/studio"); await waitFor("!!document.querySelector('.tab')");
await ev("[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Upload')).click()"); await waitFor("!!document.querySelector('#studioFile')");
await setFile(`${SP}/corrupt.pdf`);
await ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Run analysis')).click()");
await waitFor("document.querySelector('.result .state.error')");
check("corrupt PDF -> server error shown with retry", await ev("document.querySelector('.result .state.error p')?.textContent.includes('Could not read the PDF') && !!document.querySelector('.result .state.error .btn')"));
await shot("e2e-studio-upload-error");

// ---- Document Intelligence on the guide PDF
const g = recs["guide.pdf"];
await go(`#/intelligence?id=${g.id}`); await waitFor("document.querySelectorAll('.para').length > 0");
const nPar = await ev("document.querySelectorAll('.para').length");
check("one block per backend paragraph", nPar === g.result.paragraphs.length, `${nPar} vs ${g.result.paragraphs.length}`);
const tags = await ev("[...document.querySelectorAll('.para .para-tag b')].map(b=>b.textContent)");
const expectTags = g.result.paragraphs.map((p) => (p.scored ? (p.score * 100).toFixed(0) + "%" : "skipped"));
check("paragraph scores on screen == backend", JSON.stringify(tags) === JSON.stringify(expectTags));
check("paragraph text is the stored text", await ev(`document.querySelector('.para .para-body').textContent === ${JSON.stringify(g.text.slice(g.result.paragraphs[0].start, g.result.paragraphs[0].end))}`));
await shot("e2e-intel-doc", ".tabcard");
await ev("document.querySelector('.para.band-human, .para.band-uncertain, .para.band-ai').click()");
check("selecting a paragraph fills the detail panel", await ev("document.querySelector('.detail h3')?.textContent.startsWith('Paragraph') && document.querySelector('.detail .explain')?.textContent.includes('Score')"));
await ev("[...document.querySelectorAll('.segmented button')].find(b=>b.textContent.includes('Sentence')).click()");
check("sentence mode shows context-window tooltips", await ev("!!document.querySelector('.snt[title*=\"context-window estimate\"]')"));
await shot("e2e-intel-sentences", ".tabcard");
await ev("[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Paragraphs')).click()");
check("table has a row per paragraph", await ev(`document.querySelectorAll('tr.prow').length === ${g.result.paragraphs.length}`));
await ev("[...document.querySelectorAll('.sort')].find(b=>b.textContent.includes('AI score')).click()");
const sorted = await ev("[...document.querySelectorAll('tr.prow .sc-cell b')].map(b=>parseFloat(b.textContent))");
check("sort by score works", sorted.every((v, i) => i === 0 || sorted[i - 1] >= v), sorted.join(","));
await shot("e2e-intel-table", ".tabcard");
await ev("[...document.querySelectorAll('.tab')].find(t=>t.textContent.includes('Distribution')).click()");
check("distribution charts render", await ev("document.querySelectorAll('.tab-panel svg.chart').length >= 3 && !document.querySelector('.tab-panel').innerHTML.includes('NaN')"));
await shot("e2e-intel-dist", ".tabcard");

// ---- Intelligence empty / bad id / picker
await go("#/intelligence?id=doesnotexist"); await waitFor("document.body.innerText.includes('could not be opened')");
check("bad id -> error + picker of real analyses", await ev("document.querySelectorAll('a.pick').length > 0"));
await shot("e2e-intel-picker");

// ---- mobile
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await go("#/studio"); await waitFor("!!document.querySelector('#studioText')"); await sleep(400);
check("mobile: no horizontal overflow on Studio", await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"));
await shot("e2e-mobile-studio");
await go(`#/intelligence?id=${g.id}`); await waitFor("document.querySelectorAll('.para').length > 0"); await sleep(500);
check("mobile: no horizontal overflow on Intelligence", await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"));
await shot("e2e-mobile-intel"); await shot("e2e-mobile-intel-tabs", ".tabcard");
await ev("document.getElementById('menuBtn').click()"); await sleep(500);
check("mobile drawer opens", await ev("document.getElementById('app').dataset.navOpen === 'true'"));
await shot("e2e-mobile-drawer");
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(300);
check("Escape closes drawer", await ev("document.getElementById('app').dataset.navOpen === 'false'"));
await send("Emulation.clearDeviceMetricsOverride");
await ev("document.getElementById('collapseBtn').click()"); await sleep(400);
check("collapse button collapses sidebar", await ev("document.getElementById('app').dataset.collapsed === 'true'"));
await shot("e2e-collapsed");

check("no console errors / exceptions", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));
writeFileSync(`${SP}/e2e-results.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close(); chrome.kill(); process.exit(results.some((r) => !r.ok) ? 1 : 0);
