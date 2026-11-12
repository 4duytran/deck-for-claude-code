'use strict';
// boot-clean-probe: boots the REAL main.js and counts the renderer console-message events of ERROR level only
// (never warning, info or debug: the ONE definition of "console error"), from the creation of each web contents
// until 5 s after the first window's did-finish-load. Prints each one.
//   <CONTAIN> node_modules/.bin/electron test/boot-clean-probe.js
// Gate: 0 errors. BOOT_CLEAN_BASELINE=<file> (optional, no default) names a set of known messages, one normalized
// message per line; later runs gate on "no error outside that set". BOOT_CLEAN_RECORD=1 together with
// BOOT_CLEAN_BASELINE=<file> writes the messages seen to that file; without the file it is ignored.
// Gate mono-mac-fallback: MONO_FONT of the booted renderer (theme.js, the xterm fontFamily) lists Menlo before the
// generic monospace and keeps every family it listed before the macOS fallback, in the same relative order.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const BASELINE_FILE = process.env.BOOT_CLEAN_BASELINE || '';
const SETTLE_MS = 5000;
const norm = (m) => String(m).replace(/\s+/g, ' ').trim().slice(0, 300);
// The MONO_FONT families before the macOS fallback was added; none may disappear or be reordered.
const HEAD_MONO = ['JetBrainsMono Nerd Font', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'];

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-boot-clean-'));
process.env.HOME = BASE;
process.env.CLAUDE_DECK_ZOOM = '1.0';
process.env.CLAUDE_DECK_NO_SHELL_ENV = '1';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_ASK_DIR = fs.mkdtempSync(path.join(BASE, 'ask-'));
process.env.CLAUDE_DECK_ROOMS_DIR = fs.mkdtempSync(path.join(BASE, 'rooms-'));
process.env.CLAUDE_DECK_STATUS_DIR = fs.mkdtempSync(path.join(BASE, 'status-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = fs.mkdtempSync(path.join(BASE, 'projects-'));
process.env.CLAUDE_DECK_PLUGINS_DIR = fs.mkdtempSync(path.join(BASE, 'plugins-'));
process.env.CLAUDE_DECK_BIN = '/bin/bash';
for (const k of ['PRICES', 'COMMANDS']) process.env[`CLAUDE_DECK_${k}_URL`] = 'http://127.0.0.1:1';
delete process.env.OPENAI_API_KEY;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_USER_TOKEN;

const errors = [];
let loaded = false;
let finished = false;
let mainWc = null;
const record = process.env.BOOT_CLEAN_RECORD === '1' && BASELINE_FILE !== '';
const known = new Set();
if (!record) {
  try { for (const l of fs.readFileSync(BASELINE_FILE, 'utf8').split('\n')) if (l.trim()) known.add(l.trim()); } catch (_) { /* no baseline: gate on 0 */ }
}

// MONO_FONT as the booted renderer holds it: theme.js is already in its module graph, so the import is the same instance.
async function readMonoFont() {
  if (!mainWc || mainWc.isDestroyed()) return null;
  const read = mainWc.executeJavaScript("import('./js/theme.js').then((m) => m.MONO_FONT)").catch(() => null);
  return Promise.race([read, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
}

function monoMacFallback(value) {
  if (typeof value !== 'string') return false;
  const fams = value.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
  const head = HEAD_MONO.map((f) => fams.indexOf(f));
  const headKept = head.every((i, k) => i !== -1 && (k === 0 || i > head[k - 1]));
  const menlo = fams.indexOf('Menlo');
  return headKept && menlo !== -1 && menlo < fams.indexOf('monospace');
}

async function finish() {
  if (finished) return;
  finished = true;
  const out = errors.filter((e) => !known.has(e));
  for (const e of errors) process.stdout.write(`ERROR-LEVEL console-message${known.has(e) ? ' (baseline)' : ''}: ${e}\n`);
  if (record) {
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, errors.length ? `${[...new Set(errors)].join('\n')}\n` : '');
    process.stdout.write(`RECORDED ${new Set(errors).size} distinct error(s) to ${BASELINE_FILE}\n`);
  }
  const monoFont = await readMonoFont();
  const gates = {
    window_loaded: loaded,
    no_error_level_console_message: record ? true : out.length === 0,
    'mono-mac-fallback': monoMacFallback(monoFont),
  };
  process.stdout.write(`INFO error-level events=${errors.length} baseline-set=${known.size} outside-baseline=${out.length}\n`);
  process.stdout.write(`INFO mono-font=${JSON.stringify(monoFont)}\n`);
  const bad = Object.keys(gates).filter((g) => !gates[g]);
  for (const g of Object.keys(gates)) process.stdout.write(`${gates[g] ? 'PASS' : 'FAIL'} ${g}\n`);
  process.stdout.write(bad.length === 0 ? `VERDICT: ALL GREEN (${Object.keys(gates).length}/${Object.keys(gates).length})\n`
    : `VERDICT: RED ${bad.join(',')} (${Object.keys(gates).length - bad.length}/${Object.keys(gates).length})\n`);
  app.exit(bad.length === 0 ? 0 : 1);
}

// Registered before main.js is required, so it sees every web contents from its creation.
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    const message = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (level === 'error' || level === 3) errors.push(norm(message));
  });
  if (wc.getType() === 'window') {
    wc.once('did-finish-load', () => { loaded = true; if (!mainWc) mainWc = wc; setTimeout(finish, SETTLE_MS); });
  }
});
setTimeout(finish, 60000).unref(); // never hang: window_loaded fails if the load never came

app.setPath('userData', fs.mkdtempSync(path.join(BASE, 'ud-')));
require('../main.js');
