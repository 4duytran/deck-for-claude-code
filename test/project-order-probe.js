// test/project-order-probe.js — P4 (2026-09-18) probe: sidebar
// project-GROUP order is frozen at first scan and never reshuffles
// afterwards, even when a project's mtime moves. User's fix request,
// verbatim (widget mock): "recalculé seulement au lancement / un nouveau
// projet apparaît en fin de liste". Within-group SESSION order (still live
// recency, src/main/ipc/sessions.js:225) is untouched — out of scope, not
// asserted here.
// t8 covers F1 (Tier 2 review, 2026-09-18): an UNOBSERVED absence (a
// project's directory fails to list for one scan) must not be read as a
// removal — that would purge its recorded slot and re-append it as a
// stale-position "newcomer" the moment the fs cooperates again, silently
// reintroducing the exact reshuffle the user reported.
// Run: node_modules/.bin/electron test/project-order-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-order-probe-home-'));
process.env.HOME = FAKE_HOME;
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', 'fixture');
fs.mkdirSync(PROJ_DIR, { recursive: true });
// t8 needs a project ALONE in its own directory so chmod-ing that one
// directory unreadable (EACCES on fsp.readdir, :139) can't collaterally
// hide any other fixture.
const PROJ_DIR_W = path.join(FAKE_HOME, '.claude', 'projects', 'fixture-w');
fs.mkdirSync(PROJ_DIR_W, { recursive: true });

process.env.CLAUDE_DECK_BIN = path.join(FAKE_HOME, 'fake-claude.sh'); // unused (no spawn)
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

let uidCounter = 0;
const uuid = () => {
  uidCounter += 1;
  const n = String(uidCounter).padStart(12, '0');
  return `${n.slice(0, 8)}-aaaa-4bbb-8ccc-${n}`;
};

// Explicit mtime clock (seconds since epoch) — every fixture picks its own
// value so ordering never depends on wall-clock timing between tool calls.
const T0 = Math.floor(Date.now() / 1000) - 100000;

function mkSession(cwd, mtimeSec, dir = PROJ_DIR) {
  const sid = uuid();
  const filePath = path.join(dir, `${sid}.jsonl`);
  const body = `${JSON.stringify({
    type: 'user', cwd, gitBranch: '',
    message: { role: 'user', content: 'probe session' },
  })}\n`;
  fs.writeFileSync(filePath, body);
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
  return filePath;
}
const touch = (filePath, mtimeSec) => fs.utimesSync(filePath, mtimeSec, mtimeSec);

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-order-probe-')));

const { app, BrowserWindow } = require('electron');

const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}
const arr = (x) => JSON.stringify(x);

