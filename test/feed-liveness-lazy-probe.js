// test/feed-liveness-lazy-probe.js — E2E probe (real app) for plan decision D-CV1(a): the chat feed's agent-state tick
// (transcript.js agentStateSync) reads the session liveness LAZILY. With every state terminal, liveness cannot move a state
// (K3 rule 4), so a subscription whose agents are all terminal makes ZERO sessionLivenessSince calls over several ticks, while a
// non-terminal agent still gets its liveness read (K5) and a re-open still reaches the chat.
//
// Instrument: session-status.sessionLivenessSince and session-activity.sessionActivity are wrapped BEFORE main.js is required
// (transcript.js destructures them at require time). Each call records its stack, so a call made by the feed
// (frame in ipc/transcript.js) is told apart from the sidebar scan's. The wrapper returns the real result untouched.
//
// Fixtures: mkdtemp trees only (never ~/.claude). S1 is live (fresh `working` status in an isolated status dir) and holds one
// background dispatch toolu_run whose own transcript receives a SubagentStop tail (-> done). S2 has no status file and no pane:
// liveness unknown -> its agent reads `unknown` (non-terminal), the control that proves the counter sees feed reads.
//
// Gates:
//   ll0 control: the non-terminal S2 subscription reads the liveness (>= 2 feed calls over the window)
//   ll1 S1 reaches `done` (running first, then the SubagentStop tail)
//   ll2 ticks ran: agentStateSync called sessionActivity >= 3 times for S1 over the quiet window (the zero below is not idle)
//   ll3 ZERO sessionLivenessSince calls by the feed for S1 over the window, every agent terminal
//   ll4 a re-open (an own record after the stop) pushes `running` to the chat within 2 ticks
//
// Run (worktree root): env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 <CENV> xvfb-run -a timeout 180 node_modules/.bin/electron test/feed-liveness-lazy-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-feed-liveness-lazy-'));
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });
const statusDir = path.join(base, 'status');
fs.mkdirSync(statusDir, { recursive: true });

const S1 = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const S2 = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const fileS1 = path.join(projDir, `${S1}.jsonl`);
const fileS2 = path.join(projDir, `${S2}.jsonl`);
const subS1 = path.join(projDir, S1, 'subagents');
const subS2 = path.join(projDir, S2, 'subagents');
fs.mkdirSync(subS1, { recursive: true });
fs.mkdirSync(subS2, { recursive: true });

