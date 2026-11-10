// claude-deck — rooms: the inter-session "room" router. Live Claude sessions
// (and the human) post one JSON line per message to ROOM_FILE via the bin/room
// CLI (or the deck's room panel); the deck watches that file and writes the
// rendered message straight into the TARGET pane's pty — waking even an idle
// session sitting at its prompt. The deck is the natural router: it already
// owns every pane's pty master (state.ptys) and fixed each session id at spawn.
//
// Design contract (mirrors session-status.js conventions):
//   - never crash the deck over a room nicety (every fs op is best-effort);
//   - local-only — everything lives under ~/.claude/rooms, no network;
//   - no backlog re-injection on (re)start — the cursor begins at current EOF
//     (acceptance criterion 4);
//   - echo-guard — a '*' broadcast never returns to its sender;
//   - bounce, never drop — an undeliverable directed message gets a visible
//     router reply addressed back to its sender.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  ROOMS_DIR, ROOM_FILE, REGISTRY_FILE, SESSIONS_FILE, LEAD_FILE, ROOM_MAX_TEXT, ROOM_SUBMIT_DELAY_MS, ROOM_HUMAN_LABEL, DECK_BIN_DIR, UUID_RE,
  STATUS_DIR, LIVE_STATUSES, ROOM_QUEUE_MAX, ROOM_QUEUE_DRAIN_COOLDOWN_MS,
} = require('./config');
const { ptys, sessionDirs, resumeIdMap } = require('./state');
const roomDb = require('./room-db'); // persistent message archive (single-writer = this router)

// sessionId -> { label, cwd } — the deck-known display label for a session.
// A live session's label comes from its creation name (when the user named it)
// or a cwd+shortid fallback; the registry joins this with state.ptys (the
// liveness truth) so a stale entry here is harmless (only live ptys are listed).
const roomLabels = new Map();

// Optional live-feed listener, wired by ipc/room.js -> send('room-append', msg)
// for the deck's own room panel. Kept as a plain callback so rooms.js never
// requires window.js/electron (the headless probe loads this module directly).
let roomListener = null;
function setRoomListener(fn) { roomListener = typeof fn === 'function' ? fn : null; }

// Optional control listener, wired by ipc/room.js -> send('room-control', rec)
// so the RENDERER (which owns pane creation) can act on a `room spawn`/`resume`
// control record. Same plain-callback decoupling as roomListener (rooms.js
// never requires electron; the headless probe loads this module directly).
let controlListener = null;
function setControlListener(fn) { controlListener = typeof fn === 'function' ? fn : null; }

const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : '?');

// Fallback label when a session was never given a creation name.
function roomLabelFor(sessionId, cwd) {
  const base = cwd ? path.basename(cwd) : '';
  return `${base || 'session'}-${shortId(sessionId)}`;
}

// Resolve a party id (from OR to) to the deck's CANONICAL display name via
// roomLabels — the router-owned map seeded at spawn/resume (registerRoomSession)
// and refined by the deck's session summary (setRoomLabel, which only touches an
// already-seeded id). It is NEVER pruned on pane close, so a peer that goes
// offline WITHIN a deck run still resolves; across a deck restart an id never
// reopened has no entry and falls back to the short id. Resolving HERE (not in
// the renderer, which only sees LIVE sessions) is what lets an offline-same-run
// peer still render "<name> (<shortid>)". Null for the specials the panel names
// itself ('*' broadcast / 'user' human / 'router' bounce) and for an unknown id.
function resolveToLabel(to) {
  if (typeof to !== 'string' || !to || to === '*' || to === 'user' || to === 'router') return null;
  // Exact id hit (full UUID) — the common, unambiguous case.
  if (UUID_RE.test(to)) {
    const info = roomLabels.get(to);
    if (info && info.label) return info.label;
  }
  // Short-id / prefix handle (`room send --to 96ae8e1f`): roomLabels is keyed by
  // the FULL session id, so match the FIRST registered session whose id starts
  // with the handle. Unlike resolveTargets (which REFUSES to guess on ≥2 prefix
  // matches, since a misroute is harmful), this picks the first — the stakes are
  // display-only (a label, never a delivery), and an 8-hex collision between two
  // live sessions is astronomically rare. (A full UUID has dashes, so it never
  // falls into this hex-only branch — no accidental cross-match with a full id.)
  if (/^[0-9a-f]{6,}$/i.test(to)) {
    for (const [sid, info] of roomLabels) {
      if (sid.startsWith(to) && info && info.label) return info.label;
    }
  }
  return null;
}

