'use strict';
// plugin-options-manifest-probe — daily-brief-v2 step D8 (R9.1): the optional top-level `options` kind of
// deck-plugin.json, validated by src/main/plugin-manifest.js (a LEAF: fs + path only). Hermetic: every plugin folder
// is built at run time in a mkdtemp dir, no app boot, no network, no child process.
//   xvfb-run -a node_modules/.bin/electron test/plugin-options-manifest-probe.js
// PLUGIN_MANIFEST_SRC=<file> points the probe at another copy of the module (mutation proofs); default: this tree.
//
// Gates: m1 absent / empty `options` -> manifest.options = [] and every existing manifest stays valid; m2 the
// daily-brief block (plan § 2.6) accepted and returned, with the upper bounds; m3 refused with
// « Manifeste invalide : options » (name, duplicates, slot clash, choices count, value shape, default, count,
// non-array, labels, entry shapes); m4 scan skips a folder with bad options with one warn; m5 the module stays a leaf.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const SRC = process.env.PLUGIN_MANIFEST_SRC ? path.resolve(process.env.PLUGIN_MANIFEST_SRC) : path.join(__dirname, '..', 'src', 'main', 'plugin-manifest.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-options-probe-'));
const BASE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const E_OPTIONS = 'Manifeste invalide : options';

