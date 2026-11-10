'use strict';
// plugin-install-probe — daily-brief plan S8b (D14 import, D18 delete, D22 envMap names), D14 amended by
// plugins-v4-fixes Amendment 4 (T8): every import, new or replacement, leaves the plugin ENABLED; only the host
// readiness gate (plugins.js) keeps a plugin without its required access from running (g23):
// src/main/plugin-install.js on a throwaway tree. Hermetic: everything lives in a mkdtemp dir (plugins dir, data root,
// state file, source folders), no app boot, no network, no child process (g23 wires the host to a recording runner
// stub, never to the real runner); the native picker is stubbed in-process
// (dialog.showOpenDialog is read at call time by the module, so no seam is needed). The probe deletes only inside its
// own mkdtemp dir.
//   xvfb-run -a node_modules/.bin/electron test/plugin-install-probe.js
// PLUGIN_INSTALL_SRC=<file> points the probe at another copy of the module (mutation proofs); default: this tree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app, dialog, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.PLUGIN_INSTALL_SRC ? path.resolve(process.env.PLUGIN_INSTALL_SRC) : path.join(ROOT, 'src', 'main', 'plugin-install.js');
const FIX = path.join(__dirname, 'fixtures', 'plugins');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-install-probe-'));
const RAND = Math.random().toString(36).slice(2, 10);
const CANARY = `/tmp/p-${RAND}`; // `X;touch <CANARY>` must never run
const PLUGINS = path.join(TMP, 'plugins');
const DATA = path.join(TMP, 'plugin-data');
const STATE = path.join(TMP, 'plugins.json');
const ID = 'sample-report';
const BASE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
const E_RUNNING = "Plugin en cours d'exécution";
const E_OUTSIDE = 'Suppression refusée : chemin hors du dossier des plugins';
const E_TOKEN = 'Import expiré : choisissez de nouveau le dossier';
const E_EXISTS = 'Plugin déjà installé';
const E_UNKNOWN = 'Plugin introuvable';
const E_REQUEST = 'Requête invalide';
const E_BADNAME = 'Nom de variable invalide : API_TOKEN';

const results = {};
async function gate(name, fn) {
  try { results[name] = !!(await fn()); } catch (e) { results[name] = false; console.log(`  ${name} threw: ${(e && e.stack) || e}`); }
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

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const ls = (d) => (exists(d) ? fs.readdirSync(d).sort() : null);
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const dotted = (d) => (ls(d) || []).some((n) => n.startsWith('.'));
function treeHash(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const r = path.join(rel, n);
      if (st.isSymbolicLink()) h.update(`L ${r} ${fs.readlinkSync(p)}\n`);
      else if (st.isDirectory()) { h.update(`D ${r}\n`); walk(p, r); } else { h.update(`F ${r} ${st.mode & 0o777} `); h.update(fs.readFileSync(p)); h.update('\n'); }
    }
  }(dir, ''));
  return h.digest('hex');
}
const dirBytes = (d) => fs.readdirSync(d).reduce((n, f) => n + fs.statSync(path.join(d, f)).size, 0);

let seq = 0;
function mkSource(mutate) { // a fresh copy of the valid fixture: the fixtures themselves are never touched
  const dir = path.join(TMP, 'src', `s${++seq}`);
  fs.cpSync(path.join(FIX, 'valid'), dir, { recursive: true });
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  if (mutate) mutate(dir);
  return dir;
}
function editManifest(dir, fn) {
  const file = path.join(dir, 'deck-plugin.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(m);
  fs.writeFileSync(file, JSON.stringify(m));
}

// ---- native picker stub ----
let PICK = null;
let PICK_MODE = 'ok';
const dialogCalls = [];
dialog.showOpenDialog = async (...args) => {
  dialogCalls.push(args);
  if (PICK_MODE === 'throw') throw new Error('boom');
  if (PICK_MODE === 'cancel') return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: [PICK] };
};

let M;
try { M = require(SRC); } catch (e) { results.load = false; console.log(`  load failed: ${e.message}`); finish(); }
if (M) main().then(finish, (e) => { results.main_crashed = false; console.log(`  crashed: ${(e && e.stack) || e}`); finish(); });

