// Analysis History: search, filter, sort, paginate, open and delete. Uses GET /api/history/search and DELETE /api/history/{id}.
import { deleteAnalysis, searchHistoryPage } from "../api.js";
import { meter } from "../charts.js";
import { SORT_OPTIONS, SOURCE_LABEL, SOURCE_OPTIONS, hasFilters, searchParams } from "../logic.js";
import { badge, button, card, confirmDialog, emptyState, fmtDate, fmtInt, h, pageHead, pagination, pct, toast, verdictBadge } from "../ui.js";

const KEYS = ["q", "verdict", "source", "status", "date_from", "date_to", "sort", "page", "size"];

export function render(root, ctx) {
  const f = Object.fromEntries(KEYS.map((k) => [k, ctx.query.get(k) || ""]));
  f.sort = f.sort || "newest";
  let size = [10, 25, 50].includes(+f.size) ? +f.size : 10, page = Math.max(1, +f.page || 1), seq = 0, timer = null;

  const field = (label, control) => h("label", { class: "field" }, h("span", {}, label), control);
  const select = (key, opts, first) => { const s = h("select", { "aria-label": key }, ...(first ? [h("option", { value: "" }, first)] : []), ...opts.map(([v, l]) => h("option", { value: v, selected: f[key] === v }, l))); s.addEventListener("change", () => { f[key] = s.value; page = 1; load(); }); return s; };
  const search = h("input", { type: "search", class: "text-in", value: f.q, placeholder: "Search by document name…", "aria-label": "Search by document name", autocomplete: "off" });
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { f.q = search.value.trim(); page = 1; load(); }, 300); });
  const date = (key) => { const i = h("input", { type: "date", value: f[key], "aria-label": key }); i.addEventListener("change", () => { f[key] = i.value; page = 1; load(); }); return i; };
  const sizeSel = h("select", { "aria-label": "Rows per page" }, ...[10, 25, 50].map((n) => h("option", { value: n, selected: n === size }, `${n} per page`)));
  sizeSel.addEventListener("change", () => { size = +sizeSel.value; page = 1; load(); });
  const verdictSel = select("verdict", [["likely_human", "Likely human"], ["uncertain", "Uncertain"], ["likely_ai", "Likely AI"]], "All verdicts");
  const sourceSel = select("source", SOURCE_OPTIONS, "All sources");
  const statusSel = select("status", [["ok", "Scored"], ["insufficient_text", "Too short"]], "Any status");
  const sortSel = select("sort", SORT_OPTIONS);
  const dFrom = date("date_from"), dTo = date("date_to");
  const clear = button("Clear filters", { kind: "ghost", size: "sm", onclick: () => { for (const k of ["q", "verdict", "source", "status", "date_from", "date_to"]) f[k] = ""; f.sort = "newest"; search.value = ""; [verdictSel, sourceSel, statusSel].forEach((s) => (s.value = "")); sortSel.value = "newest"; dFrom.value = dTo.value = ""; page = 1; load(); } });

  const filters = h("div", { class: "filters" }, field("Search", search), field("Verdict", verdictSel), field("Source", sourceSel), field("Status", statusSel),
    field("From (UTC date)", dFrom), field("To (UTC date)", dTo), field("Sort by", sortSel), h("div", { class: "field end" }, clear));
  const results = h("div", { "aria-live": "polite" });
  root.replaceChildren(pageHead({ eyebrow: "Archive", title: "Analysis History", lede: "Every document analysed on this computer. Search, filter and reopen any result.", actions: [button("New analysis", { kind: "primary", icon: "studio", href: "#/studio" })] }),
    card(null, { cls: "filter-card" }, filters), h("div", { style: "height:18px" }), results);

  function syncUrl() {
    const p = new URLSearchParams();
    for (const k of ["q", "verdict", "source", "status", "date_from", "date_to"]) if (f[k]) p.set(k, f[k]);
    if (f.sort !== "newest") p.set("sort", f.sort); if (page > 1) p.set("page", page); if (size !== 10) p.set("size", size);
    if (location.hash.startsWith("#/history")) history.replaceState(null, "", "#/history" + (p.toString() ? "?" + p : ""));
  }

  async function load() {
    const mine = ++seq; syncUrl();
    results.replaceChildren(card(null, {}, h("div", { class: "skel-rows" }, ...Array.from({ length: 5 }, () => h("div", { class: "skeleton", style: "height:44px;margin:10px 0" })))));
    let r;
    try { r = await searchHistoryPage(searchParams(f, size, page)); }
    catch (e) { if (mine === seq) results.replaceChildren(card(null, {}, emptyState({ error: true, title: "Could not load history", text: e.message, action: button("Retry", { kind: "primary", onclick: load }) }))); return; }
    if (mine !== seq) return;
    if (!r.total && page > 1) { page = 1; return load(); }
    if (!r.total) {
      results.replaceChildren(card(null, {}, hasFilters(f)
        ? emptyState({ icon: "search", title: "No analyses match these filters", text: "Try a different search or widen the filters.", action: button("Clear filters", { kind: "primary", onclick: () => clear.click() }) })
        : emptyState({ icon: "history", title: "No analyses yet", text: "Analyse a document and it will be saved here automatically.", action: button("Open Detection Studio", { kind: "primary", icon: "studio", href: "#/studio" }) })));
      return;
    }
    const tbody = h("tbody", {}, ...r.items.map((a) => h("tr", { class: "hrow" },
      h("td", { class: "doc-cell", "data-label": "Document" }, h("a", { class: "title link", href: `#/intelligence?id=${encodeURIComponent(a.id)}`, title: a.title }, a.title), h("div", { class: "meta" }, `Case ${a.id}`)),
      h("td", { "data-label": "Source" }, badge(SOURCE_LABEL[a.source] || a.source, "indigo")), h("td", { class: "nowrap", "data-label": "Date" }, fmtDate(a.created_at)), h("td", { class: "num", "data-label": "Words" }, fmtInt(a.words)),
      h("td", { class: "sc", "data-label": "AI score" }, a.overall_score != null ? h("div", { class: "sc-cell" }, h("div", { html: meter(a.overall_score) }), h("b", {}, pct(a.overall_score, 0))) : h("span", { class: "muted" }, "—")),
      h("td", { "data-label": "Verdict" }, a.verdict ? verdictBadge(a.verdict) : badge(a.status === "insufficient_text" ? "Too short" : "Not scored", "neutral")),
      h("td", { class: "act" }, h("a", { class: "btn btn-sm", href: `#/intelligence?id=${encodeURIComponent(a.id)}` }, "Open"),
        h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", "aria-label": `Delete ${a.title}`, onclick: () => remove(a) }, "Delete")))));
    results.replaceChildren(card(null, { cls: "table-card" },
      h("div", { class: "table-scroll" }, h("table", { class: "ptable htable stack-m" }, h("thead", {}, h("tr", {}, ...["Document", "Source", "Date", "Words", "AI score", "Verdict", ""].map((t, i) => h("th", { scope: "col", class: i === 3 ? "num" : "" }, t)))), tbody)),
      h("div", { class: "table-foot" }, pagination({ total: r.total, limit: size, offset: (page - 1) * size, onPage: (p) => { page = p; load(); window.scrollTo({ top: 0, behavior: "smooth" }); } }), h("label", { class: "field inline" }, sizeSel))));
  }

  async function remove(a) {
    if (!(await confirmDialog({ title: "Delete this analysis?", text: `“${a.title}” will be removed from your history and from any batch that contains it. This cannot be undone.`, confirmLabel: "Delete", danger: true }))) return;
    try { await deleteAnalysis(a.id); toast("Analysis deleted"); } catch (e) { toast(e.message, "error"); }
    load();
  }
  load();
}
