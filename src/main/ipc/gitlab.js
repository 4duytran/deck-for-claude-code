// claude-deck — ipc/gitlab (deck-mr-review): GitLab merge requests, main side. glabCall() runs one `glab api -i` call
// through gitlab-repo.js and glabJson() parses its output (status line, headers, blank line, JSON body); `gitlab-mrs` lists
// the open MRs of the repo behind a panel target (R4), `gitlab-mr` loads one MR for the review view (R5): latest version,
// diffs, discussions, whole or as one `req.part` (deck-mr-ui D3); `gitlab-user` gives the signed-in username per host (D2).
// Host and project come from the repo remote resolved here, never from the renderer (D6).
// Reads are GETs. The only writes (R7) are POSTs, JSON on stdin (D9): `gitlab-submit` posts the confirmed drafts, a line draft as
// a diff discussion, a general draft as a MR note (D17) and a reply draft as a note of its thread, with GitLab quick actions escaped
// in the posted body; `gitlab-approve` approves the shown version. `gitlab-file-raw` reads one file of the repo at a commit, raw
// and untrimmed, for the context expansion of the MR diff (one GET, answered through git-panel's `fileTextAnswer`).
// Requires ipc/gitlab-repo.js, ipc/gitlab-drafts.js and ipc/git-panel.js.
'use strict';

const { ipcMain } = require('electron');
const { gitlabRepoId, folderGitlabRepos, execGlab } = require('./gitlab-repo');
const { listDrafts, removeDraft, setDraftError, DISCUSSION_ID_RE } = require('./gitlab-drafts');
const { fileTextAnswer, FILE_TEXT_CAP } = require('./git-panel');

const PAGE_SIZE = 100;
const MR_PAGES_MAX = 5; // 5 calls stay far under GitLab's 100 requests / minute limit
const DIFF_PAGES_MAX = 30; // 3,000 files = GitLab's own ceiling of diff files per MR (D8)
const DISCUSSION_PAGES_MAX = 30; // 30 of the 100 requests / minute (D8)
const IID_RE = /^[1-9]\d{0,9}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FILE_REF_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // a commit sha, SHA-1 or SHA-256
const MESSAGE_MAX = 300;
const DESCRIPTION_MAX = 4000; // the list rows carry the MR description to the rail: bounded
const NO_REPO_MESSAGE = 'Dépôt GitLab introuvable';
const UNREADABLE_MESSAGE = 'Réponse GitLab illisible';
const BAD_MR_MESSAGE = 'Merge request invalide';
const NO_VERSION_MESSAGE = 'Cette merge request n’a aucune version';
const BAD_IDS_MESSAGE = 'Brouillons invalides';
const BAD_SHA_MESSAGE = 'Version de la merge request invalide';
const BUSY_MESSAGE = 'Un envoi est déjà en cours pour cette merge request';
const STALE_MESSAGE = 'la MR a changé';
const CONFLICT_MESSAGE = 'la MR a changé (409) — rouvre-la';
const UNEXPECTED_MESSAGE = 'Réponse GitLab inattendue';
const UNCERTAIN_MESSAGE = 'peut-être publié — vérifie sur GitLab';
const BAD_THREAD_MESSAGE = 'Fil de discussion invalide';
const BAD_FILE_PATH_MESSAGE = 'Chemin de fichier invalide';
const BAD_FILE_REF_MESSAGE = 'Version du fichier invalide';
const REFUSED_MESSAGE = 'Envoi refusé : le brouillon n’a pas pu être enregistré avant l’envoi';
const POST_ARGS = ['-X', 'POST', '-H', 'Content-Type: application/json', '--input', '-'];

const fail = (status, message) => ({ ok: false, status, message });
const text = (v) => (typeof v === 'string' ? v : '');
const orNull = (v) => (v == null ? null : v);
const isObject = (v) => !!v && typeof v === 'object';

// `glab api -i` stdout -> { status, headers (lower-case names), body } or null. LF or CRLF.
function parseGlabHttp(stdout) {
  const text = String(stdout || '');
  const gap = text.match(/\r?\n\r?\n/);
  const head = gap ? text.slice(0, gap.index) : text;
  const body = gap ? text.slice(gap.index + gap[0].length) : '';
  const lines = head.split(/\r?\n/);
  const status = lines[0].match(/^HTTP\/\S+\s+(\d{3})\b/i);
  if (!status) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(status[1]), headers, body };
}

