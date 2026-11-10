'use strict';
// plugin-options-state-probe — daily-brief-v2 step D9 (spec § 2.6 State, contract C14, R9.3): the choice of a declared plugin
// option (e.g. CLAUDE_MODE = sub | api) lives in the plugin's entry of plugins.json as `options: { NAME: value }`, written
// by host.setOption(id, name, value), answered by host.accessOf(id).options, handed to the runner as the 4th run() argument,
// and carried over a replace import by plugin-install.js. Hermetic: everything lives in a mkdtemp dir, fake scan / access /
// runner / reports, the real plugin-install.js on the real `valid` fixture with a stubbed native picker; no app boot, no
// network, no child process, no env read.
//   xvfb-run -a node_modules/.bin/electron test/plugin-options-state-probe.js
// Mutation proofs: --host-src=<plugins.js copy> / --install-src=<plugin-install.js copy> point the probe at another copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, dialog } = require('electron');

const ROOT = path.join(__dirname, '..');
const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? path.resolve(a.slice(k.length + 3)) : null; };
const HOST_SRC = argOf('host-src') || path.join(ROOT, 'src', 'main', 'plugins.js');
const INSTALL_SRC = argOf('install-src') || path.join(ROOT, 'src', 'main', 'plugin-install.js');
const FIX = path.join(__dirname, 'fixtures', 'plugins');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-options-state-probe-'));
const BASE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const NOW = new Date(2026, 10, 3, 9, 0).getTime();
const E_REQUEST = 'Requête invalide';
const E_UNKNOWN = 'Plugin introuvable';
const ID = 'sample-report'; // id of the `valid` fixture

const results = {};
async function gate(name, fn) {
  const fails = [];
  const t = { ok: (cond, msg) => { if (!cond) fails.push(msg); } };
  try { await fn(t); } catch (e) { fails.push(`threw: ${(e && e.message) || e}`); }
  results[name] = fails.length === 0;
  for (const m of fails) console.log(`  ${name}: ${m}`);
}
function finish() {
  const names = Object.keys(results);
  const ok = names.filter((n) => results[n]).length;
  for (const n of names) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}`);
  const green = names.length > 0 && ok === names.length;
  console.log(green ? `VERDICT: ALL GREEN (${ok}/${names.length})` : `VERDICT: RED (${ok}/${names.length})`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(green ? 0 : 1);
}

const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`; // the exact serialisation of both writers
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OPT = [{
  name: 'CLAUDE_MODE', label: 'Accès à Claude', default: 'sub',
  choices: [{ value: 'sub', label: 'Abonnement' }, { value: 'api', label: 'API' }],
}];
const SLOTS = [
  { name: 'JIRA_TOKEN', label: 'Jira', required: true, hints: ['JIRA'] },
  { name: 'CLAUDE_KEY', label: 'Clé API Claude (mode API)', required: false, hints: ['ANTHROPIC'] },
];
const mk = (id, extra) => ({ id, label: id, description: 'd', trigger: 'manual', argv: ['run'], env: [], options: [], dir: `/fake/plugins/${id}`, argv0Abs: `/fake/plugins/${id}/run`, ...extra });
const BRIEF = mk('daily-brief', { trigger: 'daily', env: SLOTS, options: OPT });
const PLAIN = mk('plain'); // declares no option
const NOSLOT = mk('no-slot', { options: OPT }); // options, no slot: accessOf takes its early return
const OPTIONAL_ONLY = mk('optional-only', { env: [SLOTS[1]], options: OPT }); // no required slot: no shell listing
const MAPPED = { JIRA_TOKEN: 'MY_JIRA' };
const ENTRY = { enabled: false, lastAutoDate: '2026-11-02', retentionDays: 7, envMap: MAPPED };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

