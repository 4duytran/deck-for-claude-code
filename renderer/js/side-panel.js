// claude-deck — renderer/side-panel (P1-09): the docked, resizable right panel
// (T3-style split). Its tabs host the Files slot (#files-panel, filled by
// files-panel.js), #git-panel, #plans-panel and #terminal-panel. One tab is active at a time: showing
// one closes the previous one (the old « one overlay at a time » rule).
// Imports state.js and motion.js (a leaf, no cycle): the tab modules REGISTER themselves, and
// the selected session arrives through the overlayState.onPaneSelected slot.
// Motion: open slides the panel in, a tab switch fades the new tab in, maximize / restore glide
// (FLIP), and close sets `hidden` at once (state and layout are final) while a short inert tail
// keeps the panel painted as it leaves.
'use strict';

import { panes, layoutState, overlayState } from './state.js';
import { swapIn, exitThen, flipFrom } from './motion.js';

const TABS = ['files', 'git', 'plans', 'terminal'];
const HOSTS = { files: 'files-panel', git: 'git-panel', plans: 'plans-panel', terminal: 'terminal-panel' };
const MIN_W = 320; // panel width floor
const MIN_MAIN_W = 480; // the workspace always keeps at least this much
const DEFAULT_W = 420;
const KEY_STEP = 24;
// The leaving tail of a close: the mirror of the 10 px slide-in of swapIn.
const SLIDE_OUT_KF = [
  { opacity: 1, transform: 'translateX(0)' },
  { opacity: 0, transform: 'translateX(10px)' },
];
const TAIL_PROPS = ['display', 'position', 'top', 'right', 'bottom', 'width'];

// open/tab/target: what the panel shows. target = { paneId, sessionId } (ids only).
// max: the panel overlays the whole area right of the sidebar (toggleSidePanelMax).
export const sp = { open: false, tab: null, target: null, width: DEFAULT_W, max: false };
// tab -> { open(target, { keepFocus }), close(), ownEscape, autoMax(), userMax() }
//   open: loads the tab for a target and ends in showSideTab(tab, target)
//   close: resets the tab's own state (never calls back into the panel)
//   ownEscape: the tab handles Escape itself (git chooser, ...)
//   autoMax: true while the max is the tab's own (Escape closes the tab, no restore first)
//   userMax: a #sp-max click happened: from now on the max is the user's
const handlers = new Map();

const $ = (id) => document.getElementById(id);

export function registerSideTab(tab, h) {
  if (TABS.includes(tab)) handlers.set(tab, h);
}

function selectedTarget() {
  const p = panes.get(layoutState.selectedPaneId);
  return p ? { paneId: p.paneId, sessionId: p.sessionId } : null;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.paneId && b.paneId) return a.paneId === b.paneId;
  return !!a.sessionId && a.sessionId === b.sessionId;
}

function sidebarWidth() {
  const sb = $('sidebar');
  return sb ? sb.getBoundingClientRect().width : 0;
}

function maxWidth() {
  return Math.max(MIN_W, window.innerWidth - sidebarWidth() - MIN_MAIN_W);
}

function clampWidth(w, max = maxWidth()) {
  return Math.round(Math.min(Math.max(w, MIN_W), max));
}

function applyWidth(w = sp.width) {
  const max = maxWidth();
  sp.width = clampWidth(w, max);
  document.documentElement.style.setProperty('--side-w', `${sp.width}px`);
  const h = $('sp-resize');
  if (h) {
    h.setAttribute('aria-valuemin', String(MIN_W));
    h.setAttribute('aria-valuemax', String(max));
    h.setAttribute('aria-valuenow', String(sp.width));
  }
}

// Maximized layout (R1): #side-panel leaves the flow and covers the area right of the
// sidebar (fixed, insets measured from #workspace / #main-row). #workspace keeps its
// measured width, frozen inline and then covered, so no pane ever sees a size change:
// fit() does not run and the PTY is never resized.
function placeMax() {
  const w = $('workspace').getBoundingClientRect();
  const row = $('main-row').getBoundingClientRect();
  const el = $('side-panel');
  el.style.top = `${row.top}px`;
  el.style.left = `${w.left}px`;
  el.style.bottom = `${window.innerHeight - row.bottom}px`;
}

function syncMaxButton() {
  const b = $('sp-max');
  if (!b) return;
  const label = sp.max ? 'Réduire' : 'Agrandir';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.classList.toggle('on', sp.max);
}

// The pending « hide #workspace once the grow ended », so a newer maximize / restore can void it.
let wsHide = null;

