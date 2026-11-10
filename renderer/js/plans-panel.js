// claude-deck — renderer/plans-panel (v40): same UX shell as the git panel.
// The list = plans this session MADE (écrit / plan mode) or CONSUMED
// (consulté), straight from the transcript truth; the view renders the
// selected plan's markdown.
// NOTE (P1-09): a TAB of the docked side panel (side-panel.js), like the git
// panel — see the comment there. No import of git-panel.js any more.
'use strict';

import { overlayState } from './state.js';
import { registerSideTab, showSideTab, closeSidePanel } from './side-panel.js';
import { mountClosedFrame } from './page-frame.js';
import { placeBubbles, fileScope } from './code-ask.js';
import { frameAskSelect, frameAskPointerDown, frameAskReset } from './frame-ask.js';
import { skeleton, progressBar } from './loading.js';
import { spinWhile, revealFrame } from './motion.js';

export const pp = { open: false, target: null, count: 0, selected: -1, names: [], kinds: [], htmlOnly: false };
// A FILE plan named *.html / *.htm: an inline plan's name is its first line, so the kind decides.
const isHtmlPlan = (kind, name) => kind === 'file' && /\.html?$/i.test(name);
let ppIdleRefreshTimer = 0;
// One shared renderer instance. Defense in depth (review round): html:false
// escapes raw HTML; markdown-it's own validateLink kills javascript:/data:
// hrefs; CSP 'self' blocks inline handlers; main's will-navigate +
// setWindowOpenHandler guards kill every remaining navigation path.
export const ppMd = (typeof markdownit !== 'undefined')
  ? markdownit({ html: false, linkify: true }) : null;

// Ask surface of an HTML plan (chip and popup: frame-ask.js). The answers live in the dock under the plan,
// emptied on every plan change and put back by placeBubbles.
function ppFallbackRect() { // no usable rect from the page: the top of the plan view
  const v = document.getElementById('pp-view').getBoundingClientRect();
  return { left: v.left + 12, top: v.top, width: 0, height: 8 };
}

function ppAskReset() {
  frameAskReset();
  const dock = document.getElementById('pp-asks');
  if (dock) { dock.replaceChildren(); dock.hidden = true; }
}

function ppPlaceBubble(bubble) {
  const dock = document.getElementById('pp-asks');
  if (!dock) return;
  dock.appendChild(bubble);
  dock.hidden = false;
}

// The threads of a file are one list per file and session (code-ask `fileScope`), the Files tab's list included.
function ppAskHost(name, i, fileKey) {
  return {
    label: name,
    scope: fileScope(pp.target, fileKey),
    isLive: () => pp.open && pp.selected === i && !!pp.target,
    fallbackRect: ppFallbackRect,
    placeBubble: ppPlaceBubble,
  };
}

// Public entry (name and behaviour kept): shows the Plans tab for `target`.
export function openPlansPanel(target) { ppActivate(target, true); }

// focus=false on a session-change reload: the terminal just selected keeps the keys.
function ppActivate(target, focus) {
  overlayState.closeUsagePage?.(); // usage page: same rule (slot self-assigned by usage.js)
  overlayState.closeAgentJournal?.(); // S6b: journal-centric exclusivity (aj11); UD4/C7 — the room overlay is a pre-existing, out-of-scope coexistence, untouched here
  pp.target = { ...target };
  pp.open = true;
  pp.selected = -1;
  ppAskReset();
  showSideTab('plans', target); // closes the previous tab, unhides the panel
  document.getElementById('pp-view').innerHTML =
    '<div class="gp-empty">Sélectionne un plan pour le lire</div>';
  // preventScroll (rule 8): same as the git panel.
  if (focus) document.getElementById('pp-list').focus({ preventScroll: true });
  ppLoadList();
}

// Closes the whole side panel when the Plans tab is the active one.
export function closePlansPanel() { if (pp.open) closeSidePanel(); }

// The tab's own state reset — side-panel.js calls it when the panel closes or
// another tab is shown; it never calls back into the panel.
function ppDeactivate() {
  pp.open = false;
  pp.target = null;
  ppAskReset();
  ppSetBar(false);
}

function ppFmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
    + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

let ppBar = null; // strip under the header while a user-started refresh keeps the rows

function ppSetBar(on) {
  if (ppBar) ppBar.remove();
  ppBar = on ? progressBar() : null;
  if (ppBar) document.getElementById('pp-head').after(ppBar);
}

