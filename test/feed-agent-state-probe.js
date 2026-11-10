// test/feed-agent-state-probe.js — E2E probe (real app) for lot-feed (plan Step L4): the chat feed
// ('transcript-append') carries the agent lifecycle as `{kind:'agentState', toolUseId, state, seq, agentType, summary}`
// events computed by session-activity's agentStatesOf; `agentWaiting` never reaches the renderer.
//
// Fixtures: mkdtemp trees only (never ~/.claude). S1 is live (fresh `working` status in an isolated status dir) and holds
//   toolu_old  an out-of-window running dispatch (its `tool` event sits before 650 filler events: outside MAX_EVENTS),
//   toolu_run  a background dispatch whose own transcript gets a SubagentStop tail,
//   toolu_wait a background dispatch that receives a waiting notice.
// S2 has no status file and no pane: liveness unknown -> its agent reads `unknown`.
// Clock (M-3): real app, no seam — fixture records are written relative to Date.now(), appended records use `new Date()`.
//
// Gates: fs1 fresh subscribe pushes `running` (out-of-window row with agentType/summary, absent from the reply),
// fs2 own SubagentStop tail -> exactly one `done` push within 2 ticks, fs3 waiting notice -> `waiting`,
// fs4 no `agentWaiting` in any renderer batch or reply, fs5 seq strictly increasing between two anchors,
// fs6 re-anchor (file rewritten in place) -> first push after the reset batch carries the restarted seq and `running`
// for the out-of-window row, fs7 a second fresh subscribe gets it too, fs8 `unknown` is sent and the sub-agent feed keeps draining.
//
// Run (worktree root): env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 <CENV> xvfb-run -a timeout 180 node_modules/.bin/electron test/feed-agent-state-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-feed-agent-state-'));
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
const asstText = (text, ms) => L({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userLine = (text, ms) => L({ type: 'user', timestamp: iso(ms), cwd: base, message: { role: 'user', content: text } });
const ownTask = (aid, ms) => L({ type: 'user', isSidechain: true, agentId: aid, timestamp: iso(ms), message: { role: 'user', content: 'task' } });
const ownTool = (aid, ms, pattern) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_own_${ms}`, name: 'Grep', input: { pattern } }] } });
const ownEndTurn = (aid, ms) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const ownStop = (aid, ms) => L({ type: 'attachment', isSidechain: true, agentId: aid, timestamp: iso(ms),
  attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 } });
const WAITING_NOTICE = '<task-notification><task-id>aWait</task-id><tool-use-id>toolu_wait</tool-use-id><status>completed</status>'
  + '<summary>Agent "Wait job" is waiting on its own background work</summary></task-notification>';
const waitingLine = (ms) => L({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'text', text: WAITING_NOTICE }] } });

const FILLERS = 650; // > MAX_EVENTS (600): the first dispatch falls out of the bounded initial read
function mainS1() {
  let s = userLine('go', T0 - 300000) + dispatch('toolu_old', 'arch', 'Trace flow C', T0 - 299000);
  for (let i = 0; i < FILLERS; i++) s += asstText(`filler ${i}`, T0 - 298000 + i);
  s += dispatch('toolu_run', 'code-dev', 'Run job', T0 - 60000) + ack('toolu_run', 'aRun', T0 - 59000);
  s += dispatch('toolu_wait', 'notes', 'Wait job', T0 - 58000) + ack('toolu_wait', 'aWait', T0 - 57000);
  return s;
}
fs.writeFileSync(fileS1, mainS1());
for (const [aid, tid, type, desc] of [['aRun', 'toolu_run', 'code-dev', 'Run job'], ['aWait', 'toolu_wait', 'notes', 'Wait job']]) {
  fs.writeFileSync(path.join(subS1, `agent-${aid}.meta.json`), JSON.stringify({ agentType: type, description: desc, toolUseId: tid }));
  fs.writeFileSync(path.join(subS1, `agent-${aid}.jsonl`), ownTask(aid, T0 - 56000) + ownTool(aid, T0 - 55000, 'first-marker'));
}
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
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-feed-agent-state-userdata-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');
const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, ok: ok === true });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const sent = []; // every webContents.send, in order
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, payload) => { sent.push({ n: sent.length, t: Date.now(), ch, p: payload }); return realSend(ch, payload); };
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const states = (pane, from = 0) => sent.filter((s) => s.n >= from && s.ch === 'transcript-append' && s.p && s.p.paneId === pane)
    .flatMap((s) => (s.p.events || []).filter((e) => e.kind === 'agentState').map((e) => ({ ...e, n: s.n, t: s.t })));
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
  const subscribe = (pane, sid) => j(`window.api.transcriptSubscribe({ paneId: '${pane}', sessionId: '${sid}' }).then((r) => ({
    ok: r.ok, truncatedHead: r.truncatedHead,
    toolIds: (r.events || []).filter((e) => e.kind === 'tool').map((e) => e.id),
    kinds: [...new Set((r.events || []).map((e) => e.kind))] }))`);
  const lastOf = (list, id) => list.filter((e) => e.toolUseId === id).pop();

  await sleep(1500); // boot settles

  // === fs1 — fresh subscribe: running pushes, the out-of-window row included ==============================
  const replyA = await subscribe('feed-a', S1);
  const okA = await waitFor(() => ['toolu_old', 'toolu_run', 'toolu_wait'].every((id) => (lastOf(states('feed-a'), id) || {}).state === 'running'), 5000);
  const oldA = lastOf(states('feed-a'), 'toolu_old');
  gate('fs1_fresh_subscribe_running_incl_out_of_window',
    okA && !!replyA && replyA.ok === true && replyA.truncatedHead === true && !replyA.toolIds.includes('toolu_old')
      && !!oldA && oldA.agentType === 'arch' && oldA.summary === 'Trace flow C',
    JSON.stringify({ okA, reply: replyA && { truncatedHead: replyA.truncatedHead, oldInReply: replyA.toolIds.includes('toolu_old') }, oldA }));

  // === fs2 — own SubagentStop tail: exactly one `done` within 2 ticks ======================================
  touchStatus();
  const tAppend = Date.now();
  fs.appendFileSync(path.join(subS1, 'agent-aRun.jsonl'), ownEndTurn('aRun', Date.now()) + ownStop('aRun', Date.now() + 1));
  const gotDone = await waitFor(() => states('feed-a').some((e) => e.toolUseId === 'toolu_run' && e.state === 'done'), 6500);
  const doneAt = gotDone ? states('feed-a').find((e) => e.toolUseId === 'toolu_run' && e.state === 'done').t - tAppend : null;
  await sleep(2600); // two more ticks: no duplicate push
  const doneCount = states('feed-a').filter((e) => e.toolUseId === 'toolu_run' && e.state === 'done').length;
  gate('fs2_own_tail_one_done_push_within_2_ticks', gotDone && doneAt <= 5000 && doneCount === 1, JSON.stringify({ doneAt, doneCount }));

  // === fs3/fs4 — waiting notice (+ a normal line in the same write): `waiting` pushed, `agentWaiting` filtered ====
  touchStatus();
  fs.appendFileSync(path.join(subS1, 'agent-aWait.jsonl'), ownTask('aWait', Date.now()));
  await sleep(40);
  const fromC = sent.length;
  fs.appendFileSync(fileS1, waitingLine(Date.now()) + asstText('apres-la-notification', Date.now() + 1));
  const gotWaiting = await waitFor(() => states('feed-a', fromC).some((e) => e.toolUseId === 'toolu_wait' && e.state === 'waiting'), 6500);
  const gotText = await waitFor(() => sent.some((s) => s.n >= fromC && s.ch === 'transcript-append' && s.p.paneId === 'feed-a'
    && (s.p.events || []).some((e) => e.kind === 'text' && e.text === 'apres-la-notification')), 3000);
  gate('fs3_waiting_notice_pushes_waiting', gotWaiting && gotText, JSON.stringify({ gotWaiting, gotText }));
  const { normalizeLine } = require(path.join(__dirname, '..', 'src', 'main', 'transcript-normalize.js'));
  const normalizesToWaiting = normalizeLine(waitingLine(Date.now()).trim(), new Map()).some((e) => e.kind === 'agentWaiting');
  const leaked = sent.filter((s) => s.ch === 'transcript-append' && (s.p.events || []).some((e) => e.kind === 'agentWaiting')).length;
  gate('fs4_no_agentWaiting_reaches_renderer', normalizesToWaiting && gotText && leaked === 0 && !(replyA && replyA.kinds.includes('agentWaiting')),
    JSON.stringify({ normalizesToWaiting, leaked }));

  // === fs5 — seq strictly increasing between two anchors ===================================================
  const seqs = states('feed-a').map((e) => e.seq);
  gate('fs5_seq_strictly_increasing', seqs.length >= 5 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]) && seqs[0] === 1, JSON.stringify(seqs));

  // === fs6 — re-anchor (rewritten in place): first push after the reset batch has the restarted seq ======
  touchStatus();
  const fromE = sent.length;
  fs.writeFileSync(fileS1, mainS1()); // shorter than what the sub has read: drain() rebuilds through anchor(reset)
  const gotReset = await waitFor(() => sent.some((s) => s.n >= fromE && s.ch === 'transcript-append' && s.p.paneId === 'feed-a' && s.p.reset === true), 6500);
  const resetN = gotReset ? sent.find((s) => s.n >= fromE && s.ch === 'transcript-append' && s.p.paneId === 'feed-a' && s.p.reset === true).n : -1;
  await waitFor(() => states('feed-a', resetN).some((e) => e.toolUseId === 'toolu_old'), 5000);
  const after = states('feed-a', resetN);
  const oldE = lastOf(after, 'toolu_old');
  gate('fs6_reanchor_restarts_seq_and_pushes_running',
    gotReset && after.length >= 1 && after[0].seq === 1 && after.every((e, i) => i === 0 || e.seq > after[i - 1].seq)
      && !!oldE && oldE.state === 'running' && oldE.agentType === 'arch' && oldE.summary === 'Trace flow C',
    JSON.stringify({ gotReset, resetN, seqs: after.map((e) => `${e.toolUseId}:${e.state}:${e.seq}`), oldE }));

  // === fs7 — a second fresh subscribe on the same session ==================================================
  touchStatus();
  const replyB = await subscribe('feed-b', S1);
  const okB = await waitFor(() => (lastOf(states('feed-b'), 'toolu_old') || {}).state === 'running', 5000);
  const oldB = lastOf(states('feed-b'), 'toolu_old');
  gate('fs7_second_subscribe_gets_running', okB && !!replyB && replyB.ok === true && !!oldB && oldB.agentType === 'arch' && oldB.summary === 'Trace flow C' && states('feed-b')[0].seq === 1,
    JSON.stringify({ okB, oldB }));

  // === fs8 — `unknown` (no status file, no pane) is sent like any state and the sub-agent feed keeps draining ==
  await subscribe('feed-c', S2);
  const gotUnknown = await waitFor(() => (lastOf(states('feed-c'), 'toolu_unk') || {}).state === 'unknown', 5000);
  const fromG = sent.length;
  fs.appendFileSync(path.join(subS2, 'agent-aUnk.jsonl'), ownTool('aUnk', Date.now(), 'second-marker'));
  const fedAfter = await waitFor(() => sent.some((s) => s.n >= fromG && s.ch === 'subagent-append' && s.p.paneId === 'feed-c'
    && s.p.toolUseId === 'toolu_unk' && JSON.stringify(s.p.events).includes('second-marker')), 6500);
  gate('fs8_unknown_sent_and_feed_keeps_draining', gotUnknown && fedAfter, JSON.stringify({ gotUnknown, fedAfter }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'FAIL'} (${failed.length === 0 ? results.length : failed.length}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
  process.exit(failed.length === 0 ? 0 : 1);
});
