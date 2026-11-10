'use strict';
// plugin-host-probe — daily-brief S1 (docs/plans/daily-brief.plan.md § S1, fold v4.1 #1, v4.2 #5, v4.3 #6 #7 #17):
// the Deck host policy src/main/plugins.js + the config.js seams, against in-probe fakes only (scan, access, runner,
// reports are injected; the sibling plugin-*.js modules are never required, no shell, no spawn, no network).
// Hermetic: every rig has its own userData dir under one mkdtemp dir; the clock is a variable.
//   xvfb-run -a node_modules/.bin/electron test/plugin-host-probe.js
// PLUGIN_HOST_SRC=<dir> points the probe at another copy of src/main (mutation proofs); default: this tree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');
const { app, BrowserWindow } = require('electron');

// Two modes. Parent (default): g0-g12 on plugins.js with fakes, then S8 gates g13-g18 that drive the REAL app: each
// "boot" is a child Electron process (this same file, PLUGIN_HOST_CHILD=<scenario json>) that requires main.js and talks to
// it through window.api, so the preload mirror, the IPC layer and the composition are all exercised, and a reboot is a
// real restart over the same userData dir.
const CHILD = Boolean(process.env.PLUGIN_HOST_CHILD);
const SRC = process.env.PLUGIN_HOST_SRC ? path.resolve(process.env.PLUGIN_HOST_SRC) : path.join(__dirname, '..', 'src', 'main');
const TMP = CHILD ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-host-probe-'));
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const E_RUNNING = "Plugin en cours d'exécution";
const E_SHELL = 'Lecture du shell impossible';
const E_RETENTION = 'Durée de conservation : un entier entre 1 et 365';
const DAY = 86400e3;

let M = null;
let loadError = null;
try { M = require(path.join(SRC, 'plugins.js')); } catch (err) { loadError = err; }

// ---- fixtures -----------------------------------------------------------------------------------------------
// The shell's fake values live only here: the host's collaborators never receive them (names only), which is the
// boundary the real access module keeps. The probe greps every host output for them.
const FAKE_ENV = { DECK_FAKE_API_TOKEN: 'fake-secret-jira-8472', SLACK_USER_TOKEN: 'xoxp-fake-slack-9931' };
const FAKE_VALUES = Object.values(FAKE_ENV);
const SLOT_JIRA = { name: 'JIRA_TOKEN', label: 'Jeton Jira', required: true, hints: ['FAKE', 'TOKEN'] };
const SLOT_SLACK = { name: 'SLACK_TOKEN', label: 'Jeton Slack (utilisateur)', required: true, hints: ['SLACK', 'USER', 'TOKEN'] };
const SLOT_AIKIDO = { name: 'AIKIDO_KEY', label: 'Clé Aikido', required: false, hints: ['AIKIDO', 'KEY'] };
const PLUGIN = {
  id: 'daily-brief', label: 'Brief du jour', description: 'Résumé quotidien.', trigger: 'daily',
  argv: ['bin/daily-brief', 'run'], env: [SLOT_JIRA, SLOT_SLACK, SLOT_AIKIDO],
  dir: '/fake/plugins/daily-brief', argv0Abs: '/fake/plugins/daily-brief/bin/daily-brief',
};
const READY_MAP = { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN', SLACK_TOKEN: 'SLACK_USER_TOKEN' };
const readyEntry = (extra = {}) => ({ 'daily-brief': { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 7, envMap: { ...READY_MAP }, ...extra } });

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const dayStr = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// One run entry as reports.list answers it; `at` is a local ISO date-time.
const runEntry = (at, over = {}) => ({
  stem: `${at.slice(0, 10)}T${at.slice(11, 13)}${at.slice(14, 16)}`, start: Date.parse(at), trigger: 'manual', exit: 0, size: 1024, pid: null, hasReport: true, hasLog: true, ...over,
});
const walk = (d) => {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...walk(p));
  }
  return out;
};
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameMap = (a, b) => sameJson(Object.entries(a || {}).sort(), Object.entries(b || {}).sort()); // same pairs, any key order

// One rig = one userData dir + fake collaborators. boot() builds a NEW host over the same files (a Deck restart).
function rig(opts = {}) {
  const R = {
    userData: fs.mkdtempSync(path.join(TMP, 'ud-')),
    clock: { ms: Date.parse(opts.now || '2026-11-03T09:00:00') },
    calls: { scan: 0, scanArgs: null, listNames: 0, shellArgs: null, run: [], prune: [], list: [] },
    sh: { fail: false }, forced: new Set(), running: new Set(), lastTrigger: {}, refuse: null, stem: null,
    entries: {}, listFails: false, // run entries per plugin id, as reports.list answers them; listFails makes it throw
    plugins: opts.plugins || [], host: null,
  };
  R.statePath = path.join(R.userData, 'plugins.json');
  R.pluginsDir = path.join(R.userData, 'plugins'); // never created: "absent = no plugin"
  R.state = () => readJson(R.statePath);
  R.seed = (obj) => fs.writeFileSync(R.statePath, JSON.stringify(obj));
  R.files = () => walk(R.userData);
  R.baseNames = ['PATH', 'HOME', 'LANG'];
  const access = {
    async listNames(...args) {
      R.calls.listNames++;
      R.calls.shellArgs = args;
      // the real module answers { ok: true, names, note } or { ok: false, error, reason }
      return R.sh.fail ? { ok: false, error: E_SHELL, reason: 'timeout' } : { ok: true, names: Object.keys(FAKE_ENV), note: R.sh.note || null };
    },
    status: (slots, envMap, names) => slots.map((s) => {
      const m = envMap[s.name];
      return { name: s.name, status: !m ? 'introuvable' : names.includes(m) ? 'présente' : 'absente', candidates: [] };
    }),
    validName: (n) => typeof n === 'string' && NAME_RE.test(n),
  };
  R.access = access;
  const runner = {
    run(plugin, envMap, trigger) {
      R.calls.run.push({ id: plugin.id, envMap: { ...envMap }, trigger, stateAtRun: R.state() });
      R.lastTrigger[plugin.id] = trigger;
      if (R.refuse) return { ok: false, ...R.refuse };
      R.running.add(plugin.id);
      return { ok: true, stem: '2026-11-03T0900' };
    },
    // like the real runner, a run left alive by a previous Deck instance is recognised only when the plugin is passed
    isRunning: (id, plugin) => R.running.has(id) || (R.forced.has(id) && Boolean(plugin && plugin.id === id)),
    runningStem: (id, plugin) => (plugin ? R.stem : null),
  };
  const reports = {
    prune: (id, days, keep) => { R.calls.prune.push({ id, days, keep }); },
    // like the real list: {date} keeps the entries whose start falls on that local day
    list: (id, filter) => {
      R.calls.list.push({ id, filter });
      if (R.listFails) throw new Error('list failed');
      return (R.entries[id] || []).filter((e) => !filter || !filter.date || dayStr(e.start) === filter.date);
    },
  };
  R.finish = (id, info = {}) => {
    R.running.delete(id);
    R.host.onExit(id, { stem: '2026-11-03T0900', trigger: R.lastTrigger[id], exit: 0, signal: null, error: null, ...info });
  };
  R.boot = (extra = {}) => {
    if (!M) throw new Error(`plugins.js not loadable: ${loadError && loadError.message}`);
    R.host = M.create({
      pluginsDir: R.pluginsDir, statePath: R.statePath, nowFn: () => R.clock.ms, shellPath: '/fake/shell', baseNames: R.baseNames, access, runner, reports,
      scan: async (dir, o) => { R.calls.scan++; R.calls.scanArgs = [dir, o]; return R.plugins; },
      ...extra,
    });
    return R.host;
  };
  return R;
}

function loadConfig(env) {
  const cfg = path.join(SRC, 'config.js');
  const keys = ['CLAUDE_DECK_PLUGINS_DIR', 'CLAUDE_DECK_PLUGINS_NOW', 'CLAUDE_DECK_PLUGINS_SHELL'];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    delete require.cache[require.resolve(cfg)];
    return require(cfg);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    delete require.cache[require.resolve(cfg)];
  }
}

// ---- gates --------------------------------------------------------------------------------------------------
const gates = [];
const gate = (name, fn) => gates.push({ name, fn });

gate('g0 module shape: loads, requires only fs / path, reads no env, no sibling module', async (t) => {
  t.ok(M && typeof M.create === 'function', `create exported (${loadError && loadError.message})`);
  const src = fs.readFileSync(path.join(SRC, 'plugins.js'), 'utf8');
  const specs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  t.ok(specs.every((s) => ['fs', 'path'].includes(s)), `require specifiers: ${specs.join(',')}`);
  t.ok(!/process\.env|shell-env|resolveShellEnv/.test(src), 'no process.env / shell-env reference');
  const host = rig().boot();
  for (const m of ['startup', 'rescan', 'list', 'setEnabled', 'setRetention', 'setEnvMap', 'runNow', 'accessOf', 'onExit']) {
    t.ok(typeof host[m] === 'function', `host.${m}`);
  }
});

gate('g1 D1 no plugin: 0 run, 0 shell listing, 0 prune, nothing written under userData, empty list', async (t) => {
  const r = rig({ plugins: [] });
  const host = r.boot();
  await host.startup();
  t.ok(r.calls.run.length === 0, 'no run');
  t.ok(r.calls.listNames === 0, 'no shell listing');
  t.ok(r.calls.prune.length === 0, 'no prune');
  t.ok(r.calls.scan === 1 && r.calls.scanArgs[0] === r.pluginsDir, 'scan once on the injected dir');
  t.ok(r.calls.scanArgs[1].baseNames === r.baseNames, 'scan gets the injected BASE names');
  t.ok(sameJson(host.list(), []), 'list is empty');
  for (const res of [await host.runNow('nope'), await host.setEnabled('nope', true), await host.accessOf('nope'),
    await host.setRetention('nope', 7), await host.setEnvMap('nope', {})]) t.ok(res && res.ok === false, 'unknown id refused');
  t.ok(r.calls.listNames === 0 && r.calls.run.length === 0, 'still no shell / run after the refusals');
  t.ok(r.files().length === 0, `userData empty (${r.files().join(',')})`);
  t.ok(!fs.existsSync(r.pluginsDir), 'plugins dir never created');
});

gate('g2 D2 daily rule: new date -> 1 auto run (claim persisted before it), same date 0, disabled 0, run-now 1', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry());
  await r.boot().startup();
  t.ok(r.calls.run.length === 1 && r.calls.run[0].trigger === 'auto', 'one auto run on a new date');
  t.ok(r.calls.run[0].stateAtRun['daily-brief'].lastAutoDate === '2026-11-03', 'claim already on disk when the run starts');
  t.ok(sameJson(r.calls.run[0].envMap, READY_MAP), 'runner gets the mapped NAMES');
  t.ok(r.calls.listNames === 1, 'one shell listing at start');
  t.ok(sameJson(r.calls.shellArgs, ['/fake/shell']), `listing gets the shellPath and nothing else (${JSON.stringify(r.calls.shellArgs)})`);
  r.finish('daily-brief', { exit: 0 });
  await r.boot().startup();
  t.ok(r.calls.run.length === 1, 'same date, second boot: no run');
  r.clock.ms += DAY;
  await r.boot().startup();
  t.ok(r.calls.run.length === 2, 'next date: a run');
  r.finish('daily-brief', { exit: 0 });

  const d = rig({ plugins: [PLUGIN] });
  d.seed(readyEntry({ enabled: false }));
  await d.boot().startup();
  t.ok(d.calls.run.length === 0 && d.calls.listNames === 0, 'disabled: no run, no shell listing');
  t.ok(d.state()['daily-brief'].lastAutoDate === '2026-11-02', 'disabled: no claim');

  const m = rig({ plugins: [{ ...PLUGIN, id: 'manual-one', trigger: 'manual' }] });
  m.seed({ 'manual-one': { enabled: true, lastAutoDate: null, retentionDays: 30, envMap: { ...READY_MAP } } });
  await m.boot().startup();
  t.ok(m.calls.run.length === 0, 'manual trigger: never automatic');

  const n = rig({ plugins: [PLUGIN] });
  n.seed(readyEntry({ enabled: false }));
  const host = n.boot();
  await host.startup();
  const res = await host.runNow('daily-brief');
  t.ok(res.ok === true && n.calls.run.length === 1 && n.calls.run[0].trigger === 'manual', 'run-now: one manual run');
  t.ok(n.state()['daily-brief'].lastAutoDate === '2026-11-02', 'run-now never touches the claim');
});

gate('g3 D23 gate e: required slot unmapped or absent -> enable / run-now / auto refused, no claim, "À configurer"', async (t) => {
  let r = rig({ plugins: [PLUGIN] });
  let host = r.boot();
  await host.startup();
  let res = await host.setEnabled('daily-brief', true);
  t.ok(res.ok === false && res.error === 'Accès requis manquant : Jeton Jira, Jeton Slack (utilisateur)', `unmapped refused (${res.error})`);
  t.ok(!r.state(), 'nothing persisted by the refusal');
  r = rig({ plugins: [PLUGIN] });
  r.seed({ 'daily-brief': { enabled: false, lastAutoDate: null, retentionDays: 30, envMap: { JIRA_TOKEN: 'JIRA_NOT_EXPORTED', SLACK_TOKEN: 'SLACK_USER_TOKEN' } } });
  host = r.boot();
  res = await host.setEnabled('daily-brief', true);
  t.ok(res.ok === false && res.error === 'Accès requis manquant : Jeton Jira', `absent refused, only the missing label (${res.error})`);
  t.ok(r.state()['daily-brief'].enabled === false, 'enabled stays false');

  r = rig({ plugins: [PLUGIN] });
  r.seed({ 'daily-brief': { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 7, envMap: { SLACK_TOKEN: 'SLACK_USER_TOKEN' } } });
  host = r.boot();
  await host.startup();
  t.ok(r.calls.run.length === 0, 'enabled but not ready: no automatic run');
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-02', 'no lastAutoDate claim');
  const row = host.list()[0];
  t.ok(row.ready === false && row.status === 'À configurer' && sameJson(row.missing, ['Jeton Jira']), `list: not ready (${JSON.stringify(row)})`);
  res = await host.runNow('daily-brief');
  t.ok(res.ok === false && /^Accès requis manquant/.test(res.error) && r.calls.run.length === 0, 'run-now refused, no run');

  r = rig({ plugins: [PLUGIN] });
  r.seed({ 'daily-brief': { enabled: false, lastAutoDate: null, retentionDays: 30, envMap: { ...READY_MAP } } });
  res = await r.boot().setEnabled('daily-brief', true);
  t.ok(res.ok === true && r.state()['daily-brief'].enabled === true, 'optional slot unmapped does not block');

  r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry());
  r.sh.fail = true;
  host = r.boot();
  await host.startup();
  t.ok(r.calls.run.length === 0 && r.state()['daily-brief'].lastAutoDate === '2026-11-02', 'shell unreadable: no run, no claim');
  const srow = host.list()[0];
  t.ok(srow.ready === false && srow.status === 'À configurer' && srow.error === E_SHELL, `shell unreadable: not ready (${JSON.stringify(srow)})`);
  res = await host.setEnabled('daily-brief', false);
  t.ok(res.ok === true && r.state()['daily-brief'].enabled === false, 'disabling needs no shell');
  r.seed(readyEntry({ enabled: false }));
  res = await host.setEnabled('daily-brief', true);
  t.ok(res.ok === false && res.error === E_SHELL, `enable on shell failure -> "${E_SHELL}"`);

  r = rig({ plugins: [PLUGIN] });
  r.seed({ 'daily-brief': { enabled: false, lastAutoDate: null, retentionDays: 30, envMap: {} } });
  host = r.boot();
  await host.startup();
  const urow = host.list()[0];
  t.ok(r.calls.listNames === 0 && urow.ready === null && urow.status === null, 'never listed: unknown renders as nothing, no shell call');

  r = rig({ plugins: [{ ...PLUGIN, id: 'no-slot', env: [] }] });
  res = await r.boot().setEnabled('no-slot', true);
  t.ok(res.ok === true && r.calls.listNames === 0, 'no required slot: enabled without a shell call');
});

gate('g4 D22: setEnvMap with a hostile name refused, nothing persisted, no file touched', async (t) => {
  const marker = path.join(os.tmpdir(), `p-${process.pid}-${Date.now()}`);
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ enabled: false }));
  const before = fs.readFileSync(r.statePath, 'utf8');
  const host = r.boot();
  const bad = [{ JIRA_TOKEN: `X;touch ${marker}` }, { JIRA_TOKEN: `$(touch ${marker})` }, { JIRA_TOKEN: 'A B' }, { JIRA_TOKEN: '1ABC' },
    { JIRA_TOKEN: 42 }, { JIRA_TOKEN: 'A'.repeat(65) }, { [`X;touch ${marker}`]: 'DECK_FAKE_API_TOKEN' }, { EVIL: 'DECK_FAKE_API_TOKEN' },
    { SLACK_TOKEN: 'SLACK_USER_TOKEN', JIRA_TOKEN: `X;touch ${marker}` }, null, [], 'DECK_FAKE_API_TOKEN'];
  for (const map of bad) {
    const res = await host.setEnvMap('daily-brief', map);
    t.ok(res.ok === false && typeof res.error === 'string', `refused: ${JSON.stringify(map)}`);
  }
  const hostile = await host.setEnvMap('daily-brief', { JIRA_TOKEN: `X;touch ${marker}` });
  t.ok(hostile.error === 'Nom de variable invalide : JIRA_TOKEN', `French line naming the slot (${hostile.error})`);
  t.ok(!hostile.error.includes('touch'), 'the rejected text is not echoed back');
  t.ok(fs.readFileSync(r.statePath, 'utf8') === before, 'state file byte-identical after every refusal');
  t.ok(!fs.existsSync(marker), 'marker file absent');
  const ok = await host.setEnvMap('daily-brief', { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN', SLACK_TOKEN: 'SLACK_USER_TOKEN', AIKIDO_KEY: '' });
  t.ok(ok.ok === true && sameJson(r.state()['daily-brief'].envMap, READY_MAP), 'valid names persisted, empty entry unmapped');

  // a hand-edited state file with a hostile name must never reach the runner
  const h = rig({ plugins: [PLUGIN] });
  h.seed({ 'daily-brief': { enabled: true, lastAutoDate: null, retentionDays: 30, envMap: { JIRA_TOKEN: `X;touch ${marker}`, SLACK_TOKEN: 'SLACK_USER_TOKEN' } } });
  const hh = h.boot();
  await hh.startup();
  await hh.runNow('daily-brief');
  t.ok(h.calls.run.length === 0, 'hostile hand-edited map: no run');
  t.ok(!JSON.stringify(hh.list()).includes('touch'), 'hostile name not echoed by list()');
  t.ok(!fs.existsSync(marker), 'marker still absent');
});

gate('g5 D19: plugins.json holds names only; no fake value in the file, list(), accessOf() or the refusals', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  const host = r.boot();
  const outputs = [];
  outputs.push(await host.setEnvMap('daily-brief', { JIRA_TOKEN: FAKE_VALUES[0] }));
  outputs.push(await host.setEnvMap('daily-brief', { SLACK_TOKEN: FAKE_VALUES[1] }));
  t.ok(outputs.every((o) => o.ok === false), 'a value is not a name: refused');
  outputs.push(await host.setEnvMap('daily-brief', READY_MAP));
  outputs.push(await host.setEnabled('daily-brief', true));
  outputs.push(await host.setRetention('daily-brief', 7));
  await host.startup();
  r.finish('daily-brief', { exit: 0 });
  r.sh.note = 'shell non pris en charge, lecture via bash';
  const access = await host.accessOf('daily-brief');
  t.ok(access.note === r.sh.note && host.list()[0].note === r.sh.note, 'the listing note reaches accessOf() and list()');
  outputs.push(access, host.list());
  const text = fs.readFileSync(r.statePath, 'utf8');
  const hits = FAKE_VALUES.filter((v) => text.includes(v) || JSON.stringify(outputs).includes(v));
  t.ok(hits.length === 0, `fake values in file or payloads: ${hits.length}`);
  const entry = JSON.parse(text)['daily-brief'];
  t.ok(sameJson(Object.keys(entry).sort(), ['enabled', 'envMap', 'lastAutoDate', 'retentionDays']), `entry keys (${Object.keys(entry)})`);
  t.ok(Object.entries(entry.envMap).every(([k, v]) => NAME_RE.test(k) && NAME_RE.test(v)), 'envMap holds NAMES only');
  t.ok(access.ok === true && access.rows.length === 3, 'accessOf: one row per slot');
  t.ok(access.rows.every((x) => ['name', 'label', 'required', 'hints', 'mapped', 'status', 'candidates'].every((k) => k in x)), 'accessOf row shape');
  t.ok(access.rows.find((x) => x.name === 'JIRA_TOKEN').status === 'présente' && access.rows.find((x) => x.name === 'AIKIDO_KEY').status === 'introuvable', 'accessOf statuses');
  t.ok(fs.readdirSync(r.userData).every((f) => !f.endsWith('.tmp')), 'tmp+rename leaves no .tmp');
});

gate('g6 retention: 0 / 366 / 2.5 / junk refused, 7 persisted and survives a reboot', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ retentionDays: 30 }));
  const host = r.boot();
  for (const bad of [0, 366, 2.5, -1, NaN, null, undefined, '', 'abc', '2.5', {}, [], 1e3, Infinity]) {
    const res = await host.setRetention('daily-brief', bad);
    t.ok(res.ok === false && res.error === E_RETENTION, `refused: ${String(bad)}`);
  }
  t.ok(r.state()['daily-brief'].retentionDays === 30, 'refusals persist nothing');
  const res = await host.setRetention('daily-brief', 7);
  t.ok(res.ok === true && r.state()['daily-brief'].retentionDays === 7, '7 persisted');
  t.ok((await host.setRetention('daily-brief', 1)).ok && (await host.setRetention('daily-brief', 365)).ok, 'bounds 1 and 365 accepted');
  await host.setRetention('daily-brief', 7);
  const again = r.boot();
  await again.startup();
  const row = again.list()[0];
  t.ok(row.retentionDays === 7 && row.enabled === true && sameJson(row.envMap, READY_MAP), 'enabled, retentionDays, envMap survive a reboot');
  const fresh = rig({ plugins: [PLUGIN] });
  const f = fresh.boot();
  await f.startup();
  t.ok(f.list()[0].retentionDays === 30 && f.list()[0].enabled === false, 'defaults: 30 days, disabled');
  t.ok(!fresh.state(), 'defaults are not written');
});

gate('g7 D17 + fold v4.3 #7: prune at start (every plugin) and after exit, keepStems from runner.runningStem', async (t) => {
  const other = { ...PLUGIN, id: 'other-one', trigger: 'manual' };
  const r = rig({ plugins: [PLUGIN, other] });
  r.seed(readyEntry({ lastAutoDate: '2026-11-03' })); // claimed today: no run, pure start-up prune
  await r.boot().startup();
  const p0 = r.calls.prune.map((p) => `${p.id}:${p.days}:${JSON.stringify(p.keep)}`).sort();
  t.ok(sameJson(p0, ['daily-brief:7:[]', 'other-one:30:[]']), `start-up prune (${p0})`);
  t.ok(r.calls.run.length === 0, 'no run');

  const q = rig({ plugins: [PLUGIN] });
  q.seed(readyEntry());
  await q.boot().startup();
  const before = q.calls.prune.length;
  q.stem = '2026-11-03T0900';
  q.finish('daily-brief', { exit: 0 });
  const last = q.calls.prune[q.calls.prune.length - 1];
  t.ok(q.calls.prune.length === before + 1, 'one prune after the exit');
  t.ok(last.id === 'daily-brief' && last.days === 7 && sameJson(last.keep, ['2026-11-03T0900']), `prune(id, days, [runningStem]) (${JSON.stringify(last)})`);
  q.stem = null;
  await q.host.runNow('daily-brief');
  q.finish('daily-brief', { exit: 0 });
  t.ok(sameJson(q.calls.prune[q.calls.prune.length - 1].keep, []), 'no running stem -> empty keepStems');
});

gate('g8 fold v4.1 #1: auto exit != 0 restores lastAutoDate (retry at the next start), exit 0 keeps the claim', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: '2026-11-01' }));
  await r.boot().startup();
  t.ok(r.calls.run.length === 1 && r.calls.run[0].stateAtRun['daily-brief'].lastAutoDate === '2026-11-03', 'claimed before the run');
  r.finish('daily-brief', { exit: 3 });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-01', `restored to the previous value (${r.state()['daily-brief'].lastAutoDate})`);
  await r.boot().startup();
  t.ok(r.calls.run.length === 2, 'next boot, same date: runs once more');
  r.finish('daily-brief', { exit: 0 });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-03', 'exit 0 keeps the claim');
  await r.boot().startup();
  t.ok(r.calls.run.length === 2, 'next boot after a success: no run');

  const n = rig({ plugins: [PLUGIN] });
  n.seed(readyEntry({ lastAutoDate: null }));
  await n.boot().startup();
  n.finish('daily-brief', { exit: 3 });
  t.ok(n.state()['daily-brief'].lastAutoDate === null, 'previous value null is restored as null');
  await n.boot().startup();
  t.ok(n.calls.run.length === 2, 'retry after a null restore');

  const m = rig({ plugins: [PLUGIN] });
  m.seed(readyEntry());
  const host = m.boot();
  await host.runNow('daily-brief');
  m.finish('daily-brief', { exit: 3 });
  t.ok(m.state()['daily-brief'].lastAutoDate === '2026-11-02', 'a failed manual run never touches the claim');
});

