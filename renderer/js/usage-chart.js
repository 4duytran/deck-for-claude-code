// claude-deck — renderer/usage-chart: the cost / token curve of the usage page.
// monotonePath / niceTicks / xLabels / bucketValue are pure (they load in plain
// Node). renderChart(host, {buckets, metric, period}) is the only DOM entry: it
// reads no global (host.ownerDocument), paints with tokens.css custom
// properties and writes text through textContent only.
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_W = 640;
const H = 220;
const PAD = { l: 48, r: 14, t: 12, b: 26 };
const NICE = [1, 2, 2.5, 5, 10];
const MAX_DAY_LABELS = { '7d': 7, '30d': 6, '90d': 6 };
const HOUR_LABEL_STEP = 4;
const TIP_GAP = 12;
const AXIS_FONT = 'var(--font-mono)';
let gradSeq = 0; // unique gradient id per paint, so a url(#id) never meets a stale defs
const USD = ' $';

const nf = (o) => new Intl.NumberFormat('fr-FR', o);
const NF_COMPACT = nf({ notation: 'compact', maximumFractionDigits: 1 });
const NF_INT = nf({ maximumFractionDigits: 0 });
const NF_TICK = nf({ maximumSignificantDigits: 3 });
const NF_COST = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF_COST_SMALL = nf({ minimumFractionDigits: 3, maximumFractionDigits: 3 });
const DAY_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

const rnd = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pad2 = (v) => String(v).padStart(2, '0');
const validDate = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t) : null);

export function bucketValue(b, metric) {
  if (metric === 'tok') {
    const t = (b && b.tok) || {};
    return num(t.inp) + num(t.cc) + num(t.cr) + num(t.out);
  }
  return num(b && b.cost);
}

// Monotone cubic through the points (d3 monotoneX tangents: no overshoot
// between two points). Points are {x, y} or [x, y]; x must increase.
export function monotonePath(points) {
  const pts = [];
  for (const p of Array.isArray(points) ? points : []) {
    const x = Array.isArray(p) ? p[0] : p && p.x;
    const y = Array.isArray(p) ? p[1] : p && p.y;
    if (Number.isFinite(x) && Number.isFinite(y) && (!pts.length || x > pts[pts.length - 1][0])) {
      pts.push([x, y]);
    }
  }
  const n = pts.length;
  if (!n) return '';
  let d = `M${rnd(pts[0][0])} ${rnd(pts[0][1])}`;
  if (n === 1) return d;
  const h = [];
  const s = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1][0] - pts[i][0];
    s[i] = (pts[i + 1][1] - pts[i][1]) / h[i];
  }
  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i]);
    m[i] = (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0;
  }
  m[0] = n === 2 ? s[0] : (3 * s[0] - m[1]) / 2;
  m[n - 1] = n === 2 ? s[0] : (3 * s[n - 2] - m[n - 2]) / 2;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const k = h[i] / 3;
    d += `C${rnd(x0 + k)} ${rnd(y0 + k * m[i])} ${rnd(x1 - k)} ${rnd(y1 - k * m[i + 1])} ${rnd(x1)} ${rnd(y1)}`;
  }
  return d;
}

// 4-5 round ticks from 0 (step in {1, 2, 2.5, 5} x 10^k) with the last >= max.
export function niceTicks(max, count = 4) {
  const cnt = Number.isFinite(count) && count >= 2 ? Math.floor(count) : 4;
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  if (!top) return Array.from({ length: cnt + 1 }, (_, i) => i);
  const raw = top / cnt;
  const mag = Math.pow(10, Math.floor(Math.log10(raw) + 1e-12));
  const step = (NICE.map((f) => f * mag).find((v) => v >= raw)) || 10 * mag;
  const intervals = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: intervals + 1 }, (_, i) => +(i * step).toPrecision(12));
}

