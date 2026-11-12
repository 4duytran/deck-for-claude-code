'use strict';
// plugin-runner-probe - daily-brief S1s (plan v4.3, AMD-3): src/main/plugin-runner.js against a FAKE login
// shell (test/fixtures/plugins/runner-shell.sh, FAKE secrets only) and a fixture plugin (fixtures/plugins/fake).
// Hermetic: fake reports store in a mkdtemp dir, no main.js boot, no real rc, no real value read or printed.
//   xvfb-run -a node_modules/.bin/electron test/plugin-runner-probe.js
// PLUGIN_RUNNER_SRC=<dir> points the probe at another copy of src/main (mutation proofs).
//
// Gates: load, no_env_read | b_* child env (names, slot hash, host values, unset BASE skipped) | a2_* rc isolation
//   c_shellenv_stub | d_* hostile names refused, no spawn | spawn_* launch shape | single_flight* | exit0_* exit3_*
//   pid_* (sidecar pid, pid survives exec, pid-aware isRunning, cmdline guard) | signal_kill | spawn_error | spawn_throw
//   shell_fallback | shell_ic | userinfo_throw | prespawn_throw | stale_slot_dropped
//   eq_* an argv0 holding `=` (GNU env reads "$0" as an assignment) refused, no spawn, no value in the log | argv0abs_* the
//   validated realpath of the descriptor is what runs and what the pid guard looks for, lexical only without one
//   s1-s6 K2 runner.stop: s1 in-flight group TERM (grandchild gone, mark before signal, onExit once stopped) | s2 TERM ignored ->
//   SIGKILL after stopGraceMs | s3 survivor stopped + marked | s4 survivor failing the cmdline guard: no signal, no mark |
//   s5 not running: no mark | s6 ESRCH between check and kill is ok (fake plugins live in the probe TMP) | s7 a stop for a NEW run
//   started inside the old run's onExit is its own stop (signalled, its stem; the old stop still ok) | s8 concurrent stops of ONE run
//   (in flight, survivor) share one stop | s9 a late stop with no new run shares the old one
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('node:child_process');
const { EventEmitter } = require('events');
const { app } = require('electron');

const SRC = process.env.PLUGIN_RUNNER_SRC ? path.resolve(process.env.PLUGIN_RUNNER_SRC) : path.join(__dirname, '..', 'src', 'main');
const FIX = path.join(__dirname, 'fixtures', 'plugins');
const PLUGIN_DIR = fs.realpathSync(path.join(FIX, 'fake'));
const SHELL = path.join(FIX, 'runner-shell.sh');
const ARGV0 = path.join(PLUGIN_DIR, 'run.py');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'deck-plugin.json'), 'utf8'));
fs.chmodSync(ARGV0, 0o755);
fs.chmodSync(SHELL, 0o755);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-runner-probe-'));

