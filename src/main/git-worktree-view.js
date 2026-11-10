'use strict';

// Task-branch view of a session's git worktrees (C-VIEW): which linked worktree is the head
// (the task branch that receives the lots) and which are the lots. Read-only, simple-git only.
// The renderer never reaches this module: ipc/git-panel.js asks and sends the payload.

const fs = require('fs');
const path = require('path');
const { simpleGit } = require('simple-git');

// Remote first (DoD 2): the same order the branches handler of git-panel.js answers.
const DEFAULT_BASES = ['origin/develop', 'develop', 'origin/main', 'main'];
const CREATED_FROM = /^branch: Created from (.+)$/;

const real = (p) => {
  try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
};
const byRootAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// `<root>/.git` of a linked worktree is a file « gitdir: <main>/.git/worktrees/<id> »; the id is
// unique per repo and is never a path.
function worktreeId(root) {
  try {
    const first = fs.readFileSync(path.join(root, '.git'), 'utf8').split('\n')[0];
    const m = /^gitdir:\s*(.+?)\s*$/.exec(first);
    return m ? path.basename(m[1]) : null;
  } catch (_) {
    return null;
  }
}

// Linked worktrees of the repo, live ones only: the main tree (first block), prunable blocks and
// missing folders are dropped. -> [{root, branch|null, id}]
async function listWorktrees(mainRoot) {
  let out;
  try {
    out = await simpleGit(mainRoot).raw(['worktree', 'list', '--porcelain']);
  } catch (_) {
    return [];
  }
  const list = [];
  for (const block of out.split(/\n[ \t]*\n/).filter((b) => b.trim()).slice(1)) {
    let root = null;
    let branch = null;
    let prunable = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) root = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
    }
    if (!root || prunable || !fs.existsSync(root)) continue;
    const id = worktreeId(root);
    if (id) list.push({ root, branch, id });
  }
  return list;
}

// OLDEST « branch: Created from <start> » subject of the branch reflog; null when the ref or its
// reflog is gone. `worktree add -b X p S` records S, `checkout -b` records HEAD.
async function branchStart(git, branch) {
  try {
    const out = await git.raw(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`]);
    const starts = out.split('\n').map((s) => CREATED_FROM.exec(s.trim())).filter(Boolean);
    return starts.length ? starts[starts.length - 1][1] : null;
  } catch (_) {
    return null;
  }
}

// recorded = C-SA `worktrees` [{root, count, branch, live}]. -> null | {head, lots}.
async function pickWorktreeView(mainRoot, recorded) {
  if (!Array.isArray(recorded) || !recorded.length) return null;
  const linked = await listWorktrees(mainRoot);
  const linkedByReal = new Map(linked.map((w) => [real(w.root), w]));
  // a recorded root is live only when git still lists it as a linked worktree
  const recs = recorded.map((r) => ({
    key: real(r.root),
    count: r.count || 0,
    branch: r.branch || null,
    wt: r.live ? linkedByReal.get(real(r.root)) || null : null,
  }));
  const liveRecs = recs.filter((r) => r.wt);
  const git = simpleGit(mainRoot);

  // (2) every recorded root, live or removed, votes for the live linked worktree sitting on the
  // branch its own branch was created from
  const ballots = await Promise.all(recs.map(async (r) => {
    const branch = (r.wt && r.wt.branch) || r.branch;
    if (!branch) return null;
    const start = await branchStart(git, branch);
    if (!start || start === branch) return null;
    const target = linked.find((w) => w.branch === start);
    return target ? { rec: r, target } : null;
  }));
  const votes = new Map();
  for (const b of ballots) {
    if (!b) continue;
    const key = real(b.target.root);
    if (!votes.has(key)) votes.set(key, { key, wt: b.target, voters: [] });
    votes.get(key).voters.push(b.rec);
  }
  const liveCount = (v) => {
    const r = liveRecs.find((x) => x.key === v.key);
    return r ? r.count : -1;
  };

  let head = null;
  if (votes.size) {
    // (3) most voted; tie -> the one a live recorded root with more writes sits on, then root asc
    const top = [...votes.values()].sort((a, b) => b.voters.length - a.voters.length
      || liveCount(b) - liveCount(a) || byRootAsc(a.wt.root, b.wt.root))[0];
    head = top.wt;
    // (3b) a worktree the session never wrote in, voted by a single live root R, is R's task
    // branch only when R is named as its lot (`<head>-...` or `<head>/...`); else it is R's
    // parent topic and R is the head
    const solo = top.voters.length === 1 ? top.voters[0] : null;
    if (solo && solo.wt && !recs.some((r) => r.key === top.key)) {
      const lotName = solo.wt.branch || solo.branch || '';
      const isLot = lotName.startsWith(`${head.branch}-`) || lotName.startsWith(`${head.branch}/`);
      if (!isLot) head = solo.wt;
    }
  } else {
    // (4) no vote -> the most written live recorded root that sits on a branch
    head = liveRecs.filter((r) => r.wt.branch)
      .sort((a, b) => b.count - a.count || byRootAsc(a.wt.root, b.wt.root))
      .map((r) => r.wt)[0] || null;
  }
  if (!head) return null;

  // (5) lots = live recorded roots minus the head; a vote with no live recorded root gives []
  const headKey = real(head.root);
  return {
    head: { root: head.root, branch: head.branch, id: head.id },
    lots: liveRecs.filter((r) => r.key !== headKey)
      .map((r) => ({ root: r.wt.root, branch: r.wt.branch, id: r.wt.id })),
  };
}

// refs: a Map / Set of ref names (as readBranches of git-panel.js builds) or an array.
function worktreeDefaultBase(refs) {
  const has = refs instanceof Map || refs instanceof Set ? (n) => refs.has(n)
    : Array.isArray(refs) ? (n) => refs.includes(n) : () => false;
  return DEFAULT_BASES.find(has) || null;
}

module.exports = { listWorktrees, pickWorktreeView, worktreeDefaultBase };
