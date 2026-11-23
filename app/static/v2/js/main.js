// App shell: hash router, collapsible sidebar, mobile drawer, header with live model status.
import { getStatus } from "./api.js";
import { icon } from "./icons.js";
import { emptyState, h, loadingBlock, pageHead } from "./ui.js";
import { render as dashboard } from "./pages/dashboard.js";
import { render as design } from "./pages/design.js";
import { render as intelligence } from "./pages/intelligence.js";
import { render as studio } from "./pages/studio.js";
import { render as batch } from "./pages/batch.js";
import { render as history } from "./pages/history.js";
import { render as analytics } from "./pages/analytics.js";
import { render as reports } from "./pages/reports.js";
import { render as model } from "./pages/model.js";
import { render as dual } from "./pages/dual.js";

export const MODULES = [
  { id: "dashboard", title: "Dashboard", icon: "dashboard", lede: "Overview of all analyses.", render: dashboard },
  { id: "studio", title: "Detection Studio", icon: "studio", lede: "Paste text or upload a document and run the detector.", render: studio },
  { id: "intelligence", title: "Document Intelligence", icon: "intelligence", lede: "Paragraph-level results, highlighting and score distribution.", render: intelligence },
  { id: "batch", title: "Batch Analysis", icon: "batch", lede: "Analyse several documents at once and compare them.", render: batch },
  { id: "analytics", title: "Analytics", icon: "analytics", lede: "Score distributions and trends from your stored results.", render: analytics },
  { id: "history", title: "History", icon: "history", lede: "Search, filter and revisit previous analyses.", render: history },
  { id: "reports", title: "Report Center", icon: "reports", lede: "Print-ready reports you can save as PDF.", render: reports },
  { id: "model", title: "Model Information", icon: "model", lede: "The detector, its measured accuracy and its limitations.", render: model },
];
const ROUTES = Object.fromEntries(MODULES.map((m) => [m.id, m.render]));
ROUTES.design = design;
ROUTES.dual = dual;   // extra route (not one of the eight modules): linked from the sidebar footer
const TITLES = { ...Object.fromEntries(MODULES.map((m) => [m.id, m])), design: { title: "Components", lede: "Design system preview" }, dual: { title: "Dual-model comparison", lede: "Followsci BERT and Fakespot RoBERTa side by side." } };

const app = document.getElementById("app"), view = document.getElementById("view"), nav = document.getElementById("nav");
const crumbT = document.getElementById("crumbTitle"), crumbS = document.getElementById("crumbSub");
const mq = window.matchMedia("(max-width: 960px)");
let current = null, seq = 0;

/* ---------- sidebar ---------- */
nav.replaceChildren(...MODULES.map((m) => h("a", { href: `#/${m.id}`, "data-id": m.id, title: m.title, html: `${icon(m.icon)}<span class="label">${m.title}</span>${m.stage && !m.classicHash ? '<span class="soon">soon</span>' : ""}` })));
const setCollapsed = (v) => { app.dataset.collapsed = v ? "true" : "false"; try { localStorage.setItem("od2-collapsed", v ? "1" : "0"); } catch (_) { /* private mode */ } document.getElementById("collapseBtn").setAttribute("aria-expanded", String(!v)); };
try { setCollapsed(localStorage.getItem("od2-collapsed") === "1"); } catch (_) { setCollapsed(false); }
document.getElementById("collapseBtn").addEventListener("click", () => setCollapsed(app.dataset.collapsed !== "true"));

const menuBtn = document.getElementById("menuBtn");
function setDrawer(open) { app.dataset.navOpen = open ? "true" : "false"; menuBtn.setAttribute("aria-expanded", String(open)); if (open) nav.querySelector("a[aria-current], a")?.focus(); }
menuBtn.addEventListener("click", () => setDrawer(app.dataset.navOpen !== "true"));
document.getElementById("scrim").addEventListener("click", () => { setDrawer(false); menuBtn.focus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.dataset.navOpen === "true") { setDrawer(false); menuBtn.focus(); } });
mq.addEventListener("change", () => setDrawer(false));

/* ---------- search (submits to the History module) ---------- */
const searchInput = document.getElementById("searchInput"), narrowMq = window.matchMedia("(max-width: 560px)");
const setPlaceholder = () => { searchInput.placeholder = narrowMq.matches ? "Search…" : "Search analyses…"; };
setPlaceholder(); narrowMq.addEventListener("change", setPlaceholder);
document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("searchInput").value.trim();
  location.hash = q ? `#/history?q=${encodeURIComponent(q)}` : "#/history";
});

/* ---------- router ---------- */
function parse() {
  const raw = location.hash.replace(/^#\/?/, ""), [path, query = ""] = raw.split("?");
  return { id: path || "dashboard", query: new URLSearchParams(query) };
}
async function route() {
  const { id, query } = parse(), mine = ++seq, fn = ROUTES[id];
  setDrawer(false);
  if (!fn) {
    view.replaceChildren(pageHead({ eyebrow: "404", title: "Page not found" }), emptyState({ title: "That page does not exist", text: `There is no module called “${id}”.`, action: h("a", { class: "btn btn-primary", href: "#/dashboard" }, "Go to dashboard") }));
    crumbT.textContent = "Not found"; crumbS.textContent = ""; document.title = "Not found · Open Detector"; return;
  }
  document.getElementById("searchInput").value = id === "history" ? (query.get("q") || "") : "";   // header search mirrors the History query only
  const meta = TITLES[id];
  crumbT.textContent = meta.title; crumbS.textContent = meta.lede || ""; document.title = `${meta.title} · Open Detector`;
  nav.querySelectorAll("a").forEach((a) => (a.dataset.id === id ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  view.classList.remove("view"); void view.offsetWidth; view.classList.add("view");   // replay the entrance animation
  view.replaceChildren(loadingBlock(3));
  try { await fn(view, { query }); } catch (e) {
    if (mine === seq) view.replaceChildren(pageHead({ eyebrow: "Error", title: meta.title }), emptyState({ error: true, title: "This page failed to load", text: e.message }));
  }
  if (mine === seq && current !== id) { window.scrollTo({ top: 0 }); current = id; }
}
window.addEventListener("hashchange", route);

/* ---------- live model status (GET /api/status) ---------- */
(async function status() {
  const dot = document.getElementById("statusDot"), text = document.getElementById("statusText");
  try {
    const s = await getStatus();
    dot.className = "dot ok"; text.textContent = `${s.model.split("/").pop()} · ${s.device}`;
    document.getElementById("statusChip").title = `Model ${s.model} running on ${s.device}`;
  } catch (_) { dot.className = "dot err"; text.textContent = "server unreachable"; }
})();

route();
