// Minimal SVG time-series chart: two value lines on their own scales plus
// shaded bars for pump run time. No dependencies.

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

/**
 * points: [{ts (ms), t, soil, pump (0-100)}], sorted by ts.
 * opts: {tempMax, soilMin, colors: {t, soil, pump, grid, text}}
 */
export function drawHistory(svg, points, opts) {
  const W = svg.clientWidth || 600, H = svg.clientHeight || 240;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const pad = { l: 40, r: 40, t: 12, b: 26 };
  const c = opts.colors;
  if (points.length < 2) {
    el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: c.text, "font-size": 13 }, svg).textContent = "รอข้อมูล…";
    return;
  }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const x = (ts) => pad.l + ((ts - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const temps = points.map((p) => p.t).filter((v) => v != null);
  // Whole-degree axis split into 4 equal steps, so every label is an integer.
  const tLo = Math.floor(Math.min(...temps, opts.tempMax) - 1);
  const tHi = tLo + Math.ceil((Math.max(...temps, opts.tempMax) + 1 - tLo) / 4) * 4;
  const yT = (v) => pad.t + (1 - (v - tLo) / (tHi - tLo)) * (H - pad.t - pad.b);
  const yS = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);

  // grid + axis labels (left: °C, right: soil %)
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * (H - pad.t - pad.b);
    el("line", { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: c.grid, "stroke-width": 1 }, svg);
    el("text", { x: pad.l - 6, y: y + 4, "text-anchor": "end", fill: c.t, "font-size": 11 }, svg).textContent = (tHi - (i / 4) * (tHi - tLo)).toFixed(0);
    el("text", { x: W - pad.r + 6, y: y + 4, fill: c.soil, "font-size": 11 }, svg).textContent = `${100 - i * 25}%`;
  }
  const span = t1 - t0;
  const step = span > 50 * 60000 ? 15 * 60000 : span > 20 * 60000 ? 10 * 60000 : 5 * 60000;
  for (let ts = Math.ceil(t0 / step) * step; ts <= t1; ts += step) {
    const label = new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    el("text", { x: x(ts), y: H - 8, "text-anchor": "middle", fill: c.text, "font-size": 11 }, svg).textContent = label;
  }

  // pump run time as bars along the bottom; each bar spans until the next point
  points.forEach((p, i) => {
    if (!p.pump) return;
    const next = points[i + 1];
    const w = Math.min(40, Math.max(1.5, next ? x(next.ts) - x(p.ts) : 3));
    const h = (p.pump / 100) * 22;
    el("rect", { x: x(p.ts), y: H - pad.b - h, width: w, height: h, fill: c.pump, opacity: 0.55 }, svg);
  });

  // thresholds
  el("line", { x1: pad.l, x2: W - pad.r, y1: yT(opts.tempMax), y2: yT(opts.tempMax), stroke: c.t, "stroke-dasharray": "4 4", opacity: 0.6 }, svg);
  el("line", { x1: pad.l, x2: W - pad.r, y1: yS(opts.soilMin), y2: yS(opts.soilMin), stroke: c.soil, "stroke-dasharray": "4 4", opacity: 0.6 }, svg);

  const path = (key, y) => points.filter((p) => p[key] != null).map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  el("path", { d: path("soil", yS), fill: "none", stroke: c.soil, "stroke-width": 2.2, "stroke-linejoin": "round" }, svg);
  el("path", { d: path("t", yT), fill: "none", stroke: c.t, "stroke-width": 2.2, "stroke-linejoin": "round" }, svg);
}

/** Tiny sparkline for a sensor card. */
export function drawSpark(svg, values, color) {
  const W = svg.clientWidth || 160, H = svg.clientHeight || 36;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  if (values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values);
  const range = hi - lo || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / range) * (H - 6)).toFixed(1)}`).join("");
  el("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
}
