// claude-deck — ipc/git-panel (v39): read-only git state of the ACTIVE
// SESSION's workspace. Data layer per the feature spec: rev-parse guard ->
// empty state on non-repos; simple-git for status/branch/ahead-behind/
// numstat; diffs are LAZY (one file per IPC call, on click) with a
// hunk-aligned line cap so a lockfile can never freeze the renderer. The
// session cwd comes from the ptys registry (set at spawn) — NEVER from the
// renderer. The renderer addresses repos by INDEX into main's cached list:
// ids in, paths never cross the IPC boundary in either direction.
'use strict';

const { ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { simpleGit } = require('simple-git');
const { ptys } = require('../state');
const { findSessionFile } = require('../transcripts');
const { readSessionMeta } = require('../session-meta');
const { sessionTouchedRepos, effectiveSessionId } = require('../session-activity');
const { pickWorktreeView, worktreeDefaultBase } = require('../git-worktree-view');

const GIT_DIFF_CAP_LINES = 1500;

// v53 open-with chooser — the user picks the editor per click (no per-extension
// routing). Registry of GUI editors with candidate launcher names; only those
// resolvable on PATH are offered to the renderer, plus an always-present
// "system default" (shell.openPath). Detection is cached for the process life.
const EDITOR_DEFS = [
  { id: 'idea', label: 'IntelliJ IDEA', bins: ['intellij-idea-ultimate', 'idea-ultimate', 'idea'] },
  { id: 'pycharm', label: 'PyCharm', bins: ['pycharm', 'pycharm-professional', 'pycharm-community'] },
  { id: 'code', label: 'VS Code', bins: ['code', 'codium'] },
];

// PATH scan for an executable — no shell, no `which` spawn (injection surface):
// just stat each PATH dir. An absolute candidate is taken as-is.
function resolveBin(name) {
  if (name.includes('/')) {
    try { fs.accessSync(name, fs.constants.X_OK); return name; } catch (_) { return null; }
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next dir */ }
  }
  return null;
}

let editorsCache = null;
function availableEditors() {
  if (editorsCache) return editorsCache;
  editorsCache = [];
  for (const def of EDITOR_DEFS) {
    let cmd = null;
    for (const b of def.bins) { cmd = resolveBin(b); if (cmd) break; }
    if (cmd) editorsCache.push({ id: def.id, label: def.label, cmd });
  }
  // Probe seam (same family as CLAUDE_DECK_NO_OPEN/_BIN): a deterministic
  // editor whose launcher is a test script, so the LIVE spawn path can be
  // exercised without a real IDE (the dry-run seam never reaches spawn).
  if (process.env.CLAUDE_DECK_FAKE_EDITOR) {
    editorsCache.push({ id: 'fake', label: 'Fake Editor', cmd: process.env.CLAUDE_DECK_FAKE_EDITOR });
  }
  return editorsCache;
}

function paneCwd(paneId) {
  const entry = ptys.get(String(paneId || ''));
  return entry && entry.cwd ? entry.cwd : null;
}

async function resolveGitCwd(target = {}) {
  const sessionId = effectiveSessionId(target);
  // Session-touched repo, addressed by index into the cached list.
  if (sessionId && Number.isInteger(target.repoIndex)) {
    const repos = await sessionTouchedRepos(sessionId);
    const r = repos[target.repoIndex];
    if (r) return r.root;
  }
  // Fallback: the session's plain workspace cwd (pane registry at spawn,
  // else the cwd recorded inside the session's own .jsonl).
  let cwd = paneCwd(target.paneId);
  if (!cwd && sessionId) {
    const file = findSessionFile(sessionId);
    if (file) {
      try {
        const meta = await readSessionMeta(file, (await fsp.stat(file)).size);
        if (meta && meta.cwd) cwd = meta.cwd;
      } catch (_) { /* fall through -> null */ }
    }
  }
  return cwd || null;
}

// Base-branch comparison (B29). Only names this listing returns are accepted as
// a base, so a renderer string never reaches git as an option.
const DEFAULT_BASES = ['develop', 'origin/develop', 'main', 'origin/main'];

async function readBranches(git) {
  const out = await git.raw(['for-each-ref', '--format=%(HEAD)|%(refname)', 'refs/heads', 'refs/remotes/origin']);
  let current = null;
  const local = [];
  const remote = [];
  for (const line of out.split('\n')) {
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const ref = line.slice(bar + 1).trim();
    if (ref.startsWith('refs/heads/')) {
      local.push(ref.slice('refs/heads/'.length));
      if (line.slice(0, bar).trim() === '*') current = local[local.length - 1];
    } else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
      remote.push(ref.slice('refs/remotes/'.length));
    }
  }
  const refs = new Map();
  for (const n of local) refs.set(n, `refs/heads/${n}`);
  for (const n of remote) if (!refs.has(n)) refs.set(n, `refs/remotes/${n}`);
  const branches = [
    ...local.map((name) => ({ name, remote: false })),
    ...remote.filter((n) => !local.includes(n.slice('origin/'.length))).map((name) => ({ name, remote: true })),
  ];
  return { current, branches, refs, defaultBase: DEFAULT_BASES.find((n) => refs.has(n)) || null };
}

const wantBase = (b) => (b === undefined || b === null || b === '' ? null : b);

