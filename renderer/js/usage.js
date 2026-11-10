// claude-deck — renderer/usage: quota gauges (5h/7j) in the header — data
// pushed by main's deck-usage watcher; the countdown re-computes locally from
// resets_at so it stays accurate even when the file is stale (no Claude
// session running = no new writes).
'use strict';

import { modeState, overlayState } from './state.js';
import { openUsagePage, closeUsagePage, notifyUsageUpdate } from './usage-page.js';
import { shimmer } from './loading.js';

// Self-assigned like room-panel.js does for its slot (boot.js stays out of it):
// git-panel.js / plans-panel.js close the usage page through this slot.
overlayState.closeUsagePage = closeUsagePage;

const usageState = { five_hour: null, seven_day: null };

// v35: per-source labeling — a gauge must SAY what it shows (server truth vs
// local reconstruction), never blend silently. Keyed by payload `source`.
const SOURCE_META = {
  official:  { sym: '✓', tip: 'source : serveur (statusline)' },
  anchored:  { sym: '~', tip: 'source : officiel + activité locale projetée (échelle P90 personnelle) — peut diverger du réel' },
  stale:     { sym: '~', tip: 'source : officiel figé — activité locale non comptée depuis la dernière collecte' },
  estimated: { sym: '~', tip: 'source : estimation transcripts (règle Usage Monitor, échelle P90) — fenêtre et % approximatifs' },
};

