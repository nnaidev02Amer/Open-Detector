// Shared result widgets used by Detection Studio and Document Intelligence.
import { COLORS, donut } from "./charts.js";
import { DEFAULT_BANDS, bandOf, humanProbability, verdictExplanation } from "./logic.js";
import { h, pct, verdictBadge } from "./ui.js";

/** 0-100% scale with the detector's actual bands and a marker at `score`. */
export function scaleGauge(score, bands = DEFAULT_BANDS, label = "Score") {
  return h("div", { class: "scale", role: "img", "aria-label": `${label} ${pct(score)} on a 0 to 100 percent scale; human below ${pct(bands.human_below, 0)}, AI above ${pct(bands.ai_above, 0)}` },
    h("div", { class: "scale-track" },
      h("i", { class: "z-human", style: `width:${bands.human_below * 100}%` }),
      h("i", { class: "z-unc", style: `width:${(bands.ai_above - bands.human_below) * 100}%` }),
      h("i", { class: "z-ai", style: `width:${(1 - bands.ai_above) * 100}%` }),
      h("span", { class: "marker", style: `left:${score * 100}%`, title: pct(score) })),
    h("div", { class: "scale-labels" }, h("span", {}, "0%"), h("span", { style: `left:${bands.human_below * 100}%` }, pct(bands.human_below, 0)),
      h("span", { style: `left:${bands.ai_above * 100}%` }, pct(bands.ai_above, 0)), h("span", {}, "100%")));
}

/** Donut + probabilities + verdict + gauge + explanation for a scored document result. */
export function resultHead(rec) {
  const r = rec.result, bands = r.bands || DEFAULT_BANDS, band = bandOf(r.overall_score, bands), human = humanProbability(r.overall_score);
  const segs = [{ label: "AI probability", value: r.overall_score, color: COLORS.ai }, { label: "Human probability", value: human, color: COLORS.human }];
  return h("div", { class: `result-main band-${band}` },
    h("div", { class: "donut-box", html: donut(segs, { centerValue: pct(r.overall_score, 0), centerLabel: "AI score", label: "AI versus human probability" }) }),
    h("div", { class: "grow" },
      h("div", { class: "verdict-line" }, verdictBadge(r.verdict), h("span", { class: "muted" }, rec.title)),
      h("div", { class: "prob-row" },
        h("div", {}, h("span", { class: "k" }, "AI probability"), h("b", { class: "ai-t" }, pct(r.overall_score))),
        h("div", {}, h("span", { class: "k" }, "Human probability"), h("b", { class: "human-t" }, pct(human)))),
      scaleGauge(r.overall_score, bands, "Document score"), h("p", { class: "explain" }, verdictExplanation(r))));
}
