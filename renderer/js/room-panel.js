// claude-deck — renderer/room-panel: the inter-session room chat the HUMAN
// sees and posts into. Self-initializing (NOT wired through boot.js) so the
// whole feature stays isolated and trivially removable. Same overlay shell as
// the git/plans panels (slide-in, .open). Live feed via window.api.onRoomAppend
// ('room-append' push from the router); a human post goes out as from:'user'
// (label 'you').
//
// Security: every message field is session/file-controlled text -> DOM +
// textContent ONLY, never innerHTML (same rule as the plans panel).
'use strict';

// S6b: overlayState (renderer/js/state.js) is reached via `window.overlayState`
// here, NOT a static `import` — this file is also require()'d headlessly by
// .scratch/room-relabel-probe.js and room-tolabel-probe.js to unit-test
// party() against the real source (see the seam at the bottom). Node's
// module-type auto-detection reparses a typeless .js as ESM the instant it
// sees ANY top-level import/export, which silences the `typeof module !==
// 'undefined'` CommonJS guard below and drops the party() export entirely
// (measured: require() then returns `{}`). boot.js's existing PROBE SEAM
// Object.assign(window, …) publishes the same state.js object reference, so
// `window.overlayState` here is the identical singleton the other overlay
// modules import directly.
const FEED_CAP = 300; // floor for the bounded in-memory feed (panel is a live view, not an archive)
const COUNT_KEY = 'roomFeedCount'; // localStorage: the human's chosen display size
const DEFAULT_COUNT = 10;          // matches config.ROOM_FEED_DEFAULT
const TOUT = 0;                    // the "Tout" preset value (all, up to the archive ceiling)
const LOAD_CEILING = 500;          // mirrors room-db RECENT_CEILING: max rows "Tout" can pull (DOM-safe)

const room = { open: false, unread: 0, msgs: [], cap: FEED_CAP };

// The chosen number of messages to show (0 = "Tout"), persisted across restarts.
// An unset or non-numeric value falls back to the default.
function readCount() {
  const raw = localStorage.getItem(COUNT_KEY);
  if (raw === null) return DEFAULT_COUNT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COUNT;
}

function el(id) { return document.getElementById(id); }

