// claude-deck — renderer/header-tools: the priority+ toolbar of #app-header. No control is ever cut off: when the
// bar is too narrow it folds by STEPS (cumulative classes on the header), then sends its [data-prio] tools into the
// « ⋯ » menu, the lowest data-prio first. A new tool is a button with a data-prio in the markup, nothing here changes.
// Fit test per zone: the visible children plus the gaps against the zone's own width (a flex-end zone spills its
// overflow to the left, where scrollWidth cannot see it). One ResizeObserver (window width, zoom) plus a
// MutationObserver on the zones' content (a text, a badge, the AI mode). Menu items proxy .click() to the ORIGINAL
// buttons, so every handler bound to their ids keeps working. Motion: motion.js, opacity / transform, instant under
// reduced motion. No subscription to a window.api push here: boot.js owns those. In AI mode the open menu hides the
// native claude.ai view (it always draws above the DOM) with the same aiHide / aiShow calls as mode.js.
'use strict';

import { fadeIn, exitThen } from './motion.js';
import { modeState } from './state.js';
import { aiFrameRect } from './mode.js';

const FOLD = ['hs-uncenter', 'hs-noreset', 'hs-shortpill', 'hs-icons', 'hs-nobrand'];
const TAIL = ['hs-modeicons', 'hs-ringonly'];
const ALL = [...FOLD, ...TAIL];
// What a step class changes on screen: those elements fade back in when the class toggles (the layout has already snapped).
const FOLD_TARGETS = {
  'hs-noreset': '.gauge',
  'hs-shortpill': '#session-pill',
  'hs-icons': '.hdr-tool',
  'hs-nobrand': '#brand',
  'hs-modeicons': '.mode-tab',
  'hs-ringonly': '.gauge',
};
const OPEN_KF = [{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }, { opacity: 1, transform: 'none' }];
const CLOSE_KF = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px) scale(0.98)' }];
const FOLD_KF = [{ opacity: 0.35 }, { opacity: 1 }];

// Live state, on the probe seam as window.headerTools.state.
export const headerTools = {
  state: { step: 0, steps: 0, out: [], open: false },
  relayout: () => {},
  open: () => {},
  close: () => {},
};

let hdr; let left; let right; let more; let menu;
let ordered = []; // [data-prio] controls, lowest priority (first to leave) first
let applied = null; // step classes on the header after the last layout (null before the first)
let menuKey = null;
let lastMode = null; // body[data-mode] at the last layout: a mode switch ends an open menu
let nativeHidden = false; // the native claude.ai view is hidden because the menu is open in AI mode
let refs = []; // mirrors of the menu: { tool, item?, badgeSrc?, badge?, info? }

const visible = (el) => getComputedStyle(el).display !== 'none';
const idOf = (t, i) => t.id || (t.dataset.hdrId ||= `tool-${i}`);
const labelOf = (t) => (t.querySelector('.hdr-lbl')?.textContent.trim()) || t.title || t.getAttribute('aria-label') || t.id;

// A zone fits when its visible children (and the gaps between them) are no wider than the zone itself.
function zoneFits(z) {
  const kids = [...z.children].filter(visible);
  const gap = parseFloat(getComputedStyle(z).columnGap) || 0;
  const need = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
  return need <= z.clientWidth + 0.5;
}
const fits = () => zoneFits(left) && zoneFits(right);

// 6 fold steps, one step per tool sent to the menu, then the mode switch icons, then the gauges as rings.
function stepsFor(n) {
  const out = [];
  for (let i = 0; i <= FOLD.length; i++) out.push({ cls: FOLD.slice(0, i), out: 0 });
  for (let k = 1; k <= n; k++) out.push({ cls: FOLD, out: k });
  out.push({ cls: [...FOLD, TAIL[0]], out: n });
  out.push({ cls: [...FOLD, ...TAIL], out: n });
  return out;
}

function apply(step, present) {
  hdr.classList.remove(...ALL);
  hdr.classList.add(...step.cls);
  const gone = new Set(present.slice(0, step.out));
  for (const t of ordered) t.classList.toggle('hs-out', gone.has(t));
  hdr.classList.toggle('hs-more', gone.size > 0);
  return present.slice(0, step.out);
}

// « 7 sessions, 2 attend » -> « 7 · 2 »: the sidebar rebuilds the pill with replaceChildren, so the short form is an attribute.
function syncShort() {
  const pill = document.getElementById('session-pill');
  if (!pill) return;
  const m = /^\D*(\d+)\D+(\d+)\D*$/.exec(pill.textContent.trim());
  if (m) pill.dataset.short = `${m[1]} · ${m[2]}`; else delete pill.dataset.short;
}

function syncMirrors() {
  for (const r of refs) {
    if (r.info) r.info.textContent = r.tool.textContent.trim();
    if (r.badge) { r.badge.textContent = r.badgeSrc.textContent; r.badge.hidden = r.badgeSrc.hidden; }
  }
  more.classList.toggle('has-badge', refs.some((r) => r.badgeSrc && !r.badgeSrc.hidden));
}