// [{i, label}] — i indexes `buckets`. Labels come from each bucket's own local
// start (never t0 + k * 24 h), so a 23 h / 25 h day cannot skip or repeat one.
export function xLabels(buckets, period) {
  const list = Array.isArray(buckets) ? buckets : [];
  const out = [];
  if (period === '24h') {
    const seen = new Set();
    list.forEach((b, i) => {
      const d = validDate(b && b.t);
      if (!d || d.getMinutes() || d.getHours() % HOUR_LABEL_STEP) return;
      const label = `${pad2(d.getHours())} h`;
      if (seen.has(label)) return;
      seen.add(label);
      out.push({ i, label });
    });
    return out;
  }
  const step = Math.max(1, Math.ceil(list.length / (MAX_DAY_LABELS[period] || 6)));
  for (let i = list.length - 1; i >= 0; i -= step) {
    const d = validDate(list[i] && list[i].t);
    if (d) out.unshift({ i, label: DAY_FMT.format(d) });
  }
  return out;
}

const axisText = (v, metric) => (metric === 'tok' ? NF_COMPACT.format(v) : NF_TICK.format(v) + USD);
const valueText = (v, metric) =>
  metric === 'tok' ? `${NF_INT.format(v)} tokens` : (v > 0 && v < 0.1 ? NF_COST_SMALL : NF_COST).format(v) + USD;

function titleOf(t, period) {
  const d = validDate(t);
  if (!d) return '';
  return period === '24h' ? `${DATE_FMT.format(d)}, ${pad2(d.getHours())} h` : DATE_FMT.format(d);
}

function svgEl(doc, tag, attrs, style, parent) {
  const e = doc.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (style) Object.assign(e.style, style);
  if (parent) parent.appendChild(e);
  return e;
}