let Host;
try { Host = require(HOST_SRC); } catch (e) { results.load = false; console.log(`  load failed: ${e.message}`); }
let seq = 0;
function rig({ plugins = [BRIEF], seed, listed = ['MY_JIRA'] } = {}) {
  const dir = path.join(TMP, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'plugins.json');
  if (seed !== undefined) fs.writeFileSync(statePath, seed);
  const calls = { run: [], list: 0 };
  let refuse = null; // a runner refusal answer, e.g. { ok: false, reason: 'invalid-option' }
  const access = {
    validName: (n) => typeof n === 'string' && NAME_RE.test(n),
    listNames: async () => { calls.list += 1; return { ok: true, names: listed }; },
    status: (slots, envMap, names) => slots.map((s) => ({ name: s.name, status: envMap[s.name] && names.includes(envMap[s.name]) ? 'présente' : 'absente', candidates: [] })),
  };
  const runner = {
    run: (p, envMap, trigger, options) => { calls.run.push({ id: p.id, trigger, envMap, options }); return refuse || { ok: true, stem: '2026-11-03T0900' }; },
    isRunning: () => false,
    runningStem: () => null,
  };
  const reports = { prune: () => {} };
  const host = Host.create({
    pluginsDir: path.join(dir, 'plugins'), statePath, nowFn: () => NOW, shellPath: '/fake/shell', baseNames: BASE, access, runner, reports,
    scan: async () => plugins,
  });
  const text = () => (fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null);
  return { dir, statePath, host, calls, text, json: () => JSON.parse(text()), refuse: (v) => { refuse = v; } };
}

// ---- the real import module, on the `valid` fixture, through a stubbed native picker ----
let PICK = null;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PICK] });
function mkSource() {
  const src = path.join(TMP, 'src', `s${++seq}`);
  fs.cpSync(path.join(FIX, 'valid'), src, { recursive: true });
  fs.chmodSync(path.join(src, 'run.sh'), 0o755);
  return src;
}
function installer(r) {
  const MF = require(path.join(ROOT, 'src', 'main', 'plugin-manifest.js'));
  const AC = require(path.join(ROOT, 'src', 'main', 'plugin-access.js'));
  return require(INSTALL_SRC).create({
    pluginsDir: path.join(r.dir, 'plugins'), dataRoot: path.join(r.dir, 'plugin-data'), statePath: r.statePath,
    validateManifest: MF.validateManifest, isRunning: () => false, stats: () => ({ count: 0, bytes: 0 }), baseNames: BASE, validName: AC.validName,
  });
}

if (Host) main().then(finish, (e) => { results.main_crashed = false; console.log(`  crashed: ${(e && e.stack) || e}`); finish(); });
else finish();