gate('g9 fold v4.3 #6: spawn error, signal exit and runner refusal each restore lastAutoDate', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: '2026-11-01' }));
  await r.boot().startup();
  r.finish('daily-brief', { exit: undefined, error: 'spawn /fake/shell ENOENT' });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-01', 'spawn error: restored');
  await r.boot().startup();
  t.ok(r.calls.run.length === 2, 'retried after the spawn error');
  r.finish('daily-brief', { exit: null, signal: 'SIGKILL' });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-01', 'signal exit: restored');
  r.refuse = { reason: 'invalid-name', name: 'X' };
  await r.boot().startup();
  t.ok(r.calls.run.length === 3, 'third attempt reached the runner');
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-01', 'runner refusal (no spawn, no onExit): restored at once');
  r.refuse = null;
  await r.boot().startup();
  t.ok(r.calls.run.length === 4, 'fourth attempt runs');
  r.finish('daily-brief', { exit: 0 });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-03', 'then exit 0 keeps the claim');
  r.host.onExit('daily-brief', { stem: 'S', trigger: 'auto', exit: 3, signal: null, error: null });
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-03', 'a stray exit report with no pending claim changes nothing');

  const q = rig({ plugins: [PLUGIN] });
  q.seed(readyEntry({ enabled: false }));
  const h = q.boot();
  await h.startup();
  const lines = [[{ reason: 'running' }, E_RUNNING], [{ reason: 'invalid-name', name: 'X' }, 'Nom de variable invalide : X'],
    [{ reason: 'entry-failed', error: 'EACCES' }, 'Lancement impossible : EACCES'], [{ reason: 'bad-input' }, 'Lancement impossible']];
  for (const [refuse, line] of lines) {
    q.refuse = refuse;
    const res = await h.runNow('daily-brief');
    t.ok(res.ok === false && res.error === line, `run-now maps ${JSON.stringify(refuse)} -> "${res.error}"`);
  }
  q.refuse = null;
  t.ok((await h.runNow('daily-brief')).ok === true, 'run-now launches once the runner accepts');
});

gate('g10 fold v4.2 #5: a run the runner reports alive (sidecar exit null, live pid) -> no auto run, no claim, run-now refused', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry());
  r.forced.add('daily-brief');
  const host = r.boot();
  await host.startup();
  t.ok(r.calls.run.length === 0, 'no automatic run');
  t.ok(r.state()['daily-brief'].lastAutoDate === '2026-11-02', 'no claim');
  t.ok(host.list()[0].running === true, 'list: running');
  const listed = r.calls.listNames;
  const res = await host.runNow('daily-brief');
  t.ok(res.ok === false && res.error === E_RUNNING && r.calls.run.length === 0, `run-now refused (${res.error})`);
  t.ok(r.calls.listNames === listed, 'refused before any shell call');
  r.forced.clear();
  await r.boot().startup();
  t.ok(r.calls.run.length === 1, 'once the process is gone, the daily rule applies again');
});

gate('g11 corrupt or odd plugins.json -> {} (no throw), rewritten valid at the next change', async (t) => {
  for (const junk of ['{not json', '[]', '"str"', 'null', '']) {
    const r = rig({ plugins: [PLUGIN] });
    fs.writeFileSync(r.statePath, junk);
    const host = r.boot();
    await host.startup();
    t.ok(host.list().length === 1 && host.list()[0].enabled === false, `survives ${JSON.stringify(junk)}`);
    const res = await host.setRetention('daily-brief', 9);
    t.ok(res.ok === true && r.state()['daily-brief'].retentionDays === 9, 'rewritten valid');
  }
});

gate('g12 config.js seams: PLUGINS_DIR / PLUGINS_NOW / PLUGINS_SHELL (null by default), provisional PLUGIN_BASE_ENV', async (t) => {
  const d = loadConfig({});
  t.ok(d.PLUGINS_DIR === null && d.PLUGINS_NOW === null && d.PLUGINS_SHELL === null, 'defaults are null');
  const s = loadConfig({ CLAUDE_DECK_PLUGINS_DIR: '/x/plugins', CLAUDE_DECK_PLUGINS_NOW: '2026-11-03T08:00:00', CLAUDE_DECK_PLUGINS_SHELL: '/bin/bash' });
  t.ok(s.PLUGINS_DIR === '/x/plugins' && s.PLUGINS_SHELL === '/bin/bash', 'dir and shell seams');
  t.ok(s.PLUGINS_NOW === Date.parse('2026-11-03T08:00:00'), 'ISO clock seam -> epoch ms');
  t.ok(loadConfig({ CLAUDE_DECK_PLUGINS_NOW: '1793000000000' }).PLUGINS_NOW === 1793000000000, 'epoch ms clock seam');
  t.ok(loadConfig({ CLAUDE_DECK_PLUGINS_NOW: 'garbage' }).PLUGINS_NOW === null, 'unparsable clock ignored');
  const expect = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
  t.ok(sameJson(d.PLUGIN_BASE_ENV, expect), 'PLUGIN_BASE_ENV is the provisional list');
  t.ok(Object.isFrozen(d.PLUGIN_BASE_ENV), 'PLUGIN_BASE_ENV frozen');
});

// ---- S8: the real app, booted as child processes -------------------------------------------------------------
const REPO = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');
const RC_SHELL = path.join(FIXTURES, 'runner-shell.sh'); // the fixture "user shell": its rc exports and ECHOES two fake secrets
const RC_SECRETS = ['fake-rsh-mapped-9c41e7', 'fake-rsh-other-5d02b8'];
const DEAD = 'http://127.0.0.1:1';
const CHANNELS = ['plugins-list', 'plugins-set-enabled', 'plugins-set-retention', 'plugins-set-env-map', 'plugins-access', 'plugins-detect',
  'plugins-run-now', 'plugins-history', 'plugins-open-report', 'plugins-read-log', 'plugins-pick', 'plugins-import', 'plugins-delete-card', 'plugins-delete',
  'plugin-view-escape'];
const WINDOW_PUSH = ['plugin-view-escape']; // sent by window.js (before-input-event), not by the plugins IPC layer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fixtureManifest = (over = {}) => ({
  id: 'fake', label: 'Plugin factice', description: 'Fixture du host.', argv: ['run.py'], trigger: 'daily',
  env: [{ name: 'FAKE_TOKEN', label: 'Jeton factice', required: true, hints: ['RSH', 'MAPPED'] },
    { name: 'FAKE_OPT', label: 'Option factice', required: false, hints: ['FAKE', 'OPT'] }], ...over,
});
function installFixture(dir, over = {}) { // a plugin folder = the S1s fixture script + a manifest of this probe
  const m = fixtureManifest(over);
  const d = path.join(dir, m.id);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'fake', 'run.py'), path.join(d, 'run.py'));
  fs.chmodSync(path.join(d, 'run.py'), 0o755);
  fs.writeFileSync(path.join(d, 'deck-plugin.json'), JSON.stringify(m));
  return d;
}

// One rig = one userData dir surviving the boots + a counting wrapper around the fixture shell: it logs "list" for a names
// listing and "run" for a plugin launch (the launch command is the one holding `exec env -i`), then hands over to the fixture.
function bootRig(name, shellTarget = RC_SHELL) {
  const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
  const R = { dir, n: 0, userData: path.join(dir, 'ud'), pluginsDir: path.join(dir, 'plugins'), shell: path.join(dir, 'sh', 'bash'), countFile: path.join(dir, 'count.log') };
  // the wrapper is named `bash`: the listing shell is an allowlist on the basename, anything else goes to /bin/bash and bypasses the fake
  for (const d of ['ud', 'projects', 'home', 'ask', 'status', 'sh']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(R.shell, `#!/bin/bash\ncase "$2" in *"exec env -i"*) echo run >> "${R.countFile}" ;; *) echo list >> "${R.countFile}" ;; esac\nexec "${shellTarget}" "$@"\n`, { mode: 0o755 });
  R.counts = () => {
    const l = fs.existsSync(R.countFile) ? fs.readFileSync(R.countFile, 'utf8').split('\n').filter(Boolean) : [];
    return { run: l.filter((x) => x === 'run').length, list: l.filter((x) => x === 'list').length };
  };
  R.statePath = path.join(R.userData, 'plugins.json');
  R.state = () => readJson(R.statePath);
  R.reportsDir = path.join(R.userData, 'plugin-data', 'fake', 'reports');
  R.sidecars = () => { try { return fs.readdirSync(R.reportsDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ stem: f.slice(0, -5), ...readJson(path.join(R.reportsDir, f)) })); } catch (_) { return []; } };
  return R;
}

const WAIT_LISTED = { op: 'waitFor', as: 'listed', code: 'const l = await window.api.pluginsList(); return l.every((r) => r.ready !== null);' };
const finishedToday = (n) => ({ op: 'waitFor', as: `finished>=${n}`, ms: 20000,
  code: `const h = await window.api.pluginsHistory('fake', { days: 1 }); return h.filter((e) => e.exit !== null).length >= ${n};` });
const ev = (as, code) => ({ op: 'eval', as, code });
// S19 renderer-side helpers: each eval is its own async function body, so the helpers are prepended to every UI step.
const UI_HELP = `
  const $q = (s, r = document) => r.querySelector(s);
  const rowEl = (id) => $q('#plg-list .plg-row[data-id="' + id + '"]');
  const shownTitle = () => { const p = $q('#plugin-panel'), h = $q('#plg-dhead h2'); return p && p.dataset.page === 'detail' && h ? h.textContent : null; };
  // K5: a list row holds the pick, the status and ONE quick action; its « off » class says the plugin is disabled (the switch itself lives in the Paramètres tab, see sw()).
  const snap = () => [...document.querySelectorAll('#plg-list .plg-row')].map((r) => ({
    id: r.dataset.id, label: $q('.plg-label', r).textContent, desc: $q('.plg-desc', r).textContent,
    on: String(!r.classList.contains('off')), runDis: $q('.plg-run', r).disabled,
    runText: $q('.plg-run', r).textContent, status: $q('.plg-status', r).textContent, note: $q('.plg-note', r).textContent,
    current: shownTitle() === $q('.plg-label', r).textContent ? 'true' : null }));
  const rowOf = (id) => snap().find((r) => r.id === id) || {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end && !cond()) await wait(40); return Boolean(cond()); };
  const backToList = async () => { const p = $q('#plugin-panel'); if (!p || p.dataset.page !== 'detail') return true; $q('#plg-back').click(); return until(() => p.dataset.page === 'list'); };
  // The detail page of a plugin, reached the user's way: back to the list when another one is open, then its pick button.
  const openDetail = async (id) => {
    const label = rowOf(id).label;
    if (label === undefined) return false;
    if (shownTitle() !== null && shownTitle() !== label) await backToList();
    if (shownTitle() !== label) $q('[data-act="pick"]', rowEl(id)).click();
    return until(() => shownTitle() === label);
  };
  const goTab = (tab) => { const b = $q('#plg-detail [data-act="tab"][data-tab="' + tab + '"]'); if (b) b.click(); return Boolean(b); };
  const sw = () => { const s = $q('#plg-set-switch'); return s ? { on: s.getAttribute('aria-checked'), dis: s.disabled } : null; };
  // V26: « Modifier » (data-act="access") lives in the head of the « Accès » card of the Paramètres tab: reach it the user's way, the tab then the button.
  const accessBtn = () => $q('#plg-settings .plg-set-head [data-act="access"]');
  const clickAccess = async (id) => { await openDetail(id); goTab('settings'); await until(() => Boolean(accessBtn()) && !$q('#plg-settings').hidden, 2000); const b = accessBtn(); if (b) b.click(); return Boolean(b); };
`;
const uiEv = (as, code) => ev(as, UI_HELP + code);
const shots = (name) => (process.env.PLUGIN_HOST_SHOTS ? [{ op: 'shot', file: path.join(process.env.PLUGIN_HOST_SHOTS, name) }] : []);
const uiWait = (as, cond, ms) => ({ op: 'waitFor', as, ms: ms || 15000, code: `${UI_HELP} return Boolean(${cond});` });

// Spawns the child; resolves { results, error } (error = null when every step ran).
function runBoot(R, steps, o = {}) {
  return new Promise((resolve) => {
    const scenario = path.join(R.dir, `scenario-${++R.n}.json`);
    fs.writeFileSync(scenario, JSON.stringify({ userData: R.userData, steps, fakeInstall: Boolean(o.fakeInstall), importFrom: o.importFrom || null, countFile: R.countFile }));
    // names the S19d scenario matches by hint must come from the fake shell only, never from the machine running the probe
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(JIRA|SLACK|AIKIDO|GITLAB|OPENAI|CLAUDE_(?!DECK_))/.test(k)));
    const env = {
      ...inherited, PLUGIN_HOST_CHILD: scenario, HOME: path.join(R.dir, 'home'),
      CLAUDE_DECK_BIN: o.bin || '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: path.join(R.dir, 'projects'),
      CLAUDE_DECK_ASK_DIR: path.join(R.dir, 'ask'), CLAUDE_DECK_STATUS_DIR: path.join(R.dir, 'status'),
      CLAUDE_DECK_PRICES_URL: DEAD, CLAUDE_DECK_COMMANDS_URL: DEAD,
      CLAUDE_DECK_PLUGINS_DIR: R.pluginsDir, CLAUDE_DECK_PLUGINS_NOW: o.now || '2026-11-03T09:00:00',
      CLAUDE_DECK_PLUGINS_SHELL: R.shell,
    };
    for (const k of ['OPENAI_API_KEY', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[k];
    const child = cp.spawn(process.execPath, [__filename], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 100000);
    child.on('close', () => {
      clearTimeout(timer);
      const m = /@@RESULT@@(.*)/.exec(buf);
      let parsed = null;
      try { parsed = m && JSON.parse(m[1]); } catch (_) { /* reported below */ }
      resolve(parsed || { results: {}, error: 'child gave no result' });
    });
  });
}

// ---- child side ----
function patchInstall(sc) { // stands in for plugin-install.js (S8b's file): records how the IPC layer builds and uses it
  const secondManifest = fixtureManifest({ id: 'second', label: 'Second', env: [{ name: 'SEC_TOKEN', label: 'Jeton second', required: false, hints: ['RSH', 'OTHER'] }] });
  globalThis.__installLoads = 0;
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (/(^|\/)plugin-install(\.js)?$/.test(request)) {
      globalThis.__installLoads++;
      return {
        create(opts) {
          globalThis.__installOpts = opts;
          return {
            pick: async () => ({ ok: true, token: 'tok1', manifest: secondManifest }),
            manifestForToken: (t) => (t === 'tok1' ? { ok: true, manifest: secondManifest } : null),
            importPlugin: async (t, o) => {
              if (t !== 'tok1') return { ok: false, error: 'Jeton inconnu' };
              fs.cpSync(sc.importFrom, path.join(opts.pluginsDir, 'second'), { recursive: true });
              return { ok: true, id: 'second', replace: Boolean(o && o.replace) };
            },
            deleteCard: (id) => ({ ok: true, id, count: 3, bytes: 1234 }),
            deletePlugin: async (id) => {
              if (opts.isRunning(id)) return { ok: false, error: E_RUNNING };
              fs.rmSync(path.join(opts.pluginsDir, id), { recursive: true, force: true });
              return { ok: true };
            },
          };
        },
      };
    }
    return origLoad.call(this, request, ...rest);
  };
}

