// claude-deck — plugin host policy: state (plugins.json), readiness gating, daily rule with claim restore, retention
// timing. Pure policy: every collaborator (scan, access, runner, reports) is injected and nothing here touches an env
// value or the shell; the host only ever handles variable NAMES and statuses.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RETENTION_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPTION_NAME_RE = /^[A-Z][A-Z0-9_]{0,31}$/; // same shapes as the manifest's `options` kind
const OPTION_VALUE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PRESENT = 'présente';
const NOT_CONFIGURED = 'À configurer';
const E_RUNNING = "Plugin en cours d'exécution";
const E_NOT_RUNNING = 'Aucune exécution en cours';
const E_STOP = 'Arrêt impossible';
const E_SHELL = 'Lecture du shell impossible';
const E_RETENTION = 'Durée de conservation : un entier entre 1 et 365';
const E_UNKNOWN = 'Plugin introuvable';
const E_REQUEST = 'Requête invalide';

const fail = (error) => ({ ok: false, error });
const short = (v) => String(v).slice(0, 64);

function dayOf(ms) { // local calendar day, YYYY-MM-DD (copy of price-feed.js dayOf)
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Result shape of every mutator: { ok: true, ... } or { ok: false, error: '<French line>' }, never a throw.
// scan -> [plugin]; access.listNames -> { ok, names, note }; baseNames is required (a missing one throws here).
function create({ pluginsDir, statePath, scan, access, runner, reports, nowFn = () => Date.now(), shellPath, baseNames }) {
  if (!baseNames) throw new TypeError('plugins: baseNames is required');
  let plugins = []; // last scan
  let names = null; // last shell listing (variable NAMES), null = not read or unreadable
  let shellError = false;
  let note = null; // the listing's status note, e.g. « shell non pris en charge, lecture via bash »
  const pending = new Map(); // id -> { prev, claimed }: an automatic run's claim, restorable until its exit

  // ---- state file: re-read on every operation, so writes by the import / delete module are never shadowed ----
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (_) { return {}; } // ENOENT or corrupt
  }
  function writeState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(`${statePath}.tmp`, statePath);
  }
  function entryOf(state, id) {
    const e = state[id] && typeof state[id] === 'object' ? state[id] : {};
    const envMap = Object.create(null); // a slot named __proto__ stays plain data
    if (e.envMap && typeof e.envMap === 'object') {
      for (const [slot, name] of Object.entries(e.envMap)) {
        if (access.validName(slot) && typeof name === 'string' && access.validName(name)) envMap[slot] = name;
      }
    }
    const options = Object.create(null); // name -> value of a declared choice, both shapes re-checked
    if (e.options && typeof e.options === 'object') {
      for (const [name, value] of Object.entries(e.options)) {
        if (OPTION_NAME_RE.test(name) && typeof value === 'string' && OPTION_VALUE_RE.test(value)) options[name] = value;
      }
    }
    return {
      enabled: e.enabled === true,
      lastAutoDate: typeof e.lastAutoDate === 'string' && DATE_RE.test(e.lastAutoDate) ? e.lastAutoDate : null,
      retentionDays: Number.isInteger(e.retentionDays) && e.retentionDays >= 1 && e.retentionDays <= 365 ? e.retentionDays : DEFAULT_RETENTION_DAYS,
      envMap,
      options,
    };
  }
  function update(id, patch) {
    const state = readState();
    const next = { ...entryOf(state, id), ...patch };
    if (!Object.keys(next.options).length) delete next.options; // an entry that never chose anything gains no key
    state[id] = next;
    writeState(state);
  }

  // ---- scan cache ----
  async function rescan() {
    try {
      const r = await scan(pluginsDir, { baseNames });
      plugins = Array.isArray(r) ? r : [];
    } catch (_) {
      console.warn('[plugins] scan failed');
      plugins = [];
    }
    return plugins;
  }
  async function find(id) {
    let p = plugins.find((x) => x.id === id);
    if (!p && typeof id === 'string') {
      await rescan(); // a plugin imported since the last scan
      p = plugins.find((x) => x.id === id);
    }
    return p || null;
  }

  // ---- readiness: slot statuses come from `access`; the shell is read only when a required slot exists ----
  const slotsOf = (p) => (Array.isArray(p.env) ? p.env : []);
  // ---- options: the manifest declares them, the entry stores the user's pick (a stale or odd pick reads as the default) ----
  const optionsOf = (p) => (Array.isArray(p.options) ? p.options : []);
  const valueOf = (o, st) => (o.choices.some((c) => c.value === st.options[o.name]) ? st.options[o.name] : o.default);
  const effectiveOptions = (p, st) => Object.fromEntries(optionsOf(p).map((o) => [o.name, valueOf(o, st)]));
  const optionRows = (p, st) => optionsOf(p).map((o) => ({
    name: o.name, label: o.label, choices: o.choices.map((c) => ({ value: c.value, label: c.label })), value: valueOf(o, st),
  }));
  const needsShell = (p) => slotsOf(p).some((s) => s.required === true);
  async function readNames() {
    let r;
    try { r = await access.listNames(shellPath); } catch (_) { r = null; }
    const list = r && r.ok === true && Array.isArray(r.names) ? r.names : null;
    shellError = !list;
    names = list ? list.filter((n) => typeof n === 'string') : null;
    note = list && typeof r.note === 'string' ? r.note : null;
    return names ? { ok: true, names } : { ok: false };
  }
  function evaluate(p, st, nameList) {
    const slots = slotsOf(p);
    const found = slots.length ? access.status(slots, st.envMap, nameList) : [];
    const rows = slots.map((slot) => {
      const row = (Array.isArray(found) && found.find((x) => x && x.name === slot.name)) || {};
      return {
        name: slot.name,
        label: slot.label,
        required: slot.required === true,
        hints: slot.hints,
        mapped: st.envMap[slot.name] || null,
        status: typeof row.status === 'string' ? row.status : null,
        candidates: Array.isArray(row.candidates) ? row.candidates.filter((c) => typeof c === 'string') : [],
      };
    });
    const missing = rows.filter((x) => x.required && x.status !== PRESENT).map((x) => x.label);
    return { rows, missing, ready: missing.length === 0 };
  }
  // nr = result of readNames(), or null when no listing was needed
  function judge(p, st, nr) {
    if (!needsShell(p)) return { ready: true, missing: [] };
    if (!nr || !nr.ok) return { ready: false, error: E_SHELL, missing: [] };
    const { ready, missing } = evaluate(p, st, nr.names);
    return { ready, missing };
  }
  const refusal = (g) => fail(g.error || `Accès requis manquant : ${g.missing.join(', ')}`);

  // ---- claim and run ----
  function restoreClaim(id) {
    const rec = pending.get(id);
    if (!rec) return;
    pending.delete(id);
    const state = readState();
    if (!state[id] || entryOf(state, id).lastAutoDate !== rec.claimed) return;
    update(id, { lastAutoDate: rec.prev });
  }
  // The runner answers { ok: true, stem, note? } or { ok: false, reason, name?, error? } (a fixed word, not a line).
  function refusalOf(r) {
    if (r.reason === 'running') return E_RUNNING;
    if (r.reason === 'invalid-name' && r.name) return `Nom de variable invalide : ${short(r.name)}`;
    if (r.reason === 'invalid-option') return 'Option invalide'; // the runner names none: a hand-built descriptor's text is never echoed
    return typeof r.error === 'string' ? `Lancement impossible : ${short(r.error)}` : 'Lancement impossible';
  }
  async function start(p, st, trigger) {
    try {
      const r = await runner.run(p, { ...st.envMap }, trigger, effectiveOptions(p, st));
      if (!r || r.ok === false || r.error) return fail(refusalOf(r || {}));
      return r.note ? { ok: true, stem: r.stem, note: r.note } : { ok: true, stem: r.stem };
    } catch (err) {
      return fail(`Lancement impossible : ${short(err && err.message)}`);
    }
  }
  async function launchAuto(p, st, today) {
    pending.set(p.id, { prev: st.lastAutoDate, claimed: today });
    update(p.id, { lastAutoDate: today }); // the claim precedes the run: a restart during it must not run twice
    const r = await start(p, st, 'auto');
    if (!r.ok) restoreClaim(p.id); // refused, no spawn: no exit will report
    return r.ok;
  }
  // The runner also needs the plugin (its command path) to recognise a run a previous Deck instance left alive.
  function pruneOne(id, days, plugin) {
    try { reports.prune(id, days, [runner.runningStem(id, plugin)].filter(Boolean)); } catch (_) { console.warn('[plugins] prune failed'); }
  }

  // Wire as runner `onExit`: restores a failed automatic run's claim, then prunes the plugin's history.
  function onExit(id, info) {
    try {
      const i = info || {};
      if (i.trigger === 'auto') {
        // success keeps the claim; so does a user stop: no automatic retry the same day
        if ((i.exit !== 0 || i.signal || i.error) && i.stopped !== true) restoreClaim(id);
        else pending.delete(id);
      }
      pruneOne(id, entryOf(readState(), id).retentionDays, plugins.find((x) => x.id === id));
    } catch (_) { console.warn('[plugins] exit handling failed'); }
  }

  // The daily rule is met by any successful run of today, whatever its trigger; a list failure reads as no report.
  function reportedToday(id, today) {
    try {
      return reports.list(id, { date: today }).some((e) => e && e.exit === 0 && e.hasReport === true);
    } catch (_) { return false; }
  }

  async function startup() {
    await rescan();
    if (!plugins.length) return { ok: true, started: [] }; // no plugin: no shell, no write
    const state = readState();
    for (const p of plugins) pruneOne(p.id, entryOf(state, p.id).retentionDays, p);
    const enabled = plugins.filter((p) => entryOf(state, p.id).enabled);
    const started = [];
    if (!enabled.length) return { ok: true, started };
    const nr = enabled.some(needsShell) ? await readNames() : null;
    const today = dayOf(nowFn());
    for (const p of enabled) {
      const st = entryOf(readState(), p.id);
      if (p.trigger !== 'daily' || st.lastAutoDate === today || runner.isRunning(p.id, p)) continue;
      if (reportedToday(p.id, today)) continue; // already reported today: no run and no claim
      if (!judge(p, st, nr).ready) continue; // not ready: no run and no claim
      if (await launchAuto(p, st, today)) started.push(p.id);
    }
    return { ok: true, started };
  }

  function list() {
    const state = readState();
    return plugins.map((p) => {
      const st = entryOf(state, p.id);
      let ready = null; // null = never read: rendered as nothing, not as a guess
      let missing = [];
      let error = null;
      if (!needsShell(p)) ready = true;
      else if (shellError) { ready = false; error = E_SHELL; } else if (names) ({ ready, missing } = evaluate(p, st, names));
      return {
        id: p.id,
        label: p.label,
        description: p.description,
        trigger: p.trigger,
        enabled: st.enabled,
        retentionDays: st.retentionDays,
        lastAutoDate: st.lastAutoDate,
        envMap: { ...st.envMap },
        ready,
        missing,
        error,
        running: Boolean(runner.isRunning(p.id, p)),
        status: ready === false ? NOT_CONFIGURED : null,
        note,
        options: optionRows(p, st),
      };
    });
  }

  async function setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') return fail(E_REQUEST);
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (runner.isRunning(id, p)) return fail(E_RUNNING); // a running plugin is not edited: stop it first
    const st = entryOf(readState(), id);
    if (st.enabled === enabled) return { ok: true, enabled };
    if (enabled) {
      const g = judge(p, st, needsShell(p) ? await readNames() : null);
      if (runner.isRunning(id, p)) return fail(E_RUNNING); // a run may have started during the shell read
      if (!g.ready) return refusal(g);
    }
    update(id, { enabled });
    return { ok: true, enabled };
  }

  async function setRetention(id, days) {
    const n = typeof days === 'string' && /^\d{1,3}$/.test(days) ? Number(days) : days;
    if (!Number.isInteger(n) || n < 1 || n > 365) return fail(E_RETENTION);
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (runner.isRunning(id, p)) return fail(E_RUNNING);
    update(id, { retentionDays: n });
    return { ok: true, retentionDays: n };
  }

  // `map` replaces the whole mapping { slot: USER_VAR_NAME }; '' / null unmaps a slot. All or nothing.
  async function setEnvMap(id, map) {
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (runner.isRunning(id, p)) return fail(E_RUNNING);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return fail(E_REQUEST);
    const declared = new Set(slotsOf(p).map((s) => s.name));
    const next = Object.create(null);
    for (const [slot, name] of Object.entries(map)) {
      if (name === '' || name === null || name === undefined) continue;
      if (!declared.has(slot)) return fail(E_REQUEST);
      // the line names the SLOT, never the rejected text: a pasted secret must not be echoed back
      if (typeof name !== 'string' || !access.validName(name)) return fail(`Nom de variable invalide : ${slot}`);
      next[slot] = name;
    }
    update(id, { envMap: { ...next } });
    return { ok: true, envMap: { ...next } };
  }

  // Only a declared option name and one of its declared values are stored; the pick survives the other writers.
  async function setOption(id, name, value) {
    if (typeof name !== 'string' || typeof value !== 'string') return fail(E_REQUEST);
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (runner.isRunning(id, p)) return fail(E_RUNNING);
    const option = optionsOf(p).find((o) => o.name === name);
    if (!option || !option.choices.some((c) => c.value === value)) return fail(E_REQUEST);
    update(id, { options: { ...entryOf(readState(), id).options, [name]: value } });
    return { ok: true, name, value };
  }

  async function runNow(id) {
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (runner.isRunning(id, p)) return fail(E_RUNNING);
    const st = entryOf(readState(), id);
    const g = judge(p, st, needsShell(p) ? await readNames() : null);
    if (!g.ready) return refusal(g);
    return start(p, st, 'manual');
  }

  // User stop of the running plugin (a run of this instance or a survivor of a previous one). The runner marks the entry
  // and ends the process group; an automatic run keeps its claim through onExit. -> { ok: true, stem } | { ok: false, error }
  async function stop(id) {
    const p = await find(id);
    if (!p) return fail(E_NOT_RUNNING);
    let r;
    try { r = await runner.stop(id, p); } catch (_) { return fail(E_STOP); }
    if (r && r.ok === true) return { ok: true, stem: r.stem };
    return fail(r && r.reason === 'still-alive' ? E_STOP : E_NOT_RUNNING);
  }

  // Fresh listing: the card / « Modifier » screen shows what the shell exports now.
  async function accessOf(id) {
    const p = await find(id);
    if (!p) return fail(E_UNKNOWN);
    if (!slotsOf(p).length) return { ok: true, rows: [], ready: true, missing: [], options: optionRows(p, entryOf(readState(), id)) };
    const nr = await readNames();
    if (!nr.ok) return fail(E_SHELL);
    const st = entryOf(readState(), id);
    const { rows, ready, missing } = evaluate(p, st, nr.names);
    return { ok: true, rows, ready, missing, note, options: optionRows(p, st) };
  }

  return { startup, rescan, list, setEnabled, setRetention, setEnvMap, setOption, runNow, stop, accessOf, onExit };
}

module.exports = { create };