function fmtAge(s) {
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

// resets_at is epoch SECONDS (verified against the statusline stdin format).
function fmtReset(resetsAt, nowSec) {
  const diff = resetsAt - nowSec;
  if (diff <= 0) return 'reset imminent';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `reset dans ${d}j ${h}h`;
  if (h > 0) return `reset dans ${h}h${String(m).padStart(2, '0')}`;
  return `reset dans ${Math.max(m, 1)}min`;
}

// v26: continuous ring color — green (0%) through amber to red (100%),
// linear HSL interpolation between the deck's GitHub-dark endpoints
// (#3fb950 ≈ hsl(137 49% 48%) -> #e5534b ≈ hsl(4 75% 60%)). The hue sweep
// passes through amber around 50% for free. The CSS 'stroke 0.4s ease'
// transition smooths every step.
export function ringColor(pct) {
  const t = Math.min(100, Math.max(0, pct)) / 100;
  const h = Math.round(137 + (4 - 137) * t);
  const s = Math.round(49 + (75 - 49) * t);
  const l = Math.round(48 + (60 - 48) * t);
  return `hsl(${h} ${s}% ${l}%)`;
}

function renderGauge(id, w) {
  const el = document.getElementById(id);
  if (!el) return;
  // v24 ring shell: the arc is driven by stroke-dashoffset, computed from the
  // circle's OWN radius (no magic constants — resizing the SVG keeps working).
  const arc = el.querySelector('.g-arc');
  const pctEl = el.querySelector('.g-pct');
  const rstEl = el.querySelector('.g-reset');
  const srcEl = el.querySelector('.g-src');
  const circ = 2 * Math.PI * arc.r.baseVal.value;
  arc.style.strokeDasharray = String(circ);
  if (w && w.none === true) {
    // Claude Ultra sends no 5 h window: say so, never a dash or an estimate.
    el.dataset.level = 'none';
    el.dataset.source = 'unlimited';
    el.style.removeProperty('--p');
    arc.style.strokeDashoffset = String(circ); // empty ring
    arc.style.stroke = '';
    pctEl.style.color = '';
    pctEl.textContent = '';
    rstEl.textContent = 'pas de limite';
    if (srcEl) srcEl.textContent = '';
    el.title = '5 h : pas de limite (plan Ultra) — Claude Code n’envoie pas de fenêtre de 5 h';
    return;
  }
  if (!w || typeof w.used_percentage !== 'number') {
    // No data (no official, nothing estimable) -> calm placeholder, never an error.
    el.dataset.level = 'none';
    el.dataset.source = 'none';
    el.style.removeProperty('--p');
    arc.style.strokeDashoffset = String(circ); // empty ring
    arc.style.stroke = ''; // back to the neutral CSS fallback
    pctEl.style.color = '';
    pctEl.textContent = '—';
    rstEl.textContent = '';
    if (srcEl) srcEl.textContent = '';
    el.title = 'aucune donnée quota — ouvre une session via le deck pour collecter l’officiel';
    return;
  }
  // v35 source badge + tooltip — transparency is part of the contract.
  const srcMeta = SOURCE_META[w.source];
  el.dataset.source = w.source || 'unknown';
  if (srcEl) srcEl.textContent = srcMeta ? srcMeta.sym : '';
  el.title = srcMeta
    ? srcMeta.tip + (typeof w.official_age_s === 'number'
        ? ` · dernière collecte officielle il y a ${fmtAge(w.official_age_s)}`
        : '')
    : '';
  const nowSec = Math.floor(Date.now() / 1000);
  let pct = Math.round(w.used_percentage);
  let reset = w.resets_at ? fmtReset(w.resets_at, nowSec) : '';
  if (w.resets_at && nowSec > w.resets_at) {
    pct = 0; // the window already reset; the stale file just doesn't know yet
    reset = 'reset imminent';
  }
  pct = Math.min(100, Math.max(0, pct));
  el.style.setProperty('--p', String(pct / 100)); // fills the header's line meter (style.css .g-ring-wrap::after)
  arc.style.strokeDashoffset = String(circ * (1 - pct / 100));
  // v26: stroke follows the continuous green->red ramp; the figure adopts it
  // too once critical (>=80) — perfectly in tune with the arc, no fixed red.
  arc.style.stroke = ringColor(pct);
  pctEl.style.color = pct >= 80 ? ringColor(pct) : '';
  el.dataset.level = pct >= 80 ? 'alert' : pct >= 50 ? 'warm' : 'ok'; // semantic state (probes)
  pctEl.textContent = String(pct); // bare figure — the ring IS the percent
  rstEl.textContent = reset; // own line under the label (no · separator)
}

function renderUsage() {
  renderGauge('gauge-5h', usageState.five_hour);
  renderGauge('gauge-7d', usageState.seven_day);
}

// The first quota read answers in a frame or two: the ring shimmer shows only when the wait passes this delay.
const GAUGE_LOAD_DELAY_MS = 120;
let gaugeLoadTimer = null;

function showGaugeLoader() {
  for (const id of ['gauge-5h', 'gauge-7d']) {
    const wrap = document.querySelector(`#${id} .g-ring-wrap`);
    if (wrap && !wrap.querySelector('.g-skel')) wrap.append(shimmer('g-skel'));
  }
}

function clearGaugeLoader() {
  clearTimeout(gaugeLoadTimer);
  gaugeLoadTimer = null;
  document.querySelectorAll('#usage .g-skel').forEach((n) => n.remove());
}

export function applyUsage(u) {
  clearGaugeLoader(); // the first value (or the failure) ends the wait for good
  usageState.five_hour = (u && u.five_hour) || null;
  usageState.seven_day = (u && u.seven_day) || null;
  renderUsage();
  notifyUsageUpdate(u); // the usage page's « Limites » tab shares this single listener
}

// Entry points: the header « Usage » button and a click on either gauge. The
// native AI view draws above the DOM (and a mode switch is mid-fade), so an
// overlay opened then would be invisible: ignore the click.
function openFromHeader(tab) {
  if (modeState.mode !== 'code' || modeState.switching) return;
  overlayState.closeAgentJournal?.(); // S6b: journal-centric exclusivity (aj11), as git-panel / plans-panel do
  openUsagePage(tab);
}

// Initial fetch + push subscription + local countdown tick — from boot.js.
export function initUsage() {
  document.getElementById('usage-open')?.addEventListener('click', () => openFromHeader());
  for (const id of ['gauge-5h', 'gauge-7d']) {
    document.getElementById(id)?.addEventListener('click', () => openFromHeader('limits'));
  }
  gaugeLoadTimer = setTimeout(showGaugeLoader, GAUGE_LOAD_DELAY_MS);
  window.api.getUsage().then(applyUsage).catch(() => applyUsage(null));
  window.api.onUsageUpdate(applyUsage);
  setInterval(renderUsage, 60 * 1000); // countdown ticks locally, no file I/O
}