async function childMain() {
  const sc = JSON.parse(fs.readFileSync(process.env.PLUGIN_HOST_CHILD, 'utf8'));
  const out = { results: {}, error: null };
  const done = (code) => process.stdout.write(`\n@@RESULT@@${JSON.stringify(out)}\n`, () => app.exit(code));
  setTimeout(() => { out.error = 'child watchdog'; done(2); }, 90000).unref();
  try {
    app.setPath('userData', sc.userData);
    if (sc.fakeInstall) patchInstall(sc);
    // S19d: what main answers on every plugins-* channel, as the renderer receives it (window.api is read-only, so the page cannot be wrapped)
    globalThis.__ipcOut = [];
    const { ipcMain } = require('electron');
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, fn) => origHandle(channel, async (...a) => {
      const r = await fn(...a);
      if (/^plugins-/.test(channel)) globalThis.__ipcOut.push(JSON.stringify([channel, r]));
      return r;
    });
    require(path.join(REPO, 'main.js'));
    await app.whenReady();
    let win = null;
    for (let i = 0; i < 300 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.filesList)', true).catch(() => false))) win = null;
      if (!win) await sleep(100);
    }
    if (!win) throw new Error('renderer never became ready');
    const run = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
    await run("window.__payloads = []; window.__pushes = 0; window.P = (n, v) => { window.__payloads.push(JSON.stringify([n, v])); return v; };"
      + ' if (window.api.onPluginsChanged) window.api.onPluginsChanged(() => { window.__pushes++; });');
    const ctx = { fs, countFile: sc.countFile, ipcOut: () => globalThis.__ipcOut, installLoads: () => globalThis.__installLoads || 0, installOpts: () => globalThis.__installOpts || null,
      // S19b: the native folder dialog, replaced in-process (plugin-install.js reads dialog.showOpenDialog at call time); null = canceled
      stubDialog: (p) => { require('electron').dialog.showOpenDialog = async () => (p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }); },
      // A report frame runs no script (plugin CSP, script-src 'none'): main reads WHICH report it shows (the <title> of the deckpage: sub-frame,
      // read through WebFrameMain, which the page CSP does not bind) and mirrors one entry per mounted frame URL into window.__marks.
      startMarks: () => {
        let lastUrl = '', busy = false;
        const timer = setInterval(async () => {
          if (busy) return;
          busy = true;
          try {
            const f = win.webContents.mainFrame.framesInSubtree.find((x) => x.url.startsWith('deckpage://'));
            if (f && f.url !== lastUrl) {
              const title = await f.executeJavaScript('document.title');
              if (title) { lastUrl = f.url; await win.webContents.executeJavaScript(`window.__marks.push(${JSON.stringify(title)})`); }
            }
          } catch (_) { /* frame gone or still navigating: the next tick reads again */ }
          busy = false;
        }, 50);
        timer.unref();
        ctx.stopMarks = () => clearInterval(timer);
        return true;
      } };
    for (const s of sc.steps) {
      if (s.op === 'sleep') await sleep(s.ms);
      else if (s.op === 'shot') { // diagnostic only (PLUGIN_HOST_SHOTS=<dir>): the Plugins panel as pixels, never a gate
        const r = await run("const b = document.getElementById('plugin-panel').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };");
        await sleep(500); // the compositor needs a frame or capturePage hands back the previous one
        win.webContents.invalidate();
        await sleep(300);
        fs.writeFileSync(s.file, (await win.webContents.capturePage(r)).toPNG());
      }
      else if (s.op === 'tclick') { // AMD-4: a TRUSTED mouse click at the centre of the element (never .click() through executeJavaScript)
        const c = await run(`const b = document.querySelector(${JSON.stringify(s.sel)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await sleep(900); // the 900 ms entrance timer of the overlay
        if (s.expectOpen) { const o = await run('return plg.open;'); if (o !== true) throw new Error(`tclick ${s.sel}: plg.open is ${o}`); }
      }
      else if (s.op === 'tkey') { // AMD-4: a TRUSTED key press into the page
        win.webContents.focus();
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: s.key });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: s.key });
        await sleep(s.ms || 300);
      }
      else if (s.op === 'eval') out.results[s.as] = await run(s.code);
      else if (s.op === 'main') out.results[s.as] = await new Function('ctx', `return (async () => { ${s.code} })()`)(ctx);
      else if (s.op === 'waitFor') {
        const end = Date.now() + (s.ms || 15000);
        let ok = false;
        while (!ok && Date.now() < end) { ok = Boolean(await run(s.code)); if (!ok) await sleep(150); }
        if (!ok) throw new Error(`waitFor timed out: ${s.as}`);
      }
    }
    if (ctx.stopMarks) ctx.stopMarks();
    out.results.payloads = await run('return window.__payloads;');
  } catch (err) { out.error = String(err && err.message).slice(0, 300); }
  done(out.error ? 1 : 0);
}

const SECOND_DIR = () => { // a valid plugin folder the fake install "imports"
  const parent = path.join(TMP, 'src-second');
  return installFixture(parent, { id: 'second', label: 'Second', env: [{ name: 'SEC_TOKEN', label: 'Jeton second', required: false, hints: ['RSH', 'OTHER'] }] });
};

// Scenario A: a ready daily plugin over three boots (new date -> 1 run; same date -> 0; then run-now and the IPC surface).
async function scenarioA() {
  const R = bootRig('a');
  installFixture(R.pluginsDir);
  const reports = require(path.join(SRC, 'plugin-reports.js')).create(path.join(R.userData, 'plugin-data'), () => Date.parse(R.seedAt));
  for (const [at, bytes] of [['2026-10-25T08:00:00', 40], ['2026-11-01T08:00:00', 1100 * 1024]]) { // 9 days and 2 days before the boots
    R.seedAt = at;
    const e = reports.newEntry('fake', 'manual');
    fs.writeFileSync(e.reportPath, '<!doctype html><title>x</title>' + 'y'.repeat(bytes));
    reports.finishEntry('fake', e.stem, { exit: 0 });
  }
  fs.writeFileSync(R.statePath, JSON.stringify({ fake: { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 30, envMap: { FAKE_TOKEN: 'RSH_MAPPED_TOKEN' } } }));
  const out = { R };
  out.b1 = await runBoot(R, [WAIT_LISTED, finishedToday(1),
    ev('list', "return P('list', await window.api.pluginsList());"),
    ev('retention', "return P('set-retention', await window.api.pluginsSetRetention('fake', 3));"),
    ev('envmap', "return P('set-env-map', await window.api.pluginsSetEnvMap('fake', { FAKE_TOKEN: 'RSH_MAPPED_TOKEN', FAKE_OPT: 'RSH_OTHER_SECRET' }));")]);
  out.afterB1 = { counts: R.counts(), state: R.state(), sidecars: R.sidecars() };
  out.b2 = await runBoot(R, [WAIT_LISTED, { op: 'sleep', ms: 800 },
    ev('list', "return P('list', await window.api.pluginsList());"),
    ev('history', "return P('history', await window.api.pluginsHistory('fake', { days: 30 }));"),
    ev('badRetention', "return P('set-retention', await window.api.pluginsSetRetention('fake', 0));"),
    ev('badArgs', "const r = []; r.push(await window.api.pluginsSetEnabled(42, true)); r.push(await window.api.pluginsSetEnabled('fake', 'yes')); r.push(await window.api.pluginsHistory(7)); r.push(await window.api.pluginsOpenReport('../x', 'y')); r.push(await window.api.pluginsReadLog('fake', '../../x')); return r;")]);
  out.afterB2 = { counts: R.counts(), state: R.state() };
  const importFrom = SECOND_DIR();
  out.b3 = await runBoot(R, [WAIT_LISTED,
    { op: 'main', as: 'installLoadsBefore', code: 'return ctx.installLoads();' },
    ev('access', "return P('access', await window.api.pluginsAccess('fake'));"),
    ev('detect', "return P('detect', await window.api.pluginsDetect({ id: 'fake' }));"),
    ev('runNow', "return P('run-now', await window.api.pluginsRunNow('fake'));"),
    finishedToday(2),
    ev('history', "return P('history', await window.api.pluginsHistory('fake', { days: 1 }));"),
    ev('openLatest', "const h = await window.api.pluginsHistory('fake', { days: 1 }); return P('open-report', await window.api.pluginsOpenReport('fake', h[0].stem));"),
    ev('readLog', "const h = await window.api.pluginsHistory('fake', { days: 1 }); return P('read-log', await window.api.pluginsReadLog('fake', h[0].stem));"),
    ev('openBig', "return P('open-report', await window.api.pluginsOpenReport('fake', '2026-11-01T0800'));"),
    ev('openMissing', "return P('open-report', await window.api.pluginsOpenReport('fake', '2026-01-01T0000'));"),
    ev('pick', "return P('pick', await window.api.pluginsPick());"),
    ev('detectToken', "return P('detect', await window.api.pluginsDetect({ token: 'tok1' }));"),
    ev('pushesBefore', 'return window.__pushes;'),
    ev('import', "return P('import', await window.api.pluginsImport('tok1', { replace: false, envMap: {} }));"),
    ev('listAfterImport', "return (await window.api.pluginsList()).map((r) => r.id);"),
    ev('deleteCard', "return P('delete-card', await window.api.pluginsDeleteCard('second'));"),
    ev('deleteSecond', "return P('delete', await window.api.pluginsDelete('second'));"),
    ev('listAfterDelete', "return (await window.api.pluginsList()).map((r) => r.id);"),
    { op: 'sleep', ms: 300 },
    ev('pushesAfter', 'return window.__pushes;'),
    { op: 'main', as: 'installOptKeys', code: 'const o = ctx.installOpts(); return o ? Object.keys(o).sort() : null;' },
  ], { fakeInstall: true, importFrom });
  out.afterB3 = { counts: R.counts(), sidecars: R.sidecars() };
  return out;
}

// Scenario B: the same plugin, required slot not mapped -> never runs, "À configurer".
async function scenarioB() {
  const R = bootRig('b');
  installFixture(R.pluginsDir);
  fs.writeFileSync(R.statePath, JSON.stringify({ fake: { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 30, envMap: {} } }));
  const b1 = await runBoot(R, [WAIT_LISTED, { op: 'sleep', ms: 800 },
    ev('list', "return P('list', await window.api.pluginsList());"),
    ev('runNow', "return P('run-now', await window.api.pluginsRunNow('fake'));"),
    ev('access', "return P('access', await window.api.pluginsAccess('fake'));")]);
  return { R, b1, counts: R.counts(), state: R.state(), sidecars: R.sidecars() };
}

// Scenario D (D1 at boot level): no plugins dir at all -> the Deck boots, lists nothing, calls no shell, writes nothing.
async function scenarioD() {
  const R = bootRig('d');
  const b1 = await runBoot(R, [{ op: 'sleep', ms: 1500 }, ev('list', "return P('list', await window.api.pluginsList());"),
    ev('history', "return P('history', await window.api.pluginsHistory('fake', { days: 30 }));"),
    ev('runNow', "return P('run-now', await window.api.pluginsRunNow('fake'));"),
    // S19: the Plugins tab with nothing installed (D1) — opened through the real tab button
    uiEv('btnInfo', "const b = $q('#plugin-toggle'); return { exists: !!b, title: b && b.title, aria: b && b.getAttribute('aria-label'), text: b && b.textContent.trim() };"),
    OPEN_BTN,
    uiWait('emptyShown', "$q('#plg-empty') && !$q('#plg-empty').hidden"),
    uiEv('empty', "return { open: plg.open, overlay: $q('#plugin-panel').classList.contains('open'), hostHidden: $q('#plugin-panel').hidden, emptyText: $q('#plg-empty').textContent, rows: document.querySelectorAll('#plg-list .plg-row').length, frames: document.querySelectorAll('#plugin-panel iframe').length, importText: ($q('#plg-import') || {}).textContent, seam: typeof window.plg };"),
    ...shots('plugins-empty.png')]);
  return { R, b1, counts: R.counts(), written: fs.readdirSync(R.userData).filter((n) => /^plugin/.test(n)), pluginsDirMade: fs.existsSync(R.pluginsDir) };
}

// Scenario C: two Deck instances. Boot 1 starts a long run and quits; boot 2 (a later day) finds it alive; then it is killed.
async function scenarioC() {
  const R = bootRig('c');
  installFixture(R.pluginsDir, { argv: ['run.py', '0', '60'] });
  fs.writeFileSync(R.statePath, JSON.stringify({ fake: { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 30, envMap: { FAKE_TOKEN: 'RSH_MAPPED_TOKEN' } } }));
  const out = { R };
  let pid = null;
  try {
    out.b1 = await runBoot(R, [{ op: 'waitFor', as: 'running', code: "return (await window.api.pluginsList()).some((r) => r.running === true);" }]);
    out.afterB1 = { counts: R.counts(), sidecars: R.sidecars() };
    pid = (out.afterB1.sidecars[0] || {}).pid;
    out.aliveAfterB1 = Number.isInteger(pid) && (() => { try { process.kill(pid, 0); return true; } catch (_) { return false; } })();
    out.b2 = await runBoot(R, [WAIT_LISTED, { op: 'sleep', ms: 800 },
      ev('list', "return P('list', await window.api.pluginsList());"),
      ev('runNow', "return P('run-now', await window.api.pluginsRunNow('fake'));"),
      ev('delete', "return P('delete', await window.api.pluginsDelete('fake'));"),
      { op: 'main', as: 'installLoads', code: 'return ctx.installLoads();' }], { now: '2026-11-04T09:00:00', fakeInstall: true });
    out.afterB2 = { counts: R.counts() };
    // the delete of boot 2 stopped the survivor, then removed the plugin: the process is gone and so is the folder
    out.aliveAfterB2 = Number.isInteger(pid) && (() => { try { process.kill(pid, 0); return true; } catch (_) { return false; } })();
    out.dirAfterB2 = fs.existsSync(path.join(R.pluginsDir, 'fake'));
    if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); await sleep(100); } catch (_) { break; } }
    installFixture(R.pluginsDir, { argv: ['run.py', '0', '60'] }); // boot 3 still finds the plugin its stopped entry belongs to
    const st = R.state();
    // disabled, so boot 3 starts no new automatic run: the stopped entry stays the newest
    st.fake = { lastAutoDate: '2026-11-02', retentionDays: 30, envMap: { FAKE_TOKEN: 'RSH_MAPPED_TOKEN' }, ...(st.fake || {}), enabled: false };
    fs.writeFileSync(R.statePath, JSON.stringify(st));
    // disabled: the shell is never read, so `ready` stays null; the scan alone says the startup got past its first step
    out.b3 = await runBoot(R, [{ op: 'waitFor', as: 'scanned', code: 'return (await window.api.pluginsList()).length === 1;' }, { op: 'sleep', ms: 800 },
      ev('list', "return P('list', await window.api.pluginsList());"),
      ev('history', "return P('history', await window.api.pluginsHistory('fake', { days: 30 }));")], { now: '2026-11-04T09:30:00' });
    out.afterB3 = { counts: R.counts() };
  } finally {
    if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
  }
  return out;
}

// Scenario E (S19 UI): three disabled plugins - `fake` (ready once the shell is read), `unready` (a required slot unmapped) and
// `xss` (markup in its label and description). The panel is driven through its real buttons; boot 2 proves the switch survives.
const MARKUP_LABEL = '<b id="pwn">Gras</b>';
const MARKUP_DESC = '<img src=x onerror="window.__pwn=1">';
async function scenarioE() {
  const R = bootRig('e');
  installFixture(R.pluginsDir);
  installFixture(R.pluginsDir, { id: 'unready', label: 'Plugin non prêt', env: [{ name: 'NEED_TOKEN', label: 'Jeton manquant', required: true, hints: ['NEED', 'TOKEN'] }] });
  installFixture(R.pluginsDir, { id: 'xss', label: MARKUP_LABEL, description: MARKUP_DESC, env: [] });
  fs.writeFileSync(R.statePath, JSON.stringify({ fake: { enabled: false, lastAutoDate: '2026-11-02', retentionDays: 30, envMap: { FAKE_TOKEN: 'RSH_MAPPED_TOKEN' } } }));
  const out = { R };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 3;' },
    uiEv('btnInfo', "const b = $q('#plugin-toggle'); return { exists: !!b, title: b && b.title, aria: b && b.getAttribute('aria-label') };"),
    OPEN_BTN,
    uiWait('rows', "document.querySelectorAll('#plg-list .plg-row').length === 3"),
    // the list page (nothing shown yet), then each detail head: the row holds « Lancer », the head « Lancer maintenant »
    uiEv('rows0', "const rows = snap(); const z = { rows, page: $q('#plugin-panel').dataset.page, open: plg.open, hostHidden: $q('#plugin-panel').hidden, emptyHidden: $q('#plg-empty').hidden, pwnEl: !!document.getElementById('pwn'), pwnWin: window.__pwn === undefined ? null : window.__pwn, imgs: document.querySelectorAll('#plugin-panel img').length, bolds: document.querySelectorAll('#plugin-panel b').length }; for (const x of rows) { await openDetail(x.id); x.headRun = ($q('#plg-dhead [data-act=\"run\"]') || {}).textContent; } await backToList(); return z;"),
    // D23: the shell was never read, so `unready` offers its switch (Paramètres tab, clicked before the access answer lands); the host refuses and the row says why
    uiEv('clickUnready', "await openDetail('unready'); goTab('settings'); $q('#plg-set-switch').click(); return true;"),
    uiWait('refused', "rowOf('unready').note.includes('Accès requis manquant') && rowOf('unready').status.includes('À configurer') && sw() && sw().dis === true"),
    uiEv('rows1', "const rows = snap(); const u = rows.find((x) => x.id === 'unready'); u.swDis = sw().dis; u.sw = sw().on; return rows;"),
    // D3: the switch re-enables a ready plugin
    uiEv('clickFake', "await openDetail('fake'); goTab('settings'); $q('#plg-set-switch').click(); return true;"),
    uiWait('enabled', "rowOf('fake').on === 'true' && sw() && sw().on === 'true'"),
    uiEv('rows2', "const rows = snap(); const f = rows.find((x) => x.id === 'fake'); f.sw = sw().on; return rows;"),
    { op: 'sleep', ms: 300 },
    // « Lancer » on the list row: the exit push refreshes the row; the latest report mounts once the detail opens on its Rapport tab
    uiEv('clickRun', "await backToList(); rowEl('fake').querySelector('.plg-run').click(); return true;"),
    uiWait('reportedRow', "/^Dernier rapport/.test(rowOf('fake').status)", 25000),
    uiEv('openFake', "return await openDetail('fake');"),
    uiWait('reported', "/^Dernier rapport/.test(rowOf('fake').status) && $q('#plg-view iframe')", 25000),
    uiEv('frame', "const f = $q('#plg-view iframe'); return { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), title: f.title, count: document.querySelectorAll('#plugin-panel iframe').length, inView: !!f.closest('#plg-view'), row: rowOf('fake') };"),
    ...shots('plugins-report.png'),
    uiEv('pick', "return await openDetail('xss');"),
    uiWait('picked', "rowOf('xss').current === 'true'"),
    uiEv('afterPick', "return { rows: snap(), frames: document.querySelectorAll('#plugin-panel iframe').length, view: $q('#plg-view').textContent };"),
    uiEv('afterClose', "$q('#plg-close').click(); const f = document.querySelectorAll('#plugin-panel iframe').length; return { frames: f, open: plg.open };"),
  ]);
  out.afterB1 = { counts: R.counts(), state: R.state(), sidecars: R.sidecars() };
  out.b2 = await runBoot(R, [WAIT_LISTED,
    OPEN_BTN,
    uiWait('rows', "document.querySelectorAll('#plg-list .plg-row').length === 3"),
    uiEv('rows', "const rows = snap(); for (const id of ['fake', 'unready']) { await openDetail(id); goTab('settings'); const s = sw(); const x = rows.find((r) => r.id === id); x.swDis = s.dis; x.sw = s.on; } await backToList(); return rows;"),
    { op: 'sleep', ms: 800 }], { now: '2026-11-03T09:30:00' }); // K1: boot 1's manual report of today satisfies the daily rule, so no second run
  out.afterB2 = { counts: R.counts() };
  return out;
}

// Scenario F (S19 UI): a latest report over 1 MiB -> one refusal line and no frame; failed and interrupted runs read in the status.
async function scenarioF() {
  const R = bootRig('f');
  for (const id of ['fake', 'fail', 'intr']) installFixture(R.pluginsDir, { id, label: `Plugin ${id}`, env: [] });
  const reports = require(path.join(SRC, 'plugin-reports.js')).create(path.join(R.userData, 'plugin-data'), () => Date.parse(R.seedAt));
  R.seedAt = '2026-11-01T08:00:00';
  const big = reports.newEntry('fake', 'manual');
  fs.writeFileSync(big.reportPath, '<!doctype html><title>x</title>' + 'y'.repeat(1100 * 1024));
  reports.finishEntry('fake', big.stem, { exit: 0 });
  R.seedAt = '2026-11-01T09:00:00';
  const failed = reports.newEntry('fail', 'manual');
  reports.finishEntry('fail', failed.stem, { exit: 3 });
  R.seedAt = '2026-11-01T10:00:00';
  reports.newEntry('intr', 'auto'); // never finished: exit null, no live pid -> « Interrompu »
  const HEAD = "const $ = (id) => document.getElementById(id); const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };";
  const out = { R };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 3;' },
    OPEN_BTN,
    uiWait('rows', "document.querySelectorAll('#plg-list .plg-row').length === 3"),
    uiEv('openFake', "return await openDetail('fake');"),
    uiWait('refusal', "$q('#plg-view') && /volumineux/.test($q('#plg-view').textContent)"),
    uiEv('big', "return { rows: snap(), frames: document.querySelectorAll('#plugin-panel iframe').length, view: $q('#plg-view').textContent, current: rowOf('fake').current };"),
    ...shots('plugins-toolarge.png'),
    uiEv('pickFail', "return await openDetail('fail');"),
    uiWait('pickedFail', "rowOf('fail').current === 'true'"),
    uiEv('afterPick', "return { frames: document.querySelectorAll('#plugin-panel iframe').length, view: $q('#plg-view').textContent, fakeCurrent: rowOf('fake').current };"),
    // the switch of each plugin lives in its Paramètres tab
    uiEv('sws', "const out = {}; for (const x of snap()) { await openDetail(x.id); goTab('settings'); out[x.id] = sw(); } await backToList(); return out;"),
    // the head of the side panel with four tabs (opened as the Terminal tab, which needs no pane): no overflow at any width, every tab named, labels all shown or all hidden
    uiEv('heads', `${HEAD} const out = {};
      for (const w of [320, 344, 368, 392, 420, 448, 452, 456, 460, 464, 468, 472, 476, 480, 520, 620]) {
        sp.width = w; closeSidePanel(); openSidePanel('terminal'); await new Promise((r) => setTimeout(r, 250));
        const panel = box($('side-panel')), tabs = box($('sp-tabs')), head = box($('sp-head')), close = box($('sp-close')), max = box($('sp-max'));
        const labels = [...document.querySelectorAll('#sp-tabs .sp-tab')].map((t) => { const s = t.querySelector('span');
          return { tab: t.dataset.tab, title: t.getAttribute('title'), aria: t.getAttribute('aria-label'), shown: !!s && getComputedStyle(s).display !== 'none' && s.offsetWidth > 0, inTabs: t.getBoundingClientRect().right <= tabs.r + 0.5 }; });
        out[w] = { panelW: Math.round(panel.w), opened: sp.open === true && sp.tab === 'terminal' && !$('side-panel').hidden && $('side-panel').getClientRects().length > 0,
          list: [...document.querySelectorAll('.sp-tab')].map((b) => b.dataset.tab), plgIn: !!document.querySelector('#side-panel #plugin-panel'), closeIn: close.l >= panel.l && close.r <= panel.r + 0.5, maxIn: max.l >= panel.l && max.r <= panel.r + 0.5,
          tabsOverflow: $('sp-tabs').scrollWidth > $('sp-tabs').clientWidth, headOverflow: $('sp-head').scrollWidth > $('sp-head').clientWidth, tabsInHead: tabs.r <= head.r + 0.5, labels };
      }
      return out;`),
  ]);
  return out;
}

// Scenario G (S19b UI): the import and delete cards over the REAL plugin-install.js; only the native folder dialog is stubbed
// (ctx.stubDialog). Sources live outside the plugins dir: a delete must leave them byte for byte. `slow` is a long run, so its
// delete is refused by the host (D3). The expected card figures come from the filesystem, never from the IPC answer under test.
const NEW_LABEL = '<i id="pwn2">Nouveau</i>';
const NEW_DESC = '<img src=x onerror="window.__pwn2=1">';
const SCOPE_LINE = 'Ce plugin recevra uniquement les accès listés ci-dessous.';
const frBytes = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1).replace('.', ',')} Ko` : `${(n / 1048576).toFixed(1).replace('.', ',')} Mo`);
const digestDir = (root) => { // "relpath:size:sha1" of every file below root, sorted
  const out = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, n);
      if (fs.lstatSync(p).isDirectory()) walk(p);
      else out.push(`${path.relative(root, p)}:${fs.statSync(p).size}:${require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`);
    }
  })(root);
  return out;
};
const CARD_HELP = `
  const cardSnap = () => { const c = $q('#plg-card'); if (!c || c.hidden) return null;
    const t = (s) => { const n = $q(s, c); return n ? n.textContent : null; };
    const acc = $q('#plg-card-access', c);
    return { kind: c.dataset.kind, kicker: t('.plg-card-kicker'), title: t('.plg-card-title'), desc: t('.plg-card-desc'), trigger: t('.plg-card-trigger'),
      command: t('.plg-card-command'), scope: t('.plg-card-scope'), accessEmpty: !!acc && acc.childNodes.length === 0, replace: t('.plg-card-replace'),
      error: t('.plg-card-error'), impact: t('.plg-card-impact'), buttons: [...c.querySelectorAll('button')].map((b) => ({ act: b.dataset.act, text: b.textContent, dis: b.disabled })),
      pwnEl: !!document.getElementById('pwn2'), pwnWin: window.__pwn2 === undefined ? null : window.__pwn2, imgs: c.querySelectorAll('img').length, italics: c.querySelectorAll('i').length }; };
  const clickCard = (act) => { $q('#plg-card [data-act="' + act + '"]').click(); return true; };
`;
const cardEv = (as, code) => uiEv(as, CARD_HELP + code);
const cardWait = (as, cond, ms) => ({ op: 'waitFor', as, ms: ms || 15000, code: `${UI_HELP}${CARD_HELP} return Boolean(${cond});` });
const stubStep = (p) => ({ op: 'main', as: 'stub', code: `ctx.stubDialog(${JSON.stringify(p)}); return true;` });
const lsStep = (as, dir) => ({ op: 'main', as, code: `return ctx.fs.readdirSync(${JSON.stringify(dir)}).sort();` });
const existsStep = (as, p) => ({ op: 'main', as, code: `return ctx.fs.existsSync(${JSON.stringify(p)});` });
const labelStep = (as, dir) => ({ op: 'main', as, code: `return JSON.parse(ctx.fs.readFileSync(${JSON.stringify(path.join(dir, 'deck-plugin.json'))}, 'utf8')).label;` });

async function scenarioG() {
  const R = bootRig('g');
  installFixture(R.pluginsDir); // `fake`: the installed id of the replace path and of the delete path
  installFixture(R.pluginsDir, { id: 'slow', label: 'Plugin lent', env: [], argv: ['run.py', '0', '60'] });
  const srcRoot = path.join(TMP, 'src-g');
  const srcNew = installFixture(srcRoot, { id: 'newone', label: NEW_LABEL, description: NEW_DESC, trigger: 'manual', env: [] });
  const srcDup = installFixture(path.join(srcRoot, 'dup'), { id: 'fake', label: 'Plugin factice v2', description: 'Version deux.' });
  const srcBad = path.join(FIXTURES, 'invalid');
  const reports = require(path.join(SRC, 'plugin-reports.js')).create(path.join(R.userData, 'plugin-data'), () => Date.parse(R.seedAt));
  for (const [at, bytes] of [['2026-11-01T08:00:00', 40], ['2026-11-02T08:00:00', 3000]]) {
    R.seedAt = at;
    const e = reports.newEntry('fake', 'manual');
    fs.writeFileSync(e.reportPath, '<!doctype html><title>x</title>' + 'y'.repeat(bytes));
    reports.finishEntry('fake', e.stem, { exit: 0 });
  }
  fs.writeFileSync(R.statePath, JSON.stringify({
    fake: { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30, envMap: {} },
    slow: { enabled: true, lastAutoDate: '2026-11-02', retentionDays: 30, envMap: {} },
  }));
  const dataFake = path.join(R.userData, 'plugin-data', 'fake');
  const out = { R };
  out.exp = { count: R.sidecars().length, bytes: fs.readdirSync(R.reportsDir).reduce((s, n) => s + fs.statSync(path.join(R.reportsDir, n)).size, 0) };
  out.srcBefore = { dup: digestDir(srcDup), newone: digestDir(srcNew), bad: digestDir(srcBad) };
  const openCardOf = (as) => [{ op: 'sleep', ms: 100 }, uiEv(`click-${as}`, "$q('#plg-import').click(); return true;"), cardWait(as, "cardSnap()")];
  const slowPid = () => {
    try {
      const d = path.join(R.userData, 'plugin-data', 'slow', 'reports');
      for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json'))) { const j = readJson(path.join(d, f)); if (j && Number.isInteger(j.pid)) return j.pid; }
    } catch (_) { /* no entry */ }
    return null;
  };
  try {
    out.b1 = await runBoot(R, [
      { op: 'waitFor', as: 'running', code: "return (await window.api.pluginsList()).some((r) => r.id === 'slow' && r.running === true);" },
      OPEN_BTN,
      uiWait('rows', 'document.querySelectorAll("#plg-list .plg-row").length === 2'),
      // « Supprimer » lives in the detail head only: counted on each plugin's detail page, none on the list rows
      cardEv('start', "const b = $q('#plg-import'); const z = { text: b.textContent, disabled: b.disabled, host: !!$q('#plg-card'), card: cardSnap(), rowDel: document.querySelectorAll('#plg-list [data-act=\"delete\"]').length, delBtns: 0 }; for (const x of snap()) { await openDetail(x.id); z.delBtns += document.querySelectorAll('#plg-dhead [data-act=\"delete\"]').length; } await backToList(); return z;"),
      // canceled dialog: no card, no error
      stubStep(null), uiEv('clickCanceled', "$q('#plg-import').click(); return true;"), { op: 'sleep', ms: 500 },
      cardEv('afterCancelDialog', 'return { card: cardSnap(), disabled: $q("#plg-import").disabled };'),
      // a valid folder: the card shows the manifest as text; nothing is copied before the confirm
      stubStep(srcNew), ...openCardOf('cardNew'),
      cardEv('cardNew', 'return cardSnap();'),
      lsStep('lsAfterPick', R.pluginsDir),
      cardEv('cancelNew', "clickCard('card-cancel'); return true;"),
      cardWait('cancelledNew', '!cardSnap()'),
      lsStep('lsAfterCancel', R.pluginsDir),
      ...openCardOf('cardNew2'),
      cardEv('confirmNew', "clickCard('card-confirm'); return true;"),
      cardWait('importedNew', "rowEl('newone') && !cardSnap()"),
      cardEv('afterImport', 'return { rows: snap(), card: cardSnap() };'),
      lsStep('lsAfterImport', R.pluginsDir),
      ...shots('plugins-import-card.png'),
      // an invalid folder: the host's French line, nothing offered, nothing copied
      stubStep(srcBad), ...openCardOf('cardBad'),
      cardEv('cardBad', 'return cardSnap();'),
      cardEv('hostBad', 'return await window.api.pluginsPick();'),
      lsStep('lsAfterBad', R.pluginsDir),
      cardEv('closeBad', "clickCard('card-cancel'); return true;"),
      cardWait('closedBad', '!cardSnap()'),
      // an installed id: the replace prompt; cancel keeps the installed copy, confirm swaps it
      stubStep(srcDup), ...openCardOf('cardDup'),
      cardEv('cardDup', 'return cardSnap();'),
      labelStep('labelBefore', path.join(R.pluginsDir, 'fake')),
      cardEv('cancelDup', "clickCard('card-cancel'); return true;"),
      cardWait('cancelledDup', '!cardSnap()'),
      labelStep('labelAfterCancel', path.join(R.pluginsDir, 'fake')),
      ...openCardOf('cardDup2'),
      cardEv('confirmDup', "clickCard('card-confirm'); return true;"),
      cardWait('replaced', "rowEl('fake') && rowOf('fake').label === 'Plugin factice v2' && !cardSnap()"),
      cardEv('afterReplace', 'return { row: rowOf("fake") };'),
      // delete: the card says how many reports and how much; cancel removes nothing; confirm removes the copy and its data
      cardEv('ipcCard', "return await window.api.pluginsDeleteCard('fake');"),
      cardEv('clickDel', "await openDetail('fake'); $q('#plg-dhead [data-act=\"delete\"]').click(); return true;"),
      cardWait('cardDel', "cardSnap() && cardSnap().kind === 'delete'"),
      cardEv('cardDel', 'return cardSnap();'),
      ...shots('plugins-delete-card.png'),
      existsStep('dirBeforeDel', path.join(R.pluginsDir, 'fake')), existsStep('dataBeforeDel', dataFake),
      cardEv('cancelDel', "clickCard('card-cancel'); return true;"),
      cardWait('cancelledDel', '!cardSnap()'),
      existsStep('dirAfterCancelDel', path.join(R.pluginsDir, 'fake')), existsStep('dataAfterCancelDel', dataFake),
      cardEv('clickDel2', "await openDetail('fake'); $q('#plg-dhead [data-act=\"delete\"]').click(); return true;"),
      cardWait('cardDel2', "cardSnap() && cardSnap().kind === 'delete'"),
      cardEv('confirmDel', "clickCard('card-confirm'); return true;"),
      cardWait('deleted', "!rowEl('fake') && !cardSnap()"),
      existsStep('dirAfterDel', path.join(R.pluginsDir, 'fake')), existsStep('dataAfterDel', dataFake),
      // a plugin that is running: the host stops it first (5 s grace + 2 s at most), then removes it; the card closes, the row and the folder go
      cardEv('clickDelSlow', "await openDetail('slow'); $q('#plg-dhead [data-act=\"delete\"]').click(); return true;"),
      cardWait('cardSlow', "cardSnap() && cardSnap().kind === 'delete'"),
      cardEv('confirmSlow', "clickCard('card-confirm'); return true;"),
      cardWait('slowDeletedWait', "!rowEl('slow') && !cardSnap()", 15000),
      cardEv('slowDeleted', 'return { card: cardSnap(), row: !!rowEl("slow") };'),
      existsStep('dirSlowAfter', path.join(R.pluginsDir, 'slow')),
    ]);
    out.after = { state: R.state(), dirs: fs.readdirSync(R.pluginsDir).sort(), srcAfter: { dup: digestDir(srcDup), newone: digestDir(srcNew), bad: digestDir(srcBad) } };
  } finally {
    const pid = slowPid();
    if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
  }
  return out;
}

const RUNS = {};
const settled =(p) => p.catch((err) => ({ fatal: String(err && err.stack).slice(0, 300) }));
const ok2 = (t, boot, label) => t.ok(boot && boot.error === null, `${label}: boot ran (${boot && boot.error})`);

gate('g13 D4 page-scheme: slot "plugin" stores a page (token url), > 1 MiB -> tooLarge, other slots unaffected', async (t) => {
  const P = require(path.join(SRC, 'page-scheme.js'));
  const a = P.putPage('plugin', '<p>ok</p>');
  t.ok(a.ok === true && /^deckpage:\/\/page\/[0-9a-f-]{36}$/.test(a.url), `plugin slot url (${JSON.stringify(a)})`);
  const big = P.putPage('plugin', 'x'.repeat(1100 * 1024));
  t.ok(big.ok === false && big.error === 'tooLarge', `1.1 MB -> tooLarge (${JSON.stringify(big)})`);
  const b = P.putPage('plugin', '<p>second</p>');
  t.ok(b.ok === true && b.url !== a.url, 'a new serve replaces the token');
  const f = P.putPage('files', '<p>f</p>');
  t.ok(f.ok === true && P.putPage('nope', 'x').error === 'badSlot', 'files slot works, unknown slot refused');
});

