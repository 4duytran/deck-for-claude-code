// room-mirror-probe — drives mods/room-mirror's `session.send` hook with a fake
// `$` (env / fs / process backed by a temp dir) and a fake `next`, as the
// engine would on a model SendMessage ({to:<name>, text, origin:{kind:'model'}}).
// Contract: docs/plans/room-native-transport.contract.md § B.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ENTRY = path.join(__dirname, '..', 'mods', 'room-mirror', 'hooks', 'register.mjs');
const A = '11111111-1111-1111-1111-111111111111'; // the sender (this session)
const B = '22222222-2222-2222-2222-222222222222'; // a room member, label "tnr"
const KEYS = ['from', 'from_label', 'id', 'mirror', 'text', 'to', 'ts'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let failures = 0;
function assert(name, cond, detail) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` :: ${detail}` : ''}\n`);
  if (!cond) failures += 1;
}

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `room-mirror-${tag}-`)); }

function writeRegistry(dir) {
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
    sessions: [
      { session_id: A, label: 'backend', cwd: '/x/backend', pty_pid: 1, alive: true, last_seen: 'x' },
      { session_id: B, label: 'tnr', cwd: '/x/tnr', pty_pid: 2, alive: true, last_seen: 'x' },
    ],
  }));
}

// The slice of `$` the mod may touch, backed by the real fs / a real child.
function fake$(env, { failProcess = false } = {}) {
  return {
    env: { get: async (n) => env[n] },
    fs: {
      read: async (p) => fs.readFileSync(p, 'utf8'),
      exists: async (p) => fs.existsSync(p),
      write: async (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); },
    },
    process: {
      run: async (argv, init = {}) => {
        if (failProcess) throw new Error('process.run blew up');
        const r = spawnSync(argv[0], argv.slice(1), { input: init.stdin == null ? '' : init.stdin, encoding: 'utf8' });
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    },
  };
}

async function loadHook() {
  const hooks = {};
  try {
    const mod = await import(pathToFileURL(ENTRY).href);
    mod.register((event, ...rest) => { hooks[event] = rest[rest.length - 1]; });
  } catch (err) {
    process.stdout.write(`note  mod not loadable: ${err.code || err.message}\n`);
  }
  return hooks['session.send'] || null;
}

// Fire one send; `next` records its calls and answers like the engine.
async function send(hook, $, e, nextResult = { isDelivered: true }) {
  const calls = [];
  const next = async (ev) => { calls.push(ev); return nextResult; };
  if (!hook) return { threw: new Error('no session.send hook registered'), calls, result: undefined };
  try { return { result: await hook($, e, next), calls, threw: null }; } catch (err) { return { threw: err, calls, result: undefined }; }
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function untouched(name, run, e, nextResult = { isDelivered: true }) {
  assert(`${name}: send went through once, event passed unchanged`, run.calls.length === 1 && run.calls[0] === e, `calls=${run.calls.length}`);
  assert(`${name}: hook answers exactly what next answered`, !run.threw && run.result === (run.calls.length ? run.result : undefined) && JSON.stringify(run.result) === JSON.stringify(nextResult),
    run.threw ? run.threw.message : JSON.stringify(run.result));
}

(async () => {
  const hook = await loadHook();
  assert('mod registers a session.send hook', typeof hook === 'function');

  // 1. room target by label -> exactly one exact-shape record, existing lines kept.
  {
    const dir = tmp('label');
    writeRegistry(dir);
    const roomFile = path.join(dir, 'main.jsonl');
    fs.writeFileSync(roomFile, `${JSON.stringify({ id: 'old', ts: 't', from: 'user', from_label: 'human', to: '*', text: 'earlier' })}\n`);
    const e = { to: 'tnr', text: 'ping\nsecond "line"', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), e);
    const recs = lines(roomFile);
    assert('room target (label): one new record appended after the existing one', recs.length === 2 && recs[0].id === 'old', `records=${recs.length}`);
    const r = recs[1] || {};
    assert('room target (label): exact key set', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(KEYS), Object.keys(r).join(','));
    assert('room target (label): from = ROOM_SESSION_ID, from_label = ROOM_LABEL', r.from === A && r.from_label === 'backend');
    assert('room target (label): to = target room id', r.to === B, String(r.to));
    assert('room target (label): text verbatim, mirror === true', r.text === e.text && r.mirror === true);
    assert('room target (label): id is a uuid, ts an ISO timestamp', UUID.test(String(r.id)) && new Date(r.ts).toISOString() === r.ts, `${r.id} ${r.ts}`);
    untouched('room target (label)', run, e);
  }

  // 2. room target by session id (any case), label falls back to the short id.
  {
    const dir = tmp('id');
    writeRegistry(dir);
    const e = { to: B.toUpperCase(), text: 'by id', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A }), e);
    const recs = lines(path.join(dir, 'main.jsonl'));
    assert('room target (id): one record, to = registry id, from_label = short id', recs.length === 1 && recs[0].to === B && recs[0].from_label === A.slice(0, 8), JSON.stringify(recs));
    untouched('room target (id)', run, e);
  }

  // 3. non-room target -> nothing written, send untouched.
  {
    const dir = tmp('non-room');
    writeRegistry(dir);
    const e = { to: 'some-subagent', text: 'not a room member', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), e);
    assert('non-room target: no record', lines(path.join(dir, 'main.jsonl')).length === 0);
    untouched('non-room target', run, e);
  }

  // 4. registry missing -> nothing written, send untouched.
  {
    const dir = tmp('no-registry');
    const e = { to: 'tnr', text: 'who is tnr', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), e);
    assert('registry missing: no record', lines(path.join(dir, 'main.jsonl')).length === 0);
    untouched('registry missing', run, e);
  }

  // 5. every error swallowed: process.run rejects / registry is garbage.
  {
    const dir = tmp('errors');
    writeRegistry(dir);
    const e = { to: 'tnr', text: 'x', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A }, { failProcess: true }), e);
    untouched('write error', run, e);
    fs.writeFileSync(path.join(dir, 'registry.json'), '{not json');
    const run2 = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A }), e);
    assert('garbage registry: no record', lines(path.join(dir, 'main.jsonl')).length === 0);
    untouched('garbage registry', run2, e);
  }

  // 6. no ROOM_SESSION_ID (not a deck session) -> no record.
  {
    const dir = tmp('no-self');
    writeRegistry(dir);
    const e = { to: 'tnr', text: 'x', origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir }), e);
    assert('no ROOM_SESSION_ID: no record', lines(path.join(dir, 'main.jsonl')).length === 0);
    untouched('no ROOM_SESSION_ID', run, e);
  }

  // 7. send not delivered -> not mirrored, result passed through.
  {
    const dir = tmp('refused');
    writeRegistry(dir);
    const e = { to: 'tnr', text: 'x', origin: { kind: 'model' } };
    const refused = { isDelivered: false, reason: 'no such recipient' };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A }), e, refused);
    assert('undelivered send: no record', lines(path.join(dir, 'main.jsonl')).length === 0);
    untouched('undelivered send', run, e, refused);
  }

  // 8. CLAUDE_DECK_ROOMS_DIR unset -> $HOME/.claude/rooms.
  {
    const home = tmp('home');
    const dir = path.join(home, '.claude', 'rooms');
    fs.mkdirSync(dir, { recursive: true });
    writeRegistry(dir);
    const e = { to: 'tnr', text: 'default dir', origin: { kind: 'model' } };
    await send(hook, fake$({ HOME: home, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), e);
    assert('default rooms dir ($HOME/.claude/rooms): one record', lines(path.join(dir, 'main.jsonl')).length === 1);
  }

  // 9. native names: Claude Code delivers only to its own session name (or the
  // uds: address of the session's pid), so memberOf must resolve both to the member.
  {
    const dir = tmp('native');
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
      sessions: [
        { session_id: A, label: 'backend', native_name: 'backend-x1', pty_pid: 4141, alive: true },
        { session_id: B, label: 'tnr', native_name: 'TNR-ab', pty_pid: 4242, alive: true },
        { session_id: '33333333-3333-3333-3333-333333333333', label: 'old', pty_pid: 4343, alive: true },
      ],
    }));
    const cases = [
      ['native_name (case-insensitive)', 'tnr-AB', B],
      ['uds address of the member pid', 'uds:/run/user/1000/cc-socks/4242.sock', B],
      ['label still wins', 'tnr', B],
      ['session_id still matches', B, B],
      ['uds address of an unknown pid', 'uds:/run/user/1000/cc-socks/9999.sock', null],
      ['uds suffix only (no pid boundary)', 'uds:/run/user/1000/cc-socks/14242.sock', null],
      ['unknown native name', 'nobody-zz', null],
    ];
    for (const [what, to, want] of cases) {
      const before = lines(path.join(dir, 'main.jsonl')).length;
      await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), { to, text: 'n', origin: { kind: 'model' } });
      const got = lines(path.join(dir, 'main.jsonl')).slice(before);
      assert(`native: ${what}`, want ? got.length === 1 && got[0].to === want : got.length === 0, JSON.stringify(got));
    }
  }

  // 10. collision: one session's label equals another's native name. A native
  // SendMessage reached the native name's owner only, so the record names it.
  {
    const dir = tmp('collision');
    const C = '33333333-3333-3333-3333-333333333333';
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
      sessions: [
        { session_id: A, label: 'backend', native_name: null, pty_pid: 4141, alive: true },
        { session_id: C, label: 'worker', native_name: null, pty_pid: 4343, alive: true },
        { session_id: B, label: 'tnr', native_name: 'worker', pty_pid: 4242, alive: true },
      ],
    }));
    const env = { CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' };
    await send(hook, fake$(env), { to: 'worker', text: 'who gets it', origin: { kind: 'model' } });
    const got = lines(path.join(dir, 'main.jsonl'));
    assert('collision: label of C vs native_name of B -> record names B (native name first)', got.length === 1 && got[0].to === B, JSON.stringify(got));
    await send(hook, fake$(env), { to: 'uds:/run/user/1000/cc-socks/4242.sock', text: 'by uds', origin: { kind: 'model' } });
    const got2 = lines(path.join(dir, 'main.jsonl'));
    assert('collision: uds address of B pid -> B', got2.length === 2 && got2[1].to === B, JSON.stringify(got2));
    await send(hook, fake$(env), { to: 'tnr', text: 'label fallback', origin: { kind: 'model' } });
    const got3 = lines(path.join(dir, 'main.jsonl'));
    assert('collision: a label no native name claims still falls back to the label', got3.length === 3 && got3[2].to === B, JSON.stringify(got3));
  }

  // 11. long text is capped like the pane path (ROOM_MAX_TEXT = 4000 chars), so the
  // JSON line stays under one tee chunk and parses as a single record.
  {
    const dir = tmp('cap');
    writeRegistry(dir);
    const text = 'abcdefghij'.repeat(2000);
    const e = { to: 'tnr', text, origin: { kind: 'model' } };
    const run = await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A, ROOM_LABEL: 'backend' }), e);
    const roomFile = path.join(dir, 'main.jsonl');
    let recs = [];
    try { recs = lines(roomFile); } catch (err) { assert('cap: the appended line parses', false, err.message); }
    assert('cap: 20000-char text -> one record', recs.length === 1, `records=${recs.length}`);
    assert('cap: text length is 4000 (first 4000 chars kept)', recs.length === 1 && recs[0].text.length === 4000 && recs[0].text === text.slice(0, 4000), recs[0] ? String(recs[0].text.length) : 'none');
    assert('cap: the line is under one 8192-byte tee chunk', fs.statSync(roomFile).size < 8192, String(fs.statSync(roomFile).size));
    assert('cap: the send itself still carries the full text', run.calls.length === 1 && run.calls[0].text === text);
    const exact = 'z'.repeat(4000);
    await send(hook, fake$({ CLAUDE_DECK_ROOMS_DIR: dir, ROOM_SESSION_ID: A }), { to: 'tnr', text: exact, origin: { kind: 'model' } });
    const recs2 = lines(roomFile);
    assert('cap: a 4000-char text is kept whole (boundary)', recs2.length === 2 && recs2[1].text === exact);
  }

  process.stdout.write(failures === 0 ? 'room-mirror-probe: ALL PASS\n' : `room-mirror-probe: ${failures} FAIL\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  process.stdout.write(`room-mirror-probe: CRASH ${err && err.stack}\n`);
  process.exit(2);
});
