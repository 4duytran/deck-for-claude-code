// claude-deck — renderer/motion: tiny WAAPI helpers for exits and height
// changes that stay on the compositor. Only transform/opacity are ever
// animated; heights are never keyframed: collapse/expand slide the FOLLOWING
// siblings with a measured translateY (FLIP) and flip display at the end.
// Durations/easing come from the tokens.css custom properties (fallbacks below).
'use strict';

const REDUCED_MQ = '(prefers-reduced-motion: reduce)';
const FALLBACK_EASE = 'cubic-bezier(.32,.72,0,1)';
const COMPOSITOR_PROPS = new Set([
  'transform', 'translate', 'scale', 'rotate', 'opacity', 'offset', 'easing', 'composite',
]);
const EXIT_KF = [
  { opacity: 1, transform: 'translateY(0)' },
  { opacity: 0, transform: 'translateY(8px)' },
];
const FOLD_OUT_KF = [
  { opacity: 1, transform: 'translateY(0)' },
  { opacity: 0, transform: 'translateY(-6px)' },
];
const FOLD_IN_KF = [
  { opacity: 0, transform: 'translateY(-6px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

const ENTER_KF = [
  { opacity: 0, transform: 'translateX(-6px)' },
  { opacity: 1, transform: 'translateX(0)' },
];

const FRAME_KF = [{ opacity: 0 }, { opacity: 1 }];
const SWAP_PX = 10; // slide of a page swap (8-12 px reads as a hint, never as travel)
const REVEAL_MAX_MS = 4000;

const SPIN_MS = 700; // one turn of a refresh icon
const SPIN_MAX_MS = 20000; // a reload that never settles must not keep the icon turning for ever
const PRESS_MIN_MS = 160; // reduced motion: the shortest pressed look of a refresh button
const SPIN_KF = [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }];

const spins = new WeakMap(); // refresh button -> its running spin
const live = new WeakMap(); // el -> the running op (one per element)
const entering = new WeakMap(); // el -> its running fadeIn animation

function token(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch { return ''; }
}

function durMs(name, fallbackMs) {
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(token(name));
  if (!m) return fallbackMs;
  return m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}

function timing(name, fallbackMs, extra) {
  return {
    duration: durMs(name, fallbackMs),
    easing: token('--ease-out') || FALLBACK_EASE,
    fill: 'forwards', // held until the op ends, then cancelled with the hide
    ...extra,
  };
}

function instant(el) {
  return typeof el.animate !== 'function' || !el.isConnected
    || window.matchMedia(REDUCED_MQ).matches;
}

function hide(el) { el.style.display = 'none'; }
function show(el) { el.style.removeProperty('display'); el.hidden = false; }

// Drop every keyframe property the compositor cannot animate.
function compositorOnly(kf) {
  const pick = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => COMPOSITOR_PROPS.has(k)));
  return Array.isArray(kf) ? kf.map(pick) : pick(kf);
}

// `opts.scope` of collapse / expand: honoured only for a real ancestor of `el`.
function scopeOf(el, opts) {
  const s = opts && opts.scope;
  return s && s !== el && s.contains(el) ? s : null;
}

// Later in-flow siblings: the only elements that move when `el` leaves or enters the flow. With a `scope` (an ancestor),
// also those of each ancestor of `el` below the scope; none of the scope's own siblings.
function followers(el, scope = null) {
  const out = [];
  for (let n = el; n && n !== scope; n = scope && n.parentElement) { // no scope: the loop runs once
    for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
      const cs = getComputedStyle(s);
      if (cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed') out.push(s);
    }
  }
  return out;
}

// Vertical move of the first follower caused by `change()` (exact: margins and gaps included) and the followers that
// glide by it. `wide` (a scope) reads EVERY follower in one pass before the write and again after it, and keeps only
// those that moved by that same distance: one that did not move with the fold would otherwise glide to a wrong place.
function measureShift(list, change, wide = false) {
  if (!list.length) { change(); return { dy: 0, list }; }
  const probe = wide ? list : [list[0]];
  const before = probe.map((s) => s.getBoundingClientRect().top);
  change();
  const moves = probe.map((s, i) => s.getBoundingClientRect().top - before[i]);
  const dy = moves[0];
  return { dy, list: wide ? list.filter((_, i) => Math.abs(moves[i] - dy) < 0.5) : list };
}

function slide(list, from, to, t) {
  if (Math.abs(from - to) < 0.5) return [];
  const kf = [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }];
  return list.map((s) => s.animate(kf, { ...t, composite: 'add' }));
}

