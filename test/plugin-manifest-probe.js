'use strict';
// plugin-manifest-probe — daily-brief plan S1m (D19 manifest `env` slots, D22 injection names):
// src/main/plugin-manifest.js is a LEAF (fs + path only). Hermetic: every plugin folder is built at run time in a
// mkdtemp dir, nothing under the user's real plugins dir, no app boot, no network, no child process.
//   xvfb-run -a node_modules/.bin/electron test/plugin-manifest-probe.js
// PLUGIN_MANIFEST_SRC=<file> points the probe at another copy of the module (mutation proofs); default: this tree.
//
// Gates: valid daily-brief-like manifest accepted; refused slot names (prefixes, BASE, injection, duplicate), hints,
// slot shape, top-level fields, argv escape (.., absolute, symlink, not executable); scan skips (dot, symlink, file,
// invalid, id != folder name) with one warn per invalid folder; the module is a leaf; the injection canary file stays absent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const SRC = process.env.PLUGIN_MANIFEST_SRC ? path.resolve(process.env.PLUGIN_MANIFEST_SRC) : path.join(__dirname, '..', 'src', 'main', 'plugin-manifest.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-manifest-probe-'));
const RAND = Math.random().toString(36).slice(2, 10);
const CANARY = `/tmp/p-${RAND}`; // `X;touch <CANARY>` must never run
const BASE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const E_ABSENT = 'Manifeste absent (deck-plugin.json)';
const E_OUTSIDE = 'La commande doit rester dans le dossier du plugin';
const INVALID = (f) => `Manifeste invalide : ${f}`;

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
  const DAILY = [
    { name: 'JIRA_URL', label: 'Adresse Jira', required: true, hints: ['JIRA', 'URL'] },
    { name: 'JIRA_EMAIL', label: 'Identifiant Jira (e-mail)', required: true, hints: ['JIRA', 'USER'] },
    { name: 'JIRA_TOKEN', label: 'Jeton Jira', required: true, hints: ['JIRA', 'TOKEN'] },
    { name: 'SLACK_TOKEN', label: 'Jeton Slack (utilisateur)', required: true, hints: ['SLACK', 'USER', 'TOKEN'] },
    { name: 'CLAUDE_KEY', label: 'Clé API Claude (lot test)', required: true, hints: ['CLAUDE', 'KEY'] },
    { name: 'AIKIDO_KEY', label: 'Clé Aikido', required: false, hints: ['AIKIDO', 'KEY'] },
  ];
  const good = (over = {}) => ({ id: 'daily-brief', label: 'Brief du jour', description: 'Rapport quotidien Jira, Slack et sécurité.', argv: ['run.sh'], trigger: 'daily', env: DAILY, ...over });
  const slot = (name, over = {}) => ({ name, label: 'Jeton', required: true, hints: ['TOKEN'], ...over });
  function plugin(manifest, { parent = TMP, name, exec = true } = {}) {
    const dir = path.join(parent, name || `p${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: exec ? 0o755 : 0o644 });
    fs.writeFileSync(path.join(dir, 'deck-plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    return dir;
  }
  const check = (m, opts = {}) => M.validateManifest(plugin(m, opts), { baseNames: BASE });
  const refused = (m, msg) => { const r = check(m); return r.ok === false && r.error === msg; };
  const refusedStarts = (m, prefix) => { const r = check(m); return r.ok === false && r.error.startsWith(prefix); };

  gate('g1_valid_manifest_accepted', () => {
    const dir = plugin(good(), { name: 'g1' });
    const r = M.validateManifest(dir, { baseNames: BASE });
    return r.ok === true && r.id === 'daily-brief' && r.manifest.env.length === 6
      && r.manifest.env[2].hints.join(',') === 'JIRA,TOKEN' && r.manifest.env[5].required === false
      && r.manifest.trigger === 'daily' && r.dirReal === fs.realpathSync(dir)
      && path.isAbsolute(r.argv0Abs) && r.argv0Abs === path.join(r.dirReal, 'run.sh');
  });
  gate('g2_reserved_prefixes_refused', () => ['ANTHROPIC_API_KEY', 'CLAUDE_DECK_X', 'ELECTRON_RUN', 'DECK_PLUGIN_ID']
    .every((n) => refused(good({ env: [slot(n)] }), INVALID('env[0].name (nom réservé)'))));
  gate('g3_base_name_refused', () => refused(good({ env: [slot('PATH')] }), INVALID('env[0].name (variable de base)'))
    && refused(good({ env: [slot('JIRA_URL'), slot('HOME')] }), INVALID('env[1].name (variable de base)')));
  gate('g4_injection_names_refused', () => [`X;touch ${CANARY}`, `$(touch ${CANARY})`, 'A B', '1A', 'A-B', 'FOO\n', 'A'.repeat(65), 'é']
    .every((n) => {
      const r = check(good({ env: [slot(n)] }));
      return r.ok === false && r.error.startsWith('Nom de variable invalide : ') && !/[\x00-\x1f]/.test(r.error);
    }));
  gate('g5_duplicate_name_refused', () => refused(good({ env: [slot('JIRA_URL'), slot('JIRA_URL')] }), INVALID('env[1].name (doublon)')));
  gate('g6_hints_refused', () => [['jira'], [], ['A', 'B', 'C', 'D', 'E', 'F', 'G'], ['A-B'], 'TOKEN', [1]]
    .every((h) => refusedStarts(good({ env: [slot('JIRA_URL', { hints: h })] }), INVALID('env[0].hints'))));
  gate('g7_slot_shape_refused', () => refused(good({ env: [slot('A', { label: 'x'.repeat(61) })] }), INVALID('env[0].label'))
    && refused(good({ env: [slot('A', { label: '' })] }), INVALID('env[0].label'))
    && refused(good({ env: [slot('A', { required: 'yes' })] }), INVALID('env[0].required'))
    && refused(good({ env: Array.from({ length: 17 }, (_, i) => slot(`S${i}`)) }), INVALID('env'))
    && refused(good({ env: 'JIRA_URL' }), INVALID('env'))
    && refused(good({ env: [null] }), INVALID('env[0]'))
    && refused(good({ env: [{ label: 'x', required: true, hints: ['A'] }] }), INVALID('env[0].name')));
  gate('g8_npm_prefix_and_no_env_accepted', () => check(good({ env: [slot('npm_config_registry')] })).ok === true
    && check(good({ env: Array.from({ length: 16 }, (_, i) => slot(`S${i}`)) })).ok === true
    && (() => { const m = good(); delete m.env; const r = check(m); return r.ok === true && Array.isArray(r.manifest.env) && r.manifest.env.length === 0; })());
  gate('g9_top_level_fields_refused', () => refused(good({ id: 'Bad_ID' }), INVALID('id'))
    && refused(good({ id: 'a'.repeat(41) }), INVALID('id'))
    && refused(good({ label: 'x'.repeat(61) }), INVALID('label'))
    && refused(good({ description: 'x'.repeat(301) }), INVALID('description'))
    && refused(good({ trigger: 'weekly' }), INVALID('trigger'))
    && refused(good({ argv: [] }), INVALID('argv'))
    && refused(good({ argv: Array.from({ length: 9 }, () => 'run.sh') }), INVALID('argv'))
    && refused(good({ argv: [1] }), INVALID('argv'))
    && refused('{not json', INVALID('JSON'))
    && refused('[]', INVALID('manifeste'))
    && M.validateManifest(path.join(TMP, 'does-not-exist'), { baseNames: BASE }).error === E_ABSENT
    && M.validateManifest(fs.mkdtempSync(path.join(TMP, 'empty-')), { baseNames: BASE }).error === E_ABSENT);
  gate('g10_argv_escape_refused', () => {
    fs.writeFileSync(path.join(TMP, 'outside.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const symDir = plugin(good({ argv: ['link.sh'] }), { name: 'g10-sym' });
    fs.symlinkSync(path.join(TMP, 'outside.sh'), path.join(symDir, 'link.sh'));
    const aliasDir = plugin(good({ argv: ['alias.sh'] }), { name: 'g10-alias' });
    fs.symlinkSync('run.sh', path.join(aliasDir, 'alias.sh'));
    const alias = M.validateManifest(aliasDir, { baseNames: BASE });
    const nested = plugin(good({ argv: ['bin/../run.sh', '--flag', ''] }), { name: 'g10-nested' });
    return refused(good({ argv: ['../outside.sh'] }), E_OUTSIDE)
      && refused(good({ argv: [path.join(TMP, 'outside.sh')] }), E_OUTSIDE)
      && M.validateManifest(symDir, { baseNames: BASE }).error === E_OUTSIDE
      && alias.ok === true && alias.argv0Abs === path.join(fs.realpathSync(aliasDir), 'run.sh')
      && M.validateManifest(nested, { baseNames: BASE }).ok === true
      && check(good(), { exec: false }).error === INVALID('argv[0]')
      && refused(good({ argv: ['missing.sh'] }), INVALID('argv[0]'));
  });
  gate('g11_base_names_fail_closed', () => {
    const dir = plugin(good({ env: [slot('PATH')] }), { name: 'g11' });
    let threw = false;
    try { M.validateManifest(dir); } catch (e) { threw = e instanceof TypeError; }
    return threw && M.validateManifest(dir, { baseNames: new Set(BASE) }).ok === false;
  });
  gate('g12_name_re_and_prefixes_exported', () => M.NAME_RE instanceof RegExp && M.NAME_RE.test('JIRA_URL') && !M.NAME_RE.test('X;y')
    && !M.NAME_RE.test('A\n') && ['ANTHROPIC_', 'CLAUDE_DECK_', 'ELECTRON_', 'DECK_PLUGIN_'].every((p) => M.REFUSED_PREFIXES.includes(p))
    && !M.REFUSED_PREFIXES.includes('npm_') && M.REFUSED_PREFIXES.length === 4);
  gate('g13_scan_real_dirs_only', () => {
    const root = path.join(TMP, 'plugins');
    fs.mkdirSync(root);
    plugin(good(), { parent: root, name: 'daily-brief' });
    plugin(good({ id: 'zeta', env: [] }), { parent: root, name: 'zeta' });
    plugin(good({ id: 'dotted' }), { parent: root, name: '.dotted' });
    const real = plugin(good({ id: 'linked' }), { parent: path.join(TMP, 'elsewhere'), name: 'linked' });
    fs.symlinkSync(real, path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
    plugin(good({ id: 'badargv', argv: ['../x'] }), { parent: root, name: 'badargv' });
    plugin(good({ id: 'other' }), { parent: root, name: 'mismatch' });
    fs.mkdirSync(path.join(root, 'nomanifest'));
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let found;
    let absent;
    try { found = M.scan(root, { baseNames: BASE }); absent = M.scan(path.join(TMP, 'nope'), { baseNames: BASE }); } finally { console.warn = realWarn; }
    return found.map((p) => p.id).join(',') === 'daily-brief,zeta'
      && found[0].dir === path.join(root, 'daily-brief') && found[0].manifest.env.length === 6 && path.isAbsolute(found[0].argv0Abs)
      && Array.isArray(absent) && absent.length === 0
      && warns.length === 3 && warns.every((w) => w.startsWith('[plugins] '))
      && ['badargv', 'mismatch', 'nomanifest'].every((n) => warns.filter((w) => w.includes(n)).length === 1)
      && !warns.some((w) => w.includes('.dotted') || w.includes('linked') || w.includes('stray'));
  });
  gate('g14_module_is_a_leaf', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    return reqs.length > 0 && reqs.every((r) => ['fs', 'path', 'node:fs', 'node:path'].includes(r)) && !/child_process|\bexec(Sync)?\(|spawn/.test(src);
  });
  gate('g15_no_file_created_by_injection_names', () => !fs.existsSync(CANARY));
  // GNU `env` reads "$0" as an assignment when argv[0] holds `=` (the launch template ends in `env ... "$0" "$@"`).
  gate('g16_argv0_with_equals_refused', () => {
    const msg = INVALID('argv[0] (caractère « = » interdit)');
    const dir = plugin(good({ argv: ['bin/x=y'] }), { name: 'g16' });
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'x=y'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // exists and is executable: only the `=` can refuse it
    const r = M.validateManifest(dir, { baseNames: BASE });
    const withArg = check(good({ argv: ['run.sh', '--key=value', 'a=b'] }));
    return r.ok === false && r.error === msg
      && refused(good({ argv: ['x=y'] }), msg) && refused(good({ argv: ['=run.sh'] }), msg)
      && withArg.ok === true && withArg.manifest.argv[2] === 'a=b'; // `=` stays legal in the later arguments
  });
  finish();
}
