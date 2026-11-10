// claude-deck — ipc/ask: main side of the ask channel (hook <-> main <-> renderer).
//
// bin/deck-ask-hook.js drops <id>.req.json in ASK_DIR (a question from
// AskUserQuestion) and polls <id>.ans.json. Main watches the dir, routes each
// request to its pane with paneOfSession(sid), pushes it to the renderer
// (`ask-request`), validates the renderer's answer (`ask-answer`) and writes the
// answer file itself.
//
// Fallback rule (hard): a request main cannot route or validate (any kind but
// `ask` included) gets {kind:'terminal'} written back at once and is never
// pushed, so the native TUI shows it.
//
// The channel is a factory over injected deps (dir, resolve, send): registerAskIpc
// / startAskWatcher wire the real ones lazily, so _internals loads in plain node.
'use strict';

const fs = require('fs');
const path = require('path');
const { ASK_DIR } = require('../config');

const REQ_SUFFIX = '.req.json';
const ANS_SUFFIX = '.ans.json';
const PID_NAME = 'deck.pid';
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_REQ_BYTES = 1024 * 1024; // hard cap on a request file; over it -> terminal
const MAX_ANSWER_CHARS = 16000;
const MAX_QUESTIONS = 16;
const STALE_MS = 86400 * 1000; // the hook's injected timeout T (24 h): older leftovers have no hook waiting any more
const MAX_PIDS = 16;
const POLL_MS = 2000; // stat-only safety net under fs.watch
const OWNER_FRESH_MS = 10 * 1000; // a live foreign deck.pid younger than this owns the channel (5 polls)

const bad = (reason) => ({ ok: false, reason });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Shape check of a request file's text. Payload strings (input, questions) are
// data and stay verbatim; only identity fields are bounded.
function validateRequest(text, expectId) {
  if (typeof text !== 'string') return bad('malformed');
  if (Buffer.byteLength(text) > MAX_REQ_BYTES) return bad('oversize');
  let req;
  try { req = JSON.parse(text); } catch (_) { return bad('malformed'); }
  if (!isObj(req)) return bad('shape');
  if (req.v !== 1) return bad('version');
  if (req.kind !== 'ask') return bad('kind');
  if (typeof req.id !== 'string' || !ID_RE.test(req.id)) return bad('id');
  if (expectId !== undefined && req.id !== expectId) return bad('id-mismatch');
  if (!shortStr(req.sid, 200)) return bad('sid');
  if (!shortStr(req.tool, 200)) return bad('tool');
  if (req.cwd !== undefined && (typeof req.cwd !== 'string' || req.cwd.length > 4096)) return bad('cwd');
  if (!isObj(req.input)) return bad('input');
  if (req.ts !== undefined && !Number.isFinite(req.ts)) return bad('ts');
  if (req.pids !== undefined && !(Array.isArray(req.pids) && req.pids.length <= MAX_PIDS
    && req.pids.every((n) => Number.isInteger(n) && n > 1))) return bad('pids');
  const qs = req.input.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > MAX_QUESTIONS) return bad('questions');
  if (!qs.every((q) => isObj(q) && shortStr(q.question, 10000))) return bad('questions');
  return { ok: true, req };
}

