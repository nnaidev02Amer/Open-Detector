// Chart builders: pure functions returning SVG strings (no DOM access, no libraries).
// Every label that may come from data is escaped; numbers are coerced and clamped.

export const COLORS = { human: "#34d6c0", uncertain: "#f5b84b", ai: "#f2668b", indigo: "#6366f1", indigoSoft: "#818cf8" };

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const f1 = (v) => (Math.round(v * 10) / 10).toString();
let uid = 0;

/** Donut. segments: [{label, value, color}], opts: {size, thickness, centerValue, centerLabel}. Empty / all-zero -> empty ring. */
export function donut(segments, opts = {}) {
  const size = opts.size || 190, th = opts.thickness || 16, r = (size - 28) / 2, c = size / 2, circ = 2 * Math.PI * r;
  const segs = (segments || []).map((s) => ({ ...s, value: Math.max(0, num(s.value)) }));
  const total = segs.reduce((a, s) => a + s.value, 0);
  let off = 0, arcs = "";
  if (total > 0) {
    for (const s of segs) {
      if (!s.value) continue;
      const len = (s.value / total) * circ, gap = segs.filter((x) => x.value).length > 1 ? 3 : 0;
      arcs += `<circle class="seg" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${esc(s.color)}" stroke-width="${th}" stroke-linecap="butt"` +
        ` stroke-dasharray="${f1(Math.max(0, len - gap))} ${f1(circ - Math.max(0, len - gap))}" stroke-dashoffset="${f1(-off)}" transform="rotate(-90 ${c} ${c})">` +
        `<title>${esc(s.label)}: ${s.value} (${f1((s.value / total) * 100)}%)</title></circle>`;
      off += len;
    }
  }
  const cv = opts.centerValue != null ? `<text x="${c}" y="${c + 4}" text-anchor="middle" style="fill:#e9edfb;font:700 26px var(--display)">${esc(opts.centerValue)}</text>` : "";
  const cl = opts.centerLabel ? `<text x="${c}" y="${c + 24}" text-anchor="middle">${esc(opts.centerLabel)}</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.label || "Donut chart")}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(129,140,248,.12)" stroke-width="${th}"/><g class="donut">${arcs}</g>${cv}${cl}</svg>`;
}

/** Bar chart / histogram. values: number[], opts: {labels, height, colors|color, yMax, label}. */
export function bars(values, opts = {}) {
  const vals = (values || []).map((v) => Math.max(0, num(v))), n = vals.length || 1;
  const W = 520, H = opts.height || 200, pl = 30, pb = 26, pt = 10, pr = 6, iw = W - pl - pr, ih = H - pb - pt;
  const rawMax = Math.max(opts.yMax || 0, ...vals, 1), tick = Math.ceil(rawMax / 4), max = tick * 4, step = iw / n, bw = Math.min(56, Math.max(4, step * 0.72)), id = `bg${++uid}`;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = pt + ih - (ih * i) / 4;
    g += `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${f1(y)}" y2="${f1(y)}"/><text x="${pl - 6}" y="${f1(y + 4)}" text-anchor="end">${Math.round((max * i) / 4)}</text>`;
  }
  let b = "";
  vals.forEach((v, i) => {
    const h = (v / max) * ih, x = pl + i * step + (step - bw) / 2, col = (opts.colors && opts.colors[i]) || opts.color || `url(#${id})`;
    b += `<rect class="bar" x="${f1(x)}" y="${f1(pt + ih - h)}" width="${f1(bw)}" height="${f1(Math.max(h, v > 0 ? 2 : 0))}" rx="4" fill="${col}" style="animation-delay:${i * 40}ms">` +
      `<title>${esc(opts.labels ? opts.labels[i] : i + 1)}: ${v}</title></rect>`;
    if (opts.labels) b += `<text x="${f1(x + bw / 2)}" y="${H - 8}" text-anchor="middle">${esc(opts.labels[i])}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Bar chart")}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#818cf8"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs>${g}<g class="bars">${b}</g></svg>`;
}

/** Line/area chart. points: [{x: label, y: number|null}], opts: {height, yMax, yFormat, label}. Null y values leave gaps. */
export function line(points, opts = {}) {
  const pts = points || [], n = pts.length, W = 520, H = opts.height || 200, pl = 34, pr = 10, pt = 12, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const ys = pts.map((p) => (p.y == null ? null : num(p.y)));
  const max = Math.max(opts.yMax || 0, ...ys.filter((v) => v != null), 1), id = `lg${++uid}`;
  const X = (i) => pl + (n === 1 ? iw / 2 : (iw * i) / (n - 1)), Y = (v) => pt + ih - (v / max) * ih;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = pt + ih - (ih * i) / 4, val = (max * i) / 4;
    g += `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${f1(y)}" y2="${f1(y)}"/><text x="${pl - 6}" y="${f1(y + 4)}" text-anchor="end">${opts.yFormat ? esc(opts.yFormat(val)) : Math.round(val)}</text>`;
  }
  let path = "", area = "", started = false, dots = "", seg = [];
  const flush = () => { if (seg.length > 1) area += `<path d="M${seg[0][0]},${pt + ih} ${seg.map((p) => `L${p[0]},${p[1]}`).join(" ")} L${seg[seg.length - 1][0]},${pt + ih}Z" fill="url(#${id})"/>`; seg = []; };
  ys.forEach((v, i) => {
    if (v == null) { started = false; flush(); return; }
    const x = f1(X(i)), y = f1(Y(v));
    path += `${started ? "L" : "M"}${x},${y} `; started = true; seg.push([x, y]);
    dots += `<circle class="pt" cx="${x}" cy="${y}" r="4" fill="#0a1020" stroke="#818cf8" stroke-width="2"><title>${esc(pts[i].x)}: ${opts.yFormat ? esc(opts.yFormat(v)) : v}</title></circle>`;
  });
  flush();
  const every = Math.max(1, Math.ceil(n / 6));
  const xl = pts.map((p, i) => (i % every === 0 || i === n - 1 ? `<text x="${f1(X(i))}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>` : "")).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Line chart")}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f1" stop-opacity=".38"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>` +
    `${g}${area}<path class="line-path" d="${path.trim()}" fill="none" stroke="#818cf8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${xl}</svg>`;
}

/** Horizontal meter 0..1 as an HTML string. */
export function meter(value) {
  const v = Math.min(1, Math.max(0, num(value)));
  return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v * 100)}"><i style="width:${f1(v * 100)}%"></i></div>`;
}

export function legend(items) {
  return `<div class="legend">${(items || []).map((i) => `<div><i style="background:${esc(i.color)}"></i>${esc(i.label)}<b>${esc(i.value)}</b></div>`).join("")}</div>`;
}
