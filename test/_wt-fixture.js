// test/_wt-fixture.js — shared fixture of the git-worktrees probes (Steps 2, 10, 14).
// Throwaway repos under mkdtemp only; git runs without the user's or the system's config.
//
//   const { makeFixture } = require('./_wt-fixture');
//   const fx = makeFixture({ behind: 0 });   // behind = N: local develop N commits behind origin/develop
//   fx.main                                  // main checkout, on develop
//   fx.taskWorktree()                        // git worktree add -b feat/t <p> origin/develop + 1 commit
//   fx.lotWorktree({ name, branch, from })   // git worktree add -b <branch> <p> <from> + 1 uncommitted edit
//   fx.mergeAndRemove(lot, task)             // lot commit, merge in the task worktree, remove the lot, keep its branch
//   fx.rec(wt, count, live)                  // a C-SA `worktrees` record
//   fx.writeTranscript(sid, cwd, files)      // transcript with one Write tool_use per file
//   fx.cleanup()
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

const git = (cwd, ...args) => execFileSync('git',
  ['-c', 'commit.gpgsign=false', '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).toString();

function makeFixture({ behind = 0 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wt-fixture-')));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const main = path.join(base, 'main');
  const wtDir = path.join(base, 'wt');
  const projDir = path.join(base, 'projects', 'proj');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  git(base, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(seed, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'develop');
  git(base, 'clone', '-q', origin, main);
  for (let i = 1; i <= behind; i++) {
    fs.writeFileSync(path.join(seed, `up${i}.txt`), `${i}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', `upstream ${i}`);
  }
  if (behind) {
    git(seed, 'push', '-q', 'origin', 'develop');
    git(main, 'fetch', '-q', 'origin');
  }

  // from: start-point (omitted = HEAD); existing: attach a branch that already exists;
  // detached: `checkout -b` inside the worktree (reflog subject « Created from HEAD »)
  function addWorktree({ name, branch, from, existing = false, detached = false }) {
    const dir = path.join(wtDir, name);
    if (existing) git(main, 'worktree', 'add', '-q', dir, branch);
    else if (detached) {
      git(main, 'worktree', 'add', '-q', '--detach', dir, ...(from ? [from] : []));
      git(dir, 'checkout', '-q', '-b', branch);
    } else git(main, 'worktree', 'add', '-q', '-b', branch, dir, ...(from ? [from] : []));
    return { root: fs.realpathSync(dir), branch, name };
  }

  function taskWorktree({ name = 'task', branch = 'feat/t' } = {}) {
    const wt = addWorktree({ name, branch, from: 'origin/develop' });
    fs.writeFileSync(path.join(wt.root, 'task.txt'), 'task work\n');
    git(wt.root, 'add', '-A');
    git(wt.root, 'commit', '-q', '-m', 'task work');
    return wt;
  }

  function lotWorktree({ name, branch, from = 'feat/t', detached = false, edit = true }) {
    const wt = addWorktree({ name, branch, from, detached });
    if (edit) fs.writeFileSync(path.join(wt.root, `lot-${name}.txt`), 'lot work\n');
    return wt;
  }

  // Merge through git only: no write-tool record exists for the task worktree.
  function mergeAndRemove(lot, task) {
    git(lot.root, 'add', '-A');
    git(lot.root, 'commit', '-q', '--allow-empty', '-m', `lot ${lot.name}`);
    git(task.root, 'merge', '-q', '--no-ff', '-m', `merge ${lot.branch}`, lot.branch);
    git(main, 'worktree', 'remove', '--force', lot.root);
  }

  const dropDir = (wt) => fs.rmSync(wt.root, { recursive: true, force: true });
  const idOf = (wt) => path.basename(git(wt.root, 'rev-parse', '--git-dir').trim());
  const rec = (wt, count, live = true) => ({ root: wt.root, count, branch: wt.branch, live });

  let toolN = 0;
  function writeTranscript(sid, cwd, files) {
    const lines = [{ type: 'user', cwd, timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'go' } }];
    for (const f of files) {
      lines.push({
        type: 'assistant', timestamp: '2026-10-30T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', id: `toolu_${++toolN}`, name: 'Write', input: { file_path: f } }] },
      });
    }
    const file = path.join(projDir, `${sid}.jsonl`);
    fs.appendFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return file;
  }

  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });

  return {
    base, origin, main, projDir, git, addWorktree, taskWorktree, lotWorktree,
    mergeAndRemove, dropDir, idOf, rec, writeTranscript, cleanup,
  };
}

module.exports = { makeFixture, git };
