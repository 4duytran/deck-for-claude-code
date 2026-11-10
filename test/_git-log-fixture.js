// test/_git-log-fixture.js — fixture of git-log-probe (deck-git-log, contract § 6.1), built on _wt-fixture.js.
// Throwaway repos under mkdtemp only; git runs without the user's or the system's config.
//
//   const { makeGitLogFixture } = require('./_git-log-fixture');
//   const fx = makeGitLogFixture();
//   fx.clone / fx.main        the clone, HEAD = feat/x, src/a/one.js modified, notes/new.txt untracked
//   fx.noremote               a repo with `main` only, no remote
//   fx.sha                    { c0, h[1..60], c1, mb, d1..d3, f1, f2, lv1, ah1, ah2, blob, tree }
//   fx.sid                    { main, parent, src, noremote } session ids (transcripts under fx.projDir)
//   fx.expect                 the exact first-parent rows the log answers must hold
//   fx.snapshot() / fx.truth(sha, fmt) / fx.out(cwd, ...git args)
//   fx.cleanup()
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { makeFixture, git } = require('./_wt-fixture');

// U+001E and U+001F in the subject: the parser premise is read back by the probe (h_fixture), never assumed.
const F2_SUBJECT = '<img src=x onerror="window.__xss=1">\u001e\u001fend';
const F1_BODY = ['body line one', 'body line two', '<script>window.__xssMsg=1</script>'];
const EVIL_REF = 'evil/<img-src=x-onerror=window.__xssRef=1>';

const out = (cwd, ...args) => git(cwd, ...args).replace(/\n$/, '');

