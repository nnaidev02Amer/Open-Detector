// Seeds real analyses, opens all routes at desktop and mobile widths, scans for stray null/undefined text, saves screenshots.
// Run through tests/e2e/run_e2e.ps1 (it prepares fixtures, a scratch database and the server). Needs Node 22+ and Google Chrome.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [SP, OUT, SEED] = process.argv.slice(2), BASE = "http://127.0.0.1:8791", PORT = 9336;
mkdirSync(OUT, { recursive: true });
const api = async (p, o) => (await fetch(BASE + p, o)).json();
let ids = {};
if (SEED === "seed") {
  const fd = new FormData(); fd.append("file", new Blob([readFileSync(`${SP}/guide.pdf`)], { type: "application/pdf" }), "Browser_Fingerprinting_Guide.pdf");
  ids.guide = (await api("/api/analyze-file", { method: "POST", body: fd })).id;
  const sample = readFileSync(`${SP}/sample.txt`, "utf8");
  ids.mixed = (await api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: sample, title: "Mixed paragraph sample" }) })).id;
  await api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "far too short", title: "Tiny note" }) });
  const bfd = new FormData();
  for (const [f, t] of [["sample.txt", "text/plain"], ["sample.md", "text/markdown"], ["sample.docx", "application/octet-stream"], ["guide.pdf", "application/pdf"], ["short.txt", "text/plain"], ["bad.exe", "application/octet-stream"]]) bfd.append("files", new Blob([readFileSync(`${SP}/${f}`)], { type: t }), f);
  bfd.append("title", "Coursework folder");
  ids.batch = (await api("/api/batch", { method: "POST", body: bfd })).id;
  writeFileSync(`${SP}/seed-ids.json`, JSON.stringify(ids));
} else ids = JSON.parse(readFileSync(`${SP}/seed-ids.json`, "utf8"));

const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${SP}/chrome-shots`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch (_) { /* wait */ } await sleep(300); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0, problems = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.result.value;
await send("Page.enable");
const routes = [["dashboard", "#/dashboard"], ["studio", "#/studio"], ["intelligence", `#/intelligence?id=${ids.guide}`], ["batch", "#/batch"], ["batch-result", `#/batch?id=${ids.batch}`], ["history", "#/history"], ["analytics", "#/analytics"],
  ["reports", "#/reports"], ["report", `#/reports?id=${ids.mixed}`], ["model", "#/model"], ["design", "#/design"]];
for (const [label, w, h, dpr, mobile] of [["desktop", 1440, 900, 1, false], ["mobile", 390, 844, 2, true]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile });
  await send("Page.navigate", { url: BASE + "/" });
  for (const [name, hash] of routes) {
    await ev(`location.hash = '#/blank'`); await sleep(200); await ev(`location.hash = ${JSON.stringify(hash)}`); await sleep(2500);
    const size = await ev("({w: document.documentElement.scrollWidth, h: Math.min(document.documentElement.scrollHeight, 6000)})");
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: size.h, scale: 1 } });
    writeFileSync(`${OUT}/${label}-${name}.png`, Buffer.from(r.result.data, "base64"));
    const stray = await ev("(document.getElementById('view').innerText.match(/\b(null|undefined|NaN|\[object Object\])\b/g) || []).join(',')");
    if (stray) { problems++; console.log("STRAY TEXT", label, name, stray); }
    if (size.w > w + 1) problems++;
    console.log(label, name, `overflow:${size.w > w + 1}`, `height:${size.h}`);
  }
}
console.log(problems ? `${problems} problem(s) found` : "All routes clean: no stray text, no horizontal overflow.");
ws.close(); chrome.kill(); process.exit(problems ? 1 : 0);
