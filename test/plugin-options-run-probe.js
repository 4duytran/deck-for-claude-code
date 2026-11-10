'use strict';
// plugin-options-run-probe - daily-brief-v2 D10 (R9, contract C5): src/main/plugin-runner.js hands the effective plugin
// OPTIONS to the child as literal `DECK_PLUGIN_OPT_<NAME>=<value>` words of the `exec env -i` template.
// Real launch: a fake plugin is started by runner.run through the real `bash -ic` template (the PLUGINS_SHELL seam
// pointed at /bin/bash, HOME = a throwaway dir whose .bashrc exports ONE fake variable, so no user rc file is read).
// The fake plugin writes what it sees FROM INSIDE the child: every variable NAME, plus the option words themselves
// (non-secret choice values); it never reads or writes any other value.
//   xvfb-run -a node_modules/.bin/electron test/plugin-options-run-probe.js
// PLUGIN_RUNNER_SRC=<dir> points the probe at another copy of src/main (mutation proofs).
//
// Gates: load
//   r1 declared option + {CLAUDE_MODE:'api'} -> the child reads DECK_PLUGIN_OPT_CLAUDE_MODE=api (outer env has no option)
//   r2 no stored value -> the declared default (also an empty / missing options argument)
//   r3 an undeclared option -> no word; an undeclared value -> the default
//   r4 a plugin without options -> no DECK_PLUGIN_OPT_ name in the child
//   r5 a bad option name / default / ANY declared choice value -> {ok:false, reason:'invalid-option'}, no spawn, no report entry
//   r6 no option -> the template is the unchanged legacy one; slots and host names reach the child; no env read
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('node:child_process');
const { app } = require('electron');

const SRC = process.env.PLUGIN_RUNNER_SRC ? path.resolve(process.env.PLUGIN_RUNNER_SRC) : path.join(__dirname, '..', 'src', 'main');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-options-probe-')));
const HOME_TMP = path.join(TMP, 'home');
fs.mkdirSync(HOME_TMP);
// The ONE rc the interactive bash reads: a throwaway one, exporting a FAKE variable so a mapped slot can be proven.
fs.writeFileSync(path.join(HOME_TMP, '.bashrc'), 'export OPTPROBE_FAKE_VAR=fake-optprobe-3f9a1c\n');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (n) => typeof n === 'string' && n.length <= 64 && NAME_RE.test(n);
const BASE = ['PATH'];
const HOST = ['DECK_PLUGIN_ID', 'DECK_PLUGIN_DATA_DIR', 'DECK_PLUGIN_REPORT', 'DECK_PLUGIN_TRIGGER', 'DECK_PLUGIN_DATE'];
const LEGACY = 'exec env -i ${PATH+"PATH=$PATH"} ${OPTPROBE_FAKE_VAR+"SLOT_X=$OPTPROBE_FAKE_VAR"} '
  + HOST.map((h) => h + '="$' + h + '"').join(' ') + ' "$0" "$@" 1>&3 2>&3 3>&-';
