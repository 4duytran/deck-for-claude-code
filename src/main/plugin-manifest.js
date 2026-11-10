'use strict';
// Plugin manifest validation + folder scan. Leaf module: `fs` and `path` only, nothing is ever executed here.
// Every slot name is checked against NAME_RE because the launch template (plugin-runner) embeds names in shell text.
// validateManifest never throws on a bad plugin (returns { ok:false, error }), only on a missing `baseNames`.
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'deck-plugin.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_MAX = 64;
const HINT_RE = /^[A-Z0-9]+$/;
const REFUSED_PREFIXES = Object.freeze(['ANTHROPIC_', 'CLAUDE_DECK_', 'ELECTRON_', 'DECK_PLUGIN_']);
const TRIGGERS = ['daily', 'manual'];
const LABEL_MAX = 60;
const DESCRIPTION_MAX = 300;
const ARGV_MAX = 8;
const ENV_MAX = 16;
const HINTS_MAX = 6;
const OPTIONS_MAX = 8;
const CHOICES_MIN = 2;
const CHOICES_MAX = 6;
// Option names and choice values end up in a literal `DECK_PLUGIN_OPT_<NAME>=<value>` word of the launch template:
// both shapes need no shell quoting.
const OPTION_NAME_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const CHOICE_VALUE_RE = /^[a-z][a-z0-9-]{0,31}$/;

const E_ABSENT = `Manifeste absent (${MANIFEST_FILE})`;
const E_OUTSIDE = 'La commande doit rester dans le dossier du plugin';

class Refusal extends Error {}
const refuse = (message) => new Refusal(message);
const invalid = (field) => refuse(`Manifeste invalide : ${field}`);
const safe = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 80);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;
const isLabel = (s) => typeof s === 'string' && s.trim() !== '' && chars(s) <= LABEL_MAX;
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function nameSet(baseNames) {
  if (!Array.isArray(baseNames) && !(baseNames instanceof Set)) {
    throw new TypeError('plugin-manifest: baseNames must be an array or a Set of variable names');
  }
  return new Set([...baseNames].filter((n) => typeof n === 'string'));
}

function readManifest(dirReal) {
  const file = path.join(dirReal, MANIFEST_FILE);
  let st;
  try { st = fs.lstatSync(file); } catch { throw refuse(E_ABSENT); }
  if (!st.isFile()) throw refuse(E_ABSENT);
  if (st.size > MANIFEST_MAX_BYTES) throw invalid('taille');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { throw invalid('JSON'); }
  if (!isObject(raw)) throw invalid('manifeste');
  return raw;
}

// Returns the realpath of argv[0]: a regular executable file inside the plugin folder.
function checkCommand(argv, dirReal) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > ARGV_MAX
    || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || argv[0] === '') throw invalid('argv');
  // The launch template ends in `env ... "$0" "$@"`: GNU env would read an argv[0] holding `=` as an assignment.
  if (argv[0].includes('=')) throw invalid('argv[0] (caractère « = » interdit)');
  const lexical = path.resolve(dirReal, argv[0]);
  if (path.isAbsolute(argv[0]) || !inside(dirReal, lexical)) throw refuse(E_OUTSIDE);
  let real;
  try { real = fs.realpathSync(lexical); } catch { throw invalid('argv[0]'); }
  if (!inside(dirReal, real)) throw refuse(E_OUTSIDE);
  try {
    if (!fs.statSync(real).isFile()) throw new Error('not a file');
    fs.accessSync(real, fs.constants.X_OK);
  } catch { throw invalid('argv[0]'); }
  return real;
}

function checkSlot(slot, i, seen, base) {
  const at = `env[${i}]`;
  if (!isObject(slot)) throw invalid(at);
  const { name, label, required, hints } = slot;
  if (typeof name !== 'string') throw invalid(`${at}.name`);
  if (name.length > NAME_MAX || !NAME_RE.test(name)) throw refuse(`Nom de variable invalide : ${safe(name)}`);
  if (REFUSED_PREFIXES.some((p) => name.startsWith(p))) throw invalid(`${at}.name (nom réservé)`);
  if (base.has(name)) throw invalid(`${at}.name (variable de base)`);
  if (seen.has(name)) throw invalid(`${at}.name (doublon)`);
  seen.add(name);
  if (!isLabel(label)) throw invalid(`${at}.label`);
  if (typeof required !== 'boolean') throw invalid(`${at}.required`);
  if (!Array.isArray(hints) || hints.length < 1 || hints.length > HINTS_MAX) throw invalid(`${at}.hints`);
  if (!hints.every((h) => typeof h === 'string' && HINT_RE.test(h))) throw invalid(`${at}.hints (majuscules et chiffres)`);
  return { name, label, required, hints: [...hints] };
}

