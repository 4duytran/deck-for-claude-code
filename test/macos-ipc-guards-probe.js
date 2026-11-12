// macos-ipc-guards probe — the two main-process IPC sites that behaved Linux-only:
//   1. `primary-write` (src/main/ipc/pty.js): the X11 PRIMARY bridge. `clipboard.writeText(text, 'selection')` is a
//      Linux-only Electron feature; on macOS it must do nothing (never overwrite the system clipboard).
//   2. `panel-term-open` (src/main/ipc/panel-term.js): the side-panel shell. A Dock-launched macOS app has no
//      Homebrew PATH and a non-login zsh skips ~/.zprofile, so on darwin the shell starts as a login shell (`-l`);
//      the Linux spawn keeps its empty argument list.
//
// Run: bash test/run.sh macos-ipc-guards-probe
//
// No window and no main.js boot: the handlers are registered against a capturing ipcMain, clipboard.writeText and
// node-pty's spawn are spies, and `process.platform` is stubbed around each call (both guards read it per call).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-macos-guards-'));
process.env.HOME = FAKE_HOME;
process.env.SHELL = '/bin/bash';
process.env.CLAUDE_DECK_ASK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-macos-guards-ask-'));

const { app, ipcMain, clipboard } = require('electron');

// Capturing ipcMain: the real registration functions run unchanged against it.
const onHandlers = new Map();
const invokeHandlers = new Map();
ipcMain.on = (channel, fn) => { onHandlers.set(channel, fn); return ipcMain; };
ipcMain.handle = (channel, fn) => { invokeHandlers.set(channel, fn); };

// Spies.
const clipboardCalls = [];
clipboard.writeText = (text, type) => { clipboardCalls.push({ text, type }); };

const spawns = [];
const nodePty = require('node-pty');
nodePty.spawn = (file, args, opts) => {
  spawns.push({ file, args, cwd: opts && opts.cwd });
  return { pid: 4242, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
};

// The panel terminal resolves its cwd through the git panel: point it at a throwaway directory.
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-macos-guards-cwd-'));
require(path.join(__dirname, '..', 'src', 'main', 'ipc', 'git-panel')).resolveGitCwd = async () => WORKDIR;

const { registerPtyIpc } = require(path.join(__dirname, '..', 'src', 'main', 'ipc', 'pty'));
const { registerPanelTermIpc, killAllPanelTerms } = require(path.join(__dirname, '..', 'src', 'main', 'ipc', 'panel-term'));
registerPtyIpc();
registerPanelTermIpc();

const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
async function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', realPlatform); }
}

const primaryWrite = (text) => onHandlers.get('primary-write')({}, text);
const selectionWrites = () => clipboardCalls.filter((c) => c.type === 'selection');
let termSeq = 0;
async function openPanelTerm() {
  const termId = `macos-guard-${++termSeq}`;
  const before = spawns.length;
  const r = await invokeHandlers.get('panel-term-open')({}, { termId, target: { paneId: 'p1', sessionId: 's1' }, cols: 80, rows: 24 });
  return { r, spawn: spawns.length > before ? spawns[spawns.length - 1] : null };
}

app.whenReady().then(async () => {
  gate('handlers-registered',
    typeof onHandlers.get('primary-write') === 'function' && typeof invokeHandlers.get('panel-term-open') === 'function',
    `primary-write=${typeof onHandlers.get('primary-write')} panel-term-open=${typeof invokeHandlers.get('panel-term-open')}`);

  // === primary-write ========================================================
  await withPlatform('linux', () => primaryWrite('linux selection'));
  gate('primary-linux — a selection still goes to the X11 PRIMARY buffer',
    selectionWrites().length === 1 && selectionWrites()[0].text === 'linux selection', JSON.stringify(clipboardCalls));

  clipboardCalls.length = 0;
  await withPlatform('darwin', () => primaryWrite('darwin selection'));
  gate('primary-darwin-noop — no clipboard write of any kind on macOS',
    clipboardCalls.length === 0, JSON.stringify(clipboardCalls));

  clipboardCalls.length = 0;
  await withPlatform('darwin', () => onHandlers.get('clipboard-write')({}, 'explicit copy'));
  gate('clipboard-write-darwin — the explicit CLIPBOARD bridge is untouched on macOS',
    clipboardCalls.length === 1 && clipboardCalls[0].text === 'explicit copy' && clipboardCalls[0].type === undefined,
    JSON.stringify(clipboardCalls));

  // === panel-term shell args ===============================================
  const lin = await withPlatform('linux', openPanelTerm);
  gate('panel-login-linux — the Linux shell keeps an empty argument list',
    lin.r.ok === true && !!lin.spawn && lin.spawn.file === '/bin/bash' && Array.isArray(lin.spawn.args) && lin.spawn.args.length === 0,
    JSON.stringify({ r: lin.r, spawn: lin.spawn }));

  const mac = await withPlatform('darwin', openPanelTerm);
  gate('panel-login-darwin — the macOS shell starts as a login shell',
    mac.r.ok === true && !!mac.spawn && mac.spawn.file === '/bin/bash'
      && JSON.stringify(mac.spawn.args) === JSON.stringify(['-l']),
    JSON.stringify({ r: mac.r, spawn: mac.spawn }));

  killAllPanelTerms();
  console.log('\n=== macos-ipc-guards probe ===');
  for (const r of results) console.log(r);
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nVERDICT: ${failed ? 'FAIL' : 'ALL GREEN'} (${passed}/${results.length})`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.log(`FAIL probe-crash — ${e && e.stack || e}`);
  app.exit(1);
});
