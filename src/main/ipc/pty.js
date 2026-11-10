// claude-deck — ipc/pty: PTY lifecycle — one `claude` process per pane,
// indexed by paneId — plus the clipboard bridges (PRIMARY + CLIPBOARD).
'use strict';

const { app, ipcMain, clipboard } = require('electron');
const pty = require('node-pty');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { UUID_RE, CLAUDE_BIN, ROOM_BRIEFING, APP_ROOT } = require('../config');
const { resolveShellEnv } = require('../shell-env');
const { INJECT_SETTINGS, INJECTED_SETTINGS_JSON } = require('../settings-injection');
const { ptys, ptyOpening, sessionDirs, pendingNames, deckSpawnedIds, resumeIdMap, statusAlias } = require('../state');
const { send } = require('../window');
const { markSessionClosed, detectResumedSession, expectClearFork, readSessionEffort } = require('../session-status');
const { roomSpawnEnv, roomLabelFor, registerRoomSession, refreshRegistry } = require('../rooms');

// New-session launch options: validated here, the only trust point (the renderer's values are never
// trusted); an invalid one is dropped silently. Values measured on `claude --help`: --model takes an
// alias or a full id, --permission-mode a fixed choice list, --effort low|medium|high|xhigh|max
// (the composer's « auto » has no flag value, so it never reaches argv).
const LAUNCH_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const LAUNCH_MODEL_ID_RE = /^claude-[a-z0-9.-]{1,60}$/;
const LAUNCH_PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
const LAUNCH_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const LAUNCH_PROMPT_MAX_BYTES = 20 * 1024;

// -> { flags, tail }: flags go before the deck's own, tail (`-- <prompt>`) goes LAST. `--` keeps a prompt
// starting with `-` a prompt; it does not stop `claude -- mcp` from running the `mcp` subcommand, so a
// one-word prompt gets one trailing space (measured: `claude -- "mcp "` starts the REPL).
function launchOptions(opts) {
  const { model, permissionMode, effort, initialPrompt } = opts;
  const flags = [];
  if (typeof model === 'string' && (LAUNCH_MODEL_ALIASES.has(model) || LAUNCH_MODEL_ID_RE.test(model))) {
    flags.push('--model', model);
  }
  if (typeof permissionMode === 'string' && LAUNCH_PERMISSION_MODES.has(permissionMode)) {
    flags.push('--permission-mode', permissionMode);
  }
  if (typeof effort === 'string' && LAUNCH_EFFORTS.has(effort)) flags.push('--effort', effort);
  const tail = [];
  if (typeof initialPrompt === 'string') {
    const text = initialPrompt.trim();
    if (text && Buffer.byteLength(text, 'utf8') <= LAUNCH_PROMPT_MAX_BYTES) {
      tail.push('--', /\s/.test(text) ? text : `${text} `);
    }
  }
  return { flags, tail };
}

// --- Send trace (diagnostic only, DoD 5) --------------------------------------
// Records, per pane, (a) the child's bracketed-paste mode as announced by ITS
// OWN output (`\x1b[?2004h`/`l`) and (b) the shape of every submit-shaped INPUT
// write (paste+CR, lone CR, text+CR). Never the message text itself. Purely
// diagnostic: it changes no byte/timing of what reaches the PTY, and every I/O
// here is best-effort (a throwing fs must never block/throw into the PTY path).
// File lives under Electron's real userData dir (app.getPath resolved lazily —
// never at module load — so probes that `app.setPath('userData', tmpdir)`
// before opening a pane land the trace in their own throwaway dir).
const TRACE_FILE_NAME = 'send-trace.jsonl';
const TRACE_MAX_BYTES = 1024 * 1024; // rotate past 1 MB
const BRACKETED_MODE_RE = /\x1b\[\?2004([hl])/g;

function sendTraceFile() {
  return path.join(app.getPath('userData'), TRACE_FILE_NAME);
}

function writeTraceLine(obj) {
  try {
    const file = sendTraceFile();
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { size = 0; } // first write
    if (size > TRACE_MAX_BYTES) {
      try { fs.renameSync(file, `${file}.1`); } catch (_) { /* best effort rotation */ }
    }
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
  } catch (_) { /* trace must never block or throw into the PTY path */ }
}

// Bracketed-paste mode, tracked from the CHILD's OWN output (Claude Code emits
// ?2004h on raw-mode enter, ?2004l on exit). A sequence can straddle two `data`
// chunks, so a ≤7-char tail (one short of the 8-char sequence) is carried over:
// long enough to catch a split, short enough that a match can never be fully
// re-found inside the tail alone (it always needs ≥1 byte of the new chunk) ->
// no duplicate transition logged.
function trackBracketedMode(entry, paneId, data) {
  try {
    const combined = (entry.outTail || '') + data;
    BRACKETED_MODE_RE.lastIndex = 0;
    let m;
    while ((m = BRACKETED_MODE_RE.exec(combined))) {
      const bracketed = m[1] === 'h';
      const mode = bracketed ? 'on' : 'off';
      if (entry.bracketedMode !== mode) {
        entry.bracketedMode = mode;
        writeTraceLine({ ts: new Date().toISOString(), paneId, kind: 'mode', bracketed });
      }
    }
    entry.outTail = combined.slice(-7);
  } catch (_) { /* trace must never affect PTY data forwarding */ }
}

// Classifies a submit-shaped INPUT write; returns null for anything else
// (plain keystrokes are never logged).
function classifySubmitWrite(data) {
  if (data.indexOf('\x1b[200~') !== -1) return data.endsWith('\r') ? 'bracketed+cr' : 'bracketed-no-cr';
  if (data === '\r') return 'lone-cr';
  if (data.length > 1 && data.endsWith('\r')) return 'text+cr';
  return null;
}

// Count of '\r' inside the payload, excluding a single trailing one (the
// submit CR itself — the "extra CRs" a caller cares about are the ones INSIDE
// the message).
function countInnerCr(data) {
  let count = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === '\r') count++;
  if (data.endsWith('\r')) count -= 1;
  return Math.max(0, count);
}