// A wait shows over an empty list; over rows only a load the user started (`user`) shows one.
export async function ppLoadList({ user = false } = {}) {
  if (!pp.open || !pp.target) return;
  const t = pp.target; // every activation assigns a fresh object
  const listEl = document.getElementById('pp-list');
  if (!listEl.firstChild) listEl.replaceChildren(skeleton());
  else if (user) ppSetBar(true);
  const res = await window.api.plansList(t).catch(() => null);
  if (!pp.open) { ppSetBar(false); return; } // closed while loading
  if (pp.target !== t) return; // a newer activation owns the list and its loader
  ppSetBar(false);
  listEl.textContent = '';
  const plans = res && res.ok ? res.plans : [];
  pp.count = plans.length;
  pp.names = plans.map((p) => p.name); // identity guard for planGet
  pp.kinds = plans.map((p) => p.kind); // an inline plan's name is its first line: only a file name routes
  if (!plans.length) {
    document.getElementById('pp-count').textContent = '';
    const empty = document.createElement('div');
    empty.className = 'gp-empty';
    empty.textContent = (res && res.ok)
      ? 'aucun plan touché par cette session'
      : 'session introuvable';
    listEl.appendChild(empty);
    ppAskReset();
    document.getElementById('pp-view').innerHTML = '<div class="gp-empty">—</div>';
    return;
  }
  plans.forEach((p, i) => {
    // Names/dates are transcript- and file-controlled strings: DOM +
    // textContent only, never innerHTML (same rule as the git panel).
    const row = document.createElement('div');
    row.className = 'gp-row pp-row';
    if (i === pp.selected) row.classList.add('selected');
    if (!p.exists) row.classList.add('pp-missing');
    const glyph = document.createElement('span');
    glyph.className = 'gp-glyph pp-glyph';
    glyph.textContent = p.kind === 'inline' ? '◇' : '▤';
    const name = document.createElement('span');
    name.className = 'gp-path';
    name.textContent = p.name;
    name.title = p.name;
    const badges = document.createElement('span');
    badges.className = 'gp-pills';
    const b = document.createElement('i');
    b.className = p.written ? 'gp-add' : 'pp-read';
    b.textContent = p.kind === 'inline' ? 'plan mode' : (p.written ? 'écrit' : 'consulté');
    badges.appendChild(b);
    if (!p.exists) {
      const m = document.createElement('i');
      m.className = 'gp-del';
      m.textContent = 'supprimé';
      badges.appendChild(m);
    }
    const ts = document.createElement('span');
    ts.className = 'pp-ts';
    ts.textContent = ppFmtTs(p.ts);
    row.append(glyph, name, badges, ts);
    row.addEventListener('click', () => ppLoadPlan(i));
    listEl.appendChild(row);
  });
  ppApplyFilter();
}

// Rows are hidden in place, never rebuilt: the DOM position stays the full-list index that
// ppLoadPlan sends to main. The count, the button state and the empty message follow.
function ppApplyFilter() {
  const listEl = document.getElementById('pp-list');
  const btn = document.getElementById('pp-html-only');
  if (btn) btn.setAttribute('aria-pressed', String(pp.htmlOnly));
  listEl.querySelectorAll('.pp-filter-empty').forEach((e) => e.remove());
  if (!pp.count) return; // the empty list owns its own message and a blank count
  let shown = 0;
  listEl.querySelectorAll('.pp-row').forEach((row, i) => {
    row.hidden = pp.htmlOnly && !isHtmlPlan(pp.kinds[i], pp.names[i]);
    if (!row.hidden) shown++;
  });
  const n = pp.htmlOnly ? shown : pp.count;
  document.getElementById('pp-count').textContent =
    `${n} plan${n > 1 ? 's' : ''}${pp.htmlOnly ? ' HTML' : ''}`;
  if (pp.htmlOnly && !shown) {
    const empty = document.createElement('div');
    empty.className = 'gp-empty pp-filter-empty';
    empty.textContent = 'aucun plan HTML dans cette session';
    listEl.appendChild(empty);
  }
}

function showPlanError(view, text) {
  const err = document.createElement('div');
  err.className = 'gp-empty';
  err.textContent = text;
  view.replaceChildren(err);
}