// A newer op on the same element first jumps the running one to its end state.
function supersede(el) { live.get(el)?.end(); }

function run(el, anims, onEnd) {
  const op = {
    end() {
      if (live.get(el) !== op) return;
      live.delete(el);
      for (const a of anims) a.cancel();
      onEnd();
    },
  };
  live.set(el, op);
  return Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => op.end());
}

// Animate `el` out (transform/opacity keyframes), then hide it. Resolves once hidden.
// `opts.dur` names a duration token (default --dur-drawer); a numeric `opts.duration` still wins; other opts go to WAAPI as timing.
export function exitThen(el, kf = EXIT_KF, opts = {}) {
  supersede(el);
  if (instant(el) || getComputedStyle(el).display === 'none') {
    hide(el);
    return Promise.resolve();
  }
  const { dur, ...extra } = opts;
  const anim = el.animate(compositorOnly(kf), timing(dur || '--dur-drawer', 280, extra));
  return run(el, [anim], () => hide(el));
}

// Fade `els` in on --dur-pop (opacity / transform). The caller already applied the end state
// (a width snap, a display flip), so nothing is held or hidden afterwards. Skipped under
// reduced motion and for elements that are not displayed.
export function fadeIn(els, kf = ENTER_KF) {
  const t = { ...timing('--dur-pop', 200), fill: 'none' };
  for (const el of els) {
    entering.get(el)?.cancel();
    if (instant(el) || !el.getClientRects().length) continue;
    entering.set(el, el.animate(compositorOnly(kf), t));
  }
}

// Fold `el` away: it fades up while the siblings below slide into its place. `opts.scope` (an ancestor of `el`) widens the
// slide to the later siblings of each ancestor below it, so everything that sits under the fold inside the scope glides.
export function collapse(el, opts = {}) {
  supersede(el);
  if (instant(el) || getComputedStyle(el).display === 'none') {
    hide(el);
    return Promise.resolve();
  }
  const t = timing('--dur-height', 220);
  const scope = scopeOf(el, opts);
  const prev = el.style.display;
  const { dy, list } = measureShift(followers(el, scope), () => hide(el), !!scope); // dy <= 0
  el.style.display = prev;
  const anims = [el.animate(FOLD_OUT_KF, t), ...slide(list, 0, dy, t)];
  return run(el, anims, () => hide(el));
}

// Page swap, arrival only (the leaving view is replaced at once): `el` is shown and arrives from 10 px on the side it will be read from, fading in on --dur-drawer. The end state
// is the element's own (fill 'none'), so nothing is left inline. Reduced motion or an element that is not displayed: shown, no animation.
// `opts.dur` names a duration token (default --dur-drawer).
export function swapIn(el, opts = {}) {
  supersede(el);
  entering.get(el)?.cancel();
  show(el);
  if (instant(el) || !el.getClientRects().length) return Promise.resolve();
  const x = (opts.dir === 'back' ? -1 : 1) * SWAP_PX;
  const kf = [{ opacity: 0, transform: `translateX(${x}px)` }, { opacity: 1, transform: 'translateX(0)' }];
  const anim = el.animate(kf, { ...timing(opts.dur || '--dur-drawer', 280), fill: 'none' });
  entering.set(el, anim);
  return anim.finished.then(() => {}, () => {});
}

// A report frame paints white before its page is ready. Keep it at opacity 0 until `load`, then fade it in (opacity only, --dur-pop).
// Call it before the frame is attached. `opts.maxMs` bounds the wait for a frame that never loads (default 4 s): then it shows as it is.
// `opts.ready(frame)`, when a function, says whether a `load` is the page's own (a srcdoc frame loads about:blank first): a `load` it
// refuses keeps the frame hidden for the next one.
// `opts.after` (a promise) replaces the wait for `load`, for a frame that is already loaded and only has to sit out a glide. Returns a
// cancel(): it disarms the reveal (the inline opacity is then the caller's to clear).
export function revealFrame(frame, opts = {}) {
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    clearTimeout(timer);
    frame.removeEventListener('load', onLoad);
    frame.style.removeProperty('opacity');
    fadeIn([frame], FRAME_KF);
  };
  const onLoad = () => { if (typeof opts.ready !== 'function' || opts.ready(frame)) reveal(); };
  const timer = setTimeout(reveal, opts.maxMs > 0 ? opts.maxMs : REVEAL_MAX_MS);
  entering.get(frame)?.cancel();
  frame.style.opacity = '0';
  if (opts.after) opts.after.then(reveal, reveal);
  else frame.addEventListener('load', onLoad);
  return () => {
    shown = true;
    clearTimeout(timer);
    frame.removeEventListener('load', onLoad);
  };
}

