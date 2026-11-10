// v35 P4 — unit probe for usage-estimator.js on synthetic fixtures.
// Pure node, isolated tmp dir (NOT ~/.claude/projects — no FIX#1 interference).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageEstimator, SESSION_MS } = require('../src/main/usage-estimator');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const ko = (m) => { fail++; console.log(`  ✗ ${m}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-est-'));
const proj = path.join(root, 'proj-a');
fs.mkdirSync(proj, { recursive: true });

const NOW = Date.now();
const HOUR = 3600 * 1000;
// anchor: 30h ago, mid-hour (13:37-style) to exercise the floor-to-hour rule
const anchor = new Date(NOW - 30 * HOUR);
anchor.setUTCMinutes(37, 12, 0);
const A = anchor.getTime();

function line(tsMs, tok, mid, rid) {
  return JSON.stringify({
    timestamp: new Date(tsMs).toISOString(),
    requestId: rid,
    message: { id: mid, usage: { input_tokens: tok, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + '\n';
}

// block 1 (completed): 2 events at A and A+10min -> 1000 + 2000 tokens
// block 2 (completed): gap >= 5h -> A+6h, 4000 tokens
// block 3 (completed): A+12h, 8000 tokens
// block 4 (ACTIVE): NOW-10min and NOW-5min -> 600 tokens
let f1 = line(A, 1000, 'm1', 'r1') + line(A + 10 * 60000, 2000, 'm2', 'r2')
       + line(A + 6 * HOUR, 4000, 'm3', 'r3')
       + line(A + 12 * HOUR, 8000, 'm4', 'r4')
       + line(NOW - 10 * 60000, 500, 'm5', 'r5')
       + line(NOW - 5 * 60000, 100, 'm6', 'r6');
fs.writeFileSync(path.join(proj, 'session1.jsonl'), f1);
// duplicate of m5:r5 in a "fork" file + a unique event in a SUBAGENT dir
fs.writeFileSync(path.join(proj, 'session2.jsonl'), line(NOW - 10 * 60000, 500, 'm5', 'r5'));
const subDir = path.join(proj, 'session-x', 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), line(NOW - 8 * 60000, 50, 'm7', 'r7'));
// malformed lines + irrelevant lines must be skipped silently
fs.appendFileSync(path.join(proj, 'session1.jsonl'), '{broken json "usage"\n{"type":"custom-title","customTitle":"x"}\n');

const est = new UsageEstimator(root);
est.scan(NOW);
const c = est.compute(NOW);

// t1: recursive walk found all 3 files
est.files.size === 3 ? ok(`t1 recursive walk: 3 files (incl. subagents/)`) : ko(`t1 files=${est.files.size}`);

// t2: block count & floor-to-hour anchoring
c.blocks.length === 4 ? ok('t2a 4 blocks') : ko(`t2a blocks=${c.blocks.length}`);
const b1 = c.blocks[0];
const expectedStart = new Date(A); expectedStart.setUTCMinutes(0, 0, 0);
b1.startMs === expectedStart.getTime() ? ok('t2b block start floored to the hour') : ko(`t2b start=${new Date(b1.startMs).toISOString()}`);
b1.endMs === b1.startMs + SESSION_MS ? ok('t2c end = start + 5h') : ko('t2c');

// t3: per-block totals + dedup (m5:r5 counted once) + subagent tokens counted
const totals = c.blocks.map((b) => b.tokens);
JSON.stringify(totals) === JSON.stringify([3000, 4000, 8000, 650])
  ? ok(`t3 totals [3000,4000,8000,650] (dedup + subagent ok)`) : ko(`t3 totals=${JSON.stringify(totals)}`);

// t4: active block + interpolated P90 over the 3 completed ones
// (sorted [3000,4000,8000], rank=1.8 -> 4000 + 0.8*4000 = 7200 — NOT max())
c.active && c.active.tokens === 650 ? ok('t4a active block = 650 tokens') : ko('t4a');
c.p90 === 7200 ? ok('t4b p90 interpolated = 7200 (not max 8000)') : ko(`t4b p90=${c.p90}`);

// t5: tokensSince (strictly after NOW-9min -> m6 100 + m7 50)
c.tokensSince(NOW - 9 * 60000) === 150 ? ok('t5 tokensSince = 150') : ko(`t5 ${c.tokensSince(NOW - 9 * 60000)}`);

// t6: lastActivityMs = most recent event
c.lastActivityMs === NOW - 5 * 60000 ? ok('t6 lastActivityMs') : ko('t6');

// t7: incremental — unchanged rescan parses nothing & reports no change
!est.scan(NOW) ? ok('t7a unchanged rescan -> false') : ko('t7a');
fs.appendFileSync(path.join(proj, 'session1.jsonl'), line(NOW - 60000, 25, 'm8', 'r8'));
est.scan(NOW) ? ok('t7b touched file -> true') : ko('t7b');
est.compute(NOW).active.tokens === 675 ? ok('t7c recompute includes new event (675)') : ko('t7c');

// t8: a file past the 90 d scan window (100 d old) is not ingested
const oldFp = path.join(proj, 'old.jsonl');
fs.writeFileSync(oldFp, line(NOW - 100 * 24 * HOUR, 9999, 'm9', 'r9'));
const old = new Date(NOW - 100 * 24 * HOUR);
fs.utimesSync(oldFp, old, old);
est.scan(NOW);
est.files.has(oldFp) ? ko('t8 aged-out file not skipped') : ok('t8 aged-out file skipped');

// t8b: a 9 d old file is inside the 90 d scan window (ingested, served by events()) but outside the 8 d
// estimate window: compute() leaves its tokens out of the blocks and out of tokensSince
const before = est.compute(NOW);
const beforeTotals = JSON.stringify(before.blocks.map((b) => b.tokens));
const beforeSince = before.tokensSince(0);
const midFp = path.join(proj, 'nine-days.jsonl');
fs.writeFileSync(midFp, line(NOW - 9 * 24 * HOUR, 7777, 'm10', 'r10'));
const nine = new Date(NOW - 9 * 24 * HOUR);
fs.utimesSync(midFp, nine, nine);
est.scan(NOW);
const after = est.compute(NOW);
const afterTotals = JSON.stringify(after.blocks.map((b) => b.tokens));
const ingested = est.files.has(midFp) && est.events({}, NOW).some((e) => e.hash === 'm10:r10');
const leftOut = afterTotals === beforeTotals && after.tokensSince(0) === beforeSince;
ingested && leftOut ? ok('t8b 9-day-old file ingested, left out of blocks and tokensSince')
  : ko(`t8b ingested=${ingested} leftOut=${leftOut} (blocks ${beforeTotals} -> ${afterTotals}, since ${beforeSince} -> ${after.tokensSince(0)})`);

fs.rmSync(root, { recursive: true, force: true });
console.log('---');
console.log(`PASS=${pass} FAIL=${fail}`);
console.log(fail === 0 ? 'P4 VERDICT: ALL GREEN' : 'P4 VERDICT: RED');
process.exit(fail === 0 ? 0 : 1);
