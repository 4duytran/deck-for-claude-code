// test/agent-resume-probe.js — A3 (D3) / rubric R8 + M5 rows + the v5 H-B stub-FUNCTION re-open rows + A14 (L3b half).
// Headless: the REAL session-activity.js over mkdtemp session fixtures with fresh timestamps (no clock seam), `send`
// stubbed. Every H-B row passes liveness as a counting stub FUNCTION `() => true` over a session whose ONLY entry is the
// re-opened run: the stub must be called exactly once per computation. Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-resume-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-resume-probe-'));
const projDir = path.join(base, 'projects', 'proj-resume');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_NO_OPEN = '1';
require('../src/main/window').send = () => {};
const sa = require('../src/main/session-activity.js');

const MIN = 60 * 1000;
const NOW0 = Date.now();
const B = NOW0 - 20 * MIN; // session start; every fixed event sits between B and NOW0
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wj = (f, ls) => fs.writeFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const aj = (f, ls) => fs.appendFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const ACK = 'Async agent launched successfully in the background.';
const INTERRUPT = '[Request interrupted by user]';

let seq = 0;
function session(key, extra = []) { // one background dispatch D acked at B+2s, then `extra(D, A)` main lines
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const D = `toolu_${key}_D`; const A = `agr${seq}`;
  const s = { sid, D, A, key, file: path.join(projDir, `${sid}.jsonl`), dir: path.join(projDir, sid, 'subagents') };
  wj(s.file, [{ type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(B), message: { role: 'user', content: `start ${key}` } },
    { type: 'assistant', timestamp: iso(B + 1000), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: `${key}`, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(B + 2000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } },
    ...extra(D, A)]);
  fs.mkdirSync(s.dir, { recursive: true });
  return s;
}
const ownFile = (s) => path.join(s.dir, `agent-${s.A}.jsonl`);
const putMeta = (s, x = {}) => fs.writeFileSync(path.join(s.dir, `agent-${s.A}.meta.json`), JSON.stringify({ agentType: 'code-dev', description: s.key, toolUseId: s.D, ...x }));
const asst = (t, x = {}) => ({ type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }], ...x } });
const endTurn = (t) => asst(t, { stop_reason: 'end_turn' });
const stopTail = (t) => ({ type: 'attachment', isSidechain: true, timestamp: iso(t), attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } });
const userT = (t, text) => ({ type: 'user', isSidechain: true, timestamp: iso(t), message: { role: 'user', content: [{ type: 'text', text }] } });
const finalLine = (D, A, t) => ({ type: 'attachment', timestamp: iso(t), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: [
  '<task-notification>', `<task-id>${A}</task-id>`, `<tool-use-id>${D}</tool-use-id>`, `<output-file>/tmp/${A}.output</output-file>`,
  '<status>completed</status>', '<summary>Agent "x" finished</summary>', '<result>done</result>', '</task-notification>'].join('\n') } });
const waitLine = (D, A, t) => ({ type: 'attachment', timestamp: iso(t), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: [
  '<task-notification>', `<task-id>${A}</task-id>`, `<tool-use-id>${D}</tool-use-id>`, `<output-file>/tmp/${A}.output</output-file>`,
  '<status>completed</status>', '<summary>Agent "x" is waiting on its own background work</summary>',
  '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes.</note>',
  '</task-notification>'].join('\n') } });
const resumeLine = (callId, A, t) => ({ type: 'user', timestamp: iso(t),
  message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Resuming agent in the background.' }] },
  toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: A } });
const live = (v) => { const f = () => { f.calls += 1; return f.value; }; f.calls = 0; f.value = v; return f; };
const act = (s) => sa.sessionActivity(s.sid);
const st = (s, liveness) => sa.agentStatesOf(s.sid, liveness).get(s.D);

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });
async function pollState(s, want, ms = 4000) { // the stop evidence arrives through the async meta check
  let x = null;
  for (let i = 0; i < ms / 100; i++) {
    sa.activityFlags(await act(s), true, s.sid);
    x = st(s, true);
    if (x && x.state === want) return x;
    await sleep(100);
  }
  return x;
}

