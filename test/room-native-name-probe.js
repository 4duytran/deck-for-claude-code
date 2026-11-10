// room-native-name-probe — headless gate for the native-name registry logic of
// src/main/rooms.js (readNativeName / nativeNameOf / noteSessionStatus and the
// native_name field of writeRegistry). The room-mirror mod matches a model's
// SendMessage target against this field, so a wrong name routes a message to the
// wrong session (or to nobody).
// Seam: HOME points at a throwaway dir BEFORE rooms.js loads, so
// os.homedir()/.claude/sessions is a fixture; ROOMS_DIR/STATUS_DIR are isolated
// too. state.ptys is seeded with fake panes { sessionId, cwd, proc: { pid } }.
// Nothing here reads or writes the real ~/.claude.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'room-native-name-probe-'));
const HOME = path.join(TMP, 'home');
const SESS_DIR = path.join(HOME, '.claude', 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAUDE_DECK_ROOMS_DIR = path.join(TMP, 'rooms');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(TMP, 'status');

const { REGISTRY_FILE } = require('../src/main/config');
const { ptys } = require('../src/main/state');
const rooms = require('../src/main/rooms');

let failures = 0;
let total = 0;
function assert(name, cond) {
  total += 1;
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!cond) failures += 1;
}

const sessFile = (pid) => path.join(SESS_DIR, `${pid}.json`);
const putSess = (pid, obj) => fs.writeFileSync(sessFile(pid), typeof obj === 'string' ? obj : JSON.stringify(obj));
const seed = (paneId, sessionId, pid) => ptys.set(paneId, { proc: { pid }, sessionId, cwd: '/tmp/native-name-probe' });
const entry = (sid) => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  return (reg.sessions || []).find((s) => s.session_id === sid);
};
const nameIn = (sid) => { const e = entry(sid); return e ? e.native_name : undefined; };
const plantSentinel = () => fs.writeFileSync(REGISTRY_FILE, '{"sentinel":true}\n');
const sentinelKept = () => fs.readFileSync(REGISTRY_FILE, 'utf8').includes('"sentinel"');

const S = (n) => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;

// --- read: valid file, pid match -------------------------------------------
putSess(4242, { pid: 4242, name: '  alpha  ', sessionId: 'ignored' });
seed('p1', S(1), 4242);
rooms.writeRegistry();
assert('read: name read when json.pid === pid (and trimmed)', nameIn(S(1)) === 'alpha');
assert('read: only name is kept (no other field leaks into the entry)', !('sessionId' in entry(S(1))) && entry(S(1)).pty_pid === 4242);

// --- read: every null path -------------------------------------------------
putSess(4301, { pid: 9999, name: 'wrong-pid' });
seed('p2', S(2), 4301);
putSess(4302, { pid: 4302, name: '   ' });
seed('p3', S(3), 4302);
putSess(4303, { pid: 4303, name: 'x'.repeat(201) });
seed('p4', S(4), 4303);
seed('p5', S(5), 4304); // no file written for 4304
putSess(4305, { pid: 4305, name: 42 });
seed('p6', S(6), 4305);
putSess(4306, '{not json');
seed('p7', S(7), 4306);
putSess(4307, { pid: 4307, name: 'y'.repeat(200) });
seed('p8', S(8), 4307);
seed('p9', S(9), null); // pane without a pid
rooms.writeRegistry();
assert('null: json.pid does not match the pty pid', nameIn(S(2)) === null);
assert('null: empty (whitespace) name', nameIn(S(3)) === null);
assert('null: name longer than 200 chars', nameIn(S(4)) === null);
assert('null: session file missing', nameIn(S(5)) === null);
assert('null: non-string name', nameIn(S(6)) === null);
assert('null: unparsable session file', nameIn(S(7)) === null);
assert('keep: a 200-char name is accepted (boundary)', nameIn(S(8)) === 'y'.repeat(200));
assert('null: pane without a pid', nameIn(S(9)) === null);

// --- cache: kept while the pid is stable, dropped when the pid changes -----
putSess(4242, { pid: 4242, name: 'beta' }); // file moves under a cached entry
rooms.writeRegistry();
assert('cache: a known name for the same pid is not re-read', nameIn(S(1)) === 'alpha');

putSess(4250, { pid: 4250, name: 'gamma' });
seed('p1', S(1), 4250);
rooms.writeRegistry();
assert('cache: a new pid re-reads the name', nameIn(S(1)) === 'gamma');

