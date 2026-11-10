// claude-deck — renderer/usage-page: full-window usage overlay (#usage-page),
// built here in JS (no markup in index.html). Tabs « Coût » / « Tokens » read
// the main-process report (window.api.getUsageReport, bundled API price table:
// an ESTIMATE, never a bill); « Limites » shows the 5 h / 7 d quota windows
// from window.api.getUsage() + notifyUsageUpdate(). External data reaches the
// DOM through textContent only. usage.js initUsage() owns the usage-update listener.
// Imports are one-way: git-panel.js / plans-panel.js never reach this module.
'use strict';

import { closeSidePanel } from './side-panel.js';
import { overlayState } from './state.js';
import { expand, collapse, exitThen, spinWhile } from './motion.js';
import { renderChart } from './usage-chart.js';
import { shimmer, progressBar } from './loading.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NBSP = ' ';
const NNBSP = ' ';
const TAB_KEY = 'deck-usage-tab';
const PERIOD_KEY = 'deck-usage-period';
const PRICE_DATE = '27/10/2026'; // date of the bundled price table (usage-prices.js)
const STALE_MS = 60 * 1000; // a cached report older than this is refetched when shown
const TICK_MS = 30 * 1000; // local countdown refresh while « Limites » is visible
const WARMING_RETRY_MS = 1000; // a warming report (estimator cold pass) is asked again after this delay
const WARMING_MAX_MS = 30 * 1000; // ... for at most this long, then the error line

const TABS = [
  { id: 'cost', label: 'Coût', icon: 'coins' },
  { id: 'tokens', label: 'Tokens', icon: 'layers' },
  { id: 'limits', label: 'Limites', icon: 'gauge' },
];
const PERIODS = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 j' },
  { id: '30d', label: '30 j' },
  { id: '90d', label: '90 j' },
];
const TOKEN_TYPES = [
  ['inp', 'Entrée'], ['cc', 'Écriture cache'], ['cr', 'Lecture cache'], ['out', 'Sortie'],
];
const SPEEDS = [['standard', 'Standard'], ['fast', 'Rapide']];
// Measure colours: the chart line is --m-1, the token types take --m-1..4 in the order above, and the
// model rows take them in share order. Speed rows and models past the fourth stay neutral.
const MEASURE = ['var(--m-1)', 'var(--m-2)', 'var(--m-3)', 'var(--m-4)'];
const TYPE_COLOUR = Object.fromEntries(TOKEN_TYPES.map(([k], i) => [k, MEASURE[i]]));

function swatch() {
  const sw = document.createElement('i');
  sw.className = 'up-sw';
  sw.setAttribute('aria-hidden', 'true');
  return sw;
}
const WINDOWS = [
  { key: 'five_hour', title: 'Fenêtre de 5 h' },
  { key: 'seven_day', title: 'Fenêtre de 7 j' },
];
const PLANS = [
  { id: null, label: 'Non défini' }, { id: 'pro', label: 'Pro' }, { id: 'max', label: 'Max' }, { id: 'ultra', label: 'Ultra' },
];
const PLAN_WEEKLY = { max: '5× l’usage Pro par semaine', ultra: '10× l’usage Pro par semaine' };
const SOURCE_LABEL = {
  official: 'serveur',
  anchored: 'officiel + activité locale',
  stale: 'officiel figé',
  estimated: 'estimation transcripts',
};
// Divergence caveat per source (same wording as the header gauges' tips in usage.js).
const SOURCE_TIP = {
  official: 'source : serveur (statusline)',
  anchored: 'source : officiel + activité locale projetée (échelle P90 personnelle) — peut diverger du réel',
  stale: 'source : officiel figé — activité locale non comptée depuis la dernière collecte',
  estimated: 'source : estimation transcripts (règle Usage Monitor, échelle P90) — fenêtre et % approximatifs',
};
const TAB_IDS = TABS.map((t) => t.id);
const PERIOD_IDS = PERIODS.map((p) => p.id);

// ---------- pure formatters (French) ----------

const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);

function fr(n, dec) {
  const [i, f] = Math.abs(n).toFixed(dec).split('.');
  return (n < 0 ? '−' : '') + group(i) + (f ? `,${f}` : '');
}

