// test/agent-meta-session-probe.js — D-MS2: the stop / resume / meta-check state of an agent is a fact about ONE
// session. stoppedAtMemo (the user stop of the current run), metaCheckedAt (the negative-memo cooldown), metaResumed
// and metaRunGen (the resume bookkeeping) and the in-flight scan guard are keyed by `sessionId:dispatchId`, so two
// sessions that share a dispatch id (a forked or resumed transcript copies it) never read each other's stop, never
// inherit each other's cooldown, and a SendMessage resume in one session leaves the other session's state alone.
// A call that carries no session id neither reads nor writes these tables.
// Headless: the REAL session-activity.js over mkdtemp fixtures, `send` stubbed, liveness `true`. A user stop is the
// agent's meta.json (stoppedByUser) with, or without, an interrupt record as the own transcript's last record.
// Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-meta-session-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-meta-session-probe-'));
const projDir = path.join(base, 'projects', 'proj-meta');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_NO_OPEN = '1';
require('../src/main/window').send = () => {};
const sa = require('../src/main/session-activity.js');

const MIN = 60 * 1000;
const NOW0 = Date.now();
const T0 = NOW0 - 20 * MIN; // session start; every fixed event sits between T0 and NOW0
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wj = (f, ls) => fs.writeFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const aj = (f, ls) => fs.appendFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const ACK = 'Async agent launched successfully in the background.';
const INTERRUPT = '[Request interrupted by user]';

