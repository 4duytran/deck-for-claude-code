// claude-deck — usage report: pure aggregation of estimator events into the
// usage page payload (buckets, totals, shares, per-model, per-day). No IO, no
// app state. Costs come from usage-prices: an API list-price ESTIMATE, never a bill.
'use strict';

const { priceOf, costOf } = require('./usage-prices');

const HOUR_MS = 3600000;
const PERIODS = { '24h': { hourly: true, n: 24 }, '7d': { n: 7 }, '30d': { n: 30 }, '90d': { n: 90 } };
const MAX_PROJECTS = 5;

const formatters = new Map();

// Wall-clock fields of an instant in `tz` (Number values: year, month, day, hour, minute, second).
function wall(ts, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ts)) p[type] = +value;
  return p;
}

// UTC offset (ms) of `tz` at the instant `ts`.
function offsetAt(ts, tz) {
  const w = wall(ts, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour % 24, w.minute, w.second) - Math.floor(ts / 1000) * 1000;
}

const dayKey = w => `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;

// First instant of the local calendar day whose civil date is `civilMs` (UTC midnight of that date).
// Candidates use the offsets of the day before, of the day and of the day after; the earliest one
// that really shows that date wins (a fall-back day can hold local midnight twice). A skipped
// date (a zone that jumps over a day) has no candidate and falls back to the later of two passes.
function dayStart(civilMs, tz) {
  const want = new Date(civilMs).toISOString().slice(0, 10);
  let best = null;
  for (const probe of [civilMs - 86400000, civilMs, civilMs + 86400000]) {
    const x = civilMs - offsetAt(probe, tz);
    if (dayKey(wall(x, tz)) === want && (best === null || x < best)) best = x;
  }
  if (best !== null) return best;
  const a = civilMs - offsetAt(civilMs, tz);
  return Math.max(a, civilMs - offsetAt(a, tz));
}

// Ascending bucket boundaries [start0 .. startN, endN]. Days are counted on the
// civil calendar (never ts + 24 h), hours as elapsed hours from the current local hour.
function boundsFor(spec, nowMs, tz) {
  const bounds = [];
  if (spec.hourly) {
    const off = offsetAt(nowMs, tz);
    const hourStart = Math.floor((nowMs + off) / HOUR_MS) * HOUR_MS - off;
    for (let k = 0; k <= spec.n; k++) bounds.push(hourStart - (spec.n - 1 - k) * HOUR_MS);
    return bounds;
  }
  const w = wall(nowMs, tz);
  for (let k = 0; k <= spec.n; k++) {
    bounds.push(dayStart(Date.UTC(w.year, w.month - 1, w.day - (spec.n - 1) + k), tz));
  }
  return bounds;
}

// Index i with bounds[i] <= ts < bounds[i + 1], or -1 outside the window.
function indexIn(bounds, ts) {
  const last = bounds.length - 1;
  if (ts < bounds[0] || ts >= bounds[last]) return -1;
  let lo = 0;
  let hi = last - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid] <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const acc = () => ({ inp: 0, cc: 0, cr: 0, out: 0, cost: 0, priced: 0, unpricedTok: 0 });

function add(a, inp, cc, cr, out, cost) {
  a.inp += inp; a.cc += cc; a.cr += cr; a.out += out;
  if (cost === null) a.unpricedTok += inp + cc + cr + out;
  else { a.cost += cost; a.priced++; }
}

function merge(into, a) {
  into.inp += a.inp; into.cc += a.cc; into.cr += a.cr; into.out += a.out;
  into.cost += a.cost; into.priced += a.priced; into.unpricedTok += a.unpricedTok;
}

const tokOf = a => ({ inp: a.inp, cc: a.cc, cr: a.cr, out: a.out });
const sumTok = a => a.inp + a.cc + a.cr + a.out;
// null only when the aggregate holds tokens and none of them could be priced.
const costOut = a => (a.priced === 0 && a.unpricedTok > 0 ? null : a.cost);

function topProjects(byProj) {
  return [...byProj].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_PROJECTS).map(p => p[0]);
}

// events: estimator events {ts, model, sid, proj, speed, inp, cc5, cc1h, cr, out, ...}.
// period: '24h' (hourly buckets) | '7d' | '30d' | '90d' (local calendar days in `tz`).
// Bucket `t` = epoch ms of the bucket start. Cache tokens: cc = cache writes, cr = cache reads.
function buildReport(events, period, nowMs, tz) {
  const spec = Object.hasOwn(PERIODS, period) ? PERIODS[period] : null;
  if (!spec) throw new RangeError(`unknown usage period: ${period}`);
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bounds = boundsFor(spec, Number.isFinite(nowMs) ? nowMs : Date.now(), zone);
  const buckets = Array.from({ length: spec.n }, acc);
  const total = acc();
  const models = new Map();
  const sids = new Set();
  const costByType = { inp: 0, cc: 0, cr: 0, out: 0 };
  const costBySpeed = { standard: 0, fast: 0 };
  let cacheSavings = 0;

  for (const e of events || []) {
    if (!e || !Number.isFinite(e.ts)) continue;
    const i = indexIn(bounds, e.ts);
    if (i < 0) continue;
    const inp = e.inp || 0;
    const cc5 = e.cc5 || 0;
    const cc1h = e.cc1h || 0;
    const cr = e.cr || 0;
    const out = e.out || 0;
    const cc = cc5 + cc1h;
    const n = inp + cc + cr + out;
    if (!(n > 0)) continue;
    const cost = costOf(e);
    const name = typeof e.model === 'string' && e.model ? e.model : 'unknown';
    let m = models.get(name);
    if (!m) { m = acc(); m.proj = new Map(); models.set(name, m); }
    add(buckets[i], inp, cc, cr, out, cost);
    add(total, inp, cc, cr, out, cost);
    add(m, inp, cc, cr, out, cost);
    if (e.proj) m.proj.set(e.proj, (m.proj.get(e.proj) || 0) + n);
    if (e.sid) sids.add(e.sid);
    if (cost === null) continue;
    const r = priceOf(e.model, e.speed, inp + cc + cr);
    costByType.inp += inp * r.inp / 1e6;
    costByType.cc += (cc5 * r.cc5 + cc1h * r.cc1h) / 1e6;
    costByType.cr += cr * r.cr / 1e6;
    costByType.out += out * r.out / 1e6;
    costBySpeed[e.speed === 'fast' ? 'fast' : 'standard'] += cost;
    cacheSavings += cr * (r.inp - r.cr) / 1e6;
  }

  const days = new Map();
  buckets.forEach((a, i) => {
    if (sumTok(a) === 0) return;
    const day = dayKey(wall(bounds[i], zone));
    let d = days.get(day);
    if (!d) { d = acc(); days.set(day, d); }
    merge(d, a);
  });

  const byModel = [...models].map(([model, a]) => {
    const cost = costOut(a);
    return { model, cost, share: cost !== null && total.cost > 0 ? cost / total.cost : null, tok: tokOf(a), projects: topProjects(a.proj) };
  }).sort((x, y) => (y.cost !== null) - (x.cost !== null)
    || (y.cost || 0) - (x.cost || 0)
    || sumTok(y.tok) - sumTok(x.tok)
    || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0));

  return {
    period,
    buckets: buckets.map((a, i) => ({ t: bounds[i], cost: costOut(a), tok: tokOf(a) })),
    totals: {
      processed: sumTok(total), cachedInput: total.cr, uncachedInput: total.inp + total.cc, output: total.out,
      cacheSavings, cost: costOut(total), unpricedTokens: total.unpricedTok,
    },
    shares: { tokensByType: tokOf(total), costByType, costBySpeed },
    byModel,
    byDay: [...days].reverse().map(([day, a]) => ({ day, cost: costOut(a), tok: tokOf(a) })),
    sessions: sids.size,
  };
}

module.exports = { buildReport };