// True when `label` is the SPAWN-TIME fallback for `id` — roomLabelFor's
// `${basename(cwd)}-${shortId}` shape, frozen into ROOM_LABEL before the deck
// computed the pane's real summary name. Such a label should yield to the
// canonical roomLabels name at display time; an explicit sender `--label` (which
// does not end in `-<shortid>`) is preserved.
function isFallbackLabel(label, id) {
  return typeof label === 'string' && typeof id === 'string'
    && label.endsWith(`-${shortId(id)}`);
}

// The display name for a message's SENDER: the deck's canonical roomLabels name
// when the stored from_label is absent or the spawn-time fallback shape, else the
// stored label verbatim (an explicit --label is preserved). Null only when there
// is no name at all. SHARED by relabelMessage (the panel feed) AND render() (the
// injected [Room - Claude - …] tag delivered into a target session), so both
// surfaces show the SAME name instead of diverging (panel fixed, tag stale).
function canonicalFromLabel(msg) {
  const canonical = resolveToLabel(msg.from);
  if (canonical && (msg.from_label == null || isFallbackLabel(msg.from_label, msg.from))) return canonical;
  return msg.from_label != null ? msg.from_label : null;
}

// Re-stamp a routed/archived message's display labels against the deck's CURRENT
// canonical names. The archived from_label is often the sender's spawn-time
// fallback (workspace-<shortid>, frozen before the deck named the pane) and a
// short-id `to` may carry no frozen to_label at all — so both existing and new
// rows end up as "<real name> (<shortid>)" regardless of peer liveness. Only
// overrides a NULL or fallback from_label (an explicit --label is kept) and only
// FILLS a null to_label (a frozen real name like a full-UUID target is kept).
// Pure over roomLabels — electron-free, so ipc/room.js maps the feed through it
// and the headless probe can seed roomLabels and assert the output directly.
function relabelMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  const fromReal = canonicalFromLabel(m);
  if (fromReal != null) out.from_label = fromReal;
  const toReal = resolveToLabel(m.to);
  if (toReal && m.to_label == null) out.to_label = toReal;
  return out;
}

// Build the per-session env patch applied at spawn. CLONES the (memoized)
// base env — NEVER mutates it, or the ROOM_* of one session would leak onto
// every later spawn. APPENDS the shipped bin/ to PATH (not prepend): `room`
// still resolves (no other `room` binary exists), but the repo-local bin/ never
// SHADOWS the user's real tools (git/node/claude/...) inside a session.
function roomSpawnEnv(baseEnv, sessionId, label) {
  const env = { ...baseEnv };
  if (sessionId) env.ROOM_SESSION_ID = sessionId;
  if (label) env.ROOM_LABEL = label;
  const sep = path.delimiter;
  env.PATH = baseEnv && baseEnv.PATH ? `${baseEnv.PATH}${sep}${DECK_BIN_DIR}` : DECK_BIN_DIR;
  return env;
}

// Claude Code's own name for a session (field `name` of ~/.claude/sessions/<pid>.json,
// pid = the pane's claude process). A native SendMessage is delivered ONLY to that
// name (or to the pid's uds: address), never to the room label, so the registry
// carries it for the room-mirror mod. Only pids the deck spawned are read, only
// `name` is kept. The file appears after the spawn and a /rename can change it under
// the same pid: a registry rewrite trusts the cached name, and each status event of the
// session (noteSessionStatus) re-reads the file and rewrites the registry only when
// the name differs from the cached one (or was unknown).
const NATIVE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const nativeNames = new Map(); // sessionId -> { pid, name }

function readNativeName(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(NATIVE_SESSIONS_DIR, `${pid}.json`), 'utf8'));
    if (!j || j.pid !== pid || typeof j.name !== 'string') return null;
    const name = j.name.trim();
    return name && name.length <= 200 ? name : null;
  } catch (_) { return null; }
}

function nativeNameOf(sessionId, pid) {
  const known = nativeNames.get(sessionId);
  if (known && known.pid === pid) return known.name;
  const name = readNativeName(pid);
  if (name) nativeNames.set(sessionId, { pid, name });
  else nativeNames.delete(sessionId);
  return name;
}

// Status-event trigger (session-status.js watcher): re-reads the live session's
// name file (one small read); the registry is rewritten only when the name is
// unknown or differs from the cached one, the cache being dropped so the rewrite
// takes the fresh name.
function noteSessionStatus(sessionId) {
  if (!sessionId) return;
  for (const entry of ptys.values()) {
    if (entry.sessionId !== sessionId) continue;
    const pid = (entry.proc && entry.proc.pid) || null;
    const known = nativeNames.get(sessionId);
    if (known && known.pid === pid && readNativeName(pid) === known.name) return;
    nativeNames.delete(sessionId);
    writeRegistry();
    return;
  }
}