async function resolveBase(git, base) {
  const ref = (await readBranches(git)).refs.get(base);
  if (!ref) return { ok: false, reason: 'base' };
  try {
    return { ok: true, base, mergeBase: (await git.raw(['merge-base', ref, 'HEAD'])).trim() };
  } catch (_) {
    return { ok: false, reason: 'merge-base' };
  }
}

// Tracked files that differ between the merge-base and the working tree
// (committed + staged + unstaged), renames split into D + A so a per-file diff matches.
async function changedSince(git, mergeBase) {
  const args = ['--no-optional-locks', 'diff', '--no-renames', '-z'];
  const [names, nums] = await Promise.all([
    git.raw([...args, '--name-status', mergeBase, '--']),
    git.raw([...args, '--numstat', mergeBase, '--']),
  ]);
  const counts = new Map();
  for (const rec of nums.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (m) counts.set(m[3], m[1] === '-' ? null : { adds: Number(m[1]), dels: Number(m[2]) });
  }
  const tok = names.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < tok.length; i += 2) {
    files.push({ path: tok[i + 1], glyph: tok[i][0], pills: counts.get(tok[i + 1]) || null });
  }
  return files;
}

// Task-branch view of the selected repo entry (a one-repo session is entered straight), or null:
// every caller then keeps today's code path.
async function worktreeViewFor(target, reposIn) {
  const sessionId = effectiveSessionId(target);
  if (!sessionId) return null;
  const repos = reposIn || await sessionTouchedRepos(sessionId);
  const entry = repos[Number.isInteger(target.repoIndex) ? target.repoIndex : repos.length === 1 ? 0 : -1];
  if (!entry || !entry.worktrees?.length) return null;
  try {
    const view = await pickWorktreeView(entry.root, entry.worktrees);
    return view && { ...view, repo: path.basename(entry.root) };
  } catch (_) {
    return null;
  }
}

const sumPills = (files) => files.reduce((s, f) => (f.pills
  ? { adds: s.adds + f.pills.adds, dels: s.dels + f.pills.dels } : s), { adds: 0, dels: 0 });

// A lot = its own commits not yet in the head branch + uncommitted + untracked, compared in the lot root.
async function lotStatus(lot, headBranch) {
  const git = simpleGit({ baseDir: lot.root });
  const cmp = await resolveBase(git, headBranch);
  if (!cmp.ok) return null; // unknown state renders as nothing
  const [files, st] = await Promise.all([changedSince(git, cmp.mergeBase), git.status()]);
  const untracked = st.files.filter((f) => f.index === '?' || f.working_dir === '?')
    .map((f) => ({ path: f.path, glyph: '?' }));
  return { id: lot.id, name: path.basename(lot.root), branch: lot.branch, base: headBranch,
    files, untracked, totals: sumPills(files) };
}

// Head part (today's compare / local payload, run in the head root) + the lots.
async function addLots(view, payload) {
  const lots = (await Promise.all(view.lots.map((l) => lotStatus(l, view.head.branch)))).filter(Boolean);
  const totals = lots.reduce((s, l) => ({ adds: s.adds + l.totals.adds, dels: s.dels + l.totals.dels }), payload.totals);
  return { ...payload, repo: view.repo, totals,
    clean: payload.clean && lots.every((l) => l.files.length + l.untracked.length === 0),
    worktree: { head: { id: '', name: path.basename(view.head.root), branch: view.head.branch }, lots } };
}

const isWtSet = (wt) => wt !== undefined && wt !== null && wt !== '';

