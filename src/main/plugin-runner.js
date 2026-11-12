// claude-deck - main/plugin-runner: launch ONE plugin through the user's own shell (daily-brief AMD-3).
// The Deck never reads a secret: it spawns `$SHELL -ic TEMPLATE argv0 args...` with a constant OUTER env, and
// TEMPLATE holds variable NAMES plus the literal `DECK_PLUGIN_OPT_<NAME>=<value>` words of the declared options
// (pattern-checked, never a secret). The user's shell expands the values inside `exec env -i ...`, so they
// reach the plugin and nothing else. A leaf: requires node built-ins only; collaborators come in as arguments.
'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUTER_PATH = process.platform === 'darwin' ? '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin' : '/usr/local/bin:/usr/bin:/bin';
const HOST_NAMES = ['DECK_PLUGIN_ID', 'DECK_PLUGIN_DATA_DIR', 'DECK_PLUGIN_REPORT', 'DECK_PLUGIN_TRIGGER', 'DECK_PLUGIN_DATE'];
const TRIGGERS = ['auto', 'manual'];
// Shells that cannot run the POSIX template; they fall back to bash. Anything else is run as given.
const NON_POSIX = new Set(['fish', 'csh', 'tcsh', 'nu', 'elvish', 'xonsh', 'pwsh', 'powershell']);
const FALLBACK_SHELL = '/bin/bash';
const FALLBACK_NOTE = 'shell non pris en charge, lecture via bash';
// fd 3 is the log: the shell's own fds 1/2 are ignored, so rc output never reaches it; only the plugin's does.
const TEMPLATE_TAIL = '"$0" "$@" 1>&3 2>&3 3>&-';

function dayOf(ms) { // local calendar day, YYYY-MM-DD
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Option name and value shapes (the manifest's own): neither needs shell quoting, so a word is built only after both match.
const OPT_NAME_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const OPT_VALUE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OPT_PREFIX = 'DECK_PLUGIN_OPT_';

// One literal `DECK_PLUGIN_OPT_<NAME>=<value>` word per declared option: the given value when it is one of the declared
// choices, else the declared default. -> {words} or {bad: true} (malformed or duplicated declaration, bad name, default or
// choice value: every declared choice is checked, not only the one in use).
function optionWords(declared, given) {
  if (declared === undefined || declared === null) return { words: [] };
  if (!Array.isArray(declared)) return { bad: true };
  const stored = given && typeof given === 'object' ? given : {};
  const seen = new Set();
  const words = [];
  for (const opt of declared) {
    if (!opt || typeof opt !== 'object' || typeof opt.name !== 'string' || !OPT_NAME_RE.test(opt.name) || seen.has(opt.name)
      || !Array.isArray(opt.choices)
      || !opt.choices.every((c) => c && typeof c.value === 'string' && OPT_VALUE_RE.test(c.value))) return { bad: true };
    seen.add(opt.name);
    const pick = Object.prototype.hasOwnProperty.call(stored, opt.name) ? stored[opt.name] : undefined;
    const value = typeof pick === 'string' && opt.choices.some((c) => c && c.value === pick) ? pick : opt.default;
    if (typeof value !== 'string' || !OPT_VALUE_RE.test(value)) return { bad: true };
    words.push(OPT_PREFIX + opt.name + '=' + value);
  }
  return { words };
}

// `${U+"S=$U"}` passes S only when U is set; nothing but NAMES is written into the string.
function buildTemplate(baseNames, pairs, validName, declaredOptions, givenOptions) {
  const words = [];
  for (const b of baseNames) {
    if (!validName(b)) return { bad: b };
    words.push('${' + b + '+"' + b + '=$' + b + '"}');
  }
  for (const [slot, user] of pairs) {
    if (!validName(slot)) return { bad: slot };
    if (!validName(user)) return { bad: user };
    words.push('${' + user + '+"' + slot + '=$' + user + '"}');
  }
  for (const h of HOST_NAMES) words.push(h + '="$' + h + '"');
  const opts = optionWords(declaredOptions, givenOptions);
  if (opts.bad) return { badOption: true };
  words.push(...opts.words);
  return { template: 'exec env -i ' + words.join(' ') + ' ' + TEMPLATE_TAIL };
}

function pickShell(shellPath) {
  if (typeof shellPath !== 'string' || !shellPath || NON_POSIX.has(path.basename(shellPath))) {
    return { file: FALLBACK_SHELL, fallback: true };
  }
  return { file: shellPath, fallback: false };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The two matchers behind pidHolds, exported for the probes. Linux reads the exact argv words of /proc/<pid>/cmdline.
// macOS has no /proc: `ps` prints one command line, so argv0 must sit in it between a space (or the line start) and a
// space (or the line end), which keeps a path holding spaces one unit. Any error means no match.
function procHolds(pid, argv0Abs) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').includes(argv0Abs); } catch { return false; }
}
function psHolds(pid, argv0Abs) {
  try {
    const line = cp.execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`(^| )${escapeRe(argv0Abs)}( |$)`).test(line.replace(/\n+$/, ''));
  } catch { return false; }
}

// pid-reuse guard: alive AND its command line holds the plugin's absolute argv0 (the pid survives the exec chain).
function pidHolds(pid, argv0Abs) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return process.platform === 'darwin' ? psHolds(pid, argv0Abs) : procHolds(pid, argv0Abs);
}