// Atomic (tmp+rename) snapshot of who is live, for the CLI's label resolution
// and `room who`. Source of truth for liveness is state.ptys; roomLabels only
// supplies the display label.
function writeRegistry() {
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const seen = new Set();
    const sessions = [];
    for (const entry of ptys.values()) {
      if (!entry.sessionId || seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      const info = roomLabels.get(entry.sessionId);
      const pid = (entry.proc && entry.proc.pid) || null;
      sessions.push({
        session_id: entry.sessionId,
        label: (info && info.label) || roomLabelFor(entry.sessionId, entry.cwd),
        native_name: nativeNameOf(entry.sessionId, pid),
        cwd: entry.cwd || null,
        pty_pid: pid,
        alive: true,
        last_seen: new Date().toISOString(),
      });
    }
    for (const id of nativeNames.keys()) if (!seen.has(id)) nativeNames.delete(id);
    const tmp = `${REGISTRY_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`);
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (_) { /* registry is a convenience; never crash a spawn over it */ }
}

// Called by ipc/pty.js right after a successful spawn — record the label and
// refresh the registry so the new session is immediately resolvable by peers.
function registerRoomSession(sessionId, label, cwd) {
  if (sessionId) roomLabels.set(sessionId, { label: label || roomLabelFor(sessionId, cwd), cwd });
  writeRegistry();
}

// Called on pane exit — state.ptys has already dropped the dead pane, so a
// plain rebuild reflects the new live set.
function refreshRegistry() {
  writeRegistry();
}

// Atomic snapshot of the FULL sidebar session list (live + idle), written from
// the canonical `sessions-list` scan (ipc/sessions.js) so it never diverges
// from what the sidebar shows — lineage dedup, title resolution and ordering
// are already applied by the time `groups` reaches here. Powers the CLI's
// `room sessions`.
//
// `live` is computed HERE from the row's reconciled sidebar `status` (the scan
// runs reconcileOpenPanes first), NOT CLI-side from registry.json membership.
// Why: a RESUMED session's live pty registers under its ORIGINAL id, but the
// scan's lineage-dedup keeps the FORKED (newId) row — so a registry-vs-snapshot
// id intersect would mislabel a live resumed session as idle (and a resume of
// that newId would double-fork past the single-pane guard). The status field is
// read under the forked id via resumeIdMap, so `status !== 'closed'` = "has an
// open pane" holds for resumes too. (`closed` is the only no-pane status:
// session-status.js writes it on PtyExit and as the never-opened default.)
//
// `file` is the canonical .jsonl path (latest fork), letting `room sessions
// --summary <id>` tail-read a specific session. Best-effort: a snapshot miss
// never breaks a sidebar refresh.
// -> true when the file was written (tmp + rename), false otherwise (never throws).
function writeSessionsFile(groups) {
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const sessions = [];
    for (const group of groups) {
      for (const s of (group.sessions || [])) {
        const dir = sessionDirs.get(s.sessionId);
        const row = {
          session_id: s.sessionId,
          label: s.summary || s.sessionId,
          cwd: group.cwd || null,
          file: dir ? path.join(dir, `${s.sessionId}.jsonl`) : null,
          mtime: s.mtimeMs || 0,
          status: s.status || null,
          live: s.status !== 'closed', // open pane (reconciled, resume-safe)
        };
        sessions.push(row);
      }
    }
    const doc = { updated: new Date().toISOString(), sessions };
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    fs.renameSync(tmp, SESSIONS_FILE);
    return true;
  } catch (_) {
    return false; // snapshot is a convenience; never crash a refresh over it
  }
}

function writeSessionsSnapshot(groups) {
  return writeSessionsFile(Array.isArray(groups) ? groups : []);
}

// Update a session's DISPLAY name. The sidebar scan (ipc/sessions.js) feeds the
// deck's computed session summary here, so the room shows the SAME names as the
// deck sidebar instead of a bare cwd+shortid fallback — the registry/panel can
// then be told apart, while routing still uses the precise session id.
function setRoomLabel(sessionId, label) {
  if (!sessionId || !label) return;
  const prev = roomLabels.get(sessionId);
  if (!prev) return; // only refresh sessions the deck registered (bounds the map; the sidebar scans ALL history)
  if (prev.label === label) return; // no-op (avoid needless registry churn)
  roomLabels.set(sessionId, { ...prev, label });
}

// ---------------------------------------------------------------------------
// Delivery.
// ---------------------------------------------------------------------------

// A single delivered message must validate the target's input box EXACTLY
// ONCE — so every embedded CR/LF is flattened to a visible glyph (a stray CR
// mid-text would submit early / split the line). The SUBMITTING CR is NOT glued
// here: deliver() sends it as a separate, delayed keystroke (see submitToPane).
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n|\r|\n/g, ' ⏎ ')
    .slice(0, ROOM_MAX_TEXT);
}