// FAKE values, the same constants as runner-shell.sh.
const FAKE_MAPPED = 'fake-rsh-mapped-9c41e7';
const FAKE_OTHER = 'fake-rsh-other-5d02b8';
const BASE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ'];
const HOST = ['DECK_PLUGIN_ID', 'DECK_PLUGIN_DATA_DIR', 'DECK_PLUGIN_REPORT', 'DECK_PLUGIN_TRIGGER', 'DECK_PLUGIN_DATE'];
const OUTER_PATH = '/usr/local/bin:/usr/bin:/bin';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (n) => typeof n === 'string' && n.length <= 64 && NAME_RE.test(n);
const clock = () => new Date(2026, 10, 2, 9, 0, 0).getTime();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
// Process inspection without /proc (macOS has none): /proc on linux, `ps` on darwin; liveness is signal 0 on both.
// A darwin word is a space-separated token of the ps line, so a path holding a space splits there.
const kill0 = process.kill.bind(process); // taken before a probe spy replaces process.kill
const IS_DARWIN = process.platform === 'darwin';
const psOut = (args) => { try { return cp.execFileSync('ps', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const alive = (pid) => { try { kill0(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const cmdline = (pid) => {
  if (!IS_DARWIN) { try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0'); } catch { return []; } }
  const line = psOut(['-ww', '-o', 'command=', '-p', String(pid)]).replace(/\n+$/, '');
  return line ? line.split(' ') : [];
};
const cmdText = (pid) => cmdline(pid).join(' ');
const allCmdlines = () => (IS_DARWIN
  ? psOut(['-axww', '-o', 'pid=,command=']).split('\n').map((l) => /^\s*(\d+) (.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), words: m[2].split(' ') }))
  : fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map((n) => ({ pid: Number(n), words: cmdline(n) })));
const postExec =(pid) => { const c = cmdline(pid); return c.includes(ARGV0) && /python3$/.test(c[0] || ''); };

const results = {};
function gate(name, ok, extra) {
  results[name] = !!ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ' :: ' + extra}`);
}

// ---- spawn wrapper: records every call, `dry` swaps the next one for an inert fake child ----------------
const realSpawn = cp.spawn;
const spawnCalls = [];
let dryNext = false;
cp.spawn = (cmd, args, opts) => {
  const rec = { cmd, args: [...args], stdio: opts.stdio, detached: opts.detached, cwd: opts.cwd, env: { ...opts.env }, pid: null, unref: false };
  spawnCalls.push(rec);
  let child;
  if (dryNext) {
    dryNext = false;
    child = new EventEmitter();
    child.pid = undefined;
    child.unref = () => {};
    setImmediate(() => child.emit('exit', 0, null));
  } else {
    child = realSpawn(cmd, args, opts);
  }
  rec.pid = child.pid;
  const unref = child.unref.bind(child);
  child.unref = () => { rec.unref = true; return unref(); };
  return child;
};

// ---- ordered log shared by the fake store (marks) and the process.kill spy (signals), for the K2 gates -------
const events = [];

// ---- fake reports store (the pinned shape of plugin-reports.js) ------------------------------------------
function fakeReports(root) {
  const calls = { newEntry: [], setPid: [], finishEntry: [], markStopped: [] };
  const seq = {};
  const last = {};
  const dirOf = (id) => path.join(root, id, 'reports');
  const side = (id, stem) => path.join(dirOf(id), `${stem}.json`);
  const rd = (id, stem) => JSON.parse(fs.readFileSync(side(id, stem), 'utf8'));
  const wr = (id, stem, o) => fs.writeFileSync(side(id, stem), JSON.stringify(o));
  const api = {
    root, calls, rd, dirOf,
    newEntry(id, trigger) {
      calls.newEntry.push({ id, trigger });
      fs.mkdirSync(dirOf(id), { recursive: true });
      const n = (seq[id] = (seq[id] || 0) + 1);
      const stem = n === 1 ? '2026-11-02T0900' : `2026-11-02T0900-${n}`;
      wr(id, stem, { start: clock(), trigger, exit: null, size: 0, pid: null });
      last[id] = stem;
      return { stem, reportPath: path.join(dirOf(id), `${stem}.html`), logPath: path.join(dirOf(id), `${stem}.log`) };
    },
    setPid(id, stem, pid) { calls.setPid.push({ id, stem, pid }); wr(id, stem, { ...rd(id, stem), pid }); },
    finishEntry(id, stem, r) {
      calls.finishEntry.push({ id, stem, exit: r.exit, signal: r.signal });
      let size = 0;
      try { size = fs.statSync(path.join(dirOf(id), `${stem}.html`)).size; } catch { /* no report */ }
      wr(id, stem, { ...rd(id, stem), exit: r.exit, size });
    },
    markStopped(id, stem) { // contract of plugin-reports.js (lot c2): merges `stopped: true` into the sidecar
      calls.markStopped.push({ id, stem });
      events.push({ k: 'mark', id, stem });
      try { wr(id, stem, { ...rd(id, stem), stopped: true }); return true; } catch { return false; }
    },
    latest(id) { return last[id] ? { stem: last[id], ...rd(id, last[id]) } : null; },
    seed(id, o) { // craft the entry a previous Deck instance left behind
      fs.mkdirSync(dirOf(id), { recursive: true });
      const stem = o.stem || '2026-11-02T0800';
      wr(id, stem, { start: clock(), trigger: 'auto', exit: null, size: 0, pid: null, ...o });
      last[id] = stem;
      return stem;
    },
  };
  return api;
}

const plugin = (tail, env) => ({ id: 'fake', dir: PLUGIN_DIR, argv: ['run.py', ...tail], env: env || MANIFEST.env });
const MAP_A = { FAKE_TOKEN: 'RSH_MAPPED_TOKEN', FAKE_OPT: 'RSH_ABSENT' };
let mkN = 0;
let createFn = null;
function mk(opts = {}) {
  const exits = [];
  const reports = fakeReports(path.join(TMP, `data-${++mkN}`));
  const runner = createFn({
    reports, onExit: (id, info) => exits.push({ id, ...info }), nowFn: clock, shellPath: SHELL, baseNames: BASE, validName, ...opts,
  });
  return { runner, reports, exits };
}
const waitExits = (ctx, n) => until(() => ctx.exits.length >= n, 10000, `${n} exit(s)`);
const readLog = (ctx, stem) => fs.readFileSync(path.join(ctx.reports.dirOf('fake'), `${stem}.log`), 'utf8');
const readRec = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.reports.root, 'fake', 'record.json'), 'utf8'));
const spawned = [];
function foreign(args, env) { // a process a previous Deck instance would have left running
  const c = realSpawn(args[0], args.slice(1), { detached: true, stdio: 'ignore', env });
  spawned.push(c);
  return c;
}

async function main() {
  try {
    ({ create: createFn } = require(path.join(SRC, 'plugin-runner.js')));
  } catch (e) {
    gate('load', false, e.code || String(e.message).split('\n')[0]);
    return false;
  }
  gate('load', typeof createFn === 'function');
  const source = fs.readFileSync(path.join(SRC, 'plugin-runner.js'), 'utf8');
  gate('no_env_read', !/process\.env|resolveShellEnv|shell-env/.test(source));

  // gate c: the shell-env snapshot is stubbed to throw; the runner has no collaborator on it
  const shellEnv = require(path.join(SRC, 'shell-env.js'));
  let stubCalls = 0;
  shellEnv.resolveShellEnv = () => { stubCalls += 1; throw new Error('stubbed'); };

  // ---- run A: exit 0, manual, through the fake login shell -------------------------------------------------
  const A = mk();
  const rA = A.runner.run(plugin(['0', '0']), MAP_A, 'manual');
  gate('run_ok', rA && rA.ok === true && typeof rA.stem === 'string', JSON.stringify(rA));
  await waitExits(A, 1);
  const rec = readRec(A);
  const expectNames = [...['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG'], 'FAKE_TOKEN', ...HOST].sort();
  gate('b_names', JSON.stringify(rec.names) === JSON.stringify(expectNames), `got ${rec.names.join(',')}`);
  gate('b_unmapped_absent', !rec.names.includes('RSH_OTHER_SECRET') && !rec.names.includes('RSH_MAPPED_TOKEN') && !rec.names.includes('FAKE_OPT') && !rec.names.includes('TZ'));
  gate('b_slot_hash', rec.sha256.FAKE_TOKEN === sha(FAKE_MAPPED));
  const entry0 = A.reports.calls.newEntry[0];
  gate('b_host_values',
    rec.sha256.DECK_PLUGIN_ID === sha('fake') && rec.sha256.DECK_PLUGIN_TRIGGER === sha('manual') && rec.sha256.DECK_PLUGIN_DATE === sha('2026-11-02')
    && rec.sha256.DECK_PLUGIN_REPORT === sha(path.join(A.reports.dirOf('fake'), `${rA.stem}.html`))
    && rec.sha256.DECK_PLUGIN_DATA_DIR === sha(path.join(A.reports.root, 'fake')) && entry0.trigger === 'manual');
  gate('b_cwd_fd3', rec.cwd === PLUGIN_DIR && rec.fd3_open === false);

  const sc = spawnCalls[0];
  const expectTemplate = 'exec env -i ' + [
    ...BASE.map((b) => '${' + b + '+"' + b + '=$' + b + '"}'),
    '${RSH_MAPPED_TOKEN+"FAKE_TOKEN=$RSH_MAPPED_TOKEN"}', '${RSH_ABSENT+"FAKE_OPT=$RSH_ABSENT"}',
    ...HOST.map((h) => h + '="$' + h + '"'),
  ].join(' ') + ' "$0" "$@" 1>&3 2>&3 3>&-';
  gate('spawn_shape', sc.cmd === SHELL && sc.args[0] === '-ic' && sc.args[2] === ARGV0 && JSON.stringify(sc.args.slice(3)) === '["0","0"]'
    && sc.detached === true && sc.cwd === PLUGIN_DIR && sc.unref === true
    && sc.stdio.length === 4 && sc.stdio.slice(0, 3).every((x) => x === 'ignore') && Number.isInteger(sc.stdio[3]));
  gate('template_shape', sc.args[1] === expectTemplate, sc.args[1]);
  gate('spawn_outer_env', JSON.stringify(Object.keys(sc.env).sort()) === JSON.stringify(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', ...HOST].sort()) && sc.env.PATH === OUTER_PATH);
  const wire = JSON.stringify(spawnCalls.map((c) => [c.cmd, c.args, c.env, c.stdio]));
  gate('spawn_argv_clean', !wire.includes('fake-rsh-') && !JSON.stringify(rec.argv).includes('fake-rsh-'));

  // gate a2: the rc printed the fake secrets on stdout and stderr; only the plugin's own output reaches the log
  const log0 = readLog(A, rA.stem);
  gate('a2_log_plugin_output', log0.includes('fake-plugin-stdout') && log0.includes('fake-plugin-stderr'));
  gate('a2_rc_isolation', !log0.includes('fake-rsh-') && !log0.includes('rc-banner'));
  gate('c_shellenv_stub', stubCalls === 0 && A.exits[0].exit === 0);

  gate('exit0_finish', A.exits[0].exit === 0 && A.exits[0].signal === null && A.exits[0].error === null && A.exits[0].stem === rA.stem && A.exits[0].trigger === 'manual' && A.exits[0].id === 'fake'
    && A.reports.calls.finishEntry[0].exit === 0 && A.reports.calls.finishEntry[0].stem === rA.stem
    && A.reports.rd('fake', rA.stem).exit === 0 && A.reports.rd('fake', rA.stem).size > 0);
  const sp = A.reports.calls.setPid[0];
  gate('pid_sidecar', A.reports.calls.setPid.length === 1 && sp.stem === rA.stem && Number.isInteger(sp.pid) && sp.pid > 0 && sp.pid === sc.pid);

  // ---- exit 3 reaches finishEntry, second entry (-2) ---------------------------------------------------------
  const rB = A.runner.run(plugin(['3', '0']), MAP_A, 'auto');
  await waitExits(A, 2);
  gate('exit3_finish', rB.ok && rB.stem === '2026-11-02T0900-2' && A.exits[1].exit === 3 && A.exits[1].trigger === 'auto' && A.exits[1].error === null
    && A.reports.calls.finishEntry[1].exit === 3 && A.reports.rd('fake', rB.stem).exit === 3
    && readLog(A, rB.stem).includes('fake-plugin-stdout') && A.reports.calls.newEntry.length === 2);

  // ---- gate d: hostile names refused at launch, no spawn, no orphan entry --------------------------------------
  const FILE = path.join(os.tmpdir(), `p-${crypto.randomBytes(6).toString('hex')}`);
  const HOSTILE = [`X;touch ${FILE}`, `X$(touch ${FILE})`, `X\`touch ${FILE}\``, `X\ntouch ${FILE}`, `X touch ${FILE}`, `X"; touch ${FILE}; "`, '', '1X', 'X=Y', 'a-b'];
  const D = mk();
  const callsBefore = spawnCalls.length;
  let slotOk = true; let varOk = true; let baseOk = true;
  for (const h of HOSTILE) {
    const rs = D.runner.run(plugin(['0', '0'], [{ name: h }]), { [h]: 'RSH_MAPPED_TOKEN' }, 'manual');
    const rv = D.runner.run(plugin(['0', '0']), { FAKE_TOKEN: h }, 'manual');
    const Db = mk({ baseNames: [...BASE, h] });
    const rb = Db.runner.run(plugin(['0', '0']), MAP_A, 'manual');
    slotOk = slotOk && rs.ok === false && rs.reason === 'invalid-name' && Db.reports.calls.newEntry.length === 0;
    varOk = varOk && rv.ok === false && rv.reason === 'invalid-name';
    baseOk = baseOk && rb.ok === false && rb.reason === 'invalid-name' && Db.reports.calls.newEntry.length === 0;
  }
  await sleep(150);
  gate('d_slot_refused', slotOk);
  gate('d_var_refused', varOk);
  gate('d_base_refused', baseOk);
  gate('d_no_spawn_no_entry', spawnCalls.length === callsBefore && D.reports.calls.newEntry.length === 0 && D.exits.length === 0);
  gate('d_file_absent', !fs.existsSync(FILE));
  const rt = D.runner.run(plugin(['0', '0']), MAP_A, 'weird');
  gate('d_bad_trigger', rt.ok === false && spawnCalls.length === callsBefore);

  // ---- an argv0 holding `=`: GNU `env` would read "$0" as an assignment and print BASE + the mapped values into the log ----
  const mkScript = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\necho ran-eq\n', { mode: 0o755 }); return file; };
  const EQ_A = path.join(TMP, 'eqa');
  mkScript(path.join(EQ_A, 'bin', 'x=y'));
  const EQ_DIR = path.join(TMP, 'eq=plugins', 'p'); // a plugins dir with `=` in its path: argv[0] itself is clean
  mkScript(path.join(EQ_DIR, 'run.sh'));
  const eqCases = {
    lexical: { id: 'fake', dir: EQ_A, argv: ['bin/x=y'], env: MANIFEST.env },
    dir: { id: 'fake', dir: EQ_DIR, argv: ['run.sh'], env: MANIFEST.env },
    abs: { id: 'fake', dir: PLUGIN_DIR, argv: ['run.py', '0', '0'], argv0Abs: path.join(EQ_DIR, 'run.sh'), env: MANIFEST.env }, // the validated path holds `=`
  };
  const eq = {};
  for (const [k, desc] of Object.entries(eqCases)) {
    const ctx = mk();
    const n0 = spawnCalls.length;
    const r = ctx.runner.run(desc, MAP_A, 'manual');
    let log = '';
    if (r && r.ok) { await waitExits(ctx, 1); log = readLog(ctx, r.stem); } else await sleep(100);
    eq[k] = { r, spawns: spawnCalls.length - n0, entries: ctx.reports.calls.newEntry.length, leaked: log.includes('fake-rsh-') };
  }
  gate('eq_argv0_refused', Object.values(eq).every((x) => x.r && x.r.ok === false && x.r.reason === 'invalid-argv0'), JSON.stringify(Object.values(eq).map((x) => x.r)));
  gate('eq_no_spawn_no_entry', Object.values(eq).every((x) => x.spawns === 0 && x.entries === 0), JSON.stringify(Object.values(eq).map((x) => [x.spawns, x.entries])));
  gate('eq_no_secret_in_log', Object.values(eq).every((x) => !x.leaked), JSON.stringify(Object.values(eq).map((x) => x.leaked)));
  dryNext = true;
  const eqArg = mk();
  const rEqArg = eqArg.runner.run(plugin(['0', '0', '--key=value', 'a=b']), MAP_A, 'manual');
  await waitExits(eqArg, 1);
  gate('eq_arg_with_equals_ok', rEqArg.ok === true && JSON.stringify(spawnCalls[spawnCalls.length - 1].args.slice(5)) === '["--key=value","a=b"]');

  // ---- the validated realpath (manifest argv0Abs) is what runs, not argv[0] rebuilt lexically -------------------------------
  // `link.sh` was an in-folder symlink when the manifest scan validated it; afterwards it is retargeted OUTSIDE the folder.
  const LNK = path.join(fs.realpathSync(TMP), 'lnk');
  const REAL = path.join(LNK, 'real.sh');
  const OUT = path.join(fs.realpathSync(TMP), 'outside.sh');
  fs.mkdirSync(LNK, { recursive: true });
  fs.writeFileSync(REAL, '#!/bin/sh\necho ran-real\nsleep "${1:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(OUT, '#!/bin/sh\necho ran-outside\n', { mode: 0o755 });
  fs.symlinkSync(OUT, path.join(LNK, 'link.sh')); // the state after the retarget; the validated state is `argv0Abs: REAL` below
  const validated = { id: 'fake', dir: LNK, argv: ['link.sh', '0'], argv0Abs: REAL, env: MANIFEST.env };
  const V = mk();
  const rV = V.runner.run(validated, MAP_A, 'manual');
  await waitExits(V, 1);
  const logV = readLog(V, rV.stem);
  const scV = spawnCalls[spawnCalls.length - 1];
  gate('argv0abs_spawned', rV.ok === true && scV.args[2] === REAL && logV.includes('ran-real') && !logV.includes('ran-outside'), `${scV.args[2]} :: ${JSON.stringify(logV.slice(0, 120))}`);
  dryNext = true; // no argv0Abs, or one that is not absolute: the lexical form
  const L = mk();
  L.runner.run({ id: 'fake', dir: LNK, argv: ['link.sh', '0'], env: MANIFEST.env }, MAP_A, 'manual');
  await waitExits(L, 1);
  const lexA = spawnCalls[spawnCalls.length - 1].args[2];
  dryNext = true;
  const L2 = mk();
  L2.runner.run({ id: 'fake', dir: LNK, argv: ['link.sh', '0'], argv0Abs: 'real.sh', env: MANIFEST.env }, MAP_A, 'manual');
  await waitExits(L2, 1);
  gate('argv0abs_lexical_fallback', lexA === path.join(LNK, 'link.sh') && spawnCalls[spawnCalls.length - 1].args[2] === path.join(LNK, 'link.sh'), `${lexA}`);
  // pid-reuse guard: a process left by a previous Deck runs the validated realpath; its cmdline never holds `link.sh`
  const liveV = foreign([REAL, '8'], { PATH: OUTER_PATH });
  await until(() => cmdline(liveV.pid).includes(REAL), 5000, 'foreign validated plugin up');
  const PV = mk();
  const stemV = PV.reports.seed('fake', { pid: liveV.pid, exit: null });
  gate('argv0abs_pid_guard', PV.runner.isRunning('fake', validated) === true && PV.runner.runningStem('fake', validated) === stemV
    && PV.runner.isRunning('fake', { ...validated, argv0Abs: undefined }) === false);

  // ---- stale slot: a mapping the manifest no longer declares is dropped -------------------------------------
  const S = mk();
  S.runner.run(plugin(['0', '0']), { ...MAP_A, STALE_SLOT: 'RSH_OTHER_SECRET' }, 'manual');
  await waitExits(S, 1);
  const recS = readRec(S);
  gate('stale_slot_dropped', !recS.names.includes('STALE_SLOT') && !recS.names.includes('RSH_OTHER_SECRET') && JSON.stringify(recS.names) === JSON.stringify(expectNames));

  // ---- single flight + pid survives the exec chain + signal ---------------------------------------------------
  const nSpawn = spawnCalls.length;
  const nEntry = A.reports.calls.newEntry.length;
  const r1 = A.runner.run(plugin(['0', '2']), MAP_A, 'manual');
  const r2 = A.runner.run(plugin(['0', '0']), MAP_A, 'manual');
  const pid1 = spawnCalls[spawnCalls.length - 1].pid;
  gate('single_flight', r1.ok === true && r2.ok === false && r2.reason === 'running' && spawnCalls.length === nSpawn + 1 && A.reports.calls.newEntry.length === nEntry + 1
    && A.runner.isRunning('fake') === true && A.runner.runningStem('fake') === r1.stem);
  gate('pid_in_sidecar', A.reports.rd('fake', r1.stem).pid === pid1 && Number.isInteger(pid1));
  await until(() => postExec(pid1), 5000, 'exec chain to reach the plugin');
  gate('pid_survives_exec', postExec(pid1) && A.reports.rd('fake', r1.stem).pid === pid1);
  await waitExits(A, 3);
  gate('single_flight_after', A.runner.isRunning('fake') === false && A.runner.runningStem('fake') === null && A.exits[2].exit === 0);

  const r3 = A.runner.run(plugin(['0', '6']), MAP_A, 'auto');
  const pid3 = spawnCalls[spawnCalls.length - 1].pid;
  await until(() => postExec(pid3), 5000, 'exec chain before the kill');
  process.kill(pid3, 'SIGTERM');
  await waitExits(A, 4);
  gate('signal_kill', r3.ok && A.exits[3].exit === null && A.exits[3].signal === 'SIGTERM' && A.exits[3].error === null
    && A.reports.calls.finishEntry[3].exit === null && A.reports.calls.finishEntry[3].signal === 'SIGTERM' && A.runner.isRunning('fake') === false);

  // ---- spawn failure: missing shell, then a throwing spawn -----------------------------------------------------
  const E = mk({ shellPath: path.join(TMP, 'no', 'such', 'shell') });
  const rE = E.runner.run(plugin(['0', '0']), MAP_A, 'auto');
  await waitExits(E, 1);
  gate('spawn_error', rE.ok === true && typeof E.exits[0].error === 'string' && E.exits[0].error.length > 0 && E.exits[0].exit === null && E.exits[0].signal === null
    && E.reports.calls.setPid.length === 0 && E.reports.calls.finishEntry[0].exit === null && E.runner.isRunning('fake') === false
    && fs.existsSync(path.join(E.reports.dirOf('fake'), `${rE.stem}.log`)));
  const nExit = A.exits.length;
  const rT = A.runner.run(plugin(['0', '0\u0000x']), MAP_A, 'auto');
  await waitExits(A, nExit + 1);
  gate('spawn_throw', rT.ok === true && typeof A.exits[nExit].error === 'string' && A.exits[nExit].exit === null && A.runner.isRunning('fake') === false);

  // ---- shell family and flags --------------------------------------------------------------------------------
  const shellOf = async (shellPath) => {
    dryNext = true;
    const c = mk({ shellPath });
    const r = c.runner.run(plugin(['0', '0']), MAP_A, 'manual');
    await waitExits(c, 1);
    return { r, call: spawnCalls[spawnCalls.length - 1] };
  };
  const fish = await shellOf('/usr/bin/fish');
  const zsh = await shellOf('/usr/bin/zsh');
  const bash = await shellOf('/bin/bash');
  gate('shell_fallback', fish.call.cmd === '/bin/bash' && fish.r.note === 'shell non pris en charge, lecture via bash' && fish.call.args[1] === expectTemplate
    && zsh.call.cmd === '/usr/bin/zsh' && zsh.r.note === undefined && bash.call.cmd === '/bin/bash' && bash.r.note === undefined);
  gate('shell_ic', [fish, zsh, bash].every((x) => x.call.args[0] === '-ic') && sc.args[0] === '-ic' && !/shellFlags/.test(source));

  // ---- the passwd entry is missing (os.userInfo throws): no env read, no stuck « running » ------------------------
  const fakeEnvUser = 'FAKE-ENV-USER-8m3q02';
  const attempt = (ctx) => {
    let r = null;
    let threw = null;
    try { r = ctx.runner.run(plugin(['0', '0']), MAP_A, 'manual'); } catch (e) { threw = e.name; }
    return { r, threw };
  };
  const fakeEnvHome = '/tmp/FAKE-ENV-HOME-5t8n40';
  const realUserInfo = os.userInfo;
  const savedUser = process.env.USER;
  const savedHome = process.env.HOME;
  process.env.USER = fakeEnvUser;
  process.env.HOME = fakeEnvHome;
  os.userInfo = () => { throw new Error('no passwd entry'); };
  const U = mk({ shellPath: undefined });
  let uTry;
  dryNext = true; // inert child: the real rc files are never read
  try {
    uTry = attempt(U);
    if (uTry.r && uTry.r.ok) await waitExits(U, 1);
  } finally {
    dryNext = false;
    os.userInfo = realUserInfo;
    if (savedUser === undefined) delete process.env.USER; else process.env.USER = savedUser;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
  const usc = spawnCalls[spawnCalls.length - 1];
  gate('userinfo_throw', uTry.threw === null && uTry.r && uTry.r.ok === true && U.exits.length === 1 && U.exits[0].exit === 0 && U.runner.isRunning('fake') === false
    && !JSON.stringify(usc.env).includes(fakeEnvUser) && !JSON.stringify(usc.env).includes(fakeEnvHome)
    && usc.env.USER === '' && usc.env.LOGNAME === '' && usc.env.HOME === '' && usc.env.SHELL === '/bin/bash' && usc.cmd === '/bin/bash',
  JSON.stringify({ threw: uTry.threw, ok: uTry.r && uTry.r.ok, running: U.runner.isRunning('fake'), env: { USER: usc.env.USER, HOME: usc.env.HOME, SHELL: usc.env.SHELL } }));

  // anything between inflight.set and the spawn that throws must end the run cleanly, never leave it « running »
  const nPre = spawnCalls.length;
  const T = mk({ nowFn: () => { throw new TypeError('clock'); } });
  const tTry = attempt(T);
  if (tTry.r && tTry.r.ok) await waitExits(T, 1);
  gate('prespawn_throw', tTry.threw === null && tTry.r && tTry.r.ok === true && T.exits.length === 1 && typeof T.exits[0].error === 'string' && T.exits[0].exit === null
    && T.reports.calls.finishEntry.length === 1 && T.runner.isRunning('fake') === false && spawnCalls.length === nPre,
  JSON.stringify({ threw: tTry.threw, running: T.runner.isRunning('fake'), exits: T.exits.length }));

  // ---- pid-aware isRunning across a Deck restart (fold v4.2 #5) -----------------------------------------------
  const FENV = { PATH: OUTER_PATH, DECK_PLUGIN_DATA_DIR: TMP, DECK_PLUGIN_REPORT: path.join(TMP, 'foreign.html') };
  const live = foreign([ARGV0, '0', '8'], FENV);
  await until(() => postExec(live.pid), 5000, 'foreign plugin up');
  const other = foreign(['/usr/bin/sleep', '8'], { PATH: OUTER_PATH });
  const dead = foreign(['/usr/bin/true'], { PATH: OUTER_PATH });
  await new Promise((r) => dead.on('exit', r));
  const P = plugin(['0', '0']);

  const R1 = mk(); // a fresh runner = the Deck after a restart: nothing in memory
  const nS = spawnCalls.length;
  R1.reports.seed('fake', { stem: '2026-11-02T0800', pid: live.pid, exit: null });
  const stemLive = '2026-11-02T0800';
  gate('pid_live_running', R1.runner.isRunning('fake', P) === true && R1.runner.runningStem('fake', P) === stemLive);
  const rr = R1.runner.run(P, MAP_A, 'manual');
  gate('pid_live_refuses_run', rr.ok === false && rr.reason === 'running' && spawnCalls.length === nS && R1.reports.calls.newEntry.length === 0);
  gate('pid_no_argv0_unknown', R1.runner.isRunning('fake') === false);
  R1.reports.seed('fake', { pid: dead.pid, exit: null });
  gate('pid_dead_not_running', R1.runner.isRunning('fake', P) === false && R1.runner.runningStem('fake', P) === null);
  R1.reports.seed('fake', { pid: other.pid, exit: null });
  gate('pid_foreign_not_running', R1.runner.isRunning('fake', P) === false && R1.runner.runningStem('fake', P) === null);
  R1.reports.seed('fake', { pid: live.pid, exit: 0 });
  gate('pid_exit_set_not_running', R1.runner.isRunning('fake', P) === false);
  R1.reports.seed('fake', { pid: null, exit: null });
  gate('pid_null_not_running', R1.runner.isRunning('fake', P) === false);
  // a runner that launched the plugin itself remembers its argv0, so the guard works without the descriptor
  A.reports.seed('fake', { pid: live.pid, exit: null });
  gate('pid_remembered_argv0', A.runner.isRunning('fake') === true);

  // ---- ps matcher, the macOS pid guard: procps takes the same `ps -ww -o command= -p <pid>` call, so Linux observes it too ----
  const { procHolds: procMatch, psHolds: psMatch } = require(path.join(SRC, 'plugin-runner.js')); // the cached module `create` came from
  const haveMatchers = typeof procMatch === 'function' && typeof psMatch === 'function';
  if (IS_DARWIN) console.log('SKIP r-ps-equiv — no /proc on darwin');
  else {
    const asked = [[live.pid, ARGV0], [live.pid, ARGV0.slice(0, -1)], [live.pid, ARGV0.slice(1)], [other.pid, ARGV0], [dead.pid, ARGV0]];
    const rows = haveMatchers ? asked.map(([pid, abs]) => [procMatch(pid, abs), psMatch(pid, abs)]) : [];
    gate('r-ps-equiv', haveMatchers && rows[0][0] === true && rows.slice(1).every(([p]) => p === false) && rows.every(([p, s]) => p === s), JSON.stringify(rows));
  }
  const SP_DIR = path.join(fs.realpathSync(TMP), 'dir with space');
  const SP_FILE = path.join(SP_DIR, 'run.sh'); // a shell fixture, not run.py: run.py reads /proc/self/environ, which macOS lacks
  fs.mkdirSync(SP_DIR, { recursive: true });
  fs.writeFileSync(SP_FILE, '#!/bin/sh\n/bin/sleep 8\nexit 0\n', { mode: 0o755 });
  const spaced = foreign([SP_FILE], { PATH: OUTER_PATH });
  const sleeper = foreign(['/bin/sleep', '8'], { PATH: OUTER_PATH });
  await until(() => cmdText(spaced.pid).includes(SP_FILE) && /sleep/.test(cmdText(sleeper.pid)), 5000, 'spaced fixture and foreign sleep up');
  const spRows = haveMatchers ? {
    held: psMatch(spaced.pid, SP_FILE), foreignPid: psMatch(sleeper.pid, SP_FILE), noLeading: psMatch(spaced.pid, SP_FILE.slice(1)),
    noTrailing: psMatch(spaced.pid, SP_FILE.slice(0, -1)), dead: psMatch(dead.pid, SP_FILE),
  } : {};
  gate('r-ps-darwin', haveMatchers && spRows.held === true && spRows.foreignPid === false && spRows.noLeading === false && spRows.noTrailing === false && spRows.dead === false, JSON.stringify(spRows));

  // the darwin branch of pidHolds itself, with `ps` swapped for a script on PATH: the answer must come from ps, never from /proc
  const FAKE_BIN = path.join(fs.realpathSync(TMP), 'fakebin');
  const ARGS_FILE = path.join(FAKE_BIN, 'args');
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.writeFileSync(path.join(FAKE_BIN, 'ps'), `#!/bin/sh\necho "$*" > "$FAKE_PS_ARGS"\nprintf '%s\\n' "$FAKE_PS_LINE"\n`, { mode: 0o755 });
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const askFake = (platform, line, pid) => { // synchronous: nothing else runs while process.platform and PATH are swapped
    const keys = ['PATH', 'FAKE_PS_LINE', 'FAKE_PS_ARGS'];
    const saved = keys.map((k) => process.env[k]);
    Object.defineProperty(process, 'platform', { ...platformDesc, value: platform });
    Object.assign(process.env, { PATH: `${FAKE_BIN}:${saved[0]}`, FAKE_PS_LINE: line, FAKE_PS_ARGS: ARGS_FILE });
    try {
      const R = mk();
      R.reports.seed('fake', { pid, exit: null });
      return R.runner.isRunning('fake', { id: 'fake', dir: SP_DIR, argv: ['run.sh'], argv0Abs: SP_FILE, env: [] });
    } finally {
      Object.defineProperty(process, 'platform', platformDesc);
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
  };
  const viaPs = askFake('darwin', `/bin/sh ${SP_FILE} arg`, sleeper.pid); // ps says held, /proc says a bare sleep
  let psArgs = '';
  try { psArgs = fs.readFileSync(ARGS_FILE, 'utf8').trim(); } catch { /* ps was never asked */ }
  const psVeto = askFake('darwin', '/bin/sleep 8', spaced.pid); // ps says foreign, /proc says held
  const viaProc = askFake('linux', `/bin/sh ${SP_FILE} arg`, sleeper.pid); // not darwin: /proc only
  gate('r-ps-dispatch', viaPs === true && psArgs === `-ww -o command= -p ${sleeper.pid}` && psVeto === false && viaProc === false, JSON.stringify({ viaPs, psArgs, psVeto, viaProc }));

  // ---- K2 stop: the plugin's own process group, signalled only while the pid passes the cmdline guard -----------------
  const STOP_DIR = path.join(fs.realpathSync(TMP), 'stop');
  const gone = (pid) => until(() => !alive(pid), 3000, `pid ${pid} gone`);
  const stopPlugin = (name, body) => { // a fake plugin built in the probe TMP
    const dir = path.join(STOP_DIR, name);
    const file = path.join(dir, 'run.sh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { id: 'fake', dir, argv: ['run.sh'], argv0Abs: file, env: [] };
  };
  const fileOf = (c, name) => path.join(c.reports.root, 'fake', name);
  const upFile = (c) => until(() => fs.existsSync(fileOf(c, 'up')), 5000, 'fake plugin up');
  const reapFixtures = () => { // leftovers of a red run: only processes whose cmdline names this probe's own stop folder
    for (const { pid, words } of allCmdlines()) {
      if (!words.some((w) => w.includes(STOP_DIR))) continue;
      for (const target of [-pid, pid]) { try { realKill(target, 'SIGKILL'); } catch { /* not a leader, or gone */ } }
    }
  };
  const realKill = process.kill.bind(process);
  let killHook = null;
  process.kill = (pid, sig) => { // spy: records every real signal (0 is the liveness test), a hook may throw in its place
    const s = sig === undefined ? 'SIGTERM' : sig;
    if (s !== 0) events.push({ k: 'kill', pid, sig: s });
    if (killHook && s !== 0) killHook(pid, s);
    return realKill(pid, sig);
  };
  const sgate = async (name, fn) => {
    killHook = null;
    try { const r = await fn(); gate(name, r.ok, r.extra); } catch (e) { gate(name, false, String(e && e.message).split('\n')[0]); } finally { killHook = null; reapFixtures(); }
  };
  const kills = (from) => events.slice(from).filter((e) => e.k === 'kill');
  try {
    // s1: in-flight run, a grandchild `sleep 30`: stop ends the whole group, marks BEFORE the signal, onExit ran when it resolves
    await sgate('s1_stop_inflight_group', async () => {
      const d = stopPlugin('s1', '/bin/sleep 30 &\necho $! > "$DECK_PLUGIN_DATA_DIR/gc.pid"\nwait');
      const c = mk();
      const r = c.runner.run(d, {}, 'manual');
      await until(() => fs.existsSync(fileOf(c, 'gc.pid')) && /^\d+\s*$/.test(fs.readFileSync(fileOf(c, 'gc.pid'), 'utf8')), 5000, 'grandchild up');
      const gc = Number(fs.readFileSync(fileOf(c, 'gc.pid'), 'utf8'));
      const pid = c.reports.rd('fake', r.stem).pid;
      const from = events.length;
      const res = await c.runner.stop('fake', d);
      const ev = events.slice(from);
      const iMark = ev.findIndex((e) => e.k === 'mark');
      const iKill = ev.findIndex((e) => e.k === 'kill');
      const ks = kills(from);
      const exitsAtResolve = c.exits.length;
      await gone(gc);
      await gone(pid);
      const ok = res && res.ok === true && res.stem === r.stem && iMark >= 0 && iKill > iMark && ks.length === 1 && ks[0].pid === -pid && ks[0].sig === 'SIGTERM'
        && c.reports.calls.markStopped.length === 1 && c.reports.calls.markStopped[0].stem === r.stem && c.reports.rd('fake', r.stem).stopped === true
        && exitsAtResolve === 1 && c.exits.length === 1 && c.exits[0].stopped === true && c.exits[0].signal === 'SIGTERM' && c.runner.isRunning('fake') === false;
      return { ok, extra: JSON.stringify({ res, iMark, iKill, ks, exits: c.exits.length, exitsAtResolve }) };
    });

    // s2: TERM ignored (the sleeps inherit the ignore): SIGKILL once stopGraceMs is over
    await sgate('s2_term_ignored_sigkill', async () => {
      const d = stopPlugin('s2', "trap '' TERM\necho up > \"$DECK_PLUGIN_DATA_DIR/up\"\nwhile :; do /bin/sleep 1; done");
      const c = mk({ stopGraceMs: 300 });
      const r = c.runner.run(d, {}, 'manual');
      await upFile(c);
      const pid = c.reports.rd('fake', r.stem).pid;
      const from = events.length;
      const t0 = Date.now();
      const res = await c.runner.stop('fake', d);
      const ms = Date.now() - t0;
      const ks = kills(from);
      await gone(pid);
      const ok = res && res.ok === true && res.stem === r.stem && ks.map((k) => k.sig).join() === 'SIGTERM,SIGKILL' && ks.every((k) => k.pid === -pid)
        && ms >= 280 && ms < 2500 && c.exits.length === 1 && c.exits[0].stopped === true && c.exits[0].signal === 'SIGKILL';
      return { ok, extra: JSON.stringify({ res, ks, ms, exits: c.exits.map((x) => [x.signal, x.stopped]) }) };
    });

    // s3: a survivor of a previous Deck (nothing in memory): stopped and marked, no onExit (this instance never settled it)
    await sgate('s3_stop_survivor', async () => {
      const d = stopPlugin('s3', '/bin/sleep 30 &\nwait');
      const live = foreign([d.argv0Abs], { PATH: OUTER_PATH });
      await until(() => cmdline(live.pid).includes(d.argv0Abs), 5000, 'survivor up');
      const c = mk();
      const stem = c.reports.seed('fake', { pid: live.pid, exit: null });
      const from = events.length;
      const res = await c.runner.stop('fake', d);
      const ks = kills(from);
      await gone(live.pid);
      const ok = res && res.ok === true && res.stem === stem && ks.length === 1 && ks[0].pid === -live.pid && ks[0].sig === 'SIGTERM'
        && c.reports.calls.markStopped.length === 1 && c.reports.calls.markStopped[0].stem === stem && c.reports.rd('fake', stem).stopped === true
        && events.slice(from).findIndex((e) => e.k === 'mark') < events.slice(from).findIndex((e) => e.k === 'kill') && c.exits.length === 0;
      return { ok, extra: JSON.stringify({ res, ks, marks: c.reports.calls.markStopped }) };
    });

    // s4: a live pid whose cmdline lacks the plugin's argv0 (pid reuse): never signalled, never marked
    await sgate('s4_foreign_pid_untouched', async () => {
      const d = stopPlugin('s4', 'wait');
      const other = foreign(['/usr/bin/sleep', '8'], { PATH: OUTER_PATH });
      await until(() => cmdline(other.pid).includes('8') && !cmdline(other.pid).includes(process.execPath), 5000, 'foreign sleep up');
      const c = mk();
      c.reports.seed('fake', { pid: other.pid, exit: null });
      const from = events.length;
      const res = await c.runner.stop('fake', d);
      const ok = res && res.ok === false && res.reason === 'not-running' && events.length === from && alive(other.pid) && realKill(other.pid, 0) === true
        && c.reports.calls.markStopped.length === 0 && c.reports.rd('fake', c.reports.latest('fake').stem).stopped === undefined;
      return { ok, extra: JSON.stringify({ res, signals: kills(from), marks: c.reports.calls.markStopped.length }) };
    });

    // s5: nothing running (no entry, then an entry with a dead pid): not-running, no mark, no signal
    await sgate('s5_not_running', async () => {
      const d = stopPlugin('s5', 'wait');
      const c = mk();
      const from = events.length;
      const none = await c.runner.stop('fake', d);
      const deadProc = foreign(['/usr/bin/true'], { PATH: OUTER_PATH });
      await new Promise((r) => deadProc.on('exit', r));
      c.reports.seed('fake', { pid: deadProc.pid, exit: null });
      const dead = await c.runner.stop('fake', d);
      const ok = none && none.ok === false && none.reason === 'not-running' && dead && dead.ok === false && dead.reason === 'not-running'
        && events.length === from && c.reports.calls.markStopped.length === 0;
      return { ok, extra: JSON.stringify({ none, dead, events: events.length - from }) };
    });

    // s6: the process exits between the check and the kill (ESRCH on the group signal): stop still resolves ok
    await sgate('s6_esrch_is_ok', async () => {
      const d = stopPlugin('s6', 'echo up > "$DECK_PLUGIN_DATA_DIR/up"\n/bin/sleep 30\necho done');
      const c = mk();
      const r = c.runner.run(d, {}, 'manual');
      await upFile(c);
      const pid = c.reports.rd('fake', r.stem).pid;
      let fired = 0;
      killHook = (target, sig) => { // the process dies for real, then the kill reports ESRCH
        if (sig !== 'SIGTERM' || target !== -pid || fired) return;
        fired += 1;
        realKill(target, 'SIGKILL');
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      };
      const from = events.length;
      const res = await c.runner.stop('fake', d);
      const ks = kills(from);
      await gone(pid);
      const ok = fired === 1 && res && res.ok === true && res.stem === r.stem && ks.length === 1 && c.reports.calls.markStopped.length === 1
        && c.exits.length === 1 && c.exits[0].stopped === true && c.runner.isRunning('fake') === false;
      return { ok, extra: JSON.stringify({ fired, res, ks, exits: c.exits.length }) };
    });

    // s7: run A is stopped; inside A's onExit (settle ran, the old stop still polls for the exit) run B starts and its stop is
    // requested at once. B must get its OWN stop: signalled, answered with B's stem; the stop of A still answers A's stem.
    await sgate('s7_stop_of_new_run_is_its_own', async () => {
      const d = stopPlugin('s7', 'echo up >> "$DECK_PLUGIN_DATA_DIR/ups"\n/bin/sleep 30');
      const exits = [];
      const B = { run: null, pid: null, stop: null };
      const c = mk({
        stopGraceMs: 1500,
        onExit: (id, info) => {
          exits.push({ id, ...info });
          if (B.run) return;
          B.run = c.runner.run(d, {}, 'manual');
          B.pid = c.reports.rd('fake', B.run.stem).pid;
          B.stop = c.runner.stop('fake', d);
        },
      });
      const r = c.runner.run(d, {}, 'manual');
      await until(() => fs.existsSync(fileOf(c, 'ups')), 5000, 'run A up');
      const pidA = c.reports.rd('fake', r.stem).pid;
      const from = events.length;
      const resA = await c.runner.stop('fake', d);
      const resB = B.stop ? await B.stop : null;
      const goneB = B.pid ? await gone(B.pid).then(() => true, () => false) : false;
      await gone(pidA);
      const bothExited = await until(() => exits.length >= 2, 4000, 'both exits').then(() => true, () => false);
      const ks = kills(from);
      const marks = c.reports.calls.markStopped.map((m) => m.stem);
      const ok = resA && resA.ok === true && resA.stem === r.stem && B.run && B.run.ok === true && B.run.stem !== r.stem
        && resB && resB.ok === true && resB.stem === B.run.stem && goneB && bothExited && ks.some((k) => k.pid === -B.pid)
        && ks.filter((k) => k.pid === -pidA).length === 1 && marks.length === 2 && marks.includes(r.stem) && marks.includes(B.run.stem)
        && exits[0].stem === r.stem && exits[0].stopped === true && exits[1].stem === B.run.stem && exits[1].stopped === true
        && c.runner.isRunning('fake') === false;
      return { ok, extra: JSON.stringify({ resA, resB, stemA: r.stem, stemB: B.run && B.run.stem, goneB, bothExited, ks, marks, exits: exits.map((x) => [x.stem, x.stopped, x.signal]) }) };
    });

    // s8: two stop() calls at once for the SAME run share one stop: one mark, one signal, the same answer (in flight, and a survivor)
    await sgate('s8_concurrent_stops_of_one_run_share', async () => {
      const d = stopPlugin('s8', 'echo up > "$DECK_PLUGIN_DATA_DIR/up"\n/bin/sleep 30');
      const c = mk({ stopGraceMs: 1500 });
      const r = c.runner.run(d, {}, 'manual');
      await upFile(c);
      const pid = c.reports.rd('fake', r.stem).pid;
      const from = events.length;
      const [a, b] = await Promise.all([c.runner.stop('fake', d), c.runner.stop('fake', d)]);
      const ks = kills(from);
      await gone(pid);
      const flightOk = a && b && a.ok === true && b.ok === true && a.stem === r.stem && b.stem === r.stem && ks.length === 1 && ks[0].pid === -pid
        && ks[0].sig === 'SIGTERM' && c.reports.calls.markStopped.length === 1 && c.exits.length === 1 && c.exits[0].stopped === true;

      const d2 = stopPlugin('s8s', '/bin/sleep 30 &\nwait');
      const live = foreign([d2.argv0Abs], { PATH: OUTER_PATH });
      await until(() => cmdline(live.pid).includes(d2.argv0Abs), 5000, 'survivor up');
      const c2 = mk();
      const stem2 = c2.reports.seed('fake', { pid: live.pid, exit: null });
      const from2 = events.length;
      const [s1, s2] = await Promise.all([c2.runner.stop('fake', d2), c2.runner.stop('fake', d2)]);
      const ks2 = kills(from2);
      await gone(live.pid);
      const survivorOk = s1 && s2 && s1.ok === true && s2.ok === true && s1.stem === stem2 && s2.stem === stem2 && ks2.length === 1 && ks2[0].pid === -live.pid
        && c2.reports.calls.markStopped.length === 1;
      return { ok: flightOk && survivorOk, extra: JSON.stringify({ a, b, ks, marks: c.reports.calls.markStopped.length, s1, s2, ks2, marks2: c2.reports.calls.markStopped.length }) };
    });

    // s9: a stop requested after the run ended, while the old stop still polls and no new run exists, shares that stop (ok, no second mark)
    await sgate('s9_late_stop_without_new_run_shares', async () => {
      const d = stopPlugin('s9', 'echo up > "$DECK_PLUGIN_DATA_DIR/up"\n/bin/sleep 30');
      const exits = [];
      let late = null;
      const c = mk({ stopGraceMs: 1500, onExit: (id, info) => { exits.push({ id, ...info }); late = c.runner.stop('fake', d); } });
      const r = c.runner.run(d, {}, 'manual');
      await upFile(c);
      const from = events.length;
      const first = await c.runner.stop('fake', d);
      const second = late ? await late : null;
      const ks = kills(from);
      const ok = first && first.ok === true && first.stem === r.stem && second && second.ok === true && second.stem === r.stem && ks.length === 1
        && c.reports.calls.markStopped.length === 1 && exits.length === 1 && exits[0].stopped === true && c.runner.isRunning('fake') === false;
      return { ok, extra: JSON.stringify({ first, second, ks, marks: c.reports.calls.markStopped.length, exits: exits.length }) };
    });
  } finally {
    process.kill = realKill;
    reapFixtures();
  }
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
  for (const c of spawned) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(code);
});
