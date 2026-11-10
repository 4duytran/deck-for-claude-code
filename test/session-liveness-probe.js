// test/session-liveness-probe.js — HERMETIC probe for sessionLiveness() in src/main/session-status.js
// (contract K3a, plan Step L1b): tri-state liveness true | false | null, CACHE FIRST (H1).
//   false = the deck's own PtyExit only; any hook SessionEnd -> null; a fresh/live pane -> true.
// Electron main process, no window. HOME, the status dir and the rooms dir are mkdtemp trees (nothing under the real
// ~/.claude). The live pane pid is a real `sleep 60` child injected into state.ptys; the dead one is a reaped pid.
// Read count = delta of global.__deckStatusDiskReads (seam in readSessionStatusEntry). Cache primed with
// readSessionStatusCached before each measured call. Watcher rows use global.__deckStatusEvents.
// Run (worktree root): env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 <CENV> xvfb-run -a timeout 180 \
//   node_modules/.bin/electron test/session-liveness-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-liveness-probe-'));
const STATUS_DIR = path.join(BASE, 'status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
process.env.HOME = path.join(BASE, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.CLAUDE_DECK_STATUS_DIR = STATUS_DIR;
process.env.CLAUDE_DECK_ROOMS_DIR = path.join(BASE, 'rooms');
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(BASE, 'projects');

const { app } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-liveness-probe-ud-')));

const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} - ${detail}`);
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000;

let seq = 0;
const newId = () => { seq += 1; return `${seq.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`; };
const fileOf = (sid) => path.join(STATUS_DIR, `${sid}.json`);
const writeRaw = (sid, text) => fs.writeFileSync(fileOf(sid), text);
const writeStatus = (sid, obj, ageMs = 0) => {
  const body = Object.assign({ ts: new Date(Date.now() - ageMs).toISOString() }, obj);
  writeRaw(sid, JSON.stringify(body) + '\n');
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(fileOf(sid), t, t); }
};

app.whenReady().then(async () => {
  const ss = require(path.join(__dirname, '..', 'src', 'main', 'session-status.js'));
  const state = require(path.join(__dirname, '..', 'src', 'main', 'state.js'));
  const { ptys, resumeIdMap, statusAlias } = state;
  const exported = typeof ss.sessionLiveness === 'function';

  const live = spawn('sleep', ['60'], { stdio: 'ignore' });
  const dead = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => dead.once('exit', r));
  await sleep(50);
  let deadAlive = true;
  try { process.kill(dead.pid, 0); } catch (_) { deadAlive = false; }
  gate('h0_harness', !deadAlive && live.pid > 0, `live pid ${live.pid} (sleep 60), dead pid ${dead.pid} reaped (signal 0 refused: ${!deadAlive})`);

  let paneN = 0;
  const addPane = (sessionId, extra = {}) => {
    paneN += 1;
    const paneId = `pane-${paneN}`;
    ptys.set(paneId, Object.assign({ proc: { pid: live.pid }, sessionId, cwd: BASE }, extra));
    return paneId;
  };
  const dropPanes = () => ptys.clear();
  // Prime the cache for `key` from the file now on disk (like a scan/watcher event would have).
  const prime = (key) => { ss.statusCache.delete(key); return ss.readSessionStatusCached(key); };
  const measure = (sid) => {
    const before = global.__deckStatusDiskReads || 0;
    let value;
    try { value = exported ? ss.sessionLiveness(sid) : 'NOT-EXPORTED'; } catch (e) { value = `THROWS ${e.message}`; }
    return { value, reads: (global.__deckStatusDiskReads || 0) - before };
  };
  const expectRow = (id, sid, want, wantReads, label) => {
    const m = measure(sid);
    gate(id, m.value === want && m.reads === wantReads, `${label} -> ${String(m.value)} with ${m.reads} read(s) (want ${String(want)}, ${wantReads})`);
  };

  // ---- PtyExit rows
  {
    const sid = newId();
    ss.markSessionClosed(sid); // the deck's own write: PtyExit file + cache set synchronously
    expectRow('p1_ptyexit_via_markSessionClosed', sid, false, 1, 'PtyExit file written by markSessionClosed, no pane');
  }
  const SPane = newId();
  {
    writeStatus(SPane, { status: 'closed', event: 'PtyExit' });
    prime(SPane);
    addPane(SPane);
    expectRow('p2_ptyexit_beats_live_pane', SPane, false, 1, 'PtyExit file + live pane (precedence)');
    writeStatus(SPane, { status: 'active', event: 'SessionStart' });
    prime(SPane);
    expectRow('p3_sessionstart_live_pane', SPane, true, 0, 'active (SessionStart) + live pane, cache primed');
    dropPanes();
  }

  // ---- hook SessionEnd rows (A15, D-S7): any SessionEnd -> null, whatever the pane
  for (const [tag, text] of [
    ['plain', '{"status":"closed","event":"SessionEnd"}\n'],
    ['extra_key', '{"status":"closed","event":"SessionEnd","reason":"clear"}\n'],
  ]) {
    const sid = newId();
    writeRaw(sid, text);
    prime(sid);
    expectRow(`e_${tag}_nopane`, sid, null, 1, `SessionEnd file ${tag}, no pane`);
    addPane(sid);
    prime(sid);
    expectRow(`e_${tag}_livepane`, sid, null, 1, `SessionEnd file ${tag}, live pane`);
    dropPanes();
  }

  // ---- /clear alias rows (K3a / A15)
  {
    const oldId = newId(); const newIdv = newId();
    resumeIdMap.set(oldId, newIdv); statusAlias.set(newIdv, oldId); // as detectResumedSession / expectClearFork set them
    writeStatus(newIdv, { status: 'active', event: 'SessionStart' });
    prime(newIdv);
    addPane(oldId); // the pane entry keeps the original id
    expectRow('c1_aliased_old_id', oldId, true, 0, 'ALIASED: old id, new id active, live pane holds old id');
    expectRow('c2_aliased_new_id', newIdv, true, 0, 'ALIASED: new id, same pane');
    dropPanes(); resumeIdMap.delete(oldId); statusAlias.delete(newIdv);
  }
  {
    const oldId = newId(); const newIdv = newId();
    writeRaw(oldId, '{"status":"closed","event":"SessionEnd"}\n');
    writeStatus(newIdv, { status: 'active', event: 'SessionStart' });
    prime(oldId); prime(newIdv);
    addPane(oldId); // a /clear typed in the terminal: nothing armed, no alias, no pane holds the new id
    expectRow('c3_notaliased_old_id', oldId, null, 1, 'NOT ALIASED: old id SessionEnd file');
    expectRow('c4_notaliased_new_id', newIdv, null, 0, 'NOT ALIASED: new id active, no pane holds it');
    dropPanes();
  }

  // ---- stale cache / table rows
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    prime(sid);
    writeStatus(sid, { status: 'closed', event: 'PtyExit' }); // another writer, the cache still says working
    expectRow('s1_ptyexit_beats_stale_busy_cache', sid, false, 1, 'cache primed working, PtyExit file, no pane');
    gate('s1b_no_cache_write', ss.statusCache.get(sid) === 'working', `statusCache after the call = ${ss.statusCache.get(sid)} (want working: no cache write)`);
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'idle', event: 'Stop' });
    prime(sid);
    addPane(sid);
    expectRow('s2_idle_live_pane', sid, true, 0, 'idle + live pane');
    dropPanes();
    expectRow('s3_idle_stop_nopane', sid, null, 0, 'idle (Stop), no pane (R4 case)');
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    prime(sid);
    addPane(sid);
    expectRow('s4_busy_cache_live_pane', sid, true, 0, 'cache working + live pane');
    dropPanes();
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' }, 6 * MIN); // ts and mtime 6 min back
    prime(sid);
    expectRow('s5_fossil_busy', sid, null, 1, 'working with ts and mtime 6 min back, no pane (R6 fossil)');
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    prime(sid);
    expectRow('s6_fresh_busy_nopane', sid, true, 1, 'working fresh, no pane');
  }
  {
    const sid = newId();
    prime(sid); // no file: cache 'closed'
    expectRow('s7_nofile_nopane', sid, null, 1, 'no status file, no pane');
    const sid3 = newId();
    prime(sid3);
    addPane(sid3);
    expectRow('s8b_nofile_live_pane', sid3, true, 1, 'no file + live pane (a fresh pane before its first hook write)');
    dropPanes();
    const sid4 = newId();
    prime(sid4);
    ptys.set('pane-dead', { proc: { pid: dead.pid }, sessionId: sid4, cwd: BASE });
    expectRow('s8c_dead_pid_nofile', sid4, null, 1, 'no file + pane holding a reaped pid');
    dropPanes();
  }
  {
    const sid = newId();
    writeRaw(sid, '{"status":"bogus"}\n');
    prime(sid);
    addPane(sid);
    expectRow('b1_bogus_live_pane', sid, true, 1, 'status "bogus" file + live pane (missing-file row)');
    dropPanes();
    expectRow('b2_bogus_nopane', sid, null, 1, 'status "bogus" file, no pane');
  }
  {
    const bad = [null, undefined, '', 42];
    const out = bad.map((v) => measure(v));
    gate('i1_invalid_ids', out.every((m) => m.value === null && m.reads === 0), `non-string/empty ids -> ${out.map((m) => `${String(m.value)}/${m.reads}`).join(' ')} (want null/0 each)`);
  }

  // ---- watcher rows (R7)
  ss.startStatusWatcher();
  await sleep(200);
  const waitEvents = async (n, ms = 3000) => {
    const t0 = Date.now();
    while ((global.__deckStatusEvents || 0) < n && Date.now() - t0 < ms) await sleep(10);
    return (global.__deckStatusEvents || 0) >= n;
  };
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    await waitEvents((global.__deckStatusEvents || 0) + 1); await sleep(100);
    prime(sid);
    const ev0 = global.__deckStatusEvents || 0;
    writeStatus(sid, { status: 'closed', event: 'PtyExit' }); // another writer, callback not yet fired (debounce 50 ms)
    expectRow('w1_ptyexit_before_callback', sid, false, 1, 'cache working, no pane, PtyExit written by another writer, before the callback');
    gate('w1b_callback_pending', (global.__deckStatusEvents || 0) === ev0, 'no watcher callback ran before the measured call');
    await waitEvents(ev0 + 1); await sleep(100);
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    await waitEvents((global.__deckStatusEvents || 0) + 1); await sleep(100);
    prime(sid);
    addPane(sid);
    const ev0 = global.__deckStatusEvents || 0;
    writeStatus(sid, { status: 'closed', event: 'PtyExit' });
    expectRow('w2_live_pane_before_callback', sid, true, 0, 'cache working + live pane, PtyExit written, before the callback');
    const got = await waitEvents(ev0 + 1); await sleep(100);
    gate('w2b_callback_ran', got, 'watcher callback ran (cache refreshed to closed)');
    expectRow('w2c_live_pane_after_callback', sid, false, 1, 'same sid after the callback (cache closed -> read PtyExit wins over the pane)');
    dropPanes();
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    await waitEvents((global.__deckStatusEvents || 0) + 1); await sleep(100);
    prime(sid);
    ss.markSessionClosed(sid);
    expectRow('w3_markSessionClosed_at_once', sid, false, 1, 'markSessionClosed -> false at once (cache set synchronously)');
    await sleep(300);
  }
  {
    const sid = newId();
    writeStatus(sid, { status: 'working', event: 'UserPromptSubmit' });
    await waitEvents((global.__deckStatusEvents || 0) + 1); await sleep(100);
    prime(sid);
    addPane(sid);
    const ev0 = global.__deckStatusEvents || 0;
    writeRaw(sid, '{"status":"closed","event":"SessionEnd"}\n');
    const got = await waitEvents(ev0 + 1); await sleep(100);
    gate('w4a_callback_ran', got, 'watcher callback ran after the SessionEnd write');
    expectRow('w4_sessionend_after_callback', sid, null, 1, 'cache working + live pane, SessionEnd file, after the callback');
    dropPanes();
  }

  try { live.kill('SIGKILL'); } catch (_) { /* already gone */ }
  const failCount = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(failed ? `VERDICT: FAIL (${failCount}/${results.length})` : `VERDICT: ALL GREEN (${results.length}/${results.length})`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.log(`FAIL harness - ${e && e.stack || e}`);
  console.log('VERDICT: FAIL (harness)');
  process.exit(2);
});