// `animate`: glide the panel from the box it had (FLIP, transform / opacity only). Off for a close,
// where the panel is about to leave anyway.
// Maximize keeps #workspace painted under the growing panel (no bare ground left of it) and hides it
// (visibility: layout kept, no pane resize) when the grow ends, the panel being opaque and covering it by then;
// without a glide (no animation, reduced motion) it is hidden at once. Restore shows it at once.
function setSidePanelMax(on, animate = false) {
  const want = on && sp.open;
  if (want === sp.max) return;
  const ws = $('workspace');
  const el = $('side-panel');
  const before = animate ? el.getBoundingClientRect() : null;
  const mine = (wsHide = {});
  if (want) {
    const w = ws.getBoundingClientRect().width;
    ws.style.flex = `0 0 ${w}px`;
    ws.style.width = `${w}px`;
    sp.max = true;
    el.classList.add('sp-max');
    placeMax();
  } else {
    sp.max = false;
    ws.style.visibility = '';
    el.classList.remove('sp-max');
    el.style.top = '';
    el.style.left = '';
    el.style.bottom = '';
    ws.style.flex = '';
    ws.style.width = '';
    applyWidth();
  }
  syncMaxButton();
  const glide = before ? flipFrom(el, before, want ? { dur: '--dur-drawer', fade: 0.5 } : { dur: '--dur-pop' }) : null;
  if (!want) return;
  const hideWs = () => { if (wsHide === mine && sp.max) ws.style.visibility = 'hidden'; };
  if (glide) glide.then(hideWs); else hideWs();
}

export function toggleSidePanelMax() {
  setSidePanelMax(!sp.max, true);
}