seed('p1', S(1), 4251); // no file for 4251
rooms.writeRegistry();
assert('cache: a pid with no file gives null, not the old name', nameIn(S(1)) === null);

putSess(4250, { pid: 4250, name: 'gamma2' }); // back to a pid the cache once held: a stale entry would say gamma
seed('p1', S(1), 4250);
rooms.writeRegistry();
assert('cache: dropped when a pid yields no name (no stale name comes back)', nameIn(S(1)) === 'gamma2');

// --- cache: dropped when the session leaves ptys ---------------------------
putSess(4260, { pid: 4260, name: 'delta' });
seed('p10', S(10), 4260);
rooms.writeRegistry();
assert('leave: name read while live', nameIn(S(10)) === 'delta');
putSess(4260, { pid: 4260, name: 'epsilon' });
ptys.delete('p10');
rooms.writeRegistry();
assert('leave: a session that left ptys is not in the registry', entry(S(10)) === undefined);
seed('p10', S(10), 4260);
rooms.writeRegistry();
assert('leave: cache dropped when the session left (fresh read on return)', nameIn(S(10)) === 'epsilon');

// --- noteSessionStatus: rewrite only while the name is unknown and live ----
seed('p20', S(20), 4270); // live, no file yet
rooms.writeRegistry();
assert('note: unknown name before the file exists', nameIn(S(20)) === null);
putSess(4270, { pid: 4270, name: 'zeta' });
plantSentinel();
rooms.noteSessionStatus(S(20));
assert('note: live session with unknown name rewrites the registry', !sentinelKept() && nameIn(S(20)) === 'zeta');

plantSentinel();
rooms.noteSessionStatus(S(20));
assert('note: known name does not rewrite the registry', sentinelKept());

seed('p21', S(21), 4280); // live, file never appears
rooms.writeRegistry();
plantSentinel();
rooms.noteSessionStatus(S(21));
assert('note: still-unknown name rewrites again (retry on each status event)', !sentinelKept() && nameIn(S(21)) === null);
plantSentinel();
rooms.noteSessionStatus(S(21));
assert('note: ... and again on the next event', !sentinelKept());

putSess(4290, { pid: 4290, name: 'eta' });
plantSentinel();
rooms.noteSessionStatus(S(22)); // never in ptys
assert('note: a session that is not live does not rewrite', sentinelKept());
rooms.noteSessionStatus('');
rooms.noteSessionStatus(undefined);
assert('note: an empty/undefined session id does not rewrite', sentinelKept());

// --- noteSessionStatus: a /rename with the same pid ------------------------
seed('p30', S(30), 4400);
putSess(4400, { pid: 4400, name: 'before' });
rooms.writeRegistry();
assert('rename: initial name read', nameIn(S(30)) === 'before');
putSess(4400, { pid: 4400, name: 'after' });
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: same pid, new name in the file -> registry shows the new name', !sentinelKept() && nameIn(S(30)) === 'after');
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: unchanged name -> no registry rewrite', sentinelKept());
rooms.writeRegistry();
assert('rename: the new name is the cached one for later rewrites', nameIn(S(30)) === 'after');
putSess(4400, { pid: 4400, name: '   ' });
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: name cleared in the file -> registry drops it', !sentinelKept() && nameIn(S(30)) === null);
putSess(4400, { pid: 4400, name: 'back' });
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: a name set again after a clear is picked up', !sentinelKept() && nameIn(S(30)) === 'back');
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: ... and then stable again', sentinelKept());
putSess(4400, { pid: 7777, name: 'forged' });
plantSentinel();
rooms.noteSessionStatus(S(30));
assert('rename: json.pid guard holds on the status path (foreign pid in the file -> name dropped)', !sentinelKept() && nameIn(S(30)) === null);
putSess(4401, { pid: 4401, name: 'ok' });
seed('p31', S(31), 4401);
rooms.writeRegistry();
assert('rename: a second session starts with its name', nameIn(S(31)) === 'ok');
putSess(4401, { pid: 4401, name: 'z'.repeat(201) });
plantSentinel();
rooms.noteSessionStatus(S(31));
assert('rename: a too-long new name is refused on the status path (200-char cap)', !sentinelKept() && nameIn(S(31)) === null);

process.stdout.write(`\n${failures === 0 ? `VERDICT: ALL GREEN (${total}/${total})` : `VERDICT: ${failures} FAILED (${total - failures}/${total})`}\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
process.exit(failures === 0 ? 0 : 1);
