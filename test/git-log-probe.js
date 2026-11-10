// test/git-log-probe.js — E2E probe: the git log view of the side panel (deck-git-log, contract § 6.2, 64 gates).
// Written RED first (lot P1): later lots turn the gates GREEN one by one. Every gate asserts positive evidence
// (an element, an answer, a value), so a gate cannot pass on code that lacks the feature.
// Fixture: test/_git-log-fixture.js (throwaway repos, fake session transcripts). Run (contract § 0 PROBE_ENV):
//   env -u OPENAI_API_KEY ... CLAUDE_DECK_ASK_DIR=$(mktemp -d) ... xvfb-run -a -s "-screen 0 5120x2880x24" \
//     node_modules/.bin/electron test/git-log-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeGitLogFixture } = require('./_git-log-fixture');

const GATES = [
  'h_fixture', 'h_boot',
  'ipc_refs_lists', 'ipc_refs_trunk',
  'ipc_log_order', 'ipc_log_mergebase', 'ipc_log_chips',
  'ipc_log_level', 'ipc_log_trunk_view', 'ipc_log_paging',
  'ipc_state', 'ipc_no_counter', 'ipc_state_no_remote',
  'ipc_guard_ref', 'ipc_guard_dash', 'ipc_guard_page', 'ipc_readonly',
  'ipc_commit_files', 'ipc_commit_message', 'ipc_commit_root', 'ipc_commit_diff',
  'ipc_guard_sha', 'ipc_guard_path', 'ipc_pathspec_literal', 'ipc_pathspec_subdir',
  'd1_no_compare_ui', 'ws_parent_cwd', 'd3d_no_counter',
  'a5_badge', 'd6_state_never', 'd6_state_level', 'd6_state_ahead', 'ui_state_no_remote',
  'a11_automax', 'a11_restore',
  'd2_wip_lists', 'd3a_order', 'd3b_join', 'd3c_chips', 'd4_level', 'd5_trunk_view',
  'a7_legend', 'a7_filter', 'a7_more',
  'd8_lists', 'd8_search', 'd8_pick_shows', 'd8_readonly',
  'a12_follow_head', 'a12_pinned_stays',
  'd9_xss_subject', 'd9_xss_ref',
  'd10_no_left_accent', 'd10_tokens', 'd10_motion',
  'd7_diff_open_wt', 'd7_files_grouped', 'd7_message', 'd7_diff_open', 'd7_back',
  'a8_kicker', 'a8_copy', 'd9_xss_message',
  'd11_enter_buttons', 'd12_enter_selected_diff', 'd2_wip_gone_after_commit', 'd13_clean_refresh_keeps_commit_diff',
];
if (GATES.length !== 67 || new Set(GATES).size !== 67) throw new Error('the gate list must hold 67 distinct ids');
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

// ---- fixture + seams (BEFORE app boot) -----------------------------------------------------------
const fx = makeGitLogFixture();
const { sha, sid } = fx;
const SHELL_SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shim-')), 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(fx.base, 'projects');
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-glog-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-glog-status-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const { app, BrowserWindow, clipboard } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();
const I4_TEXT = /[↑↓]\s*\d|d'avance|de retard|\b\d+\s+commits?\s+(devant|derrière|en avance|en retard)/;
const norm = (s) => (typeof s === 'string' ? s.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim() : s);

// what a commit of f1 must list (status, added lines, deleted lines)
const EXP_FILES = {
  'src/a/one.js': ['M', 1, 0], 'src/a/two.js': ['A', 1, 0], 'src/a/a*.js': ['A', 1, 0], 'src/a/ab.js': ['A', 1, 0],
  'app/[slug]/page.tsx': ['A', 1, 0], 'app/s/page.tsx': ['A', 1, 0], 'docs/old.md': ['D', 0, 1],
};
const EXP_DIRS = (() => {
  const m = {};
  for (const p of Object.keys(EXP_FILES)) (m[p.split('/').slice(0, -1).join('/')] ||= []).push(p);
  return Object.entries(m).map(([dir, files]) => ({ dir, files: files.sort() })).sort((a, b) => (a.dir < b.dir ? -1 : 1));
})();

// ---- page-side functions (serialised with toString, run in the renderer) ---------------------------
const prInit = () => {
  window.__pr = {
    shown: (el) => !!el && !el.hidden && el.getClientRects().length > 0,
    txt: (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null),
    keys: () => [...document.querySelectorAll('#glog-log .glog-row')].map((r) => r.dataset.key),
    row: (k) => document.querySelector('#glog-log .glog-row[data-key="' + k + '"]'),
    shownKeys: () => [...document.querySelectorAll('#glog-log .glog-row')].filter((r) => window.__pr.shown(r)).map((r) => r.dataset.key),
  };
  return true;
};

const filesInfo = () => {
  const root = document.getElementById('glog-commit');
  return {
    head: [...root.querySelector('.glog-files-head').children].map((c) => window.__pr.txt(c)).filter(Boolean).join(' '),
    dirs: [...root.querySelectorAll('.glog-dir')].map((d) => ({
      dir: d.dataset.dir, files: [...d.querySelectorAll('button.glog-file')].map((b) => b.dataset.path).sort(),
    })).sort((a, b) => (a.dir < b.dir ? -1 : 1)),
    files: [...root.querySelectorAll('button.glog-file')].map((b) => ({
      path: b.dataset.path,
      s: ((b.querySelector('.dv-pill') && b.querySelector('.dv-pill').getAttribute('data-s')) || '').toUpperCase(),
      text: b.textContent,
    })),
  };
};

const accentBarInfo = () => {
  const els = [...document.querySelectorAll('#glog-log *, #glog-refs *, #glog-detail *, #gp-head *')]
    .filter((el) => !el.closest('#gp-files, #gp-diff'));
  const bars = [];
  const opaque = (c) => c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c);
  for (const el of els) {
    const cs = getComputedStyle(el);
    const w = parseFloat(cs.borderLeftWidth) || 0;
    if (w >= 2 && cs.borderLeftStyle !== 'none' && opaque(cs.borderLeftColor) && w > (parseFloat(cs.borderRightWidth) || 0)) bars.push('border:' + (el.className || el.tagName));
    for (const layer of (cs.boxShadow || '').split(/,(?![^()]*\))/)) {
      const m = layer.match(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/);
      if (m && /inset/.test(layer) && parseFloat(m[1]) >= 2 && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0) bars.push('shadow:' + (el.className || el.tagName));
    }
    if (el.matches('.glog-row, .glog-chip, .glog-ref, #glog-detail, #glog-log, #glog-refs')) {
      for (const pseudo of ['::before', '::after']) {
        const p = getComputedStyle(el, pseudo);
        const h = el.getBoundingClientRect().height;
        if (p.content !== 'none' && p.position === 'absolute' && parseFloat(p.width) >= 1 && parseFloat(p.width) <= 6
          && parseFloat(p.height) >= 0.6 * h && (parseFloat(p.left) || 0) <= 1 && opaque(p.backgroundColor)) bars.push(pseudo + ':' + (el.className || el.id));
      }
    }
  }
  return { n: els.length, rows: document.querySelectorAll('#glog-log .glog-row').length, bars };
};

const tokenInfo = () => {
  const root = getComputedStyle(document.documentElement);
  const tok = (n) => root.getPropertyValue(n).trim().toLowerCase();
  const colourOf = (v) => { const s = document.createElement('span'); s.style.color = v; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  const allowed = new Set(['var(--text)', 'var(--text-muted)', 'var(--text-faint)', 'var(--accent)', 'var(--accent-hover)', 'var(--c-text)',
    'var(--c-muted)', 'var(--c-accent)', 'var(--c-indigo)', 'color-mix(in srgb, var(--c-indigo), white 40%)', 'var(--c-ok)', 'var(--c-del)',
    'var(--c-waiting)', 'var(--c-on-accent)', 'var(--ink-2)', 'var(--s-agent)', 'color-mix(in srgb, var(--s-agent), white 40%)', 'var(--s-ok)',
    'var(--s-del)'].map(colourOf));
  const els = [...document.querySelectorAll('[class*="glog-"]')].filter((el) => !el.closest('#gp-files, #gp-diff')
    && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  const off = els.filter((el) => !allowed.has(getComputedStyle(el).color)).map((el) => el.className + '=' + getComputedStyle(el).color);
  return { indigo: tok('--s-agent'), del: tok('--s-del'), n: els.length, off: off.slice(0, 6) };
};

const motionInfo = () => {
  const ok = new Set(['transform', 'opacity']);
  const els = [...document.querySelectorAll('[class*="glog-"], [id^="glog-"]')];
  const bad = [];
  const names = new Set();
  for (const el of els) {
    const cs = getComputedStyle(el);
    const props = cs.transitionProperty.split(',').map((s) => s.trim());
    const durs = cs.transitionDuration.split(',').map((s) => (s.trim().endsWith('ms') ? parseFloat(s) / 1000 : parseFloat(s)));
    props.forEach((p, i) => { if (durs[i % durs.length] > 0 && !ok.has(p)) bad.push((el.className || el.id) + ':' + p); });
    if (cs.animationName && cs.animationName !== 'none') cs.animationName.split(',').forEach((n) => names.add(n.trim()));
  }
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules) {
      if (r.type === CSSRule.KEYFRAMES_RULE && names.has(r.name)) {
        for (const kf of r.cssRules) for (const p of kf.style) if (!ok.has(p) && p !== 'animation-timing-function') bad.push('@' + r.name + ':' + p);
      }
    }
  }
  return { n: els.length, bad: bad.slice(0, 6) };
};