// Root of a worktree-view row: ''/absent -> the head, a lot id -> that lot, anything else -> null.
function wtRootIn(view, wt) {
  if (!isWtSet(wt)) return view.head.root;
  const lot = typeof wt === 'string' ? view.lots.find((l) => l.id === wt) : null;
  return lot ? lot.root : null;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REF_KINDS = new Set(['local', 'remote', 'tag', 'head']);
const REFS_FORMAT = '%(objectname)%09%(*objectname)%09%(HEAD)%09%(refname)%09%(upstream)%09%(objecttype)%09%(*objecttype)';
const NO_HISTORY_TYPES = new Set(['tree', 'blob']); // a tag whose own or peeled object is one of these shows no commits
const LOG_FORMAT = '--format=%H%x00%P%x00%aI%x00%an%x00%s';
const LOG_PAGE_SIZE = 50;
const LOG_PAGE_MAX = 1000;
const NO_LOCKS = '--no-optional-locks';

// Every ref of the log feature, with its FULL refname, sha and (local only) upstream. A renderer ref is only a
// KEY into this listing (`local:`, `remote:`, `tag:`), so git always receives the full refname from here.
async function readRefs(git) {
  const out = await git.raw([NO_LOCKS, 'for-each-ref', `--format=${REFS_FORMAT}`,
    'refs/heads', 'refs/remotes/origin', 'refs/tags']);
  const refs = new Map();
  let headBranch = null;
  for (const line of out.split('\n')) {
    const f = line.split('\t'); // refnames hold no byte below \040 (git-check-ref-format), so no field holds a TAB
    if (f.length < 4) continue;
    const full = f[3];
    const sha = f[1] || f[0]; // an annotated tag lists its peeled object second (one level: a tag log peels again)
    let kind;
    let name;
    if (full.startsWith('refs/heads/')) { kind = 'local'; name = full.slice('refs/heads/'.length); }
    else if (full.startsWith('refs/remotes/origin/') && full !== 'refs/remotes/origin/HEAD') {
      kind = 'remote'; name = full.slice('refs/remotes/'.length);
    } else if (full.startsWith('refs/tags/')) { kind = 'tag'; name = full.slice('refs/tags/'.length); }
    else continue;
    if (!SHA_RE.test(sha)) continue;
    if (kind === 'tag' && (NO_HISTORY_TYPES.has(f[5]) || NO_HISTORY_TYPES.has(f[6]))) continue;
    if (kind === 'local' && f[2] === '*') headBranch = name;
    refs.set(`${kind}:${name}`, { kind, name, full, sha, upstream: kind === 'local' ? (f[4] || '') : null, gone: false });
  }
  for (const e of refs.values()) {
    if (e.kind !== 'local') continue;
    const set = e.upstream.startsWith('refs/remotes/origin/') ? e.upstream.slice('refs/remotes/'.length) : null;
    const up = set || `origin/${e.name}`;
    e.upstream = refs.has(`remote:${up}`) ? up : null;
    e.gone = !!set && e.upstream === null; // configured under origin but not listed: unknown, never « never pushed »
  }
  const has = (kind, n) => refs.has(`${kind}:${n}`);
  const family = ['develop', 'main'].find((n) => has('local', n) || has('remote', `origin/${n}`)) || null;
  const trunk = { family, local: family && has('local', family) ? family : null,
    origin: family && has('remote', `origin/${family}`) ? `origin/${family}` : null };
  return { refs, headBranch, trunk };
}

// The listed entry a renderer ref names, or null. 'head' follows the checked-out branch (a detached HEAD is the
// literal HEAD); any other kind needs a string name that is listed and does not start with '-'.
function resolveRef(list, ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !REF_KINDS.has(ref.kind)) return null;
  if (ref.kind === 'head') {
    return (list.headBranch && list.refs.get(`local:${list.headBranch}`))
      || { kind: 'head', name: 'HEAD', full: 'HEAD', sha: null, upstream: null };
  }
  if (typeof ref.name !== 'string' || ref.name === '' || ref.name.startsWith('-')) return null;
  return list.refs.get(`${ref.kind}:${ref.name}`) || null;
}

async function revCount(git, tips) {
  const out = (await git.raw([NO_LOCKS, 'rev-list', '--count', '--first-parent', ...tips, '--'])).trim();
  if (!/^\d+$/.test(out)) throw new Error('count');
  return Number(out);
}

// Rows are NUL-separated fixed groups of 5; author and subject are user text, so each group is checked.
async function logRows(git, tips, skip, take) {
  const out = await git.raw([NO_LOCKS, 'log', '-z', '--first-parent', '--no-show-signature',
    `--skip=${skip}`, `--max-count=${take}`, LOG_FORMAT, ...tips, '--']);
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 5 !== 0) throw new Error('log-rows');
  const rows = [];
  for (let i = 0; i < fields.length; i += 5) {
    const [sha, parents, date, author, subject] = fields.slice(i, i + 5);
    const ps = parents === '' ? [] : parents.split(' ');
    if (!SHA_RE.test(sha) || !ps.every((p) => SHA_RE.test(p))) throw new Error('log-rows');
    rows.push({ sha, parents: ps, author, date, subject });
  }
  return rows;
}

