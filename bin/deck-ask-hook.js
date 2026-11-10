#!/usr/bin/env node
'use strict';
// deck-ask-hook.js - PreToolUse hook for AskUserQuestion (builtins only): `node deck-ask-hook.js ask <ASK_DIR>`.
// It hands the question to the deck through <ASK_DIR>/<id>.req.json and waits for <id>.ans.json. ONLY an explicit
// `answers` file yields stdout (an `allow` carrying the answers); every other path prints nothing and exits 0, so
// the CLI shows its native menu. It never writes a status file (the deck does) and never answers on its own.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STDIN_DEADLINE_MS = 2000;
const POLL_MS = 100;
const TIMEOUT_S = 86400; // the injected hook `timeout` (T): 24 h, the terminal's menu never expires either
const MAX_PIDS = 16;
const MARGIN_S = 10; // internal deadline = T - 10 s: the hook ends itself before the CLI kills it
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL = 'AskUserQuestion';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- pure helpers --------------------------------------------------------------------------------------------------

// Question texts of an AskUserQuestion input, or null when the shape is not usable.
function questionTexts(input) {
  if (!isObject(input) || !Array.isArray(input.questions) || input.questions.length === 0) return null;
  const texts = [];
  for (const q of input.questions) {
    if (!isObject(q) || typeof q.question !== 'string' || q.question === '') return null;
    texts.push(q.question);
  }
  return texts;
}

// File-name-safe request id: `tool_use_id` when it is path-safe, else `<sid>-<ts>-<rand>`.
function requestId(payload, ts, rand) {
  const tid = payload.tool_use_id;
  if (typeof tid === 'string' && ID_RE.test(tid)) return tid;
  const sid = String(payload.session_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'x';
  return `${sid}-${ts}-${rand}`;
}

// The request file content, or null when the stdin payload is not a routable AskUserQuestion call.
function buildRequest(payload, ts, rand, pids) {
  if (!isObject(payload) || payload.tool_name !== TOOL) return null;
  if (typeof payload.session_id !== 'string' || payload.session_id === '') return null;
  if (!questionTexts(payload.tool_input)) return null;
  const req = {
    v: 1, id: requestId(payload, ts, rand), kind: 'ask', sid: payload.session_id,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '', tool: TOOL, input: payload.tool_input, ts,
  };
  if (Array.isArray(pids) && pids.length > 0) req.pids = pids;
  return req;
}

// This hook's ancestor pids (parent first), from /proc on Linux; just the parent elsewhere. The deck matches them against
// its pane processes, so a question still reaches its pane after the session id changed (/clear typed in the terminal).
function ancestorPids() {
  const out = [];
  let pid = process.ppid;
  while (Number.isInteger(pid) && pid > 1 && out.length < MAX_PIDS && !out.includes(pid)) {
    out.push(pid);
    let next = 0;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      next = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[1]); // "pid (comm) state ppid ..."
    } catch (_) { /* no /proc or the process is gone */ }
    pid = next;
  }
  return out;
}

// Hook stdout for an answer file, or null (-> native menu). Strict: kind `answers`, every question answered with a
// non-empty string, no key that is not a question text. Anything else, `terminal` included, is null.
function answerOutput(input, ans) {
  const texts = questionTexts(input);
  if (!texts || !isObject(ans) || ans.kind !== 'answers' || !isObject(ans.answers)) return null;
  if (Object.keys(ans.answers).length !== new Set(texts).size) return null;
  const entries = [];
  for (const t of texts) {
    const v = Object.prototype.hasOwnProperty.call(ans.answers, t) ? ans.answers[t] : undefined;
    if (typeof v !== 'string' || v.trim() === '') return null;
    entries.push([t, v]);
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { questions: input.questions, answers: Object.fromEntries(entries) },
    },
  });
}

// ---- runtime -------------------------------------------------------------------------------------------------------

// The deck's pid from <dir>/deck.pid; 0 when missing or not a positive integer (kill(0, 0) would signal the group).
function readPid(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'deck.pid'), 'utf8').trim();
    return /^[0-9]{1,10}$/.test(raw) ? Number(raw) : 0;
  } catch (_) { return 0; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

// Internal deadline in ms; the env value is a probe seam that can only shorten it (never above T - 10 s).
function deadlineMs(env = process.env) {
  const n = Number(env.CLAUDE_DECK_ASK_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, (TIMEOUT_S - MARGIN_S) * 1000) : (TIMEOUT_S - MARGIN_S) * 1000;
}

// Whole stdin as text, or null when it does not end within the deadline (or errors).
function readStdin(deadlineMsValue) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let timer = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => finish(null), deadlineMsValue);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(null));
  });
}

async function runAsk(dir) {
  const files = []; // everything this hook may have written: unlinked on every exit
  let poll = null;
  let done = false;
  const finish = (out) => {
    if (done) return;
    done = true;
    clearInterval(poll);
    for (const f of files) { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } }
    if (out) process.stdout.write(`${out}\n`, () => process.exit(0));
    else process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish(null));
  process.on('uncaughtException', () => finish(null));
  try {
    if (!dir) return finish(null);
    const raw = await readStdin(STDIN_DEADLINE_MS);
    if (raw === null) return finish(null);
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return finish(null); }
    const ts = Date.now();
    const req = buildRequest(payload, ts, crypto.randomBytes(4).toString('hex'), ancestorPids());
    if (!req) return finish(null);
    const pid = readPid(dir);
    if (!pid || !pidAlive(pid)) return finish(null); // no deck: no request written, native menu at once
    const reqPath = path.join(dir, `${req.id}.req.json`);
    const ansPath = path.join(dir, `${req.id}.ans.json`);
    const tmpPath = path.join(dir, `${req.id}.req.tmp`); // never matches the watcher's `.req.json`
    files.push(reqPath, ansPath, tmpPath);
    try { fs.unlinkSync(ansPath); } catch (_) { /* a stale answer must never count */ }
    fs.writeFileSync(tmpPath, JSON.stringify(req), { mode: 0o600 });
    fs.renameSync(tmpPath, reqPath);
    const deadline = ts + deadlineMs();
    poll = setInterval(() => {
      try {
        let text = null;
        try { text = fs.readFileSync(ansPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return finish(null); }
        if (text !== null) {
          let ans;
          try { ans = JSON.parse(text); } catch (_) { return finish(null); }
          return finish(answerOutput(req.input, ans));
        }
        if (!pidAlive(pid) || Date.now() >= deadline) finish(null);
      } catch (_) { finish(null); }
    }, POLL_MS);
  } catch (_) { finish(null); }
}

function main(argv) {
  if (argv[0] === 'ask') return runAsk(argv[1]);
  // The `perm` mode was dropped (plan v4, option A: no PermissionRequest hook); an unknown mode never blocks the CLI.
  return process.exit(0);
}

module.exports._internals = { questionTexts, requestId, buildRequest, answerOutput, readPid, deadlineMs, ancestorPids };

if (require.main === module) main(process.argv.slice(2));