async function main() {
  await gate('own_record_after_terminalTs_running', async () => {
    const s = session('r1', () => []);
    wj(ownFile(s), [asst(B + 3000), endTurn(B + MIN), stopTail(B + MIN + 500)]);
    await act(s);
    const done = st(s, true);
    aj(ownFile(s), [asst(B + 2 * MIN)]);
    await act(s);
    const f = live(true); const x = st(s, f);
    return chk(done.state === 'done' && x.state === 'running' && f.calls === 1,
      `tail only=${done.state}, then an own record after it=${x.state} (stub calls ${f.calls}) (expect done, running, 1)`);
  });
  await gate('sendmessage_resume_running', async () => {
    const s = session('r2', (D, A) => [finalLine(D, A, B + 3 * MIN), resumeLine('toolu_r2_R', A, B + 4 * MIN)]);
    wj(ownFile(s), [asst(B + 3000), endTurn(B + MIN), stopTail(B + MIN + 500)]);
    await act(s);
    const x = st(s, true);
    return chk(x && x.state === 'running', `final then a newer resume -> ${x && x.state} (expect running; the previous run's tail and final never apply)`);
  });
  await gate('resume_older_than_completion_is_noop', async () => {
    const s = session('r3', (D, A) => [finalLine(D, A, B + 4 * MIN), resumeLine('toolu_r3_R', A, B + 3 * MIN)]);
    wj(ownFile(s), [asst(B + 3000), endTurn(B + MIN)]);
    await act(s);
    const x = st(s, true);
    return chk(x && x.state === 'done' && x.reason === 'final', `resume older than the completion -> ${x && x.state}/${x && x.reason} (expect done/final, the guard keeps the completion)`);
  });
  let stopped;
  await gate('interrupt_record_as_last_own_record_blocked', async () => {
    stopped = session('r4', () => []);
    putMeta(stopped, { stoppedByUser: true });
    wj(ownFile(stopped), [asst(B + 3000), asst(B + MIN), userT(B + 2 * MIN, INTERRUPT)]);
    const x = await pollState(stopped, 'blocked');
    return chk(x && x.state === 'blocked' && x.reason === 'stop' && x.endTs === B + 2 * MIN, `state=${x && x.state}/${x && x.reason} endTs=${x && x.endTs && iso(x.endTs)} (expect blocked/stop at the interrupt ts)`);
  });
  await gate('own_record_newer_than_interrupt_running_stub_once', async () => {
    aj(ownFile(stopped), [asst(B + 3 * MIN)]);
    await act(stopped);
    const f = live(true); const x = st(stopped, f);
    return chk(x && x.state === 'running' && f.calls === 1, `after a user stop, an own record newer than the interrupt -> ${x && x.state} (stub calls ${f.calls}) (expect running, 1)`);
  });
  await gate('hb_final_then_newer_own_record_running_stub_once', async () => {
    const s = session('hb2', (D, A) => [finalLine(D, A, B + 3 * MIN)]);
    wj(ownFile(s), [asst(B + 3000), asst(B + 5 * MIN)]);
    await act(s);
    const f = live(true); const x = st(s, f);
    return chk(x && x.state === 'running' && f.calls === 1, `final at B+3m, own record at B+5m -> ${x && x.state} (stub calls ${f.calls}) (expect running, 1)`);
  });
  await gate('hb_closed_then_newer_own_record_running_stub_once', async () => {
    const s = session('hb3', () => []);
    wj(ownFile(s), [asst(B + 3000), asst(B + MIN)]);
    await act(s);
    const x0 = st(s, () => false); // closedAt memo set by this computation
    await sleep(30);
    aj(ownFile(s), [asst(Date.now())]);
    await act(s);
    const f = live(true); const x1 = st(s, f);
    return chk(x0.state === 'closed' && x1.state === 'running' && f.calls === 1, `closed=${x0.state}, own record newer than closedAt -> ${x1.state} (stub calls ${f.calls}) (expect closed, running, 1)`);
  });
  await gate('archive_A_lt_B_tail_through_agentStatesOf_done', async () => {
    const s = session('arc', () => []);
    const root = path.join(projDir, 'subagents-archive', s.sid);
    const dirA = path.join(root, '2026-11-08-100000'); const dirB = path.join(root, '2026-11-08-110000');
    fs.mkdirSync(dirA, { recursive: true });
    wj(path.join(dirA, `agent-${s.A}.jsonl`), [asst(B + 3000), endTurn(B + MIN)]);
    await sleep(25);
    fs.mkdirSync(dirB, { recursive: true });
    wj(path.join(dirB, 'agent-other.jsonl'), [asst(B + 2 * MIN)]);
    await act(s); // this pass sees A and B (B newest)
    const before = st(s, true);
    aj(path.join(dirA, `agent-${s.A}.jsonl`), [stopTail(B + 3 * MIN)]); // the tail lands in A, not in the newest dir
    await act(s);
    const after = st(s, true);
    return chk(before.state === 'running' && after.state === 'done' && after.endTs === B + 3 * MIN, `before the tail=${before.state}, after=${after.state} endTs=${after.endTs && iso(after.endTs)} (expect running, done)`);
  });

  // D-OT: `waiting` comes from the own fold (a terminal tail with open children) or from a parent-side notice while the
  // own fold holds NO terminal tail; a clean own tail wins over a notice that follows it.
  await gate('waiting_notice_without_own_tail_waiting', async () => {
    const s = session('wn', (D, A) => [waitLine(D, A, B + 3 * MIN)]);
    wj(ownFile(s), [asst(B + 3000), asst(B + MIN)]);
    await act(s);
    const x = st(s, true);
    return chk(x && x.state === 'waiting' && x.reason === 'waiting', `waiting notice, own fold with no terminal tail -> ${x && x.state}/${x && x.reason} (expect waiting)`);
  });
  await gate('own_tail_with_open_child_waiting', async () => {
    const s = session('wc', () => []);
    wj(ownFile(s), [asst(B + 3000, { content: [{ type: 'tool_use', id: 'toolu_wc_child', name: 'Bash', input: { command: 'x', run_in_background: true } }] }),
      endTurn(B + MIN - 1), stopTail(B + MIN)]);
    await act(s);
    const x = st(s, true);
    return chk(x && x.state === 'waiting', `own tail with one open bg child -> ${x && x.state}/${x && x.reason} (expect waiting)`);
  });
  await gate('own_tail_wins_over_later_waiting_notice', async () => {
    const s = session('wt', (D, A) => [waitLine(D, A, B + MIN + 6)]);
    wj(ownFile(s), [asst(B + 3000), endTurn(B + MIN - 1), stopTail(B + MIN)]);
    await act(s);
    const x = st(s, true);
    return chk(x && x.state === 'done' && x.reason === 'own-tail' && x.endTs === B + MIN, `clean own tail at B+1m, waiting notice 6 ms later -> ${x && x.state}/${x && x.reason} (expect done/own-tail)`);
  });

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  process.exit(n === results.length ? 0 : 1);
}

main().catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