// The realpath the manifest validated when the descriptor carries it (a symlink retargeted since the scan is not
// followed); the lexical form only for a descriptor without one.
const argv0AbsOf = (plugin) => (typeof plugin.argv0Abs === 'string' && path.isAbsolute(plugin.argv0Abs)
  ? plugin.argv0Abs : path.resolve(plugin.dir, plugin.argv[0]));

const STOP_GRACE_MS = 5000; // TERM -> KILL: a UX bound, only a plugin that traps TERM ever waits it out
const STOP_POLL_MS = 100;
const STOP_KILL_WAIT_MS = 2000; // after SIGKILL, longer than this = « still-alive »
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function create({ reports, onExit, nowFn = Date.now, shellPath, baseNames = [], validName, stopGraceMs = STOP_GRACE_MS }) {
  if (!reports || typeof validName !== 'function') throw new TypeError('plugin-runner: reports and validName are required');
  const graceMs = Number.isFinite(stopGraceMs) && stopGraceMs >= 0 ? stopGraceMs : STOP_GRACE_MS;
  const inflight = new Map(); // id -> {stem, pid, argv0Abs, stopped}
  const stopping = new Map(); // id -> the stop in progress
  const argv0Of = new Map(); // id -> argv0Abs of the last run in this process

  const argv0For = (id, plugin) => (plugin && typeof plugin.dir === 'string' && Array.isArray(plugin.argv) && typeof plugin.argv[0] === 'string'
    ? argv0AbsOf(plugin) : argv0Of.get(id));

  // The entry a previous Deck instance left running: exit null, a live pid, our argv0 in its cmdline.
  function survivor(id, plugin) {
    const argv0Abs = argv0For(id, plugin);
    if (!argv0Abs) return null;
    let e;
    try { e = reports.latest(id); } catch { return null; }
    if (!e || e.exit != null || !Number.isInteger(e.pid) || e.pid <= 0) return null;
    return pidHolds(e.pid, argv0Abs) ? e : null;
  }

  const isRunning = (id, plugin) => inflight.has(id) || survivor(id, plugin) !== null;
  function runningStem(id, plugin) {
    const f = inflight.get(id);
    if (f) return f.stem;
    const e = survivor(id, plugin);
    return e ? e.stem : null;
  }

  // `options` = the effective options (name -> value) of the plugin; the declared ones come from plugin.options.
  // -> {ok: true, stem, note?} once launched (the outcome arrives through onExit), else {ok: false, reason}.
  function run(plugin, envMap, trigger, options) {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.dir !== 'string' || !Array.isArray(plugin.argv)
      || typeof plugin.argv[0] !== 'string' || !TRIGGERS.includes(trigger)) return { ok: false, reason: 'bad-input' };
    // "$0" of the template: with `=` in it GNU env reads an assignment, never runs the plugin and prints its env into the log.
    const argv0Abs = argv0AbsOf(plugin);
    if (argv0Abs.includes('=')) return { ok: false, reason: 'invalid-argv0' };
    const id = plugin.id;
    if (isRunning(id, plugin)) return { ok: false, reason: 'running' };

    // Slots the manifest no longer declares are dropped; every name that remains is checked before any spawn.
    const declared = Array.isArray(plugin.env) ? new Set(plugin.env.map((e) => e && e.name)) : null;
    const pairs = Object.entries(envMap && typeof envMap === 'object' ? envMap : {}).filter(([slot]) => !declared || declared.has(slot));
    const built = buildTemplate(baseNames, pairs, validName, plugin.options, options);
    if (built.badOption) return { ok: false, reason: 'invalid-option' };
    if (built.template === undefined) return { ok: false, reason: 'invalid-name', name: String(built.bad).slice(0, 64) };

    let entry;
    try { entry = reports.newEntry(id, trigger); } catch (e) { return { ok: false, reason: 'entry-failed', error: e.code || e.name }; }
    const { stem } = entry;
    const flight = { stem, pid: null, argv0Abs, stopped: false };
    let settled = false;
    const settle = ({ exit = null, signal = null, error = null }) => {
      if (settled) return;
      settled = true;
      inflight.delete(id);
      try { reports.finishEntry(id, stem, { exit, signal }); } catch (e) { console.warn(`[plugin-runner] finishEntry failed (${e.code || e.name})`); }
      if (typeof onExit !== 'function') return;
      try { onExit(id, { stem, trigger, exit, signal, error, stopped: flight.stopped }); } catch (e) { console.warn(`[plugin-runner] onExit threw (${e.name})`); }
    };

    const shell = pickShell(shellPath);
    inflight.set(id, flight);
    argv0Of.set(id, argv0Abs);
    let logFd = -1;
    // Everything after inflight.set sits in this try: a throw ends the run through settle, never leaves it « running ».
    try {
      let ui = {};
      try { ui = os.userInfo(); } catch { /* no passwd entry: USER stays empty, SHELL falls back; never an env read */ }
      const user = ui.username || '';
      const env = {
        HOME: ui.homedir || '', USER: user, LOGNAME: user, SHELL: ui.shell || FALLBACK_SHELL, PATH: OUTER_PATH,
        DECK_PLUGIN_ID: id, DECK_PLUGIN_DATA_DIR: path.dirname(path.dirname(entry.reportPath)), DECK_PLUGIN_REPORT: entry.reportPath,
        DECK_PLUGIN_TRIGGER: trigger, DECK_PLUGIN_DATE: dayOf(new Date(nowFn()).getTime()),
      };
      logFd = fs.openSync(entry.logPath, 'a', 0o600);
      const child = cp.spawn(shell.file, ['-ic', built.template, argv0Abs, ...plugin.argv.slice(1)], {
        env, cwd: plugin.dir, detached: true, stdio: ['ignore', 'ignore', 'ignore', logFd],
      });
      child.on('error', (e) => settle({ error: e.code || e.name }));
      child.on('exit', (code, signal) => settle({ exit: code, signal }));
      if (Number.isInteger(child.pid)) {
        flight.pid = child.pid;
        try { reports.setPid(id, stem, child.pid); } catch (e) { console.warn(`[plugin-runner] setPid failed (${e.code || e.name})`); }
      }
      child.unref();
    } catch (e) {
      process.nextTick(settle, { error: e.code || e.name });
    } finally {
      if (logFd >= 0) { try { fs.closeSync(logFd); } catch { /* already closed */ } }
    }
    return shell.fallback ? { ok: true, stem, note: FALLBACK_NOTE } : { ok: true, stem };
  }

  // The target is this instance's in-flight child, else a survivor; its pid must pass pidHolds before EVERY signal,
  // so a recycled pid is never signalled. The stopped mark is written before the first signal. The signal goes to the
  // process group (the child leads one: spawn is detached); ESRCH = already gone.
  // A stop in progress is shared only by a request for the same run; a run started since gets its own stop.
  // -> {ok: true, stem} | {ok: false, reason: 'not-running' | 'still-alive'}
  function stop(id, plugin) {
    const flight = inflight.get(id) || null;
    const live = flight || survivor(id, plugin);
    const cur = stopping.get(id);
    if (cur && (!live || (flight ? cur.flight === flight : cur.pid === live.pid))) return cur.promise;
    const entry = { flight, pid: live ? live.pid : null, promise: null };
    entry.promise = doStop(id, plugin).finally(() => { if (stopping.get(id) === entry) stopping.delete(id); });
    stopping.set(id, entry);
    return entry.promise;
  }

  async function doStop(id, plugin) {
    const flight = inflight.get(id) || null;
    let target = flight;
    if (!flight) {
      const e = survivor(id, plugin);
      target = e ? { stem: e.stem, pid: e.pid, argv0Abs: argv0For(id, plugin) } : null;
    }
    if (!target || !Number.isInteger(target.pid) || target.pid <= 0 || !pidHolds(target.pid, target.argv0Abs)) return { ok: false, reason: 'not-running' };
    const { stem, pid, argv0Abs } = target;

    try { reports.markStopped(id, stem); } catch (e) { console.warn(`[plugin-runner] markStopped failed (${e.code || e.name})`); }
    if (flight) flight.stopped = true;

    // true = signalled or already gone; false = the signal was refused (not ours to send)
    const signalGroup = (sig) => {
      if (!pidHolds(pid, argv0Abs)) return true;
      try { process.kill(-pid, sig); return true; } catch (e) { return e.code === 'ESRCH'; }
    };
    const isGone = () => !pidHolds(pid, argv0Abs) && (!flight || inflight.get(id) !== flight);
    const waitGone = async (ms) => {
      const end = Date.now() + ms;
      for (;;) {
        if (isGone()) return true;
        const left = end - Date.now();
        if (left <= 0) return false;
        await sleep(Math.min(STOP_POLL_MS, left));
      }
    };

    if (!signalGroup('SIGTERM')) return { ok: false, reason: 'still-alive' };
    if (await waitGone(graceMs)) return { ok: true, stem };
    if (!signalGroup('SIGKILL')) return { ok: false, reason: 'still-alive' };
    return (await waitGone(STOP_KILL_WAIT_MS)) ? { ok: true, stem } : { ok: false, reason: 'still-alive' };
  }

  return { run, isRunning, runningStem, stop };
}

module.exports = { create, procHolds, psHolds };
