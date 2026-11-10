// claude-deck — ipc/panel-term: the shell behind the side panel's terminal tab. One node-pty shell per termId,
// started in the session's own workspace (never the folder or worktree another tab shows). It is NOT a session: it
// never enters `ptys`, so rooms and the status machinery never see it. The renderer sends ids only (a target).
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const pty = require('node-pty');
const { send } = require('../window');
const { resolveGitCwd, resolveBin } = require('./git-panel');

const terms = new Map(); // termId -> { termId, proc, cwd, outBuf, outTimer, lastSentAt, silent }

const TERMID_MAX = 128;
const COALESCE_MS = 8;
const LEAD_MS = 16;
const MAX_BUF_CHARS = 64 * 1024;

const NO_CWD = { ok: false, reason: 'no-cwd' };
const isPosInt = (n) => Number.isInteger(n) && n > 0;

// The shell's env: the Deck's own npm / Electron / CLAUDE_DECK_* settings, the GTK pins Electron sets
// (they would force the user's GTK apps onto X11) and the `*/node_modules/.bin` PATH entries (the Deck's own
// `electron`, `semver`, `node-gyp` would shadow the user's tools) must not leak into the user's shell.
const TERMINAL_ENV_DROP = new Set(['INIT_CWD', 'NODE', 'CHROME_DESKTOP', 'GDK_BACKEND', 'NO_AT_BRIDGE']);
function terminalEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_/.test(k) || TERMINAL_ENV_DROP.has(k) || /^ELECTRON_/.test(k) || /^CLAUDE_DECK_/.test(k)) continue;
    env[k] = v;
  }
  if (env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((e) => !/\/node_modules\/\.bin\/*$/.test(e)).join(path.delimiter);
  return env;
}

// Output coalescing, same rules as ipc/pty.js (leading edge at once, then one timer per burst, flushed before exit).
// A `silent` entry (ended by a reset) says nothing more: its termId may already name a new view.
function flushOut(entry) {
  if (entry.outTimer) { clearTimeout(entry.outTimer); entry.outTimer = null; }
  if (!entry.outBuf || entry.silent) return;
  const data = entry.outBuf;
  entry.outBuf = '';
  entry.lastSentAt = performance.now();
  send('panel-term-data', { termId: entry.termId, data });
}

function forwardData(entry, data) {
  if (entry.silent) return;
  const now = performance.now();
  if (!entry.outBuf && now - entry.lastSentAt >= LEAD_MS) {
    entry.lastSentAt = now;
    send('panel-term-data', { termId: entry.termId, data });
    return;
  }
  entry.outBuf += data;
  if (entry.outBuf.length > MAX_BUF_CHARS) { flushOut(entry); return; }
  if (!entry.outTimer) entry.outTimer = setTimeout(() => flushOut(entry), COALESCE_MS);
}

function killAllPanelTerms() {
  for (const entry of terms.values()) {
    flushOut(entry);
    try { entry.proc.kill(); } catch (_) { /* already dead */ }
  }
  terms.clear();
}

// A reloaded renderer restarts its pane ids (pane-1…) and holds no view of these shells: end them all, silently,
// so nothing they still say reaches a new view that reuses an id.
function resetPanelTerms() {
  for (const entry of terms.values()) {
    entry.silent = true;
    clearTimeout(entry.outTimer);
    entry.outTimer = null;
    entry.outBuf = '';
    try { entry.proc.kill(); } catch (_) { /* already dead */ }
  }
  terms.clear();
}

function registerPanelTermIpc() {
  ipcMain.handle('panel-term-open', async (_e, arg) => {
    const a = arg && typeof arg === 'object' ? arg : {};
    const { termId, target } = a;
    if (typeof termId !== 'string' || !termId || termId.length > TERMID_MAX) return NO_CWD;
    const live = terms.get(termId);
    if (live) return { ok: true, cwd: live.cwd, pid: live.proc.pid, existing: true };
    if (!target || typeof target !== 'object') return NO_CWD;
    let cwd = null;
    try {
      // repoIndex is dropped on purpose: the tab opens in the session's workspace, not in the repo the Git tab shows.
      cwd = await resolveGitCwd({ paneId: target.paneId, sessionId: target.sessionId });
      if (typeof cwd !== 'string' || !(await fsp.stat(cwd)).isDirectory()) cwd = null;
    } catch (_) { cwd = null; }
    if (!cwd) return NO_CWD;
    const cols = isPosInt(a.cols) ? a.cols : 80;
    const rows = isPosInt(a.rows) ? a.rows : 24;
    const shell = resolveBin(process.env.SHELL || '/bin/bash');
    let proc;
    try {
      // node-pty forks first and a failing exec only exits with 1: refuse a shell that is not a regular
      // executable file (resolveBin checks X_OK and searches PATH), or it would read as a normal exit
      if (!shell || !fs.statSync(shell).isFile()) return { ok: false, reason: 'spawn' };
      proc = pty.spawn(shell, [],{ name: 'xterm-256color', cols, rows, cwd, env: terminalEnv() });
    } catch (_) { return { ok: false, reason: 'spawn' }; }
    const entry = { termId, proc, cwd, outBuf: '', outTimer: null, lastSentAt: 0, silent: false };
    terms.set(termId, entry);
    proc.onData((data) => forwardData(entry, data));
    proc.onExit(({ exitCode }) => {
      flushOut(entry);
      if (terms.get(termId) === entry) terms.delete(termId);
      if (!entry.silent) send('panel-term-exit', { termId, exitCode });
    });
    return { ok: true, cwd, pid: proc.pid };
  });

  ipcMain.on('panel-term-input', (_e, m) => {
    const entry = m && terms.get(m.termId);
    if (!entry || typeof m.data !== 'string') return;
    try { entry.proc.write(m.data); } catch (_) { /* exiting */ }
  });

  ipcMain.on('panel-term-resize', (_e, m) => {
    const entry = m && terms.get(m.termId);
    if (!entry || !isPosInt(m.cols) || !isPosInt(m.rows)) return;
    try { entry.proc.resize(m.cols, m.rows); } catch (_) { /* exiting */ }
  });

  ipcMain.on('panel-term-kill', (_e, m) => {
    const entry = m && terms.get(m.termId);
    if (entry) try { entry.proc.kill(); } catch (_) { /* already dead */ }
  });

  // Sent once by every renderer start (a reload included): the first load finds an empty map and nothing happens.
  ipcMain.on('panel-term-reset', () => resetPanelTerms());
}

module.exports = { registerPanelTermIpc, killAllPanelTerms };
