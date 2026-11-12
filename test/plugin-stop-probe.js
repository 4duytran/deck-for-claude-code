'use strict';
// plugin-stop-probe - plugins-v4 K2 (plan Step c4, § 2.1 third bullet): host.stop and the daily claim of src/main/plugins.js,
// driven by the REAL runner and the REAL reports store, a fake long plugin in a TMP plugins dir and a fake login shell
// in the same TMP (no rc, no secret, no value read). Hermetic: one mkdtemp dir per rig, the host clock is frozen.
//   xvfb-run -a node_modules/.bin/electron test/plugin-stop-probe.js
// PLUGIN_STOP_SRC=<dir> points the probe at another copy of src/main (mutation proofs); default: this tree.
//
// Gates: k1 a stopped AUTO run keeps today's claim and the next startup() starts nothing | k2 a failed AUTO run (exit 1, or
//   ended from outside the Deck) still restores the claim | k3 a stopped MANUAL run leaves lastAutoDate alone | k4 the stop
//   refusals: idle, unknown, finished, runner « still-alive » | k5 list() after the stop (in flight, and a survivor of a
//   previous Deck instance): running false, latest.stopped true | k6 runNow after a stop starts a run
// k7-k10 (plan Step c5, § 2.1 fourth bullet) boot the REAL app (main.js, throwaway userData / plugins dir / fake shell) and
//   drive window.api like the renderer: k7 plugins-stop ends the run and plugins-changed follows | k8 plugins-delete on a
//   running plugin: process gone, then folder, state entry and data removed, answer ok | k9 refusals: a non-id request
//   stops nothing, and a failed stop answers its refusal on plugins-delete and removes nothing | k10 window.api.pluginsStop
//   exists and plugins-stop is handled once. The app boots from this tree (main.js), whatever PLUGIN_STOP_SRC says.
// k11-k13 (plan Step u5, § 2.1 renderer words) drive the Plugins panel of that app with real clicks: k11 a running plugin shows « Arrêter »
//   (data-act="stop") in its list row and its detail head, a refused stop leaves « Arrêt impossible » under the head, one click calls
//   pluginsStop once and the button reads « Arrêt… » disabled while it is pending, then the status reads « Arrêté · <when> », the history
//   row « Arrêté » and the journal head « Arrêté » | k12 « Supprimer » on a running plugin: the card carries the stop line (and an idle one
//   does not), a failed stop keeps « Arrêt impossible » in the card and removes nothing, the confirm leaves no run, no folder, no row and
//   the list page | k13 « Lancer maintenant » after a stop starts a new run.
// k14-k17 (T2 main, V27): a running plugin refuses its edits. k14 (app, IPC) the four edits answer { ok: false } « Plugin en cours
//   d'exécution », plugins.json is byte-identical, no plugins-changed follows, the run lives on | k15 (app, IPC) after the stop
//   the same four calls succeed and store their values | k16 (host over the real runner)
//   the guard lives in the host: an in-flight run refuses the four setters, a no-op value included, an unknown id keeps « Plugin
//   introuvable », another plugin stays editable, and after the stop the setters work | k17 the same for a run a previous Deck left alive
//   | k18 the guard is checked again after the shell read of setEnabled(true): a run that lands while the listing is held refuses it.
// k19-k21 (T2 renderer, V27) drive the Paramètres tab of the app with real clicks: k19 a run that starts while the tab is shown disables
//   « Modifier » (#plg-set-edit), every option pick, #plg-set-switch and #plg-retention and shows the line « Arrête l’exécution pour modifier
//   les réglages. » (#plg-set-lock, first child of #plg-settings, muted, no left bar); « Arrêter » stays enabled and a click on a disabled
//   control changes nothing | k20 « Arrêter » ends the run: the four controls are enabled again (a pick and the switch work), the line is
//   hidden | k21 the lock is independent of the older rules: the switch keeps « À configurer » and the busy rule keeps « Modifier » and the
//   switch (rows patched in place, six states).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const SRC = process.env.PLUGIN_STOP_SRC ? path.resolve(process.env.PLUGIN_STOP_SRC) : path.join(__dirname, '..', 'src', 'main');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-stop-probe-')));
const ID = 'longrun';
const TODAY = '2026-11-03';
const PREV = '2026-11-02';
const CLOCK = () => new Date(2026, 10, 3, 9, 0, 0).getTime();
const OUTER_PATH = '/usr/local/bin:/usr/bin:/bin';
const BASE = ['PATH', 'HOME'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (n) => typeof n === 'string' && n.length <= 64 && NAME_RE.test(n);
const E_IDLE = 'Aucune exécution en cours';
const E_STUCK = 'Arrêt impossible';
const E_REQUEST = 'Requête invalide';
const E_RUNNING = "Plugin en cours d'exécution";
const E_UNKNOWN = 'Plugin introuvable';
// A manifest with one optional slot and one declared option, so the four edits have something valid to change.
const EDITABLE = {
  env: [{ name: 'FAKE_TOKEN', label: 'Fake token', required: false, hints: ['FAKE'] }],
  options: [{ name: 'MODE', label: 'Mode', choices: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }], default: 'fast' }],
};

// The fake plugins: each run appends one line to <data dir>/ups, so the probe knows the plugin is past its start.
const UP = 'echo up >> "$DECK_PLUGIN_DATA_DIR/ups"';
const LONG = `${UP}\n/bin/sleep 30`;
const EXIT0 = `${UP}\nexit 0`;
const EXIT1 = `${UP}\nexit 1`;
const SHELL = path.join(TMP, 'fake-shell.sh'); // plays the login shell: a bare bash, never the real rc
fs.writeFileSync(SHELL, '#!/bin/bash\nexec /bin/bash --norc --noprofile "$@"\n', { mode: 0o755 });