// Cap the (file-controlled) display name embedded in the injected tag prefix so
// a long session summary can't flood the target's input box.
const TAG_NAME_MAX = 40;

// Provenance tag so the receiver knows WHO sent it and that it came via the
// ROOM (not a direct chat/terminal message) -> it must reply with `room send`,
// not a normal answer. [Room - <human>] = the human; [Room - Claude - <name>
// (<shortid>)] = a peer session — the shortid is the PRECISE reply handle
// (`room send --to <shortid>`), since the name alone can collide; [Room - router]
// = a delivery bounce.
function render(msg) {
  let tag;
  if (msg.from === 'router') tag = 'Room - router';
  else if (msg.from === 'user') tag = `Room - ${String(msg.from_label || ROOM_HUMAN_LABEL).slice(0, TAG_NAME_MAX)}`;
  else {
    // Prefer the deck's canonical name over the sender's spawn-time fallback
    // from_label (same rule as the panel via canonicalFromLabel), so the injected
    // tag reads "test-2 (9c69e356)" not "workspace-9c69e356 (9c69e356)". An
    // explicit --label is preserved; an unknown sender falls back to the short id.
    const name = String(canonicalFromLabel(msg) || shortId(msg.from)).slice(0, TAG_NAME_MAX);
    tag = `Room - Claude - ${name} (${shortId(msg.from)})`;
  }
  // Text ONLY — no trailing CR. The submit CR is sent separately by deliver()
  // (submitToPane), or a glued "text\r" is swallowed by the target TUI's
  // paste-coalescing and the message never sends.
  return `[${tag}] ${sanitize(msg.text)}`;
}

// Map of sessionId -> live pty entry (first pane found for a session).
function liveBySession() {
  const live = new Map();
  for (const entry of ptys.values()) {
    if (entry.sessionId && !live.has(entry.sessionId)) live.set(entry.sessionId, entry);
  }
  return live;
}

// Resolve a `to` field (session id | label | '*') to the set of live target
// session ids, applying the echo-guard (never the sender).
function resolveTargets(to, fromId, live = liveBySession()) {
  if (to === '*') return [...live.keys()].filter((id) => id !== fromId);
  // A UUID is an EXPLICIT target — self-addressing by one's own id is a
  // deliberate act (unlike a '*' broadcast or a label that happens to be
  // self), so this branch intentionally does NOT apply the echo-guard.
  if (typeof to === 'string' && UUID_RE.test(to)) return live.has(to) ? [to] : [];
  // Short-id PREFIX (the `(xxxxxxxx)` handle shown in a [Room - Claude - …] tag):
  // a hex string that UNIQUELY prefixes one live session id routes precisely.
  // An ambiguous prefix (≥2 live matches) returns [] -> a bounce, NEVER a wrong
  // target (this is what makes Claude->Claude replies safe to mis-name).
  if (typeof to === 'string' && /^[0-9a-f]{6,}$/i.test(to)) {
    const lc = to.toLowerCase();
    const pref = [...live.keys()].filter((id) => id !== fromId && id.toLowerCase().startsWith(lc));
    if (pref.length === 1) return pref;
    if (pref.length > 1) return []; // ambiguous -> bounce, don't guess
    // 0 matches -> fall through to a label match
  }
  const want = String(to == null ? '' : to).toLowerCase();
  if (!want) return [];
  return [...live.keys()].filter((id) => {
    if (id === fromId) return false; // a directed label-message never loops to self
    const info = roomLabels.get(id);
    const label = (info && info.label) || roomLabelFor(id, (live.get(id) || {}).cwd);
    return label.toLowerCase() === want;
  });
}

function appendLine(obj) {
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    fs.appendFileSync(ROOM_FILE, `${JSON.stringify(obj)}\n`);
  } catch (_) { /* best effort */ }
}

// A router notice to a specific session (a bounce, or a queue-overflow refusal).
// Goes through the same room-file append + delivery path as any message — so a
// notice to a BUSY sender now waits in that sender's queue too, instead of being
// typed into its busy TUI and lost.
function routerNotice(toId, text) {
  appendLine({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'router',
    from_label: 'router',
    to: toId,
    text,
  });
}

// Undeliverable directed message -> a visible router reply to its sender (no
// silent drop). Never bounce a bounce (from 'router') or a sender-less line.
function bounce(msg) {
  if (!msg.from || msg.from === 'router') return;
  routerNotice(msg.from, `undeliverable: "${msg.to}" — no live session`);
}

