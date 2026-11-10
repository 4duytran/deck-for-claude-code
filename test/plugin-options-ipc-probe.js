'use strict';
// plugin-options-ipc-probe — step D11 of daily-brief-v2 (§ 2.6 Bridge, R9): the call-mode option of a plugin over the plugins bridge.
// Boots the REAL app (main.js) in this process on a throwaway userData with two installed plugins: `daily-brief` (two slots, one
// option CLAUDE_MODE = sub | api) and `plain` (nothing declared). The "user's shell" is a copy of fake-shell.sh named `bash`, so
// the real rc files are never read and every exported value is a FAKE-SECRET one (p5 proves none crosses the bridge). Drives
// window.api like the renderer does. Hermetic: no plugin is ever run, nothing outside the mkdtemp.
//   env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//     CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//     xvfb-run -a node_modules/.bin/electron test/plugin-options-ipc-probe.js
//
// Gates:
//   p1  window.api.pluginsSetOption exists; preload.js and ipc/plugins.js hold the 'plugins-set-option' channel
//   p0  baseline: pluginsAccess('daily-brief') answers the option row at its default (sub) and the read writes nothing
//   p2  set CLAUDE_MODE = api -> { ok: true } (name and value echoed), plugins.json holds options.CLAUDE_MODE, exactly one plugins-changed
//   p4  pluginsAccess('daily-brief') now answers the option row with value api (label, both choices), the slot rows untouched
//   p3  a bad id / name / value -> { ok: false, error }, file untouched, no plugins-changed
//   p5  the bridge carries no slot value: names, labels, choices, option values and statuses only (a mapped slot reads « présente »)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-options-ipc-'));
const USER_DATA = path.join(TMP, 'userData');
const PLUGINS = path.join(TMP, 'plugins');
const STATE = path.join(USER_DATA, 'plugins.json');
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(PLUGINS);
fs.mkdirSync(path.join(TMP, 'ask'));

// A shell the listing accepts as bash (allowlist by basename), exporting FAKE secrets only, --norc.
const SHELL = path.join(TMP, 'shell', 'bash');
fs.mkdirSync(path.dirname(SHELL));
fs.copyFileSync(path.join(FIXTURES, 'fake-shell.sh'), SHELL);
fs.chmodSync(SHELL, 0o755);

function install(id, manifest) {
  const dir = path.join(PLUGINS, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id, argv: ['run.sh'], trigger: 'manual', ...manifest }));
}
const OPTION = {
  name: 'CLAUDE_MODE', label: 'Accès à Claude', default: 'sub',
  choices: [{ value: 'sub', label: 'Abonnement' }, { value: 'api', label: 'API' }],
};
install('daily-brief', {
  label: 'Brief du jour', description: 'Brief quotidien (fixture)', trigger: 'daily',
  env: [
    { name: 'JIRA_TOKEN', label: 'Jira — jeton API', required: true, hints: ['JIRA', 'TOKEN'] },
    { name: 'CLAUDE_KEY', label: 'Clé API Claude (mode API)', required: false, hints: ['CLAUDE', 'KEY'] },
  ],
  options: [OPTION],
});
install('plain', { label: 'Plugin sans option', description: 'Aucune option déclarée' });

