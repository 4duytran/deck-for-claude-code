'use strict';
// Plugin host IPC (daily-brief): every channel is a thin delegate to the host composed in main.js (`getDeps()`, built on
// first use). Only variable NAMES, statuses and the plugins' own output cross this boundary, never a value; a failure
// answers { ok: false, error: '<French line>' } and is logged by channel name only.
//   plugins-list -> [row] · plugins-history -> [entry] · every other channel -> { ok, ... } | { ok: false, error }

const fs = require('node:fs');
const { ipcMain } = require('electron');
const { send, getWin } = require('../window');
const { putPage } = require('../page-scheme');
const { MAX_BYTES } = require('../plugin-reports');
const pluginInstall = require('../plugin-install');

const E_REQUEST = 'Requête invalide';
const E_UNKNOWN = 'Plugin introuvable';
const E_SHELL = 'Lecture du shell impossible';
const E_REPORT = 'Rapport introuvable';
const E_LOG = 'Journal introuvable';
const E_TOKEN = "Jeton d'import inconnu";

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const fail = (error) => ({ ok: false, error });
const obj = (v) => (v && typeof v === 'object' ? v : {});

const notifyPluginsChanged = () => send('plugins-changed');

let install = null;
function getInstall(d) {
  if (!install) {
    install = pluginInstall.create({
      pluginsDir: d.pluginsDir, dataRoot: d.dataRoot, statePath: d.statePath, validateManifest: d.validateManifest,
      isRunning: (id) => d.runner.isRunning(id, d.pluginOf(id)), stats: (id) => d.reports.stats(id),
      baseNames: d.baseNames, validName: d.access.validName, getWin,
    });
  }
  return install;
}

function historyFilter(f) {
  const x = obj(f);
  if (Number.isInteger(x.days)) return { days: x.days };
  if (typeof x.date === 'string') return { date: x.date };
  return undefined;
}

// « Détecter »: candidates among the names the shell exports now, for a plugin already installed ({ id }) or one
// picked and not yet imported ({ token }). Nothing is persisted.
async function detect(d, arg) {
  const a = obj(arg);
  let slots = null;
  if (typeof a.token === 'string') {
    const m = obj(await getInstall(d).manifestForToken(a.token));
    if (m.ok !== true) return fail(typeof m.error === 'string' ? m.error : E_TOKEN);
    slots = obj(m.manifest).env;
  } else if (isId(a.id)) {
    const p = d.pluginOf(a.id);
    if (!p) return fail(E_UNKNOWN);
    slots = p.env;
  } else return fail(E_REQUEST);
  if (!Array.isArray(slots)) return fail(E_REQUEST);
  const names = await d.access.listNames(d.shellPath);
  if (!names || names.ok !== true) return fail(E_SHELL);
  return { ok: true, rows: d.access.detect(slots, names.names), note: names.note || null };
}

function openReport(d, id, stem) {
  const file = isId(id) && typeof stem === 'string' ? d.reports.reportPath(id, stem) : null;
  if (!file) return fail(E_REPORT);
  if (fs.statSync(file).size > MAX_BYTES) return fail('tooLarge'); // same code as page-serve: the panel shows one line for both
  return putPage('plugin', fs.readFileSync(file, 'utf8'));
}

function readLog(d, id, stem) {
  const log = isId(id) && typeof stem === 'string' ? d.reports.readLog(id, stem) : null;
  return log ? { ok: true, text: log.text, truncated: Boolean(log.truncated) } : fail(E_LOG);
}

// A successful import or delete changes the installed set: rescan, then tell the panel. An import also has its access judged
// at once (`accessOf` reads the shell names, as « Détecter » does), so the row says « À configurer » before any other read.
async function settle(d, result, judgeAccess = false) {
  if (result && result.ok === true) {
    await d.host.rescan();
    if (judgeAccess && isId(result.id)) await d.host.accessOf(result.id);
    notifyPluginsChanged();
  }
  return result;
}