function makeGitLogFixture() {
  const shared = makeFixture(); // base dir, projDir, writeTranscript, cleanup
  const root = path.join(shared.base, 'log');
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const second = path.join(root, 'second');
  const ws = path.join(root, 'ws'); // the NON-repo parent folder of the clone
  const clone = path.join(ws, 'deck-repo');
  const noremote = path.join(root, 'noremote');
  for (const d of [seed, ws, noremote]) fs.mkdirSync(d, { recursive: true });

  const sha = { h: [] };
  // msg === null: the message comes from `extra` (-F). files[rel] === null deletes the file.
  const commit = (cwd, msg, files, extra = []) => {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(cwd, rel);
      if (text === null) { fs.rmSync(f); continue; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', ...extra, ...(msg === null ? [] : ['-m', msg]));
    return out(cwd, 'rev-parse', 'HEAD');
  };

  // develop history: c0 (README.md), h1..h60, c1 (v1.0 annotated + lite), mb
  git(root, 'init', '-q', '--bare', '-b', 'develop', origin);
  git(seed, 'init', '-q', '-b', 'develop');
  git(seed, 'remote', 'add', 'origin', origin);
  sha.c0 = commit(seed, 'c0', { 'README.md': 'readme\n' });
  for (let i = 1; i <= 60; i++) sha.h[i] = commit(seed, `h${i}`, { [`h/h${i}.txt`]: `${i}\n` });
  sha.c1 = commit(seed, 'c1', { 'c1.txt': 'c1\n' });
  git(seed, 'tag', '-a', 'v1.0', '-m', 'release 1.0');
  git(seed, 'tag', 'lite');
  sha.mb = commit(seed, 'mb', { 'src/a/one.js': 'one\n', 'docs/old.md': 'old\n' });
  git(seed, 'push', '-q', 'origin', 'develop', '--tags');

  // origin/develop = mb + d1..d3, pushed from a second clone; the clone only fetches them
  git(root, 'clone', '-q', origin, clone);
  git(root, 'clone', '-q', origin, second);
  for (let i = 1; i <= 3; i++) sha[`d${i}`] = commit(second, `d${i}`, { [`d/d${i}.txt`]: `${i}\n` });
  git(second, 'push', '-q', 'origin', 'develop');
  git(clone, 'fetch', '-q', 'origin');

  const co = (...a) => git(clone, 'checkout', '-q', ...a);
  co('--no-track', '-b', 'feat/level', 'origin/develop');
  sha.lv1 = commit(clone, 'lv1', { 'lv1.txt': 'lv1\n' });
  git(clone, 'push', '-q', '-u', 'origin', 'feat/level');
  co('--no-track', '-b', 'feat/ahead', 'origin/develop');
  sha.ah1 = commit(clone, 'ah1', { 'ah1.txt': 'ah1\n' });
  git(clone, 'push', '-q', '-u', 'origin', 'feat/ahead');
  sha.ah2 = commit(clone, 'ah2', { 'ah2.txt': 'ah2\n' });
  git(clone, 'branch', '--no-track', EVIL_REF, sha.mb);
  // tag and upstream rules: tags without history (blob, tree), a nested tag, a branch whose configured upstream
  // is absent from origin (no push: only the config exists, so `%(upstream:track)` reads [gone])
  sha.blob = out(clone, 'hash-object', '-w', path.join(clone, 'README.md'));
  sha.tree = out(clone, 'rev-parse', `${sha.mb}^{tree}`);
  git(clone, 'tag', 'blobtag', sha.blob);
  git(clone, 'tag', '-a', 'treetag', '-m', 'tree tag', sha.tree);
  git(clone, 'tag', '-a', 'nested', '-m', 'nested tag', 'v1.0');
  git(clone, 'branch', '--no-track', 'gone-up', sha.mb);
  git(clone, 'config', 'branch.gone-up.remote', 'origin');
  git(clone, 'config', 'branch.gone-up.merge', 'refs/heads/gone-up');

  co('--no-track', '-b', 'feat/x', sha.mb); // no upstream
  const msgFile = path.join(root, 'f1.msg');
  fs.writeFileSync(msgFile, `f1\n\n${F1_BODY.join('\n')}\n`);
  sha.f1 = commit(clone, null, {
    'src/a/one.js': 'one\nuno\n',
    'src/a/two.js': 'two\n',
    'src/a/a*.js': 'star\n',
    'src/a/ab.js': 'ab\n',
    'app/[slug]/page.tsx': 'slug\n',
    'app/s/page.tsx': 's\n',
    'docs/old.md': null,
  }, ['-F', msgFile]);
  sha.f2 = commit(clone, F2_SUBJECT, { 'f2.txt': 'f2\n' }, ['--cleanup=verbatim']);
  // head state: 2 rows (modified + untracked), both written by the main session
  fs.writeFileSync(path.join(clone, 'src/a/one.js'), 'one\nuno\nWIP-EDIT\n');
  fs.mkdirSync(path.join(clone, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'notes/new.txt'), 'new\n');

  // noremote: main only, 2 commits, no remote
  git(noremote, 'init', '-q', '-b', 'main');
  commit(noremote, 'n1', { 'n.txt': '1\n' });
  commit(noremote, 'n2', { 'n.txt': '2\n' });
  fs.writeFileSync(path.join(noremote, 'n.txt'), '3\n');

  // sessions: the clone itself, its non-repo parent folder (workspace case), its src/ subfolder, the noremote repo
  const sid = { main: randomUUID(), parent: randomUUID(), src: randomUUID(), noremote: randomUUID() };
  const written = [path.join(clone, 'src/a/one.js'), path.join(clone, 'notes/new.txt')];
  shared.writeTranscript(sid.main, clone, written);
  shared.writeTranscript(sid.parent, ws, written);
  shared.writeTranscript(sid.src, path.join(clone, 'src'), written);
  shared.writeTranscript(sid.noremote, noremote, [path.join(noremote, 'n.txt')]);

  // the exact first-parent rows of the log answers (A2 order), from the fixture's own knowledge
  const hDesc = [];
  for (let i = 60; i >= 1; i--) hDesc.push(sha.h[i]);
  const sharedShas = [sha.mb, sha.c1, ...hDesc, sha.c0];
  const incoming = [sha.d3, sha.d2, sha.d1];
  const seg = (list, s) => list.map((x) => ({ sha: x, seg: s }));
  const expect = {
    featX: [...seg(incoming, 'trunk-only'), ...seg([sha.f2, sha.f1], 'branch'), ...seg(sharedShas, 'shared')],
    trunkLocal: [...seg(incoming, 'incoming'), ...seg(sharedShas, 'shared')],
    trunkOrigin: [...seg(incoming, 'shared'), ...seg(sharedShas, 'shared')],
  };

  // index CONTENT, not file bytes: a status() refresh of the stat cache is not a change
  const snapshot = () => ({
    head: out(clone, 'rev-parse', 'HEAD'),
    refs: git(clone, 'for-each-ref'),
    index: git(clone, 'ls-files', '--stage'),
    status: git(clone, 'status', '--porcelain'),
  });
  // one field per call, so the truth never uses the parser under test
  const truth = (s, fmt) => out(clone, 'log', '-1', `--format=${fmt}`, s);

  return {
    ...shared, // base, projDir, writeTranscript, cleanup
    git, out, root, origin, ws, clone, main: clone, noremote, sha, sid, expect, snapshot, truth,
    F2_SUBJECT, F1_BODY, EVIL_REF,
  };
}

module.exports = { makeGitLogFixture, F2_SUBJECT, F1_BODY, EVIL_REF };
