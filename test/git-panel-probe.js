// test/git-panel-probe.js — E2E probe: v39 git panel (rewritten for deck-git-log T2a: log view, auto-maximized panel).
// A throwaway repo is built with every trap from the spec: staged M,
// unstaged M, untracked, staged RENAME, modified BINARY, >cap diff.
// Plus a clean repo and a bare non-repo dir for the empty states.
//   t0  diff2html UMD loaded (CSP allows ../node_modules)
//   t1  header: repo name · branch main · #glog-badge « branche actuelle » · the selected uncommitted row says « 9 fichiers »
//       · #gp-sync / #gp-counts / #gp-base are gone
//   t2  groups: staged {b.txt, ren-new.txt(R)} / unstaged {a.txt, big.txt, bin.dat} / untracked {new.txt}; headings
//       « Indexés » / « Non indexés » / « Non suivis »
//   t3  LAZY: no diff fetched before any click (placeholder shown, #glog-diff overlay closed)
//   t4  click a.txt -> d2h table rendered with the modified line
//   t5  untracked new.txt -> full-add rendering (d2h-ins)
//   t6  binary bin.dat -> "binaire" message, no table
//   t7  big.txt -> capped banner + "voir tout" -> full render w/o banner
//   t8  rename row shows old → new (title) and its staged diff renders
//   t9  keyboard: j/j/k moves selection; the panel is maximized, so the first Escape restores it and the second closes the panel
//   t10 clean repo -> "working tree clean ✓"
//   t11 non-repo -> "pas un dépôt git"
//   t17 responsive split: the width of the diff overlay (window size, panel maximized) picks side-by-side / line-by-line
//   t19 the panel opens maximized: covers the whole area right of the sidebar
//   t35 split halves WRAP: side-by-side at wide width never scrolls horizontally (every .d2h-file-side-diff fits, no .gp-hscroll);
//       the scroll-sync / sticky-hscroll / remeasure gates (t26, t27, t30-t32) went with the horizontal scroll (cf75d06)
// Run: cd claude-deck && npx electron test/git-panel-probe.js
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-git-probe-'));
const repo = path.join(base, 'repo');
const cleanRepo = path.join(base, 'cleanrepo');
const nonRepo = path.join(base, 'nonrepo');
fs.mkdirSync(repo); fs.mkdirSync(cleanRepo); fs.mkdirSync(nonRepo);
const g = (dir, cmd) => execSync(`git -C ${dir} ${cmd}`, { stdio: 'pipe' });
const init = (dir) => {
  g(dir, 'init -b main');
  g(dir, 'config user.email probe@deck.local');
  g(dir, 'config user.name deck-probe');
};
init(repo);
fs.writeFileSync(path.join(repo, 'a.txt'),
  `alpha\nbravo-${'y'.repeat(600)}\ncharlie\n`); // long lines both sides (wrap gate t35)
fs.writeFileSync(path.join(repo, 'b.txt'), 'one\ntwo\n');
fs.writeFileSync(path.join(repo, 'ren-old.txt'), 'renamed content\n');
fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
fs.writeFileSync(path.join(repo, 'big.txt'), 'seed\n');
// wide.txt: tall (240 lines) + wide MODIFIES anchored by context, NOT capped (<1500).
fs.writeFileSync(path.join(repo, 'wide.txt'),
  Array.from({ length: 240 }, (_, i) => (i % 4 === 0 ? `W${i}: ${'y'.repeat(200)}` : `keep-${i}`)).join('\n') + '\n');
fs.writeFileSync(path.join(repo, 'marker.txt'), 'doc about git internals\n');
g(repo, 'add -A'); g(repo, 'commit -m init');
fs.writeFileSync(path.join(repo, 'a.txt'),
  `alpha\nMODIFIED-LINE-${'x'.repeat(600)}\ncharlie\n`); // unstaged M (wide for t35)
fs.writeFileSync(path.join(repo, 'b.txt'), 'one\nSTAGED-LINE\n');
g(repo, 'add b.txt');                                                          // staged M
g(repo, 'mv ren-old.txt ren-new.txt');                                         // staged R
fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([9, 9, 9, 0, 254]));  // unstaged binary
fs.writeFileSync(path.join(repo, 'big.txt'),
  Array.from({ length: 3000 }, (_, i) => `big-line-${i}`).join('\n') + '\n');  // > cap (1500)
fs.writeFileSync(path.join(repo, 'wide.txt'),
  Array.from({ length: 240 }, (_, i) => (i % 4 === 0 ? `W${i}: ${'z'.repeat(200)}` : `keep-${i}`)).join('\n') + '\n'); // 60 wide modifies
fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh-untracked-line\n');        // untracked
// Attack-class fixtures (review round): a TEXT diff that merely CONTAINS the
// binary marker string, and an untracked symlink to a secret OUTSIDE the repo.
fs.appendFileSync(path.join(repo, 'marker.txt'), 'GIT binary patch\n');        // unstaged M, text
fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-CONTENT\n');
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(repo, 'sneaky-link')); // untracked symlink
init(cleanRepo);
fs.writeFileSync(path.join(cleanRepo, 'x.txt'), 'x\n');
g(cleanRepo, 'add -A'); g(cleanRepo, 'commit -m init');                        // clean tree
// v39.1: a WORKSPACE-level folder (not a repo) holding two git children +
// one plain dir — the real "folder of repos" case behind the user's bug.
const wsRepo = path.join(base, 'wsrepo');
fs.mkdirSync(wsRepo);
for (const name of ['sub1', 'sub2']) {
  const d = path.join(wsRepo, name);
  fs.mkdirSync(d);
  init(d);
  fs.writeFileSync(path.join(d, 'f.txt'), 'base\n');
  g(d, 'add -A'); g(d, 'commit -m init');
}
fs.writeFileSync(path.join(wsRepo, 'sub1', 'f.txt'), 'base\nWS-SUB1-EDIT\n'); // sub1 dirty
fs.mkdirSync(path.join(wsRepo, 'plain'));                                      // non-git child
// sub3: git AND dirty but NEVER touched by the fake session — the semantic
// gate: dirty-but-untouched repos must NOT appear in the session picker.
{
  const d = path.join(wsRepo, 'sub3');
  fs.mkdirSync(d); init(d);
  fs.writeFileSync(path.join(d, 'z.txt'), 'z\n');
  g(d, 'add -A'); g(d, 'commit -m init');
  fs.writeFileSync(path.join(d, 'z.txt'), 'z\nDIRTY-UNTOUCHED\n');
}
// v39.2 fixtures: FAKE session transcripts under a seamed projects root.
// Multi-project session: Write -> sub1 (main transcript), Edit -> sub2
// (SUBAGENT transcript — proves the subagents walk), Write -> outside any
// repo (must be ignored). Mono session: Write -> sub1 only.
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
const UUID_MULTI = '11111111-1111-4111-8111-111111111111';
const UUID_MONO = '22222222-2222-4222-8222-222222222222';
const toolLine = (name, input) => JSON.stringify({
  type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] },
}) + '\n';
fs.mkdirSync(path.join(projDir, UUID_MULTI, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(projDir, `${UUID_MULTI}.jsonl`),
  JSON.stringify({ type: 'summary', cwd: wsRepo }) + '\n'
  + toolLine('Write', { file_path: path.join(wsRepo, 'sub1', 'f.txt') })
  + toolLine('Write', { file_path: path.join(base, 'outside.txt') })); // no repo -> ignored
fs.writeFileSync(path.join(projDir, UUID_MULTI, 'subagents', 'agent-1.jsonl'),
  toolLine('mcp__filesystem__edit_file', { path: path.join(wsRepo, 'sub2', 'f.txt') }));
fs.writeFileSync(path.join(projDir, `${UUID_MONO}.jsonl`),
  toolLine('Write', { file_path: path.join(wsRepo, 'sub1', 'f.txt') }));
// v54: a SEPARATE docs repo (not one of the code repos) with a plans/ dir. A
// session that writes REAL code to sub1 AND a plan file into docsRepo must NOT
// list docsRepo — plan writes belong to the plans axis, not the repos axis.
// docsRepo MUST be a real git repo (init) so that WITHOUT the fix it WOULD be
// counted (RED), proving the gate. The plan target need not exist on disk —
// gitRootOf only walks .git up the chain.
const docsRepo = path.join(base, 'docsrepo');
fs.mkdirSync(path.join(docsRepo, 'plans'), { recursive: true });
init(docsRepo);
fs.writeFileSync(path.join(docsRepo, 'plans', 'seed.md'), '# seed\n');
g(docsRepo, 'add -A'); g(docsRepo, 'commit -m init');
const UUID_PLANONLY = '33333333-3333-4333-8333-333333333333';
fs.writeFileSync(path.join(projDir, `${UUID_PLANONLY}.jsonl`),
  toolLine('Write', { file_path: path.join(wsRepo, 'sub1', 'f.txt') })          // real code work
  + toolLine('mcp__filesystem__write_file', { path: path.join(docsRepo, 'plans', 'feature.md') })); // plan bookkeeping

// v55: file-level scope fixture — a repo where the session writes ONE file
// (mine.txt) but the repo also has ANOTHER dirty file (other.txt) from OUTSIDE
// the session. The panel must list ONLY mine.txt; git.status() alone lists BOTH
// (every other session's churn — the ~/.claude bug) -> RED without the fix.
const scopeRepo = path.join(base, 'scoperepo');
fs.mkdirSync(scopeRepo);
init(scopeRepo);
fs.writeFileSync(path.join(scopeRepo, 'mine.txt'), 'base\n');
fs.writeFileSync(path.join(scopeRepo, 'other.txt'), 'base\n');
g(scopeRepo, 'add -A'); g(scopeRepo, 'commit -m init');
fs.writeFileSync(path.join(scopeRepo, 'mine.txt'), 'base\nSESSION-EDIT\n');   // session-touched dirty
fs.writeFileSync(path.join(scopeRepo, 'other.txt'), 'base\nFOREIGN-EDIT\n');  // dirty, NOT this session
const UUID_SCOPE = '44444444-4444-4444-8444-444444444444';
fs.writeFileSync(path.join(projDir, `${UUID_SCOPE}.jsonl`),
  toolLine('Write', { file_path: path.join(scopeRepo, 'mine.txt') }));         // only mine.txt

// v46.5: the deck passes --session-id on EVERY creation — shim drops argv.
const SHELL_SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shim-')), 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM; // real shell, never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';     // open-in-editor: resolve, never launch
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // session-truth fixtures, real ~/.claude untouched
// v53: a fake editor (marker script) to exercise the LIVE spawn path without a
// real IDE — it records the file path it was launched with. Set BEFORE main so
// availableEditors() (cached on first call) includes it.
const EDITOR_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-editor-'));
const MARKER_FILE = path.join(EDITOR_TMP, 'opened.txt');
const FAKE_EDITOR = path.join(EDITOR_TMP, 'fake-editor.sh');
fs.writeFileSync(FAKE_EDITOR,
  `#!/bin/bash\nprintf '%s' "$1" > ${JSON.stringify(MARKER_FILE)}\n`, { mode: 0o755 });
process.env.CLAUDE_DECK_FAKE_EDITOR = FAKE_EDITOR;
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ask-gp-')); // never the running deck's ask channel
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-'))); // never share a live profile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const results = {};
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const j = (code) => win.webContents.executeJavaScript(code, true);
    // The git panel is a tab of the docked #side-panel (P1-09) that AUTO-MAXIMIZES when it opens (A11): the diff overlay
    // then takes its width from the window (t17, t35).

    // t0 — bundle present under CSP default-src 'self'.
    results.t0_diff2html_loaded = await j(`typeof Diff2Html !== 'undefined' && typeof Diff2Html.html === 'function'`);

    // Open a pane on the dirty repo, then the panel via the REAL pane button.
    await j(`openPane({ cwd: ${JSON.stringify(repo)}, title: 'probe' })`);
    await sleep(1200);
    const paneId = await j(`[...panes.keys()][0]`);
    // v39.1: the pane button is gone — entry points are the session ⋮ menu
    // (DOM-gated in t18) and this direct call with the new target shape.
    await j(`openGitPanel({ paneId: '${paneId}' })`);
    await sleep(900); // status round-trip
    // A5: the head is repo · branch · #glog-badge · #glog-state; the selected row of the log is the uncommitted one.
    results.diag_head = await j(`({
      repo: document.getElementById('gp-repo').textContent,
      branch: document.getElementById('gp-branch').textContent,
      badge: document.getElementById('glog-badge').textContent,
      state: document.getElementById('glog-state').textContent,
      selRow: (document.querySelector('#glog-log .glog-row.sel, #glog-log .glog-row[aria-current="true"]') || {}).textContent ?? null,
      gone: ['gp-sync', 'gp-counts', 'gp-base'].filter((id) => document.getElementById(id)),
      sel: gp.sel,
      classOpen: document.getElementById('git-panel').classList.contains('open'),
      open: gp.open && !document.getElementById('git-panel').hidden,
    })`);
    results.t1_header = results.diag_head.open
      && results.diag_head.repo === 'repo'
      && results.diag_head.branch.includes('main')
      && results.diag_head.badge === 'branche actuelle'
      && results.diag_head.gone.length === 0
      && results.diag_head.sel === 'wip'
      && /(?:^|\D)9 fichiers(?!\w)/.test(results.diag_head.selRow || ''); // the row text is « Modifications non commitées9 fichiers—maintenant »

    const rows = await j(`gp.rows.map((r) => ({ path: r.path, kind: r.kind, glyph: r.glyph, from: r.from || null, pills: !!r.pills }))`);
    results.diag_rows = rows;
    const find = (p, k) => rows.find((r) => r.path === p && r.kind === k);
    const filesText = await j(`document.getElementById('gp-files').textContent`);
    const iS = filesText.indexOf('Indexés');
    const iU = filesText.indexOf('Non indexés');
    const iT = filesText.indexOf('Non suivis');
    results.t2_groups = !!(find('b.txt', 'staged') && find('ren-new.txt', 'staged')
      && find('ren-new.txt', 'staged').from === 'ren-old.txt'
      && find('a.txt', 'unstaged') && find('big.txt', 'unstaged') && find('bin.dat', 'unstaged')
      && find('marker.txt', 'unstaged') && find('wide.txt', 'unstaged')
      && find('new.txt', 'untracked') && find('sneaky-link', 'untracked')
      && rows.length === 9)
      && iS >= 0 && iU > iS && iT > iU;

    // t3 — lazy: placeholder still there, no d2h table yet, the diff overlay is closed.
    results.t3_lazy = await j(`document.getElementById('gp-diff').textContent.includes('Sélectionne')
      && !document.querySelector('#gp-diff .d2h-diff-table')
      && document.getElementById('glog-diff').hidden === true`);

    // t4 — click a.txt (unstaged) -> rendered diff contains the new line.
    const clickRow = (p, k) => j(`(() => {
      const idx = gp.rows.findIndex((r) => r.path === ${JSON.stringify(p)} && r.kind === ${JSON.stringify(k)});
      return document.querySelectorAll('#gp-files .gp-row')[idx].click() || idx;
    })()`);
    await clickRow('a.txt', 'unstaged');
    await sleep(700);
    results.t4_diff_renders = await j(`!!document.querySelector('#gp-diff .d2h-diff-table')
      && document.getElementById('gp-diff').textContent.includes('MODIFIED-LINE')`);

    // t5 — untracked -> full add.
    await clickRow('new.txt', 'untracked');
    await sleep(700);
    results.t5_untracked_full_add = await j(`!!document.querySelector('#gp-diff .d2h-ins')
      && document.getElementById('gp-diff').textContent.includes('fresh-untracked-line')`);

    // t6 — binary -> message, no table.
    await clickRow('bin.dat', 'unstaged');
    await sleep(700);
    results.t6_binary_message = await j(`document.getElementById('gp-diff').textContent.includes('binaire')
      && !document.querySelector('#gp-diff .d2h-diff-table')`);

    // t7 — big diff capped, then "voir tout".
    await clickRow('big.txt', 'unstaged');
    await sleep(900);
    const capped = await j(`({
      banner: !!document.querySelector('#gp-diff .gp-capped'),
      table: !!document.querySelector('#gp-diff .d2h-diff-table'),
      text: (document.querySelector('#gp-diff .gp-capped') || {}).textContent || '',
    })`);
    results.diag_capped = capped;
    await j(`(document.querySelector('#gp-diff .gp-more') || { click: () => {} }).click()`);
    await sleep(1500); // full 3000-line render
    const full = await j(`({
      banner: !!document.querySelector('#gp-diff .gp-capped'),
      hasLast: document.getElementById('gp-diff').textContent.includes('big-line-2999'),
    })`);
    results.diag_full = full;
    results.t7_cap_then_full = capped.banner && capped.table && /\d{4} lignes/.test(capped.text)
      && !full.banner && full.hasLast;

    // t8 — rename diff (staged side).
    await clickRow('ren-new.txt', 'staged');
    await sleep(700);
    results.t8_rename = await j(`(() => {
      const row = [...document.querySelectorAll('#gp-files .gp-row')]
        .find((r) => (r.querySelector('.gp-path').title || '').includes('ren-old.txt'));
      return !!row && row.querySelector('.gp-path').title === 'ren-old.txt → ren-new.txt'
        && !document.getElementById('gp-diff').textContent.includes('⚠');
    })()`);

    // t9 — keyboard: selection moves; the panel opened auto-maximized (A11), so ONE Escape closes it and the
    // width is back; a maximize the user chose (#sp-max, or made before the git tab opened) keeps « Escape restores first ».
    const key = (k) => j(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
    const spState = `({ open: gp.open, max: sp.max, hidden: document.getElementById('side-panel').hidden })`;
    await j(`gpLoadDiff(0)`); await sleep(400);
    // no_jk_nav — j / k move nothing on the git panel; the arrows (also asserted by t9) still do.
    const jkSel = [];
    for (const k of ['j', 'k']) { await key(k); await sleep(350); jkSel.push(await j(`gp.selected`)); }
    await key('ArrowDown'); await sleep(350);
    const selAfterJ = await j(`gp.selected`);
    await key('ArrowUp'); await sleep(350);
    const selAfterK = await j(`gp.selected`);
    results.diag_no_jk_nav = { jkSel, selAfterJ, selAfterK };
    results.no_jk_nav = jkSel.every((s) => s === 0) && selAfterJ === 1 && selAfterK === 0;
    const autoOn = await j(spState);
    await key('Escape'); await sleep(400);
    const autoEsc1 = await j(spState); // auto max: one Escape closes the panel and restores the width
    const openFirst = `openGitPanel({ paneId: [...panes.keys()][0] })`;
    const clickMax = async () => { await j(`document.getElementById('sp-max').click()`); await sleep(250); };
    await j(openFirst); await sleep(700);
    await clickMax(); await clickMax(); // restore, then maximize again: from now on the max is the user's
    const userOn = await j(spState);
    await key('Escape'); await sleep(400);
    const userEsc1 = await j(spState);
    await key('Escape'); await sleep(400);
    const userEsc2 = await j(spState);
    await j(openFirst); await sleep(700);
    await j(`document.querySelector('.sp-tab[data-tab="files"]').click()`); await sleep(500); // leaves the git tab: the auto max is undone
    await clickMax(); // the user maximizes on the Files tab, then opens the git tab: nothing to auto-maximize
    await j(openFirst); await sleep(700);
    const preOn = await j(spState);
    await key('Escape'); await sleep(400);
    const preEsc1 = await j(spState);
    await key('Escape'); await sleep(400);
    const preEsc2 = await j(spState);
    results.diag_kb = { selAfterJ, selAfterK, autoOn, autoEsc1, userOn, userEsc1, userEsc2, preOn, preEsc1, preEsc2 };
    results.t9_keyboard = selAfterJ === 1 && selAfterK === 0
      && autoOn.open === true && autoOn.max === true
      && autoEsc1.open === false && autoEsc1.max === false && autoEsc1.hidden === true
      && userOn.open === true && userOn.max === true
      && userEsc1.open === true && userEsc1.max === false
      && userEsc2.open === false && userEsc2.hidden === true
      && preOn.open === true && preOn.max === true
      && preEsc1.open === true && preEsc1.max === false
      && preEsc2.open === false && preEsc2.hidden === true;

    // t10 — clean repo empty state (new pane, reopen panel).
    await j(`openPane({ cwd: ${JSON.stringify(cleanRepo)}, title: 'clean' })`);
    await sleep(1100);
    const pane2 = await j(`[...panes.keys()][1]`);
    await j(`openGitPanel({ paneId: '${pane2}' })`);
    await sleep(900);
    results.t10_clean = await j(`document.getElementById('gp-files').textContent.includes('working tree clean')`);

    // t11 — non-repo empty state.
    await j(`openPane({ cwd: ${JSON.stringify(nonRepo)}, title: 'norepo' })`);
    await sleep(1100);
    const pane3 = await j(`[...panes.keys()][2]`);
    await j(`openGitPanel({ paneId: '${pane3}' })`);
    await sleep(900);
    // v46.5: an unnamed new pane DOES get a session id at spawn now — the
    // session-truth path applies (0 touched repos -> cwd fall-through, cwd
    // not a repo) -> the SESSION-SCOPED wording. The plain « pas un dépôt
    // git » only shows when no session id is known at all.
    results.t11_not_repo = await j(`document.getElementById('gp-files').textContent.includes('aucun projet git touché par cette session')`);

    // ---- attack-class gates (review round) --------------------------------
    // Back on the dirty repo's pane for both.
    await j(`openGitPanel({ paneId: '${paneId}' })`);
    await sleep(900);

    // t12 — a TEXT diff containing "GIT binary patch" must render as TEXT
    // (the binary check is ^-anchored; content lines carry +/-/space).
    await clickRow('marker.txt', 'unstaged');
    await sleep(700);
    results.t12_marker_text_not_binary = await j(`!!document.querySelector('#gp-diff .d2h-diff-table')
      && document.getElementById('gp-diff').textContent.includes('GIT binary patch')
      && !document.getElementById('gp-diff').textContent.includes('binaire')`);

    // t13 — untracked symlink: named, NEVER rendered through (the target
    // lives OUTSIDE the repo; its content must not appear).
    await clickRow('sneaky-link', 'untracked');
    await sleep(700);
    results.t13_symlink_not_followed = await j(`(() => {
      const t = document.getElementById('gp-diff').textContent;
      return t.includes('lien symbolique') && !t.includes('TOP-SECRET-CONTENT');
    })()`);

    // ---- step-4 gates ------------------------------------------------------
    // t14 — copy path: row action puts the REPO-RELATIVE path on the clipboard.
    await clickRow('a.txt', 'unstaged');
    await sleep(500);
    await j(`(() => {
      const row = document.querySelectorAll('#gp-files .gp-row')[gp.selected];
      row.dispatchEvent(new Event('mouseover'));
      row.querySelector('.gp-act').click(); // first action = copy
    })()`);
    await sleep(250);
    results.t14_copy_path = (await j(`window.api.clipboardRead()`)) === 'a.txt';

    // t15 — hunk fold: click the @@ header -> its lines hide; click again -> back.
    const hunkLines = () => j(`[...document.querySelectorAll('#gp-diff tbody tr')]
      .filter((tr) => !tr.querySelector('.d2h-info') && tr.offsetParent !== null).length`);
    const visibleBefore = await hunkLines();
    await j(`document.querySelector('#gp-diff .d2h-info').click()`);
    await sleep(200);
    const visibleFolded = await hunkLines();
    await j(`document.querySelector('#gp-diff .d2h-info').click()`);
    await sleep(200);
    const visibleRestored = await hunkLines();
    results.diag_fold = { visibleBefore, visibleFolded, visibleRestored };
    results.t15_hunk_fold = visibleBefore > 0 && visibleFolded === 0
      && visibleRestored === visibleBefore;

    // t16 — open in editor: dry-run seam resolves ROOT-relative -> absolute.
    const openRes = await j(`window.api.gitOpenFile({ paneId: '${paneId}' }, 'a.txt')`);
    results.diag_open = openRes;
    results.t16_open_in_editor = !!openRes && openRes.ok === true && openRes.dryRun === true
      && openRes.resolved === path.join(repo, 'a.txt');

    // t17 — responsive split: the panel is maximized, so the diff overlay's width follows the WINDOW (the log column
    // keeps what the refs and detail columns leave): a wide window (>= 980 px diff) -> side-by-side re-render; a narrow
    // one -> line-by-line.
    const measure = () => j(`({ w: document.getElementById('gp-diff').clientWidth, max: sp.max,
      fmt: gp.lastRender && gp.lastRender.format, side: !!document.querySelector('#gp-diff .d2h-file-side-diff') })`);
    win.setSize(2600, 900);
    await sleep(1100); // window resize -> placeMax, RO debounce (250ms) + re-render
    const wide = await measure();
    win.setSize(1100, 900);
    await sleep(1100);
    const narrow = await measure();
    results.diag_split = { wide, narrow };
    results.t17_responsive_split = wide.max === true && wide.w >= 980 && wide.fmt === 'side-by-side' && wide.side === true
      && narrow.w < 980 && narrow.fmt === 'line-by-line' && narrow.side === false;

    // ---- v39.1 gates -------------------------------------------------------
    // t18 — entry points (B22 + B2): the right-click session menu no longer
    // carries "Diff git" (it holds copy-ID / rename / delete only), and the Git
    // tab of the side panel is what opens the git panel (real tab click).
    const t18 = await j(`(() => {
      openCtxMenu(10, 10, document.createElement('div'));
      const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.dataset.action);
      closeCtxMenu();
      closeSidePanel();
      const tab = document.querySelector('.sp-tab[data-tab="git"]');
      if (!tab) return { items, tab: false };
      tab.click();
      return { items, tab: true, label: tab.textContent.trim(), selected: tab.getAttribute('aria-selected'),
               open: gp.open, shown: !document.getElementById('git-panel').hidden };
    })()`);
    results.diag_menu = t18;
    results.t18_menu_entry = JSON.stringify(t18.items) === JSON.stringify(['copyid', 'rename', 'delete'])
      && t18.tab === true && t18.selected === 'true' && t18.open === true && t18.shown === true;

    // t19 — the panel opens MAXIMIZED (A11, replaces the docked width of P1-09): it covers the whole area right of the
    // sidebar (left = the workspace's left edge, the row's full height, right = the row's right edge), sidebar intact,
    // inside #side-panel.
    await j(`openGitPanel({ paneId: '${paneId}' })`);
    await sleep(900);
    const t19 = await j(`(() => {
      const w = document.getElementById('workspace').getBoundingClientRect();
      const sp0 = document.getElementById('side-panel').getBoundingClientRect();
      const row = document.getElementById('main-row').getBoundingClientRect();
      const sb = document.getElementById('sidebar').getBoundingClientRect();
      return { dl: Math.abs(sp0.left - w.left), dr: Math.abs(sp0.right - row.right),
               dt: Math.abs(sp0.top - row.top), db: Math.abs(sp0.bottom - row.bottom),
               clear: sp0.left >= sb.right - 2, max: sp.max === true, sbW: sb.width,
               inside: document.getElementById('side-panel').contains(document.getElementById('git-panel')) };
    })()`);
    results.diag_fullwidth = t19;
    results.t19_full_workspace = t19.dl <= 2 && t19.dr <= 2 && t19.dt <= 2 && t19.db <= 2
      && t19.clear === true && t19.max === true && t19.sbW > 0 && t19.inside === true;

    // t20 — SESSION TRUTH picker: a multi-project session lists ONLY its
    // touched repos (sub1 from the main transcript, sub2 from a SUBAGENT
    // transcript) — NOT sub3 (dirty but untouched), NOT plain, NOT outside.
    await j(`openGitPanel({ sessionId: '${UUID_MULTI}' })`);
    await sleep(900);
    const list = await j(`[...document.querySelectorAll('#gp-files .gp-row .gp-path')].map((x) => x.textContent)`);
    await j(`(() => {
      const rows = [...document.querySelectorAll('#gp-files .gp-row')];
      rows.find((r) => r.querySelector('.gp-path').textContent === 'sub1').click();
    })()`);
    await sleep(900);
    const sub1 = await j(`({
      repo: document.getElementById('gp-repo').textContent,
      back: document.getElementById('gp-repo').classList.contains('gp-back'),
      hasFile: gp.rows.some((r) => r.path === 'f.txt' && r.kind === 'unstaged'),
    })`);
    await j(`document.getElementById('gp-repo').click()`); // breadcrumb back
    await sleep(900);
    const backToList = await j(`document.getElementById('gp-files').textContent.includes('Projets de la session')`);
    results.diag_ws = { list, sub1, backToList };
    results.t20_session_picker = JSON.stringify([...list].sort()) === JSON.stringify(['sub1', 'sub2'])
      && sub1.repo === '← sub1' && sub1.back === true && sub1.hasFile === true
      && backToList === true;

    // t21 — mono-project session goes STRAIGHT to its repo status (no
    // picker, no breadcrumb).
    await j(`openGitPanel({ sessionId: '${UUID_MONO}' })`);
    await sleep(900);
    const mono = await j(`({
      repo: document.getElementById('gp-repo').textContent,
      back: document.getElementById('gp-repo').classList.contains('gp-back'),
      hasFile: gp.rows.some((r) => r.path === 'f.txt' && r.kind === 'unstaged'),
      repoIndex: gp.target.repoIndex,
    })`);
    results.diag_mono = mono;
    results.t21_mono_straight_in = mono.repo === 'sub1' && mono.back === false
      && mono.hasFile === true && mono.repoIndex === 0;

    // t22 — the lazy diff addresses the SESSION repo (adopted index), not
    // some cwd: the rendered diff must carry sub1's edit.
    await j(`(() => {
      const idx = gp.rows.findIndex((r) => r.path === 'f.txt' && r.kind === 'unstaged');
      return document.querySelectorAll('#gp-files .gp-row')[idx].click() || idx;
    })()`);
    await sleep(800);
    results.t22_diff_from_session_repo = await j(
      `document.getElementById('gp-diff').textContent.includes('WS-SUB1-EDIT')`);

    // ---- v53 gates: open-with chooser + split-diff wrap -------------------
    // Back on the dirty repo's pane (line-by-line width from t17/t19).
    await j(`openGitPanel({ paneId: '${paneId}' })`);
    await sleep(900);

    // t23 — open-with IPC: the editors list (ids+labels) drives a dry-run open
    // that resolves the chosen editor to an absolute launcher command.
    const eds = await j(`window.api.gitEditors()`);
    const firstId = eds && eds.ok && eds.editors[0] ? eds.editors[0].id : null;
    const openWith = firstId
      ? await j(`window.api.gitOpenFile({ paneId: '${paneId}' }, 'a.txt', ${JSON.stringify(firstId)})`)
      : null;
    results.diag_editors = { eds, firstId, openWith };
    results.t23_open_with_editor = !!eds && eds.ok === true && Array.isArray(eds.editors)
      && eds.editors.length >= 1 && eds.editors.every((e) => e.id && e.label)
      && !!openWith && openWith.ok === true && openWith.dryRun === true
      && openWith.editor === firstId
      && typeof openWith.cmd === 'string' && openWith.cmd.length > 0
      && openWith.resolved === path.join(repo, 'a.txt');

    // t24 — the ↗ row action opens the chooser menu (editors + system entry),
    // positioned on-screen.
    await clickRow('a.txt', 'unstaged');
    await sleep(300);
    await j(`(() => {
      const row = document.querySelectorAll('#gp-files .gp-row')[gp.selected];
      const acts = row.querySelectorAll('.gp-act');
      acts[acts.length - 1].click(); // last action = open ↗
    })()`);
    await sleep(400); // first gpEditors() does an IPC round-trip
    const menu = await j(`(() => {
      const m = document.getElementById('gp-open-menu');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { items: [...m.querySelectorAll('.gp-open-item')].map((b) => b.textContent),
               onscreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth };
    })()`);
    results.diag_chooser = menu;
    results.t24_chooser_menu = !!menu && menu.items.includes('Éditeur système')
      && menu.items.length >= 2 && menu.onscreen === true;

    // t25 — Escape closes ONLY the chooser; the git panel stays open.
    await key('Escape');
    await sleep(150);
    results.t25_menu_esc_keeps_panel = await j(
      `!document.getElementById('gp-open-menu') && gp.open === true`);

    // t35 — split diff halves WRAP (cf75d06): a.txt's changed line is 600+ chars on BOTH sides, yet at wide width
    // (window 2300, panel maximized, side-by-side) no half overflows and no sticky h-bar is mounted. Replaces the
    // scroll-sync / burst / sticky / resize / fold gates (t26, t27, t30-t32) of the horizontal-scroll design.
    win.setSize(2300, 900);
    await sleep(400);
    await clickRow('a.txt', 'unstaged');
    await sleep(900); // side-by-side render at wide width
    const wrap = await j(`(() => {
      const sides = [...document.querySelectorAll('#gp-diff .d2h-file-side-diff')];
      return { fmt: gp.lastRender && gp.lastRender.format, n: sides.length,
        over: sides.map((s) => s.scrollWidth - s.clientWidth),
        long: sides.every((s) => s.textContent.length > 600),
        bars: document.querySelectorAll('#gp-diff .gp-hscroll, .gp-hscroll').length };
    })()`);
    results.diag_split_wrap = wrap;
    results.t35_split_wraps_no_hscroll = wrap.fmt === 'side-by-side' && wrap.n >= 2 && wrap.long === true
      && wrap.over.every((o) => o <= 1) && wrap.bars === 0;

    // t28 — chooser a11y + keyboard: role=menu/menuitem, first item auto-focused,
    // ArrowDown roves focus (matches sidebar.js / new-session.js menu pattern).
    win.webContents.focus(); // ensure the renderer owns focus for activeElement
    await clickRow('a.txt', 'unstaged');
    await sleep(250);
    await j(`(() => {
      const row = document.querySelectorAll('#gp-files .gp-row')[gp.selected];
      const acts = row.querySelectorAll('.gp-act');
      acts[acts.length - 1].click();
    })()`);
    await sleep(400);
    const kbd = await j(`(() => {
      const m = document.getElementById('gp-open-menu');
      if (!m) return null;
      const its = [...m.querySelectorAll('.gp-open-item')];
      const firstFocused = document.activeElement === its[0];
      const role = m.getAttribute('role');
      const itemRoles = its.every((b) => b.getAttribute('role') === 'menuitem');
      m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const movedTo1 = document.activeElement === its[1];
      return { firstFocused, role, itemRoles, movedTo1, n: its.length };
    })()`);
    results.diag_kbd_menu = kbd;
    results.t28_chooser_keyboard = !!kbd && kbd.role === 'menu' && kbd.itemRoles === true
      && kbd.firstFocused === true && kbd.movedTo1 === true;
    await key('Escape');
    await sleep(150);

    // t29 — LIVE spawn path (NO_OPEN unset for ONE call): the resolved launcher
    // is invoked with the absolute file path. A fake editor (marker script)
    // proves the spawn actually runs with the right arg — closing the dry-run
    // seam's blind spot on the feature's CORE action (open the file).
    process.env.CLAUDE_DECK_NO_OPEN = '';
    const liveRes = await j(`window.api.gitOpenFile({ paneId: '${paneId}' }, 'a.txt', 'fake')`);
    process.env.CLAUDE_DECK_NO_OPEN = '1';
    await sleep(350); // detached script writes its marker
    let marker = '';
    try { marker = fs.readFileSync(MARKER_FILE, 'utf8').trim(); } catch (_) { /* not written */ }
    results.diag_spawn = { liveRes, marker, expect: path.join(repo, 'a.txt') };
    results.t29_live_spawn = !!liveRes && liveRes.ok === true && liveRes.dryRun !== true
      && liveRes.editor === 'fake' && marker === path.join(repo, 'a.txt');

    // t33 (v54) — plan-only repo is NOT a touched project: a session that
    // writes code to sub1 AND a plan into a SEPARATE docs repo goes STRAIGHT
    // into sub1 (mono), never a picker listing 'docsrepo'. WITHOUT the fix
    // this session has 2 touched repos -> picker -> RED.
    await j(`openGitPanel({ sessionId: '${UUID_PLANONLY}' })`);
    await sleep(900);
    const planOnly = await j(`({
      repo: document.getElementById('gp-repo').textContent,
      back: document.getElementById('gp-repo').classList.contains('gp-back'),
      isPicker: document.getElementById('gp-files').textContent.includes('Projets de la session'),
      names: [...document.querySelectorAll('#gp-files .gp-row .gp-path')].map((x) => x.textContent),
    })`);
    results.diag_planonly = planOnly;
    results.t33_plan_repo_excluded = planOnly.repo === 'sub1' && planOnly.back === false
      && planOnly.isPicker === false && !planOnly.names.includes('docsrepo');

    // t34 (v55) — FILE-LEVEL session scope: a session that wrote ONLY mine.txt
    // must list mine.txt and NOT other.txt (dirty but written by NO session).
    // WITHOUT the fix git.status() lists BOTH files -> RED. This is the exact
    // ~/.claude bug (234 dirty entries, session touched 4) in miniature.
    await j(`openGitPanel({ sessionId: '${UUID_SCOPE}' })`);
    await sleep(900);
    const scopeRes = await j(`({
      repo: document.getElementById('gp-repo').textContent,
      names: [...document.querySelectorAll('#gp-files .gp-row .gp-path')].map((x) => x.textContent),
    })`);
    results.diag_scope = scopeRes;
    results.t34_file_scope = scopeRes.repo === 'scoperepo'
      && JSON.stringify([...scopeRes.names].sort()) === JSON.stringify(['mine.txt'])
      && !scopeRes.names.includes('other.txt');
  } catch (err) {
    results.error = String(err && err.stack || err);
  }

  const gates = Object.entries(results).filter(([k]) => /^t\d/.test(k));
  const pass = gates.length === 31 && gates.every(([, v]) => v === true) && results.no_jk_nav === true && !results.error; // t0..t25, t28, t29, t33..t35 + no_jk_nav
  console.log(JSON.stringify({ pass, results }, null, 2));
  for (const [k, v] of [...gates, ['no_jk_nav', results.no_jk_nav]]) console.log(`${v === true ? 'PASS' : 'FAIL'} ${k}`);
  console.log(pass ? `VERDICT: ALL GREEN (${gates.length + 1}/${gates.length + 1})` : `VERDICT: FAIL${results.error ? ' (error)' : ''}`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  try { fs.rmSync(EDITOR_TMP, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  app.exit(pass ? 0 : 1);
});
