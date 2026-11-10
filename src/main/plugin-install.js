// claude-deck — plugin import / delete (main process). Import copies a folder the user picked into the plugins dir
// (temp copy, manifest re-validated on the copy, atomic rename); delete removes the copy, the state entry and every
// report under plugin-data/<id>. The source folder is only ever read. Nothing here runs a plugin or reads an env value:
// envMap holds variable NAMES, each checked before anything touches the disk. Collaborators are injected (probes pass fakes).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RETENTION_DAYS = 30;
const OPTION_NAME_RE = /^[A-Z][A-Z0-9_]{0,31}$/; // same shapes as plugins.js and the manifest's `options` kind
const OPTION_VALUE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_MAX = 16;
const E_RUNNING = "Plugin en cours d'exécution";
const E_OUTSIDE = 'Suppression refusée : chemin hors du dossier des plugins';
const E_TOKEN = 'Import expiré : choisissez de nouveau le dossier';
const E_EXISTS = 'Plugin déjà installé';
const E_UNKNOWN = 'Plugin introuvable';
const E_REQUEST = 'Requête invalide';
const E_PICK = 'Sélection impossible';

class Refusal extends Error {}
const fail = (error, extra) => ({ ok: false, error, ...extra });
const code = (e) => String((e && e.code) || 'erreur').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'erreur';
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// isRunning(id) -> boolean (bound by the host to runner.isRunning(id, plugin)); stats(id) -> { count, bytes }.
// baseNames and validName are required (a missing one throws here); every other call answers a plain object,
// { ok: true, ... } or { ok: false, error: '<French line>' }, and does not throw.
function create({ pluginsDir, dataRoot, statePath, validateManifest, isRunning, stats, baseNames, validName, getWin }) {
  if (!baseNames || typeof validName !== 'function') throw new TypeError('plugin-install: baseNames and validName are required');
  const tokens = new Map(); // token -> { id, dir, manifest, expires }: what a pick validated, spent by a successful import
  const goodName = (n) => typeof n === 'string' && validName(n);
  const pluginsRoot = () => path.resolve(pluginsDir);
  const dataDir = () => path.resolve(dataRoot);
  const busy = (id) => { try { return Boolean(isRunning(id)); } catch { return true; } }; // unknown = refuse
  const card = (id) => { try { const s = stats(id); return { count: Number(s.count) || 0, bytes: Number(s.bytes) || 0 }; } catch { return { count: 0, bytes: 0 }; } };

  // ---- state file (plugins.json): re-read on every operation, written tmp + rename, like plugins.js ----
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch { return {}; } // ENOENT or corrupt
  }
  function writeState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(`${statePath}.tmp`, statePath);
  }
  function keptOf(entry) { // what a replace carries over, re-validated as plugins.js entryOf does
    const e = entry && typeof entry === 'object' ? entry : {};
    const envMap = Object.create(null);
    if (e.envMap && typeof e.envMap === 'object') {
      for (const [slot, name] of Object.entries(e.envMap)) if (goodName(slot) && goodName(name)) envMap[slot] = name;
    }
    const options = Object.create(null); // the user's option picks, carried as stored (a stale name is ignored at read time)
    if (e.options && typeof e.options === 'object') {
      for (const [name, value] of Object.entries(e.options)) {
        if (OPTION_NAME_RE.test(name) && typeof value === 'string' && OPTION_VALUE_RE.test(value)) options[name] = value;
      }
    }
    return {
      lastAutoDate: typeof e.lastAutoDate === 'string' && DATE_RE.test(e.lastAutoDate) ? e.lastAutoDate : null,
      retentionDays: Number.isInteger(e.retentionDays) && e.retentionDays >= 1 && e.retentionDays <= 365 ? e.retentionDays : DEFAULT_RETENTION_DAYS,
      envMap,
      options,
    };
  }

  // ---- single-use tokens ----
  function issue(src) {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
    while (tokens.size >= TOKEN_MAX) tokens.delete(tokens.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { ...src, expires: now + TOKEN_TTL_MS });
    return token;
  }
  function lookup(token) {
    const t = typeof token === 'string' ? tokens.get(token) : null;
    if (t && t.expires > Date.now()) return t;
    if (t) tokens.delete(token);
    return null;
  }
  const installed = (id) => lstatOrNull(path.join(pluginsRoot(), id)) !== null;

  // Native directory picker, then the manifest is validated on the SOURCE; nothing is copied before the import call.
  async function pick() {
    let res;
    try {
      const { dialog } = require('electron'); // read at call time: a probe replaces dialog.showOpenDialog
      const opts = { title: 'Choisir le dossier du plugin', buttonLabel: 'Choisir', properties: ['openDirectory'] };
      const win = typeof getWin === 'function' ? getWin() : null;
      res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    } catch { return fail(E_PICK); }
    if (!res || res.canceled || !Array.isArray(res.filePaths) || typeof res.filePaths[0] !== 'string') return { ok: false, canceled: true };
    const v = validateManifest(res.filePaths[0], { baseNames });
    if (!v.ok) return fail(v.error);
    // source / dest: the two folders the import card shows (the picked folder, and where the copy would land)
    return { ok: true, token: issue({ id: v.id, dir: v.dirReal, manifest: v.manifest }), id: v.id, manifest: v.manifest, exists: installed(v.id),
      source: v.dirReal, dest: path.join(pluginsRoot(), v.id) };
  }

  // The manifest a pending import was picked with (slots for « Détecter » and the access form). Does not spend the token.
  function manifestForToken(token) {
    const t = lookup(token);
    return t ? { ok: true, id: t.id, manifest: t.manifest, exists: installed(t.id) } : fail(E_TOKEN);
  }

  // input: undefined | { <slot>: '<USER_VAR_NAME>' }; '' / null unmaps a slot. The refusal names the slot, never the text.
  function checkEnvMap(input, slots) {
    if (input === undefined || input === null) return { map: Object.create(null) };
    if (typeof input !== 'object' || Array.isArray(input)) return { error: E_REQUEST };
    const declared = new Set(slots.map((s) => s.name));
    const map = Object.create(null);
    for (const [slot, value] of Object.entries(input)) {
      if (!declared.has(slot)) return { error: E_REQUEST };
      if (value === '' || value === null || value === undefined) { map[slot] = null; continue; }
      if (!goodName(value)) return { error: `Nom de variable invalide : ${slot}` };
      map[slot] = value;
    }
    return { map };
  }

  // Copy -> validate the copy -> swap -> state; any failure puts the previous copy and state back.
  function importPlugin(token, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const t = lookup(token);
    if (!t) return fail(E_TOKEN);
    const src = validateManifest(t.dir, { baseNames }); // the source may have changed since the pick
    if (!src.ok || src.id !== t.id) { tokens.delete(token); return fail(src.ok ? E_TOKEN : src.error); }
    const checked = checkEnvMap(o.envMap, src.manifest.env);
    if (checked.error) return fail(checked.error); // recoverable: the token stays
    const id = t.id;
    const root = pluginsRoot();
    const target = path.join(root, id);
    const present = lstatOrNull(target) !== null;
    if (present && o.replace !== true) return fail(E_EXISTS, { exists: true });
    if (present && busy(id)) return fail(E_RUNNING);
    tokens.delete(token);

    const stamp = crypto.randomBytes(6).toString('hex');
    const tmp = path.join(root, `.import-${stamp}`); // dot-entry: a scan ignores it
    const old = path.join(root, `.old-${stamp}`);
    let swapped = false;
    try {
      fs.mkdirSync(root, { recursive: true });
      if (inside(fs.realpathSync(root), src.dirReal)) throw new Error('inside');
      // links are copied as links (never followed): the copy cannot read outside the source
      fs.cpSync(src.dirReal, tmp, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
      const copy = validateManifest(tmp, { baseNames });
      if (!copy.ok || copy.id !== id) throw new Refusal(copy.ok ? E_TOKEN : copy.error);
      const state = readState();
      const kept = keptOf(present ? state[id] : null);
      const envMap = Object.create(null);
      for (const s of src.manifest.env) {
        const v = checked.map[s.name] !== undefined ? checked.map[s.name] : kept.envMap[s.name];
        if (typeof v === 'string') envMap[s.name] = v; // slots the new manifest no longer declares are dropped
      }
      if (present) fs.renameSync(target, old);
      fs.renameSync(tmp, target);
      swapped = true;
      state[id] = { enabled: true, lastAutoDate: kept.lastAutoDate, retentionDays: kept.retentionDays, envMap: { ...envMap } };
      if (Object.keys(kept.options).length) state[id].options = { ...kept.options };
      writeState(state);
      try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* a hidden leftover, the import stands */ }
      return { ok: true, id, replaced: present, enabled: true, envMap: { ...envMap } };
    } catch (e) {
      try { if (swapped) fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
      try { if (lstatOrNull(old)) fs.renameSync(old, target); } catch { /* best effort */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      return fail(e instanceof Refusal ? e.message : `Copie impossible : ${code(e)}`);
    }
  }

  // <root>/<id> as a real directory directly under the real root: { path, exists }, or null when the check refuses it
  // (a symlink, even to a directory, or a file). A missing root or entry is { exists: false }.
  function ownChild(root, id) {
    let rootReal;
    try { rootReal = fs.realpathSync(root); } catch (e) { return e.code === 'ENOENT' ? { path: null, exists: false } : null; }
    const p = path.join(rootReal, id);
    const st = lstatOrNull(p);
    if (!st) return { path: p, exists: false };
    return st.isDirectory() ? { path: p, exists: true } : null;
  }
  function locate(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return fail(E_OUTSIDE);
    const plugin = ownChild(pluginsRoot(), id);
    const data = ownChild(dataDir(), id);
    if (!plugin || !data) return fail(E_OUTSIDE);
    const inState = Object.prototype.hasOwnProperty.call(readState(), id);
    if (!plugin.exists && !data.exists && !inState) return fail(E_UNKNOWN);
    return { ok: true, plugin, data, inState };
  }

  // Delete confirmation card: what a delete would remove from plugin-data/<id> (reports count and bytes) and the folders it removes
  // (dir / dataDir: null when that folder is not there).
  function deleteCard(id) {
    const l = locate(id);
    return l.ok ? { ok: true, id, ...card(id), dir: l.plugin.exists ? l.plugin.path : null, dataDir: l.data.exists ? l.data.path : null } : l;
  }

  // Folder, then state entry, then data: a partial failure leaves an id that a second call finishes.
  function deletePlugin(id) {
    const l = locate(id);
    if (!l.ok) return l;
    if (busy(id)) return fail(E_RUNNING);
    const gone = card(id);
    try {
      if (l.plugin.exists) fs.rmSync(l.plugin.path, { recursive: true }); // links inside are unlinked, never followed
      if (l.inState) {
        const state = readState();
        delete state[id];
        writeState(state);
      }
      if (l.data.exists) fs.rmSync(l.data.path, { recursive: true });
    } catch (e) {
      return fail(`Suppression impossible : ${code(e)}`);
    }
    return { ok: true, id, ...gone };
  }

  return { pick, manifestForToken, importPlugin, deleteCard, deletePlugin };
}

module.exports = { create };