export function renderChart(host, opts) {
  const { buckets, metric, period } = opts || {};
  const doc = host.ownerDocument;
  const list = Array.isArray(buckets) ? buckets : [];
  const n = list.length;
  const vals = list.map((b) => bucketValue(b, metric));
  const ticks = niceTicks(Math.max(0, ...vals), 4);
  const top = ticks[ticks.length - 1];
  const W = Math.max(280, Math.round(host.clientWidth) || DEFAULT_W);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const base = PAD.t + plotH;
  const px = (i) => PAD.l + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2);
  const py = (v) => base - (v / top) * plotH;

  const wrap = doc.createElement('div');
  wrap.className = 'uc-chart';
  Object.assign(wrap.style, { position: 'relative', width: '100%' });
  const svg = svgEl(doc, 'svg', {
    class: 'uc-svg',
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    role: 'img',
    'aria-label': metric === 'tok' ? 'Courbe des tokens' : 'Courbe du coût',
  }, { display: 'block', height: 'auto', touchAction: 'pan-y' }, wrap);

  for (const v of ticks) {
    const y = py(v);
    svgEl(doc, 'line', { class: 'uc-grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y },
      { stroke: 'var(--rule)', strokeWidth: '1' }, svg);
    const lab = svgEl(doc, 'text', { class: 'uc-ylabel', x: PAD.l - 8, y, dy: '0.32em', 'text-anchor': 'end' },
      { fill: 'var(--ink-3)', fontSize: '11px', fontFamily: AXIS_FONT, fontVariantNumeric: 'tabular-nums' }, svg);
    lab.textContent = axisText(v, metric);
  }

  if (!n) {
    const empty = svgEl(doc, 'text', { class: 'uc-empty', x: PAD.l + plotW / 2, y: PAD.t + plotH / 2, 'text-anchor': 'middle' },
      { fill: 'var(--ink-3)', fontSize: '12px' }, svg);
    empty.textContent = 'Aucune donnée';
    host.replaceChildren(wrap);
    return;
  }

  const line = monotonePath(vals.map((v, i) => ({ x: px(i), y: py(v) })));
  if (n > 1) {
    // Vertical fade of the line colour (--m-1 .28 -> .02); built with createElementNS, no markup string.
    const defs = svgEl(doc, 'defs', {}, null, svg);
    const grad = svgEl(doc, 'linearGradient', { id: `uc-fill-${++gradSeq}`, x1: 0, y1: 0, x2: 0, y2: 1 }, null, defs);
    svgEl(doc, 'stop', { offset: 0 }, { stopColor: 'var(--m-1)', stopOpacity: '0.28' }, grad);
    svgEl(doc, 'stop', { offset: 1 }, { stopColor: 'var(--m-1)', stopOpacity: '0.02' }, grad);
    svgEl(doc, 'path', { class: 'uc-area', d: `${line}L${rnd(px(n - 1))} ${rnd(base)}L${rnd(px(0))} ${rnd(base)}Z` },
      { fill: `url(#${grad.id})`, stroke: 'none' }, svg);
  }
  svgEl(doc, 'path', { class: 'uc-line', d: line },
    { fill: 'none', stroke: 'var(--m-1)', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' }, svg);

  for (const { i, label } of xLabels(list, period)) {
    const t = svgEl(doc, 'text', {
      class: 'uc-xlabel', x: px(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
    }, { fill: 'var(--ink-3)', fontSize: '11px', fontFamily: AXIS_FONT, fontVariantNumeric: 'tabular-nums' }, svg);
    t.textContent = label;
  }

  // Hover: a solid hairline, the point in the line colour ringed by the ground, the tooltip on the pop surface.
  const cross = svgEl(doc, 'line', { class: 'uc-cross', y1: PAD.t, y2: base },
    { stroke: 'var(--rule-2)', strokeWidth: '1', display: 'none' }, svg);
  const dot = svgEl(doc, 'circle', { class: 'uc-dot', r: 4.5 },
    { fill: 'var(--m-1)', stroke: 'var(--ground)', strokeWidth: '2', display: 'none' }, svg);

  // Solid surface on purpose: no backdrop-filter on a tooltip (CD blur allowlist).
  const tip = doc.createElement('div');
  tip.className = 'uc-tip';
  Object.assign(tip.style, {
    position: 'absolute', left: '0px', top: '0px', display: 'none', zIndex: '2', pointerEvents: 'none',
    whiteSpace: 'nowrap', padding: '6px 10px', lineHeight: '1.35', color: 'var(--ink-2)',
    background: 'var(--surface-pop)', border: '0', borderRadius: '7px',
    boxShadow: 'inset 0 0 0 1px var(--rule-2), 0 10px 24px rgba(0, 0, 0, 0.45)',
  });
  const tipT = doc.createElement('div');
  tipT.className = 'uc-tip-t';
  Object.assign(tipT.style, { fontSize: '11px', color: 'var(--ink-3)' });
  const tipV = doc.createElement('div');
  tipV.className = 'uc-tip-v';
  Object.assign(tipV.style, { fontSize: '13px', fontWeight: '500', color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' });
  tip.appendChild(tipT);
  tip.appendChild(tipV);
  wrap.appendChild(tip);

  const hide = () => {
    cross.style.display = 'none';
    dot.style.display = 'none';
    tip.style.display = 'none';
  };
  const show = (i, rect) => {
    const k = rect.width / W;
    const x = px(i) * k;
    const y = py(vals[i]) * k;
    cross.setAttribute('x1', px(i));
    cross.setAttribute('x2', px(i));
    dot.setAttribute('cx', px(i));
    dot.setAttribute('cy', py(vals[i]));
    cross.style.display = '';
    dot.style.display = '';
    tipT.textContent = titleOf(list[i] && list[i].t, period);
    tipV.textContent = valueText(vals[i], metric);
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    // Right of the crosshair, above the point; flip left / below at an edge.
    let left = x + TIP_GAP;
    if (left + tw > rect.width) left = x - TIP_GAP - tw;
    left = Math.max(0, Math.min(left, rect.width - tw));
    let topPx = y - th - TIP_GAP;
    if (topPx < 0) topPx = y + TIP_GAP;
    topPx = Math.max(0, Math.min(topPx, rect.height - th));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(topPx)}px`;
  };

  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = n > 1 ? Math.round(((vx - PAD.l) / plotW) * (n - 1)) : 0;
    show(Math.max(0, Math.min(n - 1, i)), rect);
  });
  svg.addEventListener('pointerleave', hide);

  host.replaceChildren(wrap);
}
