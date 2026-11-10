// claude-deck — ipc/gitlab-repo: leaf of the MR-review graph. Repo identity (root + host + project path
// from the git remotes) and the one way main runs glab. Requires ipc/git-panel.js for resolveGitCwd, so it
// sits in ipc/ and is required by gitlab.js / gitlab-drafts.js, never the reverse. glab holds the user's
// credentials: execFile only, inherited environment, no argv or file ever carries a credential.
'use strict';

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const { simpleGit } = require('simple-git');
const config = require('../config');
const { resolveGitCwd } = require('./git-panel');

const GLAB_TIMEOUT_MS = config.GLAB_TIMEOUT_MS;
// One /diffs page: 100 files x GitLab's 200 KB max patch, plus JSON escaping.
const GLAB_MAX_BUFFER = 32 * 1024 * 1024;
const OVERFLOW_MESSAGE = 'Réponse GitLab trop volumineuse — affichage impossible';

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const URL_PROTOCOLS = new Set(['ssh', 'git', 'git+ssh', 'ssh+git', 'http', 'https']);

function cleanProject(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch (_) { return null; }
  p = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const segments = p.split('/');
  if (segments.length < 2 || !segments.every((s) => SEGMENT_RE.test(s))) return null;
  return segments.join('/');
}

// ssh (scp-like or ssh://) and http(s) remotes -> { host, project } or null. The API host keeps an http(s)
// port but drops an ssh port; subgroups stay in the project path.
function parseRemoteUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  let host;
  let rawPath;
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!URL_PROTOCOLS.has(proto)) return null;
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    host = proto.startsWith('http') ? u.host : u.hostname;
    rawPath = u.pathname;
  } else {
    const m = url.match(/^(?:[^@/:\s]+@)?([^@:/\s]+):(.+)$/);
    if (!m) return null;
    host = m[1];
    rawPath = m[2];
  }
  host = host.toLowerCase();
  const project = HOST_RE.test(host) ? cleanProject(rawPath) : null;
  return project ? { host, project } : null;
}

// { root, host, project } of the repo containing `cwd` (origin first, then the first remote), else null.
async function repoIdAt(cwd) {
  try {
    const git = simpleGit({ baseDir: cwd });
    const root = (await git.revparse(['--show-toplevel'])).trim();
    const remotes = await git.getRemotes(true);
    for (const r of [remotes.find((x) => x.name === 'origin'), remotes[0]]) {
      const id = r && parseRemoteUrl(r.refs.fetch || r.refs.push);
      if (id) return { root, host: id.host, project: id.project };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// The ONE predicate behind the folder listing and the `subRepo` resolution, so the two cannot diverge. `name` must
// be an entry of `baseReal` (exact match: '', '.', '..', a slash, an absolute path are never entries), hold a `.git`,
// resolve (realpath) directly under `baseReal`, and be the root of a repo whose remote is a GitLab host.
// `entries` (optional) = the readdir the caller already holds. -> { name, root } | null.
async function gitlabChildAt(baseReal, name, entries) {
  try {
    if (typeof name !== 'string') return null;
    if (!(entries || await fsp.readdir(baseReal)).includes(name)) return null;
    const child = path.join(baseReal, name);
    await fsp.stat(path.join(child, '.git'));
    const childReal = await fsp.realpath(child);
    if (path.dirname(childReal) !== baseReal) return null;
    const id = await repoIdAt(childReal);
    if (!id || await fsp.realpath(id.root) !== childReal) return null;
    return { name, root: childReal };
  } catch (_) {
    return null;
  }
}

// Realpath of the session folder when it is NOT inside a repository (the only state where the listing exists), else
// null. Same `resolveGitCwd` as the status view, the `subRepo` key ignored.
async function folderBase(target) {
  try {
    const cwd = await resolveGitCwd({ ...target, subRepo: undefined });
    if (!cwd) return null;
    const baseReal = await fsp.realpath(cwd);
    try {
      await simpleGit({ baseDir: baseReal }).revparse(['--show-toplevel']);
      return null;
    } catch (_) {
      return baseReal;
    }
  } catch (_) {
    return null;
  }
}

// Names of the GitLab repos ONE level under the session folder, sorted; [] outside the not-a-repo state.
async function folderGitlabRepos(target) {
  try {
    const base = await folderBase(target);
    if (!base) return [];
    const entries = await fsp.readdir(base);
    const found = await Promise.all(entries.map((name) => gitlabChildAt(base, name, entries)));
    return found.filter(Boolean).map((c) => c.name).sort();
  } catch (_) {
    return [];
  }
}

// { root, host, project } of the repo behind a panel target, else null. A target that OWNS a `subRepo` key (the
// folder choice) is resolved by name against the folder listing and never falls back to the session folder.
async function gitlabRepoId(target) {
  try {
    if (target && Object.hasOwn(target, 'subRepo')) {
      const base = await folderBase(target);
      const child = base && await gitlabChildAt(base, target.subRepo);
      return child ? await repoIdAt(child.root) : null;
    }
    const cwd = await resolveGitCwd(target || {});
    return cwd ? await repoIdAt(cwd) : null;
  } catch (_) {
    return null;
  }
}

function timeoutMessage(timeoutMs) {
  const seconds = String(Math.round(timeoutMs / 100) / 10).replace('.', ',');
  return `GitLab ne répond pas (délai de ${seconds} s dépassé)`;
}

// Runs glab in `root`. Always resolves { code, stdout, stderr, error }: a non-zero exit keeps its code and
// stderr with error null; a timeout, an overflow or a spawn failure sets error (stdout is then empty). A timeout also
// sets timedOut: true: the killed call may already have reached GitLab.
function execGlab(root, args, { stdin, timeoutMs = GLAB_TIMEOUT_MS, maxBuffer = GLAB_MAX_BUFFER } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(config.GLAB_BIN || 'glab', args, { cwd: root, timeout: timeoutMs, maxBuffer, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, error: null });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, stdout: '', stderr: '', error: OVERFLOW_MESSAGE });
        if (err.killed) return resolve({ code: null, stdout: '', stderr: '', error: timeoutMessage(timeoutMs), timedOut: true });
        if (typeof err.code === 'number') return resolve({ code: err.code, stdout, stderr, error: null });
        return resolve({ code: null, stdout: '', stderr: stderr || '', error: err.message });
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err.message });
      return;
    }
    child.stdin.on('error', () => { /* the child exited before reading its input */ });
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  });
}

module.exports = { gitlabRepoId, folderGitlabRepos, execGlab, parseRemoteUrl, timeoutMessage, GLAB_TIMEOUT_MS, GLAB_MAX_BUFFER };