// ---------------------------------------------------------------------------
// Busy-aware delivery queue.
//
// A message addressed to a target whose Claude is MID-TURN is NOT typed into its
// pty: that TUI is not at its input box, so the keystrokes are lost / interleave
// with the live screen (the reported bug — a peer's message vanished while the
// target worked). Such a message waits in a per-session FIFO and is injected on
// the target's NEXT return to idle, one per turn (each injected message starts a
// new turn, so firing the whole queue at once would re-lose 2..N). This mirrors
// the chat-mode composer queue (chat-view.js sendMessage/drainQueue) and reuses
// the SAME busy set (LIVE_STATUSES === chat-view BUSY_STATUSES). An idle, or
// fresh-at-prompt ('active'), target still receives in the same tick, so the
// room keeps waking a session sitting idle.
//
// rooms.js must stay electron-free (the headless probe loads it directly), so it
// reads the hook status FILE itself rather than requiring session-status.js
// (which pulls window.js -> electron). Same best-effort JSON read; resumeIdMap
// maps a resumed session's row id to its forked status file, exactly as
// session-status.isSessionBusy does.
const pendingBySession = new Map();    // sessionId -> [{ msg }] FIFO, awaiting idle
const optimisticBusyUntil = new Map(); // sessionId -> ts; post-injection settle gap

// A busy status FILE untouched this long is a FOSSIL — the session died without
// firing SessionEnd (crash, reboot), leaving 'working' frozen on disk. Mirrors
// the deck's own STALE_BUSY_MS (src/main/ipc/transcript.js) so the room's busy
// view never diverges from the deck's: without it a queued message would starve
// forever behind a dead session's stale 'working' (rooms.js can't require those
// modules — they pull electron).
const ROOM_STALE_BUSY_MS = 5 * 60 * 1000;

