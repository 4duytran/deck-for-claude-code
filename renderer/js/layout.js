// claude-deck — renderer/layout: window management (v18 minimize/maximize) +
// the v34 defensive resize pipeline + the v34 WebGL renderer fallback.
// LAYOUT STATE ONLY: PTYs and xterm instances stay alive through every
// transition; visibility is pure CSS (display:none via classes). The 2-col
// ResizeObserver pipeline handles ALL refits unchanged: hidden -> visible
// fires it (0 -> N px) and fit() on a hidden pane is a safe no-op (FitAddon
// proposeDimensions reads a NaN height on display:none -> fit early-returns;
// the follow-up pty resize then sends the UNCHANGED cols/rows -> harmless).
// Verified in addon-fit 0.10.0 source.
'use strict';

import { panes, minimized, layoutState, overlayState } from './state.js';
import { fadeIn } from './motion.js';

// Session switch (motion row 10): the arriving pane lifts in 4 px while it fades up.
const SWITCH_KF = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];

// Spot an element: scroll it into view and flash it (terracotta border
// ~600ms) — used when restoring a minimized pane (v30: the already-open
// row click is a visual no-op, it only hands the keyboard back).
export function focusFlash(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.classList.remove('flash');
  void el.offsetWidth; // reflow so a re-add re-triggers the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
}

// Hand the keyboard to the pane's visible face: the composer in chat face
// (.pane-term is display:none there), else the terminal.
export function focusPaneInput(pane) {
  if (pane.chat && pane.el.classList.contains('chat-mode')) pane.chat.inputEl.focus();
  else pane.term.focus();
}

// ---------------------------------------------------------------------------
// v34 — defensive resize: ONE pipeline keeps xterm, the PTY and the pane
// geometry in sync. Golden rules: fit() and pty.resize() are inseparable and
// always carry the SAME cols/rows; never fit a hidden/zero-sized host (a
// stale fit would shrink a live TUI — misplaced cursor, overlapping lines);
// refresh() after fit purges leftovers of the previous geometry.
// ---------------------------------------------------------------------------

// v53 (attacker #4): the one-shot bottom-stick is honored only within this TTL
// of being armed. A face-return's own resync fires within ~60ms (well inside),
// but a flag left armed because the term stayed collapsed must NOT snap an
// UNRELATED resize firing seconds later (the « window-resize while scrolled up »
// regression the v51 up-front-consume guarded — restored here without losing the
// rect-0 preservation fix).
const STICK_TTL_MS = 2000;

export function resyncPane(pane) {
  if (!panes.has(pane.paneId)) return; // closed while scheduled
  const host = pane.el.querySelector('.pane-term');
  if (!host) return;
  const r = host.getBoundingClientRect();
  // PINNED ASSUMPTION: every collapse path in this app is display:none
  // (.minimized, .zoomed siblings, #grid.single non-selected, body[data-mode="ai"] #grid) — where this
  // rect check and fit's getComputedStyle sizing agree. A future hide via
  // visibility:hidden / content-visibility / offscreen would break that
  // agreement and let a stale fit through — keep collapse == display:none.
  // v53: the rect guard now comes BEFORE consuming the one-shot bottom-stick.
  // A resync that fires while the term is momentarily collapsed (mid-reflow, a
  // zoomed sibling, the grid hidden in AI mode) must NOT swallow the flag —
  // that was the intermittent « back to terminal, not at the bottom » bug: the
  // v51 up-front consume dropped the stick on ANY collapsed resync that beat
  // the face-return's own. Leaving the flag intact lets the next real-rect
  // resync honor it. The flag is set ONLY by face-return paths and is consumed
  // below on the first fit that actually runs, so it cannot leak to an
  // unrelated later resize (that resize finds it already false).
  if (r.width <= 0 || r.height <= 0) return; // hidden/collapsed -> skip, never fit
  const stickBottom = pane._stickBottomOnce === true
    && Date.now() - (pane._stickBottomAt || 0) < STICK_TTL_MS; // v53 (attacker #4): drop a stale flag
  pane._stickBottomOnce = false;
  try {
    pane.fit.fit();
    window.api.resize(pane.paneId, pane.term.cols, pane.term.rows);
    pane.term.refresh(0, pane.term.rows - 1);
    // v51: a face-return (chat switch / restore-from-minimize) re-pins the
    // native scrollbar to the live bottom. The host was display:none while
    // output streamed, so xterm tracks the bottom (viewportY===baseY) but the
    // DOM scrollbar is parked mid-history and scrollToBottom() no-ops there —
    // pin scrollTop explicitly AFTER the fit (scrollHeight is final). At max
    // scrollTop the scroll event xterm fires resolves to amount 0 (already at
    // baseY), so the model is never moved. Opt-in + one-shot => the shared
    // resize path (window resize, AI return) is never snapped, which kept
    // hidden-output (d)'s canvas frame intact.
    if (stickBottom) {
      // INVARIANT: scrollToBottom() MUST precede the scrollTop poke. It puts
      // ydisp at ybase first, so the poke to max scrollTop resolves to a
      // scroll amount of 0 (no model move). Inverting the order risks a
      // spurious scroll the next refactor wouldn't catch (probe s6 guards it).
      const pin = () => {
        // v53 (attacker #2): pin() runs ASYNC from xterm's write queue — the
        // pane may have been closed (term disposed) between the write and the
        // drain. Guard + swallow so the callback never throws on a dead term.
        if (!panes.has(pane.paneId)) return;
        try {
          pane.term.scrollToBottom();
          const vp = pane.el.querySelector('.xterm-viewport');
          if (vp) vp.scrollTop = vp.scrollHeight;
        } catch (_) { /* disposed mid-drain — nothing to pin */ }
      };
      pin();
      // v53: a burst that landed while the term was display:none may still be
      // in xterm's async write buffer HERE — scrollHeight isn't final until it
      // drains, and a poke to a stale max reads as a user scroll-up (auto-
      // follow off) that strands the tail below the fold (the « de temps en
      // temps » miss). Re-pin once the buffer is parsed: the empty write's
      // callback fires after the queue drains (sync no-op if already empty).
      try { pane.term.write('', pin); } catch (_) { /* older xterm: pin() already ran */ }
    }
    window.__deckResyncs = (window.__deckResyncs || 0) + 1; // probe seam
  } catch (_) { /* a resize path must never kill a pane */ }
}