const SHELL_NOISE = new Set(['PWD', 'OLDPWD', '_', 'SHLVL']); // set by /bin/sh itself, not by the template
const clock = () => new Date(2026, 10, 2, 9, 0, 0).getTime();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const results = {};
function gate(name, ok, extra) {
  results[name] = !!ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ' :: ' + extra}`);
}

// The shell comes from the PLUGINS_SHELL seam of config.js, exactly as main.js resolves it (cfg.PLUGINS_SHELL first).
process.env.CLAUDE_DECK_PLUGINS_SHELL = '/bin/bash';
const cfg = require(path.join(SRC, 'config.js'));
const SHELL = cfg.PLUGINS_SHELL;
// The runner takes HOME from os.userInfo(), never from process.env: redirect it to the throwaway HOME.
os.userInfo = () => ({ username: 'optprobe', homedir: HOME_TMP, shell: '/bin/bash' });

const realSpawn = cp.spawn;
const spawnCalls = [];
const spawned = [];
cp.spawn = (cmd, args, opts) => {
  const child = realSpawn(cmd, args, opts);
  spawnCalls.push({ cmd, args: [...args], env: { ...opts.env }, pid: child.pid });
  spawned.push(child);
  return child;
};

function fakeReports(root) {
  const calls = { newEntry: [], setPid: [], finishEntry: [] };
  let last = null;
  const dirOf = (id) => path.join(root, id, 'reports');
  return {
    calls,
    newEntry(id, trigger) {
      calls.newEntry.push({ id, trigger });
      fs.mkdirSync(dirOf(id), { recursive: true });
      const stem = '2026-11-02T0900';
      last = { stem, start: clock(), trigger, exit: null, pid: null };
      return { stem, reportPath: path.join(dirOf(id), `${stem}.html`), logPath: path.join(dirOf(id), `${stem}.log`) };
    },
    setPid(id, stem, pid) { calls.setPid.push({ id, stem, pid }); if (last) last.pid = pid; },
    finishEntry(id, stem, r) { calls.finishEntry.push({ id, stem, exit: r.exit }); if (last) last.exit = r.exit; },
    latest() { return last; },
  };
}

const MODE = {
  name: 'CLAUDE_MODE', label: 'Mode', default: 'subscription',
  choices: [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }],
};
let caseN = 0;
// Launch the fake plugin through runner.run; resolves with what the child saw, or the refusal.
async function launch({ options, env = [], envMap = {}, given, hasGiven = true, extra = {} }) {
  const n = ++caseN;
  const dir = path.join(TMP, `plug-${n}`);
  const out = path.join(TMP, `out-${n}`);
  fs.mkdirSync(dir);
  fs.mkdirSync(out);
  const script = path.join(dir, 'run.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `OUT='${out}'`,
    '/usr/bin/env | while IFS= read -r l; do',
    '  n=${l%%=*}',
    '  printf \'%s\\n\' "$n" >> "$OUT/names"',
    '  case $n in DECK_PLUGIN_OPT_*) printf \'%s\\n\' "$l" >> "$OUT/opts";; esac',
    'done',
    ': > "$OUT/done"',
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  const reports = fakeReports(path.join(TMP, `data-${n}`));
  const exits = [];
  const { create } = require(path.join(SRC, 'plugin-runner.js'));
  const runner = create({ reports, onExit: (id, info) => exits.push({ id, ...info }), nowFn: clock, shellPath: SHELL, baseNames: BASE, validName });
  const plugin = { id: `opt${n}`, dir, argv: ['run.sh'], env, ...(options === undefined ? {} : { options }), ...extra };
  const before = spawnCalls.length;
  const r = hasGiven ? runner.run(plugin, envMap, 'manual', given) : runner.run(plugin, envMap, 'manual');
  const res = { r, reports, spawns: spawnCalls.length - before, call: spawnCalls[spawnCalls.length - 1], names: [], opts: [] };
  if (r.ok) {
    await until(() => exits.length >= 1, 10000, 'plugin exit');
    const rd = (f) => { try { return fs.readFileSync(path.join(out, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    res.names = rd('names');
    res.opts = rd('opts');
    res.done = fs.existsSync(path.join(out, 'done'));
    res.exit = exits[0].exit;
  }
  return res;
}
const optNames = (res) => res.names.filter((x) => x.startsWith('DECK_PLUGIN_OPT_'));
const refused = (res) => res.r && res.r.ok === false && res.r.reason === 'invalid-option' && res.spawns === 0
  && res.reports.calls.newEntry.length === 0;

async function main() {
  let loaded = false;
  try { require(path.join(SRC, 'plugin-runner.js')); loaded = true; } catch (e) { console.log(`FAIL load :: ${e.message}`); }
  gate('load', loaded && SHELL === '/bin/bash');
  if (!loaded) return false;

  // r1 - the value is read from INSIDE the child; the outer spawn env object never carries it.
  const r1 = await launch({ options: [MODE], given: { CLAUDE_MODE: 'api' } });
  gate('r1_child_reads_option', r1.r.ok === true && r1.done && r1.exit === 0
    && JSON.stringify(r1.opts) === JSON.stringify(['DECK_PLUGIN_OPT_CLAUDE_MODE=api']), JSON.stringify({ r: r1.r, opts: r1.opts, exit: r1.exit }));
  gate('r1_outer_env_has_no_option', !!r1.call && !Object.keys(r1.call.env).some((k) => k.startsWith('DECK_PLUGIN_OPT_')));
  gate('r1_literal_word_after_host_names', !!r1.call && r1.call.args[1] === LEGACY.replace(' "$0"', ' DECK_PLUGIN_OPT_CLAUDE_MODE=api "$0"').replace('${OPTPROBE_FAKE_VAR+"SLOT_X=$OPTPROBE_FAKE_VAR"} ', ''),
    r1.call && r1.call.args[1]);

  // r2 - nothing stored: the declared default (a missing, empty or non-object options argument all mean "nothing stored").
  const r2 = await launch({ options: [MODE], given: {} });
  const r2b = await launch({ options: [MODE], hasGiven: false });
  const r2c = await launch({ options: [MODE], given: null });
  const one = (res, v) => res.r.ok === true && JSON.stringify(res.opts) === JSON.stringify([`DECK_PLUGIN_OPT_CLAUDE_MODE=${v}`]);
  gate('r2_default_when_unset', one(r2, 'subscription') && one(r2b, 'subscription') && one(r2c, 'subscription'),
    JSON.stringify([r2.opts, r2b.opts, r2c.opts]));

  // r3 - an undeclared option name gets no word; an undeclared value falls back to the default.
  const r3a = await launch({ options: [MODE], given: { CLAUDE_MODE: 'api', OTHER_OPT: 'x' } });
  gate('r3_undeclared_option_no_word', one(r3a, 'api') && !r3a.names.includes('DECK_PLUGIN_OPT_OTHER_OPT'), JSON.stringify(r3a.opts));
  const r3b = await launch({ options: [MODE], given: { CLAUDE_MODE: 'bogus' } });
  const r3c = await launch({ options: [MODE], given: { CLAUDE_MODE: 7 } });
  gate('r3_undeclared_value_default', one(r3b, 'subscription') && one(r3c, 'subscription'), JSON.stringify([r3b.opts, r3c.opts]));
  const r3d = await launch({ options: [MODE, { ...MODE, name: 'EXTRA', default: 'api' }], given: { CLAUDE_MODE: 'api' } });
  gate('r3_two_declared_options', r3d.r.ok === true && JSON.stringify(r3d.opts.sort()) === JSON.stringify(['DECK_PLUGIN_OPT_CLAUDE_MODE=api', 'DECK_PLUGIN_OPT_EXTRA=api']), JSON.stringify(r3d.opts));

  // r4 - a plugin without options: no option name in the child, whatever the 4th argument holds.
  const r4 = await launch({ given: { CLAUDE_MODE: 'api' } });
  const r4b = await launch({ options: [], given: { CLAUDE_MODE: 'api' } });
  gate('r4_no_options_no_name', r4.r.ok === true && r4b.r.ok === true && r4.done && optNames(r4).length === 0 && optNames(r4b).length === 0,
    JSON.stringify([r4.names, r4b.names]));

  // r5 - a hand-built descriptor with a bad option shape is refused before any spawn or report entry.
  const bad = (opt, given) => launch({ options: [opt], given });
  const r5 = {
    name_lower: await bad({ ...MODE, name: 'opt' }, {}),
    name_long: await bad({ ...MODE, name: 'A'.repeat(33) }, {}),
    name_shell: await bad({ ...MODE, name: 'A$(id)' }, {}),
    default_space: await bad({ ...MODE, default: 'a b', choices: [{ value: 'a b' }] }, {}),
    given_subst: await bad({ ...MODE, choices: [{ value: 'subscription' }, { value: '$(id)' }] }, { CLAUDE_MODE: '$(id)' }),
    value_long: await bad({ ...MODE, default: 'a'.repeat(33) }, {}),
    // a malformed choice is refused even when the default and the pick are fine (nothing picks it, the declaration is still broken)
    choice_space_unpicked: await bad({ ...MODE, choices: [{ value: 'subscription' }, { value: 'a b' }], default: 'subscription' }, {}),
    choice_subst_unpicked: await bad({ ...MODE, choices: [{ value: 'subscription' }, { value: '$(id)' }], default: 'subscription' }, { CLAUDE_MODE: 'subscription' }),
    choice_nonstring: await bad({ ...MODE, choices: [{ value: 'subscription' }, { value: 7 }], default: 'subscription' }, {}),
    choice_null: await bad({ ...MODE, choices: [{ value: 'subscription' }, null], default: 'subscription' }, {}),
    entry_null: await launch({ options: [null], given: {} }),
    entry_noscalar: await launch({ options: ['CLAUDE_MODE'], given: {} }),
    not_array: await launch({ options: 'CLAUDE_MODE', given: {} }),
    duplicate: await launch({ options: [MODE, MODE], given: {} }),
  };
  const badNames = Object.keys(r5).filter((k) => !refused(r5[k]));
  gate('r5_invalid_option_refused_no_spawn', badNames.length === 0, `not refused: ${badNames.join(',')} ${JSON.stringify(badNames.map((k) => r5[k].r))}`);

  // r6 - nothing declared: the legacy template, byte for byte; mapped slots and host names reach the child.
  const r6 = await launch({ env: [{ name: 'SLOT_X' }], envMap: { SLOT_X: 'OPTPROBE_FAKE_VAR' }, given: {} });
  gate('r6_template_unchanged_without_option', r6.r.ok === true && !!r6.call && r6.call.args[1] === LEGACY, r6.call && r6.call.args[1]);
  const expected = ['PATH', 'SLOT_X', ...HOST];
  const unexpected = r6.names.filter((x) => !expected.includes(x) && !SHELL_NOISE.has(x));
  gate('r6_slots_and_host_names_reach_child', expected.every((x) => r6.names.includes(x)) && unexpected.length === 0, JSON.stringify({ names: r6.names, unexpected }));
  const withOpt = await launch({ options: [MODE], env: [{ name: 'SLOT_X' }], envMap: { SLOT_X: 'OPTPROBE_FAKE_VAR' }, given: { CLAUDE_MODE: 'api' } });
  gate('r6_slots_unchanged_with_option', withOpt.r.ok === true && [...expected, 'DECK_PLUGIN_OPT_CLAUDE_MODE'].every((x) => withOpt.names.includes(x))
    && withOpt.names.filter((x) => !expected.includes(x) && !SHELL_NOISE.has(x)).join() === 'DECK_PLUGIN_OPT_CLAUDE_MODE', JSON.stringify(withOpt.names));
  const src = fs.readFileSync(path.join(SRC, 'plugin-runner.js'), 'utf8');
  gate('r6_no_env_read', !/process\.env/.test(src) && !/process\.env/.test(JSON.stringify(spawnCalls.map((c) => c.args))));
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