function registerPluginsIpc(getDeps) {
  const handle = (channel, fn, onError = () => fail(E_REQUEST)) => ipcMain.handle(channel, async (_e, req) => {
    try {
      return await fn(getDeps(), obj(req));
    } catch (err) {
      console.warn(`[plugins] ${channel} failed (${err && err.code ? err.code : err && err.name})`);
      return onError();
    }
  });
  // A mutator that succeeded changes what the panel shows.
  const mutate = (channel, fn) => handle(channel, async (d, req) => {
    const r = await fn(d, req);
    if (r && r.ok === true) notifyPluginsChanged();
    return r;
  });

  handle('plugins-list', (d) => d.host.list().map((row) => {
    let latest = null;
    try { latest = d.reports.latest(row.id); } catch (_) { /* no history yet */ }
    return { ...row, latest };
  }), () => []);
  mutate('plugins-set-enabled', (d, r) => (isId(r.id) ? d.host.setEnabled(r.id, r.enabled) : fail(E_REQUEST)));
  mutate('plugins-set-retention', (d, r) => (isId(r.id) ? d.host.setRetention(r.id, r.days) : fail(E_REQUEST)));
  mutate('plugins-set-env-map', (d, r) => (isId(r.id) ? d.host.setEnvMap(r.id, r.map) : fail(E_REQUEST)));
  // Declared option pick (e.g. call mode): the host stores only a declared name with one of its declared values.
  // `plugins-access` answers the option rows { name, label, choices, value } next to the slot rows.
  mutate('plugins-set-option', (d, r) => (isId(r.id) ? d.host.setOption(r.id, r.name, r.value) : fail(E_REQUEST)));
  handle('plugins-access', (d, r) => (isId(r.id) ? d.host.accessOf(r.id) : fail(E_REQUEST)));
  handle('plugins-detect', (d, r) => detect(d, r));
  mutate('plugins-run-now', (d, r) => (isId(r.id) ? d.host.runNow(r.id) : fail(E_REQUEST)));
  mutate('plugins-stop', (d, r) => (isId(r.id) ? d.host.stop(r.id) : fail(E_REQUEST)));
  handle('plugins-history', (d, r) => (isId(r.id) ? d.reports.list(r.id, historyFilter(r.filter)) : []), () => []);
  handle('plugins-open-report', (d, r) => openReport(d, r.id, r.stem));
  handle('plugins-read-log', (d, r) => readLog(d, r.id, r.stem));

  handle('plugins-pick', (d) => getInstall(d).pick());
  handle('plugins-import', async (d, r) => {
    if (typeof r.token !== 'string') return fail(E_REQUEST);
    const o = obj(r.opts);
    return settle(d, await getInstall(d).importPlugin(r.token, { replace: o.replace === true, envMap: o.envMap }), true);
  });
  handle('plugins-delete-card', (d, r) => (isId(r.id) ? getInstall(d).deleteCard(r.id) : fail(E_REQUEST)));
  // A running plugin is stopped first; a stop that fails answers its refusal and deletes nothing. `deletePlugin` keeps its
  // own « en cours d'exécution » refusal as the last guard.
  handle('plugins-delete', async (d, r) => {
    if (!isId(r.id)) return fail(E_REQUEST);
    if (d.runner.isRunning(r.id, d.pluginOf(r.id))) {
      const stopped = await d.host.stop(r.id);
      if (!stopped || stopped.ok !== true) return stopped || fail(E_REQUEST);
    }
    return settle(d, await getInstall(d).deletePlugin(r.id));
  });
}

// After app ready: the daily rule runs once per Deck start (no plugin -> no shell, no write).
function startPlugins(getDeps) {
  Promise.resolve()
    .then(() => getDeps().host.startup())
    .then(notifyPluginsChanged)
    .catch(() => console.warn('[plugins] startup failed'));
}

module.exports = { registerPluginsIpc, startPlugins, notifyPluginsChanged };