// USD estimate; null (unpriced) and non-numbers render as a dash, never a guess.
export function fmtMoney(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  if (usd > 0 && usd < 0.01) return `< 0,01${NBSP}$`;
  return `${fr(usd, 2)}${NBSP}$`;
}

export function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? fr(Math.round(n), 0) : '—';
}

const TOKEN_UNITS = [[1e3, 'k'], [1e6, 'M'], [1e9, 'Md']];

// Compact count, three significant digits: 842, 1,23 k, 12,3 k, 123 k, 1,5 M, 3,45 Md.
export function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (Math.round(n) < 1000) return String(Math.round(n));
  let u = 0;
  while (u < TOKEN_UNITS.length - 1 && n >= TOKEN_UNITS[u + 1][0]) u++;
  const text = (idx) => {
    const v = n / TOKEN_UNITS[idx][0];
    const s = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  };
  let s = text(u);
  if (Number(s) >= 1000 && u < TOKEN_UNITS.length - 1) { u++; s = text(u); } // 999 500 -> 1 M
  return `${s.replace('.', ',')}${NBSP}${TOKEN_UNITS[u][1]}`;
}

export function fmtShare(frac) {
  if (typeof frac !== 'number' || !Number.isFinite(frac)) return '—';
  const p = frac * 100;
  if (p > 0 && p < 1) return `< 1${NBSP}%`;
  return `${Math.round(p)}${NBSP}%`;
}

// resets_at and nowSec are epoch SECONDS (statusline format, as in usage.js).
export function fmtCountdown(resetsAt, nowSec) {
  if (typeof resetsAt !== 'number') return '';
  const diff = resetsAt - nowSec;
  if (diff <= 0) return 'imminente';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `dans ${d} j ${h} h`;
  if (h > 0) return `dans ${h} h ${String(m).padStart(2, '0')}`;
  return `dans ${Math.max(m, 1)} min`;
}

function fmtResetAt(resetsAt, nowSec) {
  if (typeof resetsAt !== 'number') return '';
  const d = new Date(resetsAt * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date(nowSec * 1000).toDateString();
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('fr-FR', opts);
}

function fmtAge(s) {
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

// byDay `day` is a local civil date « YYYY-MM-DD »: build it from components (no UTC drift).
export function fmtDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return String(day);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

// One quota window as the gauges show it (usage.js applyUsage): a window whose reset
// already passed counts as empty; thresholds 50 / 80 on the USED figure.
export function limitView(w, nowSec) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  const expired = !!w.resets_at && nowSec > w.resets_at;
  const used = expired ? 0 : Math.min(100, Math.max(0, Math.round(w.used_percentage)));
  return { used, left: 100 - used, level: used >= 80 ? 'alert' : used >= 50 ? 'warm' : 'ok', expired };
}

// ---------- state ----------

function loadPref(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch (_) { return fallback; }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* private mode / quota — cosmetic */ }
}

const st = {
  open: false,
  tab: loadPref(TAB_KEY, TAB_IDS, 'limits'),
  period: loadPref(PERIOD_KEY, PERIOD_IDS, '7d'),
  by: 'model', // breakdown: 'model' | 'day'
};

// Read-only view for the probe seam (L26) and the gates (L32).
export const usageState = Object.freeze({
  get open() { return st.open; },
  get tab() { return st.tab; },
  get period() { return st.period; },
});

const reports = new Map(); // period -> { report, at, sig }
const inflight = new Map(); // period -> Promise (one fetch per period at a time)
const failed = new Set(); // periods whose last fetch failed
let limits = null; // { five_hour, seven_day } — getUsage / notifyUsageUpdate payload
let limitsSeq = 0; // bumped by every payload; a slower getUsage() answer is dropped
let limitsBusy = false;
let limitsUser = false; // the running « Limites » load was started by the refresh button
const userLoads = new Set(); // periods whose running fetch the refresh button started over a shown report
let plan = null; // the Claude plan of the last payload: 'pro' | 'max' | 'ultra' | null (Non défini)
let limitsBar = null; // the progress strip of the « Limites » pane, or null
let reportBar = null; // the progress strip over the page for a refresh of a shown report, or null
let shownKey = null; // report pane content signature (skip identical re-renders)
let tickTimer = null;
let root = null;
let refs = null;