function readStatusEntry(effectiveId) {
  try {
    const file = path.join(STATUS_DIR, `${effectiveId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.status === 'string') {
      let mtimeMs = null; // the status hook touches the file on a subagent's tool events
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { /* ts-only age */ }
      return { status: data.status, ts: typeof data.ts === 'string' ? data.ts : null, mtimeMs };
    }
  } catch (_) { /* missing/malformed -> not busy (deliver now / wake) */ }
  return { status: null, ts: null, mtimeMs: null };
}

// True iff the target's Claude is actively in a turn (so a message must queue).
// idle / active (fresh) / closed / no-file all read false -> deliver now. A LIVE
// status whose file went stale is a fossil -> also false (never starve the queue
// behind a dead session), matching session-status.js's fossil downgrade.
function sessionMidTurn(sessionId) {
  const { status, ts, mtimeMs } = readStatusEntry(resumeIdMap.get(sessionId) || sessionId);
  if (!LIVE_STATUSES.has(status)) return false;
  // Age = freshest of ts and file mtime — same rule as session-status.js statusAgeMs (a foreground
  // subagent's tool events only touch the mtime; this module cannot require that one: electron).
  const stamps = [Date.parse(ts), mtimeMs].filter(Number.isFinite);
  return stamps.length > 0 && Date.now() - Math.max(...stamps) <= ROOM_STALE_BUSY_MS;
}

function enqueuePending(id, msg) {
  let q = pendingBySession.get(id);
  if (!q) { q = []; pendingBySession.set(id, q); }
  if (q.length >= ROOM_QUEUE_MAX) {
    // Bound the queue — never grow without limit. The accepted backlog stays in
    // order and drains; the overflowing message is refused with a visible notice
    // to its sender (a '*' broadcast just drops — broadcasts never bounce).
    if (msg.to !== '*' && msg.from && msg.from !== 'router') {
      routerNotice(msg.from, `target "${msg.to}" busy — room queue full (${ROOM_QUEUE_MAX}); message not delivered, resend later`);
    }
    return;
  }
  q.push({ msg });
  global.__deckRoomQueued = (global.__deckRoomQueued || 0) + 1; // probe seam
  return true; // accepted (a refusal above returns undefined)
}

// A room message is never typed blindly into a target: it goes into that
// target's queue, then drainPending() injects it iff the target is idle (or
// fresh at its prompt). So an idle target still receives in this SAME tick; a
// mid-turn target's message waits, in order, for its next return to idle.
function deliver(msg) {
  const live = liveBySession();
  const targetIds = resolveTargets(msg.to, msg.from, live);
  if (!targetIds.length) {
    // A '*' broadcast with no other live session is simply a no-op (not an
    // error). Only a DIRECTED message to a missing target bounces.
    if (msg.to !== '*') bounce(msg);
    return;
  }
  for (const id of targetIds) enqueuePending(id, msg);
  drainPending(live); // idle targets receive now; mid-turn ones keep waiting
}

// Per-pane submit queue: sessionId -> the tail Promise of that pane's serialized
// delivery chain. A settled, no-longer-tail chain deletes itself, so the map
// stays bounded by panes with an in-flight submit.
const submitChains = new Map();

// Type the message into the target pane, THEN submit it with a SEPARATE, delayed
// CR. A single "text\r" write is read by the target Claude TUI as one pasted
// chunk and the trailing CR is treated as a literal newline inside the input box
// (the message lands but never sends — the reported bug). Writing the CR on its
// own, after a short settle (ROOM_SUBMIT_DELAY_MS), lands it as a discrete Enter
// keystroke past the TUI's paste-coalescing window, so the message submits.
//
// SERIALIZED PER PANE: two messages landing in one drain() batch would otherwise
// be written text1,text2,CR,CR — and the same paste-coalescing that this fix
// relies on would then MERGE text1+text2 into one input box and submit the blob.
// So each pane's deliveries are chained: a message's text is not written until
// the previous message to that pane has fired its CR. Different panes are
// independent (a lead broadcasting to N workers still fans out concurrently).
function submitToPane(id, proc, text) {
  if (!proc || typeof proc.write !== 'function') return;
  const prev = submitChains.get(id) || Promise.resolve();
  const next = prev.then(() => new Promise((resolve) => {
    try { proc.write(text); } catch (_) { return resolve(); /* pane exited before the text landed */ }
    setTimeout(() => {
      try { proc.write('\r'); } catch (_) { /* pane exited before the submit */ }
      resolve();
    }, ROOM_SUBMIT_DELAY_MS);
  }));
  submitChains.set(id, next);
  next.finally(() => { if (submitChains.get(id) === next) submitChains.delete(id); });
  return next; // resolves once this message's CR write attempt has run
}

// Inject ONE queued message into every target that is now idle. Called after
// each new room message (so idle targets receive immediately) AND on the safety
// interval (so a target that FINISHES its turn drains even with no new message
// to nudge it). One delivery per target per pass + the optimistic settle window
// = one message per return-to-idle, never a burst into a freshly-busy TUI.
function drainPending(live = liveBySession()) {
  try {
    const now = Date.now();
    // GC expired settle windows for sessions with nothing queued (bounds the map).
    for (const [id, until] of optimisticBusyUntil) {
      if (now >= until && !pendingBySession.has(id)) optimisticBusyUntil.delete(id);
    }
    for (const [id, q] of pendingBySession) {
      if (!q.length) { pendingBySession.delete(id); continue; }
      const entry = live.get(id);
      if (!entry) {
        // Target vanished while its messages waited -> bounce each back to its
        // sender (honour "bounce, never drop"); a '*' broadcast just drops.
        for (const { msg } of q) if (msg.to !== '*') bounce(msg);
        pendingBySession.delete(id);
        optimisticBusyUntil.delete(id);
        continue;
      }
      if (now < (optimisticBusyUntil.get(id) || 0)) continue; // just injected — settling
      if (sessionMidTurn(id)) continue;                       // still working — wait for idle
      const { msg } = q.shift();
      global.__deckRoomDelivered = (global.__deckRoomDelivered || 0) + 1; // probe seam
      submitToPane(id, entry.proc, render(msg));
      // The injected message starts a new turn; hold the next one until the hook
      // catches up to 'working' (optimistic, like chat-view drainQueue).
      optimisticBusyUntil.set(id, now + ROOM_QUEUE_DRAIN_COOLDOWN_MS);
      if (!q.length) pendingBySession.delete(id);
    }
  } catch (_) { /* never crash the deck over a room delivery (mirrors drain()) */ }
}

// Single-lead enforcement (server-side truth). The CLI gate is advisory — a
// session can append a {type:'control'} line straight to main.jsonl via Bash,
// bypassing `room`. So the deck is where the lock actually bites: it reads the
// lead lock and honours a spawn/resume ONLY from the live lead (or, when no
// lead is live, from anyone — the bootstrap case). The lead's session is live
// iff it holds a pty (liveBySession) — the same truth `room who` reports.
// FAIL-OPEN: any read/parse error returns null (= no lead) so a lock-file
// hiccup never blocks the deck's lifecycle path.
function currentLiveLead() {
  let raw;
  try {
    raw = fs.readFileSync(LEAD_FILE, 'utf8');
  } catch (e) {
    // ENOENT is the NORMAL no-lock case (silent). Any OTHER read error means a
    // lock file exists but we can't read it -> enforcement fails OPEN, which we
    // make OBSERVABLE (F4) instead of silently disabling the gate for everyone.
    if (e && e.code !== 'ENOENT') {
      try { console.warn(`[room] lead lock unreadable (${e.code}) -> enforcement fail-open`); } catch (_) { /* noop */ }
    }
    return null;
  }
  try {
    const lock = JSON.parse(raw);
    const id = lock && typeof lock.session_id === 'string' ? lock.session_id : null;
    if (!id) return null;
    return liveBySession().has(id) ? id : null; // a dead lead's lock is stale
  } catch (_) {
    // Lock exists but is corrupt -> fail-open, but log so a silent disable is
    // visible (honest writers are atomic tmp+rename, so this is anomalous).
    try { console.warn('[room] lead lock corrupt (JSON parse failed) -> enforcement fail-open'); } catch (_) { /* noop */ }
    return null;
  }
}

// A {type:'control'} record drives the deck's SESSION LIFECYCLE (spawn/resume)
// instead of being delivered into a pty: the deck owns pane creation in the
// renderer, so a well-formed control record is forwarded there (controlListener
// -> send('room-control')). Malformed/unknown actions are ignored (the watcher
// must never crash over a bad line).
function handleControl(msg) {
  const ok = (msg.action === 'spawn' && typeof msg.name === 'string' && msg.name.trim())
    || (msg.action === 'resume' && typeof msg.session_id === 'string' && UUID_RE.test(msg.session_id));
  if (!ok || !controlListener) return;
  // Reject ANY lifecycle control that is not from the live lead while a lead is
  // active: only that lead may spawn/resume. We deliberately do NOT carve out a
  // non-UUID `from` (an earlier version did, to "let the human through") — that
  // carve-out was a hole: a rival session runs `env -u ROOM_SESSION_ID room
  // spawn`, its `from` becomes 'user' (non-UUID), and it slipped past. The human
  // never reaches THIS path via its '+' button (that calls openPane directly,
  // not a control record) — so the button is unaffected. But a human OR an
  // env-unset rival using the room CLI both emit from:'user'; they are gated
  // identically (here, and CLI-side in requireLead). No live lead -> anyone may
  // act (bootstrap; the first orchestrator claims the lock CLI-side).
  //
  // NOTE (threat model): this stops ACCIDENTAL double-lead and casual bypass. It
  // is NOT a security boundary against a malicious same-user session, which can
  // forge lead.json directly or spoof `--from <leadId>` (and, per the deck's own
  // design, edit settings/hooks for arbitrary exec). That isolation is out of
  // scope for a same-uid file lock.
  const lead = currentLiveLead();
  if (lead && msg.from !== lead) {
    // Visible rejection back to the rival's pane (router notice, same delivery
    // path as a bounce) so it learns it was blocked — never a silent drop. Only
    // a routable string `from` gets a notice; a malformed/absent `from` is just
    // dropped (still rejected, nowhere to reply).
    if (typeof msg.from === 'string' && msg.from) {
      appendLine({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        from: 'router',
        from_label: 'router',
        to: msg.from,
        text: `refused: ${msg.action} — lead role held by ${shortId(lead)}; only the lead can spawn/resume (one lead at a time). Ask the human to reassign, or wait for that lead to close.`,
      });
    }
    if (roomListener) { try { roomListener(msg); } catch (_) { /* audit feed only */ } }
    return;
  }
  try { controlListener(msg); } catch (_) { /* never crash the watcher over a UI push */ }
}

function processLine(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; } // skip malformed line
  if (!msg || typeof msg !== 'object') return;
  // Control records (spawn/resume) take a separate path: lifecycle, not delivery.
  if (msg.type === 'control') {
    handleControl(msg);
    if (roomListener) { try { roomListener(msg); } catch (_) { /* audit feed only */ } }
    return;
  }
  if (typeof msg.to !== 'string' || typeof msg.text !== 'string') return;
  // Freeze the target's label onto the message (symmetric with from_label) so the
  // archive AND the live feed both carry it — the panel then shows the target as
  // "<label> (<shortid>)" instead of a raw id. Set only when absent (never clobber
  // an upstream value). Inert downstream: deliver()/render() key off msg.to/from.
  if (msg.to_label == null) { const tl = resolveToLabel(msg.to); if (tl != null) msg.to_label = tl; }
  // Archive every valid routed message (incl. router bounces, which re-enter as
  // their own lines) into the durable SQLite store BEFORE delivery, so the panel
  // history survives a main.jsonl truncate/restart. Best-effort, never throws.
  roomDb.archive(msg);
  // A mirror record is a SendMessage copy written by the mirror mod (the native
  // transport already delivered it): feed-only — archived and shown in the panel,
  // never delivered, never bounced, no bus event.
  if (msg.mirror !== true) deliver(msg);
  // Live feed for the deck's room panel (every valid line, bounces included).
  if (roomListener) {
    try { roomListener(msg); } catch (_) { /* never crash the watcher over a UI push */ }
  }
}

// ---------------------------------------------------------------------------
// Watcher.
// ---------------------------------------------------------------------------

let cursor = 0;        // byte offset already processed
let draining = false;

function drain() {
  if (draining) return;
  draining = true;
  try {
    let size;
    try { size = fs.statSync(ROOM_FILE).size; } catch (_) { return; }
    if (size < cursor) cursor = size; // file truncated/rotated -> skip to new EOF (never re-inject)
    if (size <= cursor) return;
    let chunk;
    const fd = fs.openSync(ROOM_FILE, 'r');
    try {
      const len = size - cursor;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, cursor);
      chunk = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) return; // no complete line yet — wait for the newline
    const consumed = chunk.subarray(0, lastNl + 1);
    cursor += consumed.length;
    for (const line of consumed.toString('utf8').split('\n')) {
      const t = line.trim();
      if (t) processLine(t);
    }
  } catch (_) { /* never crash the deck over a room read */ } finally {
    draining = false;
  }
}

