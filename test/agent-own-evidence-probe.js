// Probe for lot-own-evidence (contract K2 own evidence + A14 archive freshness): the one-pass fold of
// src/main/session-activity.js feeds each agent-<id>.jsonl through classifyOwnRecord/foldOwnRecord and exposes
// `ownByAgent` (agentId -> { lastTs, terminalTs, openChildren }) on the computed activity.
// Headless: Module._load stubs for ./window and ./state, the real ./transcripts pointed (CLAUDE_DECK_PROJECTS_DIR)
// at a mkdtemp tree. Reads ONLY test/fixtures/agent-lifecycle-seed/ (symlinked) and synthetic files; never ~/.claude.
// Run (from the worktree root): xvfb-run -a node_modules/.bin/electron test/agent-own-evidence-probe.js
//   OWN_EVIDENCE_SRC_ROOT=<tree> points the probe at another tree's src/main (the RED run uses the base tree).
// Clock (M-3): only the watch-window rows read Date.now(); their records are written relative to it. Every other ts is a constant.
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');

const SRC = path.join(process.env.OWN_EVIDENCE_SRC_ROOT || path.join(__dirname, '..'), 'src', 'main');
const FX = path.join(__dirname, 'fixtures', 'agent-lifecycle-seed');
const SEED_SID = '00000000-0000-4000-8000-00000000a001';
const SEED_AID = 'a0000000000000a01';
const H = 3600 * 1000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-evidence-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = root;
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /session-activity\.js$/.test(parent.filename)) {
    if (request === './window') return { send() {} };
    if (request === './state') return { ptys: new Map(), resumeIdMap: new Map() };
  }
  return load.apply(this, arguments);
};

// bytes read / opens per file path, for the incremental and "unchanged dirs are skipped" assertions
const reads = new Map();
const opens = new Map();
const realOpen = fsp.open;
fsp.open = async function (p, ...rest) {
  const fh = await realOpen.call(this, p, ...rest);
  const key = String(p);
  opens.set(key, (opens.get(key) || 0) + 1);
  const read = fh.read.bind(fh);
  fh.read = async (...args) => { const res = await read(...args); reads.set(key, (reads.get(key) || 0) + res.bytesRead); return res; };
  return fh;
};
const resetCounters = () => { reads.clear(); opens.clear(); };
const bytesOf = (p) => reads.get(p) || 0;
const bytesUnder = (dir) => [...reads].filter(([p]) => p.startsWith(dir + path.sep)).reduce((n, [, b]) => n + b, 0);
const opensUnder = (dir) => [...opens].filter(([p]) => p.startsWith(dir + path.sep)).reduce((n, [, b]) => n + b, 0);

let sa = null; let life = null; let loadError = null;
try { sa = require(path.join(SRC, 'session-activity.js')); life = require(path.join(SRC, 'agent-lifecycle.js')); } catch (e) { loadError = e; }

const results = {};
const notes = [];
const gate = (name, ok) => { results[name] = ok === true; };
const own = (r, id) => (r && r.ownByAgent instanceof Map ? r.ownByAgent.get(id) : undefined);
const view = (f) => (f ? { lastTs: f.lastTs, terminalTs: f.terminalTs, openChildren: f.openChildren } : undefined);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- synthetic own-transcript records (shapes of agent-lifecycle-core-probe) ----------------
const iso = (ms) => new Date(ms).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const userText = (aid, ms, s) => line({ type: 'user', agentId: aid, timestamp: iso(ms), message: { role: 'user', content: s } });
const endTurn = (aid, ms) => line({ type: 'assistant', agentId: aid, timestamp: iso(ms), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const stopAtt = (aid, ms) => line({ type: 'attachment', agentId: aid, timestamp: iso(ms), attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 } });
// task, end_turn, optional SubagentStop tail; `pad` makes the file big enough to tell an append from a refold
const ownFile = (aid, t0, tail, pad) => userText(aid, t0, 'x'.repeat(pad || 0) + 'task') + endTurn(aid, t0 + 1000) + (tail ? stopAtt(aid, t0 + 2000) : '');

function mkSession() {
  const sid = crypto.randomUUID();
  const proj = path.join(root, '-fx-' + sid.slice(0, 8));
  fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), line({ type: 'user', timestamp: iso(Date.UTC(2026, 10, 7, 9)), cwd: '/tmp', message: { role: 'user', content: 'hi' } }));
  return { sid, proj, live: path.join(proj, sid, 'subagents'), arch: path.join(proj, 'subagents-archive', sid) };
}
function archDir(s, name, files) {
  const dir = path.join(s.arch, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), body);
  return dir;
}
// Appending to a file never touches its dir's mtime; the result says so (a utimes restore cannot be bit-exact:
// Date drops the sub-millisecond part of mtimeMs, which the dir signature carries).
function appendKeepingDir(dir, file, body) {
  const before = fs.statSync(dir).mtimeMs;
  fs.appendFileSync(file, body);
  return fs.statSync(dir).mtimeMs === before;
}