// A menu, dialog (sidebar delete confirmation, usage page) or popup is open: it owns the next Escape,
// the maximized panel waits. Every role=dialog of renderer/ is removed or hidden when closed.
export function ownPopupOpen() {
  // A popup hosted by #workspace (the usage page) inherits the maximize hiding: read it with that lifted.
  const ws = $('workspace');
  const hid = ws.style.visibility;
  ws.style.visibility = '';
  try {
    return [...document.querySelectorAll('[role="menu"], [role="dialog"], [data-sp-popup]')]
      .some((el) => !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
  } finally {
    ws.style.visibility = hid;
  }
}

// The close tail: `hidden` is already true (state and layout are final, the workspace has the freed width), but the panel
// stays painted for --dur-pop as an inert box at the edge it left (absolute, its last box; <html> and <body> never scroll),
// then goes. `tail` names the one tail allowed to clean up; an open or a newer close takes it over.
let tail = null;

function clearTail(el) {
  tail = null;
  el.inert = false;
  for (const p of TAIL_PROPS) el.style.removeProperty(p);
}

function leaveSidePanel(el, from) {
  if (!(from.width > 0 && from.height > 0)) return;
  const mine = {};
  tail = mine;
  const s = el.style;
  s.display = 'flex';
  s.position = 'absolute';
  s.top = `${from.top}px`;
  s.right = `${window.innerWidth - from.right}px`;
  s.bottom = `${window.innerHeight - from.bottom}px`;
  s.width = `${from.width}px`;
  el.inert = true;
  exitThen(el, SLIDE_OUT_KF, { dur: '--dur-pop' }).then(() => {
    if (tail === mine && el.hidden) clearTail(el); // still closed: a reopened panel is not ours to touch
  });
}

// Called BY a tab's open function once its state is set: makes `tab` the
// active one, closes the previously active tab's state, unhides the panel.
export function showSideTab(tab, target) {
  if (!TABS.includes(tab)) return;
  overlayState.closePluginPanel?.(); // one right-hand surface at a time
  const el = $('side-panel');
  const opening = !sp.open || el.hidden;
  const prev = sp.open ? sp.tab : null;
  if (prev && prev !== tab) handlers.get(prev)?.close();
  sp.open = true;
  sp.tab = tab;
  sp.target = target
    ? { paneId: target.paneId, sessionId: target.sessionId }
    : (sp.target || selectedTarget());
  applyWidth();
  if (opening && tail) clearTail(el); // an open supersedes a running close tail
  el.hidden = false;
  for (const t of TABS) {
    const on = t === tab;
    const host = $(HOSTS[t]);
    host.hidden = !on;
    host.classList.toggle('open', on);
    const b = document.querySelector(`.sp-tab[data-tab="${t}"]`);
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  // The panel arrives as a whole when it opens; a tab switch inside an open panel fades the new tab in.
  if (opening) swapIn(el, { dir: 'forward' });
  else if (prev !== tab) swapIn($(HOSTS[tab]), { dur: '--dur-pop' });
}

// Public entry: show `tab` (files | git | plans | terminal) for `target` (default: the
// current target, else the selected pane). `opts` goes to the tab's open():
// { keepFocus } from the panel, { path, line } for the Files tab.
export function openSidePanel(tab, target, opts) {
  if (!TABS.includes(tab)) return;
  const t = target || sp.target || selectedTarget();
  overlayState.closeUsagePage?.(); // one right-hand surface at a time
  overlayState.closeAgentJournal?.();
  const h = handlers.get(tab);
  if (h) h.open(t, opts); else showSideTab(tab, t);
}

export function closeSidePanel() {
  if (!sp.open) return;
  const tab = sp.tab;
  const el = $('side-panel');
  const from = el.getBoundingClientRect(); // the box the leaving tail keeps (the maximized one when maximized)
  setSidePanelMax(false);
  sp.open = false;
  sp.tab = null;
  sp.target = null;
  el.hidden = true;
  for (const t of TABS) {
    const host = $(HOSTS[t]);
    host.hidden = true;
    host.classList.remove('open');
  }
  leaveSidePanel(el, from);
  handlers.get(tab)?.close();
}

export function toggleSidePanel(tab, target) {
  if (sp.open && sp.tab === tab) closeSidePanel(); else openSidePanel(tab, target);
}

// The shown session changed: reload the open tab for it. selectPane fires this on
// EVERY select (re-clicks included) -> a no-op when the target is unchanged, and the
// reload never takes the focus away from the terminal that was just focused.
function onPaneSelected(pane) {
  if (!sp.open || !pane) return;
  const next = { paneId: pane.paneId, sessionId: pane.sessionId };
  if (sameTarget(sp.target, next)) return;
  openSidePanel(sp.tab, next, { keepFocus: true });
}

function startDrag(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = sp.width;
  document.body.classList.add('sp-dragging');
  const move = (ev) => applyWidth(startW + (startX - ev.clientX));
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    document.body.classList.remove('sp-dragging');
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Tab bar + resize handle + Escape + selection slot — called once from boot.js.
export function initSidePanel() {
  overlayState.onPaneSelected = onPaneSelected;
  applyWidth(DEFAULT_W);

  const bar = $('sp-tabs');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('.sp-tab') : null;
    if (!b || (sp.open && sp.tab === b.dataset.tab)) return;
    openSidePanel(b.dataset.tab);
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const at = TABS.indexOf(sp.tab);
    if (at < 0) return;
    const next = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    openSidePanel(next);
    document.querySelector(`.sp-tab[data-tab="${next}"]`).focus({ preventScroll: true });
    e.preventDefault();
  });

  $('sp-close').addEventListener('click', closeSidePanel);
  $('sp-max').addEventListener('click', () => {
    handlers.get(sp.tab)?.userMax?.();
    toggleSidePanelMax();
  });

  const handle = $('sp-resize');
  handle.addEventListener('pointerdown', startDrag);
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    applyWidth(sp.width + (e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP));
    e.preventDefault();
  });
  window.addEventListener('resize', () => {
    if (!sp.open) return;
    if (sp.max) placeMax(); else applyWidth();
  });

  // Sidebar folded / unfolded (deck:sidebar): the panel's width gains / gives back what the sidebar
  // frees / takes. Maximized, only the stored width shifts (applied on restore); its left follows #workspace.
  let sbW = sidebarWidth();
  window.addEventListener('deck:sidebar', () => {
    const next = sidebarWidth();
    const freed = sbW - next;
    sbW = next;
    if (!sp.open) return;
    if (sp.max) {
      sp.width = clampWidth(sp.width + freed);
      placeMax();
    } else {
      applyWidth(sp.width + freed);
    }
  });

  // Maximized: Escape restores first. Capture phase + stopImmediatePropagation, so the
  // tab handlers (viewer, git, plans) do not also act on it; never from a focused
  // terminal (rule 8), and not while a menu / popup is open (its owner closes it first).
  // A max the tab made itself (autoMax) is not restored first: the tab's Escape closes it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sp.open || !sp.max) return;
    if (handlers.get(sp.tab)?.autoMax?.()) return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    if (ownPopupOpen()) return;
    setSidePanelMax(false, true);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Escape closes — never from a focused terminal, and never for a tab that
  // handles Escape itself (git panel: an open chooser eats the first one).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sp.open) return;
    if (sp.max && ownPopupOpen()) return; // the capture listener yielded to it: this Escape is not ours to close with
    if (handlers.get(sp.tab)?.ownEscape) return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    closeSidePanel();
    e.preventDefault();
  });
}
