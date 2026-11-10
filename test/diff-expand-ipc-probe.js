// test/diff-expand-ipc-probe.js — E2E probe: the `git-panel-file-at` channel (deck-diff-expand, lot S1, gates i1-i15).
// Written RED first: i1-i13 need the channel (RED on the base), i14-i15 pin the payloads of git-panel-diff and
// git-panel-commit-diff (GREEN before and after the helper extraction). Every gate asserts positive evidence.
// Lot S4 adds the `gitlab-file-raw` channel (gates r1-r8, RED on the base: no `gitlabFileRaw`) and pins the `gitlab-mr` `diffs`
// answer and the JSON trim of every other glab call (r9-r10, GREEN before and after). They run on the fake glab of _fake-glab.js
// (CLAUDE_DECK_GLAB_BIN set before main.js loads, the raw routes declared in this probe's route list), against the noremote repo of
// the fixture, given a GitLab-parsable `origin`. The real glab is never run.
// Fixtures: test/_git-log-fixture.js (the repo, a symlink pair, big / binary files) and test/_wt-fixture.js (a lot).
// Run: env -u OPENAI_API_KEY ... xvfb-run -a node_modules/.bin/electron test/diff-expand-ipc-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { makeGitLogFixture } = require('./_git-log-fixture');
const { makeFixture } = require('./_wt-fixture');
const { writeFakeGlab, readGlabLog } = require('./_fake-glab');

const GATES = [
  'i1_commit_side', 'i2_index_side', 'i3_worktree_side', 'i4_base_compare_side', 'i5_lot_row',
  'i6_bad_wt_refused', 'i7_symlink_leaf_refused', 'i8_symlink_parent_refused', 'i9_path_guards',
  'i10_sha_guards', 'i11_cap', 'i12_binary', 'i13_untracked_refused',
  'i14_status_diff_payload_identical', 'i15_commit_diff_payload_identical',
  'r1_raw_text_untrimmed', 'r2_request_shape', 'r3_ref_guard_no_call', 'r4_path_guards_no_call',
  'r5_cap', 'r6_binary', 'r7_404_message', 'r8_project_key_ignored',
  'r9_diffs_part_identical', 'r10_json_trim_unchanged',
];
const results = Object.fromEntries(GATES.map((g) => [g, false]));
const detail = {};

function report() {
  let pass = 0;
  for (const g of GATES) {
    if (results[g]) pass++;
    console.log(`${results[g] ? 'PASS' : 'FAIL'} ${g}${!results[g] && detail[g] ? `   (${detail[g]})` : ''}`);
  }
  const green = pass === GATES.length;
  console.log(green ? `VERDICT: ALL GREEN (${pass}/${GATES.length})` : `VERDICT: RED (${pass}/${GATES.length})`);
  return green;
}

// ---- fixtures + seams (BEFORE app boot) ------------------------------------------------------------
const CAP = 8 * 1024 * 1024;
const fx = makeGitLogFixture();
const { sha, clone } = fx;
const G = fx.git;
const W = (rel) => path.join(clone, rel);
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fileat-out-')));
fs.writeFileSync(path.join(OUT, 'secret.txt'), 'TOP-SECRET-LEAF\n');
fs.mkdirSync(path.join(OUT, 'dir'));
fs.writeFileSync(path.join(OUT, 'dir', 'secret2.txt'), 'TOP-SECRET-PARENT\n');

