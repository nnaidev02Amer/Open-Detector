// Component gallery (route #/design, not in the sidebar). Chart values here are SYNTHETIC and labelled as such.
import { bars, COLORS, donut, legend, line, meter } from "../charts.js";
import { badge, button, card, emptyState, h, loadingBlock, pageHead, statCard, statSkeletons, toast, verdictBadge } from "../ui.js";

const SWATCHES = [["--bg", "#060a16"], ["--surface-solid", "#101933"], ["--indigo-500", "#6366f1"], ["--indigo-300", "#a5b4fc"], ["--human", "#34d6c0"], ["--uncertain", "#f5b84b"], ["--ai", "#f2668b"]];

export function render(root) {
  const note = h("span", { class: "sample-note" }, "Component preview — synthetic values, not analysis data");
  root.replaceChildren(
    pageHead({ eyebrow: "Design system", title: "Components", lede: "Reusable building blocks for every module. This page exists to review the design; it never shows real statistics.", actions: [note] }),
    h("div", { class: "grid cols-2" },
      card("Palette", {}, h("div", { class: "swatches" }, ...SWATCHES.map(([n, c]) => h("div", { class: "swatch" }, h("i", { style: `background:${c}` }), h("span", {}, n))))),
      card("Buttons and badges", {}, h("div", { class: "actions" }, button("Primary", { kind: "primary", icon: "studio" }), button("Secondary"), button("Ghost", { kind: "ghost" }), button("Disabled", { disabled: true })),
        h("div", { class: "actions", style: "margin-top:16px" }, verdictBadge("likely_human"), verdictBadge("uncertain"), verdictBadge("likely_ai"), badge("PDF", "indigo"), badge("neutral")),
        h("div", { class: "actions", style: "margin-top:16px" }, button("Show toast", { size: "sm", onclick: () => toast("This is a toast message.") }), button("Show error toast", { size: "sm", onclick: () => toast("Something went wrong.", "error") })))),
    h("div", { style: "height:18px" }),
    h("div", { class: "grid cols-4" }, statCard({ label: "Stat card", value: "00", hint: "label · value · hint", icon: "gauge" }), statCard({ label: "Another", value: "00%", hint: "sample", icon: "analytics" }),
      statCard({ label: "Another", value: "00", hint: "sample", icon: "doc" }), statCard({ label: "Another", value: "00", hint: "sample", icon: "flag" })),
    h("div", { style: "height:18px" }),
    h("div", { class: "grid cols-2" },
      card("Donut", { sub: "synthetic" }, h("div", { class: "donut-wrap" }, h("div", { html: donut([{ label: "A", value: 5, color: COLORS.human }, { label: "B", value: 2, color: COLORS.uncertain }, { label: "C", value: 3, color: COLORS.ai }], { centerValue: "10", centerLabel: "sample" }) }),
        h("div", { html: legend([{ label: "A", value: 5, color: COLORS.human }, { label: "B", value: 2, color: COLORS.uncertain }, { label: "C", value: 3, color: COLORS.ai }]) }))),
      card("Meter", { sub: "synthetic" }, h("div", { html: meter(0.18) }), h("div", { style: "height:14px" }), h("div", { html: meter(0.55) }), h("div", { style: "height:14px" }), h("div", { html: meter(0.92) }))),
    h("div", { style: "height:18px" }),
    h("div", { class: "grid cols-2" },
      card("Bar chart", { sub: "synthetic" }, h("div", { html: bars([1, 3, 2, 6, 9, 4, 5, 2, 1, 7], { labels: "0123456789".split("").map((d) => d + "0"), height: 190 }) })),
      card("Line chart", { sub: "synthetic" }, h("div", { html: line(["a", "b", "c", "d", "e", "f"].map((x, i) => ({ x, y: [0.2, 0.35, 0.3, 0.6, null, 0.5][i] })), { yMax: 1, yFormat: (v) => Math.round(v * 100) + "%", height: 190 }) }))),
    h("div", { style: "height:18px" }),
    h("div", { class: "grid cols-2" },
      card("Loading state", {}, loadingBlock(3)), card("Empty state", {}, emptyState({ title: "Nothing here yet", text: "Empty states explain what will appear and how to get there.", action: button("Call to action", { kind: "primary" }) }))),
    h("div", { style: "height:18px" }), card("Stat skeletons", {}, statSkeletons(4)),
    h("div", { style: "height:18px" }), card(null, {}, emptyState({ error: true, title: "Error state", text: "Errors say what failed and offer a retry." })));
}
