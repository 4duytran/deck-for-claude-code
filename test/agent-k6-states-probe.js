// test/agent-k6-states-probe.js — D-K6: the cross-turn freshness gate (K6) lives in evaluateAgents, so
// agentStatesOf (the feed, L5's row recreation) and activityFlags (the payload) read ONE state for an entry.
// A cross-turn (not in the current turn) run that would read `running` / `waiting` reads `unknown` /
// 'stale-session' when the session's transcript was last touched more than STALE_AGENT_MS (3 h) ago, or never
// reports a mtime; an in-turn entry, and any terminal / closed verdict, is untouched.
// Headless: the REAL session-activity.js over mkdtemp fixtures, `send` stubbed, liveness injected as a counting
// stub FUNCTION (the « live session » of the card: fresh `working` status == liveness true). "Touched 4 h ago" =
// fs.utimesSync on the session transcript before the first fold (lastTouchedMs = max mtime). Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-k6-states-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-k6-states-probe-'));
const projDir = path.join(base, 'projects', 'proj-k6');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_NO_OPEN = '1';
require('../src/main/window').send = () => {};
const sa = require('../src/main/session-activity.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW0 = Date.now();
const iso = (t) => new Date(t).toISOString();
const wj = (f, ls) => fs.writeFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const ACK = 'Async agent launched successfully in the background.';
const note = (D, A, t, status, summary, extra = '') => ({ type: 'attachment', timestamp: iso(t), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: [
  '<task-notification>', `<task-id>${A}</task-id>`, `<tool-use-id>${D}</tool-use-id>`, `<output-file>/tmp/${A}.output</output-file>`,
  `<status>${status}</status>`, `<summary>${summary}</summary>`, extra, '</task-notification>'].join('\n') } });
const WAIT_NOTE = '<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes.</note>';

// o.crossTurn: a real user message follows the dispatch (the entry is no longer in the current turn).
// o.touched: ms ago the session transcript was last written (mtime), default fresh. o.notice: 'waiting' (a parent-side
// waiting notice). o.own(now): the lines of the agent's own transcript (none = nothing joined, the ghost case).
let seq = 0;
function session(key, o = {}) {
  const start = NOW0 - 20 * MIN;
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const D = `toolu_${key}`; const A = `agk${seq}`;
  const file = path.join(projDir, `${sid}.jsonl`);
  const lines = [{ type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(start), message: { role: 'user', content: `start ${key}` } },
    { type: 'assistant', timestamp: iso(start + 1000), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: key, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(start + 2000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } }];
  if (o.crossTurn) lines.push({ type: 'user', cwd: base, timestamp: iso(start + 10000), message: { role: 'user', content: `next ${key}` } });
  if (o.notice === 'waiting') lines.push(note(D, A, start + 5 * MIN, 'completed', 'Agent "x" is waiting on its own background work', WAIT_NOTE));
  wj(file, lines);
  const files = [file];
  if (o.own) { // the agent's own transcript (records stamped 5-4 min ago); `touched` ages its mtime too
    const dir = path.join(projDir, sid, 'subagents'); fs.mkdirSync(dir, { recursive: true });
    const ownFile = path.join(dir, `agent-${A}.jsonl`);
    wj(ownFile, o.own(NOW0));
    files.push(ownFile);
  }
  if (o.touched !== undefined) for (const f of files) { const t = new Date(NOW0 - o.touched); fs.utimesSync(f, t, t); }
  return { sid, D };
}
const asst = (t, x = {}) => ({ type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }], ...x } });
const stopTail = (t) => ({ type: 'attachment', isSidechain: true, timestamp: iso(t), attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } });
const live = (v) => { const f = () => { f.calls += 1; return f.value; }; f.calls = 0; f.value = v; return f; };
const act = (s) => sa.sessionActivity(s.sid);
const st = (s, liveness) => sa.agentStatesOf(s.sid, liveness).get(s.D);
const payload = (a, s, liveness) => sa.activityFlags(a, liveness, s.sid).agents.find((x) => x.toolUseId === s.D);

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });

