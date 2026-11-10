// claude-deck — renderer/mode: 'code' (terminal grid) / 'ai' (claude.ai)
// switch (v19). The AI view is a NATIVE WebContentsView owned by main; the
// DOM only contributes the #ai-frame placeholder whose measured rect drives
// the native bounds. Switching is visibility-only on BOTH sides (CSS classes
// here, setVisible in main — explicit, a native view ignores display rules):
// the grid's panes and the claude.ai page both stay alive untouched.
'use strict';

import { panes, modeState, overlayState } from './state.js';
import { resyncAllVisible } from './layout.js';
import { closeSidePanel } from './side-panel.js';
import { closeUsagePage } from './usage-page.js';

export function aiFrameRect() { // also read by header-tools.js to give the native view back after its « ⋯ » menu
  const r = document.getElementById('ai-frame').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height }; // main rounds
}

// v27 — animated switch ("fade-through", à la Raycast). The native AI view
// CANNOT fade (Electron View has no opacity API): the DOM does all the
// motion, and the native show/hide is a hard cut landing on an identical
// #0d1117 backdrop (the v21 skin) where it reads as part of the fade.
//   code -> ai : fade the code UI out, THEN swap + show the native view.
//   ai -> code : hide the view at once, swap, fade the code UI in.
// ONLY #grid/#sidebar animate — never #workspace/#ai-frame, whose measured
// rect feeds the native bounds (a mid-transition transform would skew it).
const MODE_OUT_MS = 400; // CSS slide-out (350ms) + a beat of dark — lets the
                         // exit READ as a transition before the swap
const MODE_IN_MS = 1200; // CSS delay (300ms) + slide-in (850ms) + margin (v36.2)
let fadeInTimer = 0;

function applyModeTabs(next) {
  for (const [id, m] of [['mode-code', 'code'], ['mode-ai', 'ai']]) {
    const tab = document.getElementById(id);
    tab.classList.toggle('active', next === m);
    tab.setAttribute('aria-selected', String(next === m));
  }
}

function commitMode(next) {
  modeState.mode = next;
  document.body.dataset.mode = next; // CSS swaps grid <-> placeholder
  if (next === 'ai') {
    // The dataset flip above already re-laid out (getBoundingClientRect
    // forces sync layout) -> the rect reads post-switch, never stale.
    window.api.aiShow(aiFrameRect()); // lazy-creates + positions + shows
  } else {
    window.api.aiHide(); // EXPLICIT — the native view ignores display:none
  }
}

export function setMode(next) {
  if (next !== 'code' && next !== 'ai') return;
  if (modeState.switching) { modeState.queuedMode = next; return; } // settle first, honor last click
  if (next === modeState.mode) return;
  applyModeTabs(next); // header feedback is immediate; content follows
  if (next === 'ai') {
    closeSidePanel(); // v39/v40: the native AI view always draws above the DOM (git / plans / files tabs)
    closeUsagePage(); // same reason — #usage-page is a DOM overlay too
    overlayState.closePluginPanel?.(); // and #plugin-panel (AMD-4 A4-4)
    modeState.switching = true;
    document.body.classList.add('mode-fade-out');
    setTimeout(() => {
      modeState.switching = false;
      const q = modeState.queuedMode;
      modeState.queuedMode = null;
      if (q === 'code') {
        // Canceled mid-fade: the AI view never shows — just fade back in.
        document.body.classList.remove('mode-fade-out');
        applyModeTabs('code');
        return;
      }
      commitMode('ai');
      // Reset under display:none — the return to Code then starts from a
      // clean (opacity 1) base and only the mode-in keyframes animate it.
      document.body.classList.remove('mode-fade-out');
    }, MODE_OUT_MS);
  } else {
    // SYNCHRONOUS swap — openPane's mode guard must land on a visible grid
    // in the same tick (v19 contract).
    commitMode('code');
    document.body.classList.remove('mode-fade-in');
    void document.getElementById('grid').offsetWidth; // reflow: retrigger anim
    document.body.classList.add('mode-fade-in');
    // v34: the grid is back — sizes may have changed while it was hidden
    // (window resized in AI mode). The fade-in animates opacity + transform,
    // neither of which touches COMPUTED geometry (fit's getComputedStyle
    // sizing is transform-blind) -> resync on the next frame is safe, plus
    // once more after the animation settles (belt and braces).
    // v38: same first visible frame — panes that streamed output while
    // hidden jump back to the live bottom (the user never sees the stale
    // reading position); untouched panes keep their scroll position.
    requestAnimationFrame(() => {
      resyncAllVisible();
      for (const pane of panes.values()) {
        if (!pane.outputWhileAi) continue;
        pane.outputWhileAi = false;
        try { pane.term.scrollToBottom(); } catch (_) { /* never kill the swap */ }
      }
    });
    clearTimeout(fadeInTimer);
    fadeInTimer = setTimeout(() => {
      document.body.classList.remove('mode-fade-in');
      resyncAllVisible(); // v34: post-animation resync (after, not during)
    }, MODE_IN_MS);
  }
}

// Tabs + back button + native-bounds re-sync — called once from boot.js.
export function initMode() {
  // Window resizes (and any workspace reflow) re-sync the native bounds. The
  // observer also fires on the hidden->shown flip (0 -> N px), covering the
  // switch itself. Mode guard: hiding fires it once at size 0 — never push that.
  const aiRO = new ResizeObserver(() => {
    if (modeState.mode === 'ai') window.api.aiBounds(aiFrameRect());
  });
  aiRO.observe(document.getElementById('ai-frame'));

  document.getElementById('mode-code').addEventListener('click', () => setMode('code'));
  document.getElementById('mode-ai').addEventListener('click', () => setMode('ai'));
  // v22 escape hatch — back through the native view's history (claude.ai pages
  // like /design drop the sidebar and would otherwise strand the user).
  document.getElementById('ai-back').addEventListener('click', () => window.api.aiBack());
}