// GitLab's own words for a failed call: JSON `message`, else `error`, when they are strings.
function gitlabErrorText(bodyText) {
  let json;
  try { json = JSON.parse(bodyText); } catch (_) { return ''; }
  if (!json || typeof json !== 'object') return '';
  const text = typeof json.message === 'string' ? json.message : (typeof json.error === 'string' ? json.error : '');
  return text.trim().slice(0, MESSAGE_MAX);
}

// One `glab api -i` call. `:project` in `endpoint` becomes the URL-encoded project path of the repo remote. A defined
// `opts.payload` makes it a POST of that JSON, sent on stdin (encoding A, D9), never in argv. `opts.raw` keeps the body of a
// 2xx answer untrimmed (a file's text); every other call trims it.
// -> { ok:true, status, headers, body } | { ok:false, status, message[, timedOut:true] } (message never carries raw stderr).
async function glabCall(target, endpoint, opts = {}) {
  const repo = await gitlabRepoId(target);
  if (!repo) return fail(null, NO_REPO_MESSAGE);
  const path = String(endpoint).split(':project').join(encodeURIComponent(repo.project));
  const post = opts.payload !== undefined;
  const args = ['api', '-i', '--hostname', repo.host, ...(post ? POST_ARGS : []), path];
  const run = await execGlab(repo.root, args, { stdin: post ? JSON.stringify(opts.payload) : undefined, timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer });
  if (run.error) return run.timedOut ? { ...fail(null, run.error), timedOut: true } : fail(null, run.error);
  const res = parseGlabHttp(run.stdout);
  if (!res) return fail(null, UNREADABLE_MESSAGE);
  const body = opts.raw === true ? res.body : res.body.trim();
  if (res.status < 200 || res.status > 299) return fail(res.status, gitlabErrorText(body) || `Erreur GitLab (${res.status})`);
  return { ok: true, status: res.status, headers: res.headers, body };
}

// One GET, body parsed as JSON. -> { ok:true, status, headers, data } | the failed glabCall result.
async function glabJson(target, endpoint, opts = {}) {
  const res = await glabCall(target, endpoint, { timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer });
  if (!res.ok) return res;
  let data = null;
  if (res.body) {
    try { data = JSON.parse(res.body); } catch (_) { return fail(res.status, UNREADABLE_MESSAGE); }
  }
  return { ok: true, status: res.status, headers: res.headers, data };
}

// The two write paths of this module: one POST of a JSON payload (R7).
const glabPost = (target, endpoint, payload) => glabCall(target, endpoint, { payload });

// A list endpoint (`endpoint` already holds `?per_page=`), page by page from X-Next-Page (D8). Any failed page fails the
// whole list (D7: no partial list passed off as complete); a next page still announced after `pagesMax` calls, or one that
// does not advance, sets `truncated`. -> { ok:true, items, truncated } | the failed glabJson result.
async function glabPages(target, endpoint, pagesMax) {
  const items = [];
  let page = 1;
  for (let calls = 1; ; calls++) {
    const res = await glabJson(target, page > 1 ? `${endpoint}&page=${page}` : endpoint);
    if (!res.ok) return res;
    if (!Array.isArray(res.data)) return fail(res.status, UNREADABLE_MESSAGE);
    items.push(...res.data);
    const next = res.headers['x-next-page'];
    if (!next) return { ok: true, items, truncated: false };
    const nextPage = /^\d+$/.test(next) ? Number(next) : 0;
    if (nextPage <= page || calls >= pagesMax) return { ok: true, items, truncated: true };
    page = nextPage;
  }
}

const authorName = (author) => (isObject(author) ? String(author.name || author.username || '') : '');

function mapMr(mr) {
  if (!mr || typeof mr !== 'object' || !Number.isInteger(mr.iid)) return null;
  return {
    iid: mr.iid,
    title: String(mr.title == null ? '' : mr.title),
    author: authorName(mr.author),
    username: isObject(mr.author) ? text(mr.author.username) : '',
    updatedAt: text(mr.updated_at),
    notes: Number.isInteger(mr.user_notes_count) ? mr.user_notes_count : null,
    source: String(mr.source_branch == null ? '' : mr.source_branch),
    target: String(mr.target_branch == null ? '' : mr.target_branch),
    draft: mr.draft === true || mr.work_in_progress === true,
    description: text(mr.description).slice(0, DESCRIPTION_MAX),
  };
}