// ---------- DOM helpers (textContent only) ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#lc-${name}`);
  svg.appendChild(use);
  return svg;
}

function button(cls, label, iconName, ariaLabel) {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.appendChild(icon(iconName));
  if (label) b.appendChild(el('span', 'up-btn-label', label));
  if (ariaLabel) { b.setAttribute('aria-label', ariaLabel); b.title = ariaLabel; }
  return b;
}

// hidden attribute AND inline display: author CSS cannot revive a hidden section.
function setShown(node, on) {
  node.hidden = !on;
  node.style.display = on ? '' : 'none';
}

const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const sumTok = (t) => t.inp + t.cc + t.cr + t.out;

// ---------- overlay shell ----------

function ensureRoot() {
  if (root) return;
  root = el('aside');
  root.id = 'usage-page';
  root.tabIndex = -1;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Usage');
  setShown(root, false);

  const head = el('header', 'up-head');
  const tabs = el('div', 'up-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabBtns = TABS.map((t) => {
    const b = button('up-tab', t.label, t.icon);
    b.dataset.tab = t.id;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => setTab(t.id));
    tabs.appendChild(b);
    return b;
  });
  const periods = el('div', 'up-periods');
  periods.setAttribute('role', 'group');
  periods.setAttribute('aria-label', 'Période');
  const periodBtns = PERIODS.map((p) => {
    const b = button('up-period', p.label);
    b.dataset.period = p.id;
    b.addEventListener('click', () => setPeriod(p.id));
    periods.appendChild(b);
    return b;
  });
  const planTag = el('span', 'up-plan-tag');
  setShown(planTag, false);
  const refresh = button('up-refresh', '', 'refresh-cw', 'Actualiser');
  refresh.addEventListener('click', onRefresh);
  const close = button('up-close', '', 'x', 'Fermer (Esc)');
  close.addEventListener('click', closeUsagePage);
  const actions = el('div', 'up-actions');
  actions.append(refresh, close);
  head.append(tabs, planTag, periods, actions);

  const body = el('div', 'up-body');
  const report = el('section', 'up-pane up-report');
  report.setAttribute('role', 'tabpanel');
  const limitsPane = buildLimitsPane();
  body.append(report, limitsPane.pane);
  root.append(head, body);

  // Beside the other overlays of #workspace: the DOM slot #plans-panel used to give
  // (that panel now lives in #side-panel), i.e. right before #room-panel.
  const anchor = document.getElementById('room-panel');
  if (anchor) anchor.before(root); else document.body.appendChild(root);
  refs = { tabBtns, periods, periodBtns, planTag, refresh, report, limits: limitsPane };
  document.addEventListener('keydown', onKeydown);
}

function onKeydown(e) {
  if (!st.open || e.key !== 'Escape') return;
  // NEVER steal keys from a focused terminal (same rule as the git / plans panels).
  if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
  closeUsagePage();
  e.preventDefault();
}

function reveal() {
  root.style.removeProperty('display');
  root.hidden = false;
}

export function openUsagePage(tab) {
  const wanted = TAB_IDS.includes(tab) ? tab : null;
  if (st.open) { if (wanted) setTab(wanted); return; }
  closeSidePanel(); // one fullscreen overlay at a time (§ 1.2); a no-op when closed
  overlayState.closePluginPanel?.(); // the Plugins overlay too
  ensureRoot();
  if (wanted) { st.tab = wanted; savePref(TAB_KEY, wanted); }
  st.open = true;
  for (const a of root.getAnimations?.() || []) a.cancel(); // a close still in flight
  reveal();
  requestAnimationFrame(() => { if (st.open) root.classList.add('open'); });
  startTick();
  syncChrome();
  syncPlan();
  showTab();
  root.focus({ preventScroll: true });
}

export function closeUsagePage() {
  if (!st.open) return;
  st.open = false;
  stopTick();
  root.classList.remove('open');
  // The page may be reopened while the exit animation runs: re-check after the await.
  exitThen(root, undefined, { dur: '--dur-pop' }).then(() => { if (st.open) reveal(); });
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => { if (st.open && st.tab === 'limits') updateLimits(); }, TICK_MS);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function setTab(tab) {
  if (!TAB_IDS.includes(tab) || tab === st.tab) return;
  st.tab = tab;
  savePref(TAB_KEY, tab);
  syncChrome();
  showTab();
}

