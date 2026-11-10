// test/agent-memo-session-probe.js — D-MS: a death is a fact about ONE session. closedAtMemo (the first time a
// run was seen non-terminal while the deck's PtyExit file said the session is dead) is keyed by
// `sessionId:dispatchId:runId`, so two sessions that share a dispatch id (a forked or resumed transcript copies it)
// never read each other's death, and a SendMessage resume in one session clears only that session's memo.
// A call that carries no session id neither reads nor writes the memo (no shared bucket).
// Headless: the REAL session-activity.js over mkdtemp fixtures, `send` stubbed, liveness injected as a stub
// FUNCTION (false = the PtyExit file, null = no status file). The memo is observed through the endTs of a closed
// verdict: null on the first sight of the death, the memoized ms afterwards. Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-memo-session-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-memo-session-probe-'));
const projDir = path.join(base, 'projects', 'proj-memo');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_NO_OPEN = '1';
require('../src/main/window').send = () => {};
const sa = require('../src/main/session-activity.js');

const MIN = 60 * 1000;
const NOW0 = Date.now();
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wj = (f, ls) => fs.writeFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const ACK = 'Async agent launched successfully in the background.';

// One in-turn background dispatch `D` in its own session. Two sessions built with the SAME `D` model a fork.
let seq = 0;
function session(D) {
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`;
  const A = `agm${seq}`;
  const start = NOW0 - 20 * MIN;
  const file = path.join(projDir, `${sid}.jsonl`);
  wj(file, [{ type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(start), message: { role: 'user', content: `start ${D}` } },
    { type: 'assistant', timestamp: iso(start + 1000), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: D, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(start + 2000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } }]);
  return { sid, D, A, file };
}
const resume = (s, callId, t) => fs.appendFileSync(s.file, JSON.stringify({ type: 'user', timestamp: iso(t),
  message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Resuming agent in the background.' }] },
  toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: s.A } }) + '\n');
const live = (v) => { const f = () => v; return f; };
const act = (s) => sa.sessionActivity(s.sid);
const st = (s, liveness, id = s.D) => sa.agentStatesOf(s.sid, liveness).get(id);
const fmt = (x) => (x ? `${x.state}/${x.reason}/endTs=${x.endTs}` : String(x));

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });

async function main() {
  await gate('dead_session_does_not_close_an_unknown_one_sharing_the_dispatch_id', async () => {
    const a = session('toolu_life'); const b = session('toolu_life');
    await act(a); await act(b);
    st(a, live(false)); const a2 = st(a, live(false)); // PtyExit session: first sight sets the memo, the next read shows it
    const xb = st(b, live(null)); // no status file: nothing proves anything
    return chk(a2 && a2.state === 'closed' && a2.endTs !== null && xb && xb.state === 'unknown' && xb.endTs === null,
      `A(dead)=${fmt(a2)}, B(no status)=${fmt(xb)} (expect closed with a memoized endTs, unknown with endTs null)`);
  });
  await gate('unknown_first_then_dead_stays_independent', async () => {
    const a = session('toolu_rev'); const b = session('toolu_rev');
    await act(a); await act(b);
    const xb = st(b, live(null));
    st(a, live(false)); const a2 = st(a, live(false));
    const xb2 = st(b, live(null));
    return chk(xb && xb.state === 'unknown' && a2 && a2.state === 'closed' && xb2 && xb2.state === 'unknown' && xb2.endTs === null,
      `B before=${fmt(xb)}, A(dead)=${fmt(a2)}, B after=${fmt(xb2)} (expect unknown, closed, unknown)`);
  });
  await gate('each_dead_session_keeps_its_own_first_sight', async () => {
    const a = session('toolu_two'); const b = session('toolu_two');
    await act(a); await act(b);
    st(a, live(false)); const a2 = st(a, live(false));
    await sleep(40);
    const b1 = st(b, live(false)); // B's death is first seen NOW: it must not inherit A's earlier instant
    const b2 = st(b, live(false));
    const a3 = st(a, live(false));
    return chk(b1 && b1.state === 'closed' && b1.endTs === null && b2 && b2.endTs !== null && b2.endTs >= a2.endTs + 40 && a3.endTs === a2.endTs,
      `A=${fmt(a2)}, B first=${fmt(b1)}, B next=${fmt(b2)}, A again=${fmt(a3)} (expect B first endTs null, B next >= A + 40, A unchanged)`);
  });
  await gate('sessionless_call_neither_reads_nor_writes_the_memo', async () => {
    const a = session('toolu_nosid'); const b = session('toolu_nosid');
    const aa = await act(a); await act(b);
    sa.activityFlags(aa, live(false)); sa.activityFlags(aa, live(false)); // no session id: a dead verdict that must leave no memo
    const xb = st(b, live(null));
    const xa = st(a, live(false)); // the same session read WITH its id: its first sight, not the sessionless call's
    return chk(xb && xb.state === 'unknown' && xb.endTs === null && xa && xa.state === 'closed' && xa.endTs === null,
      `B(no status) after a sessionless dead call=${fmt(xb)}, A first sight with its id=${fmt(xa)} (expect unknown/null, closed/null)`);
  });
  await gate('resume_clears_only_its_own_sessions_memo', async () => {
    const a = session('toolu_res'); const b = session('toolu_res');
    await act(a); await act(b);
    st(a, live(false)); st(b, live(false));
    const b2 = st(b, live(false)); const a2 = st(a, live(false));
    resume(a, 'toolu_res_call', NOW0 - 10 * MIN);
    await act(a); // the fold sees the resume: applyResume runs on A's ledger
    const b3 = st(b, live(false)); // B was not resumed: its memo is still there
    const ra = st(a, live(false), 'toolu_res_call'); // A's new run: a first sight again
    const ra2 = st(a, live(false), 'toolu_res_call');
    return chk(b2 && b2.endTs !== null && b3 && b3.state === 'closed' && b3.endTs === b2.endTs
      && a2 && a2.endTs !== null && ra && ra.state === 'closed' && ra.endTs === null && ra2 && ra2.endTs !== null,
      `B before=${fmt(b2)}, B after A's resume=${fmt(b3)}, A new run first=${fmt(ra)}, next=${fmt(ra2)} (expect B unchanged, A's new run null then memoized)`);
  });

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  process.exit(n === results.length ? 0 : 1);
}

main().catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