export async function ppLoadPlan(i) {
  pp.selected = i;
  ppAskReset();
  const listEl = document.getElementById('pp-list');
  [...listEl.querySelectorAll('.pp-row')].forEach((r, j) =>
    r.classList.toggle('selected', j === i));
  const view = document.getElementById('pp-view');
  const kind = pp.kinds[i]; // read before the await: a list refresh may re-sort meanwhile
  view.replaceChildren(skeleton());
  const res = await window.api.planGet(pp.target, i, pp.names[i]).catch(() => null);
  if (!pp.open || pp.selected !== i) return; // stale response (fast re-click): the newer click owns the view
  view.textContent = '';
  if (!res || !res.ok || !ppMd) {
    showPlanError(view, !ppMd ? 'markdown-it non chargé'
      : `⚠ ${(res && res.reason) || 'plan illisible'}`);
    // Index drifted (live transcript grew — main refused to serve the wrong
    // plan): re-sync the list so the next click lands on fresh indexes.
    if (res && res.stale) ppLoadList();
    return;
  }
  // Every .html FILE plan runs in the closed frame, script-free ones included.
  if (isHtmlPlan(kind, res.name)) {
    view.append(skeleton()); // the page is served next
    const mounted = await mountClosedFrame(view, res.markdown, 'plans', {
      title: res.name,
      isCurrent: () => pp.open && pp.selected === i,
      onFrame: (f) => revealFrame(f), // held at opacity 0 until `load`: the frame never shows its white background
      onSelect: (sel) => { if (pp.target) frameAskSelect(sel, ppAskHost(res.name, i, res.fileKey)); },
      onPointerDown: frameAskPointerDown,
    });
    // null: the user moved on while main answered, show nothing; false: main refused
    if (mounted === false) showPlanError(view, '⚠ page non affichable');
    else if (mounted && pp.target) placeBubbles(fileScope(pp.target, res.fileKey), ppPlaceBubble);
    return;
  }
  // markdown-it output only (html:false): plan-controlled raw HTML arrives
  // escaped; CSP 'self' blocks inline handlers; links are made inert below.
  view.innerHTML = ppMd.render(res.markdown);
  view.scrollTop = 0;
  // No selection surface here, but the threads asked on this file elsewhere (its source in Files) stay reachable in the dock.
  if (pp.target) placeBubbles(fileScope(pp.target, res.fileKey), ppPlaceBubble);
}

function ppMove(delta) {
  if (!pp.count) return;
  // Steps over hidden rows; the end of the visible list is a stop, not a wrap.
  const rows = document.querySelectorAll('#pp-list .pp-row');
  let next = pp.selected < 0 ? (delta > 0 ? -1 : pp.count) : pp.selected;
  do next += delta; while (next >= 0 && next < pp.count && rows[next] && rows[next].hidden);
  if (next >= 0 && next < pp.count) ppLoadPlan(next);
}

// v40 live refresh — same settle trigger as the git panel; the list re-parse
// is stamp-cached main-side, so this is near-free when nothing changed.
export function ppNotifySessionStatus(sessionId, status) {
  if (pp.open && pp.target && (status === 'idle' || status === 'waiting')
      && pp.target.sessionId === sessionId) {
    clearTimeout(ppIdleRefreshTimer);
    ppIdleRefreshTimer = setTimeout(() => ppLoadList(), 350);
  }
}

// Link guard + keyboard nav + buttons — called once from boot.js.
export function initPlansPanel() {
  // Plan markdown can carry links — this panel is a READER: never navigate
  // the deck window (a click on <a> would replace the whole renderer).
  document.getElementById('pp-view').addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    if (!pp.open) return;
    // NEVER steal keys from a focused terminal (same rule as the git panel).
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    // Keys typed in a field (the chat composer) stay the field's (same rule as the git panel).
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') { closeSidePanel(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { ppMove(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { ppMove(-1); e.preventDefault(); }
    else if (e.key === 'Enter' && pp.selected >= 0
        && !(e.target && e.target.closest && e.target.closest('button'))) { // a focused button keeps its Enter
      document.getElementById('pp-view').focus({ preventScroll: true });
      e.preventDefault();
    }
  });

  registerSideTab('plans', {
    open: (t, o) => ppActivate(t, !(o && o.keepFocus)),
    close: ppDeactivate,
    ownEscape: true,
  });
  document.getElementById('pp-close').addEventListener('click', closePlansPanel);
  document.getElementById('pp-refresh').addEventListener('click', (e) => spinWhile(e.currentTarget, ppLoadList({ user: true })));
  document.getElementById('pp-html-only').addEventListener('click', () => {
    pp.htmlOnly = !pp.htmlOnly;
    ppApplyFilter();
  });
}
