// room-mirror-router-probe — headless validation of the router's mirror branch
// (plan step B2, contract § B): a main.jsonl record with `mirror:true` (written
// by the mirror mod for a SendMessage copy) is FEED-ONLY — archived + pushed to
// the room panel listener, never delivered to a pane, never bounced.
// A normal record keeps its full path (archive + deliver + feed).
// Isolates ~/.claude/rooms via CLAUDE_DECK_ROOMS_DIR; stub ptys capture writes.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'room-mirror-probe-'));
process.env.CLAUDE_DECK_ROOMS_DIR = TMP;
process.env.CLAUDE_DECK_STATUS_DIR = path.join(TMP, 'status');
process.env.CLAUDE_DECK_ROOM_SUBMIT_DELAY_MS = '20';
process.env.CLAUDE_DECK_ROOM_QUEUE_COOLDOWN_MS = '0';

const ROOM_FILE = path.join(TMP, 'main.jsonl');

const { ptys } = require('../src/main/state');
const rooms = require('../src/main/rooms');
const roomDb = require('../src/main/room-db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const captured = {}; // sessionId -> [pty writes]
const feed = []; // roomListener pushes

function fakePane(paneId, sessionId, cwd, label) {
  captured[sessionId] = [];
  const proc = { pid: 2000 + Object.keys(captured).length, write: (s) => captured[sessionId].push(s) };
  ptys.set(paneId, { proc, sessionId, cwd });
  rooms.registerRoomSession(sessionId, label, cwd);
}
function append(obj) { fs.appendFileSync(ROOM_FILE, `${JSON.stringify(obj)}\n`); }
const archived = (id) => roomDb.recent(0).find((m) => m.id === id);
const writesTotal = () => Object.values(captured).reduce((n, a) => n + a.length, 0);

let failures = 0;
function assert(name, cond) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!cond) failures += 1;
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

async function run() {
  fs.mkdirSync(TMP, { recursive: true });
  fakePane('p-a', A, '/home/user/backend', 'backend');
  fakePane('p-b', B, '/home/user/tnr', 'tnr');
  rooms.setRoomListener((m) => feed.push(m));
  rooms.startRoomRouter();
  await sleep(150);

  // Control: a normal record keeps archive + delivery + feed.
  append({ id: 'n1', ts: new Date().toISOString(), from: A, from_label: 'backend', to: 'tnr', text: 'normal-ping' });
  await sleep(300);
  assert('normal: delivered to the target pane', captured[B].join('').includes('normal-ping'));
  assert('normal: archived', !!archived('n1'));
  assert('normal: pushed to the feed', feed.some((m) => m.id === 'n1'));

  const writesBefore = writesTotal();
  const pendingBefore = (rooms._internals.pendingBySession.get(B) || []).length;

  // Mirror by label, by id prefix, broadcast, and to an unknown target: all feed-only.
  const mk = (id, to) => ({ id, ts: new Date().toISOString(), from: A, from_label: 'backend', to, text: `mirror-${id}`, mirror: true });
  append(mk('m1', 'tnr'));
  append(mk('m2', '22222222'));
  append(mk('m3', '*'));
  append(mk('m4', 'ghost'));
  await sleep(400);

  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    const row = archived(id);
    assert(`mirror ${id}: archived with its text`, !!row && row.text === `mirror-${id}`);
    assert(`mirror ${id}: emitted to the feed`, feed.some((m) => m.id === id && m.mirror === true));
  }
  assert('mirror: archive freezes the target label (id-prefix target)', (archived('m2') || {}).to_label === 'tnr');
  assert('mirror: zero pane writes (no delivery, no bounce)', writesTotal() === writesBefore);
  assert('mirror: sender pane untouched (no router notice)', captured[A].length === 0);
  assert('mirror: nothing queued for the target', (rooms._internals.pendingBySession.get(B) || []).length === pendingBefore);

  // A normal record AFTER mirrors still routes (the branch is additive).
  append({ id: 'n2', ts: new Date().toISOString(), from: A, from_label: 'backend', to: 'tnr', text: 'normal-after' });
  await sleep(300);
  assert('normal after mirror: delivered', captured[B].join('').includes('normal-after'));
  assert('normal after mirror: archived + fed', !!archived('n2') && feed.some((m) => m.id === 'n2'));

  // A normal record to an unknown target still bounces (bounce path unchanged).
  append({ id: 'n3', ts: new Date().toISOString(), from: A, from_label: 'backend', to: 'ghost', text: 'anyone?' });
  await sleep(300);
  assert('normal unknown target: still bounces to the sender', /undeliverable/.test(captured[A].join('')));

  process.stdout.write(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`}\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { process.stdout.write(`FAIL  probe crashed: ${e && e.stack ? e.stack : e}\n`); process.exit(1); });