async function main() {
  console.log(`node ${process.versions.node} electron ${process.versions.electron}`);
  const MF = require(path.join(ROOT, 'src', 'main', 'plugin-manifest.js'));
  const AC = require(path.join(ROOT, 'src', 'main', 'plugin-access.js'));
  let t = new Date(2026, 10, 2, 9, 0).getTime();
  const R = require(path.join(ROOT, 'src', 'main', 'plugin-reports.js')).create(DATA, () => (t += 60000));
  const RUNNING = new Set();
  const I = M.create({
    pluginsDir: PLUGINS,
    dataRoot: DATA,
    statePath: STATE,
    validateManifest: MF.validateManifest,
    isRunning: (id) => RUNNING.has(id),
    stats: R.stats,
    baseNames: BASE,
    validName: AC.validName,
  });
  const pick = (dir, mode = 'ok') => { PICK = dir; PICK_MODE = mode; return I.pick(); };
  function seedReports(id, n) {
    for (let i = 0; i < n; i++) {
      const e = R.newEntry(id, 'manual');
      fs.writeFileSync(e.reportPath, `<html>${'x'.repeat(100 * (i + 1))}</html>`);
      fs.writeFileSync(e.logPath, `log ${i}`);
      R.finishEntry(id, e.stem, { exit: 0 });
    }
  }

  const srcA = mkSource((d) => fs.writeFileSync(path.join(d, 'old-only.txt'), 'old'));
  const srcB = mkSource((d) => { editManifest(d, (m) => { m.label = 'Rapport v2'; }); fs.writeFileSync(path.join(d, 'new.txt'), 'new'); });
  const srcInvalid = path.join(TMP, 'src', 'invalid');
  fs.cpSync(path.join(FIX, 'invalid'), srcInvalid, { recursive: true });
  const srcEmpty = path.join(TMP, 'src', 'empty');
  fs.mkdirSync(srcEmpty);
  const hashA = treeHash(srcA);
  const hashB = treeHash(srcB);
  const hashInv = treeHash(srcInvalid);
  fs.mkdirSync(path.join(TMP, 'x')); // where `<plugins>/../x` lands
  fs.writeFileSync(path.join(TMP, 'x', 'keep.txt'), 'sentinel');
  const sentinelOk = () => exists(path.join(TMP, 'x', 'keep.txt')) && fs.readFileSync(path.join(TMP, 'x', 'keep.txt'), 'utf8') === 'sentinel';

  await gate('g0_platform_dialog_and_copy_api', () => typeof dialog.showOpenDialog === 'function' && typeof fs.cpSync === 'function'
    && /^\d+\.\d+\.\d+/.test(process.versions.node) && typeof M.create === 'function');

  await gate('g1_pick_cancel_and_dialog_failure_write_nothing', async () => {
    const c = await pick(srcA, 'cancel');
    const f = await pick(srcA, 'throw');
    const last = dialogCalls[0][dialogCalls[0].length - 1];
    return c.ok === false && c.canceled === true && !c.token && f.ok === false && typeof f.error === 'string' && !f.token
      && Array.isArray(last.properties) && last.properties.includes('openDirectory')
      && !exists(PLUGINS) && !exists(STATE) && !exists(DATA);
  });

  await gate('g2_invalid_manifest_french_message_nothing_copied', async () => {
    const bad = await pick(srcInvalid);
    const none = await pick(srcEmpty);
    return bad.ok === false && bad.error === 'Manifeste invalide : id' && !bad.token
      && none.ok === false && none.error === 'Manifeste absent (deck-plugin.json)'
      && !exists(PLUGINS) && !exists(STATE) && treeHash(srcInvalid) === hashInv;
  });

  let T; // token of the first valid pick, used through the envMap and import gates
  await gate('g3_pick_valid_gives_single_use_token_and_card', async () => {
    const r = await pick(srcA);
    T = r.token;
    return r.ok === true && /^[0-9a-f]{32}$/.test(r.token) && r.id === ID && r.exists === false
      && r.manifest.label === "Rapport d'exemple" && r.manifest.trigger === 'manual' && r.manifest.argv[0] === 'run.sh'
      && r.manifest.env.map((s) => s.name).join(',') === 'API_TOKEN,API_URL' && !exists(PLUGINS) && !exists(STATE);
  });

  await gate('g4_manifest_for_token', () => {
    const m = I.manifestForToken(T);
    return m.ok === true && m.id === ID && m.manifest.env.length === 2 && m.exists === false
      && I.manifestForToken('0'.repeat(32)).ok === false && I.manifestForToken(undefined).error === E_TOKEN
      && I.manifestForToken({}).error === E_TOKEN && I.manifestForToken(T).ok === true; // a read does not spend the token
  });

  await gate('g5_envmap_injection_refused_nothing_copied_canary_absent', () => {
    const bad = [`X;touch ${CANARY}`, '$(touch x)', 'A B', '1A', 'A-B', 'A'.repeat(65), 'é', 'FOO\n', 123, {}, ['A'], true];
    const named = bad.every((v) => {
      const r = I.importPlugin(T, { replace: false, envMap: { API_TOKEN: v } });
      return r.ok === false && r.error === E_BADNAME && !/touch|\$\(/.test(r.error);
    });
    const shape = [{ NOPE: 'X' }, JSON.parse('{"__proto__":"X"}'), 'x', []]
      .every((m) => I.importPlugin(T, { envMap: m }).error === E_REQUEST);
    return named && shape && !exists(PLUGINS) && !exists(STATE) && !exists(CANARY)
      && I.manifestForToken(T).ok === true; // a refusal you can fix keeps the token
  });

  await gate('g6_import_valid_copied_listed_enabled_source_intact', () => {
    const r = I.importPlugin(T, { replace: false, envMap: { API_TOKEN: 'MY_TOKEN_VAR' } });
    const dest = path.join(PLUGINS, ID);
    const listed = MF.scan(PLUGINS, { baseNames: BASE });
    const e = exists(STATE) ? readState()[ID] : null;
    return r.ok === true && r.id === ID && r.replaced === false && r.enabled === true
      && fs.statSync(path.join(dest, 'run.sh')).isFile() && (fs.statSync(path.join(dest, 'run.sh')).mode & 0o111) !== 0
      && exists(path.join(dest, 'old-only.txt')) && listed.length === 1 && listed[0].id === ID
      && !!e && e.enabled === true && e.lastAutoDate === null && e.retentionDays === 30
      && JSON.stringify(e.envMap) === JSON.stringify({ API_TOKEN: 'MY_TOKEN_VAR' })
      && JSON.stringify(ls(PLUGINS)) === JSON.stringify([ID]) && treeHash(srcA) === hashA;
  });

  await gate('g7_token_is_single_use', () => {
    const again = I.importPlugin(T, { replace: true });
    return again.ok === false && again.error === E_TOKEN && I.manifestForToken(T).error === E_TOKEN && JSON.stringify(ls(PLUGINS)) === JSON.stringify([ID]);
  });

  await gate('g8_existing_id_needs_replace', async () => {
    const p = await pick(srcA);
    const before = treeHash(path.join(PLUGINS, ID));
    const r = I.importPlugin(p.token, { replace: false });
    return p.exists === true && r.ok === false && r.exists === true && r.error === E_EXISTS
      && treeHash(path.join(PLUGINS, ID)) === before && !dotted(PLUGINS);
  });

  seedReports(ID, 3);
  fs.writeFileSync(path.join(DATA, ID, 'notes.txt'), 'keep me');
  // enabled: false on purpose: a replacement enables even a plugin the user had switched off (a kept `enabled` would also pass with true)
  fs.writeFileSync(STATE, JSON.stringify({ [ID]: { enabled: false, lastAutoDate: '2026-11-01', retentionDays: 45, envMap: { API_TOKEN: 'MY_TOKEN_VAR', OLD_SLOT: 'GONE_VAR' } } }));

  await gate('g9_replace_keeps_data_and_envmap_and_enables', async () => {
    const dataBefore = treeHash(path.join(DATA, ID));
    const p = await pick(srcB);
    const r = I.importPlugin(p.token, { replace: true });
    const dest = path.join(PLUGINS, ID);
    const e = readState()[ID];
    return r.ok === true && r.replaced === true && JSON.parse(fs.readFileSync(path.join(dest, 'deck-plugin.json'), 'utf8')).label === 'Rapport v2'
      && exists(path.join(dest, 'new.txt')) && !exists(path.join(dest, 'old-only.txt'))
      && treeHash(path.join(DATA, ID)) === dataBefore && R.stats(ID).count === 3
      && r.enabled === true && e.enabled === true && e.retentionDays === 45 && e.lastAutoDate === '2026-11-01'
      && JSON.stringify(e.envMap) === JSON.stringify({ API_TOKEN: 'MY_TOKEN_VAR' })
      && JSON.stringify(ls(PLUGINS)) === JSON.stringify([ID]) && treeHash(srcB) === hashB;
  });

  await gate('g10_replace_envmap_merges_and_unmaps', async () => {
    const p = await pick(srcB);
    const r = I.importPlugin(p.token, { replace: true, envMap: { API_URL: 'MY_URL', API_TOKEN: '' } });
    return r.ok === true && JSON.stringify(readState()[ID].envMap) === JSON.stringify({ API_URL: 'MY_URL' });
  });

  await gate('g11_running_refuses_replace_and_delete_nothing_removed', async () => {
    const p = await pick(srcA);
    RUNNING.add(ID);
    const inst = treeHash(path.join(PLUGINS, ID));
    const data = treeHash(path.join(DATA, ID));
    const state = fs.readFileSync(STATE, 'utf8');
    const rep = I.importPlugin(p.token, { replace: true });
    const del = I.deletePlugin(ID);
    const same = treeHash(path.join(PLUGINS, ID)) === inst && treeHash(path.join(DATA, ID)) === data && fs.readFileSync(STATE, 'utf8') === state;
    RUNNING.delete(ID);
    return rep.ok === false && rep.error === E_RUNNING && del.ok === false && del.error === E_RUNNING && same && !dotted(PLUGINS);
  });

  await gate('g12_delete_traversal_and_bad_ids_refused', () => {
    const bad = ['../x', '..', '.', '', 'x/../x', '/etc', '..\\x', 'A', `${ID}/`, `${ID}/..`, 'a'.repeat(41), null, undefined, 42, {}, ['..']];
    const all = bad.every((id) => {
      const r = I.deletePlugin(id);
      const c = I.deleteCard(id);
      return r.ok === false && r.error === E_OUTSIDE && c.ok === false && c.error === E_OUTSIDE;
    });
    return all && sentinelOk() && exists(path.join(PLUGINS, ID)) && exists(path.join(DATA, ID));
  });

  await gate('g13_delete_outward_symlinks_refused_and_never_followed', () => {
    const outA = path.join(TMP, 'outside-a');
    const outB = path.join(TMP, 'outside-b');
    const outC = path.join(TMP, 'outside-c');
    for (const d of [outA, outB, outC]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f.txt'), 'outside'); }
    const intact = (d) => exists(path.join(d, 'f.txt')) && fs.readFileSync(path.join(d, 'f.txt'), 'utf8') === 'outside';
    // A: the plugin folder itself is a symlink leaving the plugins dir
    fs.symlinkSync(outA, path.join(PLUGINS, 'evil'));
    const a = I.deletePlugin('evil');
    // B: the data dir is a symlink: the plugin copy must survive too (the whole operation is refused)
    fs.mkdirSync(path.join(PLUGINS, 'evil2'));
    fs.writeFileSync(path.join(PLUGINS, 'evil2', 'f'), 'x');
    fs.mkdirSync(DATA, { recursive: true });
    fs.symlinkSync(outB, path.join(DATA, 'evil2'));
    const b = I.deletePlugin('evil2');
    // C: symlinks INSIDE a plugin folder and a data dir are removed as links, their targets untouched
    fs.mkdirSync(path.join(PLUGINS, 'inner'));
    fs.symlinkSync(outC, path.join(PLUGINS, 'inner', 'out'));
    fs.mkdirSync(path.join(DATA, 'inner', 'reports'), { recursive: true });
    fs.symlinkSync(outC, path.join(DATA, 'inner', 'reports', 'link'));
    const c = I.deletePlugin('inner');
    const ok = a.ok === false && a.error === E_OUTSIDE && fs.lstatSync(path.join(PLUGINS, 'evil')).isSymbolicLink() && intact(outA)
      && b.ok === false && b.error === E_OUTSIDE && exists(path.join(PLUGINS, 'evil2', 'f')) && fs.lstatSync(path.join(DATA, 'evil2')).isSymbolicLink() && intact(outB)
      && c.ok === true && !exists(path.join(PLUGINS, 'inner')) && !exists(path.join(DATA, 'inner')) && intact(outC);
    fs.rmSync(path.join(PLUGINS, 'evil')); // a symlink: unlink only
    fs.rmSync(path.join(PLUGINS, 'evil2'), { recursive: true });
    fs.rmSync(path.join(DATA, 'evil2'));
    return ok && sentinelOk() && exists(path.join(PLUGINS, ID));
  });

  await gate('g14_delete_card_then_wipes_everything_source_intact', () => {
    const st = readState();
    st.other = { enabled: true, lastAutoDate: null, retentionDays: 30, envMap: {} };
    fs.writeFileSync(STATE, JSON.stringify(st));
    const bytes = dirBytes(path.join(DATA, ID, 'reports'));
    const card = I.deleteCard(ID);
    const r = I.deletePlugin(ID);
    const after = readState();
    const left = R.stats(ID);
    return card.ok === true && card.count === 3 && card.bytes === bytes && bytes > 0
      && r.ok === true && r.count === 3 && r.bytes === bytes
      && !exists(path.join(PLUGINS, ID)) && !exists(path.join(DATA, ID)) && !(ID in after)
      && JSON.stringify(after.other) === JSON.stringify(st.other)
      && left.count === 0 && left.bytes === 0
      && treeHash(srcA) === hashA && treeHash(srcB) === hashB && exists(PLUGINS) && exists(DATA) && sentinelOk();
  });

  await gate('g15_delete_unknown_writes_nothing_and_orphan_data_resumes', () => {
    const state = fs.readFileSync(STATE, 'utf8');
    const ghost = I.deletePlugin('ghost');
    fs.mkdirSync(path.join(DATA, 'orphan', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'orphan', 'reports', 'x.txt'), 'x');
    const orphan = I.deletePlugin('orphan');
    return ghost.ok === false && ghost.error === E_UNKNOWN && orphan.ok === true && !exists(path.join(DATA, 'orphan'))
      && fs.readFileSync(STATE, 'utf8') === state;
  });

  await gate('g16_copy_failure_keeps_installed_copy_and_state', async () => {
    const a = await pick(srcA);
    const first = I.importPlugin(a.token, {});
    if (process.getuid && process.getuid() === 0) return first.ok === true; // root reads mode-000 files: cannot provoke it
    const srcC = mkSource((d) => {
      editManifest(d, (m) => { m.label = 'Rapport v3'; });
      fs.writeFileSync(path.join(d, 'locked.dat'), 'x');
      fs.chmodSync(path.join(d, 'locked.dat'), 0o000);
    });
    const inst = treeHash(path.join(PLUGINS, ID));
    const state = fs.readFileSync(STATE, 'utf8');
    const p = await pick(srcC);
    const r = I.importPlugin(p.token, { replace: true });
    fs.chmodSync(path.join(srcC, 'locked.dat'), 0o644);
    return first.ok === true && p.ok === true && r.ok === false && r.error.startsWith('Copie impossible : ')
      && treeHash(path.join(PLUGINS, ID)) === inst && fs.readFileSync(STATE, 'utf8') === state
      && JSON.stringify(ls(PLUGINS)) === JSON.stringify([ID]);
  });

  await gate('g17_symlinks_in_source_copied_verbatim_not_followed', async () => {
    const srcD = mkSource((d) => { fs.symlinkSync('/etc/hostname', path.join(d, 'ext')); fs.symlinkSync('run.sh', path.join(d, 'rel')); });
    const p = await pick(srcD);
    const r = I.importPlugin(p.token, { replace: true });
    const dest = path.join(PLUGINS, ID);
    return r.ok === true && fs.lstatSync(path.join(dest, 'ext')).isSymbolicLink() && fs.readlinkSync(path.join(dest, 'ext')) === '/etc/hostname'
      && fs.readlinkSync(path.join(dest, 'rel')) === 'run.sh' && !dotted(PLUGINS);
  });

  await gate('g18_source_revalidated_at_import_and_never_inside_plugins', async () => {
    const mk = (id) => mkSource((d) => editManifest(d, (m) => { m.id = id; }));
    const s1 = mk('other-one');
    const p1 = await pick(s1);
    editManifest(s1, (m) => { m.trigger = 'weekly'; });
    const r1 = I.importPlugin(p1.token, {});
    const s2 = mk('third-one');
    const p2 = await pick(s2);
    editManifest(s2, (m) => { m.id = 'fourth-one'; });
    const r2 = I.importPlugin(p2.token, {});
    const inst = treeHash(path.join(PLUGINS, ID));
    const p3 = await pick(path.join(PLUGINS, ID)); // the installed copy as a source
    const r3 = I.importPlugin(p3.token, { replace: true });
    return r1.ok === false && r1.error === 'Manifeste invalide : trigger' && r2.ok === false && r2.error === E_TOKEN
      && r3.ok === false && r3.error.startsWith('Copie impossible : ') && treeHash(path.join(PLUGINS, ID)) === inst
      && JSON.stringify(ls(PLUGINS)) === JSON.stringify([ID]);
  });

  await gate('g19_tokens_are_bounded', async () => {
    const first = (await pick(srcA)).token;
    let last;
    for (let i = 0; i < 20; i++) last = (await pick(srcA)).token;
    return I.manifestForToken(first).error === E_TOKEN && I.manifestForToken(last).ok === true;
  });

  await gate('g20_module_never_executes_anything_and_leaves_no_trace', () => {
    const text = fs.readFileSync(SRC, 'utf8');
    return !/child_process|\bspawn|\bexecFile|\bexecSync|\beval\(/.test(text) && !exists(CANARY) && !dotted(PLUGINS) && sentinelOk();
  });

  await gate('g21_required_deps_and_plain_string_paths', () => {
    const deps = { pluginsDir: PLUGINS, dataRoot: DATA, statePath: STATE, validateManifest: MF.validateManifest, isRunning: () => false, stats: R.stats, baseNames: BASE, validName: AC.validName };
    const throwsType = (o) => { try { M.create(o); return false; } catch (e) { return e instanceof TypeError; } };
    const text = fs.readFileSync(SRC, 'utf8');
    return throwsType({ ...deps, baseNames: undefined }) && throwsType({ ...deps, validName: undefined })
      && !/\blazy\b/.test(text) && !/require\('\.\/(plugin-access|config)'\)/.test(text);
  });

  // The import card shows « Source » and « Copié dans », the delete card the two folders it removes: all four are plain path strings from main.
  await gate('g22_pick_and_delete_card_carry_the_folders', async () => {
    const r = await pick(srcA);
    const imported = I.importPlugin(r.token, { replace: true });
    const dataHere = exists(path.join(DATA, ID));
    const card = I.deleteCard(ID);
    const gone = I.deletePlugin(ID);
    return r.source === fs.realpathSync(srcA) && r.dest === path.join(path.resolve(PLUGINS), ID)
      && imported.ok === true && card.ok === true
      && card.dir === path.join(fs.realpathSync(PLUGINS), ID)
      && card.dataDir === (dataHere ? path.join(fs.realpathSync(DATA), ID) : null)
      && gone.ok === true && I.deleteCard('ghost').ok === false && !('dir' in I.deleteCard('ghost'));
  });

  // Amendment 4: an import without its required access is stored ENABLED; the host (plugins.js, untouched) lists it « À configurer »
  // and starts nothing. Host over the real scan / access.status / reports and a recording runner stub (no process can start here);
  // the last step maps the access and restarts the host: that one MUST launch, so the stub would have seen a run.
  await gate('g23_import_without_required_access_enabled_a_configurer_no_run', async () => {
    const NID = 'daily-unready';
    const srcN = mkSource((d) => editManifest(d, (m) => { m.id = NID; m.trigger = 'daily'; }));
    const p = await pick(srcN);
    const r = I.importPlugin(p.token, { replace: false }); // API_TOKEN (required) left unmapped
    const stored = readState()[NID];
    const runs = [];
    const running = new Set();
    let shellNames = ['PATH', 'HOME', 'OTHER_VAR'];
    const host = require(path.join(ROOT, 'src', 'main', 'plugins.js')).create({
      pluginsDir: PLUGINS,
      statePath: STATE,
      scan: (dir, opts) => MF.scan(dir, opts).map(({ manifest: m, ...q }) => ({ ...q, ...m, dir: q.dirReal })), // the flat descriptor main.js composes
      access: { listNames: async () => ({ ok: true, names: [...shellNames], note: null }), status: AC.status, validName: AC.validName },
      runner: {
        run: (plugin, envMap, trigger) => { runs.push({ id: plugin.id, trigger }); running.add(plugin.id); return { ok: true, stem: '2026-11-03T0900' }; },
        isRunning: (id) => running.has(id),
        runningStem: () => null,
      },
      reports: R,
      nowFn: () => new Date(2026, 10, 3, 9, 0).getTime(),
      baseNames: BASE,
    });
    await host.rescan(); // what the IPC layer does after an import
    const started = (await host.startup()).started; // a Deck start over the imported plugin
    await new Promise((res) => setTimeout(res, 2500)); // nothing may start late either
    const row = host.list().find((x) => x.id === NID);
    const now = readState()[NID];
    const manual = await host.runNow(NID);
    const quiet = runs.length === 0 && running.size === 0 && started.length === 0 && R.list(NID).length === 0 && !exists(path.join(DATA, NID));
    const refused = manual.ok === false && /^Accès requis manquant/.test(manual.error) && runs.length === 0;
    // control: the same plugin, access mapped to a name the shell exports, is launched by the next start
    shellNames = [...shellNames, 'MY_TOKEN_VAR'];
    const mapped = await host.setEnvMap(NID, { API_TOKEN: 'MY_TOKEN_VAR' });
    const again = (await host.startup()).started;
    return r.ok === true && r.id === NID && r.replaced === false && r.enabled === true
      && !!stored && stored.enabled === true && stored.lastAutoDate === null
      && !!row && row.enabled === true && row.ready === false && row.status === 'À configurer' && JSON.stringify(row.missing) === JSON.stringify(["Jeton d'API"])
      && now.enabled === true && now.lastAutoDate === null && quiet && refused
      && mapped.ok === true && JSON.stringify(again) === JSON.stringify([NID]) && runs.length === 1 && runs[0].trigger === 'auto';
  });

  // T8 retest (cdfix3): the real ipc/plugins.js handlers (captured off ipcMain, then driven as the renderer does) over a host that has
  // read no shell yet (a Deck start with nothing installed) and a fake shell listing no name. Right after the import the row is
  // « À configurer »: the IPC import path reads the names itself, no startup() or « Détecter » in between.
  await gate('g24_ipc_import_then_list_without_startup_a_configurer', async () => {
    const root = path.join(TMP, 'g24');
    const pluginsDir = path.join(root, 'plugins');
    const dataRoot = path.join(root, 'plugin-data');
    const statePath = path.join(root, 'plugins.json');
    fs.mkdirSync(pluginsDir, { recursive: true });
    let shellReads = 0;
    const access = { listNames: async () => { shellReads += 1; return { ok: true, names: ['PATH', 'HOME'], note: null }; }, status: AC.status, validName: AC.validName };
    const reports = require(path.join(ROOT, 'src', 'main', 'plugin-reports.js')).create(dataRoot, () => (t += 60000));
    const runs = [];
    const runner = { run: (plugin) => { runs.push(plugin.id); return { ok: true, stem: '2026-11-03T0900' }; }, isRunning: () => false, runningStem: () => null };
    const host = require(path.join(ROOT, 'src', 'main', 'plugins.js')).create({
      pluginsDir,
      statePath,
      scan: (dir, opts) => MF.scan(dir, opts).map(({ manifest: m, ...q }) => ({ ...q, ...m, dir: q.dirReal })),
      access,
      runner,
      reports,
      nowFn: () => new Date(2026, 10, 3, 9, 0).getTime(),
      baseNames: BASE,
    });
    await host.startup(); // nothing installed: no shell call
    const readsAtStart = shellReads;
    const deps = { host, pluginsDir, dataRoot, statePath, validateManifest: MF.validateManifest, runner, pluginOf: () => null, reports, baseNames: BASE, access };
    const handlers = new Map();
    const realHandle = ipcMain.handle;
    ipcMain.handle = (channel, fn) => { handlers.set(channel, fn); };
    try { require(path.join(ROOT, 'src', 'main', 'ipc', 'plugins.js')).registerPluginsIpc(() => deps); } finally { ipcMain.handle = realHandle; }
    const call = (channel, req) => handlers.get(channel)({}, req);
    const NID = 'ipc-unready';
    PICK = mkSource((d) => editManifest(d, (m) => { m.id = NID; m.trigger = 'daily'; }));
    PICK_MODE = 'ok';
    const picked = await call('plugins-pick');
    const imported = await call('plugins-import', { token: picked.token, opts: { replace: false } }); // API_TOKEN (required) left unmapped
    const row = (await call('plugins-list')).find((x) => x.id === NID);
    await new Promise((res) => setTimeout(res, 300));
    return handlers.size > 0 && readsAtStart === 0 && picked.ok === true && imported.ok === true && imported.id === NID && imported.enabled === true
      && !!row && row.enabled === true && row.ready === false && row.status === 'À configurer' &&JSON.stringify(row.missing) === JSON.stringify(["Jeton d'API"])
      && shellReads === 1 && runs.length === 0 && reports.list(NID).length === 0;
  });
}