function setPeriod(period) {
  if (!PERIOD_IDS.includes(period) || period === st.period || st.tab === 'limits') return;
  st.period = period;
  savePref(PERIOD_KEY, period);
  syncChrome();
  showTab();
}

function onRefresh() {
  if (st.tab === 'limits') loadLimits(true); else refreshReport(true);
}

function showTab() {
  if (st.tab === 'limits') { updateLimits(); loadLimits(); } else { renderReport(); refreshReport(false); }
}

function syncChrome() {
  const limitsTab = st.tab === 'limits';
  for (const b of refs.tabBtns) {
    const on = b.dataset.tab === st.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const b of refs.periodBtns) {
    const on = b.dataset.period === st.period;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = limitsTab; // the periods only drive the report tabs; the space stays reserved
  }
  refs.periods.dataset.idle = String(limitsTab);
  setShown(refs.report, !limitsTab);
  setShown(refs.limits.pane, limitsTab);
  root.dataset.tab = st.tab;
  root.dataset.period = st.period;
  syncBusy();
}

// Show or drop ONE progress strip in `host`; `onTop` lays it over the host's top edge, out of the layout flow.
function syncBar(bar, on, host, onTop) {
  if (!on) { if (bar) bar.remove(); return null; }
  if (bar) return bar;
  const b = progressBar();
  if (onTop) { b.style.position = 'absolute'; b.style.inset = '0 0 auto 0'; }
  host.prepend(b);
  return b;
}

// The refresh icon turns through `spinWhile` (whole turns, it stops upright) for as long as the shown tab is busy, whoever
// started the load (the button, the tick, a tab or period change): one spin per busy stretch, settled when it ends.
let endSpin = null;
function syncSpin(busy) {
  if (busy && !endSpin) spinWhile(refs.refresh, new Promise((res) => { endSpin = res; }));
  else if (!busy && endSpin) { endSpin(); endSpin = null; }
}

function syncBusy() {
  if (!refs) return;
  const busy = st.tab === 'limits' ? limitsBusy : inflight.has(st.period);
  root.classList.toggle('is-refreshing', busy);
  syncSpin(busy);
  refs.refresh.classList.toggle('is-spinning', busy);
  refs.refresh.disabled = busy;
  // a strip for the first « Limites » load and for a refresh button load over shown content; an automatic reload shows none
  limitsBar = syncBar(limitsBar, st.tab === 'limits' && limitsBusy && (!limits || limitsUser), refs.limits.pane);
  reportBar = syncBar(reportBar, st.tab !== 'limits' && userLoads.has(st.period) && inflight.has(st.period)
    && reports.has(st.period), root, true);
}

// ---------- « Coût » / « Tokens » ----------

const onDisplay = (period) => st.open && st.tab !== 'limits' && st.period === period;

// { error: 'warming' } = the estimator's cold pass is still running: stay in flight (skeleton) and
// ask again while this report is on display. Giving up hands the warming reply to the validation
// in fetchReport, which turns it into the error line like any other unusable reply.
async function requestReport(period) {
  const t0 = Date.now();
  for (;;) {
    const r = await window.api.getUsageReport(period);
    if (!r || r.error !== 'warming' || Date.now() - t0 >= WARMING_MAX_MS) return r;
    await new Promise((resolve) => setTimeout(resolve, WARMING_RETRY_MS));
    if (!onDisplay(period)) return r;
  }
}

function fetchReport(period) {
  if (inflight.has(period)) return inflight.get(period);
  failed.delete(period); // a retry shows the skeleton again, not the old error
  const p = Promise.resolve()
    .then(() => requestReport(period))
    .then((r) => {
      if (!r || !Array.isArray(r.buckets) || !r.totals) throw new Error('bad usage report');
      reports.set(period, { report: r, at: Date.now(), sig: JSON.stringify(r) });
      failed.delete(period);
    })
    .catch(() => { failed.add(period); })
    .finally(() => { inflight.delete(period); });
  inflight.set(period, p);
  return p;
}

