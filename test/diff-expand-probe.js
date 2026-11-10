// test/diff-expand-probe.js — Step S2 probe: renderer/js/diff-expand.js, the pure text layer of the diff context expansion (spec D3).
// Gates: t1_above_first · t2_above_first_clamped_at_line_1 · t3_between_up · t4_between_down · t5_merge_on_full_gap ·
// t6_below_last_clamped_at_eof · t7_old_numbers_cumulative_delta · t8_all · t9_no_newline_marker · t10_count_omitted_header ·
// t11_refusals · t12_matches_true · t13_matches_false_one_moved_line · t14_gaps_counts · t15_newSideLines ·
// t16_full_expand_equals_U_max · t17_isolated_hunk_equals_U_k · t18_repeat_no_duplicates · t19_other_gaps_usable ·
// t20_add_only_and_del_only_hunks.
// Text in, text out. The module is imported into the real app page (same pattern as mr-diff-module-probe). The oracle gates (t9, t16,
// t17, t19, t20) compare against REAL `git diff -U<k>` output: a temp repo is built here in the main process, one file per fixture,
// and the diffs for k in 0, 3, 8, 23, 99999 ride into the page as JSON. The header function text (`@@ ... @@ <fn>`) is ignored in
// those comparisons: git re-derives it from the first line of the hunk, the module keeps the earlier header's text.
// Run (checkout root): see the plan's xvfb probe prefix, then `node_modules/.bin/electron test/diff-expand-probe.js`
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SHELL_SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shim-')), 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_GLAB_BIN = path.join(__dirname, '_fake-glab.js'); // no probe ever runs the real glab
// ---- git section fixtures (Step S5, gates p1-p18), built BEFORE the app boots: a hermetic repo opened as a pane, and a lot worktree
// (task branch + lot with one modified tracked file) opened through a transcript session. Everything under mkdtemp.
const { makeFixture } = require('./_wt-fixture');
const wfx = makeFixture();
const Ln = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const Tx = (arr) => arr.join('\n') + '\n';
const setLine = (arr, n, v) => { const c = arr.slice(); c[n - 1] = v; return c; };
const LOCAL = path.join(wfx.base, 'local');
const M_TEXT = Tx(setLine(setLine(setLine(Ln('m', 120), 30, 'M30'), 70, 'M70'), 110, 'M110')); // 3 hunks, hidden 26 / 33 / 33, tail 7
let COMMIT_SHA = '';
const LOT_SID = '99999999-9999-4999-8999-999999999999';
{
  fs.mkdirSync(LOCAL);
  const lg = (...a) => wfx.git(LOCAL, ...a);
  const lw = (f, s) => fs.writeFileSync(path.join(LOCAL, f), s);
  lg('init', '-q', '-b', 'trunk');
  lw('m.txt', Tx(Ln('m', 120)));
  lw('s.txt', Tx(Ln('s', 100)));
  lw('c.txt', Tx(Ln('c', 60)));
  lw('d.txt', Tx(Ln('d', 20)));
  lw('big.txt', Tx(Ln('b', 3000)));
  lw('long.txt', Tx(Ln('g', 1700)));
  fs.writeFileSync(path.join(LOCAL, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  lg('add', '-A'); lg('commit', '-q', '-m', 'base');
  lw('c.txt', Tx(setLine(Ln('c', 60), 30, 'C30')));
  lg('add', '-A'); lg('commit', '-q', '-m', 'c30');
  COMMIT_SHA = lg('rev-parse', 'HEAD').trim();
  lw('m.txt', M_TEXT);                                                  // unstaged, three hunks
  lw('s.txt', Tx(setLine(Ln('s', 100), 50, 'S50')));
  lg('add', 's.txt');                                                   // staged: line 50
  lw('s.txt', Tx(setLine(setLine(Ln('s', 100), 50, 'S50'), 40, 'WT40'))); // worktree-only change on line 40 (hidden by the staged hunk)
  lw('c.txt', Tx(setLine(setLine(Ln('c', 60), 30, 'C30'), 10, 'WT10')));  // worktree-only change on line 10
  fs.rmSync(path.join(LOCAL, 'd.txt'));                                 // unstaged deletion
  fs.writeFileSync(path.join(LOCAL, 'bin.dat'), Buffer.from([9, 9, 0, 1]));
  lw('big.txt', Tx(Ln('b', 3000).map((l, i) => (i === 29 ? 'B30' : i >= 199 && i < 1700 ? `BX${i}` : l)))); // hunk at 30, then a huge one: > 1500 diff lines
  lw('long.txt', Tx(setLine(setLine(Ln('g', 1700), 10, 'G10'), 1690, 'G1690')));
  lw('a.txt', Tx(Ln('a', 10)));
  lg('add', 'a.txt');                                                   // staged new file
  lw('u.txt', 'untracked\n');
  fs.writeFileSync(path.join(wfx.base, 'secret.txt'), 'TOP-SECRET\n');
  fs.symlinkSync(path.join(wfx.base, 'secret.txt'), path.join(LOCAL, 'link')); // untracked symlink

  const task = wfx.taskWorktree();
  fs.writeFileSync(path.join(task.root, 'm.txt'), Tx(Ln('m', 60)));
  wfx.git(task.root, 'add', '-A'); wfx.git(task.root, 'commit', '-q', '-m', 'm.txt');
  const lot = wfx.lotWorktree({ name: 'a', branch: 'feat/t-a' });
  fs.writeFileSync(path.join(lot.root, 'm.txt'), Tx(setLine(Ln('m', 60), 30, 'LOT30'))); // tracked, modified in the lot only
  wfx.writeTranscript(LOT_SID, wfx.main, [path.join(lot.root, 'm.txt'), path.join(lot.root, 'lot-a.txt')]);
}
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(wfx.base, 'projects');
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-dxp-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-dxp-status-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const { app, BrowserWindow } = require('electron');

const GATES = [
  't1_above_first', 't2_above_first_clamped_at_line_1', 't3_between_up', 't4_between_down', 't5_merge_on_full_gap',
  't6_below_last_clamped_at_eof', 't7_old_numbers_cumulative_delta', 't8_all', 't9_no_newline_marker', 't10_count_omitted_header',
  't11_refusals', 't12_matches_true', 't13_matches_false_one_moved_line', 't14_gaps_counts', 't15_newSideLines',
  't16_full_expand_equals_U_max', 't17_isolated_hunk_equals_U_k', 't18_repeat_no_duplicates', 't19_other_gaps_usable',
  't20_add_only_and_del_only_hunks',
];

// ---- fixtures (main process): old/new file pairs and the real git diffs ------------------------------------------------------
const rows = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `row ${a + i}`);
const SPECS = {
  // f1: 100 -> 102 lines; hunks at old 10 (-1/+4, net +3), 40 (deleted, net -1), 70 (edit), 96 (edit); -U3 hunks start at new 7, 40, 69, 95
  f1: { old: rows(1, 100), nw: [...rows(1, 9), 'A10a', 'A10b', 'A10c', 'A10d', ...rows(11, 39), ...rows(41, 69), 'C70', ...rows(71, 95), 'D96', ...rows(97, 100)] },
  f2: { old: rows(1, 50), nw: [...rows(1, 24), 'X25', ...rows(26, 50)] }, // one isolated hunk
  f4: { old: rows(1, 40), nw: [...rows(1, 20), 'N1', 'N2', ...rows(21, 34), ...rows(36, 40)] }, // an add-only and a delete-only change
  f5: { old: rows(1, 30), nw: [...rows(1, 9), 'Y10', ...rows(11, 30)], eol: false }, // no final newline, change far from the end
  f5b: { old: rows(1, 30), nw: [...rows(1, 29), 'Z30'], eol: false }, // no final newline, change on the last line
  f6: { old: rows(1, 10), nw: [...rows(1, 4), 'V5', ...rows(6, 10)] }, // -U0 gives `@@ -5 +5 @@`
  f7: { old: rows(1, 120), nw: [...rows(1, 79), 'W80', ...rows(81, 120)] },
};

function buildOracle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-dxp-repo-'));
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  const text = (lines, eol) => lines.join('\n') + (eol === false ? '' : '\n');
  git('init', '-q');
  for (const [n, s] of Object.entries(SPECS)) fs.writeFileSync(path.join(dir, `${n}.txt`), text(s.old, s.eol));
  git('add', '-A');
  git('-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'old');
  const fx = {};
  for (const [n, s] of Object.entries(SPECS)) {
    fs.writeFileSync(path.join(dir, `${n}.txt`), text(s.nw, s.eol));
    fx[n] = { nf: text(s.nw, s.eol), d: {} };
    for (const k of [0, 3, 8, 23, 99999]) fx[n].d[k] = git('diff', `-U${k}`, '--no-ext-diff', '--no-textconv', '--no-color', '--', `${n}.txt`);
  }
  return fx;
}

// Runs inside the app page (serialized with toString): returns { g: {gate: bool}, detail }.
async function inPage(gateNames, fx) {
  const g = Object.fromEntries(gateNames.map((n) => [n, false]));
  const detail = {};
  let M;
  try {
    M = await import('./js/diff-expand.js');
  } catch (e) {
    detail.importError = String(e);
    return { g, detail };
  }
  const gate = async (name, fn) => {
    const fails = [];
    const t = (cond, label) => { if (!cond) fails.push(label); return cond; };
    try { await fn(t); } catch (e) { fails.push(String((e && e.stack) || e)); }
    if (fails.length) detail[name] = fails;
    g[name] = fails.length === 0;
  };

  const lines = (x) => x.split('\n');
  const hdrs = (x) => lines(x).filter((l) => l.startsWith('@@'));
  const hunkLines = (x, k) => {
    const L = lines(x);
    const idx = [];
    L.forEach((l, i) => { if (l.startsWith('@@')) idx.push(i); });
    let end = k + 1 < idx.length ? idx[k + 1] : L.length;
    if (end === L.length && L[L.length - 1] === '') end -= 1;
    return L.slice(idx[k] + 1, end);
  };
  const ctxRows = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(` row ${i}`); return o; };
  const strip = (x) => lines(x).map((l) => l.replace(/^(@@ -\S+ \+\S+ @@).*$/, '$1')).join('\n');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && strip(a) === strip(b);
  const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fnOf = (h) => h.slice(h.indexOf('@@', 2) + 2);
  // closes every gap with `all` (hunk 1 each time, the merge shifts the indexes), then the tail
  const full = (d, nf) => {
    let x = M.expand(d, nf, { hunk: 0, dir: 'all' });
    while (x !== null && hdrs(x).length > 1) x = M.expand(x, nf, { hunk: 1, dir: 'all' });
    return x === null ? null : M.expand(x, nf, { hunk: 0, dir: 'down', n: Infinity });
  };
  const fullDesc = (d, nf) => {
    let x = d;
    for (let h = hdrs(d).length - 1; h >= 0 && x !== null; h--) x = M.expand(x, nf, { hunk: h, dir: 'all' });
    return x === null ? null : M.expand(x, nf, { hunk: hdrs(x).length - 1, dir: 'down', n: Infinity });
  };
  const f1 = fx.f1;
  const d3 = f1.d[3];

  await gate('t1_above_first', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 0, dir: 'up', n: 4 });
    t(hdrs(r)[0].startsWith('@@ -3,11 +3,14 @@'), 'header');
    t(eqArr(hunkLines(r, 0).slice(0, 5), ctxRows(3, 7)), 'four rows above then the old first context row');
    t(hdrs(r).length === 4, 'hunk count');
    t(eqArr(hunkLines(r, 1), hunkLines(d3, 1)) && hdrs(r)[1] === hdrs(d3)[1], 'next hunk untouched');
  });

  await gate('t2_above_first_clamped_at_line_1', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 0, dir: 'up', n: 20 });
    t(hdrs(r)[0].startsWith('@@ -1,13 +1,16 @@'), 'header starts at 1, +6 lines');
    t(eqArr(hunkLines(r, 0).slice(0, 7), ctxRows(1, 7)), 'rows 1..6 inserted, no row 0');
    t(M.gaps(r, 102).above[0] === 0, 'gap above is 0');
  });

  await gate('t3_between_up', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 1, dir: 'up', n: 5 });
    t(hdrs(r)[1].startsWith('@@ -32,12 +35,11 @@'), 'header');
    t(eqArr(hunkLines(r, 1).slice(0, 6), ctxRows(32, 37)), 'rows 32..36 then 37');
    t(hdrs(r).length === 4 && hdrs(r)[0] === hdrs(d3)[0], 'no merge, hunk 0 untouched');
    t(M.gaps(r, 102).above[1] === 18, 'gap 23 -> 18');
  });

  await gate('t4_between_down', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 0, dir: 'down', n: 5 });
    t(hdrs(r)[0].startsWith('@@ -7,12 +7,15 @@'), 'header');
    t(eqArr(hunkLines(r, 0).slice(-6), ctxRows(13, 18)), 'rows 14..18 appended');
    t(hdrs(r)[1] === hdrs(d3)[1], 'hunk 1 untouched');
    t(M.gaps(r, 102).above[1] === 18, 'gap 23 -> 18');
  });

  await gate('t5_merge_on_full_gap', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 1, dir: 'all' });
    t(hdrs(r).length === 3, 'one header fewer');
    t(hdrs(r)[0].startsWith('@@ -7,37 +7,39 @@'), 'counts summed (7+23+7, 10+23+6)');
    t(fnOf(hdrs(r)[0]) === fnOf(hdrs(d3)[0]), 'the earlier header function text is kept');
    t(eqArr(hunkLines(r, 0), [...hunkLines(d3, 0), ...ctxRows(14, 36), ...hunkLines(d3, 1)]), 'body order intact');
    t(hdrs(r)[1] === hdrs(d3)[2] && hdrs(r)[2] === hdrs(d3)[3], 'later hunks untouched');
    t(r === M.expand(d3, f1.nf, { hunk: 0, dir: 'down', n: 23 }), 'down 23 on the earlier hunk gives the same text');
    t(r === M.expand(d3, f1.nf, { hunk: 1, dir: 'up', n: 23 }), 'up 23 on the later hunk gives the same text');
  });

  await gate('t6_below_last_clamped_at_eof', (t) => {
    const r = M.expand(d3, f1.nf, { hunk: 3, dir: 'down', n: 20 });
    t(hdrs(r)[3].startsWith('@@ -93,8 +95,8 @@'), 'header +1 line only');
    t(hunkLines(r, 3).slice(-2).join('|') === ' row 99| row 100', 'row 100 appended');
    t(r.endsWith('\n') && !r.includes('\\ No newline'), 'trailing newline kept, no marker');
    t(M.gaps(r, 102).below === 0, 'tail is 0');
  });

  await gate('t7_old_numbers_cumulative_delta', (t) => {
    const r2 = M.expand(d3, f1.nf, { hunk: 2, dir: 'up', n: 5 });
    t(hdrs(r2)[2].startsWith('@@ -62,12 +64,12 @@'), 'delta +3-1 = +2: old 62 = new 64 - 2');
    const r3 = M.expand(d3, f1.nf, { hunk: 3, dir: 'up', n: 5 });
    t(hdrs(r3)[3].startsWith('@@ -88,12 +90,12 @@'), 'old 88 = new 90 - 2');
    const r1 = M.expand(d3, f1.nf, { hunk: 1, dir: 'up', n: 5 });
    t(hdrs(r1)[1].startsWith('@@ -32,12 +35,11 @@'), 'delta +3: old 32 = new 35 - 3');
  });

  await gate('t8_all', (t) => {
    const r3 = M.expand(d3, f1.nf, { hunk: 3, dir: 'all' });
    t(hdrs(r3).length === 3 && hdrs(r3)[2].startsWith('@@ -67,33 +69,33 @@'), 'the last gap closes and merges');
    const r0 = M.expand(d3, f1.nf, { hunk: 0, dir: 'all' });
    t(hdrs(r0).length === 4 && hdrs(r0)[0].startsWith('@@ -1,13 +1,16 @@'), 'the first gap fills from line 1');
    t(M.expand(r0, f1.nf, { hunk: 0, dir: 'all' }) === r0, 'a closed gap gives the same text');
  });

  await gate('t9_no_newline_marker', (t) => {
    const a = fx.f5;
    const r = M.expand(a.d[3], a.nf, { hunk: 0, dir: 'down', n: Infinity });
    const L = lines(r);
    t(L[L.length - 2] === '\\ No newline at end of file' && L[L.length - 3] === ' row 30', 'tail ends with the marker');
    t(L.filter((l) => l[0] === '\\').length === 1, 'one marker');
    t(same(full(a.d[3], a.nf), a.d[99999]), 'full expand equals real -U99999 (marker included)');
    const b = fx.f5b;
    t(b.d[3].split('\n').filter((l) => l[0] === '\\').length === 2, 'fixture: the diff already holds both markers');
    const rb = M.expand(b.d[3], b.nf, { hunk: 0, dir: 'up', n: 5 });
    t(same(rb, b.d[8]) && rb.split('\n').filter((l) => l[0] === '\\').length === 2, 'up 5 keeps both markers, equals real -U8');
    t(M.expand(b.d[3], b.nf, { hunk: 0, dir: 'down', n: 5 }) === b.d[3], 'nothing below: same text');
  });

  await gate('t10_count_omitted_header', (t) => {
    const txt = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n';
    const r = M.expand(txt, 'y\nz\nw\n', { hunk: 0, dir: 'down', n: 5 });
    t(r === 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-x\n+y\n z\n w\n', 'omitted counts read as 1, rewritten');
    const gp = M.gaps(txt, 3);
    t(gp && eqArr(gp.above, [0]) && gp.below === 2, 'gaps on an omitted-count header');
    const f = fx.f6;
    t(hdrs(f.d[0])[0].startsWith('@@ -5 +5 @@'), 'fixture: real -U0 omits the counts');
    let x = M.expand(f.d[0], f.nf, { hunk: 0, dir: 'up', n: 3 });
    x = M.expand(x, f.nf, { hunk: 0, dir: 'down', n: 3 });
    t(same(x, f.d[3]), 'up 3 + down 3 equals real -U3');
  });

  await gate('t11_refusals', (t) => {
    const nf = f1.nf;
    for (const h of [4, 9, -1, 1.5, '0', undefined, null]) t(M.expand(d3, nf, { hunk: h, dir: 'up', n: 5 }) === null, `hunk ${String(h)}`);
    t(M.expand(d3, nf, { hunk: 0, dir: 'sideways', n: 5 }) === null, 'bad dir');
    for (const n of [0, -1, NaN, '5', undefined, null]) t(M.expand(d3, nf, { hunk: 0, dir: 'up', n }) === null, `n ${String(n)}`);
    t(M.expand(d3, nf, null) === null && M.expand(d3, null, { hunk: 0, dir: 'all' }) === null, 'no opts / no file');
    const two = d3 + f1.d[3].replace(/f1\.txt/g, 'f9.txt');
    t(M.expand(two, nf, { hunk: 0, dir: 'up', n: 5 }) === null, 'two-file text: expand');
    t(M.gaps(two, 102) === null && M.matches(two, nf) === false, 'two-file text: gaps null, matches false');
    for (const junk of ['hello', '', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n', '@@ nope @@\n x\n', null, undefined, 5]) {
      t(M.expand(junk, nf, { hunk: 0, dir: 'all' }) === null && M.gaps(junk, 5) === null && M.matches(junk, nf) === false, `garbage ${String(junk).slice(0, 12)}`);
    }
    t(M.expand(d3 + 'stray\n', nf, { hunk: 0, dir: 'all' }) === null, 'stray text after the last hunk');
    t(M.expand(d3, 'row 1\nrow 2\n', { hunk: 3, dir: 'down', n: 5 }) === null && M.matches(d3, 'row 1\nrow 2\n') === false, 'file shorter than the diff');
  });

  await gate('t12_matches_true', (t) => {
    for (const n of Object.keys(fx)) for (const k of Object.keys(fx[n].d)) t(M.matches(fx[n].d[k], fx[n].nf) === true, `${n} -U${k}`);
    t(M.matches(M.expand(d3, f1.nf, { hunk: 1, dir: 'all' }), f1.nf) === true, 'spliced text');
  });

  await gate('t13_matches_false_one_moved_line', (t) => {
    const L = f1.nf.split('\n');
    const swap = L.slice();
    [swap[7], swap[8]] = [swap[8], swap[7]];
    t(M.matches(d3, swap.join('\n')) === false, 'two context rows swapped');
    const added = L.slice();
    added[10] = 'A10x';
    t(M.matches(d3, added.join('\n')) === false, 'an added line differs');
    const hidden = L.slice();
    hidden[49] = 'zzz';
    t(M.matches(d3, hidden.join('\n')) === true, 'a hidden line is not compared');
    t(M.matches(d3, L.slice(0, 60).join('\n') + '\n') === false, 'file too short');
  });

  await gate('t14_gaps_counts', (t) => {
    const a = M.gaps(d3, 102);
    t(a && eqArr(a.above, [6, 23, 23, 19]) && a.below === 1, 'f1 -U3: above and below');
    const s = a.above.reduce((x, y) => x + y, 0) + a.below + (10 + 6 + 7 + 7);
    t(s === 102, 'hidden + shown = file length');
    const n = M.gaps(d3, null);
    t(n && eqArr(n.above, [6, 23, 23, 19]) && n.below === null, 'lineCount null: below null');
    t(M.gaps(d3, undefined).below === null, 'lineCount undefined: below null');
    t(M.gaps(d3, 50).below === 0, 'lineCount short: clamped at 0');
    const u = M.gaps(f1.d[99999], 102);
    t(u && eqArr(u.above, [0]) && u.below === 0, 'full diff: nothing hidden');
    const m = M.gaps(M.expand(d3, f1.nf, { hunk: 1, dir: 'all' }), 102);
    t(m && eqArr(m.above, [6, 23, 19]) && m.below === 1, 'after a merge');
  });

  await gate('t15_newSideLines', (t) => {
    const txt = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,4 +10,5 @@\n a\n-b\n+c\n+d\n e\n f\n';
    t(eqArr([...M.newSideLines(txt)].sort((x, y) => x - y), [10, 11, 12, 13, 14]), 'context and added lines, removed skipped');
    const s = M.newSideLines(d3);
    t(s instanceof Set && s.size === 30 && s.has(7) && s.has(10) && s.has(13) && s.has(16) && !s.has(6) && !s.has(17), 'f1 -U3');
    t(eqArr([...M.newSideLines(fx.f4.d[0])].sort((x, y) => x - y), [21, 22]), 'add-only + delete-only hunks (-U0)');
    t(M.newSideLines('garbage') instanceof Set && M.newSideLines('garbage').size === 0, 'garbage: empty Set');
  });

  await gate('t16_full_expand_equals_U_max', (t) => {
    for (const n of ['f1', 'f2', 'f4', 'f5', 'f5b', 'f7']) {
      t(same(full(fx[n].d[3], fx[n].nf), fx[n].d[99999]), `${n} from -U3 (ascending)`);
      t(same(fullDesc(fx[n].d[3], fx[n].nf), fx[n].d[99999]), `${n} from -U3 (descending)`);
    }
    for (const n of ['f1', 'f4', 'f6', 'f7']) t(same(full(fx[n].d[0], fx[n].nf), fx[n].d[99999]), `${n} from -U0`);
  });

  await gate('t17_isolated_hunk_equals_U_k', (t) => {
    for (const [name, ns] of [['f2', [5, 20, 40]], ['f7', [5, 20]]]) {
      const f = fx[name];
      for (const n of ns) {
        const want = f.d[3 + n] || f.d[99999];
        let r = M.expand(f.d[3], f.nf, { hunk: 0, dir: 'up', n });
        r = M.expand(r, f.nf, { hunk: 0, dir: 'down', n });
        t(same(r, want), `${name} up ${n} + down ${n}`);
        let q = M.expand(f.d[3], f.nf, { hunk: 0, dir: 'down', n });
        q = M.expand(q, f.nf, { hunk: 0, dir: 'up', n });
        t(same(q, want), `${name} down ${n} + up ${n}`);
      }
    }
  });

  await gate('t18_repeat_no_duplicates', (t) => {
    const f = fx.f7;
    const up = (x, n) => M.expand(x, f.nf, { hunk: 0, dir: 'up', n });
    const a = up(up(f.d[3], 20), 20);
    t(a === up(f.d[3], 40), 'two up 20 = one up 40');
    t(hdrs(a)[0].startsWith('@@ -37,47 +37,47 @@'), 'header');
    t(M.newSideLines(a).size === hunkLines(a, 0).filter((l) => l[0] === ' ' || l[0] === '+').length, 'no duplicated row');
    t(new Set(hunkLines(a, 0)).size === hunkLines(a, 0).length, 'every row distinct');
    let c = f.d[3];
    for (let i = 0; i < 4; i++) c = up(c, 20);
    t(c === M.expand(f.d[3], f.nf, { hunk: 0, dir: 'all' }), 'four up 20 clamp at line 1 = all');
  });

  await gate('t19_other_gaps_usable', (t) => {
    const base = M.gaps(d3, 102);
    for (const k of [1, 2, 3]) {
      const r = M.expand(d3, f1.nf, { hunk: k, dir: 'all' });
      const gp = M.gaps(r, 102);
      t(gp && eqArr(gp.above, base.above.filter((_, i) => i !== k)) && gp.below === 1, `gaps after closing ${k}`);
      t(M.matches(r, f1.nf) === true, `matches after closing ${k}`);
      t(same(full(r, f1.nf), f1.d[99999]), `rest closes ascending after ${k}`);
      t(same(fullDesc(r, f1.nf), f1.d[99999]), `rest closes descending after ${k}`);
    }
    // a partial splice on one gap, then the other gaps keep their numbers: each rest-hunk header equals the untouched one
    const r = M.expand(d3, f1.nf, { hunk: 1, dir: 'up', n: 5 });
    t(hdrs(r)[2] === hdrs(d3)[2] && hdrs(r)[3] === hdrs(d3)[3], 'other hunks keep their headers');
    t(same(fullDesc(r, f1.nf), f1.d[99999]), 'a partial splice still closes to the real -U99999');
  });

  await gate('t20_add_only_and_del_only_hunks', (t) => {
    const f = fx.f4;
    t(hdrs(f.d[0])[0].startsWith('@@ -20,0 +21,2 @@') && hdrs(f.d[0])[1].startsWith('@@ -35 +36,0 @@'), 'fixture: real -U0 headers');
    let x = f.d[0];
    for (const k of [0, 1]) {
      x = M.expand(x, f.nf, { hunk: k, dir: 'up', n: 3 });
      x = M.expand(x, f.nf, { hunk: k, dir: 'down', n: 3 });
    }
    t(same(x, f.d[3]), 'up 3 + down 3 on each hunk equals real -U3');
    t(hdrs(x)[0].startsWith('@@ -18,6 +18,8 @@') && hdrs(x)[1].startsWith('@@ -32,7 +34,6 @@'), 'headers');
    let y = f.d[0];
    for (const k of [1, 0]) y = M.expand(y, f.nf, { hunk: k, dir: 'up', n: 3 });
    for (const k of [1, 0]) y = M.expand(y, f.nf, { hunk: k, dir: 'down', n: 3 });
    t(same(y, f.d[3]), 'same result, other order');
    t(eqArr(M.gaps(f.d[0], 38).above, [20, 14]) && M.gaps(f.d[0], 38).below === 2, 'gaps on -U0 (add-only, delete-only)');
  });

  return { g, detail };
}

// ---- git section (Step S5): the git panel diff view of renderer/js/git-panel.js, driven in the real app ----------------------------
const PGATES = [
  'p1_controls_on_modified_file', 'p2_above_first_splice', 'p3_between_all_merges', 'p4_below_last', 'p5_capped_no_tail',
  'p6_staged_row_uses_index', 'p7_commit_row', 'p8_lot_row', 'p9_no_control_added_deleted_untracked_binary', 'p10_symlink_row_no_control',
  'p11_drift_notice', 'p12_fold_after_expand', 'p13_fold_kept_by_header_text', 'p14_split_view_expand', 'p15_keep_scroll',
  'p16_format_switch_keeps_expansion', 'p17_stale_prefetch_dropped', 'p18_splice_cap_notice',
];

// Runs inside the app page (serialized with toString): small readers of the shown git diff.
function dxInstall() {
  const diffEl = () => document.getElementById('gp-diff');
  const heads = () => {
    const t = diffEl().querySelector('.d2h-diff-table');
    return t ? [...t.querySelectorAll(':scope > tbody > tr')].filter((tr) => tr.querySelector('.d2h-info')) : [];
  };
  const headText = (tr) => {
    const c = tr.lastElementChild.cloneNode(true);
    c.querySelectorAll('.dx-gap').forEach((e) => e.remove());
    return c.textContent.trim();
  };
  const texts = () => heads().map(headText);
  const btn = (k, label) => { const h = heads()[k]; return h ? [...h.querySelectorAll('.dx-gap-btn')].find((b) => b.textContent.startsWith(label)) : undefined; };
  const tailBtn = (label) => [...diffEl().querySelectorAll('.dx-gap-tail .dx-gap-btn')].find((b) => b.textContent.startsWith(label));
  const nrows = () => {
    const t = diffEl().querySelector('.d2h-diff-table');
    return t ? [...t.querySelectorAll(':scope > tbody > tr')].filter((tr) => !tr.querySelector('.d2h-info') && !tr.classList.contains('dx-gap-tail')).length : -1;
  };
  const ctxTexts = () => [...diffEl().querySelectorAll('.d2h-code-line-ctn')].map((c) => c.textContent);
  const open = async (p, kind, wt) => {
    const i = gp.rows.findIndex((r) => r.path === p && (!kind || r.kind === kind) && (wt == null || (wt === '*' ? !!r.wt : (r.wt || '') === wt)));
    if (i < 0) return -1;
    await gpLoadDiff(i);
    return i;
  };
  const fold = (k) => { heads()[k].lastElementChild.click(); };
  const pattern = () => [...diffEl().querySelectorAll('tbody')].map((tb) => [...tb.rows].map((r) => (r.classList.contains('gp-hunk-folded') ? 1 : 0)).join(''));
  return { diffEl, heads, texts, btn, tailBtn, nrows, ctxTexts, open, fold, pattern };
}

async function gitSection(win) {
  const g = Object.fromEntries(PGATES.map((n) => [n, false]));
  const detail = {};
  const J = JSON.stringify;
  const UP = '↑';
  const ALL_LABEL = 'Tout afficher';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await j(code).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await sleep(60);
    }
  };
  const gate = async (name, fn) => {
    const fails = [];
    const t = (cond, label) => { if (!cond) fails.push(label); return cond; };
    try { await fn(t); } catch (e) { fails.push(String((e && e.message) || e)); }
    if (fails.length) detail[name] = fails;
    g[name] = fails.length === 0;
  };
  const fmt = async (f) => {
    await j(`(() => { const b = document.querySelector('#gp-diffc .dv-seg button[data-format="${f}"]'); if (b) b.click(); return !!b; })()`);
    await sleep(200);
  };
  const open = (p, kind, wt) => j(`__dx.open(${J(p)}, ${J(kind || null)}, ${J(wt === undefined ? null : wt)})`);
  const click = (code) => j(`(() => { const b = ${code}; if (!b) return false; b.click(); return true; })()`);
  const tailUp = () => waitFor(`!!document.querySelector('#gp-diff .dx-gap-tail')`);
  const headChanged = (k, old) => waitFor(`(__dx.texts()[${k}] || '') !== ${J(old)}`, 3000);
  const texts = () => j(`__dx.texts()`);
  const count = (sel) => j(`document.querySelectorAll(${J(sel)}).length`);

  win.setSize(2300, 600);
  await sleep(400);
  await j(`openPane({ cwd: ${J(LOCAL)}, title: 'probe' })`);
  await sleep(1200);
  const paneId = await j(`[...panes.keys()].pop()`);
  await j(`openGitPanel({ paneId: '${paneId}' })`);
  await waitFor(`!!gp.rows && gp.rows.length > 5`, 8000);
  await sleep(600);
  await j(`window.__dx = (${dxInstall.toString()})(); true`);

  await gate('p1_controls_on_modified_file', async (t) => {
    await fmt('line-by-line');
    t((await open('m.txt', 'unstaged')) >= 0, 'row m.txt');
    t(await tailUp(), 'tail control after the prefetch');
    const s = await j(`({ n: __dx.heads().length, b: __dx.heads().map((h) => [...h.querySelectorAll('.dx-gap-btn')].map((b) => b.textContent)),
      tails: document.querySelectorAll('#gp-diff .dx-gap-tail').length,
      tail: [...document.querySelectorAll('#gp-diff .dx-gap-tail .dx-gap-btn')].map((b) => b.textContent) })`);
    t(s.n === 3, 'three hunks: ' + J(s));
    t(s.b.length === 3 && s.b[0].length === 2 && s.b[1].length === 3 && s.b[2].length === 3, 'buttons above / between / between: ' + J(s.b));
    t(s.tails === 1 && s.tail.length === 1 && s.tail[0] === ALL_LABEL, 'tail control once: ' + J(s));
  });

  await gate('p2_above_first_splice', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    const before = await j(`({ h: __dx.texts()[0], n: __dx.nrows() })`);
    t(await click(`__dx.btn(0, ${J(UP)})`), 'up button on hunk 0');
    t(await headChanged(0, before.h), 'header 0 changes');
    const after = await j(`({ h: __dx.texts()[0], n: __dx.nrows() })`);
    t(/^@@ -7,27 \+7,27 @@/.test(after.h), 'header ' + after.h);
    t(after.n === before.n + 20, `rows ${before.n} -> ${after.n}`);
  });

  await gate('p3_between_all_merges', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    const before = await j(`({ n: __dx.heads().length, r: __dx.nrows() })`);
    t(await click(`__dx.btn(1, ${J(ALL_LABEL)})`), 'all button on hunk 1');
    t(await waitFor(`__dx.heads().length === ${before.n - 1}`, 3000), 'one header fewer');
    const after = await j(`({ n: __dx.heads().length, r: __dx.nrows() })`);
    t(after.r === before.r + 33, `rows ${before.r} -> ${after.r}`);
  });

  await gate('p4_below_last', async (t) => {
    await fmt('line-by-line');
    const r = await j(`(async () => {
      await __dx.open('m.txt', 'unstaged');
      const early = document.querySelectorAll('#gp-diff .dx-gap-tail').length;
      const ctrlEarly = document.querySelectorAll('#gp-diff .dx-gap-btn').length;
      const mark = __dx.heads()[0];
      if (mark) mark.__dxMark = 1;
      const t0 = Date.now();
      while (!document.querySelector('#gp-diff .dx-gap-tail') && Date.now() - t0 < 4000) await new Promise((x) => setTimeout(x, 40));
      return { early, ctrlEarly, tail: document.querySelectorAll('#gp-diff .dx-gap-tail').length, same: !!mark && __dx.heads()[0] === mark && mark.__dxMark === 1 };
    })()`);
    t(r.early === 0 && r.ctrlEarly > 0, 'before the answer: controls above, no tail ' + J(r));
    t(r.tail === 1, 'tail control after the answer ' + J(r));
    t(r.same, 'no repaint of the rows when the tail lands');
    const n0 = await j(`__dx.nrows()`);
    t(await click(`__dx.tailBtn(${J(ALL_LABEL)})`), 'tail all button');
    t(await waitFor(`!document.querySelector('#gp-diff .dx-gap-tail')`, 3000), 'tail control gone after the pick');
    const s = await j(`({ h: __dx.texts()[2], n: __dx.nrows() })`);
    t(/^@@ -107,14 \+107,14 @@/.test(s.h || ''), 'last header ' + s.h);
    t(s.n === n0 + 7, `rows ${n0} -> ${s.n}`);
  });

  await gate('p5_capped_no_tail', async (t) => {
    await fmt('line-by-line');
    t((await open('big.txt', 'unstaged')) >= 0, 'row big.txt');
    t(await waitFor(`!!document.querySelector('#gp-diff .gp-capped')`, 4000), 'capped banner');
    await sleep(700);
    t((await count('#gp-diff .dx-gap-btn')) > 0, 'a control above the first hunk');
    t((await count('#gp-diff .dx-gap-tail')) === 0, 'no tail control on a capped diff');
  });

  await gate('p6_staged_row_uses_index', async (t) => {
    await fmt('line-by-line');
    t((await open('s.txt', 'staged')) >= 0, 'staged row s.txt');
    const h = (await texts())[0];
    t(await click(`__dx.btn(0, ${J(UP)})`), 'up button');
    t(await headChanged(0, h), 'header changes (a splice, not a drift notice)');
    const s = await j(`({ h: __dx.texts()[0], c: __dx.ctxTexts(), note: document.querySelectorAll('#gp-diff .dx-gap-notice').length })`);
    t(/^@@ -27,27 \+27,27 @@/.test(s.h || ''), 'header ' + s.h);
    t(s.c.includes('s40') && !s.c.includes('WT40'), 'the spliced rows come from the index blob, not the worktree');
    t(s.note === 0, 'no notice');
  });

  await gate('p9_no_control_added_deleted_untracked_binary', async (t) => {
    await fmt('line-by-line');
    t((await open('m.txt', 'unstaged')) >= 0 && (await waitFor(`document.querySelectorAll('#gp-diff .dx-gap-btn').length > 0`)), 'precondition: the modified file has controls');
    for (const [p, kind] of [['a.txt', 'staged'], ['d.txt', 'unstaged'], ['u.txt', 'untracked'], ['bin.dat', 'unstaged']]) {
      t((await open(p, kind)) >= 0, `row ${p}`);
      await sleep(500);
      const s = await j(`({ ctrl: document.querySelectorAll('#gp-diff .dx-gap, #gp-diff .dx-gap-tail, #gp-diff .dx-gap-btn').length,
        table: !!document.querySelector('#gp-diff .d2h-diff-table'), empty: (document.querySelector('#gp-diff .gp-empty') || {}).textContent || '' })`);
      t(s.ctrl === 0, `${p}: no control ` + J(s));
      t(p === 'bin.dat' ? /binaire/.test(s.empty) : s.table, `${p}: shape ` + J(s));
    }
  });

  await gate('p10_symlink_row_no_control', async (t) => {
    await fmt('line-by-line');
    t((await open('m.txt', 'unstaged')) >= 0 && (await waitFor(`document.querySelectorAll('#gp-diff .dx-gap-btn').length > 0`)), 'precondition: the modified file has controls');
    t((await open('link', 'untracked')) >= 0, 'row link');
    await sleep(500);
    const s = await j(`({ ctrl: document.querySelectorAll('#gp-diff .dx-gap, #gp-diff .dx-gap-tail, #gp-diff .dx-gap-btn').length, empty: (document.querySelector('#gp-diff .gp-empty') || {}).textContent || '' })`);
    t(s.ctrl === 0 && /lien symbolique/.test(s.empty), J(s));
  });

  await gate('p11_drift_notice', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    t(await tailUp(), 'tail control');
    const before = await j(`({ n: __dx.heads().length, r: __dx.nrows(), h: __dx.texts()[0] })`);
    try {
      fs.writeFileSync(path.join(LOCAL, 'm.txt'), M_TEXT.replace('m28\n', 'DRIFT28\n'));
      t(await click(`__dx.btn(0, ${J(UP)})`), 'up button');
      t(await waitFor(`!!document.querySelector('#gp-diff .dx-gap-notice')`, 3000), 'notice shown');
      await sleep(300);
      const s = await j(`({ note: (document.querySelector('#gp-diff .dx-gap-notice') || {}).textContent, n: __dx.heads().length, r: __dx.nrows(), h: __dx.texts()[0] })`);
      t(s.note === 'Fichier modifié depuis le diff — rafraîchir', 'notice text ' + J(s.note));
      t(s.n === before.n && s.r === before.r && s.h === before.h, 'nothing spliced ' + J([before, s]));
    } finally {
      fs.writeFileSync(path.join(LOCAL, 'm.txt'), M_TEXT);
    }
  });

  await gate('p12_fold_after_expand', async (t) => {
    await fmt('side-by-side');
    await open('m.txt', 'unstaged');
    t(await waitFor(`document.querySelectorAll('#gp-diff .dx-gap-tail').length === 2`), 'tail row in both columns');
    const h1 = (await texts())[1];
    t(await click(`__dx.btn(1, ${J(UP)})`), 'up button on hunk 1');
    t(await headChanged(1, h1), 'spliced');
    await j(`__dx.fold(0)`);
    const folded = await j(`__dx.pattern()`);
    t(folded.length === 2 && folded[0] === folded[1] && folded[0].includes('1'), 'both columns fold the same rows ' + J(folded));
    await j(`__dx.fold(0)`);
    const open0 = await j(`__dx.pattern()`);
    t(open0.every((p) => !p.includes('1')), 'unfold restores every row');
    await fmt('line-by-line');
  });

  await gate('p13_fold_kept_by_header_text', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    await j(`__dx.fold(0)`);
    await j(`__dx.fold(2)`);
    const before = await texts();
    t(await click(`__dx.btn(0, ${J(UP)})`), 'up button on the folded hunk 0');
    t(await headChanged(0, before[0]), 'spliced');
    const s = await j(`(() => { const h = __dx.heads(); return { t: __dx.texts(), f: h.map((x) => x.classList.contains('gp-folded')),
      rowsFolded: [...h[2].parentElement.rows].filter((r) => r.classList.contains('gp-hunk-folded')).length,
      h0Folded: [...h[0].parentElement.rows].slice(0, [...h[0].parentElement.rows].indexOf(h[1])).filter((r) => r.classList.contains('gp-hunk-folded')).length }; })()`);
    t(s.t[1] === before[1] && s.t[2] === before[2] && s.t[0] !== before[0], 'only hunk 0 changed its header ' + J(s.t));
    t(s.f[0] === false && s.f[1] === false && s.f[2] === true, 'hunk 2 stays folded, hunk 0 (new header) and 1 are open ' + J(s.f));
    t(s.rowsFolded > 0 && s.h0Folded === 0, 'folded rows follow ' + J(s));
  });

  await gate('p14_split_view_expand', async (t) => {
    await fmt('side-by-side');
    await open('m.txt', 'unstaged');
    t(await waitFor(`document.querySelectorAll('#gp-diff .dx-gap-tail').length === 2`), 'tail row in both columns');
    const h1 = (await texts())[1];
    t(await click(`__dx.btn(1, ${J(UP)})`), 'up button on hunk 1');
    t(await headChanged(1, h1), 'spliced');
    const s = await j(`({ sides: document.querySelectorAll('#gp-diff .d2h-file-side-diff').length,
      rows: [...document.querySelectorAll('#gp-diff .d2h-diff-table')].map((tb) => tb.querySelectorAll(':scope > tbody > tr').length),
      tails: document.querySelectorAll('#gp-diff .dx-gap-tail').length, h: __dx.texts()[1] })`);
    t(s.sides === 2 && s.rows.length === 2 && s.rows[0] === s.rows[1], 'two aligned columns ' + J(s));
    t(s.tails === 2, 'tail row kept in both ' + J(s));
    t(/^@@ -47,27 \+47,27 @@/.test(s.h || ''), 'header ' + s.h);
    await fmt('line-by-line');
  });

  await gate('p15_keep_scroll', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    t(await tailUp(), 'tail control');
    const h1 = (await texts())[1];
    t(await click(`__dx.btn(1, ${J(UP)})`), 'up button on hunk 1');
    t(await headChanged(1, h1), 'spliced');
    const sc = await j(`(() => { const d = __dx.diffEl(); d.scrollTop = 120; return { max: d.scrollHeight - d.clientHeight, top: d.scrollTop }; })()`);
    t(sc.max > 200 && Math.abs(sc.top - 120) <= 1, 'the diff scrolls ' + J(sc));
    const h2 = (await texts())[2];
    t(await click(`__dx.btn(2, ${J(UP)})`), 'up button on hunk 2');
    t(await headChanged(2, h2), 'spliced again');
    const top = await j(`__dx.diffEl().scrollTop`);
    t(Math.abs(top - 120) <= 2, 'scrollTop kept ' + top);
  });

  await gate('p16_format_switch_keeps_expansion', async (t) => {
    await fmt('line-by-line');
    await open('m.txt', 'unstaged');
    t(await tailUp(), 'tail control');
    const h1 = (await texts())[1];
    t(await click(`__dx.btn(1, ${J(UP)})`), 'up button on hunk 1');
    t(await headChanged(1, h1), 'spliced');
    const s = await j(`(() => {
      const before = __dx.texts();
      const mark = __dx.heads()[0];
      document.querySelector('#gp-diffc .dv-seg button[data-format="side-by-side"]').click();
      return { fmt: gp.lastRender.format, before, after: __dx.texts(), tails: document.querySelectorAll('#gp-diff .dx-gap-tail').length,
        redrawn: !!mark && mark !== __dx.heads()[0], fl: gp.lastRender.res.fileLines };
    })()`);
    t(s.fmt === 'side-by-side' && s.redrawn, 're-rendered in the new format, same call ' + J(s));
    t(JSON.stringify(s.before) === JSON.stringify(s.after) && /^@@ -47,27 \+47,27 @@/.test(s.after[1] || ''), 'the spliced rows survive ' + J(s));
    t(s.tails === 2 && s.fl === 120, 'the tail control is there with no new answer ' + J(s));
    await fmt('line-by-line');
  });

  await gate('p17_stale_prefetch_dropped', async (t) => {
    await fmt('line-by-line');
    await j(`(async () => { await __dx.open('m.txt', 'unstaged'); await __dx.open('s.txt', 'staged'); return true; })()`);
    await sleep(900);
    const s = await j(`({ path: gp.lastRender.row.path, kind: gp.lastRender.row.kind, fl: gp.lastRender.res.fileLines, n: __dx.heads().length,
      tails: document.querySelectorAll('#gp-diff .dx-gap-tail').length, h: __dx.texts()[0] })`);
    t(s.path === 's.txt' && s.kind === 'staged' && s.fl === 100 && s.n === 1 && s.tails === 1 && /^@@ -47,7 \+47,7 @@/.test(s.h), J(s));
  });

  await gate('p18_splice_cap_notice', async (t) => {
    await fmt('line-by-line');
    t((await open('long.txt', 'unstaged')) >= 0, 'row long.txt');
    t(await tailUp(), 'tail control');
    const before = await j(`({ n: __dx.heads().length, r: __dx.nrows(), t: __dx.texts() })`);
    t(await click(`__dx.btn(1, ${J(ALL_LABEL)})`), 'all button on hunk 1');
    t(await waitFor(`!!document.querySelector('#gp-diff .dx-gap-notice')`, 3000), 'notice shown');
    await sleep(300);
    const s = await j(`({ note: (document.querySelector('#gp-diff .dx-gap-notice') || {}).textContent, n: __dx.heads().length, r: __dx.nrows(), t: __dx.texts() })`);
    t(s.note === 'Diff trop long — ouvre le fichier', 'notice text ' + J(s.note));
    t(s.n === before.n && s.r === before.r && JSON.stringify(s.t) === JSON.stringify(before.t), 'nothing spliced ' + J([before, s]));
    t(await click(`__dx.btn(1, ${J(UP)})`), 'up button on hunk 1');
    t(await headChanged(1, before.t[1]), 'a pick under the cap splices');
    const h = (await texts())[1];
    t(/^@@ -1667,27 \+1667,27 @@/.test(h || ''), 'header ' + h);
  });

  await gate('p7_commit_row', async (t) => {
    await j(`document.querySelector('#glog-diff .glog-diff-back') && document.querySelector('#glog-diff .glog-diff-back').click()`);
    await sleep(200);
    t(await click(`[...document.querySelectorAll('#glog-log button[data-key]')].find((b) => b.dataset.key === ${J(COMMIT_SHA)})`), 'commit row in the log');
    t(await waitFor(`!!document.querySelector('#glog-commit button.glog-file[data-path="c.txt"]')`, 5000), 'commit detail lists c.txt');
    t(await click(`document.querySelector('#glog-commit button.glog-file[data-path="c.txt"]')`), 'open the commit file');
    t(await waitFor(`!!document.querySelector('#gp-diff .d2h-diff-table')`, 4000), 'diff painted');
    t(await tailUp(), 'tail control');
    const h = (await texts())[0];
    t(await click(`__dx.btn(0, ${J(UP)})`), 'up button');
    t(await headChanged(0, h), 'spliced');
    const s = await j(`({ h: __dx.texts()[0], c: __dx.ctxTexts() })`);
    t(/^@@ -7,27 \+7,27 @@/.test(s.h || ''), 'header ' + s.h);
    t(s.c.includes('c10') && !s.c.includes('WT10'), 'the spliced rows come from the commit blob, not the worktree');
  });

  await gate('p8_lot_row', async (t) => {
    await j(`closeSidePanel()`);
    await sleep(300);
    await j(`openGitPanel({ sessionId: ${J(LOT_SID)} })`);
    t(await waitFor(`!!gp.rows && gp.rows.some((r) => r.wt && r.path === 'm.txt')`, 8000), 'lot row m.txt');
    await sleep(500);
    await fmt('line-by-line');
    t((await open('m.txt', null, '*')) >= 0, 'open the lot row');
    t(await tailUp(), 'tail control');
    const h = (await texts())[0];
    t(await click(`__dx.btn(0, ${J(UP)})`), 'up button');
    t(await headChanged(0, h), 'spliced');
    const s = await j(`({ h: __dx.texts()[0], c: __dx.ctxTexts() })`);
    t(/^@@ -7,27 \+7,27 @@/.test(s.h || ''), 'header ' + s.h);
    t(s.c.includes('m10') && s.c.includes('LOT30'), 'the spliced rows come from the lot worktree');
  });

  return { g, detail };
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 280s'); app.exit(2); }, 280000);
  let out = { g: {}, detail: { error: 'no run' } };
  try {
    const fx = buildOracle();
    await new Promise((r) => setTimeout(r, 1500));
    const win = BrowserWindow.getAllWindows()[0];
    out = await win.webContents.executeJavaScript(`(${inPage.toString()})(${JSON.stringify(GATES)}, ${JSON.stringify(fx)})`, true);
  } catch (e) {
    out.detail = { error: String(e) };
  }
  try {
    const git = await gitSection(BrowserWindow.getAllWindows()[0]);
    out = { g: { ...out.g, ...git.g }, detail: { ...out.detail, ...git.detail } };
  } catch (e) {
    out.detail = { ...out.detail, gitError: String((e && e.stack) || e) };
  }
  GATES.push(...PGATES); // the t gates already ran in the page: the printed list and the count now include p1-p18
  clearTimeout(watchdog);
  console.log('DETAIL: ' + JSON.stringify(out.detail));
  let pass = 0;
  for (const n of GATES) {
    const ok = out.g[n] === true;
    if (ok) pass += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
  }
  console.log(pass === GATES.length ? `VERDICT: ALL GREEN (${pass}/${GATES.length})` : `VERDICT: ${GATES.length - pass} FAIL (${pass}/${GATES.length})`);
  app.exit(pass === GATES.length ? 0 : 1);
});