process.env.CLAUDE_DECK_PLUGINS_DIR = PLUGINS;
process.env.CLAUDE_DECK_ASK_DIR = path.join(TMP, 'ask');
process.env.CLAUDE_DECK_PLUGINS_SHELL = SHELL;
app.setPath('userData', USER_DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const bridgeLog = []; // every answer window.api gave in this boot, scanned by p5
let win = null;

async function gate(name, desc, fn) {
  let verdict;
  try { verdict = await fn(); } catch (e) { verdict = `threw ${e && e.message}`; }
  results.push(verdict === null);
  console.log(`${verdict === null ? 'PASS' : 'FAIL'} ${name} - ${desc}${verdict === null ? '' : ` :: ${verdict}`}`);
}

// window.api call that answers { missing: true } instead of throwing when the function is not exposed yet
async function call(fn, ...args) {
  const r = await win.webContents.executeJavaScript(
    `(async () => { const f = window.api[${JSON.stringify(fn)}]; if (typeof f !== 'function') return { missing: true }; return await f(...${JSON.stringify(args)}); })()`, true);
  bridgeLog.push({ fn, r });
  return r;
}
const pushes = () => win.webContents.executeJavaScript('window.__pushes', true);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const J = (v) => JSON.stringify(v);
const optionRow = (access) => (access && Array.isArray(access.options) ? access.options.find((o) => o.name === 'CLAUDE_MODE') : undefined);

async function main() {
  require(path.join(ROOT, 'main.js'));
  await app.whenReady();
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.filesList)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  await win.webContents.executeJavaScript('window.__pushes = 0; if (window.api.onPluginsChanged) window.api.onPluginsChanged(() => { window.__pushes++; }); true', true);
  await sleep(1500); // the startup push settles before any baseline

  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(ROOT, 'src/main/ipc/plugins.js'), 'utf8');

  await gate('p1', 'window.api.pluginsSetOption exists; preload.js and ipc/plugins.js hold the channel', async () => {
    const type = await win.webContents.executeJavaScript('typeof window.api.pluginsSetOption', true);
    if (type !== 'function') return `typeof window.api.pluginsSetOption: ${type}`;
    if (!preload.includes("'plugins-set-option'")) return 'preload.js lacks plugins-set-option';
    if (!ipc.includes("'plugins-set-option'")) return 'ipc/plugins.js lacks plugins-set-option';
    return null;
  });

  await gate('p0', 'baseline: the option row reads its default (sub) and reading writes nothing', async () => {
    const a = await call('pluginsAccess', 'daily-brief');
    if (!a || a.ok !== true) return `access answered ${J(a)}`;
    const row = optionRow(a);
    if (!row) return `no CLAUDE_MODE row in ${J(a.options)}`;
    if (row.value !== 'sub') return `default value: ${J(row)}`;
    const st = readState();
    return st && st['daily-brief'] && st['daily-brief'].options ? `read wrote options: ${J(st)}` : null;
  });

  const base = await pushes();
  await gate('p2', 'set api -> { ok: true }, stored in plugins.json, exactly one plugins-changed', async () => {
    const r = await call('pluginsSetOption', 'daily-brief', 'CLAUDE_MODE', 'api');
    if (!r || r.ok !== true) return `set answered ${J(r)}`;
    if (r.name !== 'CLAUDE_MODE' || r.value !== 'api') return `set did not echo the pick: ${J(r)}`;
    const st = readState();
    const entry = st && st['daily-brief'];
    if (!entry || J(entry.options) !== J({ CLAUDE_MODE: 'api' })) return `file: ${J(st)}`;
    if (st.plain) return `another plugin gained an entry: ${J(st.plain)}`;
    await sleep(600);
    const n = (await pushes()) - base;
    return n === 1 ? null : `plugins-changed pushes: ${n}`;
  });

  await gate('p4', 'pluginsAccess("daily-brief") answers the option row with value api', async () => {
    const a = await call('pluginsAccess', 'daily-brief');
    if (!a || a.ok !== true) return `access answered ${J(a)}`;
    const row = optionRow(a);
    if (!row) return `no CLAUDE_MODE row in ${J(a.options)}`;
    if (J(row) !== J({ name: 'CLAUDE_MODE', label: OPTION.label, choices: OPTION.choices, value: 'api' })) return `row: ${J(row)}`;
    const slots = Array.isArray(a.rows) ? a.rows.map((x) => x.name).join() : null;
    return slots === 'JIRA_TOKEN,CLAUDE_KEY' ? null : `slot rows: ${slots}`;
  });

  await gate('p3', 'a bad id / name / value -> { ok: false, error }, file untouched, no plugins-changed', async () => {
    const before = J(readState());
    const p0 = await pushes();
    const bad = [
      ['unknown id', ['nope', 'CLAUDE_MODE', 'sub']],
      ['id of a plugin declaring no option', ['plain', 'CLAUDE_MODE', 'api']],
      ['empty id', ['', 'CLAUDE_MODE', 'sub']],
      ['id too long', ['x'.repeat(65), 'CLAUDE_MODE', 'sub']],
      ['id of the wrong type', [42, 'CLAUDE_MODE', 'sub']],
      ['no id', [undefined, 'CLAUDE_MODE', 'sub']],
      ['undeclared name', ['daily-brief', 'OTHER', 'sub']],
      ['lowercase name', ['daily-brief', 'claude_mode', 'sub']],
      ['name with a space', ['daily-brief', 'CLAUDE_MODE ', 'sub']],
      ['proto name', ['daily-brief', '__proto__', 'sub']],
      ['slot name used as option name', ['daily-brief', 'CLAUDE_KEY', 'sub']],
      ['name of the wrong type', ['daily-brief', 7, 'sub']],
      ['no name', ['daily-brief', undefined, 'sub']],
      ['undeclared value', ['daily-brief', 'CLAUDE_MODE', 'weird']],
      ['uppercase value', ['daily-brief', 'CLAUDE_MODE', 'API']],
      ['value with a space', ['daily-brief', 'CLAUDE_MODE', 'api ']],
      ['empty value', ['daily-brief', 'CLAUDE_MODE', '']],
      ['value of the wrong type', ['daily-brief', 'CLAUDE_MODE', 1]],
      ['object value', ['daily-brief', 'CLAUDE_MODE', { value: 'api' }]],
      ['no value', ['daily-brief', 'CLAUDE_MODE', undefined]],
    ];
    for (const [what, args] of bad) {
      const r = await call('pluginsSetOption', ...args);
      if (!r || r.ok !== false || typeof r.error !== 'string' || !r.error) return `${what} answered ${J(r)}`;
    }
    await sleep(600);
    if (J(readState()) !== before) return `file moved: ${J(readState())}`;
    const n = (await pushes()) - p0;
    return n === 0 ? null : `plugins-changed pushes after refusals: ${n}`;
  });

  await gate('p5', 'the bridge carries no slot value: names, labels, choices, option values, statuses only', async () => {
    // Map a slot to a name the fake shell exports: its status reads « présente » and its FAKE-SECRET value is one read away.
    const m = await call('pluginsSetEnvMap', 'daily-brief', { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN' });
    if (!m || m.ok !== true) return `set-env-map answered ${J(m)}`;
    const back = await call('pluginsSetOption', 'daily-brief', 'CLAUDE_MODE', 'sub');
    if (!back || back.ok !== true) return `set sub answered ${J(back)}`;
    if (J(Object.keys(back).sort()) !== J(['name', 'ok', 'value'])) return `set answer carries other keys: ${J(back)}`;
    const a = await call('pluginsAccess', 'daily-brief');
    if (!a || a.ok !== true) return `access answered ${J(a)}`;
    const jira = (a.rows || []).find((x) => x.name === 'JIRA_TOKEN');
    if (!jira || jira.status !== 'présente') return `mapped slot is not read through the shell: ${J(jira)}`;
    const row = optionRow(a);
    if (!row || J(Object.keys(row)) !== J(['name', 'label', 'choices', 'value'])) return `option row keys: ${J(row && Object.keys(row))}`;
    if (row.choices.some((c) => J(Object.keys(c)) !== J(['value', 'label']))) return `choice keys: ${J(row.choices)}`;
    if (row.value !== 'sub') return `option value after the pick: ${row.value}`;
    await call('pluginsList');
    await call('pluginsDetect', { id: 'daily-brief' });
    const leaks = bridgeLog.filter((e) => /FAKE-SECRET/.test(J(e.r)));
    if (leaks.length) return `a fake secret value crossed the bridge in: ${leaks.map((e) => e.fn).join()}`;
    if (/FAKE-SECRET/.test(fs.readFileSync(STATE, 'utf8'))) return 'plugins.json holds a fake secret value';
    if (/process\.env|getenv/.test(ipc)) return 'ipc/plugins.js reads the environment';
    return null;
  });

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} FAIL of ${results.length}` : `ALL GREEN (${results.length} gates)`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  app.exit(failed ? 1 : 0);
}

setTimeout(() => { console.log('FAIL probe-timeout'); app.exit(2); }, 120000).unref();
main().catch((e) => { console.log(`FAIL probe-crash: ${e && e.stack}`); app.exit(2); });