gate('g14 wiring (static): preload mirrors every channel, install required at the top of the IPC layer, quit path untouched (option B), no flags constant', async (t) => {
  const ipcSrc = readTextOrEmpty(path.join(SRC, 'ipc', 'plugins.js'));
  const preload = readTextOrEmpty(path.join(REPO, 'preload.js'));
  const main = readTextOrEmpty(path.join(REPO, 'main.js'));
  const windowSrc = readTextOrEmpty(path.join(SRC, 'window.js'));
  for (const c of [...CHANNELS, 'plugins-changed']) {
    const own = WINDOW_PUSH.includes(c) ? ['window.js', windowSrc] : ['ipc/plugins.js', ipcSrc];
    t.ok(own[1].includes(`'${c}'`), `${own[0]} holds ${c}`);
    t.ok(preload.includes(`'${c}'`), `preload.js mirrors ${c}`);
  }
  t.ok(/registerPluginsIpc\(/.test(main) && /startPlugins\(/.test(main), 'main.js registers and starts the plugin host');
  t.ok(!/plugin-install/.test(main) && /^const .*require\(\s*'\.\.\/plugin-install'\s*\)/m.test(ipcSrc) && !/E_INSTALL|withInstall/.test(ipcSrc), 'plugin-install.js: one top-level require in the IPC layer, no missing-module answer');
  t.ok(main.includes("app.on('before-quit', () => { killAll(); killAllPanelTerms(); });"), 'before-quit does not touch plugin children');
  const cfg = require(path.join(SRC, 'config.js'));
  t.ok(!('PLUGIN_SHELL_FLAGS' in cfg) && !/shellFlags/.test(main) && !/shellFlags/.test(ipcSrc), 'no shell-flags constant in config.js, none passed by main.js or read by the IPC layer (-ic is fixed at the two spawn sites)');
});

gate('g15 D2 D15 D3 D17 D19: new date + ready fixture -> 1 spawn + 1 entry; reboot same date -> 0; settings persist; run-now -> 1 more', async (t) => {
  const A = await RUNS.A;
  t.ok(!A.fatal, `scenario A ran (${A.fatal})`);
  if (A.fatal) return;
  ok2(t, A.b1, 'boot 1'); ok2(t, A.b2, 'boot 2'); ok2(t, A.b3, 'boot 3');
  const today = A.afterB1.sidecars.filter((s) => s.stem.startsWith('2026-11-03'));
  t.ok(A.afterB1.counts.run === 1 && today.length === 1 && today[0].exit === 0 && today[0].trigger === 'auto', `boot 1: 1 spawn, 1 auto entry exit 0 (${JSON.stringify(A.afterB1.counts)}, ${today.length})`);
  t.ok(A.afterB1.state.fake.lastAutoDate === '2026-11-03', 'boot 1: claim persisted');
  t.ok(A.afterB2.counts.run === 1, `boot 2 (same date): 0 more spawn (${JSON.stringify(A.afterB2.counts)})`);
  const l2 = (A.b2.results.list || [])[0] || {};
  t.ok(l2.enabled === true && l2.retentionDays === 3 && l2.envMap && l2.envMap.FAKE_TOKEN === 'RSH_MAPPED_TOKEN' && l2.envMap.FAKE_OPT === 'RSH_OTHER_SECRET', `enabled / retention / envMap survive the reboot (${JSON.stringify(l2)})`);
  t.ok(l2.ready === true && l2.status === null, 'ready plugin: no "À configurer"');
  const stems2 = (A.b2.results.history || []).map((e) => e.stem);
  t.ok(!stems2.includes('2026-10-25T0800') && stems2.includes('2026-11-01T0800'), `D17: retention 3 pruned the 9-day-old entry at start, kept the 2-day-old one (${stems2})`);
  t.ok((A.b3.results.runNow || {}).ok === true && A.afterB3.counts.run === 2, `run-now -> 1 more spawn (${JSON.stringify(A.b3.results.runNow)}, ${JSON.stringify(A.afterB3.counts)})`);
  const h = A.b3.results.history || [];
  t.ok(h.length === 2 && h.every((e) => e.exit === 0 && e.hasLog), `D15: two entries today, each with its log (${h.length})`);
  t.ok(A.b2.results.badRetention && A.b2.results.badRetention.error === E_RETENTION, 'IPC: retention 0 refused with the French line');
  const bad = A.b2.results.badArgs || [];
  t.ok(bad.length === 5 && bad[0].ok === false && bad[1].ok === false && Array.isArray(bad[2]) && bad[3].ok === false && bad[4].ok === false, `malformed IPC args answer, never throw (${JSON.stringify(bad)})`);
});

gate('g16 D4 D20 + fold v4.3 #2 #9: report slot through IPC, detect / access carry names only, gate a2 on every payload incl. read-log', async (t) => {
  const A = await RUNS.A;
  if (A.fatal) { t.ok(false, `scenario A (${A.fatal})`); return; }
  const r = A.b3.results;
  t.ok(r.openLatest && r.openLatest.ok === true && /^deckpage:\/\/page\//.test(r.openLatest.url), `plugins-open-report: valid report -> token url (${JSON.stringify(r.openLatest)})`);
  t.ok(r.openBig && r.openBig.ok === false && r.openBig.error === 'tooLarge', `plugins-open-report: 1.1 MB entry -> tooLarge (${JSON.stringify(r.openBig)})`);
  t.ok(r.openMissing && r.openMissing.ok === false && r.openMissing.error !== 'tooLarge', 'plugins-open-report: unknown stem -> refusal');
  t.ok(r.readLog && r.readLog.ok === true && /fake-plugin-stdout/.test(r.readLog.text) && /fake-plugin-stderr/.test(r.readLog.text), `plugins-read-log: the plugin's own output (${String(JSON.stringify(r.readLog)).slice(0, 120)})`);
  const d = r.detect || {};
  const tok = (d.rows || []).find((x) => x.name === 'FAKE_TOKEN') || {};
  t.ok(d.ok === true && Array.isArray(d.rows) && d.rows.length === 2 && (tok.candidates || []).includes('RSH_MAPPED_TOKEN'), `plugins-detect({id}): rows with the candidate NAME (${JSON.stringify(d).slice(0, 200)})`);
  const a = r.access || {};
  t.ok(a.ok === true && (a.rows || []).every((x) => sameJson(Object.keys(x).sort(), ['candidates', 'hints', 'label', 'mapped', 'name', 'required', 'status'])), `plugins-access: rows hold names + statuses only (${(a.rows || []).map((x) => Object.keys(x).join(',')).join(' | ')})`);
  t.ok((a.rows || []).find((x) => x.name === 'FAKE_TOKEN').status === 'présente' && a.ready === true, 'plugins-access: mapped + exported -> présente');
  const all = JSON.stringify([A.b1.results, A.b2.results, A.b3.results]);
  t.ok(r.payloads && r.payloads.length >= 12, `payloads captured (${r.payloads && r.payloads.length})`);
  for (const secret of RC_SECRETS) t.ok(!all.includes(secret), `a2: 0 hit of a fake rc secret in the IPC payloads (${secret.slice(0, 14)}…)`);
  const files = fs.readdirSync(A.R.reportsDir).map((f) => fs.readFileSync(path.join(A.R.reportsDir, f), 'utf8')).join('\n');
  t.ok(RC_SECRETS.every((s) => !files.includes(s)), 'a2: the rc output reached no log, report or sidecar');
});

gate('g17 D23: unready plugin (required slot unmapped) -> 0 spawn, "À configurer", run-now refused, no claim', async (t) => {
  const B = await RUNS.B;
  if (B.fatal) { t.ok(false, `scenario B (${B.fatal})`); return; }
  ok2(t, B.b1, 'boot');
  const row = (B.b1.results.list || [])[0] || {};
  t.ok(B.counts.run === 0 && B.sidecars.length === 0, `0 spawn, 0 entry (${JSON.stringify(B.counts)}, ${B.sidecars.length})`);
  t.ok(B.counts.list >= 1 && row.ready === false && row.status === 'À configurer', `listed, ready false, status "À configurer" (${JSON.stringify(row).slice(0, 160)})`);
  t.ok(B.state.fake.lastAutoDate === '2026-11-02', 'no claim');
  const rn = B.b1.results.runNow || {};
  t.ok(rn.ok === false && /^Accès requis manquant : Jeton factice/.test(rn.error), `run-now refused (${rn.error})`);
  const ac = B.b1.results.access || {};
  t.ok(ac.ok === true && ac.ready === false && (ac.rows || []).find((x) => x.name === 'FAKE_TOKEN').status === 'introuvable', 'plugins-access: slot unmapped -> introuvable');
});

gate('g18 fold v4.3 #3 D3: two instances - boot 2 sees the live pid (running, no auto run, run-now refused, delete stops it then removes it); pid dead -> stopped entry', async (t) => {
  const C = await RUNS.C;
  if (C.fatal) { t.ok(false, `scenario C (${C.fatal})`); return; }
  ok2(t, C.b1, 'boot 1'); ok2(t, C.b2, 'boot 2'); ok2(t, C.b3, 'boot 3');
  t.ok(C.afterB1.counts.run === 1 && C.afterB1.sidecars[0].exit === null && C.aliveAfterB1 === true, `boot 1 started a long run that outlives the Deck (${JSON.stringify(C.afterB1.counts)}, alive ${C.aliveAfterB1})`);
  const l = (C.b2.results.list || [])[0] || {};
  t.ok(l.running === true, 'boot 2: plugins-list says running');
  t.ok(C.afterB2.counts.run === 1, `boot 2 (a later day): no automatic run (${JSON.stringify(C.afterB2.counts)})`);
  t.ok(C.b2.results.runNow && C.b2.results.runNow.ok === false && C.b2.results.runNow.error === E_RUNNING, `run-now refused (${JSON.stringify(C.b2.results.runNow)})`);
  t.ok(C.b2.results.delete && C.b2.results.delete.ok === true && C.aliveAfterB2 === false && C.dirAfterB2 === false, `S8b isRunning bound to the runner and the plugin descriptor: delete stops the survivor, then removes the plugin (${JSON.stringify(C.b2.results.delete)}, alive ${C.aliveAfterB2}, dir ${C.dirAfterB2})`);
  const l3 = (C.b3.results.list || [])[0] || {};
  const h3 = C.b3.results.history || [];
  t.ok(l3.running === false && h3.length === 1 && h3[0].exit === null && h3[0].stopped === true, `boot 3 (pid dead): not running, the entry is left with exit null and stopped = "Arrêté" (${JSON.stringify(h3)})`);
  t.ok(C.afterB3.counts.run === 1, 'still one launch in total');
});

gate('g19 S8b seam: install built lazily with the contract keys; import / delete rescan the list and push plugins-changed', async (t) => {
  const A = await RUNS.A;
  if (A.fatal) { t.ok(false, `scenario A (${A.fatal})`); return; }
  const r = A.b3.results;
  t.ok(r.installLoadsBefore === 1, `plugin-install.js required once, by the IPC layer, before the first pick (${r.installLoadsBefore})`);
  const keys = r.installOptKeys || [];
  t.ok(['dataRoot', 'isRunning', 'pluginsDir', 'stats', 'statePath', 'validateManifest'].every((k) => keys.includes(k)), `create() holds the contract keys (${JSON.stringify(keys)})`);
  t.ok(r.deleteCard && r.deleteCard.ok === true && r.deleteCard.count === 3, 'plugins-delete-card delegates (card data for the delete screen)');
  t.ok(r.pick && r.pick.ok === true && r.pick.token === 'tok1', 'plugins-pick delegates');
  const d = r.detectToken || {};
  t.ok(d.ok === true && ((d.rows || [])[0] || {}).name === 'SEC_TOKEN' && (d.rows[0].candidates || []).includes('RSH_OTHER_SECRET'), `plugins-detect({token}) uses manifestForToken (${JSON.stringify(d).slice(0, 160)})`);
  t.ok(r.import && r.import.ok === true && r.listAfterImport.includes('second'), `import -> rescan -> listed without a reboot (${JSON.stringify(r.listAfterImport)})`);
  t.ok(r.deleteSecond && r.deleteSecond.ok === true && !r.listAfterDelete.includes('second'), `delete -> rescan -> gone (${JSON.stringify(r.listAfterDelete)})`);
  t.ok(r.pushesAfter - r.pushesBefore >= 2, `plugins-changed pushed after import and delete (${r.pushesBefore} -> ${r.pushesAfter})`);
});

gate('g20 D1 at boot level: no plugin -> empty list, no shell call, nothing written under userData, no plugins dir made', async (t) => {
  const D = await RUNS.D;
  if (D.fatal) { t.ok(false, `scenario D (${D.fatal})`); return; }
  ok2(t, D.b1, 'boot');
  t.ok(Array.isArray(D.b1.results.list) && D.b1.results.list.length === 0 && Array.isArray(D.b1.results.history) && D.b1.results.history.length === 0, 'plugins-list and plugins-history are empty arrays');
  t.ok(D.b1.results.runNow && D.b1.results.runNow.ok === false, `run-now of an unknown plugin refused (${JSON.stringify(D.b1.results.runNow)})`);
  t.ok(D.counts.run === 0 && D.counts.list === 0, `no shell call (${JSON.stringify(D.counts)})`);
  t.ok(D.written.length === 0 && D.pluginsDirMade === false, `nothing written (${D.written}, plugins dir made: ${D.pluginsDirMade})`);
});

// ---- S19: the Plugins side tab -------------------------------------------------------------------------------
const PANEL_JS = path.join(REPO, 'renderer', 'js', 'plugin-panel.js');
const TAB_TITLES = ['Fichiers', 'Git', 'Plans', 'Terminal'];
const cssRulesOf = (css, re) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => re.test(m[1])).map((m) => `${m[1].trim()} { ${m[2].trim()} }`);

gate('g21 S19 + AMD-4 wiring (static): header button, workspace overlay, no side tab, one onPluginsChanged listener in boot.js, text-only DOM, sandbox exactly allow-scripts, no left accent bar', async (t) => {
  const panelSrc = readTextOrEmpty(PANEL_JS);
  const panel = panelSrc.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''); // code only: a comment may name what the code avoids
  const boot =readTextOrEmpty(path.join(REPO, 'renderer', 'js', 'boot.js'));
  const side = readTextOrEmpty(path.join(REPO, 'renderer', 'js', 'side-panel.js'));
  const src = (n) => readTextOrEmpty(path.join(REPO, 'renderer', 'js', n));
  const html = readTextOrEmpty(path.join(REPO, 'renderer', 'index.html'));
  const css = readTextOrEmpty(path.join(REPO, 'renderer', 'style.css'));
  t.ok(panel.length > 0, 'renderer/js/plugin-panel.js exists');
  const tabsDecl = /\bTABS\s*=\s*\[([^\]]*)\]/.exec(side);
  t.ok(!!tabsDecl && sameJson(tabsDecl[1].split(',').map((s) => s.trim().replace(/'/g, '')), ['files', 'git', 'plans', 'terminal']) && !/plugins\s*:/.test(side), 'side-panel.js: TABS and HOSTS hold the four tabs, no plugins entry');
  t.ok(!/registerSideTab|showSideTab|side-panel\.js/.test(panel), 'plugin-panel.js: no side-panel.js import, no registerSideTab / showSideTab');
  const specs = [...panel.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  t.ok(specs.length > 0 && specs.every((s) => ['./state.js', './loading.js', './mode.js', './plugin-journal.js', './motion.js'].includes(s)), `imports stay leaf-side (${specs.join(', ')})`);
  t.ok((boot.match(/onPluginsChanged\s*\(/g) || []).length === 1, 'boot.js subscribes onPluginsChanged exactly once');
  t.ok(!/window\.api\.on[A-Z]/.test(panel), 'plugin-panel.js subscribes to nothing itself (boot.js owns every listener)');
  t.ok(/from\s+'\.\/plugin-panel\.js'/.test(boot) && /initPluginPanel\(\)/.test(boot) && /\bplg\b/.test(boot.slice(boot.indexOf('Object.assign(window'))), 'boot.js: import, init and the probe seam entry');
  const wsStart = html.indexOf('<main id="workspace">'), wsEnd = html.indexOf('</main>'), panelAt = html.indexOf('id="plugin-panel"');
  t.ok(/id="room-toggle"[\s\S]*?<\/button>\s*<button id="plugin-toggle"/.test(html), 'index.html: #plugin-toggle right after the #room-toggle button');
  t.ok(wsStart > 0 && panelAt > wsStart && panelAt < wsEnd, 'index.html: #plugin-panel sits between <main id="workspace"> and </main>');
  t.ok(/id="plg-close"/.test(html) && /id="plg-empty"/.test(html) && /id="plg-import"/.test(html) && !/data-tab=.plugins/.test(html), 'index.html: close control, empty state, import button, and no plugins tab button');
  for (const f of ['room-panel.js', 'agent-journal.js', 'usage-page.js', 'side-panel.js', 'mode.js', 'sidebar.js']) t.ok(/closePluginPanel\??\.?\(/.test(src(f)), `${f} closes Plugins through the closePluginPanel slot`);
  t.ok(/closePluginPanel:\s*null/.test(src('state.js')) && /overlayState\.closePluginPanel\s*=\s*closePluginPanel/.test(boot), 'state.js holds the slot, boot.js assigns it');
  t.ok(!/export function openPluginPanel/.test(panel) && /function openPluginPanel/.test(panel) && /export function closePluginPanel/.test(panel), 'plugin-panel.js exports closePluginPanel only (openPluginPanel stays module-private)');
  t.ok(!/\bimport\b[^;]*plugin-panel\.js/.test(src('sidebar.js')), 'sidebar.js does not import plugin-panel.js (it reaches the panel through the slot)');
  t.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\bDOMParser\b|\beval\(/.test(panel), 'no HTML sink in plugin-panel.js');
  t.ok(!/\b(fetch|require|XMLHttpRequest)\s*\(|localStorage|sessionStorage/.test(panel), 'the renderer module does no IO');
  const sandboxes = [...panel.matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'/g)].map((m) => m[1]);
  t.ok(sandboxes.length === 1 && sandboxes[0] === 'allow-scripts' && !/allow-same-origin/.test(panel), `sandbox exactly allow-scripts (${sandboxes.join('|')})`);
  const rules = cssRulesOf(css, /#plugin-panel|\.plg-|#plg-/);
  t.ok(rules.length >= 8, `the panel rules are in style.css (${rules.length})`);
  t.ok(rules.filter((r) => !/#room-panel/.test(r)).every((r) => !/border-left|border-inline-start|inset\s+[2-9]px|box-shadow:[^;]*\b[2-9]px 0/.test(r)), 'no coloured left accent bar on rows or cards (the shared Room shell edge excepted)');
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, ''); // a comment above a rule would otherwise read as part of its selector
  const selOf = (re) => [...cssCode.matchAll(/([^{}]+)\{/g)].map((m) => m[1]).filter((s) => re.test(s));
  t.ok(/classList\.remove\('rp-anim-in'\), 320\)/.test(panel) && /\}, 240\);/.test(panel), 'plugin-panel.js: the 320 ms entrance timer and the 240 ms hide timer of room-panel.js');
  for (const k of ['', '.open', '.rp-anim-in']) {
    const room = new RegExp(`#room-panel${k.replace('.', '\\.')}(?![\\w.-])`), plug = new RegExp(`#plugin-panel${k.replace('.', '\\.')}(?![\\w.\\[-])`);
    t.ok(selOf(room).some((s) => room.test(s) && plug.test(s)), `#plugin-panel${k} shares the #room-panel${k} shell rule`);
  }
  t.ok(!selOf(/mode-fade/).some((s) => /#plugin-panel/.test(s)), 'the Plugins overlay stays out of body.mode-fade-* (it never stays open across a mode switch)');
  t.ok(/@container sp-head \(max-width: 384px\)/.test(css) && !/max-width: 464px/.test(css), 'style.css: the narrow head is the four-tab query (384 px)');
});

gate('g22 S19 D1 (UI): no plugin -> the header button opens an empty state with « Importer un plugin… », no row, no frame', async (t) => {
  const D = await RUNS.D;
  if (D.fatal) { t.ok(false, `scenario D (${D.fatal})`); return; }
  const r = D.b1.results;
  t.ok(r.btnInfo && r.btnInfo.exists === true && r.btnInfo.title === 'Plugins' && r.btnInfo.aria === 'Plugins' && /Plugins/.test(r.btnInfo.text || ''), `header button named Plugins (${JSON.stringify(r.btnInfo)})`);
  const e = r.empty || {};
  t.ok(e.open === true && e.overlay === true && e.hostHidden === false, `the button opens the host (${JSON.stringify(e).slice(0, 160)})`);
  t.ok(/Aucun plugin installé/.test(e.emptyText || ''), `empty state says so (${e.emptyText})`);
  t.ok(e.importText === 'Importer un plugin…', `import button (${e.importText})`);
  t.ok(e.rows === 0 && e.frames === 0, 'no row, no frame');
  t.ok(e.seam === 'object', 'probe seam: window.plg');
  t.ok(D.counts.run === 0 && D.counts.list === 0, `opening the panel spawned and listed nothing (${JSON.stringify(D.counts)})`);
});

gate('g23 S19 D3 D23 D4 (UI): list, switch persists, unready refused with the French line, run mounts the latest report in a closed frame, markup stays text', async (t) => {
  const E = await RUNS.E;
  t.ok(!E.fatal, `scenario E ran (${E.fatal})`);
  if (E.fatal) return;
  ok2(t, E.b1, 'boot 1'); ok2(t, E.b2, 'boot 2');
  const r = E.b1.results;
  t.ok(r.btnInfo && r.btnInfo.exists === true, 'header button present with 3 plugins installed');
  const z = r.rows0 || {};
  t.ok(z.open === true && z.hostHidden === false && z.emptyHidden === true && (z.rows || []).length === 3, `three rows, no empty state (${JSON.stringify(z).slice(0, 140)})`);
  t.ok(sameJson((z.rows || []).map((x) => x.id), ['fake', 'unready', 'xss']), 'rows follow the listing order');
  t.ok(z.page === 'list', `the panel opens on the list page (${z.page})`);
  t.ok((z.rows || []).every((x) => x.on === 'false' && x.runText === 'Lancer' && x.headRun === 'Lancer maintenant'), `disabled rows are kept, « Lancer » on the row and « Lancer maintenant » in each detail head (${JSON.stringify((z.rows || []).map((x) => [x.on, x.runText, x.headRun]))})`);
  t.ok((z.rows || []).filter((x) => x.id !== 'xss').every((x) => !/À configurer/.test(x.status)), 'ready null (shell never read) shows no « À configurer »');
  const xss = (z.rows || []).find((x) => x.id === 'xss') || {};
  t.ok(xss.label === MARKUP_LABEL && xss.desc === MARKUP_DESC, `label and description are text (${xss.label} | ${xss.desc})`);
  t.ok(z.pwnEl === false && z.pwnWin === null && z.imgs === 0 && z.bolds === 0, `no element built from the markup (${JSON.stringify({ pwnEl: z.pwnEl, pwnWin: z.pwnWin, imgs: z.imgs, bolds: z.bolds })})`);
  const un = (r.rows1 || []).find((x) => x.id === 'unready') || {};
  t.ok(un.on === 'false' && /^Accès requis manquant : Jeton manquant/.test(un.note), `D23 unready: the switch is refused with the host line (${un.note})`);
  t.ok(/À configurer/.test(un.status) && un.swDis === true && un.runDis === true, `D23 unready: « À configurer », switch and run disabled (${JSON.stringify(un)})`);
  const fk = (r.rows2 || []).find((x) => x.id === 'fake') || {};
  t.ok(fk.on === 'true' && fk.sw === 'true' && fk.note === '' && !/À configurer/.test(fk.status), `D3 ready: the switch re-enables it (${JSON.stringify(fk)})`);
  t.ok(E.afterB1.state.fake.enabled === true, 'D3: enabled persisted in plugins.json');
  t.ok(!E.afterB1.state.unready || E.afterB1.state.unready.enabled !== true, 'D23: the refused plugin was not enabled');
  t.ok(E.afterB1.counts.run === 1, `exactly one launch: the « Lancer maintenant » click (${JSON.stringify(E.afterB1.counts)})`);
  const f = r.frame || {};
  t.ok(f.sandbox === 'allow-scripts', `D4 frame sandbox is exactly allow-scripts (${f.sandbox})`);
  t.ok(/^deckpage:\/\/page\/[0-9a-f-]{36}$/.test(f.src || ''), `frame src is a deckpage token url (${f.src})`);
  t.ok(f.count === 1 && f.inView === true && /Plugin factice/.test(f.title || ''), 'one frame, inside the report view, titled with the plugin');
  t.ok(/^Dernier rapport/.test((f.row || {}).status || ''), `the exit push refreshed the row with no click (${(f.row || {}).status})`);
  const ap = r.afterPick || {};
  t.ok(ap.frames === 0 || ap.frames === 1, 'selecting another row keeps at most one frame');
  t.ok(((ap.rows || []).find((x) => x.id === 'xss') || {}).current === 'true' && ((ap.rows || []).find((x) => x.id === 'fake') || {}).current !== 'true', 'the picked row is the current one');
  t.ok(r.afterClose && r.afterClose.frames === 0 && r.afterClose.open === false, 'closing the panel unmounts the report frame (a hidden page would keep running)');
  t.ok(E.afterB2 && E.afterB2.counts.run === 1, `K1 real app: the reboot starts no daily run, boot 1's manual report of today already counts (${JSON.stringify(E.afterB2 && E.afterB2.counts)})`);
  const b2 = (E.b2.results.rows || []);
  t.ok(((b2.find((x) => x.id === 'fake') || {}).on === 'true') && ((b2.find((x) => x.id === 'unready') || {}).swDis === true), `after a reboot: fake still on, unready still disabled (${JSON.stringify(b2.map((x) => [x.id, x.on, x.swDis]))})`);
});

gate('g24 S19 D4 (UI): a latest report over 1 MiB -> a French refusal line and no frame; failed / interrupted runs read in the status', async (t) => {
  const F = await RUNS.F;
  t.ok(!F.fatal, `scenario F ran (${F.fatal})`);
  if (F.fatal) return;
  ok2(t, F.b1, 'boot');
  const r = F.b1.results;
  const big = r.big || {};
  t.ok(big.frames === 0 && /volumineux/.test(big.view || ''), `1.1 MB -> refusal line, no frame (${big.view})`);
  t.ok(big.current === 'true', 'the plugin opened from the list is the one shown (K5: the list page has no default pick)');
  const row = (id) => ((big.rows || []).find((x) => x.id === id)) || {};
  t.ok(/^Dernier rapport/.test(row('fake').status || ''), `fake status (${row('fake').status})`);
  t.ok(/Échec \(code 3\)/.test(row('fail').status || ''), `fail status (${row('fail').status})`);
  t.ok(/^Interrompu/.test(row('intr').status || ''), `intr status (${row('intr').status})`);
  const sws = Object.values(r.sws || {});
  t.ok(sws.length === 3 && sws.every((s) => s && s.dis === false && s.on === 'false') && (big.rows || []).every((x) => x.on === 'false'), `ready plugins keep a usable switch (${JSON.stringify(r.sws)})`);
  const ap = r.afterPick || {};
  t.ok(ap.frames === 0 && ap.fakeCurrent !== 'true' && !/volumineux/.test(ap.view || ''), `picking a plugin with no report drops the refusal line (${ap.view})`);
});

gate('g25 AMD-4 A4-5 side panel head: four tabs, no plugins tab, every one named, no overflow at any width, labels all shown or all hidden', async (t) => {
  const F = await RUNS.F;
  if (F.fatal || !F.b1 || !F.b1.results.heads) { t.ok(false, `scenario F heads (${F.fatal || (F.b1 && F.b1.error)})`); return; }
  const heads = F.b1.results.heads;
  const widths = Object.keys(heads).map(Number).sort((a, b) => a - b);
  console.log(`     (diag) head by requested width: ${widths.map((w) => `${w}->${heads[w].panelW}${heads[w].labels[0].shown ? 'L' : 'i'}${heads[w].tabsOverflow || heads[w].headOverflow ? '!' : ''}`).join(' ')}`);
  let prevShown = false;
  for (const w of widths) {
    const h = heads[w];
    t.ok(h.closeIn && h.maxIn && !h.tabsOverflow && !h.headOverflow && h.tabsInHead && h.labels.every((l) => l.inTabs), `width ${w} (panel ${h.panelW}): head fits`);
    t.ok(h.opened === true, `width ${w}: the side panel opens with no pane (Terminal tab)`);
    t.ok(sameJson(h.list, ['files', 'git', 'plans', 'terminal']) && h.plgIn === false, `width ${w}: the four tabs, no plugins tab, no #plugin-panel inside #side-panel (${JSON.stringify(h.list)})`);
    t.ok(sameJson(h.labels.map((l) => l.title), TAB_TITLES) && h.labels.every((l) => l.aria === l.title), `width ${w}: four tabs, each named by title and aria-label`);
    const shown = h.labels[0].shown;
    t.ok(h.labels.every((l) => l.shown === shown), `width ${w}: labels uniform`);
    if (h.panelW >= 420) t.ok(shown, `width ${w} (panel ${h.panelW}): labels shown from 420 px up`);
    if (h.panelW <= 392) t.ok(!shown, `width ${w} (panel ${h.panelW}): icon-only below the four-tab need`);
    t.ok(!(prevShown && !shown), `width ${w}: labels never disappear as the panel widens`);
    prevShown = shown;
  }
  t.ok(heads[widths[0]].labels.every((l) => !l.shown), 'the floor is icon-only');
  t.ok(heads[widths[widths.length - 1]].labels.every((l) => l.shown), `the widest tried (${widths[widths.length - 1]}) is labelled`);
});

gate('g26 S19b D14 (UI, amended by plugins-v4 Amendment 4): import card shows the manifest as text; cancel copies nothing; confirm lists the row on; invalid -> the host French line, nothing copied; installed id -> replace prompt', async (t) => {
  const G = await RUNS.G;
  t.ok(!G.fatal, `scenario G ran (${G.fatal})`);
  if (G.fatal) return;
  ok2(t, G.b1, 'boot');
  const r = G.b1.results || {};
  const st = r.start || {};
  t.ok(st.text === 'Importer un plugin…' && st.disabled === false && st.host === true && st.card === null, `the import button is live and the card host is empty (${JSON.stringify(st)})`);
  t.ok(st.delBtns === 2 && st.rowDel === 0, `each detail head offers « Supprimer », no list row does (${st.delBtns} | ${st.rowDel})`);
  const cd = r.afterCancelDialog || {};
  t.ok(cd.card === null && cd.disabled === false, `a canceled dialog shows nothing (${JSON.stringify(cd)})`);
  const c = r.cardNew || {};
  t.ok(c.kind === 'import' && c.kicker === 'Importer un plugin', `card kind and kicker (${c.kind} | ${c.kicker})`);
  t.ok(c.title === NEW_LABEL && c.desc === NEW_DESC, `name and description are text (${c.title} | ${c.desc})`);
  t.ok(c.trigger === 'Manuel' && c.command === 'run.py', `trigger and command (${c.trigger} | ${c.command})`);
  t.ok(c.scope === SCOPE_LINE && c.accessEmpty === true, `the scope line and an empty region for the access rows (${c.scope} | ${c.accessEmpty})`);
  t.ok(c.pwnEl === false && c.pwnWin === null && c.imgs === 0 && c.italics === 0, `no element built from the markup (${JSON.stringify({ pwnEl: c.pwnEl, pwnWin: c.pwnWin, imgs: c.imgs, italics: c.italics })})`);
  t.ok(c.replace === null && c.error === null, 'a new id: no replace prompt, no error');
  t.ok(sameJson((c.buttons || []).map((b) => [b.act, b.text, b.dis]), [['card-confirm', 'Importer', false], ['card-cancel', 'Annuler', false]]), `buttons (${JSON.stringify(c.buttons)})`);
  t.ok(sameJson(r.lsAfterPick, ['fake', 'slow']) && sameJson(r.lsAfterCancel, ['fake', 'slow']), `D14: nothing copied by the pick or the cancel (${JSON.stringify(r.lsAfterPick)} | ${JSON.stringify(r.lsAfterCancel)})`);
  const ai = r.afterImport || {};
  const nw = (ai.rows || []).find((x) => x.id === 'newone') || {};
  t.ok(ai.card === null && nw.on === 'true' && nw.label === NEW_LABEL, `confirm: the card closes and the row is listed, on (${JSON.stringify(nw)})`);
  t.ok(G.after.state.newone && G.after.state.newone.enabled === true, 'confirm: persisted enabled');
  t.ok(sameJson(r.lsAfterImport, ['fake', 'newone', 'slow']), `confirm: the folder is copied, no leftover (${JSON.stringify(r.lsAfterImport)})`);
  const bad = r.cardBad || {};
  t.ok(bad.kind === 'refused' && typeof bad.error === 'string' && bad.error.length > 0 && r.hostBad && r.hostBad.ok === false && bad.error === r.hostBad.error, `invalid: the card shows the host line (${bad.error} | ${(r.hostBad || {}).error})`);
  t.ok((bad.buttons || []).length === 1 && bad.buttons[0].act === 'card-cancel' && bad.buttons[0].text === 'Fermer' && bad.title === null, `invalid: only « Fermer », no manifest card (${JSON.stringify(bad.buttons)})`);
  t.ok(sameJson(r.lsAfterBad, ['fake', 'newone', 'slow']), `invalid: nothing copied (${JSON.stringify(r.lsAfterBad)})`);
  const dp = r.cardDup || {};
  t.ok(dp.kind === 'import' && dp.kicker === 'Remplacer un plugin' && /déjà installé/.test(dp.replace || '') && dp.trigger === 'Quotidien', `installed id: replace prompt (${dp.kicker} | ${dp.replace} | ${dp.trigger})`);
  // S19d: a manifest that declares slots adds « Détecter » to its card (acc-detect); the two action buttons stay what they were
  t.ok(sameJson((dp.buttons || []).filter((b) => b.act !== 'acc-detect').map((b) => [b.act, b.text]), [['card-confirm', 'Remplacer'], ['card-cancel', 'Annuler']]), `replace buttons (${JSON.stringify(dp.buttons)})`);
  t.ok(r.labelBefore === 'Plugin factice' && r.labelAfterCancel === 'Plugin factice', `cancel keeps the installed copy (${r.labelBefore} | ${r.labelAfterCancel})`);
  t.ok(((r.afterReplace || {}).row || {}).label === 'Plugin factice v2' && ((r.afterReplace || {}).row || {}).on === 'true', `confirm replaces it, on (${JSON.stringify((r.afterReplace || {}).row)})`);
  for (const k of ['dup', 'newone', 'bad']) t.ok(sameJson(G.srcBefore[k], G.after.srcAfter[k]), `the source folder (${k}) is untouched`);
});

gate('g27 S19b D18 (UI): delete card shows the report count and size, cancel removes nothing, confirm leaves nothing under plugin-data/<id> and the source intact, a running plugin is stopped then removed', async (t) => {
  const G = await RUNS.G;
  if (G.fatal) { t.ok(false, `scenario G (${G.fatal})`); return; }
  ok2(t, G.b1, 'boot');
  const r = G.b1.results || {};
  const ipc = r.ipcCard || {};
  t.ok(G.exp.count === 2 && ipc.ok === true && ipc.count === G.exp.count && ipc.bytes === G.exp.bytes && G.exp.bytes > 0, `the host figures match the files (${JSON.stringify(ipc)} | ${JSON.stringify(G.exp)})`);
  const d = r.cardDel || {};
  t.ok(d.kind === 'delete' && d.kicker === 'Supprimer un plugin' && d.title === 'Plugin factice v2', `delete card: kind, kicker, name (${d.kind} | ${d.kicker} | ${d.title})`);
  t.ok((d.impact || '').includes(`${G.exp.count} rapports`) && (d.impact || '').includes(frBytes(G.exp.bytes)), `delete card says ${G.exp.count} rapports and ${frBytes(G.exp.bytes)} (${d.impact})`);
  t.ok(sameJson((d.buttons || []).map((b) => [b.act, b.text]), [['card-confirm', 'Supprimer'], ['card-cancel', 'Annuler']]), `delete buttons (${JSON.stringify(d.buttons)})`);
  t.ok(r.dirBeforeDel === true && r.dataBeforeDel === true && r.dirAfterCancelDel === true && r.dataAfterCancelDel === true, 'cancel removes nothing');
  t.ok(r.dirAfterDel === false && r.dataAfterDel === false, `confirm: no plugin folder and nothing left under plugin-data/fake (${r.dirAfterDel} | ${r.dataAfterDel})`);
  t.ok(!('fake' in (G.after.state || {})), 'confirm: the state entry is gone');
  t.ok(sameJson(G.after.srcAfter.dup, G.srcBefore.dup), 'D18: the source folder of the removed copy is intact');
  const s = r.slowDeleted || {};
  t.ok(s.row === false && s.card === null, `a running plugin: stopped then removed, the card closed and the row gone (${JSON.stringify(s)})`);
  t.ok(r.dirSlowAfter === false, `a running plugin: its folder is gone (${r.dirSlowAfter})`);
});

// Scenario H (S19c UI): history, filters and retention over the fake clock (2026-11-03 09:00 local). `fake` holds three runs - one
// ok today, one failed (code 3) yesterday with a log that carries markup, one ok ten days ago; `trunc` one failed run with a
// log over 1 MiB. Each report posts a marker to the parent when its frame runs, so the probe knows WHICH report a row opened.
// The inline script is inert under the plugin CSP; the mount is read from the <title> by ctx.startMarks (runBoot).
const H_MARK = (tag) => `<!doctype html><title>${tag}</title><script>parent.postMessage({ deckProbe: '${tag}' }, '*')</script>`;
const H_LOG = 'boom: connexion refusée\nligne 2 <img src=x onerror="window.__pwn=1">\n';
const HIST_HELP = `
  const tabs = () => [...document.querySelectorAll('#plg-detail [role="tab"]')].map((b) => ({ text: b.textContent, sel: b.getAttribute('aria-selected'), act: b.dataset.act }));
  const chips = () => [...document.querySelectorAll('#plg-hist [data-act="range"]')].map((b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed') }));
  const hrows = () => [...document.querySelectorAll('#plg-hist .plg-hrow')].map((b) => ({ day: $q('.plg-h-day', b).textContent, time: $q('.plg-h-time', b).textContent,
    trig: $q('.plg-h-trig', b).textContent, status: $q('.plg-h-status', b).textContent, size: $q('.plg-h-size', b).textContent, cur: b.getAttribute('aria-current') }));
  const histState = () => { const e = $q('#plg-hempty'), d = $q('#plg-date'); return { tabs: tabs(), chips: chips(), rows: hrows(), shown: $q('#plg-shown').textContent,
    empty: e && !e.hidden ? e.textContent : null, histHidden: $q('#plg-hist').hidden, dateVisible: !!d && !d.hidden, dateVal: d ? d.value : null,
    frames: document.querySelectorAll('#plugin-panel iframe').length }; };
  const clickChip = (r) => { $q('#plg-hist [data-act="range"][data-range="' + r + '"]').click(); };
  const setDate = (v) => { const i = $q('#plg-date'); i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); };
`;
const histEv = (as, code) => ev(as, UI_HELP + HIST_HELP + code);
const histWait = (as, cond, ms) => ({ op: 'waitFor', as, ms: ms || 15000, code: `${UI_HELP}${HIST_HELP} return Boolean(${cond});` });
async function scenarioH() {
  const R = bootRig('h');
  const plugin = installFixture(R.pluginsDir, { id: 'fake', label: 'Plugin factice', env: [] });
  installFixture(R.pluginsDir, { id: 'trunc', label: 'Plugin tronqué', env: [] });
  const dataRoot = path.join(R.userData, 'plugin-data');
  const reports = require(path.join(SRC, 'plugin-reports.js')).create(dataRoot, () => Date.parse(R.seedAt));
  const seed = (id, at, trigger, exit, o = {}) => {
    R.seedAt = at;
    const e = reports.newEntry(id, trigger);
    if (o.report !== undefined) fs.writeFileSync(e.reportPath, o.report);
    if (o.log !== undefined) fs.writeFileSync(e.logPath, o.log);
    reports.finishEntry(id, e.stem, { exit });
    return e.stem;
  };
  seed('fake', '2026-10-24T08:00:00', 'auto', 0, { report: H_MARK('R-OLD') });
  seed('fake', '2026-11-02T08:00:00', 'manual', 3, { log: H_LOG });
  seed('fake', '2026-11-03T08:00:00', 'auto', 0, { report: H_MARK('R-TODAY') });
  seed('trunc', '2026-11-03T07:00:00', 'manual', 5, { log: 'A'.repeat(1100 * 1024) + '\nTAIL-MARK\n' });
  const keep = path.join(dataRoot, 'fake', 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  fs.writeFileSync(R.statePath, JSON.stringify({
    fake: { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30, envMap: {} },
    trunc: { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30, envMap: {} },
  }));
  const manifestBefore = fs.readFileSync(path.join(plugin, 'deck-plugin.json'), 'utf8');
  const out = { R, keep, sidecarsSeed: R.sidecars() };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 2;' },
    ev('marks', 'window.__marks = []; return true;'),
    { op: 'main', as: 'marksOn', code: 'return ctx.startMarks();' },
    OPEN_BTN,
    histWait('rows', "document.querySelectorAll('#plg-list .plg-row').length === 2"),
    histEv('openFake0', "return await openDetail('fake');"),
    histWait('tabsReady', "tabs().length === 4 && /Historique · 3/.test(tabs()[2].text)"),
    histEv('detail0', "const i = $q('#plg-retention'); return { tabs: tabs(), ret: i.value, retMin: i.min, retMax: i.max, retType: i.type, storage: $q('#plg-storage').textContent, histHidden: $q('#plg-hist').hidden, cur: rowOf('fake').current, keepLabel: $q('#plg-settings').textContent };"),
    histWait('mounted', "window.__marks.includes('R-TODAY')"),
    histEv('view0', "const f = $q('#plg-view iframe'); return { frames: document.querySelectorAll('#plugin-panel iframe').length, sandbox: f && f.getAttribute('sandbox'), marks: window.__marks.slice() };"),
    histEv('ipc', "const n = async (f) => (await window.api.pluginsHistory('fake', f)).map((e) => e.stem); return { all: await n(undefined), d1: await n({ days: 1 }), d7: await n({ days: 7 }), d30: await n({ days: 30 }), date: await n({ date: '2026-11-02' }) };"),
    histEv('goHist', "goTab('history'); return true;"),
    histWait('hist7', 'hrows().length === 2'),
    histEv('h7', 'return histState();'),
    histEv('c1', "clickChip('1'); return true;"),
    histWait('c1w', "hrows().length === 1 && chips()[0].pressed === 'true'"),
    histEv('h1', 'return histState();'),
    histEv('c30', "clickChip('30'); return true;"),
    histWait('c30w', "hrows().length === 3 && chips()[2].pressed === 'true'"),
    histEv('h30', 'return histState();'),
    histEv('cDate', "clickChip('date'); return true;"),
    histWait('cDateW', "histState().dateVisible && chips()[3].pressed === 'true'"),
    histEv('hDateOpen', 'return histState();'),
    histEv('d1', "setDate('2026-11-02'); return true;"),
    histWait('d1w', "hrows().length === 1 && /^Échec/.test(hrows()[0].status)"),
    histEv('hD1', 'return histState();'),
    histEv('d2', "setDate('2026-10-24'); return true;"),
    histWait('d2w', "hrows().length === 1 && /24 oct/.test(hrows()[0].day)"),
    histEv('hD2', 'return histState();'),
    histEv('d3', "setDate('2026-11-01'); return true;"),
    histWait('d3w', 'hrows().length === 0 && histState().empty'),
    histEv('hD3', 'return histState();'),
    // a row opens its entry: the failed one -> the failure view with its log (text only)
    histEv('d4', "setDate('2026-11-02'); return true;"),
    histWait('d4w', "hrows().length === 1 && /^Échec/.test(hrows()[0].status)"),
    histEv('openFail', "$q('#plg-hist .plg-hrow').click(); return true;"),
    histWait('failShown', "$q('#plg-view .plg-fail pre') && $q('#plg-view .plg-fail pre').textContent.length > 0"),
    histEv('fail', "const v = $q('#plg-view'), n = $q('.plg-log-note', v); return { tabs: tabs(), title: $q('.plg-fail-title', v).textContent, log: $q('pre', v).textContent, note: n && !n.hidden ? n.textContent : '', imgs: v.querySelectorAll('img').length, pwn: window.__pwn === undefined ? null : window.__pwn, frames: document.querySelectorAll('#plugin-panel iframe').length, histHidden: $q('#plg-hist').hidden };"),
    // the old ok run, then today's: each opens ITS report in the closed frame
    histEv('goHist2', "goTab('history'); clickChip('30'); return true;"),
    histWait('h30b', 'hrows().length === 3'),
    histEv('openOld', "$q('#plg-hist .plg-hrow:nth-child(3)').click(); return true;"),
    histWait('oldMarked', "window.__marks.includes('R-OLD')"),
    histEv('viewOld', "return { frames: document.querySelectorAll('#plugin-panel iframe').length, marks: window.__marks.slice(), tabs: tabs() };"),
    histEv('goHist3', "goTab('history'); return true;"),
    histWait('h30c', 'hrows().length === 3'),
    histEv('openToday', "$q('#plg-hist .plg-hrow:nth-child(1)').click(); return true;"),
    histWait('todayAgain', "window.__marks.length === 3"),
    histEv('viewToday', 'return { marks: window.__marks.slice(), frames: document.querySelectorAll("#plugin-panel iframe").length };'),
    // a log over 1 MiB: its tail and « journal tronqué »
    uiEv('pickTrunc', "return await openDetail('trunc');"),
    histWait('truncSel', "rowOf('trunc').current === 'true'"),
    histEv('goHist4', "goTab('history'); return true;"),
    histWait('truncRow', "hrows().length === 1 && /^Échec \\(code 5\\)/.test(hrows()[0].status)"),
    histEv('openTrunc', "$q('#plg-hist .plg-hrow').click(); return true;"),
    histWait('truncShown', "$q('#plg-view .plg-log-note') && !$q('#plg-view .plg-log-note').hidden"),
    histEv('trunc', "const v = $q('#plg-view'); return { title: $q('.plg-fail-title', v).textContent, note: $q('.plg-log-note', v).textContent, len: $q('pre', v).textContent.length, tail: $q('pre', v).textContent.trimEnd().slice(-9) };"),
    // retention: the field calls the host, a bad value gets the host line and the field goes back to the stored value
    uiEv('pickFake', "return await openDetail('fake');"),
    histWait('fakeSel', "rowOf('fake').current === 'true' && $q('#plg-retention').value === '30'"),
    histEv('ret1', "const i = $q('#plg-retention'); i.value = '1'; i.dispatchEvent(new Event('change', { bubbles: true })); return true;"),
    { op: 'waitFor', as: 'ret1w', code: "return (await window.api.pluginsList()).find((r) => r.id === 'fake').retentionDays === 1;" },
    histEv('retBad', "const i = $q('#plg-retention'); i.value = '0'; i.dispatchEvent(new Event('change', { bubbles: true })); return true;"),
    histWait('retBadW', "/entier entre 1 et 365/.test(rowOf('fake').note) && $q('#plg-retention').value === '1'"),
    histEv('retAfterBad', "return { val: $q('#plg-retention').value, note: rowOf('fake').note, list: (await window.api.pluginsList()).find((r) => r.id === 'fake').retentionDays };"),
  ]);
  out.afterB1 = { state: R.state(), sidecars: R.sidecars() };
  out.b2 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 2;' },
    OPEN_BTN,
    histWait('rows2', "document.querySelectorAll('#plg-list .plg-row').length === 2"),
    histEv('openFake2', "return await openDetail('fake');"),
    histWait('tabsReady2', "tabs().length === 4 && /Historique · 1/.test(tabs()[2].text)"),
    histEv('detail2', "return { tabs: tabs(), ret: $q('#plg-retention').value, storage: $q('#plg-storage').textContent };"),
    histEv('goHist', "goTab('history'); clickChip('30'); return true;"),
    histWait('hist30', 'hrows().length === 1'),
    histEv('h2', 'return histState();'),
  ], { now: '2026-11-03T09:30:00' });
  out.after = {
    sidecars: R.sidecars(),
    truncSidecars: (() => { try { return fs.readdirSync(path.join(dataRoot, 'trunc', 'reports')).filter((f) => f.endsWith('.json')).length; } catch (_) { return 0; } })(),
    keep: readTextOrEmpty(keep), runPy: fs.existsSync(path.join(plugin, 'run.py')), manifestSame: readTextOrEmpty(path.join(plugin, 'deck-plugin.json')) === manifestBefore,
  };
  return out;
}

const fakeSize = (H) => H.sidecarsSeed.reduce((a, s) => a + (Number.isInteger(s.size) ? s.size : 0), 0);

gate('g28 S19c D15 (UI): tabs « Rapport | Historique · 3 », storage line, history rows newest first with day, time, trigger, status and size', async (t) => {
  const H = await RUNS.H;
  t.ok(!H.fatal, `scenario H ran (${H.fatal})`);
  if (H.fatal) return;
  ok2(t, H.b1, 'boot 1'); ok2(t, H.b2, 'boot 2');
  const r = H.b1.results;
  const d = r.detail0 || {};
  t.ok(sameJson((d.tabs || []).map((x) => x.text), ['Rapport', 'Journal', 'Historique · 3', 'Paramètres']), `the four tabs, the count of the kept runs (${JSON.stringify(d.tabs)})`);
  t.ok(d.tabs && d.tabs[0].sel === 'true' && d.tabs[2].sel === 'false' && d.histHidden === true, 'opens on « Rapport », the history is not shown');
  t.ok(/Garder les rapports/.test(d.keepLabel || '') && /jours/.test(d.keepLabel || ''), `retention line « Garder les rapports N jours » (${d.keepLabel})`);
  t.ok(d.retType === 'number' && d.ret === '30' && d.retMin === '1' && d.retMax === '365', `retention field: number 1-365, stored value (${d.ret} ${d.retMin}-${d.retMax})`);
  t.ok(d.storage === `3 rapports · ${frBytes(fakeSize(H))}`, `storage line: count and report bytes from the files (${d.storage} | ${frBytes(fakeSize(H))})`);
  t.ok(r.view0 && r.view0.frames === 1 && r.view0.sandbox === 'allow-scripts' && sameJson(r.view0.marks, ['R-TODAY']), `« Rapport » mounts the latest report in the closed frame (${JSON.stringify(r.view0)})`);
  const h = r.h7 || {};
  t.ok(h.tabs && h.tabs[2].sel === 'true' && h.histHidden === false && h.frames === 0, `« Historique » replaces the report view and unmounts the frame (${h.frames})`);
  t.ok(sameJson((h.rows || []).map((x) => x.status), ['OK', 'Échec (code 3)']), `7 j (default): newest first (${JSON.stringify((h.rows || []).map((x) => x.status))})`);
  const [a, b] = h.rows || [];
  t.ok(a && /3 nov\./.test(a.day) && a.time === '08:00' && a.trig === 'Automatique' && a.size === frBytes(H.sidecarsSeed.find((s) => s.exit === 0 && s.start > Date.parse('2026-11-03T00:00:00')).size), `row 1 (${JSON.stringify(a)})`);
  t.ok(b && /2 nov\./.test(b.day) && b.time === '08:00' && b.trig === 'Manuel' && b.size === '—', `row 2 (${JSON.stringify(b)})`);
  t.ok(a && a.cur === 'true' && b && b.cur !== 'true', 'the row shown in « Rapport » is marked current');
});

gate('g29 S19c D16 (UI): chips « 1 j » « 7 j » « 30 j » « Date… » filter through the host; « 1 j » is today only; the date field picks one day', async (t) => {
  const H = await RUNS.H;
  if (H.fatal) { t.ok(false, `scenario H (${H.fatal})`); return; }
  ok2(t, H.b1, 'boot 1');
  const r = H.b1.results;
  t.ok(sameJson(((r.h7 || {}).chips || []).map((c) => c.text), ['1 j', '7 j', '30 j', 'Date…']), `chip labels exact (${JSON.stringify((r.h7 || {}).chips)})`);
  t.ok(sameJson(((r.h7 || {}).chips || []).map((c) => c.pressed), ['false', 'true', 'false', 'false']), '7 j is the default, pressed');
  const ipc = r.ipc || {};
  t.ok(ipc.all && ipc.all.length === 3 && ipc.d1.length === 1 && ipc.d7.length === 2 && ipc.d30.length === 3 && ipc.date.length === 1, `host figures on the fake clock (${JSON.stringify(ipc)})`);
  const n = (k) => ((r[k] || {}).rows || []).length;
  t.ok(n('h1') === ipc.d1.length && n('h7') === ipc.d7.length && n('h30') === ipc.d30.length, `the rows are the host's answer for 1 j / 7 j / 30 j (${n('h1')}/${n('h7')}/${n('h30')})`);
  const h1 = r.h1 || {};
  t.ok(h1.rows && h1.rows.length === 1 && /3 nov\./.test(h1.rows[0].day) && h1.rows[0].status === 'OK', `1 j = today only, yesterday's failure left out (${JSON.stringify(h1.rows)})`);
  t.ok(sameJson((h1.chips || []).map((c) => c.pressed), ['true', 'false', 'false', 'false']) && h1.shown === '1 affiché', `1 j pressed, « 1 affiché » (${h1.shown})`);
  const h30 = r.h30 || {};
  t.ok(sameJson((h30.rows || []).map((x) => x.status), ['OK', 'Échec (code 3)', 'OK']) && /24 oct\./.test(((h30.rows || [])[2] || {}).day || '') && h30.shown === '3 affichés', `30 j: the three runs, newest first (${JSON.stringify((h30.rows || []).map((x) => x.day))} | ${h30.shown})`);
  const o = r.hDateOpen || {};
  t.ok(o.dateVisible === true && o.dateVal === '2026-11-03' && (o.chips || [])[3].pressed === 'true', `Date… shows the date field, starting at the newest run's day (${o.dateVisible} ${o.dateVal})`);
  t.ok((r.h1 || {}).dateVisible === false, 'the date field is hidden while a day-count chip is on');
  t.ok(r.hD1 && r.hD1.rows.length === 1 && /^Échec/.test(r.hD1.rows[0].status) && r.hD1.rows[0].trig === 'Manuel', `date 2026-11-02 -> the failed run (${JSON.stringify((r.hD1 || {}).rows)})`);
  t.ok(r.hD2 && r.hD2.rows.length === 1 && /24 oct\./.test(r.hD2.rows[0].day), `date 2026-10-24 -> the old run (${JSON.stringify((r.hD2 || {}).rows)})`);
  t.ok(r.hD3 && r.hD3.rows.length === 0 && r.hD3.empty === 'Aucun rapport pour cette période.' && r.hD3.shown === '0 affiché', `a day with no run says so (${(r.hD3 || {}).empty} | ${(r.hD3 || {}).shown})`);
});

gate('g30 S19c D15 (UI): a row opens its report in the closed frame; a failed row shows « Échec (code N) » and its log as text; « journal tronqué » when cut', async (t) => {
  const H = await RUNS.H;
  if (H.fatal) { t.ok(false, `scenario H (${H.fatal})`); return; }
  ok2(t, H.b1, 'boot 1');
  const r = H.b1.results;
  const f = r.fail || {};
  t.ok(/^Échec \(code 3\)/.test(f.title || ''), `failure title (${f.title})`);
  t.ok((f.log || '').includes('boom: connexion refusée') && (f.log || '').includes('<img src=x onerror="window.__pwn=1">'), `the log is in a <pre>, markup kept as text (${(f.log || '').slice(0, 80)})`);
  t.ok(f.imgs === 0 && f.pwn === null, `no element built from the log (${f.imgs} ${f.pwn})`);
  t.ok(f.note === '' && f.frames === 0, `an uncut log carries no « journal tronqué » and no frame (${JSON.stringify(f.note)} ${f.frames})`);
  t.ok(f.tabs && f.tabs[1].text === 'Journal' && f.tabs[1].sel === 'true' && f.histHidden === true, 'opening a failed row leaves the history for its view, on the « Journal » tab (no report to show)');
  t.ok(sameJson((r.viewOld || {}).marks, ['R-TODAY', 'R-OLD']) && (r.viewOld || {}).frames === 1, `the third row opened ITS report in one frame (${JSON.stringify(r.viewOld)})`);
  t.ok(sameJson((r.viewToday || {}).marks, ['R-TODAY', 'R-OLD', 'R-TODAY']) && (r.viewToday || {}).frames === 1, `then the first row's (${JSON.stringify(r.viewToday)})`);
  const tr = r.trunc || {};
  t.ok(/^Échec \(code 5\)/.test(tr.title || '') && tr.note === 'journal tronqué', `cut log: « journal tronqué » (${tr.title} | ${tr.note})`);
  t.ok(tr.tail === 'TAIL-MARK' && tr.len > 1000 * 1024 && tr.len <= 1024 * 1024 + 64, `the tail of the log is shown, at most 1 MiB (${tr.tail} ${tr.len})`);
});

gate('g31 S19c D17 (UI): « Garder les rapports N jours » calls the host (persisted, bad value refused with the host line); after a reboot older rows are gone, files outside the reports stay', async (t) => {
  const H = await RUNS.H;
  if (H.fatal) { t.ok(false, `scenario H (${H.fatal})`); return; }
  ok2(t, H.b1, 'boot 1'); ok2(t, H.b2, 'boot 2');
  const r = H.b1.results;
  t.ok(H.afterB1.state.fake && H.afterB1.state.fake.retentionDays === 1, `retention 1 persisted in plugins.json (${JSON.stringify(H.afterB1.state.fake)})`);
  t.ok(H.afterB1.state.trunc && H.afterB1.state.trunc.retentionDays === 30, 'the other plugin keeps its own retention');
  const b = r.retAfterBad || {};
  t.ok(b.note === 'Durée de conservation : un entier entre 1 et 365' && b.val === '1' && b.list === 1, `0 is refused with the host line, the field returns to the stored value (${JSON.stringify(b)})`);
  t.ok(H.afterB1.sidecars.length === 3, `changing the setting deletes nothing by itself (${H.afterB1.sidecars.length})`);
  const d = H.b2.results.detail2 || {};
  t.ok(sameJson((d.tabs || []).map((x) => x.text), ['Rapport', 'Journal', 'Historique · 1', 'Paramètres']) && d.ret === '1' && /^1 rapport · /.test(d.storage || ''), `after the reboot: one run kept, field reads 1 (${JSON.stringify(d)})`);
  const h = H.b2.results.h2 || {};
  t.ok(h.rows && h.rows.length === 1 && /3 nov\./.test(h.rows[0].day) && h.rows[0].status === 'OK', `30 j after the reboot shows today's run only (${JSON.stringify(h.rows)})`);
  t.ok(H.after.sidecars.length === 1 && H.after.sidecars[0].start > Date.parse('2026-11-03T00:00:00'), `older entries are gone from disk (${H.after.sidecars.length})`);
  t.ok(H.after.keep === 'keep' && H.after.runPy === true && H.after.manifestSame === true, `files outside the reports are intact (${JSON.stringify({ keep: H.after.keep, runPy: H.after.runPy, manifest: H.after.manifestSame })})`);
  t.ok(H.after.truncSidecars === 1, `another plugin's history is untouched (${H.after.truncSidecars})`);
});

// ---- S19d: access rows on the import card and the « Accès · Modifier » screen -------------------------------------------------
// The shell is the fixture fake-shell.sh: it exports FAKE secrets only (every value starts with FAKE-SECRET-), and the scenario
// proves that none of them ever reaches the page, an IPC payload, plugins.json or the DOM. Six slots, as the daily-brief plugin.
const FAKE_SHELL = path.join(FIXTURES, 'fake-shell.sh');
const SIX = [
  { name: 'JIRA_URL', label: 'Jira — URL du site', required: true, hints: ['JIRA', 'URL'] },
  { name: 'JIRA_EMAIL', label: 'Jira — identifiant', required: true, hints: ['JIRA', 'USER'] },
  { name: 'JIRA_TOKEN', label: 'Jira — jeton API', required: true, hints: ['FAKE', 'TOKEN'] },
  { name: 'SLACK_TOKEN', label: 'Slack — jeton utilisateur', required: true, hints: ['SLACK', 'TOKEN'] },
  { name: 'CLAUDE_KEY', label: 'Claude — clé API (batch des doc drifts)', required: true, hints: ['CLAUDE', 'KEY'] },
  { name: 'AIKIDO_KEY', label: 'Aikido — clé API (CVE)', required: false, hints: ['AIKIDO'] },
];
const ACC_HELP = `
  const accSnap = () => { const c = $q('#plg-card'); if (!c || c.hidden) return null;
    const a = $q('#plg-card-access', c);
    const rows = a ? [...a.querySelectorAll('.plg-acc-row')].map((r) => { const ctl = $q('.plg-acc-in', r), st = $q('.plg-acc-status', r);
      return { slot: r.dataset.slot, required: r.dataset.required, label: $q('.plg-acc-label', r).textContent, sub: $q('.plg-acc-sub', r).textContent,
        tag: ctl.tagName, value: ctl.value, options: ctl.tagName === 'SELECT' ? [...ctl.options].map((o) => o.value) : [],
        status: st.textContent, host: st.dataset.status || '' }; }) : [];
    const t = (s) => { const n = $q(s, c); return n ? n.textContent : null; };
    const b = (act) => { const n = $q('[data-act="' + act + '"]', c); return n ? { text: n.textContent, dis: n.disabled } : null; };
    return { kind: c.dataset.kind, title: t('.plg-card-title'), rows, sum: t('.plg-acc-sum'), missing: t('.plg-acc-missing'), lock: t('.plg-acc-lock'),
      error: t('.plg-card-error'), detect: b('acc-detect'), confirm: b('card-confirm'), cancel: b('card-cancel'), text: c.textContent }; };
  const setName = (slot, v) => { const i = $q('#plg-card .plg-acc-row[data-slot="' + slot + '"] .plg-acc-in'); i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; };
`;
const accEv = (as, code) => uiEv(as, CARD_HELP + ACC_HELP + code);
const accWait = (as, cond, ms) => ({ op: 'waitFor', as, ms: ms || 15000, code: `${UI_HELP}${CARD_HELP}${ACC_HELP} return Boolean(${cond});` });
const IPC_OUT = { op: 'main', as: 'ipcOut', code: 'return ctx.ipcOut();' }; // every plugins-* answer main gave this boot (panel and probe alike)
// K5 + V26: the Accès line (title + count) and « Modifier » are in the head of the « Accès » card, in the Paramètres tab of each detail page; the detail head holds none
const ROW_LINES = "const out = []; for (const x of snap()) { await openDetail(x.id); goTab('settings'); const h = $q('#plg-settings .plg-set-head h2'); const b = accessBtn(); out.push({ id: x.id, label: x.label, k: h && h.textContent, sum: ($q('#plg-set-sum') || {}).textContent, btn: b && b.textContent, aria: b && b.getAttribute('aria-label'), accessCtls: document.querySelectorAll('#plugin-panel [data-act=\"access\"]').length, inCard: document.querySelectorAll('#plg-settings .plg-set-head [data-act=\"access\"]').length, inHead: document.querySelectorAll('#plg-dhead [data-act=\"access\"]').length }); } await backToList(); return out;";
const OPEN_BTN = { op: 'tclick', sel: '#plugin-toggle', expectOpen: true }; // the user's path: a trusted click on the header button (it toggles: a scenario never opens twice in one boot)

// Scenario I: `brief` (six slots, nothing mapped), `okp` (two slots, both mapped to names the shell exports). Boot 1 drives the import card
// (Détecter, a choice, the confirm, a hostile NAME), the screen of `brief` (Détecter, Enregistrer, a hostile NAME) and the screen of `okp`
// (a required slot cleared). Boot 2 proves the saved map survived the restart.
async function scenarioI() {
  const R = bootRig('i', FAKE_SHELL);
  const marker = `/tmp/p-${require('crypto').randomBytes(6).toString('hex')}`;
  const evil = `X;touch ${marker}`;
  installFixture(R.pluginsDir, { id: 'brief', label: 'Brief du jour', env: SIX });
  installFixture(R.pluginsDir, { id: 'okp', label: 'Plugin prêt', env: [SIX[2], SIX[5]] });
  const srcRoot = path.join(TMP, 'src-i');
  const srcB2 = installFixture(srcRoot, { id: 'brief2', label: 'Brief importé', env: SIX });
  const srcB3 = installFixture(path.join(srcRoot, 'three'), { id: 'brief3', label: 'Brief trois', env: SIX });
  const seed = { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30 };
  fs.writeFileSync(R.statePath, JSON.stringify({ brief: { ...seed, envMap: {} }, okp: { ...seed, envMap: { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN', AIKIDO_KEY: 'AIKIDO_API_KEY' } } }));
  const envOf = (as, id) => ({ op: 'main', as, code: `return JSON.parse(ctx.fs.readFileSync(${JSON.stringify(R.statePath)}, 'utf8'))[${JSON.stringify(id)}].envMap;` });
  const openAccess = (id, as, n) => [accEv(`click-${as}`, `return clickAccess('${id}');`),
    accWait(as, `accSnap() && accSnap().kind === 'access' && accSnap().rows.length === ${n}`)];
  const openImport = (src, as) => [stubStep(src), { op: 'sleep', ms: 100 }, uiEv(`click-${as}`, "$q('#plg-import').click(); return true;"),
    accWait(as, "accSnap() && accSnap().kind === 'import' && accSnap().rows.length === 6")];
  const out = { R, marker };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 2;' },
    OPEN_BTN,
    uiWait('rows', 'document.querySelectorAll("#plg-list .plg-row").length === 2'),
    uiEv('lines', ROW_LINES),
    // the import card: the six slots of the manifest, nothing looked up yet
    ...openImport(srcB2, 'cardOpen'),
    accEv('cardPre', 'return accSnap();'),
    lsStep('lsAfterPick', R.pluginsDir),
    ...shots('plugins-access-import.png'),
    // « Détecter »: single matches pre-filled, two candidates offered, none -> introuvable
    accEv('detect1', "return clickCard('acc-detect');"),
    accWait('detected', "accSnap().rows.some((r) => r.slot === 'JIRA_TOKEN' && r.value === 'DECK_FAKE_API_TOKEN')"),
    accEv('cardDet', 'return accSnap();'),
    ...shots('plugins-access-detected.png'),
    accEv('pickSlack', "return setName('SLACK_TOKEN', 'SLACK_USER_TOKEN');"),
    accEv('cardPick', 'return accSnap();'),
    accEv('ipcDetectToken', "return P('detectToken', await window.api.pluginsDetect({ token: plg.card.token }));"),
    accEv('confirmImport', "return clickCard('card-confirm');"),
    accWait('imported', "rowEl('brief2') && !cardSnap()"),
    envOf('envBrief2', 'brief2'),
    // D22 on the card: a hostile NAME is refused by the host, nothing is copied
    ...openImport(srcB3, 'card3'),
    accEv('evil3', `return setName('JIRA_URL', ${JSON.stringify(evil)});`),
    accEv('confirm3', "return clickCard('card-confirm');"),
    accWait('refused3', 'accSnap() && accSnap().error'),
    accEv('card3Err', 'return accSnap();'),
    lsStep('ls3', R.pluginsDir), existsStep('marker3', marker),
    accEv('cancel3', "return clickCard('card-cancel');"), cardWait('closed3', '!cardSnap()'),
    // the screen of `brief`
    ...openAccess('brief', 'accPre', 6),
    accEv('accPre', 'return accSnap();'),
    ...shots('plugins-access-edit.png'),
    accEv('detect2', "return clickCard('acc-detect');"),
    accWait('detected2', "accSnap().rows.some((r) => r.slot === 'JIRA_TOKEN' && r.value === 'DECK_FAKE_API_TOKEN')"),
    accEv('accDet', 'return accSnap();'),
    accEv('set2', "setName('SLACK_TOKEN', 'SLACK_USER_TOKEN'); return setName('JIRA_URL', 'JIRA_BASE');"),
    envOf('envBriefBefore', 'brief'),
    accEv('save', "return clickCard('card-confirm');"),
    cardWait('saved', '!cardSnap()'),
    envOf('envBriefSaved', 'brief'),
    // V26: after « Enregistrer » the repaint gives the focus back to « Modifier », now in the Paramètres tab
    uiEv('saveFocus', "const ok = await until(() => Boolean(accessBtn()) && document.activeElement === accessBtn(), 3000); const a = document.activeElement; return { ok, active: a ? (a.dataset.act || a.id || a.tagName) : null };"),
    ...openAccess('brief', 'accSavedOpen', 6),
    accEv('accSaved', 'return accSnap();'),
    accEv('ipcAccess', "return P('accessBrief', await window.api.pluginsAccess('brief'));"),
    // D22 on the screen
    accEv('evilSet', `return setName('JIRA_EMAIL', ${JSON.stringify(evil)});`),
    accEv('saveEvil', "return clickCard('card-confirm');"),
    accWait('refusedEvil', 'accSnap() && accSnap().error'),
    accEv('accEvil', 'return accSnap();'),
    envOf('envBriefAfterEvil', 'brief'), existsStep('markerEdit', marker),
    accEv('cancelEvil', "return clickCard('card-cancel');"), cardWait('closedEvil', '!cardSnap()'),
    // D23: a required slot cleared
    ...openAccess('okp', 'okpOpen', 2),
    accEv('okpPre', 'return accSnap();'),
    accEv('okpClear', "return setName('JIRA_TOKEN', '');"),
    accEv('okpMid', 'return accSnap();'),
    accEv('okpSave', "return clickCard('card-confirm');"),
    cardWait('okpSaved', '!cardSnap()'),
    uiWait('okpUnready', "rowOf('okp').status.includes('À configurer')"),
    uiEv('okpRow', "const row = rowOf('okp'); await openDetail('okp'); goTab('settings'); row.swDis = sw().dis; return { row, sum: ($q('#plg-set-sum') || {}).textContent };"),
    uiEv('okpEnable', "return P('okpEnable', await window.api.pluginsSetEnabled('okp', true));"),
    uiEv('okpRun', "return P('okpRun', await window.api.pluginsRunNow('okp'));"),
    envOf('envOkp', 'okp'),
    uiEv('domText', "return $q('#plugin-panel').textContent;"),
    uiEv('closed', "$q('#plg-close').click(); return true;"),
    IPC_OUT,
  ]);
  out.afterB1 ={ counts: R.counts(), state: R.state(), dirs: fs.readdirSync(R.pluginsDir).sort(), markerExists: fs.existsSync(marker) };
  out.b2 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 3;' },
    OPEN_BTN,
    uiWait('rows', 'document.querySelectorAll("#plg-list .plg-row").length === 3'),
    uiEv('lines', ROW_LINES),
    ...openAccess('brief', 'accB2Open', 6),
    accEv('accB2', 'return accSnap();'),
    accEv('ipcAccess', "return P('accessBrief', await window.api.pluginsAccess('brief'));"),
    uiEv('domText', "return $q('#plugin-panel').textContent;"),
    IPC_OUT,
  ]);
  out.afterB2 ={ counts: R.counts(), state: R.state() };
  return out;
}

const SLOT_NAMES = SIX.map((s) => s.name);
const hostsOf = (c) => ((c && c.rows) || []).map((x) => x.host);
const valuesOf = (c) => Object.fromEntries(((c && c.rows) || []).map((x) => [x.slot, x.value]));
const BRIEF_MAP = { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN', SLACK_TOKEN: 'SLACK_USER_TOKEN', CLAUDE_KEY: 'CLAUDE_HARNESS_API_KEY', AIKIDO_KEY: 'AIKIDO_API_KEY' };

gate('g32 S19d (UI) import card: six rows from the manifest (label, required mark, NAME, status), « À associer » / « Facultatif » before any lookup, « Détecter » offered, nothing copied', async (t) => {
  const I = await RUNS.I;
  t.ok(!I.fatal, `scenario I ran (${I.fatal})`);
  if (I.fatal) return;
  ok2(t, I.b1, 'boot 1'); ok2(t, I.b2, 'boot 2');
  const r = I.b1.results;
  const c = r.cardPre || {};
  t.ok(c.kind === 'import' && (c.rows || []).length === 6 && sameJson(c.rows.map((x) => x.slot), SLOT_NAMES), `six rows in manifest order (${(c.rows || []).map((x) => x.slot)})`);
  t.ok((c.rows || []).every((x, i) => x.label === SIX[i].label && x.required === String(SIX[i].required) && x.sub.includes(SIX[i].name)), 'each row: label, required mark, the NAME the plugin reads');
  t.ok((c.rows || []).length === 6 && /facultatif/.test(c.rows[5].sub) && !/facultatif/.test(c.rows[0].sub), 'the optional slot says so, the required ones do not');
  t.ok((c.rows || []).every((x) => x.tag === 'INPUT' && x.value === '' && x.host === ''), 'every NAME field is empty and no host word is shown before a lookup');
  t.ok(sameJson((c.rows || []).map((x) => x.status), ['À associer', 'À associer', 'À associer', 'À associer', 'À associer', 'Facultatif']), `statuses before the lookup (${(c.rows || []).map((x) => x.status)})`);
  t.ok(c.detect && c.detect.text === 'Détecter' && c.detect.dis === false && c.confirm && c.confirm.text === 'Importer', `« Détecter » and « Importer » (${JSON.stringify([c.detect, c.confirm])})`);
  t.ok(/Le Deck ne lit jamais la valeur/.test(c.lock || ''), 'the promise: the Deck handles names, never values');
  t.ok(/0 variable/.test(c.sum || '') || /5 accès requis manquants/.test(c.sum || ''), `summary line (${c.sum})`);
  t.ok(!(r.lsAfterPick || []).includes('brief2'), 'nothing is copied before the confirm');
});

gate('g33 S19d (UI) « Détecter » on the card: single matches pre-filled, several -> a choice among the candidates, none -> « introuvable »; the map reaches plugins.json as NAMES and the import runs with it', async (t) => {
  const I = await RUNS.I;
  if (I.fatal) { t.ok(false, `scenario I (${I.fatal})`); return; }
  const r = I.b1.results;
  const c = r.cardDet || {};
  const by = (s) => (c.rows || []).find((x) => x.slot === s) || {};
  for (const s of ['JIRA_TOKEN', 'CLAUDE_KEY', 'AIKIDO_KEY']) t.ok(by(s).value === BRIEF_MAP[s] && by(s).host === 'présente', `${s} pre-filled with its single match (${JSON.stringify(by(s)).slice(0, 140)})`);
  const sl = by('SLACK_TOKEN');
  t.ok(sl.tag === 'SELECT' && sameJson(sl.options, ['', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN']) && sl.value === '' && sl.host === 'plusieurs trouvées' && /^2 variables trouvées/.test(sl.status), `two matches -> a choice (${JSON.stringify(sl)})`);
  for (const s of ['JIRA_URL', 'JIRA_EMAIL']) t.ok(by(s).host === 'introuvable' && by(s).value === '' && /^Introuvable/.test(by(s).status), `${s}: introuvable, nothing filled (${JSON.stringify(by(s)).slice(0, 140)})`);
  t.ok(valuesOf(r.cardPick).SLACK_TOKEN === 'SLACK_USER_TOKEN', 'the user picks one of the candidates');
  const d = r.ipcDetectToken || {};
  t.ok(d.ok === true && (d.rows || []).length === 6 && (d.rows || []).every((x) => sameJson(Object.keys(x).sort(), ['candidates', 'hints', 'label', 'mapped', 'name', 'required', 'status'])), 'plugins-detect({token}) answers names and statuses only');
  t.ok(sameMap(r.envBrief2, BRIEF_MAP), `the import carried the four NAMES (${JSON.stringify(r.envBrief2)})`);
  t.ok(sameMap(I.afterB1.state.brief2.envMap, BRIEF_MAP) && I.afterB1.state.brief2.enabled === true, 'brief2 is stored enabled with that map');
  t.ok(I.afterB1.dirs.includes('brief2'), `the imported plugin was copied and listed without a reboot (${I.afterB1.dirs})`);
  const det = (r.ipcOut || []).filter((p) => p.startsWith('["plugins-detect"'));
  t.ok(det.length >= 3, `main answered plugins-detect for the card, the probe's own call and the screen (${det.length})`);
});

gate('g34 S19d (UI) « Accès · Modifier »: each row has its Accès line; the screen lists the six slots with the host statuses; Détecter fills the unmapped ones; Enregistrer persists NAMES; the saved map survives a reboot', async (t) => {
  const I = await RUNS.I;
  if (I.fatal) { t.ok(false, `scenario I (${I.fatal})`); return; }
  const r = I.b1.results;
  const lines = r.lines || [];
  t.ok(lines.length === 2 && lines.every((l) => l.k === 'Accès' && l.btn === 'Modifier'), `every detail page carries « Accès · Modifier » (${JSON.stringify(lines)})`);
  t.ok(lines.every((l) => l.accessCtls === 1 && l.inCard === 1 && l.inHead === 0 && l.aria === `Modifier les accès de ${l.label}`), `V26: « Modifier » (data-act="access") lives in the « Accès » card of the Paramètres tab, one per page, none in the detail head (${JSON.stringify(lines.map((l) => [l.accessCtls, l.inCard, l.inHead, l.aria]))})`);
  t.ok((lines.find((l) => l.id === 'okp') || {}).sum === '2 variables associées', `the summary counts the associated names (${JSON.stringify(lines)})`);
  t.ok(r.saveFocus && r.saveFocus.ok === true, `V26: after « Enregistrer » the focus is back on « Modifier » of the Paramètres tab (${JSON.stringify(r.saveFocus)})`);
  const p = r.accPre || {};
  t.ok(p.kind === 'access' && p.title === 'Accès de Brief du jour' && (p.rows || []).length === 6 && p.confirm && p.confirm.text === 'Enregistrer' && p.detect && p.detect.text === 'Détecter', `the screen (${p.kind} | ${p.title})`);
  t.ok(sameJson(hostsOf(p), ['introuvable', 'introuvable', 'introuvable', 'plusieurs trouvées', 'introuvable', 'introuvable']), `statuses come from the host (${hostsOf(p)})`);
  t.ok(/^À configurer/.test(p.missing || '') && (p.missing || '').includes('Jira — jeton API') && !(p.missing || '').includes('Aikido'), `« À configurer » names the missing required labels (${p.missing})`);
  t.ok(sameMap(valuesOf(r.accDet), { JIRA_URL: '', JIRA_EMAIL: '', ...BRIEF_MAP, SLACK_TOKEN: '' }), `Détecter fills the single matches only (${JSON.stringify(valuesOf(r.accDet))})`);
  t.ok(sameMap(r.envBriefBefore, {}), 'Détecter and typing persist nothing');
  const saved = { ...BRIEF_MAP, JIRA_URL: 'JIRA_BASE' };
  t.ok(sameMap(r.envBriefSaved, saved), `Enregistrer stores the NAMES (${JSON.stringify(r.envBriefSaved)})`);
  const s = r.accSaved || {};
  t.ok(sameMap(valuesOf(s), { ...saved, JIRA_EMAIL: '' }) && sameJson(hostsOf(s), ['absente', 'introuvable', 'présente', 'présente', 'présente', 'présente']), `re-opened: stored names, host statuses (${hostsOf(s)})`);
  const b = I.b2.results.accB2 || {};
  t.ok(sameMap(valuesOf(b), valuesOf(s)) && sameJson(hostsOf(b), hostsOf(s)), 'D19 after a reboot: the screen shows the same names and statuses');
  t.ok(sameMap(I.afterB2.state.brief.envMap, saved), `plugins.json after the second boot (${JSON.stringify(I.afterB2.state.brief.envMap)})`);
  t.ok(I.afterB1.counts.run === 0 && I.afterB2.counts.run === 0, `no plugin was launched (${JSON.stringify([I.afterB1.counts, I.afterB2.counts])})`);
});

gate('g35 S19d D22 (UI): a NAME holding a shell command is refused with « Nom de variable invalide » on the card and on the screen; nothing saved, nothing copied, the file is never created', async (t) => {
  const I = await RUNS.I;
  if (I.fatal) { t.ok(false, `scenario I (${I.fatal})`); return; }
  const r = I.b1.results;
  const e3 = r.card3Err || {};
  t.ok(e3.kind === 'import' && /^Nom de variable invalide/.test(e3.error || '') && !/touch|\/tmp/.test(e3.error || ''), `card: the host line, the rejected text is not echoed (${e3.error})`);
  t.ok(!(r.ls3 || []).includes('brief3') && !I.afterB1.dirs.includes('brief3'), 'card: nothing copied');
  const ev2 = r.accEvil || {};
  t.ok(ev2.kind === 'access' && /^Nom de variable invalide/.test(ev2.error || '') && !/touch|\/tmp/.test(ev2.error || ''), `screen: the host line, the screen stays open (${ev2.error})`);
  t.ok(sameMap(r.envBriefAfterEvil, r.envBriefSaved), 'screen: the stored map is exactly what it was');
  t.ok(r.marker3 === false && r.markerEdit === false && I.afterB1.markerExists === false && !fs.existsSync(I.marker), `the marker file ${path.basename(I.marker)} was never created`);
});

gate('g36 S19d D23 (UI): a required slot cleared -> « À configurer » on the row, switch and « Lancer maintenant » disabled, the host refuses enable and run, no launch', async (t) => {
  const I = await RUNS.I;
  if (I.fatal) { t.ok(false, `scenario I (${I.fatal})`); return; }
  const r = I.b1.results;
  t.ok(sameJson(hostsOf(r.okpPre), ['présente', 'présente']) && r.okpPre.sum === '2 variables associées', `before: both names present (${hostsOf(r.okpPre)} | ${r.okpPre && r.okpPre.sum})`);
  t.ok(/^1 accès requis manquant/.test((r.okpMid || {}).sum || ''), `clearing the required field is said at once (${(r.okpMid || {}).sum})`);
  const row = (r.okpRow || {}).row || {};
  t.ok(/À configurer/.test(row.status) && row.on === 'false' && row.swDis === true && row.runDis === true, `the row (${JSON.stringify(row)})`);
  t.ok(/Jeton|Jira — jeton API/.test(row.note || ''), `the missing label is shown (${row.note})`);
  t.ok(r.okpEnable && r.okpEnable.ok === false && /^Accès requis manquant/.test(r.okpEnable.error || ''), `host refuses the switch (${JSON.stringify(r.okpEnable)})`);
  t.ok(r.okpRun && r.okpRun.ok === false && /^Accès requis manquant/.test(r.okpRun.error || ''), `host refuses the run (${JSON.stringify(r.okpRun)})`);
  t.ok(sameMap(r.envOkp, { AIKIDO_KEY: 'AIKIDO_API_KEY' }) && I.afterB1.state.okp.enabled === false && I.afterB1.counts.run === 0, 'the cleared slot is stored unmapped, the plugin stays off, 0 launch');
});

gate('g37 S19d D20: no fake value in anything the page saw (panel DOM, captured IPC answers of the panel and of the probe), in plugins.json, or in the step results', async (t) => {
  const I = await RUNS.I;
  if (I.fatal) { t.ok(false, `scenario I (${I.fatal})`); return; }
  t.ok(readTextOrEmpty(FAKE_SHELL).includes('FAKE-SECRET-'), 'the fixture shell does export fake values');
  const pay = [...(I.b1.results.ipcOut || []), ...(I.b2.results.ipcOut || [])];
  t.ok(pay.length >= 10, `main answers captured (${pay.length})`);
  for (const k of ['plugins-access', 'plugins-detect', 'plugins-set-env-map', 'plugins-import']) t.ok(pay.some((p) => p.startsWith(`["${k}"`)), `main answered ${k} during the scenario`);
  t.ok(!JSON.stringify([I.b1.results, I.b2.results]).includes('FAKE-SECRET'), '0 hit of a fake value in the IPC answers, the DOM text and every step result');
  t.ok(!JSON.stringify([I.afterB1.state, I.afterB2.state]).includes('FAKE-SECRET'), '0 hit in plugins.json');
  t.ok(I.b1.results.domText.length > 0 && I.b2.results.domText.length > 0, 'the panel text was scanned');
});

gate('g38 AMD-4 M2 busy card: Escape closes neither the card nor the panel while the card is busy, and the plugin card carries no data-sp-popup marker', async (t) => {
  const L = await RUNS.L;
  if (L.fatal) { t.ok(false, `scenario L (${L.fatal})`); return; }
  ok2(t, L.b1, 'boot');
  const b = (L.b1.results || {}).busy || {};
  t.ok(b.marker === false, `the open card has no data-sp-popup marker (${b.marker})`);
  t.ok(b.busy === true, `the card was busy when Escape arrived (${b.busy})`);
  t.ok(b.card === true && b.open === true && b.cls === true, `Escape while busy closed nothing (${JSON.stringify(b)})`);
});

gate('g39 simplified contracts: one result shape per producer, plain-string paths, baseNames required', async (t) => {
  const wrapped = rig({ plugins: { plugins: [PLUGIN] } }); // scan answers an array: a { plugins } wrapper is not a second shape
  const wHost = wrapped.boot();
  await wHost.rescan();
  t.ok(sameJson(wHost.list(), []), `scan wrapper not accepted (${JSON.stringify(wHost.list()).slice(0, 80)})`);
  const bare = rig({ plugins: [PLUGIN] }); // listNames answers { ok, names, note }: a bare array is not a second shape
  const bHost = bare.boot({ access: { ...bare.access, listNames: async () => Object.keys(FAKE_ENV) } });
  const b = await bHost.accessOf(PLUGIN.id);
  t.ok(b.ok === false && b.error === E_SHELL, `bare array listing refused (${JSON.stringify(b).slice(0, 80)})`);
  const nameless = rig({ plugins: [PLUGIN] }); // status rows are matched by slot name, never by position
  const nHost = nameless.boot({ access: { ...nameless.access, status: (slots) => slots.map(() => ({ status: 'présente', candidates: [] })) } });
  const n = await nHost.accessOf(PLUGIN.id);
  t.ok(n.ok === true && n.rows.length === PLUGIN.env.length && n.rows.every((x) => x.status === null), `nameless status rows ignored (${JSON.stringify(n).slice(0, 80)})`);
  let err = null;
  try { rig().boot({ baseNames: undefined }); } catch (e) { err = e; }
  t.ok(err instanceof TypeError, `create() without baseNames throws a TypeError (${err && err.name})`);
  t.ok(!/\blazy\b/.test(readTextOrEmpty(path.join(SRC, 'plugins.js'))), 'plugins.js: paths are plain strings, no lazy() helper');
});

function readTextOrEmpty(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }

// ---- review fixes of the Plugins tab (lot D-ui): unreadable shell, live run, replace card, __proto__ slots, card rows ---------
// Scenario J (shell = fake-shell.sh): `kept` (two slots, both mapped to names the shell does not export, three reports) and `protop`
// (slots named __proto__ and constructor). Boot 1 drives the replace card, the delete card and the protop screen; boot 2 swaps the
// shell for one that prints nothing (no marker: « Lecture du shell impossible ») and opens « Modifier » on `kept`.
const poll = (cond, ms) => `const end = Date.now() + ${ms}; while (Date.now() < end && !(${cond})) await new Promise((r) => setTimeout(r, 150));`;
const walkBytes = (root) => { let n = 0; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else n += fs.statSync(p).size; } })(root); return n; };
const PROTO_ENV = [{ name: '__proto__', label: 'Slot proto', required: false, hints: ['NOPEHINT'] }, { name: 'constructor', label: 'Slot ctor', required: false, hints: ['NOPEHINT'] }];
const META_HELP = `
  const metaSnap = () => { const c = $q('#plg-card'); const txt = (s) => { const n = $q(s, c); return n ? n.textContent : null; };
    return { dts: [...c.querySelectorAll('.plg-card-meta dt')].map((n) => n.textContent), source: txt('.plg-card-source'), dest: txt('.plg-card-dest') }; };
`;
const stateEnv = (as, statePath, id) => ({ op: 'main', as, code: `return Object.entries(JSON.parse(ctx.fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'))[${JSON.stringify(id)}].envMap);` });
const KEPT_MAP = [['JIRA_TOKEN', 'KEPT_TOKEN_NAME'], ['AIKIDO_KEY', 'KEPT_AIKIDO_NAME']];
async function scenarioJ() {
  const R = bootRig('j', FAKE_SHELL);
  installFixture(R.pluginsDir, { id: 'kept', label: 'Plugin gardé', env: [SIX[2], SIX[5]] });
  installFixture(R.pluginsDir, { id: 'protop', label: 'Plugin proto', env: PROTO_ENV });
  const src = installFixture(path.join(TMP, 'src-j'), { id: 'kept', label: 'Plugin gardé v2', env: [SIX[2], SIX[0]] });
  const dataRoot = path.join(R.userData, 'plugin-data');
  const reports = require(path.join(SRC, 'plugin-reports.js')).create(dataRoot, () => Date.parse(R.seedAt));
  ['2026-10-30T08:00:00', '2026-11-01T08:00:00', '2026-11-02T08:00:00'].forEach((at, i) => {
    R.seedAt = at;
    const e = reports.newEntry('kept', 'auto');
    fs.writeFileSync(e.reportPath, `<!doctype html><p>${'x'.repeat(200 * (i + 1))}</p>`);
    reports.finishEntry('kept', e.stem, { exit: 0 });
  });
  const seed = { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30 };
  fs.writeFileSync(R.statePath, JSON.stringify({ kept: { ...seed, envMap: Object.fromEntries(KEPT_MAP) }, protop: { ...seed, envMap: {} } }));
  const openProto = (as) => [accEv(`click-${as}`, "return clickAccess('protop');"),
    accWait(as, "accSnap() && accSnap().kind === 'access' && accSnap().rows.length === 2")];
  const out = { R, src, keptReportBytes: walkBytes(path.join(dataRoot, 'kept', 'reports')) };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 2;' },
    OPEN_BTN,
    uiWait('rows', 'document.querySelectorAll("#plg-list .plg-row").length === 2'),
    // D + F: the replace card of `kept`
    stubStep(src), { op: 'sleep', ms: 100 },
    uiEv('clickImport', "$q('#plg-import').click(); return true;"),
    accWait('replaceOpen', "accSnap() && accSnap().kind === 'import' && accSnap().rows.length === 2"),
    uiEv('replacePre', `${CARD_HELP}${ACC_HELP}${META_HELP} return { snap: accSnap(), ...metaSnap() };`),
    accEv('detectClick', "return clickCard('acc-detect');"),
    accEv('replaceDet', `${poll('accSnap() && accSnap().rows.some((r) => r.host)', 8000)} return accSnap();`),
    accEv('replaceCancel', "return clickCard('card-cancel');"), cardWait('replaceClosed', '!cardSnap()'),
    stateEnv('envKeptAfterCancel', R.statePath, 'kept'),
    // F: the delete card of `kept` (three reports)
    uiEv('clickDelete', "await openDetail('kept'); $q('#plg-dhead [data-act=\"delete\"]').click(); return true;"),
    cardWait('deleteOpen', "cardSnap() && cardSnap().kind === 'delete'"),
    cardEv('deleteCard', "const c = $q('#plg-card'); return { lines: [...c.querySelectorAll('.plg-card-impact p:not(.plg-card-path)')].map((n) => n.textContent), boxes: [...c.querySelectorAll('.plg-card-path')].map((n) => n.textContent), left: [...c.querySelectorAll('.plg-card-path')].map((n) => getComputedStyle(n).borderLeftWidth), impact: ($q('.plg-card-impact', c) || {}).textContent };"),
    cardEv('deleteCancel', "return clickCard('card-cancel');"), cardWait('deleteClosed', '!cardSnap()'),
    // E: slots named __proto__ and constructor
    ...openProto('protoOpen'),
    accEv('protoPre', 'return accSnap();'),
    accEv('protoSet', "setName('__proto__', 'MY_PROTO_NAME'); return setName('constructor', 'MY_CTOR_NAME');"),
    accEv('protoMid', 'return accSnap();'),
    accEv('protoSave', "return clickCard('card-confirm');"),
    cardWait('protoSaved', '!cardSnap()'),
    stateEnv('envProto', R.statePath, 'protop'),
    ...openProto('protoOpen2'),
    accEv('protoPost', 'return accSnap();'),
    accEv('protoClose', "return clickCard('card-cancel');"), cardWait('protoClosed', '!cardSnap()'),
  ]);
  out.stateBefore = JSON.stringify(R.state());
  fs.writeFileSync(R.shell, '#!/bin/bash\nexec /bin/true "$@"\n', { mode: 0o755 }); // prints nothing: no marker, the listing fails
  out.b2 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 2;' },
    OPEN_BTN,
    uiWait('rows', 'document.querySelectorAll("#plg-list .plg-row").length === 2'),
    accEv('clickKept', "return clickAccess('kept');"),
    accWait('unreadable', 'accSnap() && accSnap().kind === "access" && accSnap().error'),
    accEv('keptScreen', 'return accSnap();'),
    accEv('keptSave', "const b = $q('#plg-card [data-act=\"card-confirm\"]'); const dis = b.disabled; b.click(); return { dis };"),
    { op: 'sleep', ms: 700 },
    accEv('keptAfter', 'return accSnap();'),
    accEv('keptCancel', "return clickCard('card-cancel');"),
  ]);
  out.stateAfter = JSON.stringify(R.state());
  return out;
}

// Scenario K: `live` runs for 9 s (its report is written at once). The Historique tab is visited during the run (C), its live row is
// opened (B) and the page waits for the run to end.
async function scenarioK() {
  const R = bootRig('k');
  const liveDir = installFixture(R.pluginsDir, { id: 'live', label: 'Plugin en cours', env: [], argv: ['run.py', '0', '9'] });
  // this plugin's own copy of the fixture also writes one journal line (a step in progress) before its marker line
  const livePy = path.join(liveDir, 'run.py');
  const journaled = fs.readFileSync(livePy, 'utf8').replace("print('fake-plugin-stdout', flush=True)",
    "print('::deck-step:: run start 1730000000000 appels Claude : abonnement', flush=True)\nprint('fake-plugin-stdout', flush=True)");
  if (!journaled.includes('::deck-step::')) throw new Error('scenario K: the journal line was not added to the fixture');
  fs.writeFileSync(livePy, journaled);
  fs.writeFileSync(R.statePath, JSON.stringify({ live: { enabled: false, lastAutoDate: '2026-11-03', retentionDays: 30, envMap: {} } }));
  const out = { R };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 1;' },
    OPEN_BTN,
    histWait('rows', "document.querySelectorAll('#plg-list .plg-row').length === 1"),
    histEv('run', "rowEl('live').querySelector('[data-act=\"run\"]').click(); return true;"),
    histWait('running', "rowOf('live').status === 'En cours…'"),
    histEv('openLive0', "return await openDetail('live');"),
    histEv('goHist', "goTab('history'); return true;"),
    histWait('liveRow', "hrows().length === 1 && hrows()[0].status === 'En cours…'"),
    histEv('goReport', "goTab('report'); return true;"),
    { op: 'sleep', ms: 600 },
    histEv('rapportDuring', "const v = $q('#plg-view'); return { children: v.childNodes.length, frames: v.querySelectorAll('iframe').length, text: v.textContent };"),
    // K5: the live journal is the Journal tab's view
    histEv('goJournal', "goTab('journal'); return true;"),
    { op: 'sleep', ms: 1200 },
    histEv('reportDuring', `${poll("$q('#plg-view .plg-journal li.plg-step')", 4000)} const v = $q('#plg-view'); const j = $q('.plg-journal', v); const t = j ? $q('.plg-fail-title', j) : null;
      return { children: v.childNodes.length, frames: v.querySelectorAll('iframe').length, text: v.textContent, status: rowOf('live').status, journal: !!j, title: t ? t.textContent : null, steps: j ? j.querySelectorAll('li.plg-step').length : 0 };`),
    histEv('goHist2', "goTab('history'); return true;"),
    histWait('liveRow2', 'hrows().length === 1'),
    histEv('openLive', "$q('#plg-hist .plg-hrow').click(); return true;"),
    { op: 'sleep', ms: 600 },
    histEv('liveView', "const v = $q('#plg-view'); const t = $q('.plg-fail-title', v); return { title: t ? t.textContent : null, texts: [...v.querySelectorAll('.plg-fail-text')].map((n) => n.textContent), frames: v.querySelectorAll('iframe').length, status: rowOf('live').status };"),
    // v3 flow (lot u3fix): the live entry followed on the Journal tab ends on the Rapport tab by itself, with its frame and no tab click
    histEv('afterExit', `{ ${poll("/^Dernier rapport/.test(rowOf('live').status)", 18000)} } { ${poll("$q('#plg-view iframe')", 8000)} } const v = $q('#plg-view'); const t = $q('.plg-fail-title', v); return { frames: v.querySelectorAll('iframe').length, title: t ? t.textContent : null, status: rowOf('live').status };`),
  ]);
  return out;
}

gate('g40 review A (UI): « Modifier » with an unreadable shell shows the host line, no « aucun accès », « Enregistrer » disabled; plugins.json is left byte for byte', async (t) => {
  const J = await RUNS.J;
  if (J.fatal) { t.ok(false, `scenario J (${J.fatal})`); return; }
  ok2(t, J.b2, 'boot 2 (unreadable shell)');
  const r = J.b2.results;
  const s = r.keptScreen || {};
  t.ok(s.kind === 'access' && s.error === 'Lecture du shell impossible', `the host line is shown (${s.kind} | ${s.error})`);
  t.ok(!/aucun accès/.test(s.text || ''), `no « Ce plugin ne demande aucun accès » (${(s.text || '').slice(0, 120)})`);
  t.ok(s.confirm && s.confirm.dis === true, `« Enregistrer » is disabled (${JSON.stringify(s.confirm)})`);
  t.ok(r.keptSave && r.keptSave.dis === true && r.keptAfter && r.keptAfter.kind === 'access', `a click on it does nothing, the screen stays (${JSON.stringify(r.keptSave)} | ${(r.keptAfter || {}).kind})`);
  t.ok(J.stateBefore === J.stateAfter && JSON.parse(J.stateAfter).kept && JSON.stringify(Object.entries(JSON.parse(J.stateAfter).kept.envMap)) === JSON.stringify(KEPT_MAP), `plugins.json unchanged, the saved map of \`kept\` is still there (${J.stateAfter})`);
});

gate('g41 review B (UI): a live run opened from Historique reads « En cours… » (no « no report » line) and shows its report once the run ends', async (t) => {
  const K = await RUNS.K;
  if (K.fatal) { t.ok(false, `scenario K (${K.fatal})`); return; }
  ok2(t, K.b1, 'boot 1');
  const r = K.b1.results;
  const v = r.liveView || {};
  t.ok(/^En cours…/.test(v.title || ''), `title of the live entry (${v.title})`);
  t.ok(!(v.texts || []).some((x) => /pas écrit de rapport/.test(x)) && v.frames === 0, `no « no report » line, no frame yet (${JSON.stringify(v.texts)} ${v.frames})`);
  const a = r.afterExit || {};
  t.ok(a.frames === 1 && a.title === null, `after the exit its report shows on the Rapport tab (${a.frames} frame, title ${a.title}, row: ${a.status})`);
});

gate('g42 review C (UI): the Rapport tab shows the live journal after visiting Historique during a run', async (t) => {
  const K = await RUNS.K;
  if (K.fatal) { t.ok(false, `scenario K (${K.fatal})`); return; }
  ok2(t, K.b1, 'boot 1');
  const d = (K.b1.results || {}).reportDuring || {};
  t.ok(d.status === 'En cours…' && d.children > 0 && d.journal === true && /^En cours…/.test(d.title || '') && d.steps >= 1 && d.frames === 0,
    `run in progress: the view holds div.plg-journal (head « En cours… », at least one li.plg-step), no frame, never empty (${JSON.stringify(d)})`);
  t.ok(!/pas produit de rapport/.test(d.text || ''), `and never claims « no report » about a run that has not ended (${d.text})`);
  const rp = ((K.b1.results || {}).rapportDuring) || {};
  t.ok(rp.children > 0 && rp.frames === 0 && /En cours/.test(rp.text || '') && !/pas produit de rapport/.test(rp.text || ''), `the Rapport tab, back from Historique during the run, is never empty and claims no « no report » (${JSON.stringify(rp)})`);
});

gate('g43 review D (UI): the replace card keeps the installed names for the slots the new manifest declares; « Détecter » leaves them', async (t) => {
  const J = await RUNS.J;
  if (J.fatal) { t.ok(false, `scenario J (${J.fatal})`); return; }
  ok2(t, J.b1, 'boot 1');
  const r = J.b1.results;
  const c = (r.replacePre || {}).snap || {};
  t.ok(c.kind === 'import' && sameJson((c.rows || []).map((x) => x.slot), ['JIRA_TOKEN', 'JIRA_URL']), `rows = the new manifest's slots (${JSON.stringify((c.rows || []).map((x) => x.slot))})`);
  const tok = (c.rows || []).find((x) => x.slot === 'JIRA_TOKEN') || {};
  const url = (c.rows || []).find((x) => x.slot === 'JIRA_URL') || {};
  t.ok(tok.value === 'KEPT_TOKEN_NAME' && tok.status !== 'À associer', `the kept slot shows its installed name, not « À associer » (${tok.value} | ${tok.status})`);
  t.ok(url.value === '' && url.status === 'À associer', `the new slot stays to associate (${url.value} | ${url.status})`);
  const sum = c.sum || '';
  t.ok(sum === '1 accès requis manquant', `summary counts the kept name: only the new required slot is missing (${sum})`);
  const d = ((r.replaceDet || {}).rows || []).find((x) => x.slot === 'JIRA_TOKEN') || {};
  t.ok(d.value === 'KEPT_TOKEN_NAME', `« Détecter » did not overwrite the kept name (${d.value})`);
  t.ok(sameJson(r.envKeptAfterCancel, KEPT_MAP), `cancel leaves plugins.json alone (${JSON.stringify(r.envKeptAfterCancel)})`);
});

gate('g44 review E (UI): slots named __proto__ and constructor read blank, accept a NAME, reach plugins.json as data and come back', async (t) => {
  const J = await RUNS.J;
  if (J.fatal) { t.ok(false, `scenario J (${J.fatal})`); return; }
  ok2(t, J.b1, 'boot 1');
  const r = J.b1.results;
  const vals = (s) => Object.fromEntries(((s || {}).rows || []).map((x) => [x.slot, x.value]));
  t.ok(vals(r.protoPre)['__proto__'] === '' && vals(r.protoPre).constructor === '', `both rows start blank (${JSON.stringify(((r.protoPre || {}).rows || []).map((x) => x.value))})`);
  t.ok(((r.protoMid || {}).rows || []).map((x) => x.value).join(',') === 'MY_PROTO_NAME,MY_CTOR_NAME', `typed names stay in the rows (${JSON.stringify(((r.protoMid || {}).rows || []).map((x) => x.value))})`);
  t.ok(sameJson(r.envProto, [['__proto__', 'MY_PROTO_NAME'], ['constructor', 'MY_CTOR_NAME']]) || sameJson(r.envProto, [['constructor', 'MY_CTOR_NAME'], ['__proto__', 'MY_PROTO_NAME']]), `plugins.json holds both slots (${JSON.stringify(r.envProto)})`);
  t.ok(((r.protoPost || {}).rows || []).map((x) => x.value).join(',') === 'MY_PROTO_NAME,MY_CTOR_NAME', `reopened: both names come back (${JSON.stringify(((r.protoPost || {}).rows || []).map((x) => x.value))})`);
});

gate('g45 review F (UI): the import card lists « Source » and « Copié dans »; the delete card follows the validated artboard', async (t) => {
  const J = await RUNS.J;
  if (J.fatal) { t.ok(false, `scenario J (${J.fatal})`); return; }
  ok2(t, J.b1, 'boot 1');
  const r = J.b1.results;
  const m = r.replacePre || {};
  t.ok(sameJson(m.dts, ['Déclencheur', 'Commande', 'Source', 'Copié dans']), `import card rows (${JSON.stringify(m.dts)})`);
  t.ok(m.source === fs.realpathSync(J.src) && m.dest === path.join(J.R.pluginsDir, 'kept'), `source folder and destination as paths (${m.source} | ${m.dest})`);
  const d = r.deleteCard || {};
  t.ok(sameJson(d.lines, ['Le Deck efface sa copie :', `et ses données, dont ses 3 rapports (${frBytes(J.keptReportBytes)}) :`,
    "Ses accès associés partent avec. Ton dossier source et tes variables d'environnement ne sont pas touchés."]), `delete card wording (${JSON.stringify(d.lines)})`);
  t.ok(sameJson(d.boxes, [path.join(fs.realpathSync(J.R.pluginsDir), 'kept'), path.join(fs.realpathSync(path.join(J.R.userData, 'plugin-data')), 'kept')]), `the two folders it removes (${JSON.stringify(d.boxes)})`);
  t.ok((d.left || []).length === 2 && d.left.every((w) => w === '0px'), `no left accent bar on the path boxes (${JSON.stringify(d.left)})`);
});

// ---- AMD-4: the Plugins header button and its workspace overlay ----------------------------------------------------------
// Scenario L: one boot, the `fake` plugin, NO pane ever spawned. Every open is a trusted mouse click on the header button (tclick,
// sendInputEvent at its centre), every Escape a trusted key (tkey); only the delete-card opener and #plg-close use the page's own click().
async function scenarioL() {
  const R = bootRig('l');
  installFixture(R.pluginsDir);
  const TOG = { op: 'tclick', sel: '#plugin-toggle' };
  const ROOM = { op: 'tclick', sel: '#room-toggle' };
  const snapOf = (as) => uiEv(as, `const p = $q('#plugin-panel'); return { plg: plg.open, cls: p.classList.contains('open'), hidden: p.hidden, room: $q('#room-panel').classList.contains('open'),
    usage: usageState.open === true, aj: aj.open === true, sp: sp.open === true, spHidden: $q('#side-panel').hidden, mode: document.body.dataset.mode, panes: panes.size,
    frames: document.querySelectorAll('#plugin-panel iframe').length };`);
  const out = { R };
  out.b1 = await runBoot(R, [
    { op: 'waitFor', as: 'listed', code: 'return (await window.api.pluginsList()).length === 1;' },
    // A4-1: the button, before any click (body[data-mode] is set by the first mode switch only: absent = Code)
    uiEv('btn', `const b = $q('#plugin-toggle'), r = $q('#room-toggle'); const cs = (n) => { const c = getComputedStyle(n); return [c.display, c.height, c.borderRadius, c.fontSize]; };
      return { exists: !!b, parent: b && b.parentElement && b.parentElement.id, prev: b && b.previousElementSibling && b.previousElementSibling.id, text: b && b.textContent,
        visible: !!b && b.getClientRects().length > 0, cs: b && cs(b), csRoom: cs(r), panes: panes.size, mode: document.body.dataset.mode || 'code' };`),
    // A4-2: a trusted click with no pane
    TOG,
    uiWait('rows1', "document.querySelectorAll('#plg-list .plg-row').length === 1"),
    uiEv('open1', `const p = $q('#plugin-panel'), w = $q('#workspace'), pr = p.getBoundingClientRect(), wr = w.getBoundingClientRect();
      const hit = document.elementFromPoint(wr.left + wr.width / 2, wr.top + wr.height / 2);
      return { panes: panes.size, parent: p.parentElement && p.parentElement.id, hidden: p.hidden, cls: p.classList.contains('open'),
        edges: [pr.left - wr.left, pr.top - wr.top, pr.right - wr.right, pr.bottom - wr.bottom].map((x) => Math.abs(x)),
        hit: !!hit && !!hit.closest('#plugin-panel'), spHidden: $q('#side-panel').hidden, sp: sp.open, plg: plg.open, rows: snap().map((r) => r.id) };`),
    // A4-2: Escape closes the panel; an open card closes first; the close control closes it
    { op: 'tkey', key: 'Escape' },
    snapOf('esc1'),
    // `hidden` follows a 380 ms timer; a window that never shows may throttle timers, so poll (up to 3 s) and report the delay seen
    uiEv('esc1b', `const p = $q('#plugin-panel'), t0 = Date.now(); while (!p.hidden && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
      return { hidden: p.hidden, ms: Date.now() - t0, frames: document.querySelectorAll('#plugin-panel iframe').length };`),
    TOG,
    uiEv('openCard', `await openDetail('fake'); $q('#plg-dhead [data-act="delete"]').click(); return true;`),
    uiWait('cardShown', "$q('#plg-card') && !$q('#plg-card').hidden"),
    { op: 'tkey', key: 'Escape' },
    uiEv('escCard', "return { cardHidden: $q('#plg-card').hidden, plg: plg.open, page: $q('#plugin-panel').dataset.page };"),
    // K5 order: card, (full screen), detail page -> list page, then the panel
    { op: 'tkey', key: 'Escape' },
    uiEv('escDetail', "return { plg: plg.open, cls: $q('#plugin-panel').classList.contains('open'), page: $q('#plugin-panel').dataset.page, shown: shownTitle() };"),
    { op: 'tkey', key: 'Escape' },
    snapOf('escPanel'),
    TOG,
    uiEv('closeBtn', "$q('#plg-close').click(); return { plg: plg.open, cls: $q('#plugin-panel').classList.contains('open') };"),
    // A4-3 (a) Room
    TOG, ROOM, snapOf('aRoom'), TOG, snapOf('aPlg'),
    // (b) the usage page
    uiEv('bOpen', 'openUsagePage(); return true;'),
    snapOf('bUsage'),
    TOG, snapOf('bPlg'),
    // (c) the agent journal (its closes run before any fetch)
    uiEv('cOpen', "Promise.resolve(window.openAgentJournal({ sessionId: 'probe', toolUseId: 'probe' })).catch(() => {}); return true;"),
    snapOf('cAj'),
    TOG, snapOf('cPlg'),
    // (d) the side panel, opened as the Terminal tab (no pane needed)
    uiEv('dOpen', "openSidePanel('terminal'); return true;"),
    snapOf('dSp'),
    TOG, snapOf('dPlg'),
    // A4-4: the AI switch closes Plugins; a click in AI mode returns to Code mode first
    uiEv('aiSwitch', "setMode('ai'); return { plg: plg.open, cls: $q('#plugin-panel').classList.contains('open') };"),
    uiWait('aiMode', "document.body.dataset.mode === 'ai'", 20000),
    snapOf('aiSnap'),
    TOG, snapOf('aiBack'),
    // M2: Escape while the card is busy (the confirm click sets busy synchronously, the key arrives in the same tick)
    uiEv('busyOpen', `await openDetail('fake'); $q('#plg-dhead [data-act="delete"]').click(); return true;`),
    uiWait('busyCard', "plg.card && plg.card.kind === 'delete' && !$q('#plg-card').hidden"),
    uiEv('busy', `const card = $q('#plg-card'); const marker = card.hasAttribute('data-sp-popup');
      card.querySelector('[data-act="card-confirm"]').click();
      const busy = !!plg.card && plg.card.busy === true;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { marker, busy, card: !!plg.card, open: plg.open, cls: $q('#plugin-panel').classList.contains('open') };`),
  ]);
  return out;
}

// Scenario M (AMD-4 A4-6): one boot, the `fake` plugin and ONE listed session (a fake transcript + a fake claude that only reads stdin).
// Every row click is a trusted mouse click; the Plugins panel is opened by the header button, then again (page click) for the live-pane path.
async function scenarioM() {
  const R = bootRig('m');
  installFixture(R.pluginsDir);
  const ws = path.join(R.dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const projDir = path.join(R.dir, 'projects', ws.replace(/\//g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const sid = 'aaaaaaaa-1111-4bbb-8ccc-aaaaaaaaaaaa';
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: ws, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'probe session' } })}\n`
    + `${JSON.stringify({ type: 'custom-title', customTitle: 'Probe session', sessionId: sid })}\n`);
  const bin = path.join(R.dir, 'fake-claude.sh');
  fs.writeFileSync(bin, '#!/bin/bash\nstty raw -echo 2>/dev/null\nexec cat > /dev/null\n', { mode: 0o755 });
  const ROW = { op: 'tclick', sel: '.session-row' };
  const snapM = (as) => uiEv(as, `const p = $q('#plugin-panel'), r = $q('.session-row'), b = r && r.getBoundingClientRect();
    const hit = b && document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    return { plg: plg.open, cls: p.classList.contains('open'), rows: document.querySelectorAll('.session-row').length,
      vis: !!b && b.width > 0 && b.height > 0, hit: !!hit && hit.closest('.session-row') === r, panes: panes.size };`);
  const out = { R };
  out.b1 = await runBoot(R, [
    uiWait('row', "document.querySelectorAll('.session-row').length === 1"),
    OPEN_BTN,
    snapM('before'),
    ROW, // resume path: the session has no live pane yet
    uiWait('pane1', 'panes.size === 1'),
    snapM('after'),
    uiEv('reopen', "if (!plg.open) $q('#plugin-toggle').click(); return plg.open;"),
    { op: 'sleep', ms: 900 },
    snapM('before2'),
    ROW, // live path: findLivePane -> selectPane
    snapM('after2'),
  ], { bin });
  return out;
}

const lres = async (t) => {
  const L = await RUNS.L;
  if (L.fatal) { t.ok(false, `scenario L (${L.fatal})`); return null; }
  ok2(t, L.b1, 'boot');
  return L.b1.results || {};
};

gate('g46 AMD-4 A4-1 header button: « Plugins » right after « Room » in #header-right, same pill look as « Room », visible in Code mode with no pane', async (t) => {
  const r = await lres(t);
  if (!r) return;
  const b = r.btn || {};
  t.ok(b.exists === true, '#plugin-toggle exists');
  t.ok(b.parent === 'header-right' && b.prev === 'room-toggle', `right after #room-toggle in #header-right (${b.parent} | ${b.prev})`);
  t.ok(/Plugins/.test(b.text || ''), `its text holds Plugins (${b.text})`);
  t.ok(b.visible === true, 'it has a layout box (visible)');
  t.ok(!!b.cs && sameJson(b.cs, b.csRoom), `display, height, border-radius, font-size equal those of #room-toggle (${JSON.stringify(b.cs)} | ${JSON.stringify(b.csRoom)})`);
  t.ok(b.panes === 0 && b.mode === 'code', `no pane, Code mode (${b.panes} | ${b.mode})`);
});

gate('g47 AMD-4 A4-2 trusted open with no pane: a mouse click on the header button shows #plugin-panel over #workspace, the fake row listed, the side panel closed', async (t) => {
  const r = await lres(t);
  if (!r) return;
  const o = r.open1 || {};
  t.ok(o.panes === 0, `no pane was spawned (${o.panes})`);
  t.ok(o.parent === 'workspace' && o.hidden === false && o.cls === true, `#plugin-panel is a visible .open child of #workspace (${JSON.stringify([o.parent, o.hidden, o.cls])})`);
  t.ok(Array.isArray(o.edges) && o.edges.length === 4 && o.edges.every((x) => x <= 1), `its rect equals the #workspace rect (${JSON.stringify(o.edges)})`);
  t.ok(o.hit === true, 'the workspace centre lies inside #plugin-panel');
  t.ok(o.spHidden === true && o.sp === false, `the side panel is closed (${o.spHidden} | ${o.sp})`);
  t.ok(o.plg === true && sameJson(o.rows, ['fake']), `plg.open and the fake row listed (${o.plg} | ${JSON.stringify(o.rows)})`);
});

gate('g48 AMD-4 A4-2 Escape and close control: Escape closes the panel, an open card closes first, #plg-close closes it', async (t) => {
  const r = await lres(t);
  if (!r) return;
  const a = r.esc1 || {}, b = r.esc1b || {}, c = r.escCard || {}, d = r.escPanel || {}, e = r.closeBtn || {};
  t.ok(a.plg === false && a.cls === false, `Escape: plg.open false and no .open (${JSON.stringify([a.plg, a.cls])})`);
  t.ok(b.hidden === true && b.frames === 0, `hidden after the fade-out, no iframe left (${JSON.stringify([b.hidden, b.frames])}, polled ${b.ms} ms)`);
  t.ok(c.cardHidden === true && c.plg === true && c.page === 'detail', `Escape with a card open closes the card only, the detail page stays (${JSON.stringify(c)})`);
  const dt = r.escDetail || {};
  t.ok(dt.plg === true && dt.cls === true && dt.page === 'list' && dt.shown === null, `the next Escape leaves the detail page for the list page, the panel stays open (${JSON.stringify(dt)})`);
  t.ok(d.plg === false && d.cls === false, `the Escape after that closes the panel (${JSON.stringify([d.plg, d.cls])})`);
  t.ok(e.plg === false && e.cls === false, `#plg-close closes it (${JSON.stringify(e)})`);
});

gate('g49 AMD-4 A4-3 one right-hand surface: Plugins and Room, the usage page, the agent journal, the side panel close each other', async (t) => {
  const r = await lres(t);
  if (!r) return;
  const s = (k) => r[k] || {};
  t.ok(s('aRoom').room === true && s('aRoom').plg === false && s('aRoom').cls === false, `(a) opening Room closes Plugins (${JSON.stringify(s('aRoom'))})`);
  t.ok(s('aPlg').plg === true && s('aPlg').room === false, `(a) opening Plugins closes Room (${JSON.stringify(s('aPlg'))})`);
  t.ok(s('bUsage').usage === true && s('bUsage').plg === false && s('bUsage').cls === false, `(b) opening the usage page closes Plugins (${JSON.stringify(s('bUsage'))})`);
  t.ok(s('bPlg').plg === true && s('bPlg').usage === false, `(b) opening Plugins closes the usage page (${JSON.stringify(s('bPlg'))})`);
  t.ok(s('cAj').aj === true && s('cAj').plg === false && s('cAj').cls === false, `(c) opening the agent journal closes Plugins (${JSON.stringify(s('cAj'))})`);
  t.ok(s('cPlg').plg === true && s('cPlg').aj === false, `(c) opening Plugins closes the agent journal (${JSON.stringify(s('cPlg'))})`);
  t.ok(s('dSp').sp === true && s('dSp').spHidden === false && s('dSp').plg === false, `(d) opening a side tab closes Plugins (${JSON.stringify(s('dSp'))})`);
  t.ok(s('dPlg').plg === true && s('dPlg').sp === false && s('dPlg').spHidden === true, `(d) opening Plugins closes the side panel (${JSON.stringify(s('dPlg'))})`);
  t.ok(s('dPlg').panes === 0, 'no pane was spawned in the whole scenario');
});

gate('g50 AMD-4 A4-4 AI switch: switching to AI mode closes Plugins at once; a click on the button in AI mode returns to Code mode, then opens it', async (t) => {
  const r = await lres(t);
  if (!r) return;
  const a = r.aiSwitch || {}, b = r.aiSnap || {}, c = r.aiBack || {};
  t.ok(a.plg === false && a.cls === false, `setMode('ai') closed Plugins in the same evaluation (${JSON.stringify(a)})`);
  t.ok(b.mode === 'ai' && b.plg === false, `AI mode reached, Plugins still closed (${JSON.stringify([b.mode, b.plg])})`);
  t.ok(c.mode === 'code' && c.plg === true && c.cls === true, `the click returned to Code mode and opened Plugins (${JSON.stringify([c.mode, c.plg, c.cls])})`);
});

gate('g51 AMD-4 A4-6 a sidebar session-row click closes Plugins: a trusted click on a row (resume path, then live-pane path) leaves plg.open false and #plugin-panel without .open', async (t) => {
  const M = await RUNS.M;
  if (M.fatal) { t.ok(false, `scenario M (${M.fatal})`); return; }
  ok2(t, M.b1, 'boot');
  const r = M.b1.results || {};
  const s = (k) => r[k] || {};
  t.ok(s('before').rows === 1 && s('before').vis === true && s('before').hit === true, `the session row is listed, visible and hit-testable while Plugins is open (${JSON.stringify(s('before'))})`);
  t.ok(s('before').plg === true && s('before').cls === true && s('before').panes === 0, `Plugins is open, no pane yet (${JSON.stringify(s('before'))})`);
  t.ok(s('after').plg === false && s('after').cls === false, `a row click that resumes the session closed Plugins (${JSON.stringify(s('after'))})`);
  t.ok(s('after').panes === 1, `the click still opened the session (${s('after').panes} pane)`);
  t.ok(s('before2').plg === true && s('before2').cls === true, `Plugins reopened (${JSON.stringify(s('before2'))})`);
  t.ok(s('after2').plg === false && s('after2').cls === false, `a row click on the already live session closed Plugins (${JSON.stringify(s('after2'))})`);
  t.ok(s('after2').panes === 1, `still one pane (${s('after2').panes})`);
});

gate('g52 AMD-4 simplification: one Escape handler for the card (static: no onCardKey, no card keydown listener, openPluginPanel module-private; behaviour: the card closes first, then the panel)', async (t) => {
  const raw = readTextOrEmpty(PANEL_JS);
  const code = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  t.ok(raw.length > 0 && !/onCardKey/.test(raw), 'plugin-panel.js holds no onCardKey');
  t.ok(!/card\.addEventListener\(\s*'keydown'/.test(code), 'the card has no keydown listener of its own');
  t.ok((code.match(/key\s*!==\s*'Escape'/g) || []).length === 1, `exactly one Escape test in the module (${(code.match(/key\s*!==\s*'Escape'/g) || []).length})`);
  t.ok(!/export\s+function\s+openPluginPanel/.test(code) && /function\s+openPluginPanel/.test(code), 'openPluginPanel is declared but not exported');
  const r = await lres(t);
  if (!r) return;
  const c = r.escCard || {}, d = r.escPanel || {};
  const dt = r.escDetail || {};
  t.ok(c.cardHidden === true && c.plg === true && c.page === 'detail', `a trusted Escape with the delete card open closes the card only (${JSON.stringify(c)})`);
  t.ok(dt.plg === true && dt.page === 'list', `the next trusted Escape leaves the detail page for the list (${JSON.stringify(dt)})`);
  t.ok(d.plg === false && d.cls === false, `the third trusted Escape closes the panel (${JSON.stringify([d.plg, d.cls])})`);
});

// K1 daily skip (plugins-v4 lot c1): an exit-0 entry WITH a report today satisfies the daily rule, whatever its trigger.
const TODAY = '2026-11-03';
const YESTERDAY = '2026-11-02';

gate('g53 K1: a manual entry of today (exit 0 + report) skips the daily run: nothing started, no claim, lastAutoDate unchanged', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: YESTERDAY }));
  r.entries['daily-brief'] = [runEntry('2026-11-03T08:10', { trigger: 'manual', exit: 0, hasReport: true })];
  const res = await r.boot().startup();
  t.ok(r.calls.run.length === 0, `no run started (${r.calls.run.length})`);
  t.ok(sameJson(res, { ok: true, started: [] }), `startup answers nothing started (${JSON.stringify(res)})`);
  t.ok(r.state()['daily-brief'].lastAutoDate === YESTERDAY, `lastAutoDate unchanged (${r.state()['daily-brief'].lastAutoDate})`);
  t.ok(r.calls.list.length >= 1 && sameJson(r.calls.list[0], { id: 'daily-brief', filter: { date: TODAY } }), `list asked for today's entries (${JSON.stringify(r.calls.list[0])})`);
  const hold = await r.boot().startup();
  t.ok(r.calls.run.length === 0 && sameJson(hold.started, []), 'a second start-up the same day still starts nothing');
});