// FLIP for a box that changes size AND place: `el` is already laid out at its new place, `fromRect` is the box it had
// before. One transform (translate + scale about the centre) glides it from there; grow and shrink are the same call.
// `opts.dur` names a duration token (default --dur-drawer); `opts.fade` (0..1) starts it at that opacity and cross-fades to 1.
// Reduced motion or a degenerate box: nothing runs.
export function flipFrom(el, fromRect, opts = {}) {
  supersede(el);
  if (instant(el)) return Promise.resolve();
  const to = el.getBoundingClientRect();
  if (!(fromRect.width > 0 && fromRect.height > 0 && to.width > 0 && to.height > 0)) return Promise.resolve();
  const dx = fromRect.left + fromRect.width / 2 - (to.left + to.width / 2);
  const dy = fromRect.top + fromRect.height / 2 - (to.top + to.height / 2);
  const sx = fromRect.width / to.width;
  const sy = fromRect.height / to.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002) return Promise.resolve();
  const kf = [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }];
  if (opts.fade >= 0 && opts.fade < 1) { kf[0].opacity = opts.fade; kf[1].opacity = 1; }
  return run(el, [el.animate(kf, timing(opts.dur || '--dur-drawer', 280))], () => {});
}

// Refresh button: `spinWhile(btn, work)` turns the button's icon (its svg) from the click until `work` (the reload's
// promise, or nothing for an instant reload) settles, then lets it finish the turn it is on, so it always stops upright
// and a reload that returns at once still gives one whole turn. A second click while it turns joins the same spin.
// transform only (WAAPI, linear: a spinner). Reduced motion: no rotation, the `rf-busy` look is held for at least
// PRESS_MIN_MS instead. `work` is returned as given, a rejection stays the caller's.
export function spinWhile(btn, work) {
  if (!btn || !btn.isConnected) return work;
  const icon = btn.querySelector('svg') || btn;
  let st = spins.get(btn);
  if (!st) spins.set(btn, st = { open: 0, anim: null, minUntil: 0, timer: 0 });
  st.open += 1;
  clearTimeout(st.timer);
  btn.classList.add('rf-busy');
  if (window.matchMedia(REDUCED_MQ).matches || typeof icon.animate !== 'function') {
    st.minUntil = performance.now() + PRESS_MIN_MS;
  } else if (st.anim && st.anim.playState === 'running') {
    st.anim.effect.updateTiming({ iterations: Infinity }); // still on its last turn: keep going
  } else {
    const anim = icon.animate(SPIN_KF, { duration: SPIN_MS, iterations: Infinity, easing: 'linear' });
    st.anim = anim;
    const over = () => {
      if (st.anim !== anim) return;
      st.anim = null;
      if (!st.open) { btn.classList.remove('rf-busy'); spins.delete(btn); }
    };
    anim.addEventListener('finish', over);
    anim.addEventListener('cancel', over);
  }
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(cap);
    if (--st.open) return;
    if (st.anim && st.anim.playState === 'running') {
      const turns = Math.max(1, Math.ceil((Number(st.anim.currentTime) || 0) / SPIN_MS));
      st.anim.effect.updateTiming({ iterations: turns }); // the finish listener clears the busy look
    } else {
      st.timer = setTimeout(() => {
        if (st.open) return;
        btn.classList.remove('rf-busy');
        spins.delete(btn);
      }, Math.max(0, st.minUntil - performance.now()));
    }
  };
  const cap = setTimeout(end, SPIN_MAX_MS);
  Promise.resolve(work).then(end, end);
  return work;
}

// Inverse of collapse: `el` is back in the flow at once, the siblings glide down. `opts.scope` as for collapse.
export function expand(el, opts = {}) {
  supersede(el);
  if (instant(el)) {
    show(el);
    return Promise.resolve();
  }
  const t = timing('--dur-height', 220);
  const scope = scopeOf(el, opts);
  const { dy, list } = measureShift(followers(el, scope), () => show(el), !!scope); // dy >= 0
  const anims = [el.animate(FOLD_IN_KF, t), ...slide(list, -dy, 0, t)];
  return run(el, anims, () => {});
}