// Debounced entry point — EVERY geometry trigger funnels here (~60ms/pane).
export function scheduleResync(paneId, delay = 60) {
  const pane = panes.get(paneId);
  if (!pane) return;
  clearTimeout(pane.resyncTimer);
  pane.resyncTimer = setTimeout(() => {
    const p = panes.get(paneId);
    if (p) resyncPane(p);
  }, delay);
}

export function resyncAllVisible() {
  for (const pane of panes.values()) {
    if (minimized.has(pane.paneId)) continue; // hidden -> guard would skip anyway
    scheduleResync(pane.paneId);
  }
}

// v34 WebGL renderer — the DOM renderer leaves residue on CC's intense
// in-place redraws (spinners, todos, progress bars). Context loss IS
// expected and WILL happen (GPU OOM, suspend, offscreen, ~16-context
// browser limit): on loss, dispose and fall back to DOM for THIS pane, then
// resync — otherwise the pane freezes/blacks out. The try/catch covers
// "no WebGL2 at all" and the context limit at creation time. Canvas addon
// deliberately excluded (deprecated upstream; reco is DOM or WebGL).
export function attachWebglRenderer(paneId, term) {
  if (typeof WebglAddon === 'undefined' || !WebglAddon.WebglAddon) {
    return { gl: null, rendererMode: 'dom' }; // bundle missing -> DOM is fine
  }
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => webglFallbackToDom(paneId));
    term.loadAddon(gl);
    return { gl, rendererMode: 'webgl' };
  } catch (_) {
    return { gl: null, rendererMode: 'dom' }; // no GL / context limit -> DOM
  }
}

export function webglFallbackToDom(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  try { if (pane.gl) pane.gl.dispose(); } catch (_) { /* already disposed */ }
  pane.gl = null;
  pane.rendererMode = 'dom';
  window.__deckGlFallbacks = (window.__deckGlFallbacks || 0) + 1; // probe seam
  scheduleResync(paneId, 0); // repaint immediately on the DOM renderer
}

function setMaxButton(pane, on) {
  const b = pane.el.querySelector('.pane-max');
  if (b) { b.textContent = on ? '❐' : '▢'; b.title = on ? 'Restore' : 'Maximize'; }
}

export function toggleMaximize(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const grid = document.getElementById('grid');
  if (layoutState.maximizedPaneId === paneId) { // restore -> back to the 2-col grid
    layoutState.maximizedPaneId = null;
    grid.classList.remove('zoomed');
    pane.el.classList.remove('maximized');
    setMaxButton(pane, false);
  } else {
    if (layoutState.maximizedPaneId !== null) { // zoom jumps to another pane
      const prev = panes.get(layoutState.maximizedPaneId);
      if (prev) { prev.el.classList.remove('maximized'); setMaxButton(prev, false); }
    }
    layoutState.maximizedPaneId = paneId;
    grid.classList.add('zoomed');
    pane.el.classList.add('maximized');
    setMaxButton(pane, true);
    focusPaneInput(pane);
  }
  // v34: zoom geometry just changed for every pane (zoomed one grew, the
  // others hid or came back) — hidden ones are skipped by the resync guard.
  resyncAllVisible();
}

export function minimizePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane || minimized.has(paneId)) return;
  if (layoutState.maximizedPaneId === paneId) toggleMaximize(paneId); // never an empty zoomed grid
  minimized.add(paneId);
  pane.el.classList.add('minimized'); // display:none — xterm keeps buffering
}

