// claude-deck — renderer/view-full: « Plein écran » / « Réduire » of a view that holds a page frame (Plugins report, Plans HTML plan, Files page).
// wireViewFull() puts `cls` on `panel` (the style.css rules then make `view` fill the Deck window) and glides the switch with motion.js
// flipFrom on the page-swap timing family: enter --dur-drawer with a cross-fade, exit --dur-pop; transform / opacity only, instant under
// reduced motion. `holdFrame` (Files / Plans, whose frame paints an opaque #fff) keeps the frame at opacity 0 during the glide and fades it back in after it.
// The OS window is never put in full screen and the frame is never re-mounted. The button lives in `view` while a frame
// is there, else parked hidden in `park`; a view that loses its frame, or a panel that closes (`isOpen()` false), resets it.
// `frameSel` (default: a direct child iframe) says where the frame sits; `watch` lists the elements, besides `panel`, whose class / hidden
// flags can turn `isOpen()` false.
'use strict';

import { flipFrom, revealFrame } from './motion.js';
import { ownPopupOpen } from './side-panel.js';

const ENTER_FADE = 0.5; // opacity the growing view starts from
const HOLD_MAX_MS = 1200; // a glide that never reports its end must not keep the page hidden

const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

export function wireViewFull({ panel, view, btn, park, cls, isOpen, frameSel = ':scope > iframe', watch = [], holdFrame = false }) {
  let full = false;
  let hold = null; // { f, cancel }: the frame kept at opacity 0 while the view glides
  const frame = () => view.querySelector(frameSel);

  function release() {
    if (!hold) return;
    hold.cancel();
    hold.f.style.removeProperty('opacity');
    hold = null;
  }

  // The out-of-process frame lays out late during the glide, so the area it exposes shows the frame ELEMENT's own background: #fff for a Files /
  // Plans page (a page with no background of its own needs that canvas). With `holdFrame` that frame stays at opacity 0 over the view's dark surface
  // for the glide and two painted frames after it, then fades back in (opacity only, --dur-pop, motion.js revealFrame). The Plugins report frame is
  // transparent, exposes nothing and does not opt in; reduced motion starts no glide, so nothing is hidden.
  function hideFrame(glide) {
    const f = frame();
    if (f) hold = { f, cancel: revealFrame(f, { after: glide.then(raf2), maxMs: HOLD_MAX_MS }) };
  }

  function setFull(next, animate) {
    if (next === full) return;
    const from = animate ? view.getBoundingClientRect() : null;
    full = next;
    release();
    panel.classList.toggle(cls, next);
    btn.textContent = next ? 'Réduire' : 'Plein écran';
    btn.setAttribute('aria-pressed', String(next));
    if (from) {
      const glide = flipFrom(view, from, next ? { dur: '--dur-drawer', fade: ENTER_FADE } : { dur: '--dur-pop' });
      if (holdFrame && view.getAnimations().length) hideFrame(glide);
    } else for (const a of view.getAnimations()) a.cancel();
  }

  const exit = () => setFull(false, true);

  // The button follows the frame: in the view while a frame is there, parked (hidden) otherwise. The view repaints detach it, so it is kept by reference.
  function sync() {
    if (frame()) {
      if (btn.parentNode !== view) view.append(btn);
      btn.hidden = false;
      return;
    }
    release();
    setFull(false, false);
    btn.hidden = true;
    if (btn.parentNode !== park) park.append(btn);
  }

  btn.addEventListener('click', () => { if (full) exit(); else if (frame()) setFull(true, true); });
  new MutationObserver(sync).observe(view, { childList: true });
  const gone = new MutationObserver(() => { if (!isOpen()) setFull(false, false); });
  for (const n of [panel, ...watch]) gone.observe(n, { attributes: true, attributeFilter: ['class', 'hidden'] });
  sync();

  return {
    isFull: () => full,
    exit,
    // Escape typed with the focus in the frame: only main sees it. A focus anywhere else is the panel's own handler.
    frameEscape() { if (full && document.activeElement === frame()) exit(); },
  };
}

// What a side-panel tab with a full-screen view adds on top of wireViewFull (plans-full.js, files-full.js); `full` is its handle.
// reset(): the ask chip is fixed in body at the selection's Deck coordinates and the toggle moves the frame under it (the page's relay posts
// nothing on a move), so every change of the full state calls it; it also closes the popup the chip opened.
// Escape steps back one level per press: an open popup / menu / ask composer first (its owner closes it), then this full screen, then the
// maximized side panel, then the tab. A window capture listener runs before the document ones of those, so it takes the Escape that leaves
// full screen and they never see it. Never from a focused terminal (rule 8); the popup test is the side panel's own.
export function wireFullGuards({ full, panel, reset }) {
  let was = false;
  new MutationObserver(() => {
    if (full.isFull() === was) return;
    was = full.isFull();
    reset();
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !full.isFull()) return;
    if ((e.target && e.target.closest && e.target.closest('.pane-term')) || ownPopupOpen()) return;
    full.exit();
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
