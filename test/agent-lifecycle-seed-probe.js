// test/agent-lifecycle-seed-probe.js — A1 (D1) / rubric R2: replays the synthetic seed session (fixture README: a
// sub-agent that ends with a SubagentStop tail at 17:57:28.829Z, a shape that once showed `running` for 55 min)
// record by record through the REAL session-activity.js fold, with liveness `true`:
//   - `waiting` between the 17:51:46Z notice and the next own record
//   - `done` with endTs 17:57:28.829Z once the tail is in, and never `running` at any later replay step.
// Clock seam (plan M-3): `Date.now = () => clock` is set BEFORE session-activity.js is required, clock = the
// replayed record's ts, so no replayed record is silentOver and every Date.now() of the module is covered.
// Reads ONLY test/fixtures/agent-lifecycle-seed/ (copied into a mkdtemp tree), never ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-lifecycle-seed-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let clock = Date.parse('2026-11-06T21:00:00Z');
Date.now = () => clock;

const SID = '00000000-0000-4000-8000-00000000a001';
const AGENT = 'a0000000000000a01';
const D = 'toolu_00000000000000000000d001';
const FX = path.join(__dirname, 'fixtures', 'agent-lifecycle-seed');
const FX_MAIN = path.join(FX, `${SID}.jsonl`);
const FX_SUB = path.join(FX, SID, 'subagents');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lifecycle-seed-probe-'));
const projDir = path.join(base, 'projects', 'proj-seed');
const subDir = path.join(projDir, SID, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_NO_OPEN = '1';
require('../src/main/window').send = () => {};
const sa = require('../src/main/session-activity.js');

const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(!!ok);
}
function verdict(code) {
  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  process.exit(code === undefined ? (n === results.length ? 0 : 1) : code);
}

const topTs = (line) => { try { const t = Date.parse(JSON.parse(line).timestamp); return Number.isFinite(t) ? t : null; } catch (_) { return null; } };
function load(file) { // file order kept; a record with no ts (api-request-blob…) or an older one takes the running max
  let prev = 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const t = topTs(line);
    if (t !== null && t > prev) prev = t;
    return { line, ts: prev };
  });
}

async function main() {
  const sizeOk = fs.statSync(FX_MAIN).size === 3972 && fs.statSync(path.join(FX_SUB, `agent-${AGENT}.jsonl`)).size === 12777;
  gate('fixture_intact', sizeOk, 'seed fixture sizes match README');
  fs.copyFileSync(path.join(FX_SUB, `agent-${AGENT}.meta.json`), path.join(subDir, `agent-${AGENT}.meta.json`));

  const M = load(FX_MAIN);
  const O = load(path.join(FX_SUB, `agent-${AGENT}.jsonl`));
  const mainF = path.join(projDir, `${SID}.jsonl`);
  const ownF = path.join(subDir, `agent-${AGENT}.jsonl`);
  const trace = [];
  const bufMain = [];
  let lastMainTs = 0;
  const step = async (ts, src) => {
    clock = ts;
    await sa.sessionActivity(SID);
    const st = sa.agentStatesOf(SID, true).get(D) || null;
    trace.push({ ts, src, state: st && st.state, endTs: st && st.endTs, reason: st && st.reason });
  };
  const flush = async () => {
    if (!bufMain.length) return;
    fs.appendFileSync(mainF, bufMain.join('\n') + '\n');
    bufMain.length = 0;
    await step(lastMainTs, 'main');
  };
  let mi = 0; let oi = 0;
  while (mi < M.length || oi < O.length) {
    if (oi >= O.length || (mi < M.length && M[mi].ts <= O[oi].ts)) {
      bufMain.push(M[mi].line); lastMainTs = M[mi].ts; mi += 1;
      if (bufMain.length >= 300) await flush();
    } else {
      await flush();
      fs.appendFileSync(ownF, O[oi].line + '\n');
      await step(O[oi].ts, 'own');
      oi += 1;
    }
  }
  await flush();

  // D-OT: the agent's own terminal tail wins over a parent-side waiting notice. The first SubagentStop (17:51:46.039Z,
  // 0 open children) is followed 6 ms later by a "waiting" notice; the agent writes again at 17:57:07.026Z. Between the
  // two the state is done/own-tail, and the notice never makes it `waiting`.
  const tail1Ts = Date.parse('2026-11-07T17:51:46.039Z');
  const tailTs = Date.parse('2026-11-07T17:57:28.829Z');
  const reopenTs = O.find((o) => o.ts > tail1Ts).ts;
  const last = trace[trace.length - 1];
  const afterTail = trace.filter((t) => t.ts >= tailTs);
  const tailSteps = trace.filter((t) => t.ts >= tail1Ts && t.ts < reopenTs);
  const runSteps = trace.filter((t) => t.ts >= reopenTs && t.ts < tailTs);
  const brief = (ts) => ts.map((t) => [new Date(t.ts).toISOString(), t.src, t.state, t.reason, t.endTs && new Date(t.endTs).toISOString()]);
  const hist = {};
  for (const t of trace) hist[t.state] = (hist[t.state] || 0) + 1;
  console.log(`replay: ${trace.length} steps, states ${JSON.stringify(hist)}`);

  gate('replay_reached_running', trace.some((t) => t.state === 'running'), 'the replay passes through running before the notice');
  gate('own_tail_wins_over_parent_waiting_notice', tailSteps.length > 1 && tailSteps.every((t) => t.state === 'done' && t.reason === 'own-tail' && t.endTs === tail1Ts),
    `${tailSteps.length} step(s) from the 17:51:46.039Z tail to the next own record, the waiting notice among them (expect done/own-tail at the tail ts): ${JSON.stringify(brief(tailSteps))}`);
  gate('reopens_running_at_next_own_record', runSteps.length > 0 && runSteps[0].ts === reopenTs && runSteps.every((t) => t.state === 'running'),
    `${runSteps.length} step(s) from ${new Date(reopenTs).toISOString()} to the final tail, states=${[...new Set(runSteps.map((t) => t.state))]} (expect running)`);
  gate('done_at_tail', !!last && last.state === 'done' && last.endTs === tailTs && last.reason === 'own-tail',
    `final state=${last && last.state} endTs=${last && last.endTs && new Date(last.endTs).toISOString()} reason=${last && last.reason} (expect done 17:57:28.829Z own-tail)`);
  gate('never_running_after_tail', afterTail.length > 0 && afterTail.every((t) => t.state === 'done'),
    `${afterTail.length} step(s) at/after the tail, states=${[...new Set(afterTail.map((t) => t.state))]} (the seed showed running here for 55 min)`);
  verdict();
}

main().catch((e) => { console.log('PROBE ERROR', e && e.stack || e); gate('probe_ran', false, String(e && e.message)); verdict(1); });