async function refreshReport(force) {
  const period = st.period;
  const cached = reports.get(period);
  if (cached && !force && Date.now() - cached.at < STALE_MS) return;
  const pending = fetchReport(period);
  if (!cached) renderReport(); // nothing to show yet: skeleton while the fetch runs
  if (force && cached) userLoads.add(period);
  syncBusy();
  await pending;
  userLoads.delete(period);
  syncBusy();
  // The page may have closed or moved to another tab / period during the await.
  if (!st.open || st.tab === 'limits' || st.period !== period) return;
  renderReport();
}

function skeleton(cls) {
  return shimmer(`up-skel ${cls}`);
}

function renderReport() {
  const pane = refs.report;
  const entry = reports.get(st.period);
  if (!entry) {
    shownKey = null;
    pane.replaceChildren();
    if (failed.has(st.period) && !inflight.has(st.period)) {
      pane.dataset.state = 'error';
      const msg = el('div', 'up-empty', 'Données d’usage indisponibles — réessaie avec Actualiser.');
      msg.setAttribute('role', 'alert');
      pane.appendChild(msg);
      return;
    }
    pane.dataset.state = 'loading';
    pane.append(skeleton('up-skel-hero'), skeleton('up-skel-chart'), skeleton('up-skel-strip'),
      skeleton('up-skel-bars'));
    return;
  }
  const key = `${st.tab}|${st.period}|${entry.sig}`;
  if (key === shownKey && pane.dataset.state === 'ready') return; // same figures: keep open rows
  shownKey = key;
  pane.dataset.state = 'ready';
  const r = entry.report;
  const chartHost = el('div', 'up-chart');
  chartHost.setAttribute('role', 'img');
  chartHost.setAttribute('aria-label', st.tab === 'cost' ? 'Coût par période' : 'Tokens par période');
  pane.replaceChildren(buildHero(r), chartHost, buildTotals(r.totals), buildShares(r),
    buildBreakdown(r));
  try { // the chart needs the host in the DOM to measure it; a chart bug must not hide the figures
    renderChart(chartHost, { buckets: r.buckets, metric: st.tab === 'cost' ? 'cost' : 'tok', period: r.period });
  } catch (_) { chartHost.dataset.state = 'error'; }
}

// Provenance line. The date (ISO) and the source come from the report payload, main owns the price
// table; without a usable payload the bundled date and « grille intégrée » stay.
function priceProvenance(prices) {
  const m = prices && typeof prices.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(prices.date) : null;
  const date = m ? `${m[3]}/${m[2]}/${m[1]}` : PRICE_DATE;
  const source = m && prices.source === 'litellm' ? 'LiteLLM' : 'grille intégrée';
  return `Estimation au tarif API — prix du ${date} (${source})`;
}

function buildHero(r) {
  const t = r.totals;
  const hero = el('div', 'up-hero');
  const main = el('div', 'up-hero-main');
  if (st.tab === 'cost') {
    main.append(el('span', 'up-hero-value', fmtMoney(t.cost)),
      el('span', 'up-prov', priceProvenance(r.prices)));
  } else {
    main.append(el('span', 'up-hero-value', fmtTokens(t.processed)),
      el('span', 'up-hero-unit', 'tokens traités'));
  }
  hero.append(main, el('div', 'up-hero-sub', `${plural(r.sessions, 'session')} · estimation API`));
  if (st.tab === 'cost' && t.unpricedTokens > 0) {
    hero.appendChild(el('div', 'up-unpriced',
      `${fmtTokens(t.unpricedTokens)} tokens sans tarif connu — non comptés dans le coût`));
  }
  if (t.processed === 0) hero.appendChild(el('div', 'up-empty', 'Aucune activité sur cette période'));
  return hero;
}

function buildTotals(t) {
  const strip = el('div', 'up-totals');
  const items = [
    ['Traités', fmtTokens(t.processed), fmtInt(t.processed)],
    ['Entrée en cache', fmtTokens(t.cachedInput), fmtInt(t.cachedInput), MEASURE[2]],
    ['Entrée hors cache', fmtTokens(t.uncachedInput), fmtInt(t.uncachedInput), MEASURE[0]],
    ['Sortie', fmtTokens(t.output), fmtInt(t.output), MEASURE[3]],
    ['Économie de cache', fmtMoney(t.cacheSavings), 'Estimation au tarif API'],
  ];
  for (const [label, value, tip, colour] of items) {
    const it = el('div', 'up-total');
    const lab = el('span', 'up-total-label');
    if (colour) {
      it.style.setProperty('--sw', colour);
      lab.append(swatch(), document.createTextNode(label));
    } else {
      lab.textContent = label;
    }
    it.append(lab, el('span', 'up-total-value', value));
    it.title = tip;
    strip.appendChild(it);
  }
  return strip;
}

