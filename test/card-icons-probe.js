// test/card-icons-probe.js — E2E probe: v41 sidebar presence icons.
// Two binary icons at the bottom of each session card, driven by the SAME
// one-pass activity parse as the git/plans panels:
//   git  = session WROTE >=1 file in a git repo (write-only, v39.2)
//   plan = session CREATED >=1 plan (written file under */plans/*.md or
//          native ExitPlanMode) — a plan only READ never lights it.
// Gates:
//   c0  every session row carries exactly ONE .session-icons slot
//   c1  S_BOTH    -> [git, plan] (fixed order)
//   c2  S_GITONLY -> [git]
//   c3  S_PLANFILE (plan written OUTSIDE any git repo) -> [plan] only
//   c4  S_INLINE  (ExitPlanMode only) -> [plan] only
//   c5  S_READ    (plan READ, zero writes) -> [] — created != consulted
//   c6  S_NONE    (no tool_use at all) -> []
//   c7  layout stable: all rows same height (0, 1 or 2 icons — no jump)
//   c8  every icon has a non-empty tooltip
//   c9  manual re-render (cache hit -> inline flags) keeps the icons
//   c10 corrupted transcript (garbage lines) -> row exists, [] icons, no crash
//   c11 binary presence only: no text/digits inside the strip
//   c12 v41.1 meta repo segment, written separator-first (subtitle « word · repo · branch »):
//       S_BOTH touches 2 repos -> " · proj +1"
//   c13 'HEAD' (CC no-branch fallback) hidden everywhere; real branch shows
//   c14 no-activity session -> empty repo segment
//   c15 single-repo session -> " · proj" without the +N suffix
// Run: cd claude-deck && npx electron test/card-icons-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-icons-probe-'));
const proj = path.join(base, 'proj'); // a git repo (gitRootOf sees .git)
const plansDir = path.join(proj, 'docs', 'plans');
fs.mkdirSync(plansDir, { recursive: true });
fs.mkdirSync(path.join(proj, '.git'));
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
// A plans dir OUTSIDE any git repo: plan icon without the git icon.
const loosePlans = path.join(base, 'loose', 'plans');
fs.mkdirSync(loosePlans, { recursive: true });

// Second git repo: multi-repo "+N" suffix on the meta segment (v41.1).
const proj2 = path.join(base, 'proj2');
fs.mkdirSync(path.join(proj2, '.git'), { recursive: true });

const SRC = path.join(proj, 'src', 'app.js');
const SRC2 = path.join(proj2, 'lib.js');
const MADE = path.join(plansDir, 'made.plan.md');
const LOOSE = path.join(loosePlans, 'standalone.plan.md');
fs.writeFileSync(SRC, '// touched by sessions\n');
fs.writeFileSync(SRC2, '// second repo\n');
fs.writeFileSync(MADE, '# Made Plan\n');
fs.writeFileSync(LOOSE, '# Standalone Plan\n');

const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });

const S_BOTH = '11111111-1111-4111-8111-111111111111';
const S_GITONLY = '22222222-2222-4222-8222-222222222222';
const S_PLANFILE = '33333333-3333-4333-8333-333333333333';
const S_INLINE = '44444444-4444-4444-8444-444444444444';
const S_READ = '55555555-5555-4555-8555-555555555555';
const S_NONE = '66666666-6666-4666-8666-666666666666';
const S_BAD = '77777777-7777-4777-8777-777777777777';
const ALL = [S_BOTH, S_GITONLY, S_PLANFILE, S_INLINE, S_READ, S_NONE, S_BAD];

const ts = (i) => `2026-06-05T11:0${i}:00.000Z`;
// gitBranch fixtures: 'HEAD' = CC's no-branch fallback (13533/13533 real
// entries on this machine) -> must be HIDDEN; a real branch must SHOW.
const headOf = (branch) => JSON.stringify({ type: 'summary', cwd: proj, gitBranch: branch }) + '\n';
const toolLine = (name, input, t) => JSON.stringify({
  type: 'assistant', timestamp: t,
  message: { content: [{ type: 'tool_use', name, input }] },
}) + '\n';
const w = (id, body, branch = 'HEAD') => fs.writeFileSync(
  path.join(projDir, `${id}.jsonl`), headOf(branch) + body);

w(S_BOTH, toolLine('Write', { file_path: SRC }, ts(0))
  + toolLine('Write', { file_path: MADE }, ts(1))
  + toolLine('Write', { file_path: SRC2 }, ts(2))); // 2nd repo -> "+1"
w(S_GITONLY, toolLine('Write', { file_path: SRC }, ts(0)), 'feat/x'); // real branch shows
w(S_PLANFILE, toolLine('mcp__filesystem__write_file', { path: LOOSE }, ts(0)));
w(S_INLINE, toolLine('ExitPlanMode', { plan: '# Inline Plan\n\nbody\n' }, ts(0)));
w(S_READ, toolLine('Read', { file_path: MADE }, ts(0))); // consulted, NOT created
w(S_NONE, '');
w(S_BAD, '{"broken json\nnot json either\n'); // unreadable lines -> indeterminate-safe