const results = {};
const gate = (name, fn) => {
  try { results[name] = !!fn(); } catch (e) { results[name] = false; console.log(`  ${name} threw: ${e.message}`); }
};
function finish() {
  const names = Object.keys(results);
  const ok = names.filter((n) => results[n]).length;
  for (const n of names) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}`);
  const green = names.length > 0 && ok === names.length;
  console.log(green ? `VERDICT: ALL GREEN (${ok}/${names.length})` : `VERDICT: RED (${ok}/${names.length})`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(green ? 0 : 1);
}

let M;
try { M = require(SRC); } catch (e) { results.load = false; console.log(`  load failed: ${e.message}`); finish(); }
if (M) run();

function run() {
  let seq = 0;
  const DAILY_ENV = [
    { name: 'JIRA_TOKEN', label: 'Jeton Jira', required: true, hints: ['JIRA', 'TOKEN'] },
    { name: 'CLAUDE_KEY', label: 'Clé API Claude (mode API)', required: false, hints: ['CLAUDE', 'KEY'] },
  ];
  // The block shipped by deck-plugins P2b (plan step P2b, Action).
  const DAILY_OPTIONS = [{
    name: 'CLAUDE_MODE', label: 'Appels Claude',
    choices: [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }], default: 'subscription',
  }];
  const good = (over = {}) => ({ id: 'daily-brief', label: 'Brief du jour', description: 'Rapport quotidien.', argv: ['run.sh'], trigger: 'daily', env: DAILY_ENV, ...over });
  const choice = (value, label = 'Choix') => ({ value, label });
  const opt = (over = {}) => ({ name: 'MODE', label: 'Mode', choices: [choice('a1'), choice('b2')], default: 'a1', ...over });
  function plugin(manifest, { parent = TMP, name } = {}) {
    const dir = path.join(parent, name || `p${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify(manifest));
    return dir;
  }
  const check = (m) => M.validateManifest(plugin(m), { baseNames: BASE });
  const refused = (options, over = {}) => { const r = check(good({ options, ...over })); return r.ok === false && r.error === E_OPTIONS; };
  const accepted = (options, over = {}) => check(good({ options, ...over })).ok === true;
  const all = (list, fn) => list.every(fn);
  const x = (n, ch = 'A') => ch.repeat(n);

  gate('m1_absent_options_is_empty_array', () => {
    const a = check(good());
    const noEnv = check(good({ env: undefined }));
    const explicit = check(good({ options: [] }));
    return a.ok === true && Array.isArray(a.manifest.options) && a.manifest.options.length === 0
      && a.manifest.env.length === 2 && a.manifest.argv[0] === 'run.sh' && a.manifest.trigger === 'daily'
      && noEnv.ok === true && noEnv.manifest.options.length === 0 && noEnv.manifest.env.length === 0
      && explicit.ok === true && explicit.manifest.options.length === 0;
  });

  gate('m2_daily_brief_block_accepted_and_returned', () => {
    const r = check(good({ options: DAILY_OPTIONS }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.manifest.options, DAILY_OPTIONS);
    assert.deepStrictEqual(r.manifest.env.map((s) => s.name), ['JIRA_TOKEN', 'CLAUDE_KEY']);
    const noEnv = check(good({ env: undefined, options: DAILY_OPTIONS }));
    assert.strictEqual(noEnv.ok, true);
    assert.deepStrictEqual(noEnv.manifest.options, DAILY_OPTIONS);
    return true;
  });

  gate('m2b_upper_bounds_accepted', () => {
    const eight = Array.from({ length: 8 }, (_, i) => opt({ name: `OPT${i}` }));
    const six = [opt({ choices: ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => choice(v)), default: 'f' })];
    const long = [opt({ name: `A${x(31, 'B')}`, choices: [choice(`a${x(31, 'b')}`), choice('z')], default: `a${x(31, 'b')}` })];
    const digits = [opt({ name: 'A_1_9', choices: [choice('a-1'), choice('z9-')], default: 'z9-' })];
    const label = [opt({ label: x(60), choices: [choice('a', x(60)), choice('b', 'é'.repeat(60))], default: 'a' })];
    return all([eight, six, long, digits, label], (o) => accepted(o)) && check(good({ options: eight })).manifest.options.length === 8;
  });

  gate('m3a_bad_name_refused', () => {
    const names = ['claude_mode', 'Mode', '1MODE', '_MODE', '', x(33), 'A-B', 'A B', 'MODE\n', 'X;touch', 'MODÉ'];
    return all(names, (name) => refused([opt({ name })])) && refused([opt({ name: 42 })]) && refused([opt({ name: null })])
      && refused([{ label: 'Mode', choices: [choice('a1'), choice('b2')], default: 'a1' }]);
  });

  gate('m3b_duplicate_name_refused', () => refused([opt(), opt()]) && refused([opt({ name: 'ONE' }), opt({ name: 'TWO' }), opt({ name: 'ONE' })])
    && accepted([opt({ name: 'ONE' }), opt({ name: 'TWO' })]));

  gate('m3c_name_equal_to_a_slot_refused', () => refused([opt({ name: 'CLAUDE_KEY' })]) && refused([opt({ name: 'JIRA_TOKEN' })])
    && accepted([opt({ name: 'CLAUDE_MODE' })])
    && check(good({ env: [{ name: 'MODE', label: 'Mode', required: true, hints: ['MODE'] }], options: [opt()] })).error === E_OPTIONS);

  gate('m3d_choices_count_refused', () => {
    const n = (k) => Array.from({ length: k }, (_, i) => choice(`v${i}`));
    return refused([opt({ choices: [], default: 'a1' })]) && refused([opt({ choices: n(1), default: 'v0' })])
      && refused([opt({ choices: n(7), default: 'v0' })]) && accepted([opt({ choices: n(2), default: 'v1' })])
      && all([undefined, null, 'ab', { 0: choice('a1'), 1: choice('b2'), length: 2 }], (choices) => refused([opt({ choices })]));
  });

  gate('m3e_bad_value_refused', () => {
    const bad = ['API', 'Api', '1a', '-a', '_a', 'a_b', 'a b', '', x(33, 'a'), 'a\n', 'é'];
    return all(bad, (v) => refused([opt({ choices: [choice(v), choice('b2')], default: 'b2' })]))
      && refused([opt({ choices: [choice(7), choice('b2')], default: 'b2' })])
      && refused([opt({ choices: [{ label: 'Sans valeur' }, choice('b2')], default: 'b2' })]);
  });

  gate('m3f_duplicate_value_refused', () => refused([opt({ choices: [choice('a1'), choice('a1')] })])
    && refused([opt({ choices: [choice('a1'), choice('b2'), choice('c3'), choice('b2')] })])
    && accepted([opt({ choices: [choice('a1'), choice('b2')] })])
    && accepted([opt({ name: 'ONE' }), opt({ name: 'TWO' })])); // the same values may repeat across two options

  gate('m3g_default_must_be_a_declared_value', () => refused([opt({ default: 'c3' })]) && refused([opt({ default: 'A1' })])
    && refused([opt({ default: '' })]) && refused([opt({ default: 1 })]) && refused([opt({ default: null })])
    && refused([opt({ default: undefined })]) && refused([opt({ default: ['a1'] })]));

  gate('m3h_more_than_eight_options_refused', () => {
    const nine = Array.from({ length: 9 }, (_, i) => opt({ name: `OPT${i}` }));
    return refused(nine) && refused(Array.from({ length: 40 }, (_, i) => opt({ name: `OPT${i}` })));
  });

  gate('m3i_non_array_refused', () => all([{}, opt(), 'MODE', 7, true, false, null], (o) => refused(o)));

  gate('m3j_labels_and_entry_shapes_refused', () => {
    const lab = (label) => [opt({ label })];
    const clab = (label) => [opt({ choices: [{ value: 'a1', label }, choice('b2')] })]; // not choice(): its default label would replace undefined
    const bad = [undefined, null, 5, '', '   ', x(61)];
    return all(bad, (l) => refused(lab(l)) && refused(clab(l)))
      && all(['MODE', 7, null, [], true], (entry) => refused([entry]))
      && all(['a1', 7, null, []], (c) => refused([opt({ choices: [c, choice('b2')] })]));
  });

  gate('m3k_options_error_does_not_leak_the_value', () => {
    const r = check(good({ options: [opt({ name: 'bad;touch /tmp/x' })] }));
    return r.ok === false && r.error === E_OPTIONS && !r.error.includes('touch');
  });

  gate('m4_scan_skips_bad_options_with_one_warn', () => {
    const parent = path.join(TMP, 'scan');
    fs.mkdirSync(parent);
    plugin(good({ id: 'goodone', options: DAILY_OPTIONS }), { parent, name: 'goodone' });
    plugin(good({ id: 'badone', options: [opt({ default: 'nope' })] }), { parent, name: 'badone' });
    plugin(good({ id: 'plain' }), { parent, name: 'plain' });
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let found;
    try { found = M.scan(parent, { baseNames: BASE }); } finally { console.warn = orig; }
    const byId = Object.fromEntries(found.map((p) => [p.id, p]));
    return found.map((p) => p.id).join(',') === 'goodone,plain'
      && JSON.stringify(byId.goodone.manifest.options) === JSON.stringify(DAILY_OPTIONS) && byId.plain.manifest.options.length === 0
      && warns.length === 1 && warns[0].startsWith('[plugins] badone: ') && warns[0].includes(E_OPTIONS);
  });

  gate('m5_module_is_a_leaf', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    return reqs.length > 0 && reqs.every((r) => ['fs', 'path', 'node:fs', 'node:path'].includes(r)) && !/child_process|\bexec(Sync)?\(|spawn/.test(src);
  });
  finish();
}