function buildMenu(outTools) {
  menu.replaceChildren();
  refs = [];
  const infos = [];
  const items = [];
  [...outTools].reverse().forEach((t, i) => { // most important first
    const key = idOf(t, i);
    if (t.tagName !== 'BUTTON') { // a read-only control (the session pill): an info line
      const info = document.createElement('div');
      info.className = 'hdr-info';
      info.dataset.for = key;
      infos.push(info);
      refs.push({ tool: t, info });
      return;
    }
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'hdr-mi';
    mi.setAttribute('role', 'menuitem');
    mi.dataset.for = key;
    const svg = t.querySelector('svg');
    if (svg) mi.append(svg.cloneNode(true));
    const g = document.createElement('span');
    g.className = 'hdr-grow';
    g.textContent = labelOf(t);
    mi.append(g);
    const ref = { tool: t, item: mi };
    const src = t.querySelector('[data-badge]');
    if (src) {
      ref.badgeSrc = src;
      ref.badge = document.createElement('span');
      ref.badge.className = 'hdr-badge';
      mi.append(ref.badge);
    }
    // Click the original first, close after: a tool that leaves AI mode (Plugins) has then set mode « code », so the
    // close sends no ai-show (closing first gave the claude.ai view back for one frame, the button's setMode('code') hid it again).
    mi.addEventListener('click', () => { t.click(); closeMenu(false); });
    refs.push(ref);
    items.push(mi);
  });
  menu.append(...infos);
  if (infos.length && items.length) { const sep = document.createElement('div'); sep.className = 'hdr-sep'; menu.append(sep); }
  menu.append(...items);
  syncMirrors();
}

function layout() {
  syncShort(); // before the fit test: the short form changes the pill's width
  for (const t of ordered) t.classList.remove('hs-out');
  const present = ordered.filter(visible); // an empty pill, the pill in AI mode: not a tool to fold
  const steps = stepsFor(present.length);
  let i = 0;
  let outTools = [];
  for (; i < steps.length; i++) {
    outTools = apply(steps[i], present);
    if (fits()) break;
  }
  if (i === steps.length) i = steps.length - 1; // nothing fits: the last step stays
  const s = headerTools.state;
  s.step = i + 1;
  s.steps = steps.length;
  s.out = outTools.map((t, k) => idOf(t, k));
  hdr.dataset.step = String(s.step);
  hdr.dataset.steps = String(s.steps);
  const mode = document.body.dataset.mode || 'code';
  if (mode !== lastMode) { // a mode switch ends an open menu (mode.js has already hidden or shown the native view)
    lastMode = mode;
    if (s.open) closeMenu(false);
  }
  const key = s.out.join();
  if (key !== menuKey) { // the tools in the menu changed: rebuild it (and close it, the focus would be lost)
    menuKey = key;
    if (s.open) closeMenu(false);
    buildMenu(outTools);
  } else {
    syncMirrors();
  }
  const now = steps[i].cls;
  if (applied) { // the layout has snapped: the elements a toggled step class changed fade back in
    const sel = ALL.filter((c) => now.includes(c) !== applied.includes(c)).map((c) => FOLD_TARGETS[c]).filter(Boolean);
    if (sel.length) fadeIn(hdr.querySelectorAll(sel.join(',')), FOLD_KF);
  }
  applied = [...now];
}

function openMenu() {
  if (headerTools.state.open || !hdr.classList.contains('hs-more')) return;
  headerTools.state.open = true;
  if (modeState.mode === 'ai') { nativeHidden = true; window.api.aiHide(); } // the native view would cover the menu
  menu.classList.add('open');
  menu.style.removeProperty('display');
  fadeIn([menu], OPEN_KF);
  more.setAttribute('aria-expanded', 'true');
  menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
}

function closeMenu(refocus) {
  if (!headerTools.state.open) return;
  headerTools.state.open = false;
  if (nativeHidden) { // give the native view back, unless the mode already left AI (mode.js hid it)
    nativeHidden = false;
    if (modeState.mode === 'ai') window.api.aiShow(aiFrameRect());
  }
  more.setAttribute('aria-expanded', 'false');
  exitThen(menu, CLOSE_KF, { dur: '--dur-exit' }).then(() => {
    menu.style.removeProperty('display');
    if (headerTools.state.open) { fadeIn([menu], OPEN_KF); return; } // opened again while it was leaving
    menu.classList.remove('open');
  });
  if (refocus) more.focus({ preventScroll: true });
}

function onKey(e) {
  if (!headerTools.state.open) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
  if (e.key === 'Tab') { closeMenu(false); return; }
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let n = -1;
  if (e.key === 'ArrowDown') n = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') n = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = items.length - 1;
  if (n >= 0) { e.preventDefault(); items[n].focus({ preventScroll: true }); }
}

function collectTools() {
  ordered = [...hdr.querySelectorAll('[data-prio]')].sort((a, b) => Number(a.dataset.prio) - Number(b.dataset.prio));
  ordered.forEach((t, i) => idOf(t, i)); // a stable key for a tool that has no id
}

// Wired once from boot.js (first of the inits, so its Escape sees the key before the panels do).
export function initHeaderTools() {
  hdr = document.getElementById('app-header');
  more = document.getElementById('hdr-more');
  menu = document.getElementById('hdr-menu');
  if (!hdr || !more || !menu) return; // markup absent: the header stays a plain bar
  left = document.getElementById('header-left');
  right = document.getElementById('header-right');
  collectTools();
  headerTools.relayout = layout;
  headerTools.open = openMenu;
  headerTools.close = () => closeMenu(false);

  more.addEventListener('click', () => (headerTools.state.open ? closeMenu(true) : openMenu()));
  document.addEventListener('click', (e) => {
    if (headerTools.state.open && !menu.contains(e.target) && !more.contains(e.target)) closeMenu(false);
  });
  window.addEventListener('keydown', onKey, true);

  new ResizeObserver(layout).observe(hdr);
  const mo = new MutationObserver(layout);
  for (const z of [left, right, document.getElementById('mode-switch')]) {
    mo.observe(z, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
  if (document.fonts) {
    document.fonts.ready.then(layout);
    document.fonts.addEventListener('loadingdone', layout);
  }
  layout();
}
