// B4 — `--plugin-dir <DECK>/mods/room-mirror` probe (spawn layer, argv ground truth).
// Boots the REAL main.js with CLAUDE_DECK_BIN = a fake claude that dumps its argv (NUL-separated) and drives pty-open
// through the real renderer bridge. Argv ground truth = global.__deckLastSpawnArgs AND the real argv the fake received.
// Without argument it runs the main scenario (an ordinary pane) and then re-runs itself as a child
// electron with CLAUDE_DECK_BIN=/bin/bash (INJECT_SETTINGS false is decided at module load, so it needs its own process).
// Run under the containment prefix of CLAUDE.md (xvfb-run, CENV).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODE = process.argv[2] || 'main';
const DECK = path.join(__dirname, '..');
const MIRROR = path.join(DECK, 'mods', 'room-mirror');
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const H = mk(`deck-rmf-${MODE}-`);
process.env.HOME = H;
fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
process.env.CLAUDE_DECK_ASK_DIR = mk('deck-rmf-ask-');
process.env.CLAUDE_DECK_PROJECTS_DIR = mk('deck-rmf-proj-');
process.env.CLAUDE_DECK_PLUGINS_DIR = mk('deck-rmf-plg-');
process.env.CLAUDE_DECK_NO_OPEN = '1';

const DUMPDIR = mk('deck-rmf-dump-');
const FAKE = path.join(H, 'fake-claude.sh');
fs.writeFileSync(FAKE, `#!/bin/sh\nT="\${PROBE_TAG:-plain}"\nprintf '%s\\0' "$@" > "${DUMPDIR}/$T.argv"\nexec cat >/dev/null\n`);
fs.chmodSync(FAKE, 0o755);

const CHILD_ENV = { ...process.env }; // snapshot BEFORE the mode-specific bin/inject settings below
delete CHILD_ENV.CLAUDE_DECK_FORCE_INJECT;
if (MODE === 'bash') {
  process.env.CLAUDE_DECK_BIN = '/bin/bash'; // a wrapper binary: INJECT_SETTINGS is false
  delete process.env.CLAUDE_DECK_FORCE_INJECT;
} else {
  process.env.CLAUDE_DECK_BIN = FAKE;
  process.env.CLAUDE_DECK_FORCE_INJECT = '1'; // basename != claude, so inject on purpose (real argv end to end)
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', mk('deck-rmf-ud-'));
require(path.join(DECK, 'main.js'));

let fails = 0;
const gate = (name, cond, detail) => {
  if (!cond) fails++;
  const extra = !cond && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 500)}` : '';
  console.log(`  ${cond ? 'PASS' : 'FAIL'} [${MODE}] ${name}${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (a, x) => (a || []).filter((v) => v === x).length;
const noMirror = (a) => count(a, '--plugin-dir') === 0 && (a || []).every((v) => typeof v !== 'string' || !v.includes('room-mirror'));

function readDump(tag) {
  const x = fs.readFileSync(path.join(DUMPDIR, `${tag}.argv`), 'utf8').split('\0');
  x.pop();
  return x;
}
async function waitDump(tag) {
  const f = path.join(DUMPDIR, `${tag}.argv`);
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(f) && fs.statSync(f).size > 0) { await sleep(100); return readDump(tag); }
    await sleep(50);
  }
  return null;
}

// The flag exactly once, pointing at the shipped mod dir, a flag right after its value (no variadic list can swallow
// it), sitting after --settings and before the briefing.
function flagShape(a) {
  const i = (a || []).indexOf('--plugin-dir');
  return count(a, '--plugin-dir') === 1 && count(a, MIRROR) === 1 && a[i + 1] === MIRROR
    && typeof a[i + 2] === 'string' && a[i + 2].startsWith('--')
    && i > a.indexOf('--settings') && a.indexOf('--settings') >= 0 && i < a.indexOf('--append-system-prompt');
}

function runChildBash() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, 'bash'], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

app.whenReady().then(async () => {
  await sleep(800);
  const win = BrowserWindow.getAllWindows()[0];
  const ejs = (code) => win.webContents.executeJavaScript(code, true);
  let paneN = 0;
  async function open(extra) {
    const paneId = `rmf-${++paneN}`;
    global.__deckLastSpawnArgs = null;
    const res = await ejs(`window.api.openTerminal(${JSON.stringify({ paneId, cols: 80, rows: 24, cwd: H, ...extra })})`);
    return { res, seam: global.__deckLastSpawnArgs };
  }

  if (MODE === 'bash') {
    const b = await open({});
    gate('w1_wrapper_bin_precondition_no_settings', b.res.ok && !(b.seam || []).includes('--settings'), b.seam);
    gate('w2_wrapper_bin_has_no_plugin_dir', b.res.ok && noMirror(b.seam), b.seam);
    return finish();
  }

  // ---- 1. ordinary pane ---------------------------------------------------------------------------------------------
  gate('a0_mirror_dir_exists', fs.existsSync(path.join(MIRROR, '.claude-plugin', 'plugin.json')), MIRROR);
  const p1 = await open({});
  const d1 = await waitDump('plain');
  gate('a1_ordinary_flag_once_shape', p1.res.ok && flagShape(p1.seam), p1.seam);
  gate('a2_ordinary_real_argv_equals_seam', !!d1 && JSON.stringify(d1) === JSON.stringify(p1.seam), d1);

  // ---- 2. wrapper binary: its own process ---------------------------------------------------------------------------
  const child = await runChildBash();
  process.stdout.write(child.out);
  gate('w3_wrapper_bin_child_run_green', child.code === 0 && /PASS \[bash\] w2_/.test(child.out), { code: child.code });
  finish();
}).catch((err) => { console.log(`  FAIL [${MODE}] probe crashed :: ${err && err.stack}`); process.exit(2); });

function finish() {
  console.log(`${fails === 0 ? 'GREEN' : 'RED'} [${MODE}] fails=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
setTimeout(() => { console.log(`  FAIL [${MODE}] watchdog timeout`); process.exit(2); }, 150000).unref();