async function main() {
  console.log(`node ${process.versions.node} electron ${process.versions.electron}`);

  await gate('o1 setOption writes options.NAME, every other field of the entry and of the file unchanged', async (t) => {
    const r = rig({ seed: pretty({ 'daily-brief': ENTRY, other: { enabled: true }, $deck: { reportTheme: 'dark' } }) });
    const res = await r.host.setOption('daily-brief', 'CLAUDE_MODE', 'api');
    t.ok(same(res, { ok: true, name: 'CLAUDE_MODE', value: 'api' }), `result ${JSON.stringify(res)}`);
    t.ok(r.text() === pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: 'api' } }, other: { enabled: true }, $deck: { reportTheme: 'dark' } }),
      'whole file = previous content + options on the one entry, byte for byte');
    t.ok(r.json()['daily-brief'].options.CLAUDE_MODE === 'api', 'state[id].options.CLAUDE_MODE === api');
    t.ok((await r.host.setOption('daily-brief', 'CLAUDE_MODE', 'sub')).ok === true && r.json()['daily-brief'].options.CLAUDE_MODE === 'sub', 'back to sub');
    const fresh = rig();
    t.ok((await fresh.host.setOption('daily-brief', 'CLAUDE_MODE', 'api')).ok === true, 'no file: set ok');
    t.ok(same(fresh.json(), { 'daily-brief': { enabled: false, lastAutoDate: null, retentionDays: 30, envMap: {}, options: { CLAUDE_MODE: 'api' } } }), `no file -> default entry + options ${fresh.text()}`);
    const old = rig({ seed: pretty({ 'daily-brief': ENTRY }) });
    await old.host.setEnabled('daily-brief', false);
    t.ok(old.text() === pretty({ 'daily-brief': ENTRY }), 'an entry without options gains no empty options key from an unrelated write');
  });

  await gate('o2 undeclared name / undeclared value / non-string refused, file unchanged', async (t) => {
    const seeded = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: 'api' } } }) });
    const before = seeded.text();
    const empty = rig();
    const plain = rig({ plugins: [PLAIN] });
    const cases = [
      ['OTHER', 'api'], ['claude_mode', 'api'], ['CLAUDE_KEY', 'api'], ['__proto__', 'api'], ['constructor', 'api'], ['', 'api'],
      ['CLAUDE_MODE', 'gpt'], ['CLAUDE_MODE', 'API'], ['CLAUDE_MODE', ''], ['CLAUDE_MODE', 'api '], ['CLAUDE_MODE', '__proto__'],
      [null, 'api'], [undefined, 'api'], [5, 'api'], [{}, 'api'], [['CLAUDE_MODE'], 'api'], [{ toString: () => 'CLAUDE_MODE' }, 'api'],
      ['CLAUDE_MODE', null], ['CLAUDE_MODE', undefined], ['CLAUDE_MODE', 5], ['CLAUDE_MODE', true], ['CLAUDE_MODE', ['api']], ['CLAUDE_MODE', { toString: () => 'api' }],
    ];
    for (const [n, v] of cases) {
      const label = `${typeof n === 'object' ? JSON.stringify(n) : String(n)} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
      const a = await seeded.host.setOption('daily-brief', n, v);
      const b = await empty.host.setOption('daily-brief', n, v);
      const c = await plain.host.setOption('plain', n, v);
      t.ok(same(a, { ok: false, error: E_REQUEST }) && same(b, { ok: false, error: E_REQUEST }) && same(c, { ok: false, error: E_REQUEST }), `refused: ${label}`);
    }
    t.ok(same(await seeded.host.setOption('daily-brief'), { ok: false, error: E_REQUEST }), 'no argument refused');
    t.ok(same(await seeded.host.setOption('nope', 'CLAUDE_MODE', 'api'), { ok: false, error: E_UNKNOWN }), 'unknown plugin refused');
    t.ok(same(await seeded.host.setOption('$deck', 'CLAUDE_MODE', 'api'), { ok: false, error: E_UNKNOWN }), '$deck is no plugin');
    t.ok(seeded.text() === before, 'seeded file byte-identical after every refusal');
    t.ok(empty.text() === null && plain.text() === null, 'no file created by a refusal');
  });

  await gate('o3 setEnabled / setRetention / setEnvMap / claim and its restore keep options', async (t) => {
    const r = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, lastAutoDate: null } }) });
    t.ok((await r.host.setOption('daily-brief', 'CLAUDE_MODE', 'api')).ok === true, 'option set');
    let started = [];
    const steps = [
      ['setEnabled', () => r.host.setEnabled('daily-brief', true)],
      ['setRetention', () => r.host.setRetention('daily-brief', '14')],
      ['setEnvMap', () => r.host.setEnvMap('daily-brief', MAPPED)],
      ['startup claim', async () => { started = (await r.host.startup()).started; }],
      ['onExit restore', () => r.host.onExit('daily-brief', { trigger: 'auto', exit: 1 })],
      ['setEnabled off', () => r.host.setEnabled('daily-brief', false)],
    ];
    for (const [name, step] of steps) {
      await step();
      t.ok(same(r.json()['daily-brief'].options, { CLAUDE_MODE: 'api' }), `options kept after ${name}`);
    }
    t.ok(same(started, ['daily-brief']), 'the automatic claim path really ran');
    t.ok(r.json()['daily-brief'].retentionDays === 14 && r.json()['daily-brief'].lastAutoDate === null, 'the writers still did their own job');
    const odd = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: 'api', lower: 'api', BAD: 'A!', NUM: 5, ARR: ['x'], 'ANOTHER': 'x-1' } } }) });
    await odd.host.setRetention('daily-brief', 9);
    t.ok(same(odd.json()['daily-brief'].options, { CLAUDE_MODE: 'api', ANOTHER: 'x-1' }), `a write re-checks both patterns of every stored pair ${JSON.stringify(odd.json()['daily-brief'].options)}`);
    const bad = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: ['api'] } }) });
    await bad.host.setRetention('daily-brief', 9);
    t.ok(!('options' in bad.json()['daily-brief']), 'an array in place of the options object is dropped');
  });

  await gate('o4 a replace import keeps options (patterns re-checked), a first import adds none', async (t) => {
    const r = rig({ plugins: [mk(ID, { options: OPT })] });
    const I = installer(r);
    PICK = mkSource();
    const p1 = await I.pick();
    const imp = I.importPlugin(p1.token, {});
    t.ok(imp.ok === true && r.json()[ID] && !('options' in r.json()[ID]), `first import ok, no options key ${JSON.stringify(imp)}`);
    t.ok((await r.host.setOption(ID, 'CLAUDE_MODE', 'api')).ok === true, 'option set on the imported plugin');
    const withOpt = r.json()[ID];
    PICK = mkSource();
    const p2 = await I.pick();
    const rep = I.importPlugin(p2.token, { replace: true });
    t.ok(rep.ok === true && rep.replaced === true, `replace ok ${JSON.stringify(rep)}`);
    t.ok(same(r.json()[ID], { ...withOpt, enabled: true }), `replace keeps options and the other kept fields, leaves the plugin enabled ${JSON.stringify(r.json()[ID])}`);
    t.ok(!fs.existsSync(`${r.statePath}.tmp`), 'no leftover tmp file');
    const state = r.json();
    state[ID].options = { CLAUDE_MODE: 'api', lower: 'api', BAD: 'A!', NUM: 5, 'ANOTHER': 'x-1' };
    fs.writeFileSync(r.statePath, pretty(state));
    PICK = mkSource();
    const p3 = await I.pick();
    t.ok(I.importPlugin(p3.token, { replace: true }).ok === true, 'second replace ok');
    t.ok(same(r.json()[ID].options, { CLAUDE_MODE: 'api', ANOTHER: 'x-1' }), `replace re-checks both patterns ${JSON.stringify(r.json()[ID].options)}`);
    state[ID].options = ['api'];
    fs.writeFileSync(r.statePath, pretty(state));
    PICK = mkSource();
    const p4 = await I.pick();
    t.ok(I.importPlugin(p4.token, { replace: true }).ok === true && !('options' in r.json()[ID]), 'an odd options value is dropped, no empty key written');
  });

  await gate('o5 accessOf options rows: stored if declared else default, labels from the manifest', async (t) => {
    const rowsOf = async (r, id = 'daily-brief') => { const a = await r.host.accessOf(id); return a.ok ? a.options : a; };
    const none = rig();
    t.ok(same(await rowsOf(none), [{ name: 'CLAUDE_MODE', label: 'Accès à Claude', choices: OPT[0].choices, value: 'sub' }]), `default ${JSON.stringify(await rowsOf(none))}`);
    const api = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: 'api' } } }) });
    const rows = await rowsOf(api);
    t.ok(rows.length === 1 && rows[0].value === 'api', 'stored declared value');
    t.ok(same(Object.keys(rows[0]), ['name', 'label', 'choices', 'value']), `row keys ${Object.keys(rows[0])}`);
    t.ok(same(rows[0].choices, [{ value: 'sub', label: 'Abonnement' }, { value: 'api', label: 'API' }]), 'choices carry the manifest labels');
    rows[0].choices.push({ value: 'x', label: 'x' });
    rows[0].choices[0].label = 'mutated';
    t.ok(same((await rowsOf(api))[0].choices, OPT[0].choices) && OPT[0].choices.length === 2, 'rows are copies: a caller cannot reach the manifest');
    for (const stored of ['gpt', 'API', 5, null, ['api']]) {
      const odd = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: stored } } }) });
      t.ok((await rowsOf(odd))[0].value === 'sub', `stored ${JSON.stringify(stored)} -> default`);
    }
    const undeclared = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { OTHER_OPT: 'api' } } }) });
    t.ok(same((await rowsOf(undeclared)).map((x) => x.name), ['CLAUDE_MODE']), 'a stored name the manifest does not declare yields no row');
    t.ok(same(await rowsOf(rig({ plugins: [PLAIN] }), 'plain'), []), 'a plugin without options answers options: []');
    const noSlot = rig({ plugins: [NOSLOT] });
    const a = await noSlot.host.accessOf('no-slot');
    t.ok(a.ok === true && a.rows.length === 0 && a.ready === true && a.options.length === 1 && a.options[0].value === 'sub', `slot-less plugin: early return also carries options ${JSON.stringify(a)}`);
    const full = await api.host.accessOf('daily-brief');
    t.ok(full.ok === true && full.rows.length === 2 && full.ready === true && same(full.missing, []), 'rows / ready / missing unchanged');
    t.ok(same(await api.host.accessOf('nope'), { ok: false, error: E_UNKNOWN }), 'unknown plugin still refused');
  });

  await gate('o6 an automatic and a manual run hand the effective options to the runner', async (t) => {
    const r = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, lastAutoDate: null, enabled: true, options: { CLAUDE_MODE: 'api' } } }) });
    const auto = await r.host.startup();
    t.ok(same(auto.started, ['daily-brief']), `auto started ${JSON.stringify(auto)}`);
    const run = await r.host.runNow('daily-brief');
    t.ok(run.ok === true, `manual run ${JSON.stringify(run)}`);
    t.ok(r.calls.run.length === 2 && r.calls.run[0].trigger === 'auto' && r.calls.run[1].trigger === 'manual', 'one auto and one manual run');
    t.ok(r.calls.run.every((c) => same(c.options, { CLAUDE_MODE: 'api' })), `both got {CLAUDE_MODE:'api'} ${JSON.stringify(r.calls.run.map((c) => c.options))}`);
    t.ok(r.calls.run.every((c) => same(c.envMap, MAPPED)), 'the envMap argument is unchanged');
    const dflt = rig({ seed: pretty({ 'daily-brief': ENTRY }) });
    await dflt.host.runNow('daily-brief');
    t.ok(same(dflt.calls.run[0].options, { CLAUDE_MODE: 'sub' }), 'nothing stored -> the default');
    const odd = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, options: { CLAUDE_MODE: 'gpt' } } }) });
    await odd.host.runNow('daily-brief');
    t.ok(same(odd.calls.run[0].options, { CLAUDE_MODE: 'sub' }), 'stored value no longer a declared choice -> the default');
    const plain = rig({ plugins: [PLAIN] });
    await plain.host.runNow('plain');
    t.ok(same(plain.calls.run[0].options, {}), 'a plugin without options gets {}');
    const set = rig({ seed: pretty({ 'daily-brief': ENTRY }) }); // JIRA_TOKEN mapped: the run is allowed
    await set.host.setOption('daily-brief', 'CLAUDE_MODE', 'api');
    await set.host.runNow('daily-brief');
    t.ok(same(set.calls.run[0].options, { CLAUDE_MODE: 'api' }), 'setOption then run');
  });

  await gate('o7 the optional CLAUDE_KEY slot keeps the plugin ready in either mode (R9.2)', async (t) => {
    const r = rig({ seed: pretty({ 'daily-brief': ENTRY }) });
    for (const mode of ['sub', 'api']) {
      t.ok((await r.host.setOption('daily-brief', 'CLAUDE_MODE', mode)).ok === true, `${mode}: option set`);
      const a = await r.host.accessOf('daily-brief');
      const key = a.rows.find((x) => x.name === 'CLAUDE_KEY');
      t.ok(a.ok === true && a.ready === true && same(a.missing, []), `${mode}: accessOf ready ${JSON.stringify([a.ready, a.missing])}`);
      t.ok(key && key.required === false && key.mapped === null && key.status === 'absente', `${mode}: CLAUDE_KEY unmapped and absent, not required`);
      const l = r.host.list()[0];
      t.ok(l.ready === true && same(l.missing, []) && l.status === null, `${mode}: list() ready ${JSON.stringify([l.ready, l.missing, l.status])}`);
      r.calls.run.length = 0;
      t.ok((await r.host.runNow('daily-brief')).ok === true && r.calls.run.length === 1, `${mode}: runNow starts`);
      t.ok((await r.host.setEnabled('daily-brief', true)).ok === true, `${mode}: setEnabled(true) accepted`);
      await r.host.setEnabled('daily-brief', false);
    }
    const mapped = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, envMap: { ...MAPPED, CLAUDE_KEY: 'NOT_LISTED' } } }) });
    await mapped.host.setOption('daily-brief', 'CLAUDE_MODE', 'api');
    const m = await mapped.host.accessOf('daily-brief');
    t.ok(m.ready === true && m.rows.find((x) => x.name === 'CLAUDE_KEY').status === 'absente', 'api mode, CLAUDE_KEY mapped to a missing name: still ready');
    const onlyOpt = rig({ plugins: [OPTIONAL_ONLY] });
    await onlyOpt.host.setOption('optional-only', 'CLAUDE_MODE', 'api');
    await onlyOpt.host.rescan();
    t.ok(onlyOpt.host.list()[0].ready === true && onlyOpt.calls.list === 0, 'only an optional slot: ready without any shell listing');
    t.ok((await onlyOpt.host.runNow('optional-only')).ok === true && onlyOpt.calls.list === 0, 'only an optional slot: runNow without any shell listing');
  });

  await gate('o8 a runner refusal `invalid-option` has its own French line, like `invalid-name` (no value echoed, claim restored)', async (t) => {
    const E_OPTION = 'Option invalide';
    const r = rig({ seed: pretty({ 'daily-brief': ENTRY }) });
    r.refuse({ ok: false, reason: 'invalid-option' });
    const res = await r.host.runNow('daily-brief');
    t.ok(res.ok === false && res.error === E_OPTION, `run-now: ${JSON.stringify(res)}`);
    t.ok(res.error !== 'Lancement impossible', 'not the generic fallback line');
    r.refuse({ ok: false, reason: 'invalid-option', name: 'A$(id)' });
    const named = await r.host.runNow('daily-brief');
    t.ok(named.ok === false && named.error === E_OPTION && !/\$|\(id\)/.test(named.error), `a name the runner might add is not echoed: ${JSON.stringify(named)}`);
    const auto = rig({ seed: pretty({ 'daily-brief': { ...ENTRY, lastAutoDate: '2026-11-02', enabled: true } }) });
    auto.refuse({ ok: false, reason: 'invalid-option' });
    await auto.host.startup();
    t.ok(auto.calls.run.length === 1 && auto.json()['daily-brief'].lastAutoDate === '2026-11-02', `automatic run refused: claim restored (${auto.json()['daily-brief'].lastAutoDate})`);
    r.refuse(null);
    t.ok((await r.host.runNow('daily-brief')).ok === true, 'the runner accepting again launches');
  });

  await gate('o9 list() rows carry the effective options: stored pick, default, stale pick, none declared', async (t) => {
    const BOTH = [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }];
    const REAL = [{ name: 'CLAUDE_MODE', label: 'Appels Claude', choices: BOTH, default: 'subscription' }]; // the manifest option of the real plugin
    const WITH = mk('with-mode', { options: REAL });
    const rowsOf = async (seed, id = 'with-mode') => {
      const r = rig({ plugins: [WITH, PLAIN], seed });
      await r.host.rescan();
      return { r, row: r.host.list().find((x) => x.id === id) };
    };
    const expected = (value) => [{ name: 'CLAUDE_MODE', label: 'Appels Claude', choices: BOTH, value }];
    const picked = (v) => pretty({ 'with-mode': { ...ENTRY, options: { CLAUDE_MODE: v } } });

    const api = await rowsOf(picked('api'));
    t.ok(same(api.row.options, expected('api')), `stored api ${JSON.stringify(api.row.options)}`);
    const none = await rowsOf(undefined);
    t.ok(same(none.row.options, expected('subscription')), `no stored pick -> default ${JSON.stringify(none.row.options)}`);
    const entryOnly = await rowsOf(pretty({ 'with-mode': ENTRY }));
    t.ok(same(entryOnly.row.options, expected('subscription')), `entry without options -> default ${JSON.stringify(entryOnly.row.options)}`);
    for (const stored of ['gpt', 'API', '', 5, null, ['api']]) {
      const odd = await rowsOf(picked(stored));
      t.ok(same(odd.row.options, expected('subscription')), `stale pick ${JSON.stringify(stored)} -> default ${JSON.stringify(odd.row.options)}`);
    }
    const plain = await rowsOf(picked('api'), 'plain');
    t.ok(Array.isArray(plain.row.options) && same(plain.row.options, []), `a plugin declaring no option -> [] ${JSON.stringify(plain.row.options)}`);
    t.ok(plain.r.host.list().every((x) => Array.isArray(x.options)), 'every row of the list carries an options array');

    const OLD = ['id', 'label', 'description', 'trigger', 'enabled', 'retentionDays', 'lastAutoDate', 'envMap', 'ready', 'missing', 'error', 'running', 'status', 'note'];
    t.ok(OLD.every((k) => k in api.row) && api.row.id === 'with-mode' && api.row.enabled === false && api.row.retentionDays === 7, 'the fields the row already had are still there');

    api.row.options[0].choices.push({ value: 'x', label: 'x' });
    api.row.options[0].choices[0].label = 'mutated';
    api.row.options.push({ name: 'X' });
    t.ok(same(api.r.host.list().find((x) => x.id === 'with-mode').options, expected('api')) && REAL[0].choices.length === 2 && REAL[0].choices[0].label === 'Abonnement', 'rows are copies: a caller cannot reach the manifest');
    const st = api.r.json();
    t.ok(same(st['with-mode'].options, { CLAUDE_MODE: 'api' }) && !('plain' in st), 'list() writes nothing to plugins.json');
  });
}