// rows: [[key, label, number]]; fmt renders the number; groups whose total is 0 are not drawn.
function shareGroup(title, rows, fmt) {
  const total = rows.reduce((s, [, , v]) => s + (v || 0), 0);
  if (!(total > 0)) return null;
  const g = el('div', 'up-share-group');
  g.appendChild(el('div', 'up-share-title', title));
  for (const [key, label, v] of rows) {
    const frac = (v || 0) / total;
    const row = el('div', 'up-share');
    row.dataset.key = key;
    const track = el('div', 'up-bar');
    const fill = el('div', 'up-bar-fill');
    fill.style.setProperty('--p', String(frac));
    track.appendChild(fill);
    const lab = el('span', 'up-share-label');
    const colour = TYPE_COLOUR[key];
    if (colour) {
      row.style.setProperty('--sw', colour); // the swatch and the bar fill read it
      lab.appendChild(swatch());
    }
    lab.appendChild(el('span', 'up-share-name', label));
    row.append(lab, track, el('span', 'up-share-value', fmt(v || 0)),
      el('span', 'up-share-pct', fmtShare(frac)));
    g.appendChild(row);
  }
  return g;
}

function buildShares(r) {
  const wrap = el('div', 'up-shares');
  const s = r.shares || {};
  const groups = st.tab === 'cost'
    ? [
      shareGroup('Coût par type', TOKEN_TYPES.map(([k, l]) => [k, l, (s.costByType || {})[k]]), fmtMoney),
      shareGroup('Coût par vitesse', SPEEDS.map(([k, l]) => [k, l, (s.costBySpeed || {})[k]]), fmtMoney),
    ]
    : [shareGroup('Tokens par type', TOKEN_TYPES.map(([k, l]) => [k, l, (s.tokensByType || {})[k]]),
      fmtTokens)];
  for (const g of groups) if (g) wrap.appendChild(g);
  return wrap;
}

function figure(cost, tok) {
  return st.tab === 'cost' ? fmtMoney(cost) : fmtTokens(sumTok(tok));
}

function shareOf(cost, tok, totals) {
  if (st.tab === 'cost') return totals.cost > 0 && cost !== null ? cost / totals.cost : null;
  return totals.processed > 0 ? sumTok(tok) / totals.processed : null;
}

function buildBreakdown(r) {
  const sec = el('div', 'up-breakdown');
  const head = el('div', 'up-breakdown-head');
  head.setAttribute('role', 'group');
  const body = el('div', 'up-rows');
  const fill = () => body.replaceChildren(...(st.by === 'model' ? modelRows(r) : dayRows(r)));
  const segs = [['model', 'Modèle'], ['day', 'Jour']].map(([id, label]) => {
    const b = button('up-seg', label);
    b.dataset.by = id;
    b.addEventListener('click', () => {
      if (st.by === id) return;
      st.by = id;
      for (const x of segs) {
        x.classList.toggle('active', x.dataset.by === id);
        x.setAttribute('aria-pressed', String(x.dataset.by === id));
      }
      fill();
    });
    return b;
  });
  for (const b of segs) {
    b.classList.toggle('active', b.dataset.by === st.by);
    b.setAttribute('aria-pressed', String(b.dataset.by === st.by));
  }
  head.append(...segs);
  fill();
  sec.append(head, body);
  return sec;
}

function modelRows(r) {
  if (!r.byModel.length) return [el('div', 'up-empty', 'Aucun modèle sur cette période')];
  return r.byModel.map((m, i) => {
    const wrap = el('div', 'up-row-wrap');
    const row = el('button', 'up-row up-row-model');
    row.type = 'button';
    if (MEASURE[i]) row.style.setProperty('--sw', MEASURE[i]); // share order: the first four models are coloured
    row.setAttribute('aria-expanded', 'false');
    if (m.cost === null) { row.dataset.unpriced = 'true'; row.title = 'Modèle sans tarif connu'; }
    const name = el('span', 'up-row-name', m.model);
    name.title = m.model;
    row.append(icon('cpu'), name, el('span', 'up-row-value', figure(m.cost, m.tok)),
      el('span', 'up-row-pct', fmtShare(shareOf(m.cost, m.tok, r.totals))));
    const detail = buildDetail(m);
    detail.hidden = true;
    detail.style.display = 'none';
    row.addEventListener('click', () => {
      const open = row.getAttribute('aria-expanded') === 'true';
      row.setAttribute('aria-expanded', String(!open));
      (open ? collapse : expand)(detail);
    });
    wrap.append(row, detail);
    return wrap;
  });
}