// commit X: a binary file, a file one byte over the cap and one exactly at the cap
fs.writeFileSync(W('bin.dat'), Buffer.from([0x41, 0, 0x42]));
fs.writeFileSync(W('big.txt'), Buffer.alloc(CAP + 1, 0x61));
fs.writeFileSync(W('ok8.txt'), Buffer.alloc(CAP, 0x61));
G(clone, 'add', '--', 'bin.dat', 'big.txt', 'ok8.txt');
G(clone, 'commit', '-q', '-m', 'x');
sha.x = fx.out(clone, 'rev-parse', 'HEAD');
// head state: two.js staged AND edited again (index differs from the worktree), symlinks out of the repo, cap / binary files
fs.writeFileSync(W('src/a/two.js'), 'two\nSTAGED\n');
G(clone, 'add', '--', 'src/a/two.js');
fs.writeFileSync(W('src/a/two.js'), 'two\nSTAGED\nWT\n');
fs.symlinkSync(path.join(OUT, 'secret.txt'), W('leaf-link.txt'));
fs.symlinkSync(path.join(OUT, 'dir'), W('linkdir'));
fs.writeFileSync(W('cap-ok.txt'), Buffer.alloc(CAP, 0x62));
fs.writeFileSync(W('cap-over.txt'), Buffer.alloc(CAP + 1, 0x62));
fs.writeFileSync(W('bin-wt.dat'), Buffer.from([0x41, 0, 0x42]));
// the lot: task worktree (head of the view) + lot `a` with one edit of a tracked file
const fx2 = makeFixture();
const task = fx2.taskWorktree();
const lotA = fx2.lotWorktree({ name: 'a', branch: 'feat/t-a' });
fs.appendFileSync(path.join(lotA.root, 'task.txt'), 'lot edit\n');
const lotId = fx2.idOf(lotA);
const sid2 = randomUUID();
const src2 = fx2.writeTranscript(sid2, fx2.main, [path.join(lotA.root, 'lot-a.txt')]);

// gitlab section (lot S4): the noremote repo gets a GitLab-parsable origin, and glab is the fake, its raw routes declared here.
const GL_HOST = 'gitlab.example.com';
const GL_PROJECT = 'acme/group/proj';
const GL_PROJECT_ENC = 'acme%2Fgroup%2Fproj';
G(fx.noremote, 'remote', 'add', 'origin', `git@${GL_HOST}:${GL_PROJECT}.git`);
const R1_BODY = '\n\nfirst line\n  indented  \n\ttab\t \n\n   ';
const CRLF_BODY = 'a\r\nb\r\n';
const DIFF_ITEM = {
  old_path: 'src/a/one.js', new_path: 'src/a/one.js', diff: '@@ -1 +1,2 @@\n one\n+uno\n',
  new_file: false, renamed_file: false, deleted_file: false, too_large: false, collapsed: false,
};
const WEIRD_PATH = 'dir/sub dir/we?ird#na:me.txt';
const PLACEHOLDER_PATH = ':project/:branch.txt';
const plain = (body, extra = {}) => ({ http: { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body, ...extra } });
const rawRoute = (file, answer) => ({ includes: `/repository/files/${encodeURIComponent(file)}/raw?ref=`, ...answer });
const glabRoutes = [
  rawRoute('docs/r1.txt', plain(R1_BODY)),
  rawRoute('docs/crlf.txt', plain(CRLF_BODY, { eol: '\r\n' })),
  rawRoute(WEIRD_PATH, plain('weird\n')),
  rawRoute(PLACEHOLDER_PATH, plain('placeholder\n')),
  rawRoute('big/at-cap.txt', plain('a'.repeat(CAP))),
  rawRoute('big/over-cap.txt', plain('a'.repeat(CAP + 1))),
  rawRoute('big/over-buffer.txt', plain('a'.repeat(CAP + 1024 * 1024 + 64))),
  rawRoute('bin/blob.dat', plain('A\u0000B')),
  rawRoute('gone/missing.txt', { http: { status: 404, body: { message: '404 File Not Found' } } }),
  rawRoute('gone/plain404.txt', { http: { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not json' } }),
  { includes: 'merge_requests/7/diffs?per_page=100', http: { body: [DIFF_ITEM] } },
  { includes: 'merge_requests/8/diffs?per_page=100', http: { body: `\n\n  ${JSON.stringify([DIFF_ITEM])}  \n\n` } },
];
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fileraw-fake-'));
const fake = writeFakeGlab(fakeDir, glabRoutes);
process.env.CLAUDE_DECK_GLAB_BIN = fake.bin;

const SHELL_SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shim-')), 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(fx.base, 'projects');
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fileat-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fileat-status-'));
fs.mkdirSync(path.join(fx.base, 'projects', 'p2'), { recursive: true });
fs.copyFileSync(src2, path.join(fx.base, 'projects', 'p2', `${sid2}.jsonl`));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const { app, BrowserWindow } = require('electron');
const fsp = require('fs/promises');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const KEYS_TEXT = ['binary', 'capped', 'ok', 'text'];
const KEYS_DIFF = ['binary', 'capped', 'diff', 'ok', 'totalLines'];
const refused = (r, reason) => !!r && r.ok === false && r.reason === reason && !('text' in r);
const fail = (m) => { throw new Error(m); };

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('watchdog: probe stuck for 300 s'); report(); app.exit(2); }, 300000);
  try { await run(); } catch (e) { console.log('probe error: ' + String((e && e.stack) || e)); }
  clearTimeout(watchdog);
  const green = report();
  for (const f of [fx, fx2]) { try { f.cleanup(); } catch (_) { /* tmp */ } }
  for (const d of [OUT, fakeDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* tmp */ } }
  app.exit(green ? 0 : 1);
});