async function listMrs(target) {
  const res = await glabPages(target, `projects/:project/merge_requests?state=opened&per_page=${PAGE_SIZE}`, MR_PAGES_MAX);
  if (!res.ok) return res;
  return { ok: true, mrs: res.items.map(mapMr).filter(Boolean), truncated: res.truncated };
}

// One /diffs entry. A too-large or collapsed file arrives with an empty diff: `diff` is null then, never ''.
function mapDiffFile(raw) {
  if (!isObject(raw)) return null;
  const oldPath = text(raw.old_path);
  const newPath = text(raw.new_path);
  if (!oldPath && !newPath) return null;
  const tooLarge = raw.too_large === true;
  const collapsed = raw.collapsed === true;
  return { oldPath, newPath, diff: !tooLarge && !collapsed && typeof raw.diff === 'string' ? raw.diff : null, tooLarge, collapsed };
}

// D4: the file's status letter from GitLab's own flags. Only the `diffs` part carries it: the no-part body keeps mapDiffFile as is (D3).
function mapDiffFileWithStatus(raw) {
  const file = mapDiffFile(raw);
  if (!file) return null;
  let status = 'M';
  if (raw.deleted_file === true) status = 'D';
  else if (raw.new_file === true) status = 'A';
  else if (raw.renamed_file === true) status = 'R';
  return { oldPath: file.oldPath, newPath: file.newPath, status, diff: file.diff, tooLarge: file.tooLarge, collapsed: file.collapsed };
}

const mapNote = (n) => ({ id: n.id, author: authorName(n.author), body: text(n.body), createdAt: text(n.created_at), resolved: n.resolved === true });

const mapPosition = (p) => ({
  oldPath: orNull(p.old_path), newPath: orNull(p.new_path), oldLine: orNull(p.old_line), newLine: orNull(p.new_line),
  positionType: orNull(p.position_type), baseSha: orNull(p.base_sha), startSha: orNull(p.start_sha), headSha: orNull(p.head_sha),
});

// Discussions -> threads anchored to the diff (the first note holds a position) and general ones. System notes are
// dropped; a discussion left with no note is dropped too.
function splitDiscussions(discussions) {
  const diffThreads = [];
  const general = [];
  for (const d of discussions) {
    if (!isObject(d) || typeof d.id !== 'string' || !d.id || !Array.isArray(d.notes)) continue;
    const notes = d.notes.filter((n) => isObject(n) && n.system !== true);
    if (!notes.length) continue;
    if (isObject(notes[0].position)) diffThreads.push({ id: d.id, position: mapPosition(notes[0].position), notes: notes.map(mapNote) });
    else general.push({ id: d.id, notes: notes.map(mapNote) });
  }
  return { diffThreads, general };
}

// The iid reaches a URL path: a positive integer, or its digits-only string form, nothing else.
function normalizeIid(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : 0;
  return typeof v === 'string' && IID_RE.test(v) ? Number(v) : 0;
}

// `/versions` answer -> { ok:true, latest, shas: [base, start, head] } of versions[0], or the failed result.
function latestVersion(versions) {
  if (!Array.isArray(versions.data)) return fail(versions.status, UNREADABLE_MESSAGE);
  const latest = versions.data[0];
  if (latest === undefined) return fail(versions.status, NO_VERSION_MESSAGE);
  const shas = isObject(latest) ? [latest.base_commit_sha, latest.start_commit_sha, latest.head_commit_sha] : [];
  if (shas.length !== 3 || shas.some((s) => typeof s !== 'string' || !s)) return fail(versions.status, UNREADABLE_MESSAGE);
  return { ok: true, latest, shas };
}

// D2: the signed-in user of a host, kept per host once GitLab answered with a username; a failure is never kept.
const userByHost = new Map();

