'use strict';
// app-menu-probe: the native application menu the REAL main.js installs.
//   <CONTAIN> node_modules/.bin/electron test/app-menu-probe.js
// m1  non-darwin: Menu.getApplicationMenu() === null (no native bar).
// m2-m4  darwin: appMenu/editMenu/windowMenu exist, the Edit submenu carries undo..selectAll, paste is Cmd+V.
// Off macOS, m2-m4 read a second boot of this file (--as-darwin). It reports the menu main.js hands to
// Menu.setApplicationMenu while process.platform reads 'darwin'; the stub lives only around main.js's ready
// handler (measured: a darwin platform for the whole process spins Electron's main loop on Linux).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, Menu } = require('electron');

const AS_DARWIN = process.argv.includes('--as-darwin');
const REAL_PLATFORM = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });

const CHILD_MS = 45000;
const WATCHDOG_MS = 90000;
const REPORT_PREFIX = 'APPMENU-JSON ';
const EDIT_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'];
// Electron's own default for the paste role is the CommandOrControl spelling; all four map to Cmd+V on macOS.
const PASTE_ACCELERATORS = ['CmdOrCtrl+V', 'CommandOrControl+V', 'Command+V', 'Cmd+V'];

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-app-menu-'));
process.env.HOME = BASE;
process.env.CLAUDE_DECK_ZOOM = '1.0';
process.env.CLAUDE_DECK_NO_SHELL_ENV = '1';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_ASK_DIR = fs.mkdtempSync(path.join(BASE, 'ask-'));
process.env.CLAUDE_DECK_ROOMS_DIR = fs.mkdtempSync(path.join(BASE, 'rooms-'));
process.env.CLAUDE_DECK_STATUS_DIR = fs.mkdtempSync(path.join(BASE, 'status-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = fs.mkdtempSync(path.join(BASE, 'projects-'));
process.env.CLAUDE_DECK_PLUGINS_DIR = fs.mkdtempSync(path.join(BASE, 'plugins-'));
process.env.CLAUDE_DECK_BIN = '/bin/bash'; // an existing executable: the preflight alert never opens
for (const k of ['PRICES', 'COMMANDS']) process.env[`CLAUDE_DECK_${k}_URL`] = 'http://127.0.0.1:1';
delete process.env.OPENAI_API_KEY;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_USER_TOKEN;

const results = [];
const line = (s) => process.stdout.write(`${s}\n`);
function gate(id, ok, msg) {
  results.push({ id, ok });
  line(`${ok ? 'PASS' : 'FAIL'} ${id} — ${msg}`);
}

function snapshot(menu, note) {
  if (!menu) return { menu: false, top: [], note: note || 'application menu is null' };
  const lower = (r) => String(r || '').toLowerCase();
  const top = menu.items.map((i) => ({
    role: lower(i.role),
    sub: (i.submenu ? i.submenu.items : []).map((s) => ({ role: lower(s.role), accelerator: s.accelerator ? String(s.accelerator) : '' })),
  }));
  return { menu: true, top };
}

function darwinGates(snap, src) {
  const roles = snap.top.map((t) => t.role);
  const absent = ['appmenu', 'editmenu', 'windowmenu'].filter((r) => !roles.includes(r));
  gate('m2', snap.menu && absent.length === 0,
    `darwin (${src}): ${snap.menu ? `top-level roles [${roles.join(',')}], missing [${absent.join(',')}]` : snap.note}`);
  const edit = snap.top.find((t) => t.role === 'editmenu');
  const editRoles = edit ? edit.sub.map((s) => s.role) : [];
  const missing = EDIT_ROLES.filter((r) => !editRoles.includes(r));
  gate('m3', edit !== undefined && missing.length === 0,
    `darwin (${src}): edit submenu roles [${editRoles.join(',')}], missing [${missing.join(',')}]`);
  const paste = edit && edit.sub.find((s) => s.role === 'paste');
  const accel = paste ? paste.accelerator : '';
  gate('m4', PASTE_ACCELERATORS.includes(accel),
    `darwin (${src}): paste accelerator "${accel}", expected one of ${PASTE_ACCELERATORS.join(' | ')}`);
}

// Second boot: this same file as a child with --as-darwin; bounded, killed on expiry.
function runStubbedChild() {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const settle = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const child = spawn(process.execPath, [__filename, '--as-darwin'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const timer = setTimeout(() => { child.kill('SIGKILL'); settle({ error: `child still running after ${CHILD_MS} ms (killed)` }); }, CHILD_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    child.on('error', (e) => settle({ error: `spawn failed: ${e.message}` }));
    child.on('close', (code) => {
      const l = stdout.split('\n').find((x) => x.startsWith(REPORT_PREFIX));
      if (!l) return settle({ error: `child exit ${code} without a report` });
      try { settle(JSON.parse(l.slice(REPORT_PREFIX.length))); } catch (e) { settle({ error: `unreadable report: ${e.message}` }); }
    });
  });
}

function verdict() {
  const bad = results.filter((r) => !r.ok).map((r) => r.id);
  line(bad.length === 0 ? `VERDICT: ALL GREEN (${results.length}/${results.length})`
    : `VERDICT: RED ${bad.join(',')} (${results.length - bad.length}/${results.length})`);
  app.exit(bad.length === 0 ? 0 : 1);
}

function failHard(why) {
  if (AS_DARWIN) { line(`${REPORT_PREFIX}${JSON.stringify({ error: why })}`); app.exit(1); return; }
  gate('boot', false, why);
  verdict();
}

const watchdogMs = AS_DARWIN ? WATCHDOG_MS / 3 : WATCHDOG_MS;
setTimeout(() => failHard(`no result after ${watchdogMs} ms`), watchdogMs).unref();

// Child only: undefined until main.js hands a menu to Menu.setApplicationMenu while the stub is on.
let handed;
let stubbed = false;
if (AS_DARWIN) {
  const original = Menu.setApplicationMenu;
  Menu.setApplicationMenu = function (menu) {
    if (!stubbed) return original.call(Menu, menu); // Electron's own pre-ready default menu
    handed = { menu };
    stubbed = false;
    setPlatform(REAL_PLATFORM); // the menu is not applied: darwin-only native code does not exist on Linux
  };
  // Registered before main.js's own ready handler, so the stub is on when that handler picks its branch.
  app.once('ready', () => { stubbed = true; setPlatform('darwin'); });
}

app.setPath('userData', fs.mkdtempSync(path.join(BASE, 'ud-')));
require('../main.js');

// Registered after main.js's own ready handler, so Menu.setApplicationMenu has already run.
app.whenReady().then(() => new Promise((r) => setTimeout(r, 300))).then(async () => {
  if (AS_DARWIN) {
    if (stubbed) { stubbed = false; setPlatform(REAL_PLATFORM); }
    const snap = handed ? snapshot(handed.menu) : snapshot(null, 'main.js never called Menu.setApplicationMenu after ready');
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(snap)}\n`, () => app.exit(0));
    return;
  }
  const snap = snapshot(Menu.getApplicationMenu());
  if (REAL_PLATFORM === 'darwin') {
    line('SKIP m1 — darwin: the application menu is expected there, not null');
    darwinGates(snap, 'real boot');
  } else {
    gate('m1', snap.menu === false, `${REAL_PLATFORM}: Menu.getApplicationMenu() is ${snap.menu ? 'a menu' : 'null'}`);
    const child = await runStubbedChild();
    if (child.error) {
      for (const id of ['m2', 'm3', 'm4']) gate(id, false, `darwin (stubbed child): ${child.error}`);
    } else {
      darwinGates(child, 'stubbed child');
    }
  }
  verdict();
}).catch((e) => failHard(`probe error: ${e && e.stack ? e.stack : e}`));