async function mergeBaseOf(git, a, b) {
  try {
    const sha = (await git.raw([NO_LOCKS, 'merge-base', a, b])).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch (_) {
    return null; // exit 1 = no common ancestor
  }
}

function logState(list, entry, originE) {
  if (entry.kind !== 'local') return null;
  if (entry.name === list.trunk.local && originE) return entry.sha === originE.sha ? 'trunk-level' : 'trunk-behind';
  if (entry.gone) return null;
  if (!entry.upstream) return 'never';
  return list.refs.get(`remote:${entry.upstream}`).sha === entry.sha ? 'level' : 'diverged';
}

// One page of the log of a listed ref: the segments of the contract table, sliced by page from counts that stay here.
async function readLog(git, list, entry, page) {
  const { refs, trunk } = list;
  let sha = entry.sha;
  if (entry.kind === 'tag') { // the listing peels one level only (git < 2.44): a nested tag shows its final commit
    sha = await git.raw([NO_LOCKS, 'rev-parse', '--verify', '--quiet', `${entry.full}^{commit}`]).then((s) => s.trim(), () => '');
    if (!SHA_RE.test(sha)) return { ok: false, reason: 'ref' };
  } else if (!sha) sha = (await git.raw([NO_LOCKS, 'rev-parse', 'HEAD'])).trim();
  if (!SHA_RE.test(sha)) throw new Error('sha');
  const localE = trunk.local ? refs.get(`local:${trunk.local}`) : null;
  const originE = trunk.origin ? refs.get(`remote:${trunk.origin}`) : null;
  const targetE = originE || localE;
  const onTrunkLocal = entry.kind === 'local' && entry.name === trunk.local;
  const onTrunkOrigin = entry.kind === 'remote' && entry.name === trunk.origin;
  let view = 'single';
  let mergeBase = null;
  let segs = [{ seg: 'branch', tips: [entry.full] }];
  if (onTrunkLocal && originE) {
    view = 'trunk';
    segs = [{ seg: 'incoming', tips: [originE.full, `^${entry.full}`] }, { seg: 'shared', tips: [entry.full] }];
  } else if (onTrunkLocal || onTrunkOrigin) {
    view = 'trunk';
    segs = [{ seg: 'shared', tips: [entry.full] }];
  } else if (targetE) {
    mergeBase = await mergeBaseOf(git, targetE.full, entry.full);
    if (mergeBase) {
      view = 'branch';
      segs = [{ seg: 'trunk-only', tips: [targetE.full, `^${entry.full}`] },
        { seg: 'branch', tips: [entry.full, `^${targetE.full}`] }, { seg: 'shared', tips: [mergeBase] }];
    }
  }
  const lens = await Promise.all(segs.map((s) => revCount(git, s.tips)));
  const lo = page * LOG_PAGE_SIZE;
  const hi = lo + LOG_PAGE_SIZE;
  let before = 0;
  const slices = [];
  segs.forEach((s, i) => {
    const from = Math.max(lo - before, 0);
    const to = Math.min(hi - before, lens[i]);
    if (to > from) slices.push({ seg: s.seg, tips: s.tips, from, to });
    before += lens[i];
  });
  const parts = await Promise.all(slices.map((s) => logRows(git, s.tips, s.from, s.to - s.from)));
  const rows = parts.flatMap((rs, i) => rs.map((r) => ({ ...r, seg: slices[i].seg })));
  const trunkOnly = rows.filter((r) => r.seg === 'trunk-only');
  if (trunkOnly.length) {
    const outside = localE
      ? new Set((await git.raw([NO_LOCKS, 'rev-list', targetE.full, `^${entry.full}`, `^${localE.full}`, '--'])).split('\n'))
      : null;
    for (const r of trunkOnly) r.inLocal = !!outside && !outside.has(r.sha);
  }
  const shown = new Set(rows.map((r) => r.sha));
  const chips = {};
  const chip = (s, kind, text) => { if (shown.has(s)) (chips[s] = chips[s] || []).push({ kind, text }); };
  chip(sha, 'branch', entry.name);
  if (entry.kind === 'local' && entry.upstream) chip(refs.get(`remote:${entry.upstream}`).sha, 'origin', 'origin');
  if (localE) chip(localE.sha, 'develop', trunk.local);
  if (originE) chip(originE.sha, 'origin-develop', trunk.origin);
  return { ok: true, ref: { kind: entry.kind, name: entry.name, sha },
    isHead: entry.kind === 'head' || (entry.kind === 'local' && entry.name === list.headBranch),
    view, target: view === 'single' ? null : targetE.name, mergeBase, rows, more: before > hi, chips,
    state: logState(list, entry, originE) };
}

// Toplevel of the root the log reads, resolved as git-panel-branches does; null = no target or not a repo.
async function logRootOf(target) {
  try {
    const view = await worktreeViewFor(target);
    const cwd = view ? view.head.root : await resolveGitCwd(target);
    return cwd ? (await simpleGit({ baseDir: cwd }).revparse(['--show-toplevel'])).trim() : null;
  } catch (_) {
    return null;
  }
}

// The answer of both diff handlers: the binary marker first, then the line cap cut on a hunk boundary.
function diffTail(text, full) {
  // Both binary markers are ^-anchored on purpose: every CONTENT line of a
  // text hunk carries a +/-/space prefix, so only real git META lines can
  // match at column 0. An unanchored includes() would misclassify any text
  // diff that merely CONTAINS the marker string (e.g. docs about git).
  if (/^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text)) {
    return { ok: true, binary: true };
  }
  const lines = text.split('\n');
  const totalLines = lines.length;
  if (!full && totalLines > GIT_DIFF_CAP_LINES) {
    // Cut on a hunk boundary — a mid-hunk truncation can break the parser.
    let cut = GIT_DIFF_CAP_LINES;
    while (cut > 0 && !/^(@@|diff --git)/.test(lines[cut])) cut--;
    if (cut === 0) cut = GIT_DIFF_CAP_LINES; // single giant hunk: parser-tolerant cut
    return { ok: true, binary: false, diff: lines.slice(0, cut).join('\n'),
      capped: true, totalLines };
  }
  return { ok: true, binary: false, diff: text, capped: false, totalLines };
}

// One cap for the file text the context-expansion channels serve (decision U1): past it `capped`, never a cut text.
const FILE_TEXT_CAP = 8 * 1024 * 1024;

// `{ok, text, capped, binary}` of a file's raw bytes (Buffer) or text: over the cap or holding a NUL byte it carries no text.
function fileTextAnswer(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (buf.length > FILE_TEXT_CAP) return { ok: true, text: null, capped: true, binary: false };
  if (buf.includes(0)) return { ok: true, text: null, capped: false, binary: true };
  return { ok: true, text: buf.toString('utf8'), capped: false, binary: false };
}

