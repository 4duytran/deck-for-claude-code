// claude-deck — ipc/gitlab-drafts (deck-mr-review R6): review drafts of a merge request, kept in
// <userData>/gitlab-drafts.json until the user sends them. Key `host|project|iid`, host and project from the repo
// remote (gitlab-repo.js), never from the renderer. Read on every call, written atomically (tmp + rename).
// An unreadable file is copied to gitlab-drafts.json.corrupt (single, overwritten) and the store restarts empty.
// A `general` draft (« Sur toute la MR », deck-mr-ui M2) is {id, kind, body} only: no path, lines or version.
// A `reply` draft (an answer to a discussion thread) is {id, kind, discussionId, body} only; discussionId is checked
// against DISCUSSION_ID_RE (exported: gitlab.js checks it again before the POST, the id reaches a URL path).
// Requires ipc/gitlab-repo.js only: gitlab.js requires this module, never the reverse.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const { gitlabRepoId } = require('./gitlab-repo');

const STORE_FILE = 'gitlab-drafts.json';
const BODY_MAX = 100000;
const PATH_MAX = 4096;
const ERROR_MAX = 300;
const NO_REPO_MESSAGE = 'Dépôt GitLab introuvable';
const BAD_MR_MESSAGE = 'Merge request invalide';
const BAD_DRAFT_MESSAGE = 'Brouillon invalide';
const GENERAL = 'general';
const REPLY = 'reply';
const DISCUSSION_ID_RE = /^[0-9a-f]{40}$/;
const KINDS = new Set(['add', 'del', 'ctx', GENERAL]);

let corruptLogged = false;

const fail = (message) => ({ ok: false, message });
const storePath = () => path.join(app.getPath('userData'), STORE_FILE);
const rowsOf = (store, key) => (Array.isArray(store[key]) ? store[key] : []);
const text = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const lineNo = (v) => (Number.isInteger(v) && v > 0 ? v : null);

function writeStore(drafts) {
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, drafts }));
  fs.renameSync(tmp, file);
}

// The `drafts` map of the file: a missing file is empty, an unreadable one is kept aside and restarts empty.
function readStore() {
  const file = storePath();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  let map = null;
  try { map = JSON.parse(raw).drafts; } catch (_) { /* corrupt: handled below */ }
  if (map && typeof map === 'object' && !Array.isArray(map)) return map;
  const kept = `${file}.corrupt`;
  fs.copyFileSync(file, kept);
  if (!corruptLogged) {
    corruptLogged = true;
    console.log(`[gitlab-drafts] brouillons illisibles, copie gardée dans ${kept} pour récupération manuelle`);
  }
  writeStore({});
  return {};
}

function put(store, key, rows) {
  if (rows.length) store[key] = rows; else delete store[key];
  writeStore(store);
}

const bodyOf = (v) => (typeof v === 'string' && v.trim() && v.length <= BODY_MAX ? v : null);

function cleanGeneral(d, id) {
  const body = bodyOf(d.body);
  if (!id || !body) return null;
  const out = { id, kind: GENERAL, body };
  const error = text(d.error, ERROR_MAX);
  if (error) out.error = error;
  return out;
}

// The typeof check matters: RegExp.test coerces, so a one-item array holding a valid id would pass.
function cleanReply(d, id) {
  const body = bodyOf(d.body);
  if (!id || !body || typeof d.discussionId !== 'string' || !DISCUSSION_ID_RE.test(d.discussionId)) return null;
  const out = { id, kind: REPLY, discussionId: d.discussionId, body };
  const error = text(d.error, ERROR_MAX);
  if (error) out.error = error;
  return out;
}