function checkEnv(env, base) {
  if (env === undefined) return [];
  if (!Array.isArray(env) || env.length > ENV_MAX) throw invalid('env');
  const seen = new Set();
  return env.map((slot, i) => checkSlot(slot, i, seen, base));
}

function checkChoice(choice, seen) {
  if (!isObject(choice) || typeof choice.value !== 'string' || !CHOICE_VALUE_RE.test(choice.value)
    || seen.has(choice.value) || !isLabel(choice.label)) throw invalid('options');
  seen.add(choice.value);
  return { value: choice.value, label: choice.label };
}

function checkOption(option, seen, slotNames) {
  if (!isObject(option)) throw invalid('options');
  const { name, label, choices } = option;
  if (typeof name !== 'string' || !OPTION_NAME_RE.test(name) || seen.has(name) || slotNames.has(name)
    || !isLabel(label) || !Array.isArray(choices) || choices.length < CHOICES_MIN || choices.length > CHOICES_MAX) throw invalid('options');
  seen.add(name);
  const values = new Set();
  const checked = choices.map((c) => checkChoice(c, values));
  if (typeof option.default !== 'string' || !values.has(option.default)) throw invalid('options');
  return { name, label, choices: checked, default: option.default };
}

// A non-secret per-plugin choice (e.g. subscription / API). Every failure is the same « options » refusal.
function checkOptions(options, slotNames) {
  if (options === undefined) return [];
  if (!Array.isArray(options) || options.length > OPTIONS_MAX) throw invalid('options');
  const seen = new Set();
  return options.map((o) => checkOption(o, seen, slotNames));
}

function inspect(dir, base) {
  let dirReal;
  try {
    dirReal = fs.realpathSync(path.resolve(dir));
    if (!fs.statSync(dirReal).isDirectory()) throw new Error('not a directory');
  } catch { throw refuse(E_ABSENT); }
  const raw = readManifest(dirReal);
  const { id, label, description, argv, trigger } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid('id');
  if (!isLabel(label)) throw invalid('label');
  if (typeof description !== 'string' || chars(description) > DESCRIPTION_MAX) throw invalid('description');
  const argv0Abs = checkCommand(argv, dirReal);
  if (!TRIGGERS.includes(trigger)) throw invalid('trigger');
  const env = checkEnv(raw.env, base);
  const options = checkOptions(raw.options, new Set(env.map((s) => s.name)));
  return { id, dir: path.resolve(dir), dirReal, argv0Abs, manifest: { id, label, description, argv: [...argv], trigger, env, options } };
}

// -> { ok:true, id, dir, dirReal, argv0Abs, manifest } | { ok:false, error } (error = French, user-facing)
function validateManifest(dir, { baseNames } = {}) {
  const base = nameSet(baseNames);
  try {
    return { ok: true, ...inspect(dir, base) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message };
    return { ok: false, error: invalid('lecture impossible').message };
  }
}

// Real subdirectories only (lstat: a symlink or a file is not one; dot-entries ignored), sorted by id.
// An invalid folder, or one whose name differs from its manifest id, is skipped with one warn.
function scan(pluginsDir, { baseNames } = {}) {
  const base = nameSet(baseNames);
  let names;
  try { names = fs.readdirSync(pluginsDir); } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[plugins] ${safe(pluginsDir)}: ${e.code || 'lecture impossible'}`);
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(pluginsDir, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const r = validateManifest(dir, { baseNames: base });
    if (!r.ok) { console.warn(`[plugins] ${safe(name)}: ${r.error}`); continue; }
    if (r.id !== name) { console.warn(`[plugins] ${safe(name)}: Manifeste invalide : id (différent du nom du dossier)`); continue; }
    const { ok, ...plugin } = r;
    found.push(plugin);
  }
  return found;
}

module.exports = { validateManifest, scan, NAME_RE, NAME_MAX, REFUSED_PREFIXES, MANIFEST_FILE };