app.whenReady().then(async () => {
  await new Promise((r) => { setTimeout(r, 1200); });
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const order = () => js(`(async () => {
    const groups = await window.api.listSessions();
    return groups.map((g) => g.project);
  })()`);

  const PA = mkSession('/fake/ws/proj-a', T0 + 1000); // oldest
  const PB = mkSession('/fake/ws/proj-b', T0 + 2000); // middle
  const PC = mkSession('/fake/ws/proj-c', T0 + 3000); // newest

  // t1 — first call establishes the order exactly as today's live rule:
  // most-recently-active project first.
  const o1 = await order();
  gate('t1_initial_order_most_recent_first', arr(o1) === arr(['proj-c', 'proj-b', 'proj-a']),
    `order=${arr(o1)}`);

  // t2 — FREEZE: bump proj-a's mtime past everyone else (it would now rank
  // first under the old live-mtime sort). The recorded order must NOT move.
  touch(PA, T0 + 9000);
  const o2 = await order();
  gate('t2_freeze_survives_mtime_flip', arr(o2) === arr(o1),
    `after mtime flip: order=${arr(o2)} (expected unchanged ${arr(o1)})`);

  // t3 — a project absent from the first call appears later, with the
  // newest mtime of all -> it must land LAST, not first.
  const PD = mkSession('/fake/ws/proj-d', T0 + 50000);
  const o3 = await order();
  gate('t3_new_project_lands_last_despite_newest_mtime',
    arr(o3) === arr(['proj-c', 'proj-b', 'proj-a', 'proj-d']), `order=${arr(o3)}`);

  // t4 — the recorded order survives several MORE consecutive calls, with
  // further mtime churn injected between each.
  touch(PB, T0 + 60000);
  const o4 = await order();
  touch(PC, T0 + 70000);
  const o5 = await order();
  const o6 = await order();
  gate('t4_frozen_across_several_consecutive_calls',
    arr(o4) === arr(o3) && arr(o5) === arr(o3) && arr(o6) === arr(o3),
    `o4=${arr(o4)} o5=${arr(o5)} o6=${arr(o6)} (expected all = ${arr(o3)})`);

  // t5 — a project disappearing leaves no hole: the list stays contiguous,
  // proj-b just isn't in it any more.
  fs.unlinkSync(PB);
  const o7 = await order();
  gate('t5_disappear_no_hole', arr(o7) === arr(['proj-c', 'proj-a', 'proj-d']), `order=${arr(o7)}`);

  // t6 — proj-b comes back later in the SAME run, with the newest mtime of
  // all. Chosen semantics (see probe/return notes): a re-appearance is NOT
  // a resurrection — treated exactly like a brand-new project (t3's rule),
  // lands LAST, never restored to its old slot (index 1).
  mkSession('/fake/ws/proj-b', T0 + 90000);
  const o8 = await order();
  gate('t6_reappear_lands_last_not_stale_slot',
    arr(o8) === arr(['proj-c', 'proj-a', 'proj-d', 'proj-b']), `order=${arr(o8)}`);

  // t7 — tie-break determinism: two BRAND-NEW projects with EQUAL mtime
  // must still sort deterministically (cwd tiebreak), independent of
  // fsp.readdir's unordered enumeration.
  mkSession('/fake/ws/proj-z', T0 + 99000);
  mkSession('/fake/ws/proj-y', T0 + 99000);
  const o9 = await order();
  gate('t7_equal_mtime_newcomers_deterministic_tiebreak',
    arr(o9) === arr(['proj-c', 'proj-a', 'proj-d', 'proj-b', 'proj-y', 'proj-z']), `order=${arr(o9)}`);

  // t8 — F1: proj-w lives ALONE in its own directory. Establish its slot,
  // then add a further newcomer (proj-v) so "its original slot" and "the
  // end of the list" are provably different positions. Make proj-w's
  // directory unreadable for one scan (EACCES on fsp.readdir, real cause of
  // an "unobserved" project — a permission race, not a deletion): it must
  // vanish from THAT call's output without disturbing anyone else, then on
  // the very next clean scan it must reappear in its ORIGINAL slot, ahead
  // of proj-v — never appended after it as a fresh "newcomer" would be.
  mkSession('/fake/ws/proj-w', T0 + 40000, PROJ_DIR_W);
  const o10 = await order();
  const idxW = o10.indexOf('proj-w');
  mkSession('/fake/ws/proj-v', T0 + 95000);
  const o11 = await order(); // proj-w's frozen reference order, proj-v now last
  fs.chmodSync(PROJ_DIR_W, 0o000);
  const o12 = await order();
  fs.chmodSync(PROJ_DIR_W, 0o755);
  const o13 = await order();
  gate('t8_unreadable_dir_keeps_slot_not_purged',
    idxW >= 0 && idxW < o11.length - 1 && !o12.includes('proj-w') && arr(o13) === arr(o11),
    `idxW=${idxW} o11=${arr(o11)} o12(during outage)=${arr(o12)} o13(recovered)=${arr(o13)}`);

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'project-order-probe.out'), `${report}\n`);
  const passN = results.filter((l) => l.startsWith('PASS')).length;
  console.log('\n=== P4 project-order probe ===\n' + report);
  console.log(`\nVERDICT: ${failed ? 'FAIL' : 'ALL GREEN'} (${passN}/${results.length})`);
  app.exit(failed ? 1 : 0);
});