// One in-turn background dispatch `D` in its own session. Two sessions built with the SAME `D` model a fork.
let seq = 0;
function session(D) {
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-ffff-4fff-8fff-ffffffffffff`;
  const A = `agq${seq}`;
  const s = { sid, D, A, file: path.join(projDir, `${sid}.jsonl`), dir: path.join(projDir, sid, 'subagents') };
  wj(s.file, [{ type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(T0), message: { role: 'user', content: `start ${D}` } },
    { type: 'assistant', timestamp: iso(T0 + 1000), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: D, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(T0 + 2000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } }]);
  fs.mkdirSync(s.dir, { recursive: true });
  return s;
}
const ownFile = (s) => path.join(s.dir, `agent-${s.A}.jsonl`);
const metaBody = (s) => JSON.stringify({ agentType: 'code-dev', description: s.D, toolUseId: s.D, stoppedByUser: true });
const putStopMeta = (s) => fs.writeFileSync(path.join(s.dir, `agent-${s.A}.meta.json`), metaBody(s));
const asst = (t) => ({ type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
const interrupt = (t) => ({ type: 'user', isSidechain: true, timestamp: iso(t), message: { role: 'user', content: [{ type: 'text', text: INTERRUPT }] } });
// A user stop with an interrupt record as the own transcript's last record (the stop ts is that record's).
const stopWithInterrupt = (s, t) => { putStopMeta(s); wj(ownFile(s), [asst(T0 + 3000), interrupt(t)]); };
const resume = (s, callId, t) => aj(s.file, [{ type: 'user', timestamp: iso(t),
  message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Resuming agent in the background.' }] },
  toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: s.A } }]);
const act = (s) => sa.sessionActivity(s.sid);
const st = (s) => sa.agentStatesOf(s.sid, true).get(s.D);
const fmt = (x) => (x ? `${x.state}/${x.reason}/endTs=${x.endTs}` : String(x));
async function pollState(s, want, ms = 2500) { // the stop evidence arrives through the async meta check
  let x = null;
  for (let i = 0; i < ms / 100; i++) {
    sa.activityFlags(await act(s), true, s.sid);
    x = st(s);
    if (x && x.state === want) return x;
    await sleep(100);
  }
  return x;
}

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });
const isStop = (x, endTs) => x && x.state === 'blocked' && x.reason === 'stop' && (endTs === undefined || x.endTs === endTs);

async function main() {
  await gate('stop_in_A_leaves_B_non_blocked', async () => {
    const a = session('toolu_g1'); const b = session('toolu_g1');
    stopWithInterrupt(a, T0 + 2 * MIN);
    const xa = await pollState(a, 'blocked');
    await act(b);
    const xb0 = st(b);
    sa.activityFlags(await act(b), true, b.sid); await sleep(300);
    const xb = st(b);
    return chk(isStop(xa, T0 + 2 * MIN) && xb0 && xb0.state === 'running' && xb && xb.state === 'running',
      `A=${fmt(xa)}, B before its own check=${fmt(xb0)}, B after=${fmt(xb)} (expect A blocked/stop at the interrupt, B running both times)`);
  });

  await gate('cooldown_of_Bs_negative_memo_is_not_As', async () => {
    const a = session('toolu_g2'); const b = session('toolu_g2');
    const xa = await pollState(a, 'blocked', 600); // A: no meta -> its negative memo is set, state stays running
    stopWithInterrupt(b, T0 + 2 * MIN); // B is stopped AFTER A's check: B's own scan must still run
    const xb = await pollState(b, 'blocked');
    return chk(xa && xa.state === 'running' && isStop(xb, T0 + 2 * MIN),
      `A (checked, no stop)=${fmt(xa)}, B (stopped later, own check)=${fmt(xb)} (expect running, blocked/stop: A's cooldown never skips B)`);
  });

  await gate('both_stopped_same_tick_each_gets_its_scan', async () => {
    const a = session('toolu_g2b'); const b = session('toolu_g2b');
    stopWithInterrupt(a, T0 + 2 * MIN); stopWithInterrupt(b, T0 + 3 * MIN);
    const aa = await act(a); const bb = await act(b);
    sa.activityFlags(aa, true, a.sid); sa.activityFlags(bb, true, b.sid); // same tick: A's scan is in flight when B asks
    await sleep(800);
    const xa = st(a); const xb = st(b); // no further flags call: only the two first scans count
    return chk(isStop(xa, T0 + 2 * MIN) && isStop(xb, T0 + 3 * MIN),
      `A=${fmt(xa)}, B=${fmt(xb)} (expect both blocked/stop, each at its own interrupt: B's scan is not skipped by A's in-flight one)`);
  });

  await gate('resume_in_A_leaves_B_an_original_run_stop_readable', async () => {
    const a = session('toolu_g3'); const b = session('toolu_g3');
    resume(a, 'toolu_g3_call', T0 + 4 * MIN);
    await act(a); // applyResume on A's ledger: A's run is resumed
    putStopMeta(b); // B was never resumed, no interrupt record: the original run reads the meta file's mtime
    const xb = await pollState(b, 'blocked');
    return chk(isStop(xb), `B (original run, stopped, A resumed meanwhile)=${fmt(xb)} (expect blocked/stop: A's resume does not put B on the resumed-run rule)`);
  });

  await gate('resume_in_A_does_not_discard_Bs_scan_in_flight', async () => {
    const a = session('toolu_g4'); const b = session('toolu_g4');
    // B's scan walks 800 decoy metas of the live dir before it reaches the real one in an archive dir: it is still
    // running when A's resume is folded.
    for (let i = 0; i < 800; i++) fs.writeFileSync(path.join(b.dir, `decoy-${i}.meta.json`), JSON.stringify({ toolUseId: `nope_${i}` }));
    const arch = path.join(projDir, 'subagents-archive', b.sid, '20260101T000000');
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(path.join(arch, `agent-${b.A}.meta.json`), metaBody(b));
    const bb = await act(b);
    sa.activityFlags(bb, true, b.sid); // B's scan starts, its run generation is read here
    resume(a, 'toolu_g4_call', T0 + 4 * MIN);
    await act(a); // A's resume bumps A's generation, while B's scan is awaiting the decoys
    let xb = null;
    for (let i = 0; i < 60 && !(xb && xb.state === 'blocked'); i++) { await sleep(50); xb = st(b); } // no new flags call
    return chk(isStop(xb), `B after its first scan, A resumed during it=${fmt(xb)} (expect blocked/stop: the result of B's scan is kept)`);
  });

  await gate('resume_in_A_does_not_clear_Bs_stop', async () => {
    const a = session('toolu_g5'); const b = session('toolu_g5');
    stopWithInterrupt(b, T0 + 2 * MIN);
    const xb1 = await pollState(b, 'blocked');
    resume(a, 'toolu_g5_call', T0 + 4 * MIN);
    await act(a);
    const xb2 = st(b); // B's stop is memoized: A's resume must not drop it
    return chk(isStop(xb1, T0 + 2 * MIN) && isStop(xb2, T0 + 2 * MIN),
      `B before=${fmt(xb1)}, B after A's resume=${fmt(xb2)} (expect blocked/stop both times)`);
  });

  await gate('resume_in_A_leaves_Bs_cooldown_memo', async () => {
    const a = session('toolu_g5b'); const b = session('toolu_g5b');
    const x1 = await pollState(b, 'blocked', 600); // B: no meta -> negative memo set (5 min cooldown)
    stopWithInterrupt(b, T0 + 2 * MIN); // evidence appears afterwards: only a cleared cooldown would find it now
    resume(a, 'toolu_g5b_call', T0 + 4 * MIN);
    await act(a);
    sa.activityFlags(await act(b), true, b.sid); await sleep(600);
    const x2 = st(b);
    return chk(x1 && x1.state === 'running' && x2 && x2.state === 'running',
      `B checked before=${fmt(x1)}, B after A's resume + a flags call=${fmt(x2)} (expect running both: B's cooldown is not reset by A's resume)`);
  });

  await gate('each_session_own_stop_and_resume_still_work', async () => {
    const a = session('toolu_g6');
    stopWithInterrupt(a, T0 + 2 * MIN);
    const x1 = await pollState(a, 'blocked');
    const R = NOW0 - 2 * MIN;
    resume(a, 'toolu_g6_call', R);
    await act(a); // applyResume: the previous run's stop is dropped
    const x2 = st(a);
    aj(ownFile(a), [interrupt(R + MIN)]); // the resumed run is stopped in its turn
    const x3 = await pollState(a, 'blocked');
    return chk(isStop(x1, T0 + 2 * MIN) && x2 && x2.state === 'running' && isStop(x3, R + MIN),
      `stop=${fmt(x1)}, after its own resume=${fmt(x2)}, resumed run stopped=${fmt(x3)} (expect blocked, running, blocked at the new interrupt)`);
  });

  await gate('sessionless_call_neither_reads_nor_writes_the_tables', async () => {
    const a = session('toolu_g7'); const b = session('toolu_g7');
    stopWithInterrupt(a, T0 + 2 * MIN);
    const xa = await pollState(a, 'blocked');
    const aa = await act(a);
    const f1 = sa.activityFlags(aa, true); // no session id: A's stop is not read
    const bb = await act(b);
    stopWithInterrupt(b, T0 + 3 * MIN);
    sa.activityFlags(bb, true); sa.activityFlags(bb, true); // no session id: no scan, no memo written for B
    await sleep(500);
    const xb = st(b);
    return chk(isStop(xa, T0 + 2 * MIN) && f1.agents.length === 1 && f1.agents[0].state === 'running' && xb && xb.state === 'running',
      `A with its id=${fmt(xa)}, A read with no session id=${f1.agents[0] && f1.agents[0].state}, B after sessionless flags calls=${fmt(xb)} (expect blocked, running, running)`);
  });

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  process.exit(n === results.length ? 0 : 1);
}

main().catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