async function main() {
  await gate('stale_cross_turn_running_reads_unknown_in_both', async () => {
    const s = session('k1', { crossTurn: true, touched: 4 * HOUR });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'unknown' && x.reason === 'stale-session' && p === undefined,
      `lastTouched 4 h, live: agentStatesOf=${x && x.state}/${x && x.reason}, in payload=${p !== undefined} (expect unknown/stale-session, omitted)`);
  });
  await gate('fresh_cross_turn_running_in_both', async () => {
    const s = session('k2', { crossTurn: true });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'running' && p && p.state === 'running',
      `lastTouched fresh, live: agentStatesOf=${x && x.state}, payload=${p && p.state} (expect running, running)`);
  });
  await gate('stale_cross_turn_waiting_reads_unknown_in_both', async () => {
    const s = session('k3', { crossTurn: true, touched: 4 * HOUR, notice: 'waiting' });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'unknown' && x.reason === 'stale-session' && p === undefined,
      `waiting notice, lastTouched 4 h: agentStatesOf=${x && x.state}/${x && x.reason}, in payload=${p !== undefined} (expect unknown/stale-session, omitted)`);
  });
  await gate('fresh_cross_turn_waiting_in_both', async () => {
    const s = session('k4', { crossTurn: true, notice: 'waiting' });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'waiting' && p && p.state === 'waiting',
      `waiting notice, lastTouched fresh: agentStatesOf=${x && x.state}, payload=${p && p.state} (expect waiting, waiting)`);
  });
  await gate('stale_in_turn_unchanged', async () => {
    const s = session('k5', { touched: 4 * HOUR });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'running' && p && p.state === 'running',
      `in-turn, lastTouched 4 h: agentStatesOf=${x && x.state}, payload=${p && p.state} (expect running, running: the gate never touches an in-turn entry)`);
  });
  await gate('stale_cross_turn_terminal_not_masked', async () => {
    // a cross-turn entry with a terminal OWN tail stays in C1 (the parent ledger still says running) and reads done
    const s = session('k6', { crossTurn: true, touched: 4 * HOUR,
      own: (n) => [asst(n - 6 * MIN), asst(n - 5 * MIN, { stop_reason: 'end_turn' }), stopTail(n - 5 * MIN + 500)] });
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'done' && x.reason === 'own-tail' && p === undefined,
      `own tail, lastTouched 4 h: agentStatesOf=${x && x.state}/${x && x.reason}, in payload=${p !== undefined} (expect done/own-tail, dropped from the payload as before)`);
  });
  await gate('stale_cross_turn_closed_not_masked', async () => {
    const s = session('k7', { crossTurn: true, touched: 4 * HOUR });
    const a = await act(s); const f = live(false);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'closed' && x.reason === 'session' && p === undefined,
      `session not live, lastTouched 4 h: agentStatesOf=${x && x.state}/${x && x.reason} (expect closed/session, not unknown)`);
  });
  await gate('window_edges_around_stale_agent_ms', async () => {
    const inside = session('k8a', { crossTurn: true, touched: 3 * HOUR - 10 * MIN });
    const outside = session('k8b', { crossTurn: true, touched: 3 * HOUR + 10 * MIN });
    const ai = await act(inside); const ao = await act(outside); const f = live(true);
    const xi = st(inside, f); const xo = st(outside, f);
    const pi = payload(ai, inside, f); const po = payload(ao, outside, f);
    return chk(xi && xi.state === 'running' && pi && pi.state === 'running' && xo && xo.state === 'unknown' && xo.reason === 'stale-session' && po === undefined,
      `2h50m=${xi && xi.state}/${pi && pi.state}, 3h10m=${xo && xo.state}/${xo && xo.reason}/in payload=${po !== undefined} (expect running, running, unknown/stale-session, omitted)`);
  });
  await gate('missing_lastTouchedMs_cross_turn_reads_unknown_in_both', async () => {
    const s = session('k9', { crossTurn: true });
    const a = await act(s); const f = live(true);
    delete a.lastTouchedMs; // the cached fold has no mtime: nothing proves the session is fresh
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'unknown' && x.reason === 'stale-session' && p === undefined,
      `no lastTouchedMs: agentStatesOf=${x && x.state}/${x && x.reason}, in payload=${p !== undefined} (expect unknown/stale-session, omitted)`);
  });

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  process.exit(n === results.length ? 0 : 1);
}

main().catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