gate('g54 K1: an automatic entry of today (exit 0 + report) skips the daily run the same way', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: YESTERDAY }));
  r.entries['daily-brief'] = [runEntry('2026-11-03T07:05', { trigger: 'auto', exit: 0, hasReport: true })];
  const res = await r.boot().startup();
  t.ok(r.calls.run.length === 0, `no run started (${r.calls.run.length})`);
  t.ok(sameJson(res.started, []), `nothing started (${JSON.stringify(res.started)})`);
  t.ok(r.state()['daily-brief'].lastAutoDate === YESTERDAY, `lastAutoDate unchanged (${r.state()['daily-brief'].lastAutoDate})`);
});

gate('g55 K1 guard: no successful report today (failed entry, failed entry with a report, unfinished entry, list error) -> the run starts and claims today', async (t) => {
  const cases = [
    ['exit 1, no report', [runEntry('2026-11-03T08:00', { trigger: 'auto', exit: 1, hasReport: false })], false],
    ['exit 1, with a report', [runEntry('2026-11-03T08:00', { trigger: 'manual', exit: 1, hasReport: true })], false],
    ['exit null (never finished)', [runEntry('2026-11-03T08:00', { trigger: 'auto', exit: null, hasReport: false })], false],
    ['list throws', [runEntry('2026-11-03T08:00', { exit: 0, hasReport: true })], true],
  ];
  for (const [label, entries, listFails] of cases) {
    const r = rig({ plugins: [PLUGIN] });
    r.seed(readyEntry({ lastAutoDate: YESTERDAY }));
    r.entries['daily-brief'] = entries;
    r.listFails = listFails;
    const res = await r.boot().startup();
    t.ok(r.calls.run.length === 1 && r.calls.run[0].trigger === 'auto', `${label}: one auto run (${r.calls.run.length})`);
    t.ok(sameJson(res.started, ['daily-brief']), `${label}: started (${JSON.stringify(res.started)})`);
    t.ok(r.calls.run[0] && r.calls.run[0].stateAtRun['daily-brief'].lastAutoDate === TODAY, `${label}: claim on disk when the run starts`);
    t.ok(r.state()['daily-brief'].lastAutoDate === TODAY, `${label}: claimed today (${r.state()['daily-brief'].lastAutoDate})`);
  }
});