// tag: optional caller-supplied marker (preload.js writeInput 3rd arg). Only
// the exact string 'retry-cr' paired with a lone '\r' payload yields kind
// 'retry-cr' (same len/lines/modeAtWrite fields, never text); any other tag
// value, or a tag on other data, is ignored and classifySubmitWrite decides
// the kind byte-identically to the untagged path.
function traceSubmitWrite(entry, paneId, data, tag) {
  try {
    const kind = (tag === 'retry-cr' && data === '\r') ? 'retry-cr' : classifySubmitWrite(data);
    if (!kind) return; // not submit-shaped -> not logged
    writeTraceLine({
      ts: new Date().toISOString(),
      paneId,
      kind,
      len: data.length,
      lines: countInnerCr(data),
      modeAtWrite: entry.bracketedMode || 'unknown',
    });
  } catch (_) { /* trace must never affect the PTY write */ }
}

// Retry-skip row: chat-view.js's retry poll reached its deadline without firing
// (scheduleRetryCheck). The renderer's payload is untrusted IPC input: EVERY
// field is validated here and anything else is dropped silently. Lengths and
// numbers only, never message text; `ts` is stamped here, never taken from the
// renderer. Same file and rotation as the other rows (writeTraceLine).
const RETRY_SKIP_GUARDS = new Set(['menu', 'box-hidden', 'box-empty', 'no-match', 'error']);
const intIn = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
function traceRetrySkip(p) {
  try {
    if (!p || typeof p !== 'object') return;
    const { paneId, guard, boxLen, rows, cols, elapsedMs } = p;
    if (typeof paneId !== 'string' || paneId.length < 1 || paneId.length > 32) return;
    if (typeof guard !== 'string' || !RETRY_SKIP_GUARDS.has(guard)) return;
    if (!intIn(boxLen, 0, 100000) || !intIn(rows, 1, 1000) || !intIn(cols, 1, 1000) || !intIn(elapsedMs, 0, 60000)) return;
    writeTraceLine({ ts: new Date().toISOString(), paneId, kind: 'retry-skip', guard, boxLen, rows, cols, elapsedMs });
  } catch (_) { /* trace must never throw into the IPC path */ }
}

// --- PTY output coalescer ---------------------------------------------------
// Each node-pty chunk used to be one `pty-data` IPC message plus one
// `term.write` in the renderer. A busy TUI redraws constantly, so bursts are
// merged per pane before they cross IPC. Rules (payload shape stays
// `{ paneId, data }`, bytes and order are never altered, only concatenated):
//   - leading edge: a pane that sent nothing in the last LEAD_MS forwards the
//     chunk at once, so typing echo stays instant;
//   - otherwise the chunk is appended to the pane's buffer, flushed by ONE
//     timer armed on the first buffered chunk (max delay = COALESCE_MS, not a
//     sliding debounce), or at once when the buffer exceeds MAX_BUF_CHARS;
//   - the buffer is always flushed BEFORE `pty-exit`, on pane close / kill and
//     in killAll, so nothing is lost or reordered.
// CLAUDE_DECK_PTY_COALESCE_MS overrides the flush delay (0 disables coalescing:
// every chunk is forwarded on its own, the historical behaviour).
const COALESCE_MS = (() => {
  const raw = process.env.CLAUDE_DECK_PTY_COALESCE_MS;
  if (raw === undefined || raw === '') return 8;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8;
})();
const LEAD_MS = 16;
const MAX_BUF_CHARS = 64 * 1024;