async function run() {
  if (loadError) { notes.push(`load: ${loadError.message}`); return; }

  // ---- 1. the seed session (synthetic fixture): the ghost's own file, folded in the live subagents dir ----
  {
    const proj = path.join(root, '-fx-seed');
    const sub = path.join(proj, SEED_SID, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.symlinkSync(path.join(FX, `${SEED_SID}.jsonl`), path.join(proj, `${SEED_SID}.jsonl`));
    for (const f of fs.readdirSync(path.join(FX, SEED_SID, 'subagents'))) fs.symlinkSync(path.join(FX, SEED_SID, 'subagents', f), path.join(sub, f));
    const r = await sa.sessionActivity(SEED_SID);
    const direct = life.newOwnFold();
    for (const l of fs.readFileSync(path.join(FX, SEED_SID, 'subagents', `agent-${SEED_AID}.jsonl`), 'utf8').split('\n')) if (l) life.foldOwnRecord(direct, life.classifyOwnRecord(l));
    const got = own(r, SEED_AID);
    gate('seed_has_entry', got !== undefined);
    gate('seed_matches_L1', same(got, view(direct)) && direct.lastTs !== null);
    gate('seed_terminal_tail', !!got && got.terminalTs === Date.parse('2026-11-07T17:57:28.829Z') && got.terminalTs === got.lastTs && got.openChildren === 0);
    gate('seed_main_not_own', r.ownByAgent instanceof Map && r.ownByAgent.size === 1);
    gate('seed_agentstate_done', !!got && life.agentState({ startTs: got.lastTs - 60000 }, got, { sessionLive: true }).state === 'done');
  }

  // ---- 2. a live file: an appended record after the stop clears terminalTs; only the appended bytes are read ----
  {
    const s = mkSession();
    const f = path.join(s.live, 'agent-live0001.jsonl');
    const t0 = Date.UTC(2026, 10, 7, 12);
    fs.writeFileSync(f, ownFile('live0001', t0, true, 200000));
    const r1 = await sa.sessionActivity(s.sid);
    const o1 = own(r1, 'live0001');
    const more = userText('live0001', t0 + 60000, 'follow-up');
    resetCounters();
    fs.appendFileSync(f, more);
    const r2 = await sa.sessionActivity(s.sid);
    const o2 = own(r2, 'live0001');
    gate('append_flips_terminal', !!o1 && o1.terminalTs === t0 + 2000 && !!o2 && o2.terminalTs === null && o2.lastTs === t0 + 60000);
    gate('append_reads_only_new_bytes', !!o2 && bytesOf(f) > 0 && bytesOf(f) <= Buffer.byteLength(more) + 256);
  }

  // ---- 3. the newest copy by lastTs wins across live + archive ----
  {
    const s = mkSession();
    const t0 = Date.UTC(2026, 10, 7, 12);
    fs.writeFileSync(path.join(s.live, 'agent-dup00001.jsonl'), ownFile('dup00001', t0 + 600000, false)); // live: newer, no tail
    archDir(s, '2026-11-07-100000', { 'agent-dup00001.jsonl': ownFile('dup00001', t0, true) });         // archive: older, terminal
    const r = await sa.sessionActivity(s.sid);
    const o = own(r, 'dup00001');
    gate('archive_older_loses', !!o && o.lastTs === t0 + 601000 && o.terminalTs === null);
    const s2 = mkSession();
    fs.writeFileSync(path.join(s2.live, 'agent-dup00002.jsonl'), ownFile('dup00002', t0, false));        // live: older
    archDir(s2, '2026-11-07-100000', { 'agent-dup00002.jsonl': ownFile('dup00002', t0 + 600000, true) }); // archive: newer, terminal
    const o2 = own(await sa.sessionActivity(s2.sid), 'dup00002');
    gate('archive_newer_wins', !!o2 && o2.terminalTs === t0 + 602000);
  }

  // ---- 4. a pass with nothing changed reads 0 bytes (live and archive) and settles on a cache hit ----
  {
    const s = mkSession();
    const t0 = Date.UTC(2026, 10, 7, 12);
    fs.writeFileSync(path.join(s.live, 'agent-calm0001.jsonl'), ownFile('calm0001', t0, true, 50000));
    archDir(s, '2026-11-07-100000', { 'agent-calm0002.jsonl': ownFile('calm0002', t0, false, 50000) });
    archDir(s, '2026-11-07-110000', { 'agent-calm0003.jsonl': ownFile('calm0003', t0, true, 50000) });
    const r1 = await sa.sessionActivity(s.sid); // first pass reads everything; the archive watch is known only now
    resetCounters();
    const r2 = await sa.sessionActivity(s.sid); // no change on disk: the stamp may still move once (new watch set), nothing is read
    gate('second_pass_zero_bytes', own(r1, 'calm0002') !== undefined && [...reads.values()].every((b) => b === 0) && opens.size === 0 && own(r2, 'calm0002') !== undefined);
    const r3 = await sa.sessionActivity(s.sid);
    gate('settled_cache_hit', r3 === r2 && r3.ownByAgent instanceof Map);
  }

  // ---- 5. A14: a tail appended to an older archive dir's file, its dir mtime restored ----
  {
    const s = mkSession();
    const t0 = Date.now() - 600000; // A's last record must sit inside the 3 h watch window (real clock, M-3)
    fs.writeFileSync(path.join(s.live, 'agent-live0003.jsonl'), ownFile('live0003', t0, true, 20000));
    const A = archDir(s, '2026-11-07-100000', { 'agent-aaaa1111.jsonl': ownFile('aaaa1111', t0, false, 20000) }); // no tail
    const B = archDir(s, '2026-11-07-110000', { 'agent-bbbb2222.jsonl': ownFile('bbbb2222', t0, true, 20000) }); // created after A's file
    await sa.sessionActivity(s.sid); // the pass that sees B
    const r2 = await sa.sessionActivity(s.sid);
    const fa = path.join(A, 'agent-aaaa1111.jsonl');
    const before = own(r2, 'aaaa1111');
    const dirKept = appendKeepingDir(A, fa, endTurn('aaaa1111', t0 + 301000) + stopAtt('aaaa1111', t0 + 302000));
    resetCounters();
    const r3 = await sa.sessionActivity(s.sid);
    const o3 = own(r3, 'aaaa1111');
    gate('a14_dir_mtime_untouched', dirKept);
    gate('a14_stamp_misses', r3 !== r2 && !!o3);
    gate('a14_refolds_A_only', bytesOf(fa) > 0 && bytesUnder(A) === bytesOf(fa) && bytesUnder(B) === 0 && opensUnder(B) === 0 && bytesUnder(s.live) === 0 && opensUnder(s.live) === 0 && bytesOf(path.join(s.proj, `${s.sid}.jsonl`)) === 0);
    gate('a14_terminal_set', !!before && before.terminalTs === null && !!o3 && o3.terminalTs === t0 + 302000);
    gate('a14_agentstate_done', !!o3 && life.agentState({ startTs: t0 }, o3, { sessionLive: true }).state === 'done');
    gate('a14_others_unchanged', !!own(r3, 'bbbb2222') && !!own(r3, 'live0003')
      && same(view(own(r3, 'bbbb2222')), view(own(r2, 'bbbb2222'))) && same(view(own(r3, 'live0003')), view(own(r2, 'live0003'))));
  }

  // ---- 6. watch window: an own-terminal file 2 h 59 min old is watched, 3 h 1 min old is not (real clock, M-3) ----
  {
    const s = mkSession();
    const now = Date.now();
    const tP = now - (3 * H - 60000) - 2000; // last record (the stop) 2 h 59 min old
    const tQ = now - (3 * H + 60000) - 2000; // 3 h 1 min old
    const P = archDir(s, '2026-11-07-090000', { 'agent-pppp0001.jsonl': ownFile('pppp0001', tP, true) });
    const Q = archDir(s, '2026-11-07-091000', { 'agent-qqqq0001.jsonl': ownFile('qqqq0001', tQ, true) });
    archDir(s, '2026-11-07-120000', { 'agent-nnnn0001.jsonl': ownFile('nnnn0001', tQ, true) }); // the newest dir, always compared
    await sa.sessionActivity(s.sid);
    const r2 = await sa.sessionActivity(s.sid);
    const stop = (t) => t + 2000;
    const at = (r, id) => own(r, id) || {};
    gate('watch_rows_start_terminal', at(r2, 'pppp0001').terminalTs === stop(tP) && at(r2, 'qqqq0001').terminalTs === stop(tQ));
    appendKeepingDir(Q, path.join(Q, 'agent-qqqq0001.jsonl'), userText('qqqq0001', now, 'late'));
    const r3 = await sa.sessionActivity(s.sid);
    gate('watch_3h01_not_watched', r3 === r2 && r3.ownByAgent instanceof Map && at(r3, 'qqqq0001').terminalTs === stop(tQ));
    appendKeepingDir(P, path.join(P, 'agent-pppp0001.jsonl'), userText('pppp0001', now, 'late'));
    const r4 = await sa.sessionActivity(s.sid);
    gate('watch_2h59_watched', r4 !== r3 && own(r4, 'pppp0001') !== undefined && at(r4, 'pppp0001').terminalTs === null && at(r4, 'pppp0001').lastTs === now);
  }

  // ---- 7. R6: a NON-terminal own file (a killed agent, no tail) is watched only inside the window as well ----
  {
    const s = mkSession();
    const now = Date.now();
    const lastIn = now - (3 * H - 60000);  // last record 2 h 59 min old, no tail
    const lastOut = now - (3 * H + 60000); // 3 h 1 min old, no tail
    const In = archDir(s, '2026-11-07-070000', { 'agent-inin0001.jsonl': ownFile('inin0001', lastIn - 1000, false) });
    const Out = archDir(s, '2026-11-07-071000', { 'agent-outt0001.jsonl': ownFile('outt0001', lastOut - 1000, false) });
    archDir(s, '2026-11-07-120000', { 'agent-nnnn0002.jsonl': ownFile('nnnn0002', lastOut, true) }); // the newest dir
    await sa.sessionActivity(s.sid);
    const r2 = await sa.sessionActivity(s.sid);
    const at = (r, id) => own(r, id) || {};
    appendKeepingDir(Out, path.join(Out, 'agent-outt0001.jsonl'), userText('outt0001', now, 'resumed'));
    const r3 = await sa.sessionActivity(s.sid);
    gate('watch_nonterminal_3h01_not_watched', r3 === r2 && r3.ownByAgent instanceof Map && at(r3, 'outt0001').lastTs === lastOut && at(r3, 'outt0001').terminalTs === null);
    appendKeepingDir(In, path.join(In, 'agent-inin0001.jsonl'), userText('inin0001', now, 'resumed'));
    const r4 = await sa.sessionActivity(s.sid);
    gate('watch_nonterminal_2h59_watched', r4 !== r3 && at(r4, 'inin0001').lastTs === now);
  }
}

run().catch((e) => { notes.push(`threw: ${e && e.stack}`); }).then(() => {
  const names = ['seed_has_entry', 'seed_matches_L1', 'seed_terminal_tail', 'seed_main_not_own', 'seed_agentstate_done',
    'append_flips_terminal', 'append_reads_only_new_bytes', 'archive_older_loses', 'archive_newer_wins',
    'second_pass_zero_bytes', 'settled_cache_hit', 'a14_dir_mtime_untouched', 'a14_stamp_misses', 'a14_refolds_A_only', 'a14_terminal_set',
    'a14_agentstate_done', 'a14_others_unchanged', 'watch_rows_start_terminal', 'watch_3h01_not_watched', 'watch_2h59_watched',
    'watch_nonterminal_3h01_not_watched', 'watch_nonterminal_2h59_watched'];
  let failed = 0;
  for (const n of names) { const ok = results[n] === true; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`); }
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(failed === 0 ? `VERDICT: ALL GREEN (${names.length}/${names.length})` : `VERDICT: FAIL (${failed}/${names.length})`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
});
