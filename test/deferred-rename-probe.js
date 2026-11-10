// v32 probe — deferred rename of a busy session. 6 gates.
// Run: npx electron test/deferred-rename-probe.js   (from the repo root)
//
// FULL ISOLATION (incident rule 2026-06-04): HOME is faked BEFORE main.js
// loads (it derives ~/.claude paths at require time) and userData is moved to
// a mkdtemp — a probe must NEVER share storage with a live deck.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Isolation + seams, all BEFORE the app module loads -------------------
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');

const ARGS_FILE = path.join(FAKE_HOME, 'claude-args.txt');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN, `#!/bin/bash\necho "$@" > "${ARGS_FILE}"\nsleep 300\n`, { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}
const countTitles = (f) => (fs.readFileSync(f, 'utf8').match(/"type":"custom-title"/g) || []).length;
const lastTwo = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').slice(-2).map((l) => {
  try { return JSON.parse(l); } catch (_) { return null; }
});

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const refresh = async () => { await js(`document.getElementById('refresh-sessions').click()`); await sleep(500); };

  // Helper: create a v28-named session via the UI, materialize its .jsonl,
  // close the pane (v28 persists both title lines) -> returns its sessionId.
  async function makeClosedNamedSession(name) {
    try { fs.unlinkSync(ARGS_FILE); } catch (_) {}
    await js(`document.getElementById('new-session').click()`);
    await sleep(300);
    await js(`(() => {
      document.getElementById('ns-name').value = ${JSON.stringify(name)};
      document.getElementById('ns-send').click();
    })()`);
    await sleep(1000);
    const m = fs.readFileSync(ARGS_FILE, 'utf8').trim()
      .match(/--session-id ([0-9a-f-]{36})/);
    const sid = m[1];
    fs.writeFileSync(path.join(PROJ_DIR, `${sid}.jsonl`), JSON.stringify({
      type: 'user', cwd: WS, gitBranch: '',
      message: { role: 'user', content: `bootstrap ${name}` },
    }) + '\n');
    await js(`document.querySelector('.pane .pane-close').click()`);
    await sleep(800); // onExit -> markSessionClosed -> v28 persist
    await refresh();
    return sid;
  }

  // Helper: reopen a closed session in a pane (busy via live PID).
  async function reopen(sid) {
    await js(`document.querySelector('.session-row[data-session-id="${sid}"]').click()`);
    await sleep(1000);
  }

  // --- Session A: rename while busy -> pending, injected at pane close ----
  const sidA = await makeClosedNamedSession('Mon POC');
  const fileA = path.join(PROJ_DIR, `${sidA}.jsonl`);
  await reopen(sidA);
  const before = countTitles(fileA);

  const t1res = await js(`window.api.renameSession('${sidA}', 'Renamed Live')`);
  await refresh();
  const t1row = await js(`(() => {
    const s = document.querySelector('.session-row[data-session-id="${sidA}"] .summary');
    return s ? { text: s.textContent, pending: s.classList.contains('pending-rename') } : null;
  })()`);
  gate('t1 busy rename deferred + shown italic',
       !!t1res && t1res.ok === true && t1res.pending === true
       && !!t1row && t1row.text === 'Renamed Live' && t1row.pending === true,
       JSON.stringify({ res: t1res, row: t1row }));

  gate('t2 no disk write while live', countTitles(fileA) === before,
       `titles before=${before} after=${countTitles(fileA)}`);

  await js(`document.querySelector('.pane .pane-close').click()`);
  await sleep(800);
  const [ctA, anA] = lastTwo(fileA);
  gate('t3 injected at pane close (both lines)',
       !!ctA && ctA.type === 'custom-title' && ctA.customTitle === 'Renamed Live'
       && !!anA && anA.type === 'agent-name' && anA.agentName === 'Renamed Live'
       && anA.sessionId === sidA,
       JSON.stringify([ctA, anA]));

  // --- Session B: a native /rename DURING the session wins ----------------
  // FIX #1 quarantine: the resume-poll window (3.5s) opened by reopen(sidA)
  // must EXPIRE before any new .jsonl appears, or the poll mis-attributes it
  // as sidA's fork (statusAlias pollution -> the watcher path later resolves
  // the wrong row). Same guard again before the hand-made out-of-deck file.
  await sleep(2600);
  const sidB = await makeClosedNamedSession('Base');
  const fileB = path.join(PROJ_DIR, `${sidB}.jsonl`);
  await reopen(sidB);
  await js(`window.api.renameSession('${sidB}', 'DeckName')`);
  // Simulate claude's own /rename while alive: it appends BOTH lines itself.
  fs.appendFileSync(fileB,
    JSON.stringify({ type: 'custom-title', customTitle: 'NatifWin', sessionId: sidB }) + '\n'
    + JSON.stringify({ type: 'agent-name', agentName: 'NatifWin', sessionId: sidB }) + '\n');
  await js(`document.querySelector('.pane .pane-close').click()`);
  await sleep(800);
  const [ctB] = lastTwo(fileB).slice(0, 1);
  const hasDeckName = fs.readFileSync(fileB, 'utf8').includes('DeckName');
  gate('t4 native rename wins over pending',
       !!ctB && ctB.customTitle === 'NatifWin' && !hasDeckName,
       JSON.stringify({ last: ctB, leaked: hasDeckName }));

  // --- Session C: out-of-deck session, injection via the status watcher ---
  await sleep(2600); // FIX #1 quarantine for reopen(sidB)'s poll window
  const sidC = '5b1c5a6e-1111-4222-8333-444455556666';
  const fileC = path.join(PROJ_DIR, `${sidC}.jsonl`);
  fs.writeFileSync(fileC, JSON.stringify({
    type: 'user', cwd: WS, gitBranch: '',
    message: { role: 'user', content: 'out-of-deck session' },
  }) + '\n'
  + JSON.stringify({ type: 'custom-title', customTitle: 'Old', sessionId: sidC }) + '\n'
  + JSON.stringify({ type: 'agent-name', agentName: 'Old', sessionId: sidC }) + '\n');
  fs.writeFileSync(path.join(STATUS_DIR, `${sidC}.json`),
    JSON.stringify({ status: 'working', event: 'probe', ts: '2026-06-05T00:00:00Z' }) + '\n');
  await refresh();
  const t5res = await js(`window.api.renameSession('${sidC}', 'Hook Close')`);
  const stillOld = countTitles(fileC) === 1;
  fs.writeFileSync(path.join(STATUS_DIR, `${sidC}.json`),
    JSON.stringify({ status: 'closed', event: 'SessionEnd', ts: '2026-06-05T00:00:01Z' }) + '\n');
  await sleep(600); // fs.watch + 50ms debounce + injection
  const [ctC, anC] = lastTwo(fileC);
  const seams = {
    statusEvents: global.__deckStatusEvents || 0,
    injectCalls: global.__deckRenameInjectCalls || 0,
    injectWrites: global.__deckRenameInjectWrites || 0,
  };
  gate('t5 out-of-deck: injected on hook closed status',
       !!t5res && t5res.pending === true && stillOld
       && !!ctC && ctC.customTitle === 'Hook Close'
       && !!anC && anC.type === 'agent-name' && anC.agentName === 'Hook Close',
       JSON.stringify({ res: t5res, stillOld, last2: [ctC, anC], seams }));

  // --- Closed session: direct path unchanged (v31 regression) -------------
  const t6res = await js(`window.api.renameSession('${sidC}', 'Cold Rename')`);
  const [ctC2, anC2] = lastTwo(fileC);
  gate('t6 closed session renames immediately (no pending)',
       !!t6res && t6res.ok === true && t6res.pending === undefined
       && !!ctC2 && ctC2.customTitle === 'Cold Rename'
       && !!anC2 && anC2.agentName === 'Cold Rename',
       JSON.stringify({ res: t6res, last2: [ctC2, anC2] }));

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'deferred-rename-probe.out'), report + '\n');
  console.log('\n=== v32 deferred-rename probe ===\n' + report);
  app.exit(failed ? 1 : 0);
});
