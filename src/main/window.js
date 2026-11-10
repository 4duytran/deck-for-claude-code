// claude-deck — window: the ONE BrowserWindow + the renderer push helper.
// Every module that needs to push an event to the renderer goes through
// send() — never through a direct win reference (the destroyed-guard lives
// here once, not at every call site).
'use strict';

const { app, BrowserWindow, shell, dialog } = require('electron');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./config');
const { PAGE_URL_PREFIX, slotOfUrl } = require('./page-scheme');

let win = null;

// A plugin report may hand an https link to the default browser, or one Slack channel deep link to the
// Slack app, at most one opening per OPEN_MIN_INTERVAL_MS (shared): a deliberate click on another link
// takes over a second, a double click or a held Enter lands inside it. A dropped opening leaves one warn line.
const OPEN_MIN_INTERVAL_MS = 1000;
let lastOpenAt = -Infinity;

// The only slack: shape a report may open: a channel of a team, upper-case ids. Never a browser fallback.
const SLACK_LINK_RE = /^slack:\/\/channel\?team=T[A-Z0-9]{2,20}&id=[CGD][A-Z0-9]{2,20}$/;
const SLACK_HANDLER_WAIT_MS = 2000;
const SLACK_OPEN_WAIT_MS = 3000;
const SLACK_NO_HANDLER = 'Aucune application n’est associée aux liens slack:// sur cet ordinateur. Installe Slack ou ouvre-le une fois, puis réessaie.';
const SLACK_NOT_OPENED = 'Slack n’a pas pu ouvrir ce lien.';

function slackDialog(detail) {
  const options = { type: 'warning', message: 'Impossible d’ouvrir Slack', detail };
  const shown = win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  Promise.resolve(shown).catch(() => {});
}

// xdg-mime prints the .desktop file bound to the scheme: nothing, an error or no answer in time = no handler.
function slackHandlerFound() {
  return new Promise((resolve) => {
    try {
      childProcess.execFile('xdg-mime', ['query', 'default', 'x-scheme-handler/slack'], { timeout: SLACK_HANDLER_WAIT_MS },
        (err, stdout) => resolve(!err && String(stdout).trim() !== ''));
    } catch (_) { resolve(false); }
  });
}

// true on exit 0 or while xdg-open still runs at the deadline (left to finish); false on a failure inside it.
function xdgOpen(href) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => settle(true), SLACK_OPEN_WAIT_MS);
    try { childProcess.execFile('xdg-open', [href], (err) => settle(!err)); } catch (_) { settle(false); }
  });
}

async function openSlackLink(href) {
  if (process.platform !== 'linux') {
    try { await shell.openExternal(href); } catch (_) { slackDialog(SLACK_NOT_OPENED); }
    return;
  }
  if (!(await slackHandlerFound())) { slackDialog(SLACK_NO_HANDLER); return; }
  if (!(await xdgOpen(href))) slackDialog(SLACK_NOT_OPENED);
}

function openPluginLink(e) {
  let url;
  try {
    if (slotOfUrl(e.frame && e.frame.url) !== 'plugin') return;
    url = new URL(e.url);
  } catch (_) { return; }
  const slack = url.protocol === 'slack:' && SLACK_LINK_RE.test(url.href);
  if (url.protocol !== 'https:' && !slack) return;
  const now = performance.now();
  if (now - lastOpenAt < OPEN_MIN_INTERVAL_MS) {
    console.warn('[window] plugin link dropped: another one opened less than a second ago');
    return;
  }
  lastOpenAt = now;
  if (slack) openSlackLink(url.href).catch(() => {});
  else Promise.resolve(shell.openExternal(url.href)).catch(() => {});
}

// --- UI zoom -----------------------------------------------------------------
// The whole renderer is sized in ABSOLUTE px (dense by design — 120+ values),
// so a single Electron zoom factor is the one knob that enlarges the ENTIRE UI
// uniformly — chrome AND the xterm canvas — without touching every px value
// (and without paddings/line-heights drifting). The xterm panes re-fit
// themselves: a zoom change resizes their CSS box -> the per-pane ResizeObserver
// fires -> the existing resync pipeline (fit + pty.resize) runs.
// Live keys: Ctrl +/-/0. Persisted (debounced) in userData. Env CLAUDE_DECK_ZOOM.
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
// Baseline 1.0 (user decision 2026-10-28: the Verre layout reads too big at 1.2).
// Applied to the REAL app unconditionally, NOT gated on CLAUDE_DECK_BIN (the desktop
// launcher exports it); env and persisted values still win. Probe determinism: the
// sweep pins CLAUDE_DECK_ZOOM=1.0. NOTE: only the deck (claude code) is zoomed — the
// embedded claude.ai panel keeps its own native size.
const DEFAULT_ZOOM = 1.0;

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}
// PURE (exported for tests): explicit env override wins, then the persisted
// preference, then the comfortable baseline. Number.isFinite (NOT `Number(x) ||
// default`) so a literal 0 / garbage falls through to the baseline instead of
// 0 silently swallowing the default.
function resolveZoom(envRaw, persistedRaw) {
  const e = Number(envRaw);
  if (Number.isFinite(e) && e > 0) return clampZoom(e);
  const p = Number(persistedRaw);
  if (Number.isFinite(p) && p > 0) return clampZoom(p);
  return DEFAULT_ZOOM;
}
function zoomFile() {
  return path.join(app.getPath('userData'), 'deck-zoom');
}
function loadInitialZoom() {
  let persisted = null;
  try { persisted = fs.readFileSync(zoomFile(), 'utf8'); } catch (_) { /* first run */ }
  return resolveZoom(process.env.CLAUDE_DECK_ZOOM, persisted);
}
let saveTimer = null;
function saveZoom(z) {
  // Debounced: key autorepeat (held Ctrl+-) fires a burst of keyDown; coalesce
  // into ONE write so a sync fs call never stalls the main/UI thread per repeat.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(zoomFile(), String(z)); } catch (_) { /* non-fatal */ }
  }, 250);
}