function buildDetail(m) {
  const d = el('div', 'up-detail');
  for (const [k, label] of TOKEN_TYPES) {
    const line = el('div', 'up-detail-line');
    const v = el('span', 'up-detail-value', fmtTokens(m.tok[k]));
    v.title = fmtInt(m.tok[k]);
    line.append(el('span', 'up-detail-label', label), v);
    d.appendChild(line);
  }
  const proj = el('div', 'up-detail-projects');
  proj.appendChild(el('span', 'up-detail-label', 'Projets principaux'));
  const list = el('span', 'up-detail-list');
  if (m.projects && m.projects.length) {
    for (const p of m.projects) list.appendChild(el('span', 'up-chip', p));
  } else {
    list.textContent = 'aucun projet identifié';
  }
  proj.appendChild(list);
  d.appendChild(proj);
  return d;
}

function dayRows(r) {
  if (!r.byDay.length) return [el('div', 'up-empty', 'Aucune activité sur cette période')];
  return r.byDay.map((d) => { // newest first, as buildReport returns them
    const row = el('div', 'up-row up-row-day');
    row.dataset.day = d.day;
    row.append(el('span', 'up-row-name', fmtDay(d.day)), el('span', 'up-row-value', figure(d.cost, d.tok)),
      el('span', 'up-row-pct', fmtShare(shareOf(d.cost, d.tok, r.totals))));
    return row;
  });
}

// ---------- « Limites » ----------

function buildLimitsPane() {
  const pane = el('section', 'up-pane up-limits');
  pane.setAttribute('role', 'tabpanel');
  const planRow = el('div', 'up-plan');
  const opts = el('div', 'up-plan-opts');
  opts.setAttribute('role', 'group');
  opts.setAttribute('aria-label', 'Plan');
  const planOpts = PLANS.map((p) => {
    const b = button('up-plan-opt', p.label);
    b.dataset.plan = p.id || 'none';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => onPlanPick(p.id));
    opts.appendChild(b);
    return { id: p.id, btn: b };
  });
  planRow.append(el('span', 'up-plan-label', 'Plan'), opts);
  pane.appendChild(planRow);
  const cards = WINDOWS.map((w) => {
    const card = el('div', 'up-limit');
    card.dataset.win = w.key;
    const meter = el('div', 'up-meter');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', `${w.title} — quota restant`);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    const fillEl = el('div', 'up-meter-fill');
    meter.appendChild(fillEl);
    const reset = el('div', 'up-limit-reset');
    const count = el('span', 'up-limit-count');
    const at = el('span', 'up-limit-at');
    reset.append(icon('clock'), count, at);
    const left = el('span', 'up-limit-left');
    const main = el('div', 'up-limit-main');
    const cap = el('span', 'up-limit-cap', 'restant');
    main.append(left, cap);
    const src = el('span', 'up-limit-src');
    const head = el('div', 'up-limit-head');
    head.append(el('span', 'up-limit-title', w.title), src);
    const note = el('div', 'up-limit-note');
    card.appendChild(head);
    let weekly = null; // the plan's weekly allowance line: the seven_day card only
    if (w.key === 'seven_day') {
      weekly = el('div', 'up-limit-plan');
      setShown(weekly, false);
      card.appendChild(weekly);
    }
    card.append(main, meter, reset, note);
    pane.appendChild(card);
    return { key: w.key, card, left, cap, weekly, meter, fillEl, count, at, src, note };
  });
  return { pane, cards, planOpts };
}

