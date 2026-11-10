// v33 probe — auto-refresh on status transitions + caches. 6 gates (t5a: the A12 row of the t5 fixture).
// Run: npx electron test/auto-refresh-probe.js   (from the repo root)
//
// FULL ISOLATION (incident rule 2026-06-04): HOME is faked BEFORE main.js
// loads and userData is moved to a mkdtemp. No pane is ever opened -> no
// FIX #1 resume-poll window, no quarantine sleeps needed here.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });

process.env.CLAUDE_DECK_BIN = path.join(FAKE_HOME, 'fake-claude.sh'); // unused (no spawn)
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const mkSession = (sid, title) => {
  let body = JSON.stringify({
    type: 'user', cwd: WS, gitBranch: '',
    message: { role: 'user', content: `probe session ${sid}` },
  }) + '\n';
  if (title) {
    body += JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid }) + '\n'
          + JSON.stringify({ type: 'agent-name', agentName: title, sessionId: sid }) + '\n';
  }
  fs.writeFileSync(path.join(PROJ_DIR, `${sid}.jsonl`), body);
};
const setStatus = (sid, status) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: '2026-06-05T00:00:00Z' }) + '\n');

const S1 = '11111111-aaaa-4bbb-8ccc-111111111111';
const S2 = '22222222-aaaa-4bbb-8ccc-222222222222';
mkSession(S1, 'Session Un'); // present BEFORE boot — listed by the initial scan
setStatus(S1, 'idle');

// A12 / H1 row: an in-turn background dispatch (ACK only, no final result, no own SubagentStop tail), its own
// transcript's last record and mtime 4 h old, and NO status file. Built before boot: the initial scan lists it and
// every later scan walks it (t5 must still read nothing from the disk for it).
const S3 = '33333333-aaaa-4bbb-8ccc-333333333333';
{
  const HOUR = 3600 * 1000;
  const h = (ms) => new Date(Date.now() - ms).toISOString();
  const ln = (o) => JSON.stringify(o);
  const D = 'toolu_a12'; const AID = 'a12agent';
  fs.writeFileSync(path.join(PROJ_DIR, `${S3}.jsonl`), [
    ln({ type: 'user', cwd: WS, gitBranch: '', timestamp: h(5 * HOUR), message: { role: 'user', content: 'probe session a12' } }),
    ln({ type: 'assistant', timestamp: h(5 * HOUR - 1000), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: 'a12', run_in_background: true } }] } }),
    ln({ type: 'user', timestamp: h(5 * HOUR - 2000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: 'Async agent launched successfully in the background.' }] },
      toolUseResult: { isAsync: true, agentId: AID, status: 'async_launched' } }),
  ].join('\n') + '\n');
  const sub = path.join(PROJ_DIR, S3, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const own = path.join(sub, `agent-${AID}.jsonl`);
  const rec = (ms) => ln({ type: 'assistant', isSidechain: true, timestamp: h(ms), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
  fs.writeFileSync(own, rec(4 * HOUR + 60000) + '\n' + rec(4 * HOUR) + '\n');
  const t = new Date(Date.now() - 4 * HOUR);
  fs.utimesSync(own, t, t);
}

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

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // t1 — a NEW session appears on its own: jsonl + first hook status, NO
  // manual refresh -> watcher push -> debounced auto re-scan -> row exists.
  mkSession(S2, null);
  setStatus(S2, 'working');
  await sleep(1000); // 50ms watcher debounce + 300ms render debounce + scan
  const t1 = await js(`(() => {
    const r = document.querySelector('.session-row[data-session-id="${S2}"]');
    return r ? { found: true, badge: r.querySelector('.status-badge').dataset.status } : { found: false };
  })()`);
  gate('t1 new session auto-appears', t1.found && t1.badge === 'working', JSON.stringify(t1));

  // t2 — a pure status transition (working->idle) must NOT rebuild the DOM:
  // a JS expando on the row survives only if the node was not recreated.
  await js(`document.querySelector('.session-row[data-session-id="${S2}"]').__probeMark = 42`);
  setStatus(S2, 'idle');
  await sleep(900);
  const t2 = await js(`(() => {
    const r = document.querySelector('.session-row[data-session-id="${S2}"]');
    return { mark: r ? r.__probeMark : null, badge: r ? r.querySelector('.status-badge').dataset.status : null };
  })()`);
  gate('t2 no-op transition skips DOM rebuild (badge still live)',
       t2.mark === 42 && t2.badge === 'idle', JSON.stringify(t2));

  // t3 — auto-refresh never destroys an inline rename in progress.
  await js(`(() => {
    startInlineRename(document.querySelector('.session-row[data-session-id="${S1}"]'));
    document.querySelector('.summary-edit').value = 'Typing in progress';
  })()`);
  setStatus(S2, 'working'); // a transition arrives mid-edit
  await sleep(900);
  const t3 = await js(`(() => {
    const i = document.querySelector('.summary-edit');
    return { editorAlive: !!i, value: i ? i.value : null };
  })()`);
  gate('t3 edit guard: editor survives transitions',
       t3.editorAlive && t3.value === 'Typing in progress', JSON.stringify(t3));
  await js(`document.querySelector('.summary-edit').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // t4 — a STRUCTURAL change (native rename on disk) re-renders on the next
  // transition: append both title lines by hand, then touch the status.
  fs.appendFileSync(path.join(PROJ_DIR, `${S2}.jsonl`),
    JSON.stringify({ type: 'custom-title', customTitle: 'S2 Renamed', sessionId: S2 }) + '\n'
    + JSON.stringify({ type: 'agent-name', agentName: 'S2 Renamed', sessionId: S2 }) + '\n');
  setStatus(S2, 'idle');
  await sleep(900);
  const t4 = await js(`(() => {
    const r = document.querySelector('.session-row[data-session-id="${S2}"]');
    return r ? r.querySelector('.summary').textContent : null;
  })()`);
  gate('t4 structural change re-renders (new title shown)', t4 === 'S2 Renamed',
       `summary=${JSON.stringify(t4)}`);

  // t5a — A12 / H1: the extra row of t5 is meaningful. S3's agent is silent for 4 h with no status file: it reads
  // `unknown` (never running, never closed), asked outside the t5 window below.
  const sa = require(path.join(__dirname, '..', 'src', 'main', 'session-activity.js'));
  const ss = require(path.join(__dirname, '..', 'src', 'main', 'session-status.js'));
  await sa.sessionActivity(S3);
  const a12 = sa.agentStatesOf(S3, () => ss.sessionLiveness(S3)).get('toolu_a12');
  gate('t5a a12 row: silent 4 h, no status file -> agent reads unknown',
       !!a12 && a12.state === 'unknown', `state=${a12 && a12.state} reason=${a12 && a12.reason}`);

  // t5 — status cache: repeated scans read statuses from MEMORY, not disk (the S3 row included).
  const base = global.__deckStatusDiskReads || 0;
  await js(`document.getElementById('refresh-sessions').click()`);
  await sleep(500);
  await js(`document.getElementById('refresh-sessions').click()`);
  await sleep(500);
  const delta = (global.__deckStatusDiskReads || 0) - base;
  gate('t5 scans hit the status cache (zero disk reads)', delta === 0,
       `disk reads during 2 manual refreshes: ${delta}`);

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'auto-refresh-probe.out'), report + '\n');
  console.log('\n=== v33 auto-refresh probe ===\n' + report);
  app.exit(failed ? 1 : 0);
});
