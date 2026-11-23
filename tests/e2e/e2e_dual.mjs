// Dual-model comparison page (#/dual): Followsci BERT and Fakespot RoBERTa side by side, in a real browser.
// Checks that what is on screen equals what the backend returns, that there is no combined score or verdict, that the page
// does not write to history, file upload and validation, the agreement table and its filter, mobile layout and console errors.
// Run through tests/e2e/run_e2e.ps1 (it prepares fixtures, a scratch database and the server). Needs Node 22+, Google Chrome,
// and the Fakespot model in the local Hugging Face cache (the app never downloads it).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SP = process.argv[2], BASE = "http://127.0.0.1:8791", PORT = 9338;
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${SP}/chrome-dual`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
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
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
// Transient evaluate errors while a page is still loading or re-rendering (e.g. document.body not ready) are retried until the timeout.
const waitFor = async (expr, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (_) { /* page not ready yet: retry */ } await sleep(250); } throw new Error("timeout waiting for: " + expr); };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(`${SP}/${name}.png`, Buffer.from(r.result.data, "base64")); };
// Re-open a route via the router's synchronous "not found" page (#/blank), so no earlier page can finish rendering late and overwrite the target.
const go = async (hash) => { if (await ev("location.hash") === hash) { await ev("location.hash = '#/blank'"); await sleep(400); } await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(600); };
const setFile = async (path) => { const doc = await send("DOM.getDocument"); const q = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "input[type=file]" }); await send("DOM.setFileInputFiles", { files: [path], nodeId: q.result.nodeId }); };
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail); };
const click = (label) => ev(`[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()`);
const VERD = { likely_human: "Likely human", uncertain: "Uncertain", likely_ai: "Likely AI" };
const REL = { agree_ai: "Both: AI", agree_human: "Both: human", agree_uncertain: "Both: uncertain", partial: "One uncertain", disagree: "Disagree", not_compared: "Not compared" };
const P1 = (v) => (v * 100).toFixed(1) + "%", P2 = (v) => (v * 100).toFixed(2) + "%";
const postJson = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
const postFile = async (name, type) => { const fd = new FormData(); fd.append("file", new Blob([readFileSync(`${SP}/${name}`)], { type }), name); return (await fetch(BASE + "/api/analyze-file-dual", { method: "POST", body: fd })).json(); };
const historyCount = async () => (await (await fetch(BASE + "/api/history")).json()).length;
const cardExpr = (i) => `document.querySelectorAll('.dual-grid > .card')[${i}]`;

await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Page.navigate", { url: BASE + "/#/dual" }); await waitFor("!!document.querySelector('textarea.editor')");
const history0 = await historyCount();

// ---- navigation: an extra route, the eight modules are unchanged
check("page title and heading", await ev("document.title.includes('Dual-model comparison') && document.getElementById('view').innerText.includes('Dual-model comparison')"));
check("page states there is no combined verdict", await ev("document.getElementById('view').innerText.includes('no combined verdict')"));
check("sidebar footer links to #/dual", await ev("!![...document.querySelectorAll('a[href=\"#/dual\"]')].find(a => a.textContent.includes('Dual-model compare'))"));
check("main navigation still has the eight modules (dual is an extra route)", await ev("document.querySelectorAll('#nav a').length === 8 && !document.querySelector('#nav a[href=\"#/dual\"]')"));
check("classic interface link still present", await ev("!!document.querySelector('a[href=\"/classic\"]')"));

// ---- validation
await click("Compare both models");
check("empty input -> error message", await ev("document.querySelector('.field-error:not([hidden])')?.textContent.includes('Paste some text')"));
await ev(`(() => { const t = document.querySelector('textarea.editor'); t.value = 'only a handful of words here'; t.dispatchEvent(new Event('input')); })()`);
check("counter says more words are needed", await ev("document.querySelector('.counters .hint')?.textContent.includes('more words needed')"));
await click("Compare both models");
await waitFor("document.querySelector('.dual-grid')");
check("short text -> both models report no result, no comparison table", await ev("document.querySelectorAll('.dual-grid > .card').length === 2 && [...document.querySelectorAll('.dual-grid > .card')].every(c => c.innerText.includes('No result')) && !document.querySelector('.dual-table')"));

// ---- pasted text: screen == backend
const text = readFileSync(`${SP}/sample.txt`, "utf8").trim();
await go("#/dual"); await waitFor("!!document.querySelector('textarea.editor')");
await ev(`(() => { const t = document.querySelector('textarea.editor'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
await click("Compare both models");
check("progress shown while running", await ev("!!document.querySelector('.working, .dual-grid')"));
await waitFor("!!document.querySelector('.dual-table')");
await shot("e2e-dual-result");
const api = await postJson("/api/analyze-dual", { text });
const F = api.models.followsci, K = api.models.fakespot, cmp = api.comparison;
check("backend: both models ok", F.status === "ok" && K.status === "ok" && cmp);
check("exactly two model cards", await ev("document.querySelectorAll('.dual-grid > .card').length === 2"));
check("card headings are the two models", JSON.stringify(await ev("[...document.querySelectorAll('.dual-grid h3')].map(h => h.textContent)")) === JSON.stringify(["Followsci BERT", "Fakespot RoBERTa"]));
for (const [i, m, label] of [[0, F, "Followsci"], [1, K, "Fakespot"]]) {
  const t = await ev(`(() => { const c = ${cardExpr(i)}; const b = [...c.querySelectorAll('.big-prob b')].map(x => x.textContent); return { ai: b[0], human: b[1], verdict: c.querySelector('.model-head .badge').textContent, text: c.innerText }; })()`);
  check(`${label}: AI probability on screen == backend`, t.ai === P1(m.document.p_ai), `${t.ai} vs ${P1(m.document.p_ai)}`);
  check(`${label}: human probability on screen == backend`, t.human === P1(m.document.p_human), t.human);
  check(`${label}: verdict badge == backend verdict`, t.verdict === VERD[m.document.verdict], t.verdict);
  check(`${label}: own thresholds shown`, t.text.includes(`human < ${P2(m.thresholds.human_below)}`) && t.text.includes(`AI ≥ ${P2(m.thresholds.ai_at_or_above)}`));
  check(`${label}: thresholds flagged as validated`, t.text.includes("validated on a separate split") && m.thresholds.validated === true);
  check(`${label}: inference time shown`, /Inference time\s*\n?\s*\d/.test(t.text) && m.inference_ms > 0);
}
check("licences shown (MIT, Apache-2.0)", await ev(`${cardExpr(0)}.innerText.includes('MIT') && ${cardExpr(1)}.innerText.includes('Apache-2.0')`));
check("existing-app verdict shown for Followsci only", await ev(`${cardExpr(0)}.innerText.includes('Existing app verdict') && !${cardExpr(1)}.innerText.includes('Existing app verdict')`) && F.document.shipped_verdict !== undefined);
check("the two models use different thresholds", JSON.stringify(F.thresholds) !== JSON.stringify(K.thresholds));

// ---- no averaged score, no combined verdict
check("only the two model cards and the comparison table (no third result)", JSON.stringify(await ev("[...document.querySelectorAll('.result h3')].map(h => h.textContent)")) === JSON.stringify(["Followsci BERT", "Fakespot RoBERTa", "Paragraph-level comparison"]));
check("no combined/average/ensemble wording inside cards, banner or table", !(await ev("/combined|average|ensemble|overall verdict|final verdict/i.test([...document.querySelectorAll('.dual-grid, .agree-banner, .dual-table')].map(e => e.innerText).join(' '))")));
check("backend response has no combined score or verdict", !JSON.stringify(Object.keys(api)).match(/combined|average|ensemble|verdict/i) && !("verdict" in cmp) && !("p_ai" in cmp));

// ---- agreement: document and paragraphs
const banner = await ev("document.querySelector('.agree-banner')?.innerText || ''");
check("agreement banner == backend relation", banner.includes(REL[cmp.document.relation]) && banner.includes(`${(cmp.document.delta_p_ai * 100).toFixed(1)} points`), banner.replace(/\n/g, " ").slice(0, 120));
const rows = await ev(`[...document.querySelectorAll('.dual-table tbody tr')].map(tr => [...tr.cells].map(c => c.innerText.trim()))`);
check("one table row per paragraph", rows.length === cmp.paragraphs.length && rows.length === F.paragraphs.length, `${rows.length} vs ${cmp.paragraphs.length}`);
check("row scores and agreement labels == backend", rows.every((r, i) => (!F.paragraphs[i].scored || r[2] === P1(F.paragraphs[i].p_ai)) && (!K.paragraphs[i].scored || r[4] === P1(K.paragraphs[i].p_ai)) && r[6] === REL[cmp.paragraphs[i].relation]), JSON.stringify(rows.map((r) => [r[2], r[4], r[6]])));
const nDis = cmp.paragraphs.filter((p) => p.relation === "disagree" || p.relation === "partial").length;
await ev("document.querySelector('.dual-table').closest('.card').querySelector('input[type=checkbox]').click()");
await sleep(300);
const filtered = await ev("[...document.querySelectorAll('.dual-table tbody tr')].map(tr => tr.innerText.trim())");
check("disagreement filter shows only disagreements / partial agreements", nDis ? filtered.length === nDis : (filtered.length === 1 && filtered[0].includes("No paragraphs match")), `${filtered.length} rows, expected ${nDis || "empty notice"}`);
check("nothing was written to history", (await historyCount()) === history0);

// ---- file upload through the page
await go("#/dual"); await waitFor("!!document.querySelector('textarea.editor')");
await ev("[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('Upload')).click()"); await waitFor("!!document.querySelector('input[type=file]')");
await setFile(`${SP}/bad.exe`); await sleep(500);
check("unsupported file rejected with a message", await ev("(() => { const e = document.querySelector('.field-error:not([hidden])'); return !!e && e.textContent.length > 5; })()"));
await click("Compare both models");
check("running without a valid file asks for one", await ev("[...document.querySelectorAll('.field-error:not([hidden])')].some(e => e.textContent.includes('Choose a file'))"));
await setFile(`${SP}/sample.docx`); await sleep(500);
check("chosen file name shown", await ev("document.body.innerText.includes('sample.docx')"));
await click("Compare both models");
await waitFor("!!document.querySelector('.dual-table')");
const docx = await postFile("sample.docx", "application/octet-stream");
const onScreen = await ev("[0, 1].map(i => [...document.querySelectorAll('.dual-grid > .card')[i].querySelectorAll('.big-prob b')].map(x => x.textContent))");
check("DOCX upload: both models' probabilities == backend", onScreen[0][0] === P1(docx.models.followsci.document.p_ai) && onScreen[1][0] === P1(docx.models.fakespot.document.p_ai), JSON.stringify(onScreen));

// ---- the other formats through the dual API (same extraction as the rest of the app)
for (const [name, type, source] of [["sample.txt", "text/plain", "txt"], ["sample.md", "text/markdown", "txt"], ["guide.pdf", "application/pdf", "pdf"]]) {
  const r = await postFile(name, type);
  check(`${name}: both models ok, source ${source}`, r.source === source && r.models.followsci.status === "ok" && r.models.fakespot.status === "ok" && !!r.comparison, `${r.source} ${r.models?.followsci?.status}/${r.models?.fakespot?.status}`);
}
const bad = await fetch(BASE + "/api/analyze-file-dual", { method: "POST", body: (() => { const fd = new FormData(); fd.append("file", new Blob(["x"]), "a.exe"); return fd; })() });
check("API rejects an unsupported file with 400", bad.status === 400);
check("nothing was written to history (all dual calls)", (await historyCount()) === history0);

// ---- mobile
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await go("#/dual"); await waitFor("!!document.querySelector('textarea.editor')");
await ev(`(() => { const t = document.querySelector('textarea.editor'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
await click("Compare both models");
await waitFor("!!document.querySelector('.dual-table')");
await shot("e2e-dual-mobile");
check("mobile: no horizontal overflow", await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth + ' vs ' + window.innerWidth"));
check("mobile: model cards stack", await ev("(() => { const c = document.querySelectorAll('.dual-grid > .card'); return c[1].getBoundingClientRect().top > c[0].getBoundingClientRect().bottom - 2; })()"));
check("no stray null/undefined text", !(await ev("/\\b(null|undefined|NaN|\\[object Object\\])\\b/.test(document.getElementById('view').innerText)")));

check("no console errors / exceptions", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 300));
writeFileSync(`${SP}/e2e-dual-results.json`, JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close(); chrome.kill(); process.exit(results.some((r) => !r.ok) ? 1 : 0);
