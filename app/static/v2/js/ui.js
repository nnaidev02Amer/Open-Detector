// Reusable UI components. All data is inserted with textContent / escaped, never raw innerHTML.
import { icon } from "./icons.js";
import { esc } from "./charts.js";
import { pageInfo, pageWindow } from "./logic.js";

/** h("div", {class:"x", onclick}, child, "text") */
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;            // only ever fed trusted, escaped markup (icons, charts)
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

export const VERDICTS = {
  likely_human: { label: "Likely human", cls: "human" },
  uncertain: { label: "Uncertain", cls: "uncertain" },
  likely_ai: { label: "Likely AI", cls: "ai" },
};

export const plural = (n, word) => `${Number(n).toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
export const pct = (v, d = 1) => (v == null ? "—" : (v * 100).toFixed(d) + "%");
export const fmtInt = (v) => (v == null ? "—" : Number(v).toLocaleString());
export const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? String(iso) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };

export function badge(text, kind = "neutral") { return h("span", { class: `badge ${kind}` }, text); }
export function verdictBadge(v) { const m = VERDICTS[v]; return m ? badge(m.label, m.cls) : badge("Not scored", "neutral"); }

export function button(label, { kind = "", icon: ic, href, onclick, size, disabled } = {}) {
  const cls = ["btn", kind && `btn-${kind}`, size && `btn-${size}`].filter(Boolean).join(" ");
  const inner = (ic ? icon(ic) : "") + `<span>${esc(label)}</span>`;
  return href ? h("a", { class: cls, href, html: inner }) : h("button", { class: cls, type: "button", onclick, disabled, html: inner });
}

export function card(title, { sub, actions, cls = "" } = {}, ...body) {
  const head = title ? h("div", { class: "card-head" }, h("div", {}, h("h3", {}, title), sub ? h("div", { class: "sub" }, sub) : null), actions || null) : null;
  return h("section", { class: `card ${cls}` }, head, ...body);
}

export function statCard({ label, value, hint, icon: ic }) {
  return h("div", { class: "card stat" },
    h("div", { class: "stat-top" }, h("span", {}, label), h("span", { class: "stat-icon", html: icon(ic || "analytics") })),
    h("div", { class: "stat-value" }, value), hint ? h("div", { class: "stat-hint" }, hint) : null);
}

export function pageHead({ eyebrow, title, lede, actions }) {
  return h("header", { class: "page-head" },
    h("div", {}, eyebrow ? h("p", { class: "eyebrow" }, eyebrow) : null, h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null),
    actions ? h("div", { class: "actions" }, actions) : null);
}

export function emptyState({ title, text, icon: ic = "inbox", action, error = false }) {
  return h("div", { class: `state${error ? " error" : ""}`, role: error ? "alert" : "status" },
    h("div", { class: "state-icon", html: icon(error ? "alert" : ic) }), h("h3", {}, title), text ? h("p", {}, text) : null, action || null);
}

export function skeleton(w = "100%", hgt = 14) { return h("div", { class: "skeleton", style: `width:${w};height:${hgt}px`, "aria-hidden": "true" }); }
export function loadingBlock(lines = 3) {
  return h("div", { class: "loading", role: "status", "aria-label": "Loading" }, ...Array.from({ length: lines }, (_, i) => h("div", { style: "margin:12px 0" }, skeleton(i === 0 ? "42%" : "100%", i === 0 ? 20 : 14))));
}
export function statSkeletons(n = 4) {
  return h("div", { class: "grid cols-4" }, ...Array.from({ length: n }, () => h("div", { class: "card" }, skeleton("50%", 14), h("div", { style: "height:14px" }), skeleton("65%", 32), h("div", { style: "height:10px" }), skeleton("40%", 12))));
}

export function toast(msg, kind = "") {
  let box = document.querySelector(".toasts");
  if (!box) { box = h("div", { class: "toasts", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}

/** Tabs: items [{id, label, render()}]. Returns {el, select(id)}. Keyboard: arrow keys move between tabs. */
export function tabs(items, { initial, onChange } = {}) {
  const bar = h("div", { class: "tabs", role: "tablist" }), panel = h("div", { class: "tab-panel", role: "tabpanel" });
  const btns = {};
  function select(id, focus = false) {
    for (const [k, b] of Object.entries(btns)) { b.setAttribute("aria-selected", String(k === id)); b.tabIndex = k === id ? 0 : -1; }
    const it = items.find((i) => i.id === id);
    panel.replaceChildren(it.render()); panel.setAttribute("aria-labelledby", `tab-${id}`);
    panel.classList.remove("tab-in"); void panel.offsetWidth; panel.classList.add("tab-in");
    if (focus) btns[id].focus();
    if (onChange) onChange(id);
  }
  items.forEach((it, i) => {
    const b = h("button", { class: "tab", role: "tab", id: `tab-${it.id}`, type: "button", onclick: () => select(it.id),
      onkeydown: (e) => { const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (d) { e.preventDefault(); select(items[(i + d + items.length) % items.length].id, true); } } }, it.label);
    btns[it.id] = b; bar.append(b);
  });
  select(initial || items[0].id);
  return { el: h("div", {}, bar, panel), select };
}

/** Segmented control: options [{id,label}] -> {el, set(id)}. */
export function segmented(options, value, onChange) {
  const el = h("div", { class: "segmented", role: "group" });
  const btns = options.map((o) => h("button", { type: "button", "data-id": o.id, "aria-pressed": String(o.id === value), onclick: () => { set(o.id); onChange(o.id); } }, o.label));
  function set(id) { btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id))); }
  el.append(...btns);
  return { el, set };
}

export function progressBar(label) {
  return h("div", { class: "progress", role: "progressbar", "aria-label": label || "Working", "aria-busy": "true" }, h("i"));
}

/** Pagination controls. onPage(pageNumber). */
export function pagination({ total, limit, offset, onPage }) {
  const { page, pages, from, to } = pageInfo(total, limit, offset);
  const btn = (label, p, { disabled, current, aria } = {}) => h("button", { type: "button", class: `pg${current ? " current" : ""}`, disabled, "aria-label": aria, "aria-current": current ? "page" : null, onclick: () => onPage(p) }, label);
  return h("nav", { class: "pagination", "aria-label": "Pagination" },
    h("span", { class: "muted small" }, total ? `Showing ${from}–${to} of ${total.toLocaleString()}` : "No results"),
    h("div", { class: "pg-buttons" }, btn("‹", page - 1, { disabled: page <= 1, aria: "Previous page" }),
      ...pageWindow(page, pages).map((p) => (p === "…" ? h("span", { class: "pg-gap" }, "…") : btn(String(p), p, { current: p === page, aria: `Page ${p}` }))),
      btn("›", page + 1, { disabled: page >= pages, aria: "Next page" })));
}

/** Modal confirmation. Resolves true/false. Escape or backdrop click cancels; focus returns to the opener. */
export function confirmDialog({ title, text, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const done = (v) => { document.removeEventListener("keydown", onKey, true); overlay.remove(); opener?.focus?.(); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      if (e.key === "Tab") { const f = [...overlay.querySelectorAll("button")]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
    };
    const ok = h("button", { type: "button", class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => done(true) }, confirmLabel);
    const cancel = h("button", { type: "button", class: "btn btn-ghost", onclick: () => done(false) }, "Cancel");
    const overlay = h("div", { class: "modal-scrim", onclick: (e) => { if (e.target === overlay) done(false); } },
      h("div", { class: "modal", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "dlgTitle", "aria-describedby": "dlgText" },
        h("h3", { id: "dlgTitle" }, title), h("p", { id: "dlgText", class: "muted" }, text), h("div", { class: "actions end" }, cancel, ok)));
    document.body.append(overlay); document.addEventListener("keydown", onKey, true); cancel.focus();
  });
}