// Root, git handle and base compare of a diff row, shared by git-panel-diff and git-panel-file-at.
// `wt` = a lot id (that lot's root, base forced to the head branch); ''/absent = the head root with the
// renderer base. An id the view does not hold, or any `wt` outside a view, is refused. `badPath` is the caller's
// path verdict, applied after the target is known (the order of the reasons is part of the answers).
async function diffRowSource(target, wt, badPath) {
  const view = await worktreeViewFor(target);
  const hasWt = isWtSet(wt);
  let cwd;
  let forcedBase = null;
  if (view && !hasWt) {
    cwd = view.head.root;
  } else if (view || hasWt) {
    const lot = view && typeof wt === 'string' ? view.lots.find((l) => l.id === wt) : null;
    if (!lot) return { ok: false, reason: 'wt' };
    cwd = lot.root;
    forcedBase = view.head.branch;
  } else {
    cwd = await resolveGitCwd(target);
  }
  if (!cwd) return { ok: false, reason: 'no-target' };
  if (badPath) return { ok: false, reason: 'bad-path' };
  try {
    // Status paths are ROOT-relative — run every diff from the repo root,
    // not from the session cwd (a session opened in a SUBDIR would miss).
    const root = (await simpleGit({ baseDir: cwd }).revparse(['--show-toplevel'])).trim();
    const git = simpleGit({ baseDir: root });
    const base = forcedBase || wantBase(target.base);
    const cmp = base === null ? null : await resolveBase(git, base);
    if (cmp && !cmp.ok) return { ok: false, reason: cmp.reason };
    return { ok: true, root, git, cmp };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// A blob (`<sha>:<file>` or the index entry `:0:<file>`): its size first, the content only under the cap.
async function readBlobText(git, root, rev) {
  let size;
  try {
    size = Number((await git.raw([NO_LOCKS, 'cat-file', '-s', rev])).trim());
  } catch (_) {
    return { ok: false, reason: 'path' };
  }
  if (!Number.isSafeInteger(size)) return { ok: false, reason: 'git' };
  if (size > FILE_TEXT_CAP) return { ok: true, text: null, capped: true, binary: false };
  const buf = await new Promise((resolve) => {
    execFile('git', ['-C', root, NO_LOCKS, 'cat-file', 'blob', rev],
      { encoding: 'buffer', maxBuffer: FILE_TEXT_CAP + 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  return buf ? fileTextAnswer(buf) : { ok: false, reason: 'git' };
}

// A working-tree file of `root`: a symlink leaf or a path whose realpath leaves the root's realpath is refused
// (git refuses such paths, an fs read would follow them), the size is checked before the read.
async function readWorktreeText(root, fp) {
  const abs = path.join(root, fp);
  try {
    if ((await fsp.lstat(abs)).isSymbolicLink()) return { ok: false, reason: 'symlink' };
    const real = await fsp.realpath(abs);
    const rel = path.relative(await fsp.realpath(root), real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, reason: 'symlink' };
    const st = await fsp.stat(real);
    if (!st.isFile()) return { ok: false, reason: 'path' };
    if (st.size > FILE_TEXT_CAP) return { ok: true, text: null, capped: true, binary: false };
    return fileTextAnswer(await fsp.readFile(real));
  } catch (_) {
    return { ok: false, reason: 'path' };
  }
}

const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
// The existing path guard (no absolute path, no parent escape) plus no option-looking name.
const isFileArg = (p) => typeof p === 'string' && p !== '' && !p.startsWith('-') && !path.isAbsolute(p)
  && !p.split(/[\\/]/).includes('..');

// The facts git holds on a validated sha as one NUL-separated record, or null when the object is no commit.
async function readCommit(git, sha) {
  try {
    if ((await git.raw([NO_LOCKS, 'cat-file', '-t', sha])).trim() !== 'commit') return null;
  } catch (_) {
    return null;
  }
  const f = (await git.raw([NO_LOCKS, 'log', '-1', '-z', '--no-show-signature',
    '--format=%P%x00%aI%x00%an%x00%B', sha, '--'])).split('\0');
  const parents = f[0] === '' ? [] : f[0].split(' ');
  if (f.length < 4 || !parents.every((p) => SHA_RE.test(p))) throw new Error('commit');
  return { parents, date: f[1], author: f[2], message: f[3].replace(/\n+$/, '') };
}

// Files of a commit against its first parent (a root commit against the null tree), renames split into D + A.
async function commitFiles(git, sha, parents) {
  const run = (fmt) => git.raw(parents.length
    ? [NO_LOCKS, 'diff', '--no-renames', '-z', fmt, `${sha}^1`, sha, '--']
    : [NO_LOCKS, 'diff-tree', '-r', '--root', '--no-commit-id', '-z', fmt, sha, '--']);
  const [names, nums] = await Promise.all([run('--name-status'), run('--numstat')]);
  const counts = new Map();
  for (const rec of nums.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (m) counts.set(m[3], m[1] === '-' ? null : { add: Number(m[1]), del: Number(m[2]) });
  }
  const tok = names.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < tok.length; i += 2) {
    if (!/^[AMDT]$/.test(tok[i])) continue;
    const c = counts.get(tok[i + 1]);
    files.push({ path: tok[i + 1], status: tok[i], add: c ? c.add : null, del: c ? c.del : null, binary: c === null });
  }
  return files;
}

function registerGitPanelIpc() {
  ipcMain.handle('git-panel-branches', async (_e, target = {}) => {
    const view = await worktreeViewFor(target);
    if (view) {
      try {
        const { branches, refs } = await readBranches(simpleGit({ baseDir: view.head.root }));
        return { ok: true, notRepo: false, current: view.head.branch,
          defaultBase: worktreeDefaultBase(refs), branches, worktreeView: true };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    }
    const cwd = await resolveGitCwd(target);
    if (!cwd) return { ok: false, reason: 'no-target' };
    const git = simpleGit({ baseDir: cwd });
    try {
      await git.revparse(['--show-toplevel']);
    } catch (_) {
      return { ok: true, notRepo: true };
    }
    try {
      const { current, branches, defaultBase } = await readBranches(git);
      return { ok: true, notRepo: false, current, defaultBase, branches };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('git-panel-refs', async (_e, target = {}) => {
    const root = await logRootOf(target);
    if (!root) return { ok: false, reason: 'repo' };
    try {
      const { refs, headBranch, trunk } = await readRefs(simpleGit({ baseDir: root }));
      const listOf = (kind) => [...refs.values()].filter((e) => e.kind === kind);
      return { ok: true, root, repo: path.basename(root), head: { branch: headBranch }, trunk,
        locals: listOf('local').map((e) => ({ name: e.name, head: e.name === headBranch })),
        remotes: listOf('remote').map((e) => ({ name: e.name })), tags: listOf('tag').map((e) => ({ name: e.name })) };
    } catch (_) {
      return { ok: false, reason: 'git' };
    }
  });

  ipcMain.handle('git-panel-log', async (_e, { ref, page, ...target } = {}) => {
    if (!ref || typeof ref !== 'object' || !REF_KINDS.has(ref.kind)) return { ok: false, reason: 'ref' };
    if (ref.kind !== 'head' && (typeof ref.name !== 'string' || ref.name.startsWith('-'))) return { ok: false, reason: 'ref' };
    if (!Number.isInteger(page) || page < 0 || page > LOG_PAGE_MAX) return { ok: false, reason: 'page' };
    const root = await logRootOf(target);
    if (!root) return { ok: false, reason: 'repo' };
    try {
      const git = simpleGit({ baseDir: root });
      const list = await readRefs(git);
      const entry = resolveRef(list, ref);
      return entry ? await readLog(git, list, entry, page) : { ok: false, reason: 'ref' };
    } catch (_) {
      return { ok: false, reason: 'git' };
    }
  });

  ipcMain.handle('git-panel-status', async (_e, target = {}) => {
    // Session truth first: which repos did THIS session actually touch?
    const sessionId = effectiveSessionId(target);
    let sessionRepos = 0;
    let scopeFiles = null; // v55: root-relative paths THIS session wrote (null = unscoped)
    let view = null; // task-branch worktree view of the selected repo (unscoped, head root + lots)
    if (sessionId) {
      const repos = await sessionTouchedRepos(sessionId);
      sessionRepos = repos.length;
      if (!Number.isInteger(target.repoIndex)) {
        if (repos.length > 1) {
          // Multi-project session -> picker of ONLY those projects.
          return { ok: true, repoPicker: true,
            repos: repos.map((r) => ({ name: r.name, count: r.count })) };
        }
        if (repos.length === 1) target = { ...target, repoIndex: 0 }; // straight in
        // 0 touched repos -> fall through to the plain cwd behavior
      }
      // v55 file-level session truth: git.status() returns the WHOLE working
      // tree (every other session's churn — e.g. ~/.claude is shared by ALL
      // sessions). Scope the listing to the exact files THIS session wrote in
      // the resolved repo. repoIndex is settled now (single-repo straight-in
      // or a multi-repo pick).
      if (Number.isInteger(target.repoIndex) && repos[target.repoIndex]) {
        view = await worktreeViewFor(target, repos);
        scopeFiles = view ? null : new Set(repos[target.repoIndex].files || []);
      }
    }
    const cwd = view ? view.head.root : await resolveGitCwd(target);
    if (!cwd) return { ok: false, reason: 'no-target' };
    const git = simpleGit({ baseDir: cwd });
    let root;
    try {
      root = (await git.revparse(['--show-toplevel'])).trim();
    } catch (_) {
      // Not a repo is a STATE, not an error — and with session truth there is
      // no folder enumeration fallback anymore (v39.1's readdir picker was
      // the wrong model: dirty-but-untouched repos are noise).
      return { ok: true, notRepo: true, sessionScoped: !!sessionId };
    }
    try {
      const base = wantBase(target.base);
      const cmp = base === null ? null : await resolveBase(git, base);
      if (cmp && !cmp.ok) return { ok: false, reason: cmp.reason };
      const st = await git.status();
      if (cmp) {
        // Compare mode: merge-base -> working tree, plus untracked as « nouveau ».
        const keep = (pth) => !scopeFiles || scopeFiles.has(pth);
        const files = (await changedSince(git, cmp.mergeBase)).filter((f) => keep(f.path));
        const untrackedNew = st.files
          .filter((f) => f.index === '?' || f.working_dir === '?')
          .map((f) => ({ path: f.path, glyph: '?' }))
          .filter((f) => keep(f.path));
        const sums = { adds: 0, dels: 0 };
        for (const f of files) {
          if (f.pills) { sums.adds += f.pills.adds; sums.dels += f.pills.dels; }
        }
        const out = { ok: true, notRepo: false, repo: path.basename(root), root,
          branch: st.current || '(detached)', tracking: st.tracking || null,
          ahead: st.ahead || 0, behind: st.behind || 0,
          base: cmp.base, mergeBase: cmp.mergeBase, files, untracked: untrackedNew, totals: sums,
          clean: files.length + untrackedNew.length === 0, scoped: !!scopeFiles,
          repoIndex: Number.isInteger(target.repoIndex) ? target.repoIndex : null,
          sessionRepos };
        return view ? await addLots(view, out) : out;
      }
      // Per-file +/- pills: numstat on both sides. Untracked files have no
      // diff against the index — they get a "new" badge renderer-side instead.
      const [unstSum, cachedSum] = await Promise.all([
        git.diffSummary().catch(() => null),
        git.diffSummary(['--cached']).catch(() => null),
      ]);
      const pills = (summary, file) => {
        const f = summary && summary.files.find((x) => x.file === file);
        return f && !f.binary ? { adds: f.insertions, dels: f.deletions } : null;
      };
      const renamedTo = new Map(st.renamed.map((r) => [r.to, r.from]));
      const staged = [];
      const unstaged = [];
      const untracked = [];
      for (const f of st.files) {
        if (f.index === '?' || f.working_dir === '?') {
          untracked.push({ path: f.path, glyph: '?' });
          continue;
        }
        // One physical file can sit in BOTH groups (staged + further edits).
        if (f.index && f.index !== ' ') {
          staged.push({ path: f.path, glyph: f.index,
            from: renamedTo.get(f.path) || null, pills: pills(cachedSum, f.path) });
        }
        if (f.working_dir && f.working_dir !== ' ') {
          unstaged.push({ path: f.path, glyph: f.working_dir,
            pills: pills(unstSum, f.path) });
        }
      }
      // v55: keep only what THIS session wrote. A rename's new path counts,
      // but match the pre-rename name too (it may have been written there).
      let sStaged = staged, sUnstaged = unstaged, sUntracked = untracked;
      if (scopeFiles) {
        const keep = (pth, from) => scopeFiles.has(pth) || (from && scopeFiles.has(from));
        sStaged = staged.filter((f) => keep(f.path, f.from));
        // Attack #1: an unstaged entry on a RENAMED path (staged R old->new,
        // then further edited) carries no `from` — recover its origin from the
        // rename map so a session-written file isn't hidden post-rename.
        sUnstaged = unstaged.filter((f) => keep(f.path, renamedTo.get(f.path)));
        sUntracked = untracked.filter((f) => keep(f.path));
      }
      // Totals/clean reflect the SHOWN files. Post-scope, sum the per-file
      // pills — the whole-repo diffSummary would over-count hidden churn.
      const totals = { adds: 0, dels: 0 };
      for (const f of [...sStaged, ...sUnstaged]) {
        if (f.pills) { totals.adds += f.pills.adds; totals.dels += f.pills.dels; }
      }
      const shown = sStaged.length + sUnstaged.length + sUntracked.length;
      const out = { ok: true, notRepo: false, repo: path.basename(root), root,
        branch: st.current || '(detached)', tracking: st.tracking || null,
        ahead: st.ahead || 0, behind: st.behind || 0,
        staged: sStaged, unstaged: sUnstaged, untracked: sUntracked, totals,
        clean: shown === 0, scoped: !!scopeFiles,
        // v39.2: the renderer adopts the effective index (a 1-repo session is
        // entered straight) and shows the breadcrumb only when a picker exists.
        repoIndex: Number.isInteger(target.repoIndex) ? target.repoIndex : null,
        sessionRepos };
      return view ? await addLots(view, out) : out;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('git-panel-diff', async (_e, { file, kind, full, wt, ...target } = {}) => {
    const fp = String(file || '');
    // The renderer only sends back paths we produced, but stay defensive:
    // no absolute paths, no parent escapes.
    const src = await diffRowSource(target, wt, !fp || path.isAbsolute(fp) || fp.split(/[\\/]/).includes('..'));
    if (!src.ok) return src;
    const { root, git, cmp } = src;
    let text = '';
    try {
      if (kind === 'untracked') {
        // Symlink guard: `--no-index` FOLLOWS symlinks — an in-repo name
        // pointing outside the workspace would render the TARGET's content
        // (host-file disclosure). lstat first; links are named, never read.
        try {
          const lst = fs.lstatSync(path.join(root, fp));
          if (lst.isSymbolicLink()) {
            return { ok: true, binary: false, symlink: true,
              target: fs.readlinkSync(path.join(root, fp)) };
          }
        } catch (_) { /* unreadable -> let git produce the answer */ }
        // `git diff --no-index` exits 1 when files differ — that is SUCCESS
        // here (simple-git would throw on it), so this one call is execFile.
        text = await new Promise((resolve) => {
          execFile('git', ['-C', root, 'diff', '--no-index', '--', '/dev/null', fp],
            { maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout || '')));
        });
      } else if (cmp) {
        text = await git.raw(['--no-optional-locks', 'diff', cmp.mergeBase, '--', fp]);
      } else {
        const args = kind === 'staged' ? ['--cached', '--', fp] : ['--', fp];
        text = await git.diff(args);
      }
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    return diffTail(text, full);
  });

  // The new side of a diff row, as text (context expansion). Input = the diff channels' own args, so main picks
  // the side with the diff's own rule: commit blob | index blob (`staged`, no base compare) | working-tree file.
  ipcMain.handle('git-panel-file-at', async (_e, { file, kind, wt, sha, ...target } = {}) => {
    if (sha !== undefined && sha !== null) {
      if (!isSha(sha)) return { ok: false, reason: 'sha' };
      if (!isFileArg(file)) return { ok: false, reason: 'path' };
      const root = await logRootOf(target);
      if (!root) return { ok: false, reason: 'repo' };
      try {
        const git = simpleGit({ baseDir: root });
        const c = await readCommit(git, sha);
        if (!c) return { ok: false, reason: 'sha' };
        if (!(await commitFiles(git, sha, c.parents)).some((f) => f.path === file)) return { ok: false, reason: 'path' };
        return await readBlobText(git, root, `${sha}:${file}`);
      } catch (_) {
        return { ok: false, reason: 'git' };
      }
    }
    if (kind === 'untracked') return { ok: false, reason: 'untracked' };
    const src = await diffRowSource(target, wt, !isFileArg(file));
    if (!src.ok) return src;
    try {
      return src.cmp || kind !== 'staged'
        ? await readWorktreeText(src.root, file)
        : await readBlobText(src.git, src.root, `:0:${file}`);
    } catch (_) {
      return { ok: false, reason: 'git' };
    }
  });

  ipcMain.handle('git-panel-commit', async (_e, { sha, ...target } = {}) => {
    if (!isSha(sha)) return { ok: false, reason: 'sha' };
    const root = await logRootOf(target);
    if (!root) return { ok: false, reason: 'repo' };
    try {
      const git = simpleGit({ baseDir: root });
      const c = await readCommit(git, sha);
      if (!c) return { ok: false, reason: 'sha' };
      return { ok: true, sha, parents: c.parents, author: c.author, date: c.date, message: c.message,
        files: await commitFiles(git, sha, c.parents) };
    } catch (_) {
      return { ok: false, reason: 'git' };
    }
  });

  ipcMain.handle('git-panel-commit-diff', async (_e, { sha, file, full, ...target } = {}) => {
    if (!isSha(sha)) return { ok: false, reason: 'sha' };
    if (!isFileArg(file)) return { ok: false, reason: 'path' };
    const root = await logRootOf(target);
    if (!root) return { ok: false, reason: 'repo' };
    try {
      const git = simpleGit({ baseDir: root });
      const c = await readCommit(git, sha);
      if (!c) return { ok: false, reason: 'sha' };
      if (!(await commitFiles(git, sha, c.parents)).some((f) => f.path === file)) return { ok: false, reason: 'path' };
      const cmd = c.parents.length
        ? ['diff', '--no-renames', '--no-ext-diff', '--no-color', `${sha}^1`, sha]
        : ['diff-tree', '-p', '-r', '--root', '--no-commit-id', '--no-ext-diff', '--no-color', sha];
      return diffTail(await git.raw(['--literal-pathspecs', NO_LOCKS, ...cmd, '--', file]), full);
    } catch (_) {
      return { ok: false, reason: 'git' };
    }
  });

  // v53: the renderer builds the open-with menu from this — ids + labels only,
  // never the resolved binary path (kept main-side, like every path here).
  ipcMain.handle('git-panel-editors', async () => ({
    ok: true,
    editors: availableEditors().map((e) => ({ id: e.id, label: e.label })),
  }));

  // v39 step-4 / v53: open the file. `editor` (an id from git-panel-editors)
  // routes to that GUI launcher; absent/'system' keeps the legacy OS-default
  // open. Same provenance rules as the diff (registry cwd -> repo root ->
  // root-relative path, string-guarded). CLAUDE_DECK_NO_OPEN=1 is the probe
  // seam: resolve + answer, never launch.
  ipcMain.handle('git-panel-open', async (_e, { file, editor, wt, ...target } = {}) => {
    // Worktree view: `wt` picks the row's root as git-panel-diff does; outside a view any `wt` is refused.
    const view = await worktreeViewFor(target);
    let cwd;
    if (view) {
      cwd = wtRootIn(view, wt);
      if (!cwd) return { ok: false, reason: 'wt' };
    } else if (isWtSet(wt)) {
      return { ok: false, reason: 'wt' };
    } else {
      cwd = await resolveGitCwd(target);
    }
    if (!cwd) return { ok: false, reason: 'no-target' };
    const fp = String(file || '');
    if (!fp || path.isAbsolute(fp) || fp.split(/[\\/]/).includes('..')) {
      return { ok: false, reason: 'bad-path' };
    }
    const chosen = editor && editor !== 'system'
      ? availableEditors().find((e) => e.id === editor)
      : null;
    if (editor && editor !== 'system' && !chosen) {
      return { ok: false, reason: 'unknown-editor' };
    }
    try {
      const root = (await simpleGit({ baseDir: cwd }).revparse(['--show-toplevel'])).trim();
      const abs = path.join(root, fp);
      if (process.env.CLAUDE_DECK_NO_OPEN === '1') {
        return { ok: true, dryRun: true, resolved: abs,
          editor: chosen ? chosen.id : 'system', cmd: chosen ? chosen.cmd : null };
      }
      if (chosen) {
        // Detached GUI launch: the IDE outlives the deck; never inherit stdio.
        const child = spawn(chosen.cmd, [abs], { detached: true, stdio: 'ignore' });
        child.on('error', () => {}); // late ENOENT swallow; the bin was vetted
        child.unref();
        return { ok: true, resolved: abs, editor: chosen.id };
      }
      const err = await shell.openPath(abs); // '' on success per Electron docs
      return err ? { ok: false, reason: err } : { ok: true, resolved: abs, editor: 'system' };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { registerGitPanelIpc, resolveGitCwd, resolveBin, fileTextAnswer, FILE_TEXT_CAP };