gate('g56 K1 guard: a successful report from yesterday only does not count -> the run starts and claims today', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: YESTERDAY }));
  r.entries['daily-brief'] = [runEntry('2026-11-02T23:50', { trigger: 'auto', exit: 0, hasReport: true })];
  const res = await r.boot().startup();
  t.ok(r.calls.run.length === 1 && r.calls.run[0].trigger === 'auto', `one auto run (${r.calls.run.length})`);
  t.ok(sameJson(res.started, ['daily-brief']), `started (${JSON.stringify(res.started)})`);
  t.ok(r.state()['daily-brief'].lastAutoDate === TODAY, `claimed today (${r.state()['daily-brief'].lastAutoDate})`);
});

gate('g57 K1 guard: exit 0 WITHOUT a report today does not count -> the run starts and claims today', async (t) => {
  const r = rig({ plugins: [PLUGIN] });
  r.seed(readyEntry({ lastAutoDate: YESTERDAY }));
  r.entries['daily-brief'] = [runEntry('2026-11-03T08:00', { trigger: 'manual', exit: 0, hasReport: false })];
  const res = await r.boot().startup();
  t.ok(r.calls.run.length === 1 && r.calls.run[0].trigger === 'auto', `one auto run (${r.calls.run.length})`);
  t.ok(sameJson(res.started, ['daily-brief']), `started (${JSON.stringify(res.started)})`);
  t.ok(r.state()['daily-brief'].lastAutoDate === TODAY, `claimed today (${r.state()['daily-brief'].lastAutoDate})`);
});