// The 5 h card on Ultra: Claude Code sends no 5 h window (payload `{ none: true }`).
function paintUnlimited(c) {
  c.card.dataset.level = 'none';
  c.card.dataset.state = 'unlimited';
  c.left.textContent = 'Pas de limite';
  setShown(c.cap, false);
  c.fillEl.style.setProperty('--p', '0');
  c.meter.removeAttribute('aria-valuenow');
  c.count.textContent = '';
  c.at.textContent = '';
  c.src.textContent = '';
  c.src.title = '';
  c.note.textContent = 'Plan Ultra : pas de limite de 5 heures';
}

function syncPlan() {
  if (!refs) return;
  for (const o of refs.limits.planOpts) {
    const on = o.id === plan;
    o.btn.classList.toggle('active', on);
    o.btn.setAttribute('aria-pressed', String(on));
  }
  const cur = PLANS.find((p) => p.id === plan);
  refs.planTag.textContent = plan ? cur.label : '';
  setShown(refs.planTag, !!plan);
  const line = PLAN_WEEKLY[plan] || '';
  for (const c of refs.limits.cards) {
    if (!c.weekly) continue;
    c.weekly.textContent = line;
    setShown(c.weekly, !!line);
  }
}

// No optimistic paint: the UI follows the payload main pushes after the write.
function onPlanPick(id) {
  if (id === plan) return;
  try { Promise.resolve(window.api.setUsagePlan(id)).catch(() => {}); } catch (_) { /* bridge missing */ }
}

function updateLimits() {
  const pane = refs.limits.pane;
  pane.dataset.state = limits ? 'ready' : 'loading';
  const nowSec = Math.floor(Date.now() / 1000);
  for (const c of refs.limits.cards) {
    const w = limits ? limits[c.key] : null;
    if (c.key === 'five_hour' && w && w.none === true) { // before limitView, which gives null for this shape
      paintUnlimited(c);
      continue;
    }
    delete c.card.dataset.state;
    setShown(c.cap, true);
    const v = limitView(w, nowSec);
    c.card.dataset.level = v ? v.level : 'none';
    if (!v) { // No data: a calm placeholder, never a guess (CD rule 7).
      c.left.textContent = '—';
      c.fillEl.style.setProperty('--p', '0');
      c.meter.removeAttribute('aria-valuenow');
      c.count.textContent = '';
      c.at.textContent = '';
      c.src.textContent = '';
      c.src.title = '';
      c.note.textContent = limits
        ? 'Aucune donnée de quota — ouvre une session via le deck pour collecter l’officiel'
        : '';
      continue;
    }
    c.left.textContent = `${v.left}${NBSP}%`;
    c.fillEl.style.setProperty('--p', String(v.left / 100));
    c.meter.setAttribute('aria-valuenow', String(v.left));
    c.count.textContent = w.resets_at ? `Réinitialisation ${fmtCountdown(w.resets_at, nowSec)}` : '';
    c.at.textContent = w.resets_at && !v.expired ? `· ${fmtResetAt(w.resets_at, nowSec)}` : '';
    c.src.textContent = SOURCE_LABEL[w.source] ? `Source : ${SOURCE_LABEL[w.source]}` : '';
    c.src.title = SOURCE_TIP[w.source] || '';
    c.note.textContent = typeof w.official_age_s === 'number'
      ? `Dernière collecte officielle il y a ${fmtAge(w.official_age_s)}` : '';
  }
}

function applyLimits(u) {
  limits = { five_hour: (u && u.five_hour) || null, seven_day: (u && u.seven_day) || null };
  const wanted = u && u.plan;
  plan = PLANS.some((p) => p.id !== null && p.id === wanted) ? wanted : null;
  syncPlan();
  if (st.open && st.tab === 'limits') updateLimits();
  syncBusy(); // the first payload ends the first-load strip even while a pull is still out
}

async function loadLimits(user = false) {
  const seq = limitsSeq;
  limitsBusy = true;
  if (user) limitsUser = true;
  syncBusy();
  let u;
  try { u = await window.api.getUsage(); } catch (_) { u = undefined; }
  limitsBusy = false;
  limitsUser = false;
  syncBusy();
  if (u === undefined || seq !== limitsSeq) return; // failed, or a fresher push landed meanwhile
  applyLimits(u);
}

// Called by usage.js applyUsage on every push (and its initial fetch).
export function notifyUsageUpdate(payload) {
  limitsSeq++;
  applyLimits(payload);
}