function flushPtyOut(entry) {
  if (entry.outTimer) { clearTimeout(entry.outTimer); entry.outTimer = null; }
  if (!entry.outBuf) return;
  const data = entry.outBuf;
  entry.outBuf = '';
  entry.lastSentAt = performance.now();
  send('pty-data', { paneId: entry.paneId, data });
}

function forwardPtyData(entry, data) {
  if (COALESCE_MS === 0) { send('pty-data', { paneId: entry.paneId, data }); return; }
  const now = performance.now();
  // Never overtake a pending buffer: leading edge only when nothing is queued.
  if (!entry.outBuf && now - entry.lastSentAt >= LEAD_MS) {
    entry.lastSentAt = now;
    send('pty-data', { paneId: entry.paneId, data });
    return;
  }
  entry.outBuf += data;
  if (entry.outBuf.length > MAX_BUF_CHARS) { flushPtyOut(entry); return; }
  if (!entry.outTimer) entry.outTimer = setTimeout(() => flushPtyOut(entry), COALESCE_MS);
}

function killAll() {
  for (const entry of ptys.values()) {
    flushPtyOut(entry);
    try { entry.proc.kill(); } catch (_) { /* already dead */ }
    // FIX #2: leave durable 'closed' markers — claude may not emit SessionEnd on SIGHUP.
    if (entry.sessionId) markSessionClosed(entry.sessionId);
  }
  ptys.clear();
}