// Clear the room log (the panel's "clean" button), IN-PROCESS so it serializes
// with the watcher's own cursor instead of racing it cross-process. Drain any
// pending lines FIRST (so a just-appended, sender-acknowledged message is
// delivered, not silently eaten — honours "bounce, never drop" for everything
// already on disk), THEN truncate and reset the cursor. The only residual loss
// is a line appended in the microscopic window between this drain and the
// truncate — acceptable for a deliberate "wipe everything" action.
function clearRoomLog() {
  try { drain(); } catch (_) { /* best effort */ }
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    fs.writeFileSync(ROOM_FILE, '');
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  cursor = 0; // file is now empty; next append starts a fresh log
  // "Vider" purges EVERYTHING (chosen semantics): wipe the durable archive too,
  // not just the live transport — else the panel would reload the old history.
  try { roomDb.wipe(); } catch (_) { /* best effort — archive purge */ }
  return { ok: true };
}

let started = false;
function startRoomRouter() {
  if (started) return; // idempotent (probe + boot must not double-watch)
  started = true;
  try { fs.mkdirSync(ROOMS_DIR, { recursive: true }); } catch (_) { /* best effort */ }
  // Touch the file so fs.watch(ROOM_FILE) has a target; '' append never alters
  // existing content.
  try { fs.appendFileSync(ROOM_FILE, ''); } catch (_) { /* best effort */ }
  // v67: catch the ARCHIVE up on any backlog already in main.jsonl (lines written
  // while the deck was DOWN). Archiving is idempotent (INSERT OR IGNORE by id) and
  // we do NOT deliver these — the cursor below still starts at EOF — so history
  // survives a deck-down append WITHOUT re-injecting old messages into panes
  // (acceptance criterion 4 intact). Control records are skipped (lifecycle, not a
  // discussion), matching the live archive path in processLine.
  try {
    for (const line of fs.readFileSync(ROOM_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t);
        if (m && typeof m === 'object' && m.type !== 'control'
            && typeof m.to === 'string' && typeof m.text === 'string') {
          // Same resolve-then-archive contract as the live path (processLine).
          if (m.to_label == null) { const tl = resolveToLabel(m.to); if (tl != null) m.to_label = tl; }
          roomDb.archive(m);
        }
      } catch (_) { /* skip malformed line */ }
    }
  } catch (_) { /* no backlog / unreadable -> nothing to catch up */ }
  // Criterion 4: begin at current EOF — a deck restart never replays backlog.
  try { cursor = fs.statSync(ROOM_FILE).size; } catch (_) { cursor = 0; }
  writeRegistry();

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(drain, 50); };
  try {
    fs.watch(ROOM_FILE, schedule);
  } catch (_) {
    try {
      fs.watch(ROOMS_DIR, (_e, fn) => { if (fn === 'main.jsonl') schedule(); });
    } catch (_) { /* inotify refused -> the safety poll alone covers us */ }
  }
  // Safety net under fs.watch (also covers a missed event or late file creation),
  // and the queue heartbeat: a target that FINISHED its turn (went idle) has no
  // new room line to nudge its queue, so it is retried here every tick.
  setInterval(() => { drain(); drainPending(); }, 1000);
}

module.exports = {
  startRoomRouter,
  registerRoomSession,
  refreshRegistry,
  clearRoomLog,
  roomSpawnEnv,
  roomLabelFor,
  writeRegistry,
  noteSessionStatus,
  writeSessionsSnapshot,
  setRoomLabel,
  setRoomListener,
  setControlListener,
  submitToPane,
  routerNotice,
  relabelMessage, // ipc/room.js maps the panel feed + live push through this
  // exported for the headless probe (.scratch/room-router-probe.js)
  _internals: {
    drain, deliver, drainPending, resolveTargets, resolveToLabel, isFallbackLabel,
    canonicalFromLabel, relabelMessage, render, sanitize, roomLabels, handleControl,
    pendingBySession, optimisticBusyUntil, sessionMidTurn,
  },
};