async function loadUser(target) {
  const repo = await gitlabRepoId(target);
  if (!repo) return { ok: false, message: NO_REPO_MESSAGE };
  if (userByHost.has(repo.host)) return { ok: true, username: userByHost.get(repo.host) };
  const res = await glabJson(target, 'user');
  if (!res.ok) return { ok: false, message: res.message };
  const username = isObject(res.data) ? res.data.username : '';
  if (typeof username !== 'string' || !username) return { ok: false, message: UNREADABLE_MESSAGE };
  userByHost.set(repo.host, username);
  return { ok: true, username };
}

// D3: the three parts of loadMr, each over the same helpers, so the renderer can start them together.
async function loadVersionPart(req, mr) {
  const versions = await glabJson(req, `${mr}/versions`);
  if (!versions.ok) return versions;
  const found = latestVersion(versions);
  if (!found.ok) return found;
  const { latest, shas } = found;
  return { ok: true, version: { id: latest.id, base: shas[0], start: shas[1], head: shas[2] } };
}

async function loadDiffsPart(req, mr) {
  const diffs = await glabPages(req, `${mr}/diffs?per_page=${PAGE_SIZE}`, DIFF_PAGES_MAX);
  if (!diffs.ok) return diffs;
  return { ok: true, files: diffs.items.map(mapDiffFileWithStatus).filter(Boolean), truncated: diffs.truncated };
}

async function loadDiscussionsPart(req, mr) {
  const discussions = await glabPages(req, `${mr}/discussions?per_page=${PAGE_SIZE}`, DISCUSSION_PAGES_MAX);
  if (!discussions.ok) return discussions;
  return { ok: true, ...splitDiscussions(discussions.items), truncated: discussions.truncated };
}

const MR_PARTS = new Map([['version', loadVersionPart], ['diffs', loadDiffsPart], ['discussions', loadDiscussionsPart]]);

// R5: latest version ([0]: base / start / head shas), every changed file, every discussion. Sequential GETs, at most
// 1 + 30 + 30 requests; any failed call fails the whole load, no partial view.
async function loadMr(req) {
  const iid = normalizeIid(req.iid);
  if (!iid) return fail(null, BAD_MR_MESSAGE);
  if (req.part !== undefined) { // a part name is looked up in a Map: no prototype name can dispatch
    const loadPart = MR_PARTS.get(req.part);
    return loadPart ? loadPart(req, `projects/:project/merge_requests/${iid}`) : fail(null, BAD_MR_MESSAGE);
  }
  const mr = `projects/:project/merge_requests/${iid}`;
  const versions = await glabJson(req, `${mr}/versions`);
  if (!versions.ok) return versions;
  const found = latestVersion(versions);
  if (!found.ok) return found;
  const { latest, shas } = found;
  const diffs = await glabPages(req, `${mr}/diffs?per_page=${PAGE_SIZE}`, DIFF_PAGES_MAX);
  if (!diffs.ok) return diffs;
  const discussions = await glabPages(req, `${mr}/discussions?per_page=${PAGE_SIZE}`, DISCUSSION_PAGES_MAX);
  if (!discussions.ok) return discussions;
  return {
    ok: true,
    version: { id: latest.id, base: shas[0], start: shas[1], head: shas[2] },
    files: diffs.items.map(mapDiffFile).filter(Boolean),
    ...splitDiscussions(discussions.items),
    truncated: diffs.truncated || discussions.truncated,
  };
}