// v51: output streamed while the pane was hidden (display:none) left the native
// scrollbar parked mid-history — same hazard as the chat face. Arm the one-shot
// re-pin that the resync of the SHOWN pane consumes (shared by restorePane and
// selectPane, the two ways a hidden pane comes back).
function armBottomStick(pane) {
  if (!pane.outputWhileTermHidden) return;
  pane.outputWhileTermHidden = false;
  pane._stickBottomOnce = true;
  pane._stickBottomAt = Date.now(); // v53 (attacker #4): TTL stamp
}

export function restorePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  minimized.delete(paneId);
  pane.el.classList.remove('minimized');
  armBottomStick(pane); // .minimized was just removed: the resync below sees a real rect
  // v34: fit right after layout lands (rAF) — correct on the very first
  // visible frame; the pane's ResizeObserver stays as backup.
  requestAnimationFrame(() => {
    const p = panes.get(paneId);
    if (p) resyncPane(p);
  });
  focusFlash(pane.el);
  focusPaneInput(pane);
}

// Empty state of the single view: shown while no pane is selected.
function syncGridEmpty() {
  const empty = document.getElementById('grid-empty');
  if (empty) empty.hidden = layoutState.selectedPaneId !== null;
}

// Tell the sidebar (it cannot be imported from here) which pane is shown.
function announceSelection() {
  document.dispatchEvent(new CustomEvent('deck:pane-selected', {
    detail: { paneId: layoutState.selectedPaneId },
  }));
}

// B1 single view: exactly one pane is shown, the others keep running hidden
// (display:none — the resync guard above depends on it). A minimized pane is
// un-parked first; a zoom on ANOTHER pane is released so the view is never empty.
export function selectPane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (layoutState.maximizedPaneId !== null && layoutState.maximizedPaneId !== paneId) {
    toggleMaximize(layoutState.maximizedPaneId);
  }
  if (minimized.delete(paneId)) pane.el.classList.remove('minimized');
  const arriving = !pane.el.classList.contains('selected');
  layoutState.selectedPaneId = paneId;
  for (const p of panes.values()) p.el.classList.toggle('selected', p === pane);
  // A re-click on the shown row only hands the keyboard back: no fade.
  if (arriving) fadeIn([pane.el], SWITCH_KF);
  const at = layoutState.recent.indexOf(paneId);
  if (at !== -1) layoutState.recent.splice(at, 1);
  layoutState.recent.push(paneId);
  syncGridEmpty();
  // Consumed by the rAF resync below once the terminal has a real rect. A chat-face
  // pane keeps its flag: its terminal stays collapsed, the face-return path owns it.
  if (!pane.el.classList.contains('chat-mode')) armBottomStick(pane);
  requestAnimationFrame(() => {
    const p = panes.get(paneId);
    if (!p) return;
    resyncPane(p);
    // Chat face: appends while hidden could not scroll a collapsed feed — a feed that
    // was following the tail goes back to it (a feed scrolled up is left alone).
    const c = p.chat;
    if (c && c.atBottom && p.el.classList.contains('chat-mode')) c.scrollEl.scrollTop = c.scrollEl.scrollHeight;
  });
  focusPaneInput(pane);
  announceSelection();
  try { if (overlayState.onPaneSelected) overlayState.onPaneSelected(pane); } catch (_) { /* a consumer must never break the switch */ }
}

// The shown pane is gone and nothing replaces it: back to the empty state.
export function clearSelection() {
  layoutState.selectedPaneId = null;
  for (const p of panes.values()) p.el.classList.remove('selected');
  syncGridEmpty();
  announceSelection();
}

// Global listeners — called once from boot.js.
export function initLayout() {
  // Self-heal: Chromium throttles rendering while backgrounded — on the way
  // back (window focus / page visible again) re-sync every visible pane. NO
  // brutal periodic timer: these events cover the "spontaneous" desyncs.
  window.addEventListener('focus', resyncAllVisible);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resyncAllVisible();
  });
  // Window resize: each pane's ResizeObserver fires too — explicit + idempotent
  // (the per-pane debounce coalesces both into one resync).
  window.addEventListener('resize', resyncAllVisible);

  // B1: the workspace shows ONE session at a time (the others run hidden).
  const grid = document.getElementById('grid');
  grid.classList.add('single');
  syncGridEmpty();

  // Esc = restore from zoom — but ONLY when the keypress comes from the app
  // chrome. Esc typed INSIDE a terminal belongs to the program running there
  // (interrupt claude, exit vim modes…), never intercept it. Skipped in the
  // single view: zoom is subsumed there, Esc stays with the app.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || layoutState.maximizedPaneId === null) return;
    if (grid.classList.contains('single')) return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    toggleMaximize(layoutState.maximizedPaneId);
  });
}