// A draft in its stored shape, or null when it cannot become a GitLab position later (D10 shape).
// A general draft needs an id and a body only, a reply those plus a discussion id; anything else the caller sends is dropped.
function cleanDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const id = d.id == null ? crypto.randomUUID() : (typeof d.id === 'string' && /^[\w-]{1,64}$/.test(d.id) ? d.id : null);
  if (d.kind === GENERAL) return cleanGeneral(d, id);
  if (d.kind === REPLY) return cleanReply(d, id);
  const oldPath = text(d.path && d.path.old, PATH_MAX);
  const newPath = text(d.path && d.path.new, PATH_MAX);
  const v = d.version || {};
  const version = { base: text(v.base, 64), start: text(v.start, 64), head: text(v.head, 64) };
  const body = bodyOf(d.body);
  const o = lineNo(d.oldLine);
  const n = lineNo(d.newLine);
  const linesOk = d.kind === 'add' ? n : d.kind === 'del' ? o : o && n;
  if (!id || !(oldPath || newPath) || !KINDS.has(d.kind) || !linesOk || !body || Object.values(version).includes(null)) return null;
  const out = {
    id, path: { old: oldPath, new: newPath }, kind: d.kind,
    oldLine: d.kind === 'add' ? null : o, newLine: d.kind === 'del' ? null : n, body, version,
  };
  const error = text(d.error, ERROR_MAX);
  if (error) out.error = error;
  return out;
}

// Runs `fn(store, key)` for the MR behind `target`. The read-modify-write inside `fn` has no await, so two calls
// never interleave. Always resolves { ok, ... }.
async function withStore(target, iid, fn) {
  if (!/^[1-9]\d{0,9}$/.test(String(iid))) return fail(BAD_MR_MESSAGE);
  const id = await gitlabRepoId(target);
  if (!id) return fail(NO_REPO_MESSAGE);
  try { return fn(readStore(), `${id.host}|${id.project}|${iid}`); } catch (err) { return fail(err.message); }
}

const listDrafts = (target, iid) => withStore(target, iid, (store, key) => ({ ok: true, drafts: rowsOf(store, key) }));

// Adds the draft, or replaces the one with the same id in place; a draft without id gets one. The `uncertain` mark is
// never taken from the caller (cleanDraft); saving over an uncertain row clears it with its « maybe published » error.
const saveDraft = (target, iid, draft) => withStore(target, iid, (store, key) => {
  const clean = cleanDraft(draft);
  if (!clean) return fail(BAD_DRAFT_MESSAGE);
  const rows = rowsOf(store, key).slice();
  const i = rows.findIndex((x) => x.id === clean.id);
  if (i >= 0 && rows[i].uncertain) delete clean.error;
  if (i < 0) rows.push(clean); else rows[i] = clean;
  put(store, key, rows);
  return { ok: true, draft: clean };
});

const removeDraft = (target, iid, id) => withStore(target, iid, (store, key) => {
  const before = rowsOf(store, key);
  const after = before.filter((x) => x.id !== id);
  const removed = after.length !== before.length;
  if (removed) put(store, key, after);
  return { ok: true, removed };
});

// Marks a draft the send refused (`error` = the reason shown to the user); `uncertain` flags a POST that may have reached
// GitLab. The mark is lifted by saveDraft (the user's edit), removeDraft, or a definite send failure (`uncertain` false here).
const setDraftError = (target, iid, id, error, uncertain = false) => withStore(target, iid, (store, key) => {
  const before = rowsOf(store, key);
  if (!before.some((x) => x.id === id)) return { ok: true, updated: false };
  const reason = String(error).slice(0, ERROR_MAX);
  put(store, key, before.map((x) => {
    if (x.id !== id) return x;
    const { error: _old, uncertain: _flag, ...rest } = x;
    return { ...rest, error: reason, ...(uncertain && { uncertain: true }) };
  }));
  return { ok: true, updated: true };
});

function registerGitlabDraftsIpc() {
  ipcMain.handle('gitlab-drafts-list', (_e, p) => listDrafts(p?.target, p?.iid));
  ipcMain.handle('gitlab-draft-save', (_e, p) => saveDraft(p?.target, p?.iid, p?.draft));
  ipcMain.handle('gitlab-draft-delete', (_e, p) => removeDraft(p?.target, p?.iid, p?.id));
}

module.exports = { registerGitlabDraftsIpc, listDrafts, saveDraft, removeDraft, setDraftError, DISCUSSION_ID_RE };