// U8: a line whose first non-blank character is `/` runs as a GitLab quick action (`/merge`, `/close`, `/approve`…). Every such line,
// inside or outside a code block (GitLab versions disagree on what a block is), gets a `\` before that `/`, except `//` and `/*` lines.
// GitLab deletes every `\r` before it reads the body, so `\r` counts as blank and the lines end at `\n` only. Applied to the POSTed
// body only: the stored draft keeps the user's text.
function escapeQuickActions(body) {
  return text(body).split('\n').map((l) => l.replace(/^(\s*)\/(?![/*])/, '$1\\/')).join('\n');
}

// D11: added line -> new_line, removed -> old_line, context -> both. A file with a single path (added / deleted)
// repeats it, GitLab wants both paths on a text position.
function discussionPayload(d, [base, start, head]) {
  const position = {
    position_type: 'text', base_sha: base, start_sha: start, head_sha: head,
    old_path: d.path.old || d.path.new, new_path: d.path.new || d.path.old,
  };
  if (d.kind !== 'add') position.old_line = d.oldLine;
  if (d.kind !== 'del') position.new_line = d.newLine;
  return { body: escapeQuickActions(d.body), position };
}

const sendError = (res) => (res.status ? `${res.status} ${res.message}` : res.message);

const uncertainResult = (id, error) => ({ id, ok: false, uncertain: true, error });

// A DEFINITE send failure (GitLab answered, or glab failed to run): the row keeps the reason, loses any `uncertain` mark and the
// next send may post it.
async function failDraft(target, iid, id, error) {
  await setDraftError(target, iid, id, error, false);
  return { id, ok: false, error };
}

// A POST glab ran but that left no HTTP status (non-zero exit, nothing readable on stdout): the request may have reached GitLab.
const unreadableAnswer = (res) => !res.ok && res.status == null && res.message === UNREADABLE_MESSAGE;

// The one write of a draft: a reply is a note of its thread, a general draft a note of the MR, a line draft a new diff discussion.
function postDraft(target, mr, d, shas) {
  if (d.kind === 'reply') return glabPost(target, `${mr}/discussions/${d.discussionId}/notes`, { body: escapeQuickActions(d.body) });
  if (d.kind === 'general') return glabPost(target, `${mr}/notes`, { body: escapeQuickActions(d.body) });
  return glabPost(target, `${mr}/discussions`, discussionPayload(d, shas));
}

// Posts one draft, write-ahead (R7): the row is stored `uncertain` BEFORE the POST, so a crash mid-POST leaves it never resent, and
// no POST is made when that mark cannot be saved. After the POST: 201 removes the row (a failed removal leaves it uncertain); a
// timeout or an unreadable answer leaves the mark; only a DEFINITE failure (GitLab answered with a status, or glab failed to run:
// no repo, spawn error) clears it. A general draft (D17) and a reply draft (a note of its thread, D3) have no position: no stale
// check, and any 2xx but 201 may have created the note, so it keeps the mark like a timeout and is never resent. A stored reply
// whose discussion id fails the check (hand-edited store: the id reaches a URL path) is a definite failure before any mark or POST.
async function sendDraft(target, iid, d, shas) {
  const isNote = d.kind === 'general' || d.kind === 'reply';
  if (d.kind === 'reply' && !(typeof d.discussionId === 'string' && DISCUSSION_ID_RE.test(d.discussionId))) return failDraft(target, iid, d.id, BAD_THREAD_MESSAGE);
  if (!isNote && (d.version.base !== shas[0] || d.version.start !== shas[1] || d.version.head !== shas[2])) return failDraft(target, iid, d.id, STALE_MESSAGE);
  const marked = await setDraftError(target, iid, d.id, UNCERTAIN_MESSAGE, true);
  if (!(marked.ok && marked.updated)) return { id: d.id, ok: false, error: REFUSED_MESSAGE };
  const res = await postDraft(target, `projects/:project/merge_requests/${iid}`, d, shas);
  if (res.timedOut || unreadableAnswer(res)) return uncertainResult(d.id, UNCERTAIN_MESSAGE);
  if (res.ok && res.status === 201) return { id: d.id, ok: true, removed: (await removeDraft(target, iid, d.id)).ok === true };
  if (res.ok && isNote) return uncertainResult(d.id, UNCERTAIN_MESSAGE);
  return failDraft(target, iid, d.id, res.ok ? `${res.status} ${UNEXPECTED_MESSAGE}` : sendError(res));
}

// R7: the drafts of `ids` still in the store, in the order of `ids`, against versions[0]. Per-id results; a failed draft
// stays in the store with its error and the next ones go on. An uncertain draft is reported as such and never posted while its mark is stored.
async function sendDrafts(target, iid, ids) {
  const listed = await listDrafts(target, iid);
  if (!listed.ok) return listed;
  const byId = new Map(listed.drafts.map((d) => [d.id, d]));
  const wanted = [...new Set(ids)].filter((id) => byId.has(id)).map((id) => byId.get(id));
  if (!wanted.length) return { ok: true, results: [] };
  let shas = null; // only a line post needs the versions: a send of uncertain, general or reply drafts alone makes no versions call
  if (wanted.some((d) => !d.uncertain && d.kind !== 'general' && d.kind !== 'reply')) {
    const versions = await glabJson(target, `projects/:project/merge_requests/${iid}/versions`);
    if (!versions.ok) return versions;
    const found = latestVersion(versions);
    if (!found.ok) return found;
    shas = found.shas;
  }
  const results = [];
  for (const d of wanted) results.push(d.uncertain ? uncertainResult(d.id, d.error || UNCERTAIN_MESSAGE) : await sendDraft(target, iid, d, shas));
  return { ok: true, results };
}

const submitting = new Set(); // `host|project|iid` of the sends running now

async function submitReview(req) {
  const iid = normalizeIid(req.iid);
  if (!iid) return fail(null, BAD_MR_MESSAGE);
  if (!Array.isArray(req.ids) || req.ids.some((id) => typeof id !== 'string')) return fail(null, BAD_IDS_MESSAGE);
  const repo = await gitlabRepoId(req.target);
  if (!repo) return fail(null, NO_REPO_MESSAGE);
  const key = `${repo.host}|${repo.project}|${iid}`;
  if (submitting.has(key)) return fail(null, BUSY_MESSAGE);
  submitting.add(key);
  try { return await sendDrafts(req.target, iid, req.ids); } finally { submitting.delete(key); }
}

// D13: approves the head SHA the review view showed; GitLab answers 409 when the MR moved on.
async function approveMr(req) {
  const iid = normalizeIid(req.iid);
  if (!iid) return fail(null, BAD_MR_MESSAGE);
  if (typeof req.headSha !== 'string' || !SHA_RE.test(req.headSha)) return fail(null, BAD_SHA_MESSAGE);
  const res = await glabPost(req.target, `projects/:project/merge_requests/${iid}/approve`, { sha: req.headSha });
  if (res.ok) return { ok: true, status: res.status };
  return res.status === 409 ? fail(409, CONFLICT_MESSAGE) : res;
}

// A repository path: non-empty, no NUL, not absolute, no `..` segment.
const validFilePath = (p) => typeof p === 'string' && p !== '' && !p.includes('\0') && !p.startsWith('/') && !p.split('/').includes('..');

// One file at a commit, raw. The whole path is URL-encoded (`/ ? # :` too), so no glab placeholder can fire; the project comes
// from the repo remote, never from `req`. A body just over the cap still reaches fileTextAnswer (`capped`); a larger one
// overflows the buffer and fails as an error answer. -> { ok, text, capped, binary } | { ok:false, status, message }.
async function loadFileRaw(req) {
  if (!validFilePath(req.path)) return fail(null, BAD_FILE_PATH_MESSAGE);
  if (typeof req.ref !== 'string' || !FILE_REF_RE.test(req.ref)) return fail(null, BAD_FILE_REF_MESSAGE);
  const endpoint = `projects/:project/repository/files/${encodeURIComponent(req.path)}/raw?ref=${req.ref}`;
  const res = await glabCall(req, endpoint, { raw: true, maxBuffer: FILE_TEXT_CAP + 1024 * 1024 });
  return res.ok ? fileTextAnswer(res.body) : res;
}

function registerGitlabIpc() {
  ipcMain.handle('gitlab-mrs', async (_e, target = {}) => listMrs(target));
  ipcMain.handle('gitlab-folder-repos', async (_e, target) => {
    try { return { ok: true, repos: await folderGitlabRepos(isObject(target) ? target : {}) }; } catch (_) { return { ok: false }; }
  });
  ipcMain.handle('gitlab-mr', async (_e, req) => loadMr(isObject(req) ? req : {}));
  ipcMain.handle('gitlab-user', async (_e, target) => loadUser(isObject(target) ? target : {}));
  ipcMain.handle('gitlab-submit', async (_e, req) => submitReview(isObject(req) ? req : {}));
  ipcMain.handle('gitlab-approve', async (_e, req) => approveMr(isObject(req) ? req : {}));
  ipcMain.handle('gitlab-file-raw', async (_e, req) => loadFileRaw(isObject(req) ? req : {}));
}

module.exports = { registerGitlabIpc, glabJson, parseGlabHttp };