// Validates a renderer answer against its request and returns the answer file
// to write. Unknown fields are refused.
function validateAnswer(req, a) {
  if (!isObj(a)) return bad('shape');
  const only = (...keys) => Object.keys(a).every((k) => keys.includes(k));
  if (a.kind === 'terminal') {
    return only('kind') ? { ok: true, file: { kind: 'terminal' } } : bad('fields');
  }
  if (a.kind === 'answers') {
    if (!only('kind', 'answers') || !isObj(a.answers)) return bad('answers');
    const texts = new Set(req.input.questions.map((q) => q.question));
    const keys = Object.keys(a.answers);
    if (keys.length !== texts.size || !keys.every((k) => texts.has(k))) return bad('answers-keys');
    const answers = {};
    for (const k of keys) {
      const v = a.answers[k];
      if (typeof v !== 'string' || v.length < 1 || v.length > MAX_ANSWER_CHARS) return bad('answers-value');
      // defineProperty: a question text such as "__proto__" stays plain data
      Object.defineProperty(answers, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return { ok: true, file: { kind: 'answers', answers } };
  }
  return bad('kind');
}

// Validation + routing of one request text. `resolve(sid, req)` is paneOfSession, then the hook's ancestor pids.
function classify(text, resolve, expectId) {
  const v = validateRequest(text, expectId);
  if (!v.ok) return { route: 'terminal', reason: v.reason };
  const pane = resolve(v.req.sid, v.req);
  if (!pane || !pane.paneId) return { route: 'terminal', reason: 'unroutable', req: v.req };
  return { route: 'push', req: v.req, paneId: pane.paneId };
}

function pushPayload(req, paneId) {
  return { id: req.id, kind: req.kind, paneId, tool: req.tool, input: req.input, cwd: req.cwd, ts: req.ts };
}

function createChannel({ dir, resolve, send, now = Date.now, markWaiting = () => null, markGone = () => false }) {
  // id -> { id, req, paneId, sid, state, ticket }; state: pending | answered | refused | closed
  const entries = new Map();
  let watcher = null;
  let pollTimer = null;
  let standbyTimer = null;
  let debounce = null;
  const logged = new Set();
  const logOnce = (key, msg) => { if (!logged.has(key)) { logged.add(key); console.error(msg); } };

  const reqFile = (id) => path.join(dir, id + REQ_SUFFIX);

  // Atomic (tmp + rename) and only while the req file exists; a write that lost
  // the race with the hook's exit is taken back.
  function writeAnswer(id, obj) {
    const ans = path.join(dir, id + ANS_SUFFIX);
    const tmp = path.join(dir, `.${id}.${process.pid}.ans.tmp`);
    try {
      if (!fs.existsSync(reqFile(id))) return false;
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, ans);
      if (fs.existsSync(reqFile(id))) return true;
      fs.unlinkSync(ans);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) { /* not there */ }
    }
    return false;
  }

  function refuse(id, reason) {
    entries.set(id, { id, state: 'refused' });
    writeAnswer(id, { kind: 'terminal' });
    logOnce('refuse:' + reason, `deck-ask: request refused (${reason}) -> terminal`);
  }

  function handleNew(id) {
    let text = null;
    try {
      const st = fs.lstatSync(reqFile(id));
      if (!st.isFile()) return;
      if (st.size > MAX_REQ_BYTES) return refuse(id, 'oversize');
      text = fs.readFileSync(reqFile(id), 'utf8');
    } catch (_) { return; } // vanished or unreadable: retried by the next scan
    const c = classify(text, resolve, id);
    if (c.route === 'terminal') return refuse(id, c.reason);
    const e = { id, req: c.req, paneId: c.paneId, sid: c.req.sid, state: 'pending', ticket: null };
    entries.set(id, e);
    send('ask-request', pushPayload(c.req, c.paneId));
    try {
      e.ticket = markWaiting(e.sid);
      if (e.ticket) rank.set(e.ticket, ++ranks);
    } catch (_) { /* the sidebar status is a nicety */ }
  }

  function paneStillHere(e) {
    const p = resolve(e.sid, e.req);
    return !!p && p.paneId === e.paneId;
  }

  // Highest seenAt wins; the arrival rank settles a same-millisecond tie.
  const rank = new WeakMap();
  let ranks = 0;
  const newer = (a, b) => (a.seenAt !== b.seenAt ? a.seenAt > b.seenAt : (rank.get(a) || 0) > (rank.get(b) || 0));

  // The question is over: give back the status the sidebar held before it. While another ask of
  // the same session is pending the status stays waiting: the newest ticket (highest seenAt)
  // moves to it and only the last one restores. `last` (stop) releases everything.
  function release(e, last) {
    const t = e.ticket;
    if (!t) return;
    e.ticket = null;
    try {
      const heir = last ? null : [...entries.values()].find((o) => o !== e && o.sid === e.sid && o.state === 'pending');
      if (heir) {
        const keep = heir.ticket && !newer(t, heir.ticket) ? heir.ticket : t;
        const drop = keep === t ? heir.ticket : t;
        heir.ticket = keep;
        if (drop) drop.cancel();
        return;
      }
      t.cancel(); markGone(e.sid, t.seenAt);
    } catch (_) { /* best effort */ }
  }

  function scan() {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    const present = new Set();
    for (const name of names) {
      if (!name.endsWith(REQ_SUFFIX)) continue;
      const id = name.slice(0, -REQ_SUFFIX.length);
      if (!ID_RE.test(id)) continue; // never build a path from a hostile file name
      present.add(id);
      if (!entries.has(id)) handleNew(id);
    }
    for (const [id, e] of entries) {
      if (!present.has(id)) {
        entries.delete(id);
        if (e.state === 'pending' || e.state === 'answered') send('ask-closed', { id });
        release(e);
      } else if (e.state === 'pending' && !paneStillHere(e)) {
        e.state = 'closed'; // pane gone: drop the card, let the TUI have the request
        send('ask-closed', { id });
        writeAnswer(id, { kind: 'terminal' });
        release(e);
      }
    }
  }

  const pidFile = () => path.join(dir, PID_NAME);
  function writePid() {
    const tmp = path.join(dir, `.${PID_NAME}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, String(process.pid), { mode: 0o600 });
    fs.renameSync(tmp, pidFile());
  }
  function clearPid() {
    try {
      if (fs.readFileSync(pidFile(), 'utf8') === String(process.pid)) fs.unlinkSync(pidFile());
    } catch (_) { /* none or not ours */ }
  }
  // deck.pid is the hook's proof that the deck is alive, and the ownership claim
  // between decks: its mtime is the owner's heartbeat (refreshed by every poll).
  // An owner is FRESH when its pid is alive and the file is at most OWNER_FRESH_MS old.
  function readOwner() {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile(), 'utf8'), 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, ageMs: now() - fs.statSync(pidFile()).mtimeMs };
    } catch (_) { return null; }
  }
  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  }
  const ownerFresh = (o) => !!o && pidAlive(o.pid) && Math.abs(o.ageMs) <= OWNER_FRESH_MS;
  // Another process (not another channel of this one) holds the claim.
  function foreignOwnerFresh() {
    const o = readOwner();
    return !!o && o.pid !== process.pid && ownerFresh(o);
  }
  function touchPid() {
    const d = new Date(now());
    try { fs.utimesSync(pidFile(), d, d); } catch (_) { writePid(); }
  }

  // Active poll: put deck.pid back when it is missing, unreadable, names a dead process or
  // has gone stale; refresh the heartbeat when it is ours; a fresh foreign owner is left alone.
  const safeScan = () => {
    try {
      const o = readOwner();
      if (!ownerFresh(o)) writePid();
      else if (o.pid === process.pid) touchPid();
    } catch (err) { logOnce('pid', 'deck-ask: deck.pid rewrite failed: ' + err.message); }
    try { scan(); } catch (err) { logOnce('scan', 'deck-ask: scan failed: ' + err.message); }
  };

  function answer(id, a) {
    try {
      const e = typeof id === 'string' ? entries.get(id) : undefined;
      if (!e || e.state !== 'pending') return { ok: false };
      const v = validateAnswer(e.req, a);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (!writeAnswer(id, v.file)) return { ok: false };
      e.state = 'answered'; // the hook unlinks its req on exit -> ask-closed
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }

  function pruneStale() {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    const cutoff = now() - STALE_MS;
    for (const name of names) {
      if (!(name.endsWith(REQ_SUFFIX) || name.endsWith(ANS_SUFFIX) || name.endsWith('.tmp'))) continue;
      const f = path.join(dir, name);
      try { if (fs.lstatSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch (_) { /* gone */ }
    }
  }

  function stop() {
    clearTimeout(debounce);
    clearInterval(pollTimer);
    clearInterval(standbyTimer);
    pollTimer = null;
    standbyTimer = null;
    if (watcher) { try { watcher.close(); } catch (_) { /* closed */ } watcher = null; }
    for (const e of entries.values()) release(e, true);
    clearPid();
  }

  // deck.pid is written LAST, so a half-started channel never claims to be alive
  // (the hook would wait out its deadline instead of falling back to the TUI).
  function activate() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneStale();
    watcher = fs.watch(dir, { persistent: false }, (_ev, filename) => {
      if (filename && !filename.endsWith(REQ_SUFFIX)) return;
      clearTimeout(debounce);
      debounce = setTimeout(safeScan, 20);
    });
    watcher.on('error', (err) => logOnce('watch', 'deck-ask watcher error: ' + err.message));
    pollTimer = setInterval(safeScan, POLL_MS);
    pollTimer.unref();
    scan(); // leftovers younger than T: no pane yet -> answered terminal
    writePid();
    process.once('exit', clearPid);
  }

  // Standby: a live deck owns the channel. Nothing is watched, answered or written
  // (an unseamed probe instance must never answer the live deck's questions); the
  // owner is looked at again every POLL_MS and the channel takes over once it is
  // gone or stale.
  function standbyCheck() {
    try {
      if (foreignOwnerFresh()) return;
      clearInterval(standbyTimer);
      standbyTimer = null;
      activate();
    } catch (err) {
      logOnce('start', 'deck-ask watcher unavailable: ' + err.message);
      try { stop(); } catch (_) { /* best effort */ }
    }
  }

  // Fail-safe: any error is logged once and the deck runs without the channel.
  function start() {
    try {
      if (foreignOwnerFresh()) {
        standbyTimer = setInterval(standbyCheck, POLL_MS);
        standbyTimer.unref();
        logOnce('standby', 'deck-ask: another deck owns the channel; standing by');
        return true;
      }
      activate();
      return true;
    } catch (err) {
      logOnce('start', 'deck-ask watcher unavailable: ' + err.message);
      try { stop(); } catch (_) { /* best effort */ }
      return false;
    }
  }

  return { start, stop, scan, poll: safeScan, answer, entries, standby: () => standbyTimer !== null };
}

let channel = null;
function getChannel() {
  if (!channel) {
    channel = createChannel({
      dir: ASK_DIR,
      // lazy: keeps electron and the session graph out of plain-node asserts
      // the session id first (itself, resume / clear aliases); else the pane whose process is a hook ancestor
      resolve: (sid, req) => {
        const ss = require('../session-status');
        return ss.paneOfSession(sid) || ss.paneOfPids(req && req.pids);
      },
      send: (ch, payload) => require('../window').send(ch, payload),
      markWaiting: (sid) => require('../session-status').markAskWaiting(sid),
      markGone: (sid, seenAt) => require('../session-status').markMenuGone(sid, seenAt),
    });
  }
  return channel;
}

function registerAskIpc() {
  const { ipcMain } = require('electron');
  ipcMain.handle('ask-answer', (_e, id, a) => getChannel().answer(id, a));
}

function startAskWatcher() {
  try {
    getChannel().start();
  } catch (err) {
    console.error('deck-ask watcher unavailable:', err.message);
  }
}

module.exports = {
  registerAskIpc,
  startAskWatcher,
  _internals: {
    validateRequest, validateAnswer, classify, createChannel,
    MAX_REQ_BYTES, STALE_MS, OWNER_FRESH_MS,
  },
};