// ---- run ----------------------------------------------------------------------------------------------------
async function main() {
  let failed = 0;
  RUNS.A = settled(scenarioA());
  RUNS.B = settled(scenarioB());
  RUNS.C = settled(scenarioC());
  RUNS.D = settled(scenarioD());
  RUNS.E = settled(scenarioE());
  RUNS.F = settled(scenarioF());
  RUNS.G = settled(scenarioG());
  RUNS.H = settled(scenarioH());
  RUNS.I = settled(scenarioI());
  RUNS.J = settled(RUNS.I.then(() => scenarioJ())); // chained, so the peak of concurrent Deck boots stays the one of the older scenarios
  RUNS.K = settled(RUNS.H.then(() => scenarioK()));
  RUNS.L = settled(RUNS.D.then(() => scenarioL())); // chained after the short empty-state boot, same reason as J
  RUNS.M = settled(RUNS.L.then(() => scenarioM())); // one more boot, one at a time after L (same cap on concurrent Deck boots)
  for (const g of gates) {
    const bad = [];
    const t = { ok: (c, label) => { if (!c) bad.push(label); } };
    try { await g.fn(t); } catch (err) { bad.push(`threw: ${err && err.message}`); }
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'} ${g.name}${bad.length ? `\n     ${bad.join('\n     ')}` : ''}`);
  }
  console.log(failed === 0 ? `VERDICT: ALL GREEN (${gates.length}/${gates.length})` : `VERDICT: RED (${failed} failed of ${gates.length})`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* tmp dir stays */ }
  app.exit(failed === 0 ? 0 : 1);
}
if (CHILD) app.whenReady().then(childMain);
else {
  setTimeout(() => { console.log('VERDICT: TIMEOUT'); app.exit(2); }, 300000).unref();
  app.whenReady().then(main);
}