function registerPtyIpc() {
  // The pane's chat subscribes in the same renderer task, just AHEAD of this call: ptyOpening tells its feed the spawn
  // time is still to come (it waits for it instead of judging a run recorded before the pane opened).
  ipcMain.handle('pty-open', async (_e, opts) => {
    const id = opts && opts.paneId;
    const marked = typeof id === 'string' && id !== '' && !ptys.has(id);
    if (marked) ptyOpening.add(id);
    try { return await openPty(opts); } finally { if (marked) ptyOpening.delete(id); }
  });
  async function openPty(opts) {
    const { paneId, cols, rows, resumeId } = opts || {};
    if (typeof paneId !== 'string' || !paneId || ptys.has(paneId)) {
      return { ok: false, error: 'invalid or duplicate paneId' };
    }

    // cwd must exist; resume only works from the session's original cwd.
    let cwd = typeof opts.cwd === 'string' ? opts.cwd : os.homedir();
    let cwdIsDir = false;
    try { cwdIsDir = fs.statSync(cwd).isDirectory(); } catch (_) { cwdIsDir = false; }
    if (!cwdIsDir) cwd = os.homedir();

    const args = [];
    let newSessionId = null;
    let pendingName = null;
    // The id handed to `--resume`: the renderer's opts.resumeId, validated.
    let launchResumeId = null;
    if (resumeId !== undefined && resumeId !== null) {
      if (typeof resumeId !== 'string' || !UUID_RE.test(resumeId)) {
        return { ok: false, error: 'invalid resumeId' };
      }
      launchResumeId = resumeId;
    }
    if (launchResumeId) {
      // Single-pane policy (defense in depth — the renderer guards first): a
      // second `claude --resume <id>` forks ANOTHER session id; both panes then
      // fight over the same sidebar row, and closing either marks it 'closed'
      // while the other still runs. Dead PID (ESRCH) = slot free (relaunch ok).
      for (const entry of ptys.values()) {
        if (entry.sessionId !== launchResumeId) continue;
        try { process.kill(entry.proc.pid, 0); } catch (_) { continue; }
        return { ok: false, error: 'session déjà ouverte dans un autre pane' };
      }
      // A closed pane's /clear or resume drift must not outlive it: this id stands for itself again.
      // Reopening the fork row B drops only its status alias: held->B stays in resumeIdMap, the id a later follow of A resumes.
      let dropped = false;
      const fork = resumeIdMap.get(launchResumeId);
      if (fork) { statusAlias.delete(fork); resumeIdMap.delete(launchResumeId); dropped = true; }
      const held = statusAlias.get(launchResumeId);
      if (held && ![...ptys.values()].some((e) => e.sessionId === held)) {
        statusAlias.delete(launchResumeId);
        dropped = true;
      }
      // The renderer subscribed before this spawn, so its level push followed the alias just dropped.
      if (dropped) send('session-effort', { sessionId: launchResumeId, level: readSessionEffort(launchResumeId) });
      args.push('--resume', launchResumeId);
    } else {
      // v28: creation-time name -> deck-chosen session id. v46.5: the id is
      // now fixed for UNNAMED creations too — the flag-less spawn left
      // pane.sessionId null, so the chat view stayed locked until the first
      // message (toggleChatView guards on identity). Same spawn path either
      // way; only the NAME stays optional.
      const chosenName = opts.newName;
      if (typeof chosenName === 'string' && chosenName.trim()) {
        pendingName = chosenName.trim().slice(0, 200);
      }
      newSessionId = crypto.randomUUID();
      deckSpawnedIds.add(newSessionId); // v46.9.5: never a resume-fork candidate
      args.push('--session-id', newSessionId);
    }

    // FIX #1: snapshot the project dir BEFORE spawning a resume, so the new
    // .jsonl (the forked session) can be detected afterwards.
    let resumeDir = null;
    let beforeSet = null;
    if (launchResumeId) {
      resumeDir = sessionDirs.get(launchResumeId) || null;
      if (resumeDir) {
        try {
          beforeSet = new Set((await fsp.readdir(resumeDir)).filter((f) => f.endsWith('.jsonl')));
        } catch (_) {
          resumeDir = null; // dir vanished -> keep hook-only behavior
        }
      }
    }

    // Launch options (first message, model, mode, effort): a NEW session only — a resume keeps its
    // own settings.
    const launch = !launchResumeId ? launchOptions(opts) : null;
    if (launch) args.push(...launch.flags);

    // Argv order: [--resume X | --session-id Y] [launch flags] [--settings] [--plugin-dir] [deck briefing] [launch tail].
    // --settings: the dedup-guarded JSON, gated by INJECT_SETTINGS (that gate is false for a wrapper binary).
    if (INJECT_SETTINGS) {
      args.push('--settings', INJECTED_SETTINGS_JSON);
      // Room mirror mod: copies each model SendMessage to the room feed. Never for a wrapper binary;
      // the --append-system-prompt below follows, so no variadic list can swallow this flag.
      args.push('--plugin-dir', path.join(APP_ROOT, 'mods', 'room-mirror'));
    }
    // Room awareness via the SYSTEM PROMPT (not a hook) — touches no hook set,
    // so it can never disturb the user's global hooks. Same INJECT_SETTINGS
    // gate (off for bash-probe spawns). The session learns the room exists +
    // the reply-in-room convention straight from its instructions.
    if (INJECT_SETTINGS) {
      args.push('--append-system-prompt', ROOM_BRIEFING);
    }
    if (launch) args.push(...launch.tail); // `-- <first message>`, the very last argv items
    global.__deckLastSpawnArgs = args.slice(); // probe seam (argv ground truth)

    // Spawn with the user's INTERACTIVE-shell env, not Electron's bare GUI env:
    // a desktop-launched deck never sourced ~/.bashrc, so the MCP tokens exported
    // from the shell rc would be absent and the MCP servers
    // `claude` forks would 401. resolveShellEnv() is memoized + fail-safe to
    // process.env, so this await is ~free after the first pane and never blocks
    // a spawn on shell trouble. (Pre-warmed at app startup in main.js.)
    const baseEnv = await resolveShellEnv();
    // Room identity: the deck already fixed this session's id (--session-id /
    // --resume), so the in-session `room` CLI can self-identify and peers can
    // address it. roomSpawnEnv CLONES baseEnv (memoized) — never mutate it, or
    // the ROOM_* of one session leaks onto every later spawn.
    const roomSessionId = launchResumeId || newSessionId || null;
    const roomLabel = pendingName || roomLabelFor(roomSessionId, cwd);
    const spawnEnv = roomSpawnEnv(baseEnv, roomSessionId, roomLabel);
    let proc;
    try {
      proc = pty.spawn(CLAUDE_BIN, args, {
        name: 'xterm-256color',
        cols: Number(cols) || 80,
        rows: Number(rows) || 24,
        cwd,
        env: spawnEnv,
      });
    } catch (err) {
      return { ok: false, error: `spawn failed: ${err.message}` };
    }

    // v39: cwd kept for the git panel — ALWAYS resolved main-side from this
    // registry (the renderer never supplies a path to run git in).
    // bracketedMode/outTail: send-trace state (DoD 5) — mode as announced by
    // the child's own output, unknown until its first ?2004h/l.
    // paneId/outBuf/outTimer/lastSentAt: output coalescer state (forwardPtyData).
    // spawnedAt: when this CLI process started (D-PB): an agent run older than it died with the previous process.
    const entry = {
      proc, sessionId: launchResumeId || newSessionId || null, cwd, spawnedAt: Date.now(),
      bracketedMode: 'unknown', outTail: '',
      paneId, outBuf: '', outTimer: null, lastSentAt: -Infinity,
    };
    ptys.set(paneId, entry);
    if (pendingName) pendingNames.set(newSessionId, pendingName); // after spawn success only
    registerRoomSession(roomSessionId, roomLabel, cwd); // room registry: now addressable by peers
    proc.onData((data) => {
      forwardPtyData(entry, data);
      trackBracketedMode(entry, paneId, data);
    });
    // Captured here because onExit's `entry` below shadows this one (and is
    // undefined after killAll cleared the registry).
    const ownEntry = entry;
    proc.onExit(({ exitCode }) => {
      flushPtyOut(ownEntry); // pending output always precedes pty-exit
      const entry = ptys.get(paneId);
      ptys.delete(paneId);
      send('pty-exit', { paneId, exitCode });
      // FIX #2: brutal deaths (kill -9, crash) emit no SessionEnd hook — mark
      // the session closed IMMEDIATELY, without waiting for any hook.
      if (entry && entry.sessionId) markSessionClosed(entry.sessionId);
      refreshRegistry(); // room registry: drop the dead session from `who`
    });
    if (resumeDir) detectResumedSession(launchResumeId, resumeDir, beforeSet);
    // v28: the renderer adopts the deck-chosen id (single-pane policy + row mapping); a resume
    // returns none (the renderer already holds that id).
    return { ok: true, cwd, sessionId: newSessionId || undefined };
  }

  // alacritty-style PRIMARY selection bridge (Linux): every xterm selection is
  // pushed to the X11 PRIMARY buffer. The paste half is native — Chromium
  // pastes PRIMARY on middle-click by itself. Fail-silent off-X11.
  ipcMain.on('primary-write', (_e, text) => {
    if (typeof text === 'string' && text) {
      try { clipboard.writeText(text, 'selection'); } catch (_) { /* no PRIMARY */ }
    }
  });
  // System CLIPBOARD bridge for the renderer's smart Ctrl+C/V handler.
  ipcMain.on('clipboard-write', (_e, text) => {
    if (typeof text === 'string' && text) {
      try { clipboard.writeText(text); } catch (_) { /* clipboard unavailable */ }
    }
  });
  ipcMain.handle('clipboard-read', () => {
    try { return clipboard.readText() || ''; } catch (_) { return ''; }
  });

  ipcMain.on('pty-input', (_e, { paneId, data, tag } = {}) => {
    const entry = ptys.get(paneId);
    if (entry && typeof data === 'string') {
      entry.proc.write(data); // bytes/timing to the PTY: unchanged by the trace below
      traceSubmitWrite(entry, paneId, data, tag);
    }
  });

  // Retry poll gave up (preload.js traceRetrySkip): send-only, no reply; the
  // validation and the trace write live in traceRetrySkip.
  ipcMain.on('send-trace-retry-skip', (_e, payload) => { traceRetrySkip(payload); });

  // v47.x /clear re-anchor: the chat's « /clear » button arms a pane-scoped,
  // one-shot adopter (session-status.js) BEFORE it pastes /clear, so the
  // clicking pane follows its fresh session while the L1 detector keeps
  // refusing the fork for every OTHER pane. All IO + arming lives main-side.
  ipcMain.on('pane-expect-clear', (_e, { paneId } = {}) => {
    expectClearFork(paneId);
  });

  ipcMain.on('pty-resize', (_e, { paneId, cols, rows } = {}) => {
    const entry = ptys.get(paneId);
    if (entry && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      try { entry.proc.resize(cols, rows); } catch (_) { /* race with exit */ }
    }
  });

  ipcMain.on('pty-kill', (_e, { paneId } = {}) => {
    const entry = ptys.get(paneId);
    if (entry) {
      flushPtyOut(entry);
      try { entry.proc.kill(); } catch (_) { /* already dead */ }
      // onExit fires on kill and handles ptys cleanup + markSessionClosed.
    }
  });
}

module.exports = { registerPtyIpc, killAll };