function getWin() {
  return win;
}

// Renderer push with the destroyed-guard built in (no-op before createWindow
// and after close — callers never check).
// FX11 hardening: win.isDestroyed() alone missed a destroyed webContents
// during teardown — a node-pty native callback (data/exit) landing after the
// window is gone but before `win` itself is torn down would throw straight
// out of webContents.send() on node-pty's own native stack ("terminate
// called after throwing an instance of 'Napi::Error'"), taking the whole
// process down with a SIGABRT. Guard both, and swallow any remaining throw
// too (2.9: never break the deck over a late message).
function send(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (_) { /* never break the deck */ }
}

// onClosed: injected by the composition root (main.js wires killAll here) —
// window.js must not depend on the PTY module (acyclic graph).
function createWindow({ onClosed } = {}) {
  win = new BrowserWindow({
    title: 'Claude Deck', // shown until index.html's <title> takes over (same value)
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true, // non-negotiable: renderer never sees Node
      nodeIntegration: false,
    },
  });

  let currentZoom = loadInitialZoom();
  const resetZoom = resolveZoom(process.env.CLAUDE_DECK_ZOOM, null); // env override or baseline
  const applyZoom = (z) => {
    currentZoom = clampZoom(z);
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(currentZoom);
  };
  // Re-assert on EVERY load (a reload resets the factor); absolute value, so it
  // never compounds. The pane ResizeObserver refits xterm after the reflow.
  win.webContents.on('did-finish-load', () => applyZoom(currentZoom));

  // Dropping the menu also drops its copy/paste + zoom accelerators — re-wire
  // the terminal-standard ones (Ctrl+Shift+C/V à la gnome-terminal/Warp; plain
  // Ctrl+C/V must keep going to the PTY) + F12 devtools + Ctrl +/-/0 zoom.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // An Escape typed inside the out-of-process report frame never reaches the Deck document, but this event sees it:
    // payload-less push, the renderer acts only when the frame has focus. The key itself is never swallowed.
    if (input.key === 'Escape' && !input.control && !input.shift && !input.alt && !input.meta) send('plugin-view-escape');
    const ctrlShift = input.control && input.shift && !input.alt && !input.meta;
    const key = (input.key || '').toLowerCase();
    if (ctrlShift && key === 'c') { win.webContents.copy(); event.preventDefault(); return; }
    if (ctrlShift && key === 'v') { win.webContents.paste(); event.preventDefault(); return; }
    if (input.key === 'F12' && !input.control && !input.shift && !input.alt) {
      win.webContents.toggleDevTools(); event.preventDefault(); return;
    }
    // v66: main.js does Menu.setApplicationMenu(null) — which ALSO dropped the
    // default CmdOrCtrl+R reload accelerator that lived on the (now absent) View
    // menu. With no reload key re-wired, a renderer-only code edit could NEVER
    // take effect short of a full app relaunch — which is exactly why earlier
    // chat-view.js fixes appeared to do nothing (the renderer kept running the
    // launch-time bundle). Re-wire reload on F5 and Ctrl+Shift+R — both
    // terminal-safe: plain Ctrl+R stays a readline reverse-search inside the
    // xterm panes (never intercepted here).
    if (input.key === 'F5' && !input.control && !input.shift && !input.alt) {
      win.webContents.reloadIgnoringCache(); event.preventDefault(); return;
    }
    if (ctrlShift && key === 'r') {
      win.webContents.reloadIgnoringCache(); event.preventDefault(); return;
    }
    // Zoom — layout-robust. '+'/'=' ALLOW Shift (US '+' is Shift+'='; on AZERTY
    // '=' is unshifted) so Ctrl++ and Ctrl+= both zoom in on any layout. '-' and
    // '0' REQUIRE !shift so Ctrl+_ (readline undo) and friends still reach the PTY.
    const ctrlNoAM = input.control && !input.alt && !input.meta;
    if (ctrlNoAM && (input.key === '=' || input.key === '+' || input.key === 'Add')) {
      applyZoom(currentZoom + ZOOM_STEP); saveZoom(currentZoom); event.preventDefault();
    } else if (ctrlNoAM && !input.shift && (input.key === '-' || input.key === 'Subtract')) {
      applyZoom(currentZoom - ZOOM_STEP); saveZoom(currentZoom); event.preventDefault();
    } else if (ctrlNoAM && !input.shift && input.key === '0') {
      applyZoom(resetZoom); saveZoom(currentZoom); event.preventDefault();
    }
  });

  // v40 (review hardening): the deck window NEVER navigates and NEVER opens
  // children — a markdown link in the plans panel (or any future rendered
  // content) must not be able to replace/spawn the renderer. Left-clicks are
  // already swallowed in the renderer; this kills middle-click, keyboard and
  // window.open. The claude.ai WebContentsView (v19) is a separate webContents
  // and keeps its own navigation untouched.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // A sub-frame may only be navigated by the Deck itself, toward a deckpage: URL. Every other
  // navigation is cancelled; a link of a plugin report frame also goes to the browser (https only).
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    if (e.initiator === win.webContents.mainFrame && e.url.startsWith(PAGE_URL_PREFIX)) return;
    e.preventDefault();
    openPluginLink(e);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  win.on('closed', () => {
    if (onClosed) onClosed();
    win = null;
  });
  return win;
}

module.exports = { createWindow, getWin, send, resolveZoom, clampZoom };