// The booted app (k7-k10): main.js must be required before app ready (the deckpage: scheme is privileged at require time), so
// the boot is synchronous here, ahead of every await. Its plugins dir / userData / ask dir / projects dir are throwaway.
const APP = path.join(TMP, 'app');
const APP_PLUGINS = path.join(APP, 'plugins');
const APP_USER = path.join(APP, 'userData');
const APP_STATE = path.join(APP_USER, 'plugins.json');
const APP_DATA = path.join(APP_USER, 'plugin-data', ID);
// host.stop calls the IPC layer made; stuck = answer « Arrêt impossible » without stopping; hold = a promise the stop waits for (k11 sees « Arrêt… »);
// host = the host main.js composed (k11-k13 rescan it after they install a plugin folder)
const hostSpy = { calls: 0, stuck: false, hold: null, host: null, log: [] };
function bootApp() {
  for (const d of [APP_PLUGINS, APP_USER, path.join(APP, 'ask'), path.join(APP, 'projects')]) fs.mkdirSync(d, { recursive: true });
  process.env.CLAUDE_DECK_PLUGINS_DIR = APP_PLUGINS;
  process.env.CLAUDE_DECK_PLUGINS_SHELL = SHELL;
  process.env.CLAUDE_DECK_ASK_DIR = path.join(APP, 'ask');
  process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(APP, 'projects');
  app.setPath('userData', APP_USER);
  const liveHost = require(path.join(ROOT, 'src', 'main', 'plugins.js'));
  const create = liveHost.create;
  liveHost.create = (o) => { // main.js reads `.create` at compose time: the host it builds counts and may fake its stop
    const h = create(o);
    const real = h.stop;
    h.stop = async (id) => {
      hostSpy.calls += 1;
      if (hostSpy.hold) await hostSpy.hold;
      const res = hostSpy.stuck ? { ok: false, error: E_STUCK } : await real(id);
      hostSpy.log.push([hostSpy.stuck, res]);
      return res;
    };
    if (o.pluginsDir === APP_PLUGINS) hostSpy.host = h; // the rigs of k1-k6 build hosts through this same create: only the app's own host is rescanned
    return h;
  };
  require(path.join(ROOT, 'main.js'));
}
bootApp();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Process inspection without /proc (macOS has none): /proc on linux, `ps` on darwin; liveness is signal 0 on both.
// A darwin word is a space-separated token of the ps line.
const kill0 = process.kill.bind(process);
const IS_DARWIN = process.platform === 'darwin';
const psOut = (args) => { try { return require('node:child_process').execFileSync('ps', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const alive = (pid) => { try { kill0(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const cmdlineOf = (pid) => {
  if (!IS_DARWIN) { try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0'); } catch { return []; } }
  const line = psOut(['-ww', '-o', 'command=', '-p', String(pid)]).replace(/\n+$/, '');
  return line ? line.split(' ') : [];
};
const allCmdlines = () => (IS_DARWIN
  ? psOut(['-axww', '-o', 'pid=,command=']).split('\n').map((l) => /^\s*(\d+) (.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), words: m[2].split(' ') }))
  : fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map((n) => ({ pid: Number(n), words: cmdlineOf(n) })));
const gone = (pid) => until(() => !alive(pid), 3000, `pid ${pid} gone`);
const spawned = [];
function reap() { // leftovers of a red run: only processes whose cmdline names this probe's own TMP (never an Electron helper: the booted app owns some)
  for (const { pid, words } of allCmdlines()) {
    if (!words.some((w) => w.includes(TMP)) || words.some((w) => w.startsWith('--type=')) || /electron/.test(words[0] || '')) continue;
    for (const target of [-pid, pid]) { try { process.kill(target, 'SIGKILL'); } catch { /* not a leader, or gone */ } }
  }
}

const results = {};
function gate(name, ok, extra) {
  results[name] = !!ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ' :: ' + extra}`);
}
async function kgate(name, fn) {
  try { const r = await fn(); gate(name, r.ok, r.extra); } catch (e) { gate(name, false, String(e && e.message).split('\n')[0]); } finally { reap(); }
}

let reportsMod;
let runnerMod;
let hostMod;

// One rig = a plugins dir with the fake plugin, a data root, a state file, and a host over the real runner + reports.
// boot() builds a NEW runner and host over the same files (a Deck restart: nothing stays in memory).
function rig(body = LONG, extra = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'rig-'));
  const R = { dir, pluginsDir: path.join(dir, 'plugins'), dataRoot: path.join(dir, 'data'), statePath: path.join(dir, 'plugins.json'), exits: [] };
  const pdir = path.join(R.pluginsDir, ID);
  fs.mkdirSync(pdir, { recursive: true });
  R.argv0Abs = path.join(pdir, 'run.sh');
  fs.writeFileSync(R.argv0Abs, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const scan = (d) => fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, 'run.sh'))).map((n) => ({
    id: n, label: 'Fake long plugin', description: 'probe', trigger: 'daily', argv: ['run.sh'], env: [], dir: path.join(d, n), argv0Abs: path.join(d, n, 'run.sh'), ...extra,
  }));
  R.listNames = async () => ({ ok: true, names: [] }); // a gate swaps it to slow the shell read
  const access = {
    listNames: (shell) => R.listNames(shell),
    status: (slots) => slots.map((s) => ({ name: s.name, status: 'présente', candidates: [] })), // every slot reads present
    validName,
  };
  R.reports = reportsMod.create(R.dataRoot, CLOCK);
  R.hostOver = (runner) => hostMod.create({
    pluginsDir: R.pluginsDir, statePath: R.statePath, scan, access, runner, reports: R.reports, nowFn: CLOCK, shellPath: SHELL, baseNames: BASE,
  });
  R.boot = () => {
    R.runner = runnerMod.create({
      reports: R.reports, nowFn: CLOCK, shellPath: SHELL, baseNames: BASE, validName, stopGraceMs: 1500,
      onExit: (id, info) => { R.exits.push({ id, ...info }); R.host.onExit(id, info); }, // the wiring of main.js
    });
    R.host = R.hostOver(R.runner);
  };
  R.boot();
  R.seed = (entry) => fs.writeFileSync(R.statePath, JSON.stringify({ [ID]: { enabled: true, retentionDays: 30, ...entry } }));
  R.claim = () => JSON.parse(fs.readFileSync(R.statePath, 'utf8'))[ID].lastAutoDate;
  R.ups = () => { try { return fs.readFileSync(path.join(R.dataRoot, ID, 'ups'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  R.up = (n) => until(() => R.ups() >= n, 5000, `run ${n} up`);
  return R;
}

// ---- the booted app: window.api like the renderer, a real plugin folder, the sidecars read back from the data dir ----
let win = null;
let appReports = null;
const J = (v) => JSON.stringify(v);
const appUps = () => { try { return fs.readFileSync(path.join(APP_DATA, 'ups'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const appState = () => { try { return JSON.parse(fs.readFileSync(APP_STATE, 'utf8')); } catch { return null; } };
const pushes = () => win.webContents.executeJavaScript('window.__pushes', true);
// window.api call that answers { missing: true } instead of throwing when the function is not exposed
const call = (fn, ...args) => win.webContents.executeJavaScript(
  `(async () => { const f = window.api[${J(fn)}]; if (typeof f !== 'function') return { missing: true }; return await f(...${J(args)}); })()`, true);

// A fresh plugin folder (manual trigger: startup never launches it), a state entry and no data, as an import would leave it.
function appInstall(extra = {}) {
  const dir = path.join(APP_PLUGINS, ID);
  fs.rmSync(APP_DATA, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.sh'), `#!/bin/sh\n${LONG}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'deck-plugin.json'), J({ id: ID, label: 'Fake long plugin', description: 'probe', argv: ['run.sh'], trigger: 'manual', env: [], ...extra }));
  fs.writeFileSync(APP_STATE, J({ [ID]: { enabled: true, retentionDays: 30 } }));
  return dir;
}
// Start the plugin through the bridge and wait until its script is past the start line; -> { run, pid }
async function appRun() {
  const run = await call('pluginsRunNow', ID);
  if (!run || run.ok !== true) throw new Error(`run-now answered ${J(run)}`);
  await until(() => appUps() >= 1, 5000, 'app run up');
  const latest = appReports.latest(ID);
  if (!latest || !Number.isInteger(latest.pid)) throw new Error(`no pid in ${J(latest)}`);
  return { run, pid: latest.pid };
}
const goneSoft = (pid) => gone(pid).then(() => true, () => false);

async function appWindow() {
  for (let i = 0; i < 300; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && await w.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.api.onPluginsChanged)', true).catch(() => false)) return w;
    await sleep(100);
  }
  throw new Error('renderer never became ready');
}

async function main() {
  try {
    reportsMod = require(path.join(SRC, 'plugin-reports.js'));
    runnerMod = require(path.join(SRC, 'plugin-runner.js'));
    hostMod = require(path.join(SRC, 'plugins.js'));
  } catch (e) {
    gate('load', false, e.code || String(e.message).split('\n')[0]);
    return false;
  }
  gate('load', [reportsMod, runnerMod, hostMod].every((m) => typeof m.create === 'function'));

  // k1: an AUTO run the user stops keeps today's claim: the next startup() starts nothing and writes no entry
  await kgate('k1_stopped_auto_keeps_claim', async () => {
    const R = rig();
    R.seed({ lastAutoDate: PREV });
    const s1 = await R.host.startup();
    await R.up(1);
    const claimed = R.claim() === TODAY;
    const res = await R.host.stop(ID);
    const kept = R.claim() === TODAY;
    const s2 = await R.host.startup();
    const ok = sameJson(s1.started, [ID]) && claimed && res && res.ok === true && R.exits.length === 1 && R.exits[0].trigger === 'auto'
      && R.exits[0].stopped === true && kept && R.claim() === TODAY && sameJson(s2.started, []) && R.reports.list(ID).length === 1 && R.ups() === 1
      && R.host.list()[0].running === false;
    return { ok, extra: JSON.stringify({ s1, claimed, res, exits: R.exits.map((x) => [x.trigger, x.stopped]), kept, s2, entries: R.reports.list(ID).length, ups: R.ups() }) };
  });

  // k2: any other end of an AUTO run still restores the claim: exit 1, and a signal sent from outside the Deck (not a stop)
  await kgate('k2_failed_auto_restores_claim', async () => {
    const A = rig(EXIT1);
    A.seed({ lastAutoDate: PREV });
    const sA = await A.host.startup();
    await until(() => A.exits.length === 1, 8000, 'exit 1 run done');
    const failedOk = sameJson(sA.started, [ID]) && A.exits[0].exit === 1 && A.exits[0].stopped === false && A.claim() === PREV;

    const B = rig();
    B.seed({ lastAutoDate: PREV });
    const sB = await B.host.startup();
    await B.up(1);
    process.kill(-B.reports.latest(ID).pid, 'SIGTERM'); // not host.stop: no stopped mark, the run just dies
    await until(() => B.exits.length === 1, 5000, 'killed run done');
    const killedOk = sameJson(sB.started, [ID]) && B.exits[0].signal === 'SIGTERM' && B.exits[0].stopped === false && B.claim() === PREV
      && B.reports.latest(ID).stopped === false;
    const retry = await B.host.startup(); // the restored claim lets the same day try again
    const ok = failedOk && killedOk && sameJson(retry.started, [ID]);
    return { ok, extra: JSON.stringify({ failedOk, killedOk, retry, claimA: A.claim(), claimB: B.claim() }) };
  });

  // k3: a MANUAL run the user stops leaves lastAutoDate alone (a manual run never claims the day)
  await kgate('k3_stopped_manual_keeps_lastautodate', async () => {
    const R = rig();
    R.seed({ lastAutoDate: PREV });
    const run = await R.host.runNow(ID);
    await R.up(1);
    const res = await R.host.stop(ID);
    const latest = R.reports.latest(ID);
    const ok = run && run.ok === true && res && res.ok === true && R.exits.length === 1 && R.exits[0].trigger === 'manual' && R.exits[0].stopped === true
      && R.claim() === PREV && latest.trigger === 'manual' && latest.stopped === true;
    return { ok, extra: JSON.stringify({ run, res, exits: R.exits.map((x) => [x.trigger, x.stopped]), claim: R.claim(), latest }) };
  });

  // k4: the refusals: nothing running (idle, unknown id, run already finished) and a runner that answers « still-alive »
  await kgate('k4_stop_refusals', async () => {
    const R = rig();
    R.seed({});
    const idle = await R.host.stop(ID);
    const unknown = await R.host.stop('nope');
    const noEntry = R.reports.list(ID).length === 0; // nothing was marked, nothing written

    const Q = rig(EXIT0);
    Q.seed({});
    await Q.host.runNow(ID);
    await until(() => Q.exits.length === 1, 8000, 'short run done');
    const finished = await Q.host.stop(ID);
    const unmarked = Q.reports.latest(ID).stopped === false;

    await R.host.runNow(ID);
    await R.up(1);
    const stuck = await R.hostOver({ ...R.runner, stop: async () => ({ ok: false, reason: 'still-alive' }) }).stop(ID);
    const alive = R.host.list()[0].running === true; // a refused stop leaves the run alone
    const real = await R.host.stop(ID);
    const want = { ok: false, error: E_IDLE };
    const ok = sameJson(idle, want) && sameJson(unknown, want) && noEntry && sameJson(finished, want) && unmarked
      && sameJson(stuck, { ok: false, error: E_STUCK }) && alive && real && real.ok === true;
    return { ok, extra: JSON.stringify({ idle, unknown, noEntry, finished, unmarked, stuck, alive, real }) };
  });

  // k5: after the stop the row reads running false and the latest entry reads stopped true; same for a survivor
  await kgate('k5_list_after_stop', async () => {
    const R = rig();
    R.seed({ lastAutoDate: PREV });
    await R.host.runNow(ID);
    await R.up(1);
    await R.host.stop(ID);
    const rowA = R.host.list()[0];
    const latestA = R.reports.latest(ID);
    const flightOk = rowA.running === false && latestA.stopped === true && latestA.exit === null;

    // a run a previous Deck instance left alive: the sidecar holds its pid, this instance has nothing in memory
    const S = rig();
    S.seed({ lastAutoDate: TODAY });
    const entry = S.reports.newEntry(ID, 'auto');
    const live = cp.spawn(S.argv0Abs, [], { detached: true, stdio: 'ignore', env: { PATH: OUTER_PATH, DECK_PLUGIN_DATA_DIR: path.join(S.dataRoot, ID) } });
    spawned.push(live);
    S.reports.setPid(ID, entry.stem, live.pid);
    await S.up(1);
    await S.host.rescan();
    const before = S.host.list()[0].running;
    const res = await S.host.stop(ID);
    await gone(live.pid);
    const rowB = S.host.list()[0];
    const latestB = S.reports.latest(ID);
    const next = await S.host.startup(); // a survivor stopped by the user keeps the claim too
    const survivorOk = before === true && res && res.ok === true && rowB.running === false && latestB.stopped === true && latestB.exit === null
      && S.exits.length === 0 && S.claim() === TODAY && sameJson(next.started, []);
    return { ok: flightOk && survivorOk, extra: JSON.stringify({ flight: { running: rowA.running, latest: latestA }, survivor: { before, res, running: rowB.running, latest: latestB, exits: S.exits.length, next } }) };
  });

  // k6: the plugin is not left locked: runNow after a stop starts a new run
  await kgate('k6_runnow_after_stop', async () => {
    const R = rig();
    R.seed({ lastAutoDate: PREV });
    const first = await R.host.runNow(ID);
    await R.up(1);
    const res = await R.host.stop(ID);
    const again = await R.host.runNow(ID);
    await R.up(2);
    const running = R.host.list()[0].running === true;
    const entries = R.reports.list(ID).length;
    const end = await R.host.stop(ID);
    const ok = first.ok === true && res && res.ok === true && again && again.ok === true && again.stem !== first.stem && running && entries === 2 && end && end.ok === true;
    return { ok, extra: JSON.stringify({ first, res, again, running, entries, end }) };
  });

  // ---- k7-k10: the IPC layer and the preload bridge, in the real app ----
  appReports = reportsMod.create(path.join(APP_USER, 'plugin-data'), () => Date.now());
  win = await appWindow();
  await win.webContents.executeJavaScript('window.__pushes = 0; window.api.onPluginsChanged(() => { window.__pushes++; }); true', true);
  await sleep(1500); // the startup push settles before any baseline

  // k7: plugins-stop ends a run the panel started: process gone, row idle, entry stopped, and plugins-changed follows. Two pushes:
  // the runner's exit (main.js wiring) and the mutate wrapper of the channel; a plain handle() would leave only the first.
  await kgate('k7_ipc_stop_ends_run_and_notifies', async () => {
    appInstall();
    const { run, pid } = await appRun();
    await sleep(400);
    const p0 = await pushes();
    const res = await call('pluginsStop', ID);
    const goneOk = await goneSoft(pid);
    await sleep(600);
    const n = (await pushes()) - p0;
    const latest = appReports.latest(ID);
    const rows = await call('pluginsList');
    const row = Array.isArray(rows) ? rows.find((r) => r.id === ID) : null;
    const ok = res && res.ok === true && res.stem === run.stem && goneOk && n === 2 && latest.stopped === true && latest.exit === null
      && row && row.running === false;
    return { ok, extra: J({ res, stem: run.stem, goneOk, pushes: n, latest, running: row && row.running }) };
  });

  // k8: plugins-delete on a running plugin stops it first: process gone, then folder, state entry and data removed, answer ok
  await kgate('k8_ipc_delete_running_stops_then_removes', async () => {
    const dir = appInstall();
    const { pid } = await appRun();
    await sleep(400);
    const p0 = await pushes();
    const calls0 = hostSpy.calls;
    const res = await call('pluginsDelete', ID);
    const goneOk = await goneSoft(pid);
    await sleep(600);
    const n = (await pushes()) - p0;
    const state = appState();
    const rows = await call('pluginsList');
    const listed = Array.isArray(rows) && rows.some((r) => r.id === ID);
    const ok = res && res.ok === true && res.id === ID && goneOk && hostSpy.calls - calls0 === 1 && !fs.existsSync(dir)
      && state && !Object.prototype.hasOwnProperty.call(state, ID) && !fs.existsSync(APP_DATA) && !listed && n >= 1;
    return { ok, extra: J({ res, goneOk, stopCalls: hostSpy.calls - calls0, folder: fs.existsSync(dir), state, data: fs.existsSync(APP_DATA), listed, pushes: n }) };
  });

  // k9: refusals. A non-id request to plugins-stop answers the request refusal and stops nothing; a stop that fails on
  // plugins-delete answers its own refusal and removes nothing (the run is not signalled, folder / state / data stay).
  await kgate('k9_ipc_refusals_stop_nothing', async () => {
    const dir = appInstall();
    const { pid } = await appRun();
    await sleep(400);
    const p0 = await pushes();
    const calls0 = hostSpy.calls;
    const bad = ['', 42, null, undefined, [ID], { id: ID }, 'x'.repeat(65)];
    const answers = [];
    for (const b of bad) answers.push(await call('pluginsStop', b));
    const refused = answers.every((a) => a && a.ok === false && a.error === E_REQUEST);
    const badDelete = await call('pluginsDelete', 42);
    await sleep(600);
    const untouched = alive(pid) && appReports.latest(ID).stopped === false && hostSpy.calls === calls0 && (await pushes()) === p0;

    hostSpy.stuck = true;
    let stuck;
    try { stuck = await call('pluginsDelete', ID); } finally { hostSpy.stuck = false; }
    await sleep(300);
    const kept = fs.existsSync(dir) && fs.existsSync(APP_DATA) && Object.prototype.hasOwnProperty.call(appState() || {}, ID) && alive(pid)
      && appReports.latest(ID).stopped === false;
    const ok = refused && badDelete && badDelete.ok === false && untouched && sameJson(stuck, { ok: false, error: E_STUCK })
      && hostSpy.calls - calls0 === 1 && kept;
    return { ok, extra: J({ answers, badDelete, untouched, stuck, stopCalls: hostSpy.calls - calls0, kept }) };
  });

  // k10: the preload exposes pluginsStop, and plugins-stop is handled exactly once (Electron refuses a second handler)
  await kgate('k10_preload_bridge_and_single_handler', async () => {
    const type = await win.webContents.executeJavaScript('typeof window.api.pluginsStop', true);
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc', 'plugins.js'), 'utf8');
    const count = (src, re) => (src.match(re) || []).length;
    const inPreload = count(preload, /ipcRenderer\.invoke\('plugins-stop'/g);
    const inIpc = count(ipcSrc, /(?:handle|mutate)\('plugins-stop'/g);
    let registered;
    try { ipcMain.handle('plugins-stop', () => null); registered = false; ipcMain.removeHandler('plugins-stop'); } catch (e) { registered = /second handler/.test(String(e && e.message)); }
    const ok = type === 'function' && inPreload === 1 && inIpc === 1 && registered === true;
    return { ok, extra: J({ type, inPreload, inIpc, registered }) };
  });

  // ---- k11-k13: the stop / delete UI, through the panel of the real app ----
  const rend = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const waitUi = async (expr, ms = 8000) => { try { await until(() => rend(`return !!(${expr});`), ms, expr); return true; } catch { return false; } };
  const SNAP = `const snap = () => {
    const row = document.querySelector('#plg-list .plg-row[data-id="${ID}"]'); const head = document.getElementById('plg-dhead');
    const b = (root, act) => { const n = root && root.querySelector('[data-act="' + act + '"]'); return n ? { text: n.textContent, dis: n.disabled } : null; };
    const t = (root, sel) => { const n = root && root.querySelector(sel); return n ? n.textContent : null; };
    return { rowActs: row ? [...row.querySelectorAll('[data-act]')].map((n) => n.dataset.act) : null, rowStop: b(row, 'stop'), rowRun: b(row, 'run'), rowStatus: t(row, '.plg-status'),
      headStop: b(head, 'stop'), headRun: b(head, 'run'), headStatus: t(head, '.plg-status'), headNote: t(head, '.plg-note'), page: document.getElementById('plugin-panel').dataset.page,
      card: document.getElementById('plg-card').hidden ? null : { kind: document.getElementById('plg-card').dataset.kind, text: document.getElementById('plg-card').textContent, error: t(document.getElementById('plg-card'), '.plg-card-error'),
        buttons: [...document.querySelectorAll('#plg-card button')].map((n) => n.disabled) } }; };`;
  const snapUi = () => rend(`${SNAP} return snap();`);
  const untilSnap = async (pred, ms = 8000) => { try { await until(async () => pred(await snapUi()), ms, 'ui state'); } catch { /* the gate reads the last snapshot */ } return snapUi(); };
  const clickUi = (sel) => rend(`const n = document.querySelector(${J(sel)}); if (!n) return false; n.click(); return true;`);
  const ROW = `#plg-list .plg-row[data-id="${ID}"]`;
  const WHEN = /^Arrêté · \d{2}\/\d{2} \d{2}:\d{2}$/;
  const L_DEL = 'L’exécution en cours sera arrêtée, puis le plugin supprimé.';
  async function openPanel() { // a fresh opening: the list page, the rows of the host as they are now
    await rend(`if (window.plg.open) document.getElementById('plg-close').click(); return true;`);
    await rend(`document.getElementById('plugin-toggle').click(); return true;`);
    await waitUi('window.plg.open');
    await rend(`await window.plgLoadList(); return true;`);
  }
  const fresh = async () => { appInstall(); await hostSpy.host.rescan(); await openPanel(); return waitUi(`document.querySelector(${J(ROW)})`); };

  // k11: « Arrêter » in the row and the head, one pluginsStop per click, « Arrêt… » while pending, then « Arrêté » in status, history and journal
  await kgate('k11_stop_button_and_words', async () => {
    const listed = await fresh();
    const idle = await snapUi();
    await clickUi(`${ROW} [data-act="run"]`);
    await until(() => appUps() >= 1, 5000, 'run up');
    const inList = await untilSnap((s) => s.rowStop && s.rowStatus === 'En cours…');
    const pid = appReports.latest(ID).pid;
    await clickUi(`${ROW} [data-act="pick"]`);
    const inHead = await untilSnap((s) => s.page === 'detail' && s.headStop);
    // a refused stop: one call, the line under the head, the button back, the run untouched
    const calls0 = hostSpy.calls;
    hostSpy.stuck = true;
    let refused;
    try {
      await clickUi('#plg-dhead [data-act="stop"]');
      refused = await untilSnap((s) => s.headNote === E_STUCK && s.headStop && !s.headStop.dis && s.headStop.text === 'Arrêter');
    } finally { hostSpy.stuck = false; }
    const refusedOk = refused.headNote === E_STUCK && refused.headStop && refused.headStop.text === 'Arrêter' && !refused.headStop.dis && hostSpy.calls - calls0 === 1
      && alive(pid) && appReports.latest(ID).stopped === false;
    // the real stop, held in main: pending in the head and in the row, one call whatever the clicks
    let release = () => {};
    hostSpy.hold = new Promise((r) => { release = r; });
    const calls1 = hostSpy.calls;
    let pending;
    let once = false;
    try {
      await clickUi('#plg-dhead [data-act="stop"]');
      pending = await untilSnap((s) => s.headStop && s.headStop.dis && s.headStop.text === 'Arrêt…' && s.rowStop && s.rowStop.dis && s.rowStop.text === 'Arrêt…', 3000);
      await clickUi('#plg-dhead [data-act="stop"]'); // a disabled button takes no click
      await sleep(300);
      once = hostSpy.calls - calls1 === 1;
    } finally { release(); hostSpy.hold = null; }
    const done = await untilSnap((s) => WHEN.test(s.headStatus || '') && s.headRun && !s.headStop);
    const goneOk = await goneSoft(pid);
    await clickUi('#plg-detail [data-tab="history"]');
    const histOk = await waitUi(`(() => { const s = document.querySelector('#plg-hist .plg-hrow .plg-h-status'); return s && s.textContent === 'Arrêté'; })()`);
    await clickUi('#plg-detail [data-tab="journal"]');
    const journalOk = await waitUi(`(() => { const t = document.querySelector('#plg-view .plg-fail-title'); return t && t.textContent.startsWith('Arrêté'); })()`);
    const ok = listed && sameJson(idle.rowActs, ['pick', 'run']) && idle.rowRun.text === 'Lancer'
      && sameJson(inList.rowActs, ['pick', 'stop']) && inList.rowStop.text === 'Arrêter' && !inList.rowStop.dis && !inList.rowRun
      && inHead.headStop && inHead.headStop.text === 'Arrêter' && !inHead.headStop.dis && !inHead.headRun
      && refusedOk && pending.headStop.dis && pending.rowStop.dis && once
      && WHEN.test(done.headStatus) && WHEN.test(done.rowStatus) && done.headRun.text === 'Lancer maintenant' && sameJson(done.rowActs, ['pick', 'run'])
      && goneOk && appReports.latest(ID).stopped === true && histOk && journalOk;
    return { ok, extra: J({ listed, idle, inList, inHead, refused, pending, once, done, goneOk, histOk, journalOk }) };
  });

  // k12: « Supprimer » on a running plugin: the stop line in the card, a failed stop keeps the plugin, the confirm removes run and plugin, the list page returns
  await kgate('k12_delete_running_through_panel', async () => {
    const listed = await fresh();
    await clickUi(`${ROW} [data-act="pick"]`);
    await untilSnap((s) => s.page === 'detail');
    await clickUi('#plg-dhead [data-act="delete"]');
    const idleCard = await untilSnap((s) => s.card && s.card.kind === 'delete');
    await clickUi('#plg-card [data-act="card-cancel"]');
    await untilSnap((s) => !s.card);
    const { pid } = await appRun(); // started through the bridge: the panel follows the push
    await untilSnap((s) => s.headStop);
    const dir = path.join(APP_PLUGINS, ID);
    await clickUi('#plg-dhead [data-act="delete"]');
    const card = await untilSnap((s) => s.card && s.card.kind === 'delete');
    const calls0 = hostSpy.calls;
    hostSpy.stuck = true;
    let stuck;
    try {
      await clickUi('#plg-card [data-act="card-confirm"]');
      stuck = await untilSnap((s) => s.card && s.card.error === E_STUCK && s.card.buttons.every((d) => !d));
    } finally { hostSpy.stuck = false; }
    const keptOk = !!stuck.card && stuck.card.error === E_STUCK && stuck.card.buttons.every((d) => !d) && hostSpy.calls - calls0 === 1
      && alive(pid) && fs.existsSync(dir) && fs.existsSync(APP_DATA) && Object.prototype.hasOwnProperty.call(appState() || {}, ID) && !!stuck.rowStop;
    await clickUi('#plg-card [data-act="card-confirm"]');
    const fin = await untilSnap((s) => !s.card && s.page === 'list' && s.rowActs === null);
    const goneOk = await goneSoft(pid);
    const rows = await call('pluginsList');
    const ok = listed && idleCard.card && !idleCard.card.text.includes(L_DEL) && card.card && card.card.text.includes(L_DEL) && keptOk
      && !fin.card && fin.page === 'list' && fin.rowActs === null && goneOk && !fs.existsSync(dir) && !fs.existsSync(APP_DATA)
      && !Object.prototype.hasOwnProperty.call(appState() || {}, ID) && Array.isArray(rows) && !rows.some((r) => r.id === ID);
    return { ok, extra: J({ listed, idleCard: idleCard.card && idleCard.card.text, card: card.card && card.card.text, fin, goneOk, folder: fs.existsSync(dir), data: fs.existsSync(APP_DATA), calls: hostSpy.calls - calls0, log: hostSpy.log.slice(-3), keptOk }) };
  });

  // k13: after a stop the plugin is not locked: « Lancer maintenant » starts a new run
  await kgate('k13_run_now_after_stop', async () => {
    const listed = await fresh();
    const first = await appRun();
    await clickUi(`${ROW} [data-act="pick"]`);
    await untilSnap((s) => s.page === 'detail' && s.headStop);
    await clickUi('#plg-dhead [data-act="stop"]');
    const stopped = await untilSnap((s) => WHEN.test(s.headStatus || '') && s.headRun && !s.headRun.dis);
    const goneOk = await goneSoft(first.pid);
    const ups0 = appUps();
    await clickUi('#plg-dhead [data-act="run"]');
    await until(() => appUps() >= ups0 + 1, 5000, 'second run up');
    const again = await untilSnap((s) => s.headStop && s.headStatus === 'En cours…');
    const latest = appReports.latest(ID);
    const ok = listed && WHEN.test(stopped.headStatus) && goneOk && latest.stem !== first.run.stem && latest.exit === null && latest.stopped === false
      && again.headStop && again.headStop.text === 'Arrêter' && !again.headStop.dis && !again.headRun;
    return { ok, extra: J({ listed, stopped, goneOk, firstStem: first.run.stem, latest, again }) };
  });

  // ---- k14-k17: a running plugin refuses its four edits (T2, V27) ----
  const appEdits = async () => [
    await call('pluginsSetEnabled', ID, false),
    await call('pluginsSetRetention', ID, 7),
    await call('pluginsSetEnvMap', ID, { FAKE_TOKEN: 'MY_VAR' }),
    await call('pluginsSetOption', ID, 'MODE', 'slow'),
  ];
  const hostEdits = async (h) => [ // the first value would change nothing when the plugin is already enabled: a no-op is refused too
    await h.setEnabled(ID, true),
    await h.setEnabled(ID, false),
    await h.setRetention(ID, 7),
    await h.setEnvMap(ID, { FAKE_TOKEN: 'MY_VAR' }),
    await h.setOption(ID, 'MODE', 'slow'),
  ];
  const refusal = { ok: false, error: E_RUNNING };
  const rowOf = async () => { const rows = await call('pluginsList'); return Array.isArray(rows) ? rows.find((r) => r.id === ID) || null : null; };
  const appIdle = async () => { // the previous gate may have left a run: wait until the host sees it gone, then let its pushes settle
    await until(async () => { const r = await rowOf(); return !r || r.running === false; }, 8000, 'app plugin idle');
    await sleep(600);
  };
  const installEditable = async () => { appInstall(EDITABLE); await hostSpy.host.rescan(); };
  const stateRaw = (file) => fs.readFileSync(file, 'utf8');

  // k14: through the IPC, the four edits of a running plugin answer the refusal and change nothing
  await kgate('k14_ipc_edits_refused_while_running', async () => {
    await appIdle();
    await installEditable();
    const { pid } = await appRun();
    await sleep(400);
    const raw0 = stateRaw(APP_STATE);
    const p0 = await pushes();
    const answers = await appEdits();
    await sleep(600);
    const raw1 = stateRaw(APP_STATE);
    const n = (await pushes()) - p0;
    const row = await rowOf();
    const refused = answers.every((a) => sameJson(a, refusal));
    const entryKept = sameJson((appState() || {})[ID], JSON.parse(raw0)[ID]);
    const ok = refused && raw1 === raw0 && n === 0 && alive(pid) && !!row && row.running === true && entryKept;
    return { ok, extra: J({ answers, identical: raw1 === raw0, pushes: n, alive: alive(pid), running: row && row.running, entryKept }) };
  });

  // k15: once the run is stopped, the same four calls succeed and store their values
  await kgate('k15_ipc_edits_apply_after_stop', async () => {
    await appIdle();
    await installEditable();
    const { pid } = await appRun();
    await sleep(400);
    const res = await call('pluginsStop', ID);
    const goneOk = await goneSoft(pid);
    await until(async () => { const r = await rowOf(); return !!r && r.running === false; }, 5000, 'row idle after the stop');
    const answers = await appEdits();
    const entry = (appState() || {})[ID] || {};
    const want = [{ ok: true, enabled: false }, { ok: true, retentionDays: 7 }, { ok: true, envMap: { FAKE_TOKEN: 'MY_VAR' } }, { ok: true, name: 'MODE', value: 'slow' }];
    const ok = !!res && res.ok === true && goneOk && sameJson(answers, want) && entry.enabled === false && entry.retentionDays === 7
      && sameJson(entry.envMap, { FAKE_TOKEN: 'MY_VAR' }) && sameJson(entry.options, { MODE: 'slow' });
    return { ok, extra: J({ res, goneOk, answers, entry }) };
  });

  // k16: the guard is the host's own (no IPC): in flight, a no-op value included; unknown id and another plugin are not caught by it
  await kgate('k16_host_refuses_edits_while_running', async () => {
    const R = rig(LONG, EDITABLE);
    R.seed({ lastAutoDate: PREV });
    const other = path.join(R.pluginsDir, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'run.sh'), `#!/bin/sh\n${EXIT0}\n`, { mode: 0o755 });
    await R.host.rescan();
    const run = await R.host.runNow(ID);
    await R.up(1);
    const raw0 = stateRaw(R.statePath);
    const answers = await hostEdits(R.host);
    const identical = stateRaw(R.statePath) === raw0;
    const unknown = await R.host.setRetention('nope', 7);
    const free = [await R.host.setRetention('other', 9), await R.host.setEnabled('other', true)];
    const stillRunning = R.host.list().find((r) => r.id === ID).running === true;
    const stop = await R.host.stop(ID);
    const after = await hostEdits(R.host);
    const entry = JSON.parse(stateRaw(R.statePath))[ID];
    const wantAfter = [{ ok: true, enabled: true }, { ok: true, enabled: false }, { ok: true, retentionDays: 7 }, { ok: true, envMap: { FAKE_TOKEN: 'MY_VAR' } }, { ok: true, name: 'MODE', value: 'slow' }];
    const ok = !!run && run.ok === true && answers.every((a) => sameJson(a, refusal)) && identical && sameJson(unknown, { ok: false, error: E_UNKNOWN })
      && sameJson(free, [{ ok: true, retentionDays: 9 }, { ok: true, enabled: true }]) && stillRunning && !!stop && stop.ok === true
      && sameJson(after, wantAfter) && entry.enabled === false && entry.retentionDays === 7 && sameJson(entry.options, { MODE: 'slow' });
    return { ok, extra: J({ run, answers, identical, unknown, free, stillRunning, stop, after, entry }) };
  });

  // k17: a run a previous Deck left alive is just as running for the four edits
  await kgate('k17_host_refuses_edits_for_survivor', async () => {
    const S = rig(LONG, EDITABLE);
    S.seed({ lastAutoDate: TODAY });
    const entry = S.reports.newEntry(ID, 'auto');
    const live = cp.spawn(S.argv0Abs, [], { detached: true, stdio: 'ignore', env: { PATH: OUTER_PATH, DECK_PLUGIN_DATA_DIR: path.join(S.dataRoot, ID) } });
    spawned.push(live);
    S.reports.setPid(ID, entry.stem, live.pid);
    await S.up(1);
    await S.host.rescan();
    const before = S.host.list()[0].running;
    const raw0 = stateRaw(S.statePath);
    const answers = await hostEdits(S.host);
    const identical = stateRaw(S.statePath) === raw0;
    const res = await S.host.stop(ID);
    await gone(live.pid);
    const after = await hostEdits(S.host);
    const ok = before === true && answers.every((a) => sameJson(a, refusal)) && identical && !!res && res.ok === true && after.every((a) => a && a.ok === true);
    return { ok, extra: J({ before, answers, identical, res, after }) };
  });

  // k18: setEnabled(true) of a plugin with a required slot reads the shell; the first listing is held, a run-now lands meanwhile,
  // and when the listing returns the enabling is refused with nothing written (the other listings answer at once)
  await kgate('k18_enable_refused_when_a_run_lands_during_the_shell_read', async () => {
    const R = rig(LONG, { env: [{ name: 'FAKE_TOKEN', label: 'Fake token', required: true, hints: ['FAKE'] }] });
    R.seed({ enabled: false, lastAutoDate: PREV });
    let inRead = () => {};
    let release = () => {};
    const reading = new Promise((r) => { inRead = r; });
    const held = new Promise((r) => { release = r; });
    let first = true;
    R.listNames = async () => {
      if (first) { first = false; inRead(); await held; }
      return { ok: true, names: [] };
    };
    await R.host.rescan();
    const pending = R.host.setEnabled(ID, true);
    let reached = true;
    await Promise.race([reading, sleep(5000).then(() => { reached = false; })]);
    const run = await R.host.runNow(ID);
    await R.up(1);
    const raw0 = stateRaw(R.statePath);
    release();
    const res = await pending;
    const identical = stateRaw(R.statePath) === raw0;
    const entry = JSON.parse(stateRaw(R.statePath))[ID];
    const stop = await R.host.stop(ID);
    const after = await R.host.setEnabled(ID, true);
    const ok = reached && !!run && run.ok === true && sameJson(res, refusal) && identical && entry.enabled === false && !!stop && stop.ok === true
      && sameJson(after, { ok: true, enabled: true });
    return { ok, extra: J({ reached, run, res, identical, entry, stop, after }) };
  });
  // ---- k19-k21: the Paramètres tab locks its four edit controls while the plugin runs (T2 renderer, V27) ----
  const HINT = 'Arrête l’exécution pour modifier les réglages.';
  const SET_SNAP = `const sgl = () => {
    const g = (s) => document.querySelector(s); const dis = (s) => { const n = g(s); return n ? n.disabled : null; };
    const hint = g('#plg-set-lock'); const stop = g('#plg-dhead [data-act="stop"]'); const cs = hint ? getComputedStyle(hint) : null; const ref = g('#plg-set-sum');
    return { edit: dis('#plg-set-edit'), sw: dis('#plg-set-switch'), keep: dis('#plg-retention'),
      opts: [...document.querySelectorAll('#plg-set-opts [data-act="opt-pick"]')].map((b) => b.disabled),
      hint: hint ? { text: hint.textContent, hidden: hint.hidden, shown: cs.display !== 'none', first: hint === document.getElementById('plg-settings').firstElementChild,
        muted: !!ref && cs.color === getComputedStyle(ref).color, noBar: cs.borderLeftWidth === '0px' } : null,
      stop: stop ? { text: stop.textContent, dis: stop.disabled } : null, card: !document.getElementById('plg-card').hidden }; };`;
  const snapSet = () => rend(`${SET_SNAP} return sgl();`);
  const untilSet = async (pred, ms = 8000) => { try { await until(async () => pred(await snapSet()), ms, 'settings state'); } catch { /* the gate reads the last snapshot */ } return snapSet(); };
  const hintOn = (s) => !!s.hint && s.hint.text === HINT && !s.hint.hidden && s.hint.shown && s.hint.first && s.hint.muted && s.hint.noBar;
  const hintOff = (s) => !!s.hint && s.hint.text === HINT && s.hint.hidden && !s.hint.shown;
  const lockedAll = (s) => s.edit === true && s.sw === true && s.keep === true && s.opts.length >= 2 && s.opts.every((d) => d === true);
  const freeAll = (s) => s.edit === false && s.sw === false && s.keep === false && s.opts.length >= 2 && s.opts.every((d) => d === false);
  async function openSettings() { // the editable fake plugin (one option, one optional slot), the Paramètres tab built and its options read
    await appIdle();
    await installEditable();
    await openPanel();
    const listed = await waitUi(`document.querySelector(${J(ROW)})`);
    await clickUi(`${ROW} [data-act="pick"]`);
    await waitUi(`document.getElementById('plugin-panel').dataset.page === 'detail'`);
    await clickUi('#plg-detail [data-tab="settings"]');
    return listed && await waitUi(`!document.getElementById('plg-settings').hidden && document.querySelectorAll('#plg-set-opts [data-act="opt-pick"]').length >= 2`);
  }

  // k19: a run that starts while Paramètres is shown (run-now push) disables « Modifier », every option pick, the switch and the retention
  // field and shows the one line; « Arrêter » stays enabled; a click on a disabled control changes nothing
  await kgate('k19_settings_locked_while_running', async () => {
    const opened = await openSettings();
    const idle = await snapSet();
    const { pid } = await appRun();
    const locked = await untilSet((s) => lockedAll(s) && s.hint && !s.hint.hidden);
    const raw0 = stateRaw(APP_STATE);
    for (const sel of ['#plg-set-edit', '#plg-set-switch', '#plg-set-opts [data-act="opt-pick"][aria-pressed="false"]']) await clickUi(sel);
    await sleep(400);
    const after = await snapSet();
    const ok = opened && freeAll(idle) && hintOff(idle) && !idle.stop && lockedAll(locked) && hintOn(locked) && !!locked.stop && locked.stop.text === 'Arrêter' && !locked.stop.dis
      && stateRaw(APP_STATE) === raw0 && !after.card && lockedAll(after) && alive(pid);
    return { ok, extra: J({ opened, idle, locked, after, stateKept: stateRaw(APP_STATE) === raw0 }) };
  });

  // k20: « Arrêter » ends the run, the controls come back (the pick and the switch work again) and the line is hidden
  await kgate('k20_settings_unlocked_after_stop', async () => {
    const opened = await openSettings();
    const { pid } = await appRun();
    const locked = await untilSet((s) => lockedAll(s) && s.hint && !s.hint.hidden);
    await clickUi('#plg-dhead [data-act="stop"]');
    const free = await untilSet((s) => freeAll(s) && s.hint && s.hint.hidden && !s.stop);
    const goneOk = await goneSoft(pid);
    await clickUi('#plg-set-opts [data-act="opt-pick"][aria-pressed="false"]');
    await clickUi('#plg-set-switch');
    await until(() => { const e = (appState() || {})[ID] || {}; return e.enabled === false && !!e.options; }, 5000, 'edits stored after the stop').catch(() => {});
    const entry = (appState() || {})[ID] || {};
    const ok = opened && lockedAll(locked) && hintOn(locked) && freeAll(free) && hintOff(free) && goneOk
      && sameJson(entry.options, { MODE: 'slow' }) && entry.enabled === false;
    return { ok, extra: J({ opened, locked, free, goneOk, entry }) };
  });

  // k21: the lock and the other rules are independent: the switch keeps « À configurer », the busy rule keeps « Modifier » and the switch
  // (rows patched in place, the tab re-rendered; the real list is read again at the end)
  await kgate('k21_settings_lock_matrix', async () => {
    const opened = await openSettings();
    await sleep(600);
    const show = async (patch, busy) => {
      await rend(`const r = window.plg.rows.find((x) => x.id === ${J(ID)}); Object.assign(r, ${J(patch)}); window.plg.busy[${busy ? '"add"' : '"delete"'}](${J(ID)});
        document.querySelector('#plg-detail [data-tab="journal"]').click(); document.querySelector('#plg-detail [data-tab="settings"]').click(); return true;`);
      await waitUi(`document.querySelectorAll('#plg-set-opts [data-act="opt-pick"]').length >= 2`);
      return snapSet();
    };
    const A = await show({ running: false, enabled: true, status: 'Prêt' }, false);
    const B = await show({ running: true, enabled: true, status: 'Prêt' }, false);
    const C = await show({ running: true, enabled: false, status: 'À configurer' }, false);
    const D = await show({ running: false, enabled: false, status: 'À configurer' }, false);
    const E = await show({ running: false, enabled: true, status: 'Prêt' }, true);
    const F = await show({ running: true, enabled: true, status: 'Prêt' }, true);
    const G = await show({ running: false, enabled: true, status: 'Prêt' }, false);
    await rend(`window.plg.busy.delete(${J(ID)}); await window.plgLoadList(); return true;`);
    const ok = opened && freeAll(A) && hintOff(A) && lockedAll(B) && hintOn(B) && lockedAll(C) && hintOn(C)
      && D.sw === true && D.edit === false && D.keep === false && D.opts.every((d) => d === false) && hintOff(D)
      && E.sw === true && E.edit === true && E.keep === false && E.opts.every((d) => d === false) && hintOff(E)
      && lockedAll(F) && hintOn(F) && freeAll(G) && hintOff(G);
    return { ok, extra: J({ opened, A, B, C, D, E, F, G }) };
  });
  return true;
}

main().then((loaded) => {
  const names = Object.keys(results);
  const bad = names.filter((n) => !results[n]);
  console.log(bad.length === 0 && loaded ? `VERDICT: ALL GREEN (${names.length}/${names.length})` : `VERDICT: FAIL (${names.length - bad.length}/${names.length}) failing: ${bad.join(', ')}`);
  return bad.length === 0 && loaded ? 0 : 1;
}).catch((e) => {
  console.log(`VERDICT: ERROR ${String(e && e.message).split('\n')[0]}`);
  return 1;
}).then((code) => {
  reap();
  for (const c of spawned) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
});