const T0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ACK_TEXT = 'Async agent launched successfully in the background.';
const L = (o) => JSON.stringify(o) + '\n';
const dispatch = (id, type, desc, ms) => L({ type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: desc, run_in_background: true } }] } });
const ack = (id, agentId, ms) => L({ type: 'user', timestamp: iso(ms), toolUseResult: { isAsync: true, agentId },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ACK_TEXT }] } });
const userLine = (text, ms) => L({ type: 'user', timestamp: iso(ms), cwd: base, message: { role: 'user', content: text } });
const ownTask = (aid, ms) => L({ type: 'user', isSidechain: true, agentId: aid, timestamp: iso(ms), message: { role: 'user', content: 'task' } });
const ownTool = (aid, ms, pattern) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_own_${ms}`, name: 'Grep', input: { pattern } }] } });
const ownEndTurn = (aid, ms) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const ownStop = (aid, ms) => L({ type: 'attachment', isSidechain: true, agentId: aid, timestamp: iso(ms),
  attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 } });

fs.writeFileSync(fileS1, userLine('go', T0 - 120000) + dispatch('toolu_run', 'code-dev', 'Run job', T0 - 60000) + ack('toolu_run', 'aRun', T0 - 59000));
fs.writeFileSync(path.join(subS1, 'agent-aRun.meta.json'), JSON.stringify({ agentType: 'code-dev', description: 'Run job', toolUseId: 'toolu_run' }));
fs.writeFileSync(path.join(subS1, 'agent-aRun.jsonl'), ownTask('aRun', T0 - 56000) + ownTool('aRun', T0 - 55000, 'first-marker'));
fs.writeFileSync(fileS2, userLine('go', T0 - 120000) + dispatch('toolu_unk', 'kt-explore', 'Unknown job', T0 - 60000) + ack('toolu_unk', 'aUnk', T0 - 59000));
fs.writeFileSync(path.join(subS2, 'agent-aUnk.meta.json'), JSON.stringify({ agentType: 'kt-explore', description: 'Unknown job', toolUseId: 'toolu_unk' }));
fs.writeFileSync(path.join(subS2, 'agent-aUnk.jsonl'), ownTask('aUnk', T0 - 56000) + ownTool('aUnk', T0 - 55000, 'first-marker'));

const touchStatus = () => fs.writeFileSync(path.join(statusDir, `${S1}.json`),
  JSON.stringify({ status: 'working', event: 'probe', ts: new Date().toISOString() }));
touchStatus(); // S2: deliberately no status file
process.env.CLAUDE_DECK_STATUS_DIR = statusDir;
process.env.CLAUDE_DECK_BIN = path.join(base, 'fake-claude.sh');
fs.writeFileSync(process.env.CLAUDE_DECK_BIN, '#!/bin/bash\n( while :; do echo .; sleep 1; done ) &\nexec cat > /dev/null\n', { mode: 0o755 });
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;

// --- instrument: installed BEFORE main.js so transcript.js destructures the wrappers ---------------------------------------
const liveCalls = []; // { t, sid, feed } — feed = the call came from ipc/transcript.js
const actCalls = [];  // { t, sid, sync } — sync = the call came from agentStateSync
const ss = require(path.join(__dirname, '..', 'src', 'main', 'session-status.js'));
const sa = require(path.join(__dirname, '..', 'src', 'main', 'session-activity.js'));
const realLive = ss.sessionLivenessSince;
const realAct = sa.sessionActivity;
ss.sessionLivenessSince = function (sid) {
  const st = new Error().stack || '';
  liveCalls.push({ t: Date.now(), sid, feed: /ipc[\\/]transcript\.js/.test(st) });
  return realLive.apply(this, arguments);
};
sa.sessionActivity = function (sid) {
  const st = new Error().stack || '';
  actCalls.push({ t: Date.now(), sid, sync: /agentStateSync/.test(st) });
  return realAct.apply(this, arguments);
};
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-feed-liveness-lazy-userdata-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');
const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, ok: ok === true });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const sent = [];
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, payload) => { sent.push({ n: sent.length, t: Date.now(), ch, p: payload }); return realSend(ch, payload); };
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const states = (pane, from = 0) => sent.filter((s) => s.n >= from && s.ch === 'transcript-append' && s.p && s.p.paneId === pane)
    .flatMap((s) => (s.p.events || []).filter((e) => e.kind === 'agentState').map((e) => ({ ...e, n: s.n, t: s.t })));
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
  const subscribe = (pane, sid) => j(`window.api.transcriptSubscribe({ paneId: '${pane}', sessionId: '${sid}' }).then((r) => ({ ok: r.ok }))`);
  const lastOf = (list, id) => list.filter((e) => e.toolUseId === id).pop();
  const feedLive = (sid, since) => liveCalls.filter((c) => c.sid === sid && c.feed && c.t >= since).length;
  const syncActs = (sid, since) => actCalls.filter((c) => c.sid === sid && c.sync && c.t >= since).length;

  await sleep(1500); // boot settles

  // S1 -> running, then own SubagentStop tail -> done: every agent terminal.
  await subscribe('lazy-a', S1);
  const gotRunning = await waitFor(() => (lastOf(states('lazy-a'), 'toolu_run') || {}).state === 'running', 6000);
  await subscribe('lazy-b', S2);
  touchStatus();
  fs.appendFileSync(path.join(subS1, 'agent-aRun.jsonl'), ownEndTurn('aRun', Date.now()) + ownStop('aRun', Date.now() + 1));
  const gotDone = await waitFor(() => (lastOf(states('lazy-a'), 'toolu_run') || {}).state === 'done', 6500);
  gate('ll1_s1_reaches_done', gotRunning && gotDone, JSON.stringify({ gotRunning, gotDone }));

  // Settle: the tick that computed `done` has run and the subscription is in its steady state; then the measured window.
  await sleep(4500);
  const w0 = Date.now();
  await sleep(8500); // >= 4 poll ticks (POLL_MS = 2000)
  const w1 = Date.now();
  const s1Live = feedLive(S1, w0);
  const s1Sync = syncActs(S1, w0);
  const s2Live = feedLive(S2, w0);
  gate('ll0_control_nonterminal_reads_liveness', s2Live >= 2, JSON.stringify({ s2FeedLivenessCalls: s2Live, windowMs: w1 - w0, s2State: (lastOf(states('lazy-b'), 'toolu_unk') || {}).state }));
  gate('ll2_ticks_ran_in_window', s1Sync >= 3, JSON.stringify({ s1AgentStateSyncActivityCalls: s1Sync, windowMs: w1 - w0 }));
  gate('ll3_all_terminal_makes_zero_liveness_calls', s1Live === 0,
    JSON.stringify({ s1FeedLivenessCalls: s1Live, s1AgentStateSyncActivityCalls: s1Sync, allLivenessCallsAnySid: liveCalls.filter((c) => c.t >= w0).length }));

  // Re-open: an own record after the stop reaches the chat.
  touchStatus();
  const fromR = sent.length;
  fs.appendFileSync(path.join(subS1, 'agent-aRun.jsonl'), ownTool('aRun', Date.now(), 'after-stop-marker'));
  const gotReopen = await waitFor(() => states('lazy-a', fromR).some((e) => e.toolUseId === 'toolu_run' && e.state === 'running'), 4500);
  gate('ll4_reopen_reaches_the_chat', gotReopen, JSON.stringify({ gotReopen, pushed: states('lazy-a', fromR).map((e) => `${e.toolUseId}:${e.state}`) }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'FAIL'} (${failed.length === 0 ? results.length : results.length - failed.length}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
  process.exit(failed.length === 0 ? 0 : 1);
});