// ---- the run ---------------------------------------------------------------------------------------
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('watchdog: probe stuck for 330 s'); report(); app.exit(2); }, 330000);
  try { await run(); } catch (e) { console.log('probe error: ' + String((e && e.stack) || e)); }
  clearTimeout(watchdog);
  const green = report();
  try { fx.cleanup(); } catch (_) { /* tmp */ }
  app.exit(green ? 0 : 1);
});

async function run() {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const j = (code) => win.webContents.executeJavaScript(code, true);
  const inPage = (fn, ...args) => j(`(${fn.toString()})(...${J(args)})`);
  let noLog = false; // no `.glog-row` after an open: the UI is absent, later waits stay short
  const waitFor = async (code, ms) => {
    const lim = noLog ? Math.min(ms ?? 6000, 300) : (ms ?? 6000);
    const t0 = Date.now();
    for (;;) {
      const v = await j(code).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > lim) return false;
      await sleep(80);
    }
  };
  const gate = async (id, fn) => {
    try { results[id] = !!(await fn()); } catch (e) { results[id] = false; detail[id] = String((e && e.message) || e).split('\n')[0].slice(0, 120); }
  };
  const apiOk = new Map();
  const ipc = async (fn, ...exprs) => {
    if (!apiOk.has(fn)) apiOk.set(fn, await j(`typeof window.api.${fn} === 'function'`));
    if (!apiOk.get(fn)) throw new Error(`window.api.${fn} is missing`);
    return j(`window.api.${fn}(${exprs.join(', ')})`);
  };
  const tgt = (s) => J({ sessionId: s, repoIndex: 0 });
  const T = { main: tgt(sid.main), parent: tgt(sid.parent), src: tgt(sid.src), noremote: tgt(sid.noremote) };
  const refsOf = (t = T.main) => ipc('gitRefs', t);
  const logRaw = (refExpr, pageExpr = '0', t = T.main) => ipc('gitLog', t, refExpr, pageExpr);
  const logRef = (ref, page = 0, t = T.main) => logRaw(J(ref), String(page), t);
  const commitOf = (shaExpr, t = T.main) => ipc('gitCommit', t, shaExpr);
  const cdiff = (shaExpr, fileExpr, full = 'false', t = T.main) => ipc('gitCommitDiff', t, shaExpr, fileExpr, full);
  const refused = (r, reason) => !!r && r.ok === false && r.reason === reason;
  const featX = { kind: 'local', name: 'feat/x' };

  // ---- harness gates ------------------------------------------------------------------------------
  await gate('h_boot', async () => {
    await waitFor(`typeof openGitPanel === 'function' && typeof gp === 'object'`, 8000);
    return j(`typeof openGitPanel === 'function' && typeof gp === 'object' && typeof closeSidePanel === 'function'
      && typeof window.api.gitStatus === 'function' && !!document.getElementById('git-panel') && !!document.getElementById('gp-files')`);
  });
  await j(`(${prInit.toString()})()`).catch(() => {});

  await gate('h_fixture', async () => {
    const f2 = fx.truth(sha.f2, '%s');
    const f1body = fx.truth(sha.f1, '%B').replace(/\n+$/, '');
    const status = fx.out(fx.clone, 'status', '--porcelain', '-uall').split('\n').sort(); // -uall: the folder notes/ is listed by file
    const probes = [
      ['f2 subject read back with U+001E and U+001F', f2 === fx.F2_SUBJECT && f2.includes('\u001e') && f2.includes('\u001f') && f2.endsWith('end')],
      ['f1 body line 3', f1body.endsWith(fx.F1_BODY[2])],
      ['HEAD is feat/x', fx.out(fx.clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feat/x'],
      ['head rows', eq(status, [' M src/a/one.js', '?? notes/new.txt'])],
      ['origin/develop = mb + 3', fx.out(fx.clone, 'rev-parse', 'origin/develop') === sha.d3
        && fx.out(fx.clone, 'rev-parse', 'origin/develop~3') === sha.mb && fx.out(fx.clone, 'rev-parse', 'develop') === sha.mb],
      ['develop first-parent depth', Number(fx.out(fx.clone, 'rev-list', '--count', '--first-parent', 'origin/develop')) === 66],
      ['tags', fx.out(fx.clone, 'cat-file', '-t', 'v1.0') === 'tag' && fx.out(fx.clone, 'cat-file', '-t', 'lite') === 'commit'],
      ['tags without history', fx.out(fx.clone, 'cat-file', '-t', 'blobtag') === 'blob'
        && fx.out(fx.clone, 'cat-file', '-t', 'treetag') === 'tag' && fx.out(fx.clone, 'rev-parse', 'treetag^{tree}') === sha.tree],
      ['nested tag', fx.out(fx.clone, 'cat-file', '-t', 'nested') === 'tag' && fx.out(fx.clone, 'rev-parse', 'nested^{commit}') === sha.c1
        && fx.out(fx.clone, 'rev-parse', 'nested') !== fx.out(fx.clone, 'rev-parse', 'v1.0')],
      ['gone upstream', fx.out(fx.clone, 'for-each-ref', '--format=%(upstream:track)', 'refs/heads/gone-up') === '[gone]'
        && fx.out(fx.clone, 'for-each-ref', 'refs/remotes/origin/gone-up') === ''],
      ['branches', eq(sorted(fx.out(fx.clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')),
        sorted(['develop', 'feat/x', 'feat/level', 'feat/ahead', 'gone-up', fx.EVIL_REF]))],
      ['feat/x has no upstream', fx.out(fx.clone, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feat/x') === ''],
      ['feat/ahead is 1 past its upstream', fx.out(fx.clone, 'rev-parse', 'origin/feat/ahead') === sha.ah1 && fx.out(fx.clone, 'rev-parse', 'feat/ahead') === sha.ah2],
      ['noremote has no remote', fx.out(fx.noremote, 'remote') === '' && Number(fx.out(fx.noremote, 'rev-list', '--count', 'HEAD')) === 2],
      ['f1 touches 7 files', fx.out(fx.clone, 'diff', '--no-renames', '--name-status', `${sha.f1}^1`, sha.f1).split('\n').length === 7],
    ];
    const failed = probes.filter(([, ok]) => !ok).map(([n]) => n);
    if (failed.length) detail.h_fixture = failed.join('; ').slice(0, 120);
    return failed.length === 0;
  });
  const snapStart = fx.snapshot();

  // ---- IPC gates: git-panel-refs / git-panel-log (L1) -----------------------------------------------
  await gate('ipc_refs_lists', async () => {
    const r = await refsOf();
    const names = (a) => sorted(a.map((x) => x.name));
    return r.ok === true && r.root === fx.clone && r.repo === path.basename(fx.clone)
      && eq(sorted(Object.keys(r)), ['head', 'locals', 'ok', 'remotes', 'repo', 'root', 'tags', 'trunk'])
      && eq(Object.keys(r.head), ['branch']) && r.head.branch === 'feat/x'
      && eq(names(r.locals), sorted(['develop', 'feat/x', 'feat/level', 'feat/ahead', 'gone-up', fx.EVIL_REF]))
      && eq(r.locals.filter((l) => l.head).map((l) => l.name), ['feat/x'])
      && r.locals.every((l) => eq(sorted(Object.keys(l)), ['head', 'name']))
      && eq(names(r.remotes), ['origin/develop', 'origin/feat/ahead', 'origin/feat/level'])
      && r.remotes.every((x) => eq(Object.keys(x), ['name']))
      && eq(names(r.tags), ['lite', 'nested', 'v1.0']) && r.tags.every((x) => eq(Object.keys(x), ['name']));
  });
  await gate('ipc_refs_trunk', async () => {
    const r = await refsOf();
    const n = await refsOf(T.noremote);
    return r.ok === true && eq(r.trunk, { family: 'develop', local: 'develop', origin: 'origin/develop' })
      && n.ok === true && eq(n.trunk, { family: 'main', local: 'main', origin: null });
  });
  await gate('ipc_log_order', async () => {
    const a = await logRef(featX, 0);
    if (!a.ok || a.rows.length !== 50) return false;
    const exp = fx.expect.featX;
    for (let i = 0; i < 50; i++) {
      const row = a.rows[i];
      const t = (f) => fx.truth(row.sha, f);
      if (row.sha !== exp[i].sha || row.seg !== exp[i].seg) return false;
      if (!Array.isArray(row.parents) || row.parents.join(' ') !== t('%P')) return false;
      if (row.author !== t('%an') || row.date !== t('%aI') || row.subject !== t('%s')) return false;
      if (row.seg === 'trunk-only' && row.inLocal !== false) return false;
    }
    const f2 = a.rows.find((r) => r.sha === sha.f2);
    return !!f2 && f2.subject === fx.F2_SUBJECT && f2.subject.includes('\u001e') && f2.subject.includes('\u001f');
  });
  await gate('ipc_log_mergebase', async () => {
    const a = await logRef(featX, 0);
    return a.ok === true && a.view === 'branch' && a.mergeBase === sha.mb && a.target === 'origin/develop' && a.isHead === true
      && a.ref.kind === 'local' && a.ref.name === 'feat/x' && a.ref.sha === sha.f2
      && (a.rows.find((r) => r.seg === 'shared') || {}).sha === sha.mb;
  });
  await gate('ipc_log_chips', async () => {
    const a = await logRef(featX, 0);
    if (!a.ok) return false;
    const has = (s, kind, text) => (a.chips[s] || []).some((c) => c.kind === kind && c.text === text);
    const kinds = new Set(Object.values(a.chips).flat().map((c) => c.kind));
    const nest = await logRef({ kind: 'tag', name: 'nested' }, 0); // a tag of a tag: the tip is the commit, one level deeper
    const dead = [await logRef({ kind: 'tag', name: 'blobtag' }, 0), await logRef({ kind: 'tag', name: 'treetag' }, 0)];
    return has(sha.f2, 'branch', 'feat/x') && has(sha.mb, 'develop', 'develop') && has(sha.d3, 'origin-develop', 'origin/develop')
      && !kinds.has('origin') && [...kinds].every((k) => ['branch', 'origin', 'develop', 'origin-develop'].includes(k))
      && nest.ok === true && nest.ref.sha === sha.c1 && nest.rows.some((r) => r.sha === sha.c1)
      && (nest.chips[sha.c1] || []).some((c) => c.kind === 'branch' && c.text === 'nested')
      && dead.every((d) => refused(d, 'ref')); // a tag of a blob or a tree has no history to show
  });
  await gate('ipc_log_level', async () => {
    const a = await logRef({ kind: 'local', name: 'feat/level' }, 0);
    if (!a.ok) return false;
    const has = (s, kind, text) => (a.chips[s] || []).some((c) => c.kind === kind && c.text === text);
    return a.view === 'branch' && a.mergeBase === sha.d3 && a.rows.filter((r) => r.seg === 'trunk-only').length === 0
      && eq(a.rows.filter((r) => r.seg === 'branch').map((r) => r.sha), [sha.lv1])
      && has(sha.lv1, 'branch', 'feat/level') && has(sha.lv1, 'origin', 'origin');
  });
  await gate('ipc_log_trunk_view', async () => {
    const l = await logRef({ kind: 'local', name: 'develop' }, 0);
    const o = await logRef({ kind: 'remote', name: 'origin/develop' }, 0);
    if (!l.ok || !o.ok) return false;
    const shape = (a, exp) => eq(a.rows.map((r) => [r.sha, r.seg]), exp.slice(0, 50).map((e) => [e.sha, e.seg]));
    return l.view === 'trunk' && l.isHead === false && shape(l, fx.expect.trunkLocal)
      && o.view === 'trunk' && shape(o, fx.expect.trunkOrigin);
  });
  await gate('ipc_log_paging', async () => {
    const p0 = await logRef(featX, 0);
    const p1 = await logRef(featX, 1);
    const p1000 = await logRef(featX, 1000);
    if (!p0.ok || !p1.ok) return false;
    const exp = fx.expect.featX.map((e) => e.sha);
    return p0.rows.length === 50 && p0.more === true && eq(p1.rows.map((r) => r.sha), exp.slice(50)) && p1.more === false
      && new Set([...p0.rows, ...p1.rows].map((r) => r.sha)).size === exp.length && !refused(p1000, 'page');
  });
  await gate('ipc_state', async () => {
    const st = async (ref) => (await logRef(ref, 0)).state;
    const tag = await logRef({ kind: 'tag', name: 'v1.0' }, 0);
    const gone = await logRef({ kind: 'local', name: 'gone-up' }, 0); // upstream configured, absent from origin: unknown, never « never »
    return (await st(featX)) === 'never' && (await st({ kind: 'local', name: 'feat/level' })) === 'level'
      && (await st({ kind: 'local', name: 'feat/ahead' })) === 'diverged' && (await st({ kind: 'local', name: 'develop' })) === 'trunk-behind'
      && (await st({ kind: 'remote', name: 'origin/develop' })) === null && tag.ok === true && tag.state === null && tag.ref.sha === sha.c1
      && gone.ok === true && gone.state === null;
  });
  await gate('ipc_no_counter', async () => {
    const answers = [await refsOf(), await logRef(featX), await logRef({ kind: 'local', name: 'feat/level' }),
      await logRef({ kind: 'local', name: 'feat/ahead' }), await logRef({ kind: 'local', name: 'develop' }), await logRef({ kind: 'remote', name: 'origin/develop' })];
    if (!answers.every((a) => a && a.ok === true)) return false;
    const bad = [];
    const walk = (v) => {
      if (typeof v === 'string') { if (I4_TEXT.test(v)) bad.push(v.slice(0, 30)); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/ahead|behind/i.test(k)) bad.push(k); walk(x); }
    };
    answers.forEach(walk);
    return bad.length === 0;
  });
  await gate('ipc_state_no_remote', async () => {
    const m = await logRef({ kind: 'local', name: 'main' }, 0, T.noremote);
    const h = await logRef({ kind: 'head' }, 0, T.noremote);
    return m.ok === true && m.rows.length === 2 && m.state === 'never' && h.ok === true && !/^trunk-/.test(String(h.state));
  });
  await gate('ipc_guard_ref', async () => {
    const bad = [J({ kind: 'local', name: 'nope' }), J({ kind: 'bogus', name: 'feat/x' }), J({ kind: 'local', name: 123 }),
      J({ kind: 'remote', name: 'feat/x' }), J({ kind: 'local', name: 'origin/develop' }), J({ kind: 'tag', name: 'feat/x' }),
      J({ kind: 'local', name: 'HEAD' }), J({ kind: 'local', name: 'feat/x^{commit}' }), J({ kind: 'local', name: 'refs/heads/feat/x' }),
      J({ kind: 'local' })];
    const control = await logRaw(J(featX));
    for (const ref of bad) if (!refused(await logRaw(ref), 'ref')) return false;
    return control.ok === true;
  });
  await gate('ipc_guard_dash', async () => {
    const pwn = path.join(fx.base, 'pwned-log');
    const names = ['--all', '-p', '-', '-n1', `--output=${pwn}`, '--upload-pack=touch /tmp/pwned'];
    const control = await logRaw(J(featX));
    for (const kind of ['local', 'remote', 'tag', 'head']) {
      for (const name of names) if (!refused(await logRaw(J({ kind, name })), 'ref') && !(kind === 'head')) return false;
    }
    // 'head' ignores the name: it resolves to HEAD, so only the other kinds must refuse
    return control.ok === true && !fs.existsSync(pwn);
  });
  await gate('ipc_guard_page', async () => {
    const control = await logRaw(J(featX), '0');
    for (const page of ['-1', '1001', '1.5', '"1"', 'null', 'undefined', 'NaN', 'Infinity', '1e9', '[0]', 'true']) {
      if (!refused(await logRaw(J(featX), page), 'page')) return false;
    }
    return control.ok === true;
  });
  await gate('ipc_readonly', async () => {
    const before = fx.snapshot();
    const answers = [await refsOf(), await logRef(featX, 0), await logRef(featX, 1), await logRef({ kind: 'local', name: 'develop' }),
      await logRef({ kind: 'remote', name: 'origin/develop' }), await logRef({ kind: 'tag', name: 'v1.0' }),
      await logRef({ kind: 'local', name: 'feat/level' }), await logRef({ kind: 'local', name: fx.EVIL_REF }), await logRef({ kind: 'head' })];
    return answers.every((a) => a && a.ok === true) && eq(before, fx.snapshot());
  });

  // ---- IPC gates: git-panel-commit / git-panel-commit-diff (L2) -------------------------------------
  const f1Id = J(sha.f1);
  await gate('ipc_commit_files', async () => {
    const c = await commitOf(f1Id);
    if (!c.ok || !Array.isArray(c.files) || c.files.length !== 7) return false;
    return eq(sorted(Object.keys(c)), ['author', 'date', 'files', 'message', 'ok', 'parents', 'sha']) && c.sha === sha.f1
      && eq(c.parents, [sha.mb]) && c.author === fx.truth(sha.f1, '%an') && c.date === fx.truth(sha.f1, '%aI')
      && c.files.every((f) => eq(sorted(Object.keys(f)), ['add', 'binary', 'del', 'path', 'status'])
        && EXP_FILES[f.path] && f.status === EXP_FILES[f.path][0] && f.add === EXP_FILES[f.path][1] && f.del === EXP_FILES[f.path][2] && f.binary === false);
  });
  await gate('ipc_commit_message', async () => {
    const c = await commitOf(f1Id);
    const want = fx.truth(sha.f1, '%B').replace(/\n+$/, '');
    return c.ok === true && c.message.replace(/\n+$/, '') === want && want.split('\n').pop() === fx.F1_BODY[2] && want.split('\n').length === 5;
  });
  await gate('ipc_commit_root', async () => {
    const c = await commitOf(J(sha.c0));
    const d = await cdiff(J(sha.c0), J('README.md'));
    return c.ok === true && eq(c.parents, []) && eq(c.files, [{ path: 'README.md', status: 'A', add: 1, del: 0, binary: false }])
      && d.ok === true && d.diff.startsWith('diff --git') && d.diff.includes('+readme');
  });
  await gate('ipc_commit_diff', async () => {
    const d = await cdiff(f1Id, J('src/a/one.js'));
    return d.ok === true && eq(sorted(Object.keys(d)), ['binary', 'capped', 'diff', 'ok', 'totalLines']) && d.diff.startsWith('diff --git')
      && d.diff.includes('+uno') && d.capped === false && d.binary === false && typeof d.totalLines === 'number' && d.totalLines > 0;
  });
  await gate('ipc_guard_sha', async () => {
    const tree = fx.out(fx.clone, 'rev-parse', `${sha.f1}^{tree}`);
    const blob = fx.out(fx.clone, 'rev-parse', `${sha.f1}:src/a/one.js`);
    const bad = ['""', '"abc"', '"HEAD"', J(sha.f1.toUpperCase()), '"--help"', '"-x"', J('0'.repeat(40)), J(tree), J(blob), '123', 'null', 'undefined', J(`${sha.f1}0`), J(sha.f1.slice(0, 39))];
    const control = await commitOf(f1Id);
    for (const s of bad) {
      if (!refused(await commitOf(s), 'sha') || !refused(await cdiff(s, J('src/a/one.js')), 'sha')) return false;
    }
    return control.ok === true;
  });
  await gate('ipc_guard_path', async () => {
    const pwn = path.join(fx.base, 'pwned-diff');
    const bad = ['"../etc/passwd"', '"/etc/passwd"', '"-p"', J(`--output=${pwn}`), '"src/a/missing.js"', '"README.md"', '""', '"src/../src/a/one.js"',
      '":(glob)*"', '":(top)src/a/one.js"', '"src/a/one.js/"', '123', 'null'];
    const control = await cdiff(f1Id, J('src/a/one.js'));
    for (const p of bad) if (!refused(await cdiff(f1Id, p), 'path')) return false;
    return control.ok === true && !fs.existsSync(pwn);
  });
  await gate('ipc_pathspec_literal', async () => {
    const headers = (d) => (d.diff.match(/^diff --git /gm) || []).length;
    const star = await cdiff(f1Id, J('src/a/a*.js'));
    const br = await cdiff(f1Id, J('app/[slug]/page.tsx'));
    const glob = await cdiff(f1Id, J(':(glob)*'));
    return star.ok === true && headers(star) === 1 && star.diff.includes('a*.js') && !star.diff.includes('ab.js')
      && br.ok === true && headers(br) === 1 && br.diff.includes('[slug]') && !br.diff.includes('app/s/page.tsx')
      && refused(glob, 'path');
  });
  await gate('ipc_pathspec_subdir', async () => {
    if (!(await j(`typeof window.api.gitCommitDiff === 'function'`))) throw new Error('window.api.gitCommitDiff is missing');
    const before = await j(`[...panes.keys()]`);
    await j(`openPane({ cwd: ${J(path.join(fx.clone, 'src'))}, title: 'probe-src' })`);
    await sleep(1200);
    const paneId = (await j(`[...panes.keys()]`)).find((k) => !before.includes(k));
    if (!paneId) return false;
    const viaPane = await cdiff(f1Id, J('src/a/two.js'), 'false', J({ paneId }));
    const viaSession = await cdiff(f1Id, J('src/a/two.js'), 'false', T.src);
    await j(`closePane(${J(paneId)})`).catch(() => {});
    const good = (d) => d && d.ok === true && d.diff.startsWith('diff --git') && d.diff.includes('+two');
    return good(viaPane) && good(viaSession);
  });

  // ---- UI helpers ---------------------------------------------------------------------------------
  const openSession = async (sessionId) => {
    await j('closeSidePanel()').catch(() => {});
    await sleep(250);
    await j(`openGitPanel({ sessionId: ${J(sessionId)} })`);
    if (!noLog) {
      if (!(await waitFor(`!!document.querySelector('#glog-log .glog-row')`, 8000))) noLog = true;
    }
    await sleep(noLog ? 50 : 600);
  };
  const pick = async (kind, name) => {
    const clicked = await j(`(() => { const b = [...document.querySelectorAll('nav#glog-refs button.glog-ref')]
      .find((x) => x.dataset.kind === ${J(kind)} && x.dataset.name === ${J(name)}); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return false;
    const done = await waitFor(`window.__pr.txt(document.getElementById('gp-branch')).includes(${J(name)}) && !!document.querySelector('#glog-log .glog-row')`);
    await sleep(noLog ? 50 : 700);
    return !!done;
  };
  const selectRow = async (key) => {
    const clicked = await j(`(() => { const r = window.__pr.row(${J(key)}); if (!r) return false; r.click(); return true; })()`);
    if (!clicked) return false;
    return waitFor(`(() => { const s = document.querySelector('#glog-commit .glog-sha-full');
      return !!s && s.getAttribute('title') === ${J(key)} && window.__pr.shown(document.getElementById('glog-commit')); })()`);
  };
  const txtOf = (sel) => j(`window.__pr.txt(document.querySelector(${J(sel)}))`);
  const stateText = async () => {
    await waitFor(`!!window.__pr.txt(document.getElementById('glog-state'))`);
    return norm(await j(`(() => { const s = document.getElementById('glog-state'); return s && window.__pr.shown(s) ? window.__pr.txt(s) : null; })()`));
  };
  const refresh = async () => { await j(`document.getElementById('gp-refresh').click()`); await sleep(noLog ? 50 : 500); };

  // ---- A11: the side panel maximizes on open, restores on close -------------------------------------
  let automaxSeen = false;
  await gate('a11_automax', async () => {
    await j('closeSidePanel()').catch(() => {});
    await sleep(300);
    const sp = () => j(`({ max: sp.max, cls: document.getElementById('side-panel').classList.contains('sp-max') })`);
    const pre = await sp();
    await j(`openGitPanel({ sessionId: ${J(sid.main)} })`);
    await waitFor(`sp.max === true`, 3000);
    const open = await sp();
    automaxSeen = pre.max === false && pre.cls === false && open.max === true && open.cls === true;
    return automaxSeen;
  });
  await gate('a11_restore', async () => {
    await j('closeGitPanel()');
    await waitFor(`sp.max === false`, 3000);
    await sleep(300);
    const after = await j(`({ max: sp.max, cls: document.getElementById('side-panel').classList.contains('sp-max') })`);
    return automaxSeen && after.max === false && after.cls === false;
  });

  // ---- the main session: fresh open, shown ref follows HEAD (feat/x) --------------------------------
  await openSession(sid.main);
  await gate('d1_no_compare_ui', async () => {
    const r = await j(`({ panel: !!document.getElementById('git-panel') && !!document.getElementById('gp-head') && !!document.getElementById('gp-files'),
      base: ['gp-base-wrap', 'gp-base', 'gp-base-menu'].filter((id) => !!document.getElementById(id)),
      text: /Comparer à|comparée à/.test(document.getElementById('git-panel').textContent) })`);
    return r.panel && r.base.length === 0 && !r.text;
  });
  await gate('d3d_no_counter', async () => {
    const r = await j(`({ sync: !!document.getElementById('gp-sync'), counts: !!document.getElementById('gp-counts'),
      cols: !!document.getElementById('glog-log') && !!document.querySelector('#glog-log .glog-row'),
      text: new RegExp(${J(I4_TEXT.source)}).test(document.getElementById('git-panel').textContent) })`);
    return r.cols && !r.sync && !r.counts && !r.text;
  });
  const badgeHead = await j(`window.__pr.txt(document.getElementById('glog-badge'))`).catch(() => null);
  await gate('d6_state_never', async () => (await stateText()) === 'jamais poussée');

  await gate('a12_follow_head', async () => {
    const before = await j(`window.__pr.txt(document.getElementById('gp-branch'))`);
    if (!before.includes('feat/x') || badgeHead !== 'branche actuelle') return false;
    fx.git(fx.clone, 'symbolic-ref', 'HEAD', 'refs/heads/feat/level');
    try {
      await refresh();
      return await waitFor(`window.__pr.txt(document.getElementById('gp-branch')).includes('feat/level')
        && window.__pr.txt(document.getElementById('glog-badge')) === 'branche actuelle'`);
    } finally {
      fx.git(fx.clone, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');
    }
  });
  await refresh();
  await waitFor(`window.__pr.txt(document.getElementById('gp-branch')).includes('feat/x')`);
  await sleep(noLog ? 50 : 500);

  // ---- feat/x view: rows, graph, chips, wip, legend, filter --------------------------------------------
  await gate('d2_wip_lists', async () => {
    const r = await j(`(() => { const w = window.__pr.row('wip'); return { chip: w ? window.__pr.txt(w.querySelector('.glog-chip')) : null,
      seg: w ? w.dataset.seg : null, paths: gp.rows.map((x) => x.path).sort() }; })()`);
    return r.chip === '2 fichiers' && r.seg === 'wip' && eq(r.paths, ['notes/new.txt', 'src/a/one.js']);
  });
  await gate('d3a_order', async () => {
    const exp = fx.expect.featX.slice(0, 50).map((e) => [e.sha, e.seg, e.seg === 'branch' ? '1' : '0']);
    exp.splice(3, 0, ['wip', 'wip', '1']);
    const got = await j(`[...document.querySelectorAll('#glog-log .glog-row')].map((r) => [r.dataset.key, r.dataset.seg, r.dataset.lane])`);
    return eq(got, exp);
  });
  await gate('d3b_join', async () => {
    const r = await j(`({ joins: document.querySelectorAll('#glog-log .glog-join').length,
      onMb: !!(window.__pr.row(${J(sha.mb)}) && window.__pr.row(${J(sha.mb)}).querySelector('.glog-join')),
      graphs: document.querySelectorAll('#glog-log .glog-row .glog-graph').length })`);
    return r.joins === 1 && r.onMb && r.graphs >= 50;
  });
  await gate('d3c_chips', async () => {
    const chip = (key, kind) => j(`(() => { const r = window.__pr.row(${J(key)}); const c = r && r.querySelector('.glog-chip[data-kind="${kind}"]'); return c ? window.__pr.txt(c) : null; })()`);
    return (await chip(sha.f2, 'branch')) === 'feat/x' && (await chip(sha.mb, 'develop')) === 'develop'
      && (await chip(sha.d3, 'origin-develop')) === 'origin/develop';
  });
  let legendA = false;
  {
    const r = await j(`({ kinds: [...document.querySelectorAll('#glog-log .glog-legend-item[data-lane-kind]')].map((e) => e.dataset.laneKind).sort(),
      texts: [...document.querySelectorAll('#glog-log .glog-legend-item')].every((e) => window.__pr.txt(e).length > 0),
      count: window.__pr.txt(document.querySelector('#glog-log .glog-count')) })`).catch(() => null);
    legendA = !!r && eq(r.kinds, ['branch', 'shared', 'trunk-only']) && r.texts && /^50 commits?$/.test(r.count || '');
  }
  await gate('d9_xss_subject', async () => {
    const r = await j(`({ text: (window.__pr.row(${J(sha.f2)}) && window.__pr.row(${J(sha.f2)}).querySelector('.glog-subject') || {}).textContent,
      xss: typeof window.__xss, imgs: document.querySelectorAll('#glog-log img').length })`);
    return r.text === fx.F2_SUBJECT && r.xss === 'undefined' && r.imgs === 0;
  });
  await gate('d10_no_left_accent', async () => {
    const r = await inPage(accentBarInfo);
    return r.rows >= 50 && r.n > 200 && r.bars.length === 0;
  });
  await gate('d10_tokens', async () => {
    const r = await inPage(tokenInfo);
    return r.indigo === '#a49ccb' && r.del === '#c98676' && r.n >= 20 && r.off.length === 0;
  });
  await gate('d10_motion', async () => {
    const r = await inPage(motionInfo);
    return r.n >= 20 && r.bad.length === 0;
  });

  // a7_filter (before the rows are all loaded)
  const setFilter = (v) => j(`(() => { const i = document.querySelector('input.glog-filter'); if (!i) return false; i.value = ${J(v)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await gate('a7_filter', async () => {
    const attrs = await j(`(() => { const i = document.querySelector('input.glog-filter'); return i ? [i.type, i.placeholder] : null; })()`);
    if (!eq(attrs, ['search', 'Filtrer les commits'])) return false;
    const shownNoWip = async () => (await j(`window.__pr.shownKeys()`)).filter((k) => k !== 'wip');
    await setFilter('H30');
    await sleep(250);
    const bySubject = await shownNoWip();
    await setFilter(sha.f1.slice(0, 7));
    await sleep(250);
    const bySha = await shownNoWip();
    await setFilter('probe');
    await sleep(250);
    const byAuthor = (await shownNoWip()).length;
    await setFilter('');
    await sleep(250);
    const all = await shownNoWip();
    return eq(bySubject, [sha.h[30]]) && eq(bySha, [sha.f1]) && byAuthor === 50 && all.length === 50;
  });

  // d7_diff_open_wt: the uncommitted row, its file diff, back to the history
  await gate('d7_diff_open_wt', async () => {
    if (!(await j(`!!window.__pr.row('wip')`))) return false;
    await j(`window.__pr.row('wip').click()`);
    const listed = await waitFor(`window.__pr.shown(document.getElementById('gp-files')) && document.querySelectorAll('#gp-files .gp-row').length === 2
      && !window.__pr.shown(document.getElementById('glog-commit'))`);
    if (!listed) return false;
    await j(`(() => { const i = gp.rows.findIndex((r) => r.path === 'src/a/one.js');
      [...document.querySelectorAll('#gp-files .gp-row')].find((el) => Number(el.dataset.idx) === i).click(); })()`);
    const opened = await waitFor(`window.__pr.shown(document.getElementById('glog-diff')) && document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length > 0
      && document.getElementById('gp-diff').textContent.includes('WIP-EDIT')`);
    if (!opened) return false;
    await j(`document.querySelector('#glog-diff .glog-diff-back').click()`);
    return waitFor(`!window.__pr.shown(document.getElementById('glog-diff')) && window.__pr.shown(document.getElementById('glog-wip-head'))
      && window.__pr.shown(document.getElementById('gp-files')) && !window.__pr.shown(document.getElementById('glog-commit')) && !!window.__pr.row('wip')`);
  });

  // commit detail of f1 (branch row)
  let f1Selected = false;
  await gate('d7_files_grouped', async () => {
    f1Selected = !!(await selectRow(sha.f1));
    if (!f1Selected) return false;
    const info = await inPage(filesInfo);
    const filesOk = info.files.length === 7 && info.files.every((f) => {
      const e = EXP_FILES[f.path];
      return e && f.s === e[0] && (e[1] ? f.text.includes(`+${e[1]}`) : true) && (e[2] ? /[−-]1/.test(f.text) : true);
    });
    return filesOk && eq(info.dirs, EXP_DIRS) && /Fichiers modifiés/.test(info.head || '') && /\b7\b/.test(info.head) && info.head.includes('+6') && /[−-]1\b/.test(info.head);
  });
  await gate('d7_message', async () => {
    if (!f1Selected) return false;
    const r = await j(`({ msg: (document.querySelector('#glog-commit pre.glog-msg') || {}).textContent,
      full: window.__pr.txt(document.querySelector('#glog-commit h2.glog-subject-full')),
      shaShort: window.__pr.txt(document.querySelector('#glog-commit .glog-sha-full')) })`);
    const want = fx.truth(sha.f1, '%B').replace(/\n+$/, '');
    return typeof r.msg === 'string' && r.msg.replace(/\n+$/, '') === want && r.full === 'f1' && r.shaShort === sha.f1.slice(0, 7);
  });
  await gate('d9_xss_message', async () => {
    if (!f1Selected) return false;
    const r = await j(`({ xss: typeof window.__xssMsg, scripts: document.querySelectorAll('#glog-commit script').length,
      kids: document.querySelectorAll('#glog-commit pre.glog-msg *').length,
      has: ((document.querySelector('#glog-commit pre.glog-msg') || {}).textContent || '').includes(${J(fx.F1_BODY[2])}) })`);
    return r.has && r.xss === 'undefined' && r.scripts === 0 && r.kids === 0;
  });
  await gate('a8_copy', async () => {
    if (!f1Selected) return false;
    clipboard.writeText('PROBE-SENTINEL');
    const clicked = await j(`(() => { const b = document.querySelector('#glog-commit button.glog-copy'); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return false;
    for (let i = 0; i < 30; i++) { if (clipboard.readText() !== 'PROBE-SENTINEL') break; await sleep(100); }
    return clipboard.readText() === sha.f1;
  });
  const kickerF1 = f1Selected ? await txtOf('#glog-commit .glog-kicker') : null;
  await gate('d7_diff_open', async () => {
    if (!f1Selected) return false;
    await j(`document.querySelector('#glog-commit button.glog-file[data-path="src/a/one.js"]').click()`);
    const opened = await waitFor(`window.__pr.shown(document.getElementById('glog-diff')) && document.getElementById('glog-log').contains(document.getElementById('glog-diff'))
      && document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length > 0 && document.getElementById('gp-diff').textContent.includes('uno')`);
    const ctl = await j(`({ back: window.__pr.txt(document.querySelector('#glog-diff .glog-diff-back')),
      close: (document.querySelector('#glog-diff .glog-diff-close') || { getAttribute: () => null }).getAttribute('aria-label'),
      region: document.getElementById('glog-diff').getAttribute('role') })`);
    return !!opened && ctl.back === '← Historique' && ctl.close === 'Fermer le diff' && ctl.region === 'region';
  });
  await gate('d7_back', async () => {
    if (!f1Selected) return false;
    await j(`document.querySelector('#glog-diff .glog-diff-back').click()`);
    return waitFor(`!window.__pr.shown(document.getElementById('glog-diff')) && window.__pr.shown(document.getElementById('glog-commit'))
      && document.querySelector('#glog-commit .glog-sha-full').getAttribute('title') === ${J(sha.f1)} && window.__pr.shown(window.__pr.row(${J(sha.f1)}))`);
  });
  const kickers = { branch: kickerF1 };
  if (await selectRow(sha.d1)) kickers.trunkOnly = await txtOf('#glog-commit .glog-kicker');
  if (await selectRow(sha.mb)) kickers.shared = await txtOf('#glog-commit .glog-kicker');

  // a7_more: all 68 rows once the button is clicked
  await gate('a7_more', async () => {
    const before = await j(`(() => { const b = document.querySelector('#glog-log button.glog-more'); return b && window.__pr.shown(b) ? window.__pr.txt(b) : null; })()`);
    if (before !== 'Charger 50 commits de plus') return false;
    await j(`document.querySelector('#glog-log button.glog-more').click()`);
    const loaded = await waitFor(`window.__pr.keys().length === ${fx.expect.featX.length + 1}`);
    const after = await j(`({ more: window.__pr.shown(document.querySelector('#glog-log button.glog-more')),
      note: window.__pr.shown(document.querySelector('#glog-log p.glog-more-note')), count: window.__pr.txt(document.querySelector('#glog-log .glog-count')) })`);
    return !!loaded && after.more === false && after.note === false && after.count === `${fx.expect.featX.length} commits`;
  });

  // ---- the branch column ---------------------------------------------------------------------------
  await gate('d8_lists', async () => {
    const r = await j(`(() => {
      const refs = [...document.querySelectorAll('nav#glog-refs button.glog-ref')].map((b) => [b.dataset.kind, b.dataset.name]);
      const titles = Object.fromEntries([...document.querySelectorAll('nav#glog-refs .glog-ref-section')].map((s) => [s.dataset.section, (s.querySelector('h3, h4, .glog-ref-title, summary, button.glog-ref-fold, header') || s).textContent.replace(/\\s+/g, ' ').trim()]));
      const head = document.querySelector('nav#glog-refs button.glog-ref[data-name="feat/x"] .glog-head-badge');
      return { refs, titles, head: head ? head.textContent.trim() : null, ro: window.__pr.txt(document.querySelector('nav#glog-refs p.glog-ro-note')) };
    })()`);
    const names = (k) => sorted(r.refs.filter(([kind]) => kind === k).map(([, n]) => n));
    return eq(names('local'), sorted(['develop', 'feat/x', 'feat/level', 'feat/ahead', 'gone-up', fx.EVIL_REF]))
      && eq(names('remote'), ['origin/develop', 'origin/feat/ahead', 'origin/feat/level']) && eq(names('tag'), ['lite', 'nested', 'v1.0'])
      && /Locales/.test(r.titles.local || '') && /Distantes/.test(r.titles.remote || '') && /Tags/.test(r.titles.tag || '')
      && r.head === 'HEAD' && r.ro === 'Lecture seule : choisir une branche ne fait aucun checkout.';
  });
  await gate('d8_search', async () => {
    const vis = () => j(`[...document.querySelectorAll('nav#glog-refs button.glog-ref')].filter((b) => window.__pr.shown(b)).map((b) => b.dataset.kind + ':' + b.dataset.name)`);
    const fold = (s) => j(`(() => { const f = document.querySelector('nav#glog-refs .glog-ref-section[data-section="${s}"] button.glog-ref-fold'); return f ? f.getAttribute('aria-expanded') : null; })()`);
    const setSearch = (v) => j(`(() => { const i = document.querySelector('input.glog-ref-search'); if (!i) return false; i.value = ${J(v)};
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const attrs = await j(`(() => { const i = document.querySelector('input.glog-ref-search'); return i ? [i.type, i.placeholder] : null; })()`);
    if (!eq(attrs, ['search', 'Branche ou tag'])) return false;
    const initial = await vis();
    const folded = [await fold('remote'), await fold('tag')];
    await setSearch('level');
    await sleep(300);
    const hits = await vis();
    const unfolded = await fold('remote');
    await setSearch('zzzz-none');
    await sleep(300);
    const none = await vis();
    const empty = await j(`window.__pr.shown(document.querySelector('nav#glog-refs .glog-ref-empty'))`);
    await setSearch('');
    await sleep(300);
    return !initial.some((x) => x.startsWith('remote:')) && eq(folded, ['false', 'false']) && hits.includes('local:feat/level')
      && hits.includes('remote:origin/feat/level') && !hits.includes('local:feat/ahead') && !hits.includes('local:develop')
      && unfolded === 'true' && none.length === 0 && empty === true;
  });
  await gate('d9_xss_ref', async () => {
    // part 1 here (the list); part 2 (the pick) runs below once the evil ref is shown
    const r = await j(`({ btn: [...document.querySelectorAll('nav#glog-refs button.glog-ref')].some((b) => b.dataset.name === ${J(fx.EVIL_REF)}
      && b.textContent.includes(${J(fx.EVIL_REF)})), imgs: document.querySelectorAll('nav#glog-refs img').length, xss: typeof window.__xssRef })`);
    detail.d9_xss_ref_list = r.btn && r.imgs === 0 && r.xss === 'undefined';
    return false; // finalised after the pick below
  });

  // ---- picks (read-only views of other refs) -------------------------------------------------------------
  const snapPicks = fx.snapshot();
  let badgeRo = null;
  await gate('d8_pick_shows', async () => {
    if (!(await pick('local', 'feat/level'))) return false;
    badgeRo = await j(`window.__pr.txt(document.getElementById('glog-badge'))`);
    const r = await j(`({ branch: window.__pr.txt(document.getElementById('gp-branch')), keys: window.__pr.keys(),
      cur: (document.querySelector('nav#glog-refs button.glog-ref[data-name="feat/level"]') || {}).getAttribute
        ? document.querySelector('nav#glog-refs button.glog-ref[data-name="feat/level"]').getAttribute('aria-current') : null,
      curOld: document.querySelector('nav#glog-refs button.glog-ref[data-name="feat/x"]').getAttribute('aria-current'),
      subject: window.__pr.txt((window.__pr.row(${J(sha.lv1)}) || document.body).querySelector('.glog-subject')) })`);
    return r.branch.includes('feat/level') && r.keys[0] === sha.lv1 && r.subject === 'lv1'
      && !!r.cur && r.cur !== 'false' && (!r.curOld || r.curOld === 'false');
  });
  await gate('d4_level', async () => {
    const r = await j(`({ keys: window.__pr.keys(), segs: [...document.querySelectorAll('#glog-log .glog-row')].map((x) => x.dataset.seg),
      chips: [...((window.__pr.row(${J(sha.lv1)}) || document.body).querySelectorAll('.glog-chip'))].map((c) => c.dataset.kind + ':' + c.textContent.trim()),
      joins: document.querySelectorAll('#glog-log .glog-join').length,
      lanes: [...document.querySelectorAll('#glog-log .glog-row')].map((x) => x.dataset.lane) })`);
    // the branch contains the trunk (no trunk-only row): one straight lane 0, no join
    return r.keys[0] === sha.lv1 && r.keys[1] === sha.d3 && !r.segs.includes('trunk-only') && !r.segs.includes('wip')
      && r.segs.filter((s) => s === 'branch').length === 1 && r.chips.includes('branch:feat/level') && r.chips.includes('origin:origin') && r.joins === 0
      && r.lanes.length > 0 && r.lanes.every((l) => l === '0');
  });
  await gate('d6_state_level', async () => (await stateText()) === '✓ poussée sur origin');
  let a5Ro = badgeRo === 'lecture seule';
  await pick('local', 'feat/ahead');
  await gate('d6_state_ahead', async () => (await stateText()) === "pas au même niveau qu'origin");

  let incomingKicker = null;
  let legendC = false;
  await gate('d5_trunk_view', async () => {
    if (!(await pick('local', 'develop'))) return false;
    const r = await j(`({ rows: [...document.querySelectorAll('#glog-log .glog-row')].map((x) => [x.dataset.key, x.dataset.seg, x.dataset.lane]),
      dashed: [${J(sha.d3)}, ${J(sha.d2)}, ${J(sha.d1)}].map((k) => !!(window.__pr.row(k) && window.__pr.row(k).querySelector('.glog-dot-dashed'))),
      dashedCss: [${J(sha.d3)}, ${J(sha.d2)}, ${J(sha.d1)}].map((k) => { const d = window.__pr.row(k) && window.__pr.row(k).querySelector('.glog-dot'); return d ? [getComputedStyle(d).borderTopWidth, getComputedStyle(d).boxShadow !== 'none'] : null; }),
      ring: (() => { const d = window.__pr.row(${J(sha.mb)}) && window.__pr.row(${J(sha.mb)}).querySelector('.glog-dot'); return d ? [d.dataset.trunk || '', getComputedStyle(d).borderTopWidth, getComputedStyle(d).boxShadow !== 'none'] : null; })(),
      legendShared: window.__pr.txt(document.querySelector('#glog-log .glog-legend-item[data-lane-kind="shared"] .glog-legend-text')),
      joins: document.querySelectorAll('#glog-log .glog-join').length, kinds: [...document.querySelectorAll('#glog-log .glog-legend-item[data-lane-kind]')].map((e) => e.dataset.laneKind).sort(),
      count: window.__pr.txt(document.querySelector('#glog-log .glog-count')) })`);
    legendC = eq(r.kinds, ['incoming', 'shared']) && /^50 commits?$/.test(r.count || '') && r.legendShared === 'ton develop local';
    const exp = fx.expect.trunkLocal.slice(0, 50).map((e) => [e.sha, e.seg, '0']);
    if (await selectRow(sha.d1)) incomingKicker = await txtOf('#glog-commit .glog-kicker');
    // computed style (F1, no coloured border): the three incoming dots (d3 carries the origin/develop chip) are hollow inset rings, the local develop tip (mb) is the one ringed (trunk)
    return eq(r.rows, exp) && r.dashed.every(Boolean) && eq(r.dashedCss, [['0px', true], ['0px', true], ['0px', true]])
      && eq(r.ring, ['true', '0px', true]) && r.joins === 0 && (await stateText()) === 'pas à jour avec origin/develop';
  });
  await gate('a5_badge', async () => badgeHead === 'branche actuelle' && a5Ro);
  await gate('a7_legend', async () => legendA && legendC);
  await gate('a8_kicker', async () => kickers.branch === 'à livrer dans develop'
    && kickers.trunkOnly === 'sur origin/develop, pas dans ta branche' && kickers.shared === 'déjà dans develop'
    && incomingKicker === 'sur GitLab, pas encore dans ton develop local');

  await pick('local', fx.EVIL_REF);
  await gate('d9_xss_ref', async () => {
    const r = await j(`({ branch: document.getElementById('gp-branch').textContent.trim(), imgs: document.querySelectorAll('#git-panel img').length,
      xss: typeof window.__xssRef, rows: document.querySelectorAll('#glog-log .glog-row').length })`);
    return detail.d9_xss_ref_list === true && r.branch.includes(fx.EVIL_REF) && r.imgs === 0 && r.xss === 'undefined' && r.rows > 0;
  });
  delete detail.d9_xss_ref_list;
  await gate('d8_readonly', async () => {
    const r = await j(`({ ro: window.__pr.txt(document.querySelector('nav#glog-refs p.glog-ro-note')), picks: document.querySelectorAll('nav#glog-refs button.glog-ref').length })`);
    return r.ro === 'Lecture seule : choisir une branche ne fait aucun checkout.' && r.picks >= 10 && a5Ro && eq(snapPicks, fx.snapshot())
      && fx.out(fx.clone, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feat/x' && eq(snapStart.head, fx.snapshot().head);
  });

  // a12_pinned_stays: the evil ref is pinned; HEAD moves underneath, the shown ref stays
  await gate('a12_pinned_stays', async () => {
    const before = await j(`document.getElementById('gp-branch').textContent.trim()`);
    if (!before.includes(fx.EVIL_REF)) return false;
    fx.git(fx.clone, 'symbolic-ref', 'HEAD', 'refs/heads/feat/level');
    try {
      await refresh();
      await sleep(noLog ? 50 : 900);
      const r = await j(`({ branch: document.getElementById('gp-branch').textContent.trim(), badge: window.__pr.txt(document.getElementById('glog-badge')) })`);
      return r.branch.includes(fx.EVIL_REF) && !r.branch.includes('feat/level') && r.badge === 'lecture seule';
    } finally {
      fx.git(fx.clone, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');
    }
  });

  // ---- other sessions: no remote, workspace parent folder -------------------------------------------------
  await openSession(sid.noremote);
  await gate('ui_state_no_remote', async () => {
    const text = await stateText();
    const r = await j(`({ exists: !!document.getElementById('glog-state'), rows: document.querySelectorAll('#glog-log .glog-row').length,
      panel: document.getElementById('git-panel').textContent.includes('pas à jour avec') })`);
    return r.exists && r.rows >= 2 && text === 'jamais poussée' && !r.panel;
  });
  await openSession(sid.parent);
  await gate('ws_parent_cwd', async () => {
    const r = await j(`({ repo: window.__pr.txt(document.getElementById('gp-repo')),
      chip: [...document.querySelectorAll('#glog-log .glog-chip[data-kind="branch"]')].map((c) => c.textContent.trim()),
      ref: !!document.querySelector('nav#glog-refs button.glog-ref[data-name="feat/x"]') })`);
    return r.repo === 'deck-repo' && r.chip.includes('feat/x') && r.ref;
  });

  // ---- LAST: commit every head change; the uncommitted row goes away --------------------------------------
  await openSession(sid.main);
  await pick('local', 'feat/x');
  // d11_enter_buttons: TRUSTED Enter (keyDown + char + keyUp) on a focused button acts as a click even with a file row selected
  // (the panel's keydown handler once took Enter for « reopen the file diff » and cancelled the native activation)
  await gate('d11_enter_buttons', async () => {
    win.webContents.focus();
    const enter = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(400);
    };
    const diffShown = () => j(`window.__pr.shown(document.getElementById('glog-diff'))`);
    // wip selected, a file row selected, its diff opened then closed with « ← Historique »: gp.selected >= 0, diff closed
    const armed = async () => {
      if (!(await j(`!!window.__pr.row('wip')`))) return false;
      await j(`window.__pr.row('wip').click()`);
      if (!(await waitFor(`window.__pr.shown(document.getElementById('gp-files')) && document.querySelectorAll('#gp-files .gp-row').length === 2`))) return false;
      await j(`document.querySelector('#gp-files .gp-row').click()`);
      if (!(await waitFor(`window.__pr.shown(document.getElementById('glog-diff'))`))) return false;
      await j(`document.querySelector('#glog-diff .glog-diff-back').click()`);
      return waitFor(`!window.__pr.shown(document.getElementById('glog-diff')) && window.__pr.shown(document.getElementById('gp-files')) && gp.selected >= 0`);
    };
    const focus = (css) => j(`(() => { const e = document.querySelector(${J(css)}); if (!e) return false; e.focus(); return document.activeElement === e; })()`);
    // 1. a focused commit row: Enter selects that commit (detail shown, no diff)
    if (!(await armed()) || !(await focus(`#glog-log .glog-row[data-key="${sha.f1}"]`))) return false;
    await enter();
    const row = await waitFor(`(() => { const s = document.querySelector('#glog-commit .glog-sha-full');
      return !!s && s.getAttribute('title') === ${J(sha.f1)} && window.__pr.shown(document.getElementById('glog-commit')); })()`, 3000);
    detail.d11_enter_buttons = `row:${!!row} diff:${await diffShown()}`;
    if (!row || (await diffShown())) return false;
    // 2. the « Charger 50 commits de plus » button: Enter loads the next page, no diff
    if (!(await armed()) || !(await focus('#glog-log button.glog-more'))) return false;
    await enter();
    const more = await waitFor(`window.__pr.keys().length === ${fx.expect.featX.length + 1}`, 3000);
    detail.d11_enter_buttons = `more:${!!more} diff:${await diffShown()}`;
    if (!more || (await diffShown())) return false;
    // 3. a branch button of the refs column: Enter picks that ref, no diff
    if (!(await armed()) || !(await focus('nav#glog-refs button.glog-ref[data-name="feat/level"]'))) return false;
    await enter();
    const pickd = await waitFor(`window.__pr.txt(document.getElementById('gp-branch')).includes('feat/level')`, 3000);
    detail.d11_enter_buttons = `branch:${!!pickd} diff:${await diffShown()}`;
    const noDiff = !(await diffShown());
    await pick('local', 'feat/x');
    if (!pickd || !noDiff) return false;
    delete detail.d11_enter_buttons;
    return true;
  });
  // d12_enter_selected_diff: Enter reopens the SELECTED status row's diff, never what #gp-diff still holds.
  // (a) status diff of one.js, back, a commit's one.js diff, the wip row again, Enter: the overlay shows the wip edit.
  // (b) « ← Historique » while a diff loads (its answer is dropped), Enter: the diff loads, no permanent skeleton.
  await gate('d12_enter_selected_diff', async () => {
    win.webContents.focus();
    const enter = async () => {
      await j(`document.activeElement && document.activeElement.blur()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(400);
    };
    const state = () => j(`({ shown: window.__pr.shown(document.getElementById('glog-diff')), skeleton: !!document.querySelector('#gp-diff .gp-skeleton'),
      lines: document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length, edit: document.getElementById('gp-diff').textContent.includes('WIP-EDIT'),
      diffRow: gp.diffRow ? gp.diffRow.kind + ':' + gp.diffRow.path : null })`);
    const wipDiff = `window.__pr.shown(document.getElementById('glog-diff')) && document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length > 0
      && document.getElementById('gp-diff').textContent.includes('WIP-EDIT')`;
    const one = `[...document.querySelectorAll('#gp-files .gp-row')].find((r) => r.textContent.includes('one.js'))`;
    const back = `document.querySelector('#glog-diff .glog-diff-back')`;
    if (!(await j(`!!window.__pr.row('wip')`))) return false;
    await j(`window.__pr.row('wip').click()`);
    if (!(await waitFor(`window.__pr.shown(document.getElementById('gp-files')) && document.querySelectorAll('#gp-files .gp-row').length === 2`))) return false;
    await j(`(${one}).click()`);
    if (!(await waitFor(wipDiff))) return false;
    await j(`${back}.click()`);
    if (!(await selectRow(sha.f1))) return false;
    await j(`document.querySelector('#glog-commit button.glog-file[data-path="src/a/one.js"]').click()`);
    if (!(await waitFor(`window.__pr.shown(document.getElementById('glog-diff')) && document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length > 0
      && !document.getElementById('gp-diff').textContent.includes('WIP-EDIT')`))) return false;
    await j(`window.__pr.row('wip').click()`);
    if (!(await waitFor(`!window.__pr.shown(document.getElementById('glog-diff')) && window.__pr.shown(document.getElementById('gp-files'))`))) return false;
    await enter();
    const a = !!(await waitFor(wipDiff, 3000));
    const aState = await state();
    await j(`${back}.click()`);
    await j(`(() => { (${one}).click(); ${back}.click(); })()`); // open then close in one tick: the answer lands in a closed overlay
    await sleep(700);
    const mid = await state();
    await enter();
    const b = !!(await waitFor(wipDiff, 3000));
    detail.d12_enter_selected_diff = `a:${a} ${J(aState)} | b:${b} premise:${J(mid)} after:${J(await state())}`;
    if (!a || !b) return false;
    delete detail.d12_enter_selected_diff;
    return true;
  });
  await gate('d2_wip_gone_after_commit', async () => {
    if (!(await j(`!!window.__pr.row('wip')`))) return false;
    fx.git(fx.clone, 'add', '-A');
    fx.git(fx.clone, 'commit', '-q', '-m', 'wip committed');
    await refresh();
    const r = await waitFor(`!window.__pr.row('wip') && [...document.querySelectorAll('#glog-log .glog-row .glog-subject')].some((s) => s.textContent === 'wip committed')`);
    const rows = await j(`gp.rows.length`);
    return !!r && rows === 0;
  });
  // d13_clean_refresh_keeps_commit_diff: clean tree (d2 committed everything), the tip commit's file diff open: neither ⟳ nor an
  // idle push (both reload the status, which is clean) closes it while the commit stays selected.
  await gate('d13_clean_refresh_keeps_commit_diff', async () => {
    await openSession(sid.main);
    const fileBtn = `document.querySelector('#glog-commit button.glog-file')`;
    if (!(await waitFor(`!!${fileBtn}`, 4000))) {
      if (!(await j(`(() => { const r = document.querySelector('#glog-log .glog-row'); if (!r) return false; r.click(); return true; })()`))) return false;
      if (!(await waitFor(`!!${fileBtn}`))) return false;
    }
    const sel0 = await j(`gp.sel`);
    await j(`${fileBtn}.click()`);
    const open = `window.__pr.shown(document.getElementById('glog-diff')) && document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length > 0`;
    if (!(await waitFor(open))) return false;
    const held = () => j(`({ shown: window.__pr.shown(document.getElementById('glog-diff')), lines: document.querySelectorAll('#gp-diff .d2h-code-line-ctn').length,
      sel: gp.sel, detail: gp.detail })`);
    const ok = (s) => s.shown && s.lines > 0 && s.sel === sel0 && s.detail === 'commit';
    await refresh();
    await sleep(600);
    const afterRefresh = await held();
    win.webContents.send('session-status', { sessionId: sid.main, status: 'idle' });
    await sleep(1500); // 350 ms debounce, then the status load
    const afterIdle = await held();
    detail.d13_clean_refresh_keeps_commit_diff = `refresh:${J(afterRefresh)} idle:${J(afterIdle)}`;
    if (!ok(afterRefresh) || !ok(afterIdle)) return false;
    delete detail.d13_clean_refresh_keeps_commit_diff;
    return true;
  });
}