function fmtTime(ts) {
  if (typeof ts !== 'string') return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Render a room participant as "<label> (<shortid>)" — the display name plus its
// precise reply handle (`room send --to <shortid>`). The specials name themselves
// with NO id suffix: '*' = broadcast, 'user' = the human, 'router' = a delivery
// bounce. A real session id with no known label falls back to its short id alone;
// a bare label typed as a target (non-id) shows as typed. This is what turns the
// old "test-1 → <full-uuid>" into "test-1 (96ae8e1f) → test-2 (9c69e356)".
const PARTY_SPECIAL = { '*': '★ toutes', user: 'vous', router: 'router' };
function party(id, label) {
  if (!id) return '?';
  const s = String(id);
  if (PARTY_SPECIAL[s] !== undefined) return label || PARTY_SPECIAL[s];
  const short = s.slice(0, 8);
  // A session id is either a canonical UUID or a bare hex short-prefix handle.
  const looksLikeId = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{8,}$/i.test(s);
  if (label) {
    // Don't double-print the id: the spawn-time fallback label is `<cwd>-<shortid>`,
    // which already ends with the short id — appending "(<shortid>)" would read
    // "workspace-96ae8e1f (96ae8e1f)". Main-side relabelMessage normally swaps such
    // a fallback for the real name, so this only bites a genuinely-unregistered peer.
    if (label === short || label.endsWith(`-${short}`)) return label;
    return looksLikeId ? `${label} (${short})` : label;
  }
  return looksLikeId ? short : s;
}

function rowFor(m) {
  const row = document.createElement('div');
  row.className = 'rp-row';
  if (m.from === 'user') row.classList.add('rp-self');
  else if (m.from === 'router') row.classList.add('rp-router');

  const meta = document.createElement('div');
  meta.className = 'rp-meta';
  const who = document.createElement('span');
  who.className = 'rp-from';
  who.textContent = party(m.from, m.from_label);
  const arrow = document.createElement('span');
  arrow.className = 'rp-arrow';
  arrow.textContent = ` → ${party(m.to, m.to_label)}`;
  const time = document.createElement('span');
  time.className = 'rp-time';
  time.textContent = fmtTime(m.ts);
  meta.append(who, arrow, time);

  const body = document.createElement('div');
  body.className = 'rp-text';
  body.textContent = String(m.text == null ? '' : m.text);

  row.append(meta, body);
  return row;
}

function atBottom(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
}

function renderAll() {
  const feed = el('rp-feed');
  if (!feed) return;
  feed.textContent = '';
  if (!room.msgs.length) {
    const empty = document.createElement('div');
    empty.className = 'rp-empty';
    empty.textContent = 'Aucun message. Écris à une session (ou à * pour toutes).';
    feed.appendChild(empty);
    return;
  }
  for (const m of room.msgs) feed.appendChild(rowFor(m));
  feed.scrollTop = feed.scrollHeight;
}

function pushMsg(m) {
  room.msgs.push(m);
  if (room.msgs.length > room.cap) room.msgs = room.msgs.slice(-room.cap);
}

function onAppend(m) {
  if (!m || typeof m !== 'object') return;
  pushMsg(m);
  if (room.open) {
    const feed = el('rp-feed');
    if (!feed) return;
    const stick = atBottom(feed);
    const placeholder = feed.querySelector('.rp-empty');
    if (placeholder) feed.textContent = '';
    feed.appendChild(rowFor(m));
    if (stick) feed.scrollTop = feed.scrollHeight;
  } else if (m.from !== 'user') {
    room.unread += 1; // don't count the human's own posts as unread
    updateBadge();
  }
}

function updateBadge() {
  const badge = el('room-badge');
  if (!badge) return;
  if (!room.open && room.unread > 0) {
    badge.textContent = room.unread > 99 ? '99+' : String(room.unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// Loader factories load on first use: a static import would make Node reparse this
// file as ESM and drop the headless require() export below.
let loaderMod = null;
const loaders = () => (loaderMod ??= import('./loading.js').catch(() => null));
// Same reason for the refresh spin of motion.js; init() warms it, so a click finds the module loaded.
let motionMod = null;
const motion = () => (motionMod ??= import('./motion.js').catch(() => null));

// `user`: started by the human (refresh button, count selector) -> a strip over the kept rows.
// No row to keep -> placeholder rows. Any other reload over rows shows nothing.
async function loadFeed({ user = false } = {}) {
  const count = readCount();
  // In-memory cap tracks the chosen view size, but never below FEED_CAP so live
  // growth has headroom; "Tout" (0) uses the archive read-ceiling so a large
  // history isn't re-clipped client-side.
  room.cap = count === TOUT ? LOAD_CEILING : Math.max(FEED_CAP, count);
  const pending = window.api.roomRecent(count).catch(() => null);
  const feed = el('rp-feed');
  const ld = feed ? await loaders() : null;
  let loader = null;
  if (ld && feed.querySelector('.rp-row')) {
    if (user) {
      loader = ld.progressBar();
      feed.before(loader);
    }
  } else if (ld) {
    feed.textContent = '';
    loader = ld.skeleton();
    feed.append(loader);
  }
  const res = await pending;
  loader?.remove();
  room.msgs = (res && res.ok && Array.isArray(res.messages)) ? res.messages.slice(-room.cap) : [];
  renderAll();
}

async function loadWho() {
  const res = await window.api.roomWho().catch(() => null);
  const sessions = (res && res.ok && Array.isArray(res.sessions)) ? res.sessions : [];
  const sel = el('rp-to');
  const whoEl = el('rp-who');
  if (whoEl) {
    whoEl.textContent = sessions.length
      ? `${sessions.length} session${sessions.length > 1 ? 's' : ''} en ligne`
      : 'aucune session en ligne';
  }
  if (!sel) return;
  const prev = sel.value;
  sel.textContent = '';
  const broadcast = document.createElement('option');
  broadcast.value = '*';
  broadcast.textContent = '★ toutes (broadcast)';
  sel.appendChild(broadcast);
  for (const s of sessions) {
    const opt = document.createElement('option');
    // Route by the PRECISE session id (never an ambiguous label) so a directed
    // message always reaches the intended session; the label is display only.
    opt.value = s.session_id;
    const short = String(s.session_id).slice(0, 8);
    const cwd = s.cwd ? ` · ${s.cwd.split('/').pop()}` : '';
    opt.textContent = `${s.label || short} (${short})${cwd}`;
    sel.appendChild(opt);
  }
  // keep the prior selection if it still exists, else default to broadcast
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '*';
}

function openPanel() {
  const panel = el('room-panel');
  if (!panel) return;
  window.overlayState?.closeAgentJournal?.(); // S6b: journal-centric exclusivity (aj11)
  window.overlayState?.closePluginPanel?.(); // one right-hand surface at a time
  room.open = true;
  room.unread = 0;
  updateBadge();
  panel.hidden = false;
  // v65/v66: the entrance is a CSS @keyframes (mode-in) — a keyframe plays on
  // class-add regardless of any start-frame commit (unlike a bare transition),
  // so no reflow/rAF dance is needed. It rides a TRANSIENT class (.rp-anim-in),
  // NOT .open: a permanent animation on .open forwards-pins opacity:1 (so the
  // mode-switch fade-out can't run) and re-fires when the mode-fade-in override
  // lifts. Keeping .open animation-free lets the panel sync with #grid/#sidebar
  // during a Code<->AI switch (style.css body.mode-fade-*), mirroring mode.js's
  // own .mode-fade-in add/remove. Same feel (fade-through + 48px slide + scale).
  panel.classList.add('open');
  panel.classList.add('rp-anim-in');
  clearTimeout(room._animT);
  room._animT = setTimeout(() => panel.classList.remove('rp-anim-in'), 320); // > panel-in on --dur-drawer (280 ms)
  loadFeed();
  loadWho();
  const input = el('rp-input');
  if (input) input.focus({ preventScroll: true });
}

function closePanel() {
  const panel = el('room-panel');
  if (!panel || !room.open) return;
  room.open = false;
  disarmClear(); // don't leave the clean button armed across a close/reopen (else 1 click wipes)
  // Drop any in-flight entrance — .rp-anim-in's forwards-fill would pin
  // opacity:1 and block the close fade.
  clearTimeout(room._animT);
  panel.classList.remove('rp-anim-in');
  panel.classList.remove('open');
  setTimeout(() => { if (!room.open) panel.hidden = true; }, 240); // > CSS fade-out on --dur-pop (200 ms)
}

function togglePanel() {
  if (room.open) closePanel(); else openPanel();
}

// "Clean" button: wipe the whole room log and empty the feed. Confirms with a
// two-click INLINE arm on the button — NOT window.confirm(): a native modal from
// the renderer blocks the process and leaves Electron+xterm keyboard focus dead
// (every pane stops accepting input until app restart). The rest of the app already
// confirms via custom DOM (sidebar.js), never a native dialog. First click arms
// (red ring, 4s auto-disarm); second click wipes. Truncates main.jsonl main-side
// (window.api.roomClear); the local feed is cleared here so the panel reflects it
// immediately without a reload. Arm-state rides the `room` object (like _animT).
function disarmClear() {
  clearTimeout(room._clearT);
  room._clearArmed = false;
  const btn = el('rp-clear');
  if (btn) {
    btn.style.outline = '';
    btn.title = 'Vider la room (effacer tous les messages)';
  }
}

async function clearRoom() {
  const btn = el('rp-clear');
  if (!room._clearArmed) {
    room._clearArmed = true;
    room._clearArmedAt = Date.now();
    if (btn) {
      btn.style.outline = '2px solid #e5534b';
      btn.title = 'Re-cliquer pour vider la room (ou attendre pour annuler)';
    }
    clearTimeout(room._clearT);
    room._clearT = setTimeout(disarmClear, 4000);
    return;
  }
  // Armed: swallow a rapid second click — a habitual double-click would otherwise
  // arm+wipe with no deliberation gap (the native confirm we removed intercepted
  // that). Stay armed; only a click past the debounce performs the wipe.
  if (Date.now() - (room._clearArmedAt || 0) < 350) return;
  disarmClear();
  if (!window.api || typeof window.api.roomClear !== 'function') return;
  const res = await window.api.roomClear().catch(() => null);
  if (!res || !res.ok) return;
  room.msgs = [];
  room.unread = 0;
  updateBadge();
  renderAll();
  const input = el('rp-input');
  if (input) input.focus({ preventScroll: true }); // keep the composer ready, no focus theft
}

async function sendMsg(e) {
  if (e) e.preventDefault();
  const sel = el('rp-to');
  const input = el('rp-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const to = (sel && sel.value) || '*';
  input.value = '';
  // The router echoes it back via 'room-append' (no optimistic insert needed).
  await window.api.roomSend(to, text).catch(() => null);
}

function init() {
  const toggle = el('room-toggle');
  if (!toggle) return; // markup absent -> feature simply inert
  toggle.addEventListener('click', togglePanel);
  const closeBtn = el('rp-close');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  const refreshBtn = el('rp-refresh');
  if (refreshBtn) {
    motion();
    refreshBtn.addEventListener('click', () => {
      const work = Promise.all([loadFeed({ user: true }), loadWho()]);
      motion().then((m) => m && m.spinWhile(refreshBtn, work));
    });
  }
  const countSel = el('rp-count');
  if (countSel) {
    // restore the persisted choice; if it isn't a known preset, show the default
    const want = String(readCount());
    countSel.value = Array.from(countSel.options).some((o) => o.value === want)
      ? want : String(DEFAULT_COUNT);
    countSel.addEventListener('change', () => {
      localStorage.setItem(COUNT_KEY, countSel.value);
      loadFeed({ user: true });
    });
  }
  const clearBtn = el('rp-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearRoom);
  const form = el('rp-composer');
  if (form) form.addEventListener('submit', sendMsg);

  document.addEventListener('keydown', (ev) => {
    if (room.open && ev.key === 'Escape') { closePanel(); ev.preventDefault(); }
  });

  if (window.api && typeof window.api.onRoomAppend === 'function') {
    window.api.onRoomAppend(onAppend);
  }
}

// Auto-init only in a DOM context; the guard lets the module be require()d
// headlessly (the .scratch probe) to unit-test the pure helpers against the REAL
// source instead of a copy. The same guard fences the S6b self-assign below
// (D16) — boot.js never imports room-panel.js, so it cannot make this
// assignment on the panel's behalf, and `window` does not exist in the
// headless require() context.
if (typeof document !== 'undefined') {
  if (window.overlayState) window.overlayState.closeRoomPanel = closePanel;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

// Headless test seam (CommonJS): a no-op under a browser <script> (no `module`),
// so the renderer is unaffected.
if (typeof module !== 'undefined' && module.exports) module.exports = { party };
