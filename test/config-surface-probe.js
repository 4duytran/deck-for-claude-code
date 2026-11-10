'use strict';
// config-surface-probe: the deck's src/main/config.js names no voice / spotify / media / slack / weather constant,
// still exports the keys the deck reads, and the deck still boots clean.
//   <CONTAIN> node_modules/.bin/electron test/config-surface-probe.js
// Gates are computed from the live module object, the config source text and the console-message events of the real
// main.js boot (error level only, same definition as boot-clean-probe). BOOT_CLEAN_BASELINE=<file> is an optional
// set of known messages; with none, the gate is 0 error-level messages.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const BASELINE_FILE = process.env.BOOT_CLEAN_BASELINE || '';
const SETTLE_MS = 5000;
const norm = (m) => String(m).replace(/\s+/g, ' ').trim().slice(0, 300);
const CONFIG_PATH = path.join(__dirname, '..', 'src', 'main', 'config.js');

const SHARED_KEYS = ['ROOMS_DIR', 'UUID_RE', 'STATUS_DIR', 'ROOM_MAX_TEXT', 'ROOM_BRIEFING', 'APP_ROOT', 'HEADLESS_ENTRYPOINTS'];
const DECK_OWN_KEYS = ['PRICES_URL', 'COMMANDS_URL', 'PLUGINS_DIR', 'PLUGIN_BASE_ENV', 'GLAB_BIN', 'CLAUDE_BIN'];
const ASSISTANT_RE = /VOICE_|SPOTIFY_|MEDIA_/;
// Seams that sat inside the removed range without the prefixes above.
const ASSISTANT_EXTRA = ['SLACK_API_URL', 'WEATHER_URL', 'validRedirectPort', 'validUnitName', 'parseYoutubeSeam', 'YOUTUBE_SEAM'];

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-surface-'));
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

const known = new Set();
try { for (const l of fs.readFileSync(BASELINE_FILE, 'utf8').split('\n')) if (l.trim()) known.add(l.trim()); } catch (_) { /* no baseline: gate on 0 */ }

const config = require(CONFIG_PATH);
const keys = Object.keys(config);
const source = fs.readFileSync(CONFIG_PATH, 'utf8');

const errors = [];
let loaded = false;
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  const out = errors.filter((e) => !known.has(e));
  const assistantKeys = keys.filter((k) => ASSISTANT_RE.test(k));
  const extraKeys = keys.filter((k) => ASSISTANT_EXTRA.includes(k));
  const sourceHits = [...new Set((source.match(/\b(?:VOICE_|SPOTIFY_|MEDIA_)[A-Za-z_]*|\bWEATHER_URL\b|\bSLACK_API_URL\b/g) || []))];
  const gates = {
    no_voice_spotify_media_keys: assistantKeys.length === 0,
    no_other_assistant_seam_keys: extraKeys.length === 0,
    shared_keys_present: SHARED_KEYS.every((k) => config[k] !== undefined),
    deck_own_keys_present: DECK_OWN_KEYS.every((k) => k in config),
    no_assistant_name_in_source: sourceHits.length === 0,
    window_loaded: loaded,
    no_error_level_console_message: out.length === 0,
  };
  if (assistantKeys.length || extraKeys.length) process.stdout.write(`INFO assistant keys still exported: ${[...assistantKeys, ...extraKeys].join(',')}\n`);
  if (sourceHits.length) process.stdout.write(`INFO assistant names still in config.js: ${sourceHits.join(',')}\n`);
  const missing = SHARED_KEYS.filter((k) => config[k] === undefined);
  if (missing.length) process.stdout.write(`INFO shared keys missing: ${missing.join(',')}\n`);
  for (const e of errors) process.stdout.write(`ERROR-LEVEL console-message${known.has(e) ? ' (baseline)' : ''}: ${e}\n`);
  process.stdout.write(`INFO export-keys=${keys.length} error-level events=${errors.length} baseline-set=${known.size} outside-baseline=${out.length}\n`);
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
    wc.once('did-finish-load', () => { loaded = true; setTimeout(finish, SETTLE_MS); });
  }
});
setTimeout(finish, 60000).unref(); // never hang: window_loaded fails if the load never came

app.setPath('userData', fs.mkdtempSync(path.join(BASE, 'ud-')));
require('../main.js');