process.env.CLAUDE_DECK_BIN = '/bin/bash'; // real shell, never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // real ~/.claude untouched
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

    const snapshot = `(() => {
      const out = {};
      for (const row of document.querySelectorAll('.session-row')) {
        const slots = row.querySelectorAll('.session-icons');
        const icons = [...row.querySelectorAll('.sicon')];
        out[row.dataset.sessionId] = {
          slots: slots.length,
          kinds: icons.map((i) => i.dataset.kind),
          tips: icons.map((i) => i.title),
          stripText: slots.length ? slots[0].textContent.trim() : null,
          height: Math.round(row.getBoundingClientRect().height),
          meta: (row.querySelector('.meta') || {}).textContent || '',
          repoSeg: (row.querySelector('.meta-repo') || {}).textContent || '',
        };
      }
      return out;
    })()`;

    // Poll: cold cache -> first render shows nothing, the background queue
    // pushes flags in place. Wait until the two "slowest" expected icons land.
    let snap = {};
    for (let i = 0; i < 30; i++) {
      snap = await j(snapshot);
      const b = snap[S_BOTH];
      const inl = snap[S_INLINE];
      if (b && b.kinds.length === 2 && inl && inl.kinds.length === 1) break;
      await sleep(200);
    }
    results.diag_snapshot = snap;

    const g = (id) => snap[id] || { slots: 0, kinds: ['MISSING-ROW'], tips: [], height: -1 };
    results.c0_one_slot_per_row = ALL.every((id) => g(id).slots === 1);
    results.c1_both = JSON.stringify(g(S_BOTH).kinds) === '["git","plan"]';
    results.c2_gitonly = JSON.stringify(g(S_GITONLY).kinds) === '["git"]';
    results.c3_planfile_no_git = JSON.stringify(g(S_PLANFILE).kinds) === '["plan"]';
    results.c4_inline_plan = JSON.stringify(g(S_INLINE).kinds) === '["plan"]';
    results.c5_read_is_not_created = JSON.stringify(g(S_READ).kinds) === '[]';
    results.c6_none = JSON.stringify(g(S_NONE).kinds) === '[]';
    const heights = ALL.map((id) => g(id).height);
    results.c7_layout_stable = heights.every((h) => h > 0 && h === heights[0]);
    results.diag_heights = heights;
    results.c8_tooltips = ALL.every((id) => g(id).tips.every((t) => t && t.length > 3));
    results.c10_corrupted_safe = JSON.stringify(g(S_BAD).kinds) === '[]' && g(S_BAD).slots === 1;
    results.c11_binary_only = ALL.every((id) => g(id).stripText === '');
    // v41.1 — meta line: repo segment replaces the 'HEAD' noise. Separator-first
    // (' · repo[ +N]', sidebar.js setSessionIcons): subtitle reads « word · repo · branch ».
    results.c12_multi_repo_seg = g(S_BOTH).repoSeg === ' · proj +1';
    results.c13_head_hidden_branch_shown = ALL.every((id) => !g(id).meta.includes('HEAD'))
      && g(S_GITONLY).meta.includes('feat/x');
    results.c14_no_activity_empty_seg = g(S_NONE).repoSeg === '' && g(S_READ).repoSeg === '';
    results.c15_single_repo_no_suffix = g(S_GITONLY).repoSeg === ' · proj';

    // c9 — manual re-render: this time sessions-list is a cache HIT, flags
    // arrive inline with the rows (no push needed). Same final state.
    await j(`renderSessions()`);
    await sleep(600);
    const snap2 = await j(snapshot);
    results.c9_inline_rerender = JSON.stringify((snap2[S_BOTH] || {}).kinds) === '["git","plan"]'
      && JSON.stringify((snap2[S_READ] || {}).kinds) === '[]'
      && JSON.stringify((snap2[S_INLINE] || {}).kinds) === '["plan"]';
  } catch (e) {
    results.fatal = String(e && e.stack || e);
  }
  const gates = Object.entries(results).filter(([k]) => /^c\d+/.test(k));
  const failed = gates.filter(([, v]) => v !== true);
  console.log('\n=== card-icons-probe ===');
  for (const [k, v] of gates) console.log(`${v === true ? 'PASS' : 'FAIL'}  ${k}`);
  if (failed.length || results.fatal) {
    console.log('\n--- diagnostics ---');
    console.log(JSON.stringify(results, null, 2));
  }
  console.log(`VERDICT: ${failed.length === 0 && !results.fatal ? 'ALL GREEN' : 'RED'} (${gates.length - failed.length}/${gates.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length === 0 && !results.fatal ? 0 : 1);
});