async function run() {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const j = (code) => win.webContents.executeJavaScript(code, true);
  const gate = async (id, fn) => {
    try { results[id] = !!(await fn()); } catch (e) { results[id] = false; detail[id] = String((e && e.message) || e).split('\n')[0].slice(0, 140); }
  };
  const need = async (fn) => { if (!(await j(`typeof window.api.${fn} === 'function'`))) fail(`window.api.${fn} is missing`); };
  const fa = async (t, req) => { await need('gitFileAt'); return j(`window.api.gitFileAt(${J(t)}, ${J(req)})`); };
  // size / flags of a large answer only: the text itself never crosses back into the probe
  const faShape = async (t, req) => {
    await need('gitFileAt');
    return j(`window.api.gitFileAt(${J(t)}, ${J(req)}).then((r) => ({ ok: r.ok, reason: r.reason, keys: Object.keys(r).sort(),
      len: typeof r.text === 'string' ? r.text.length : null, nul: r.text === null, capped: r.capped, binary: r.binary }))`);
  };
  const gd = (t, file, kind, base, wt) => j(`window.api.gitDiff(${J(t)}, ${J(file)}, ${J(kind)}, false, ${J(base ?? null)}, ${J(wt ?? null)})`);
  const cd = (t, shaV, file) => j(`window.api.gitCommitDiff(${J(t)}, ${J(shaV)}, ${J(file)}, false)`);
  const T = { sessionId: fx.sid.main, repoIndex: 0 };
  const TL = { sessionId: sid2, repoIndex: 0 };
  // the lot session folds its worktrees while they are live (as git-wt-ipc-probe does)
  await require('../src/main/session-activity').sessionTouchedRepos(sid2);
  const wtText = (rel) => fs.readFileSync(W(rel), 'utf8');

  await gate('i1_commit_side', async () => {
    const cases = [[sha.f1, 'src/a/one.js'], [sha.f1, 'src/a/a*.js'], [sha.f1, 'app/[slug]/page.tsx'], [sha.f1, 'src/a/two.js'], [sha.c0, 'README.md']];
    for (const [s, file] of cases) {
      const r = await fa(T, { sha: s, file });
      const truth = G(clone, 'cat-file', 'blob', `${s}:${file}`);
      if (!(r.ok === true && r.text === truth && r.text.length > 0 && r.capped === false && r.binary === false && eq(Object.keys(r).sort(), KEYS_TEXT))) {
        fail(`${file}: ${J(r).slice(0, 100)}`);
      }
    }
    return true;
  });

  await gate('i2_index_side', async () => {
    const r = await fa(T, { file: 'src/a/two.js', kind: 'staged' });
    const staged = G(clone, 'cat-file', 'blob', ':0:src/a/two.js');
    if (!(r.ok === true && staged === 'two\nSTAGED\n' && r.text === staged && r.text !== wtText('src/a/two.js'))) fail(J(r).slice(0, 100));
    return refused(await fa(T, { file: 'notes/new.txt', kind: 'staged' }), 'path'); // not in the index
  });

  await gate('i3_worktree_side', async () => {
    const a = await fa(T, { file: 'src/a/one.js', kind: 'unstaged' });
    const b = await fa(T, { file: 'src/a/two.js', kind: 'unstaged' });
    return a.ok === true && a.text === wtText('src/a/one.js') && a.text === 'one\nuno\nWIP-EDIT\n' && a.capped === false && a.binary === false
      && eq(Object.keys(a).sort(), KEYS_TEXT) && b.ok === true && b.text === 'two\nSTAGED\nWT\n';
  });

  await gate('i4_base_compare_side', async () => {
    const r = await fa({ ...T, base: 'origin/develop' }, { file: 'src/a/two.js', kind: 'staged' });
    const bad = await fa({ ...T, base: 'no-such-branch' }, { file: 'src/a/two.js', kind: 'staged' });
    return r.ok === true && r.text === wtText('src/a/two.js') && r.text !== G(clone, 'cat-file', 'blob', ':0:src/a/two.js') && refused(bad, 'base');
  });

  await gate('i5_lot_row', async () => {
    const lot = await fa(TL, { file: 'task.txt', kind: 'unstaged', wt: lotId });
    const lotStaged = await fa(TL, { file: 'task.txt', kind: 'staged', wt: lotId });
    const lotOnly = await fa(TL, { file: 'lot-a.txt', kind: 'unstaged', wt: lotId });
    const head = await fa(TL, { file: 'task.txt', kind: 'unstaged' });
    const lotTruth = fs.readFileSync(path.join(lotA.root, 'task.txt'), 'utf8');
    return lotTruth === 'task work\nlot edit\n' && lot.ok === true && lot.text === lotTruth && lotStaged.ok === true && lotStaged.text === lotTruth
      && lotOnly.ok === true && lotOnly.text === 'lot work\n'
      && head.ok === true && head.text === fs.readFileSync(path.join(task.root, 'task.txt'), 'utf8') && head.text !== lotTruth;
  });

  await gate('i6_bad_wt_refused', async () => {
    for (const wt of ['nope', '../x', 123]) {
      if (!refused(await fa(TL, { file: 'task.txt', kind: 'unstaged', wt }), 'wt')) fail(`view, wt=${J(wt)}`);
    }
    if (!refused(await fa(T, { file: 'src/a/one.js', kind: 'unstaged', wt: 'abc' }), 'wt')) fail('outside a view');
    return (await fa(T, { file: 'src/a/one.js', kind: 'unstaged', wt: '' })).ok === true;
  });

  const noSecret = (r) => !J(r).includes('TOP-SECRET');
  await gate('i7_symlink_leaf_refused', async () => {
    const a = await fa(T, { file: 'leaf-link.txt', kind: 'unstaged' });
    const b = await fa({ ...T, base: 'origin/develop' }, { file: 'leaf-link.txt', kind: 'staged' });
    return refused(a, 'symlink') && refused(b, 'symlink') && noSecret(a) && noSecret(b)
      && fs.readFileSync(path.join(OUT, 'secret.txt'), 'utf8') === 'TOP-SECRET-LEAF\n';
  });

  await gate('i8_symlink_parent_refused', async () => {
    const a = await fa(T, { file: 'linkdir/secret2.txt', kind: 'unstaged' });
    const b = await fa({ ...T, base: 'origin/develop' }, { file: 'linkdir/secret2.txt', kind: 'staged' });
    return refused(a, 'symlink') && refused(b, 'symlink') && noSecret(a) && noSecret(b);
  });

  await gate('i9_path_guards', async () => {
    const bad = ['/etc/hostname', '../x', 'a/../b', '..', 'src/..', '-x', '--help', '', 123, null, { a: 1 }, ['src/a/one.js']];
    for (const file of bad) {
      const a = await fa(T, { file, kind: 'unstaged' });
      const b = await fa(T, { sha: sha.f1, file });
      if (!refused(a, 'bad-path') || !refused(b, 'path')) fail(`${J(file)}: ${J(a).slice(0, 60)} / ${J(b).slice(0, 60)}`);
    }
    if (!refused(await fa(T, { kind: 'unstaged' }), 'bad-path')) fail('missing file');
    return (await fa(T, { file: 'src/a/one.js', kind: 'unstaged' })).ok === true;
  });

  await gate('i10_sha_guards', async () => {
    const tree = fx.out(clone, 'rev-parse', `${sha.f1}^{tree}`);
    const blob = fx.out(clone, 'rev-parse', `${sha.f1}:src/a/one.js`);
    const bad = ['', 'abc', 'HEAD', sha.f1.toUpperCase(), '--help', '0'.repeat(40), tree, blob, 123, false, 0, `${sha.f1}0`, sha.f1.slice(0, 39)];
    for (const s of bad) {
      if (!refused(await fa(T, { sha: s, file: 'src/a/one.js' }), 'sha')) fail(`sha ${J(s)}`);
    }
    const holds = [[sha.f2, 'src/a/one.js'], [sha.f1, 'docs/old.md'], [sha.f1, 'no/such.txt']]; // other commit, deleted file, unknown
    for (const [s, file] of holds) {
      if (!refused(await fa(T, { sha: s, file }), 'path')) fail(`${s.slice(0, 7)}:${file}`);
    }
    return (await fa(T, { sha: sha.f1, file: 'src/a/one.js' })).ok === true;
  });

  await gate('i11_cap', async () => {
    const mod = require('../src/main/ipc/git-panel');
    if (mod.FILE_TEXT_CAP !== CAP || typeof mod.fileTextAnswer !== 'function') fail('FILE_TEXT_CAP / fileTextAnswer not exported');
    const over = mod.fileTextAnswer(Buffer.alloc(CAP + 1, 0x61));
    const small = mod.fileTextAnswer('abc');
    if (!(eq(over, { ok: true, text: null, capped: true, binary: false }) && eq(small, { ok: true, text: 'abc', capped: false, binary: false }))) fail('fileTextAnswer');
    const reads = [];
    const origReadFile = fsp.readFile;
    const origReadSync = fs.readFileSync;
    const trace = path.join(OUT, 'git-trace.log');
    fsp.readFile = function (p, ...rest) { reads.push(String(p)); return origReadFile.call(this, p, ...rest); };
    fs.readFileSync = function (p, ...rest) { reads.push(String(p)); return origReadSync.call(this, p, ...rest); };
    process.env.GIT_TRACE = trace;
    let wtOk; let wtOver; let cOk; let cOver;
    try {
      wtOk = await faShape(T, { file: 'cap-ok.txt', kind: 'unstaged' });
      wtOver = await faShape(T, { file: 'cap-over.txt', kind: 'unstaged' });
      cOk = await faShape(T, { sha: sha.x, file: 'ok8.txt' });
      cOver = await faShape(T, { sha: sha.x, file: 'big.txt' });
    } finally {
      fsp.readFile = origReadFile;
      fs.readFileSync = origReadSync;
      delete process.env.GIT_TRACE;
    }
    const tr = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    const wantKeys = eq(wtOver.keys, KEYS_TEXT) && eq(cOver.keys, KEYS_TEXT);
    const atCap = wtOk.ok && wtOk.len === CAP && wtOk.capped === false && cOk.ok && cOk.len === CAP && cOk.capped === false;
    const capped = [wtOver, cOver].every((r) => r.ok === true && r.capped === true && r.nul === true && r.binary === false);
    const wtNeverRead = reads.some((p) => p.endsWith('cap-ok.txt')) && !reads.some((p) => p.endsWith('cap-over.txt'));
    const blobLines = tr.split('\n').filter((l) => l.includes('cat-file'));
    const sizeAsked = blobLines.some((l) => l.includes('cat-file -s') && l.includes(':big.txt'));
    const blobReadOk = blobLines.some((l) => l.includes('cat-file blob') && l.includes(':ok8.txt'));
    const blobNeverRead = !blobLines.some((l) => l.includes('cat-file blob') && l.includes(':big.txt'));
    if (!(wantKeys && atCap && capped && wtNeverRead && sizeAsked && blobReadOk && blobNeverRead)) {
      fail(J({ wantKeys, atCap, capped, wtNeverRead, sizeAsked, blobReadOk, blobNeverRead }));
    }
    return true;
  });

  await gate('i12_binary', async () => {
    const mod = require('../src/main/ipc/git-panel');
    const direct = typeof mod.fileTextAnswer === 'function' && eq(mod.fileTextAnswer(Buffer.from([0x41, 0, 0x42])), { ok: true, text: null, capped: false, binary: true });
    const a = await fa(T, { sha: sha.x, file: 'bin.dat' });
    const b = await fa(T, { file: 'bin-wt.dat', kind: 'unstaged' });
    const want = { ok: true, text: null, capped: false, binary: true };
    const control = await fa(T, { sha: sha.x, file: 'ok8.txt' }).then((r) => r.ok === true).catch(() => false);
    return direct && eq(a, want) && eq(b, want) && control;
  });

  await gate('i13_untracked_refused', async () => {
    const a = await fa(T, { file: 'notes/new.txt', kind: 'untracked' });
    const control = await fa(T, { file: 'notes/new.txt', kind: 'unstaged' });
    return refused(a, 'untracked') && control.ok === true && control.text === 'new\n'
      && refused(await fa(TL, { file: 'lot-a.txt', kind: 'untracked', wt: lotId }), 'untracked');
  });

  // ---- invariants: the answers of the two diff channels, from git's own stdout ----------------------
  await gate('i14_status_diff_payload_identical', async () => {
    const mb = fx.out(clone, 'merge-base', 'origin/develop', 'HEAD');
    const mbLot = fx.out(lotA.root, 'merge-base', 'feat/t', 'HEAD');
    const noIndex = spawnSync('git', ['-C', clone, 'diff', '--no-index', '--', '/dev/null', 'notes/new.txt']).stdout.toString();
    const rows = [
      ['unstaged', await gd(T, 'src/a/one.js', 'unstaged'), G(clone, 'diff', '--', 'src/a/one.js')],
      ['staged', await gd(T, 'src/a/two.js', 'staged'), G(clone, 'diff', '--cached', '--', 'src/a/two.js')],
      ['base', await gd(T, 'src/a/two.js', 'staged', 'origin/develop'), G(clone, 'diff', mb, '--', 'src/a/two.js')],
      ['untracked', await gd(T, 'notes/new.txt', 'untracked'), noIndex],
      ['lot', await gd(TL, 'task.txt', 'unstaged', null, lotId), G(lotA.root, 'diff', mbLot, '--', 'task.txt')],
      ['head', await gd(TL, 'task.txt', 'unstaged'), G(task.root, 'diff', '--', 'task.txt')],
    ];
    for (const [name, r, truth] of rows) {
      if (!(r.ok === true && eq(Object.keys(r).sort(), KEYS_DIFF) && r.binary === false && r.capped === false
        && r.diff === truth && r.totalLines === truth.split('\n').length)) fail(`${name}: ${J(r).slice(0, 120)}`);
    }
    if (!rows[0][2].includes('+WIP-EDIT') || !rows[4][2].includes('+lot edit')) fail('fixture: empty truth');
    const link = await gd(T, 'leaf-link.txt', 'untracked');
    if (!(eq(Object.keys(link).sort(), ['binary', 'ok', 'symlink', 'target']) && link.symlink === true && link.target === path.join(OUT, 'secret.txt'))) fail('symlink answer');
    const reasons = [
      [await gd({}, 'a.txt', 'unstaged'), 'no-target'],
      [await gd(T, '/abs/x', 'unstaged'), 'bad-path'],
      [await gd(T, '../x', 'unstaged'), 'bad-path'],
      [await gd(TL, 'task.txt', 'unstaged', null, 'nope'), 'wt'],
      [await gd(T, 'src/a/one.js', 'unstaged', 'no-such-branch'), 'base'],
    ];
    for (const [r, reason] of reasons) if (!(r.ok === false && r.reason === reason)) fail(`${reason}: ${J(r).slice(0, 80)}`);
    return true;
  });

  await gate('i15_commit_diff_payload_identical', async () => {
    const lit = (...a) => G(clone, '--literal-pathspecs', ...a);
    const rows = [
      [sha.f1, 'src/a/one.js', lit('diff', '--no-renames', '--no-ext-diff', '--no-color', `${sha.f1}^1`, sha.f1, '--', 'src/a/one.js')],
      [sha.f1, 'src/a/a*.js', lit('diff', '--no-renames', '--no-ext-diff', '--no-color', `${sha.f1}^1`, sha.f1, '--', 'src/a/a*.js')],
      [sha.c0, 'README.md', lit('diff-tree', '-p', '-r', '--root', '--no-commit-id', '--no-ext-diff', '--no-color', sha.c0, '--', 'README.md')],
    ];
    for (const [s, file, truth] of rows) {
      const r = await cd(T, s, file);
      if (!(r.ok === true && eq(Object.keys(r).sort(), KEYS_DIFF) && r.binary === false && r.capped === false
        && r.diff === truth && r.totalLines === truth.split('\n').length && truth.startsWith('diff --git'))) fail(`${file}: ${J(r).slice(0, 120)}`);
    }
    const reasons = [[await cd(T, 'abc', 'src/a/one.js'), 'sha'], [await cd(T, sha.f1, '../x'), 'path'], [await cd(T, sha.f2, 'src/a/one.js'), 'path']];
    for (const [r, reason] of reasons) if (!(r.ok === false && r.reason === reason)) fail(`${reason}: ${J(r).slice(0, 80)}`);
    return true;
  });

  // ---- gitlab section (lot S4): `gitlab-file-raw` on the fake glab, asserted on the REQUEST in the fake's log ----------
  const TN = { sessionId: fx.sid.noremote, repoIndex: 0 };
  const SHA = sha.f1;
  const glog = () => readGlabLog(fake.log);
  const fr = async (t, p, ref) => { await need('gitlabFileRaw'); return j(`window.api.gitlabFileRaw(${J(t)}, ${J(p)}, ${J(ref)})`); };
  // size / flags of a large answer only: the text itself never crosses back into the probe
  const frShape = async (p) => {
    await need('gitlabFileRaw');
    return j(`window.api.gitlabFileRaw(${J(TN)}, ${J(p)}, ${J(SHA)}).then((r) => ({ ok: r.ok, status: r.status, message: r.message, keys: Object.keys(r).sort(),
      len: typeof r.text === 'string' ? r.text.length : null, nul: r.text === null, capped: r.capped, binary: r.binary }))`);
  };
  const failed = (r) => !!r && r.ok === false && typeof r.message === 'string' && r.message.length > 0 && !('text' in r);
  const rawEndpoint = (p, ref) => `projects/${GL_PROJECT_ENC}/repository/files/${encodeURIComponent(p)}/raw?ref=${ref}`;

  await gate('r1_raw_text_untrimmed', async () => {
    const a = await fr(TN, 'docs/r1.txt', SHA);
    const b = await fr(TN, 'docs/crlf.txt', SHA);
    if (!(a.ok === true && a.text === R1_BODY && a.text.startsWith('\n\n') && a.text.endsWith('   ') && a.capped === false && a.binary === false
      && eq(Object.keys(a).sort(), KEYS_TEXT))) fail(`lf: ${J(a).slice(0, 100)}`);
    return b.ok === true && b.text === CRLF_BODY && b.text.endsWith('\r\n');
  });

  await gate('r2_request_shape', async () => {
    const before = glog().length;
    await fr(TN, 'docs/r1.txt', SHA);
    const weird = await fr(TN, WEIRD_PATH, SHA);
    const holder = await fr(TN, PLACEHOLDER_PATH, SHA);
    const calls = glog().slice(before);
    const head = ['api', '-i', '--hostname', GL_HOST];
    const want = [[...head, rawEndpoint('docs/r1.txt', SHA)], [...head, rawEndpoint(WEIRD_PATH, SHA)], [...head, rawEndpoint(PLACEHOLDER_PATH, SHA)]];
    if (!(calls.length === 3 && calls.every((c, i) => eq(c.argv, want[i])))) fail(J(calls.map((c) => c.argv)).slice(0, 200));
    const [, , , , weirdArg] = calls[1].argv;
    const [, , , , holderArg] = calls[2].argv;
    const encoded = weirdArg.includes('dir%2Fsub%20dir%2Fwe%3Fird%23na%3Ame.txt/raw?ref=') && weirdArg.split('?').length === 2;
    const noPlaceholder = holderArg.includes('files/%3Aproject%2F%3Abranch.txt/raw') && !holderArg.slice('projects/'.length).includes(':');
    return encoded && noPlaceholder && weird.ok === true && weird.text === 'weird\n' && holder.ok === true && holder.text === 'placeholder\n';
  });

  await gate('r3_ref_guard_no_call', async () => {
    const bad = ['', 'abc', 'HEAD', 'main', SHA.toUpperCase(), '--help', SHA.slice(0, 39), `${SHA}0`, 'a'.repeat(63), 'a'.repeat(65), `${SHA}\n`, `${SHA}&x=1`,
      `${SHA}/../x`, `${SHA} `, 123, null, false, [SHA], { sha: SHA }];
    const before = glog().length;
    for (const ref of bad) {
      const r = await fr(TN, 'docs/r1.txt', ref);
      if (!failed(r)) fail(`ref ${J(ref)}: ${J(r).slice(0, 80)}`);
    }
    if (glog().length !== before) fail(`a refused ref reached glab: ${glog().length - before} call(s)`);
    const sha1 = await fr(TN, 'docs/r1.txt', SHA);
    const sha256 = await fr(TN, 'docs/r1.txt', 'b'.repeat(64));
    return sha1.ok === true && sha256.ok === true && glog().length === before + 2;
  });

  await gate('r4_path_guards_no_call', async () => {
    const bad = ['', '/etc/hosts', '/docs/r1.txt', '../x', 'a/../b', '..', 'a/..', 'docs/..', 'a\u0000b', '\u0000', 123, null, undefined, true, { a: 1 }, ['docs/r1.txt']];
    const before = glog().length;
    for (const p of bad) {
      const r = await fr(TN, p, SHA);
      if (!failed(r)) fail(`path ${J(p)}: ${J(r).slice(0, 80)}`);
    }
    if (glog().length !== before) fail(`a refused path reached glab: ${glog().length - before} call(s)`);
    const dots = await fr(TN, 'docs/..hidden/x.txt', SHA); // `..` inside a name is no `..` segment: it passes the guard, the fake has no route
    return glog().length === before + 1 && failed(dots) && (await fr(TN, 'docs/r1.txt', SHA)).ok === true;
  });

  await gate('r5_cap', async () => {
    const mod = require('../src/main/ipc/git-panel');
    if (mod.FILE_TEXT_CAP !== CAP) fail('FILE_TEXT_CAP');
    const atCap = await frShape('big/at-cap.txt');
    const over = await frShape('big/over-cap.txt');
    const huge = await frShape('big/over-buffer.txt');
    if (!(atCap.ok === true && atCap.len === CAP && atCap.capped === false && atCap.binary === false)) fail(`at cap: ${J(atCap).slice(0, 100)}`);
    if (!(over.ok === true && over.capped === true && over.nul === true && over.binary === false && eq(over.keys, KEYS_TEXT))) fail(`over cap: ${J(over).slice(0, 100)}`);
    // past cap + 1 MiB the explicit maxBuffer overflows: an error answer, never a truncated text
    return huge.ok === false && typeof huge.message === 'string' && huge.message.length > 0 && huge.len === null && !huge.keys.includes('text');
  });

  await gate('r6_binary', async () => {
    const r = await fr(TN, 'bin/blob.dat', SHA);
    const control = await fr(TN, 'docs/r1.txt', SHA);
    return eq(r, { ok: true, text: null, capped: false, binary: true }) && control.ok === true && control.binary === false;
  });

  await gate('r7_404_message', async () => {
    const json = await fr(TN, 'gone/missing.txt', SHA);
    const plainBody = await fr(TN, 'gone/plain404.txt', SHA);
    return failed(json) && json.status === 404 && json.message === '404 File Not Found'
      && failed(plainBody) && plainBody.status === 404 && plainBody.message === 'Erreur GitLab (404)' && !J(plainBody).includes('not json');
  });

  await gate('r8_project_key_ignored', async () => {
    const before = glog().length;
    const r = await fr({ ...TN, project: 'evil/other', projectId: 1, host: 'evil.example.com', hostname: 'evil.example.com' }, 'docs/r1.txt', SHA);
    const calls = glog().slice(before);
    return r.ok === true && r.text === R1_BODY && calls.length === 1 && eq(calls[0].argv, ['api', '-i', '--hostname', GL_HOST, rawEndpoint('docs/r1.txt', SHA)])
      && !J(calls[0].argv).includes('evil');
  });

  // ---- invariants of the shared glab runner (GREEN on the base and after) ----------------------------------------------
  await gate('r9_diffs_part_identical', async () => {
    const r = await j(`window.api.gitlabMr(${J(TN)}, 7, 'diffs')`);
    const want = { ok: true, files: [{ oldPath: DIFF_ITEM.old_path, newPath: DIFF_ITEM.new_path, status: 'M', diff: DIFF_ITEM.diff, tooLarge: false, collapsed: false }], truncated: false };
    return eq(r, want) && r.files[0].diff.endsWith('+uno\n');
  });

  await gate('r10_json_trim_unchanged', async () => {
    const r = await j(`window.api.gitlabMr(${J(TN)}, 8, 'diffs')`);
    return r.ok === true && r.truncated === false && r.files.length === 1 && r.files[0].diff === DIFF_ITEM.diff && r.files[0].status === 'M';
  });
}
