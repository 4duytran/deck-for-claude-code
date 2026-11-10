// claude-deck — session-status: live status (fed by the injected hook via
// ~/.claude/deck-status), the fs.watch pusher, PID reconciliation and the
// busy-guard every write path checks before touching a session file.
// No status file = historical session never opened with the hook -> 'closed'.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { STATUS_DIR, VALID_STATUSES, LIVE_STATUSES, UUID_RE, HEAD_BYTES } = require('./config');
const { ptys, sessionDirs, resumeIdMap, statusAlias, deckSpawnedIds } = require('./state');
const { send } = require('./window');
const { findSessionFile } = require('./transcripts');
const { persistPendingName, persistPendingRename } = require('./session-titles');
const { noteSessionStatus } = require('./rooms');

function readSessionStatus(sessionId) {
  return readSessionStatusEntry(sessionId).status;
}

// v45.2: status + its write timestamp — consumers that DISPLAY liveness (the
// chat strip) need the age to spot fossils: a busy file whose session died
// without SessionEnd/PtyExit (crash, reboot) stays busy forever on disk.
// mtimeMs: the file's mtime. The status hook `touch`es the file (content
// untouched) on a SUBAGENT's tool events, so a main session waiting on a
// foreground Agent call keeps a live file although its `ts` is old.
function readSessionStatusEntry(sessionId) {
  global.__deckStatusDiskReads = (global.__deckStatusDiskReads || 0) + 1; // probe seam
  try {
    const file = path.join(STATUS_DIR, `${sessionId}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data && VALID_STATUSES.has(data.status)) {
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { /* ts-only age */ }
      // event: the hook event that wrote the entry (Stop, UserPromptSubmit, Notification, ... or the deck's own
      // PtyExit / UserInterrupt / MenuGone). It tells a real turn end (`idle` from Stop) from the other writers of `idle`.
      return {
        status: data.status, ts: typeof data.ts === 'string' ? data.ts : null, mtimeMs, event: typeof data.event === 'string' ? data.event : null,
      };
    }
  } catch (_) { /* missing or malformed -> closed */ }
  return { status: 'closed', ts: null, mtimeMs: null, event: null };
}

// Age of a status entry in ms, from its FRESHEST sign of life: the later of the
// content `ts` (main-agent hook events) and the file mtime (subagent tool
// events refresh the mtime only). NaN when neither is usable — every stale-busy
// reader (freshStatus, isLeadTurnInFlight) reads NaN as « stale ». rooms.js
// cannot require this module (electron) and mirrors the same rule inline.
function statusAgeMs(entry, now = Date.now()) {
  const stamps = [Date.parse(entry && entry.ts), entry && entry.mtimeMs].filter(Number.isFinite);
  return stamps.length ? now - Math.max(...stamps) : NaN;
}

// v33 status cache: sessions-list used to re-read EVERY status file from disk
// on each scan (one readFileSync per row, on every auto-refresh). The watcher
// already sees every write in STATUS_DIR and keeps this map fresh — the scan
// reads memory, cold misses fill once. Correctness paths (isSessionBusy,
// reconcileOpenPanes) keep DIRECT disk reads on purpose: a debounce-stale
// cache must never green-light a write guard.
const statusCache = new Map(); // sessionId -> last known status

function readSessionStatusCached(sessionId) {
  const hit = statusCache.get(sessionId);
  if (hit !== undefined) return hit;
  const status = readSessionStatus(sessionId);
  statusCache.set(sessionId, status);
  return status;
}

// v47 /clear isolation — the genuine own-fork of oldId SHARES oldId's
// transcript history head; a fresh /clear-born (or a sibling pane's brand-new)
// session in the SAME project dir does NOT. Read only the HEAD and return the
// first plain-text user-message content — the stable lineage signal to match
// on. Unreadable/absent -> null so the caller fails closed (never adopts on
// doubt, Rule #7). Mirrors the firstUserText parse in session-meta.js.
async function firstUserHead(filePath) {
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const { size } = await fh.stat();
    if (!size) return null;
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; } // partial/last line
      if (!e || e.type !== 'user' || !e.message) continue;
      const content = e.message.content;
      if (typeof content !== 'string') continue;
      const text = content.trim();
      if (text && !text.startsWith('<')) return text; // skip XML command noise
    }
    return null;
  } catch (_) { return null; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// Belt (bounded watch): the content self-match is the primary containment, but a
// resumed pane whose user never forks would otherwise watch the SHARED dir for
// the pane's whole life. Stand the detector down after a generous window with no
// adoption — well above a real late first-message fork (minutes) and far above
// any probe settle.
const RESUME_DETECT_WINDOW_MS = 5 * 60 * 1000;

// FIX #1 (rebuilt v45.2): watch the resumed session's project dir for the
// forked .jsonl. The fork is born when claude WRITES ITS FIRST LINE — which
// happens at the user's first message, possibly MINUTES after the spawn (the
// old 3.5s one-shot poll missed late forks; the alias then never existed and
// every status push routed to a newId no pane knows: frozen activity strip,
// stale sidebar badge). Now event-driven (fs.watch on the dir) + a slow
// safety poll, alive until the fork is found OR the pane's pty dies.
function detectResumedSession(oldId, dir, beforeSet) {
  let done = false;
  let watcher = null;
  let timer = null;
  let scanning = false;
  const armedAt = Date.now();
  const finish = () => {
    done = true;
    clearInterval(timer);
    if (watcher) {
      try { watcher.close(); } catch (_) { /* already dead */ }
      watcher = null;
    }
  };
  // oldId's own history head, resolved lazily from its .jsonl in THIS dir (the
  // resume dir the pane was armed with). Cached once read; retried while the
  // file is briefly unreadable so a transient read never permanently disarms.
  let ownSigCache; // undefined = not read yet, string = oldId's first-user head
  const ownHeadSignature = async () => {
    if (typeof ownSigCache === 'string') return ownSigCache;
    const sig = await firstUserHead(path.join(dir, `${oldId}.jsonl`));
    if (sig != null) ownSigCache = sig;
    return sig;
  };
  const scan = async () => {
    if (done || scanning) return;
    scanning = true;
    try {
      // lifetime guard: no live pty runs this session anymore -> stand down
      let alive = false;
      for (const entry of ptys.values()) {
        if (entry.sessionId === oldId) { alive = true; break; }
      }
      if (!alive) { finish(); return; }
      // Belt: never watch the shared dir past the bounded window (see const).
      if (Date.now() - armedAt > RESUME_DETECT_WINDOW_MS) { finish(); return; }
      const entries = await fsp.readdir(dir);
      const fresh = [];
      for (const f of entries) {
        if (!f.endsWith('.jsonl') || beforeSet.has(f)) continue;
        const id = f.slice(0, -'.jsonl'.length);
        if (!UUID_RE.test(id)) continue;
        // v46.9.5: a sibling pane's session births its .jsonl in this SAME
        // dir — it is NOT our fork (user repro: pane A resumed + pane B
        // created -> A re-anchored onto B's transcript, both panes showed
        // B's single message). Excluded: any id the deck itself created
        // (durable — the pane may already be closed) and any id owned by a
        // live pty (another resume's row id or its already-mapped fork).
        // Residual known race (attack #5, 2026-06-07): a fork born but not
        // yet adopted by ITS detector is invisible to this guard for up to
        // one poll interval (2s; fs.watch usually closes it in ms) — two
        // un-owned forks in one dir can cross within that window.
        // Content-level lineage matching would be needed to close it.
        if (deckSpawnedIds.has(id)) continue;
        let owned = false;
        for (const entry of ptys.values()) {
          if (entry.sessionId === id
              || resumeIdMap.get(entry.sessionId) === id) { owned = true; break; }
        }
        if (owned) continue;
        let st;
        try { st = await fsp.stat(path.join(dir, f)); } catch (_) { continue; }
        fresh.push({ id, mtimeMs: st.mtimeMs });
      }
      if (!fresh.length || done) return;
      fresh.sort((a, b) => b.mtimeMs - a.mtimeMs); // several appeared -> most recent first
      // PRIMARY containment: adopt ONLY a genuine continuation of oldId's OWN
      // transcript. A foreign session (/clear-born, or a sibling pane's new
      // session) lives in this SAME dir but does NOT share oldId's history head
      // -> skipped, exactly like the deckSpawned/owned continue-gates above.
      // oldId's own head unreadable -> adopt nothing (Rule #7: never on doubt).
      const ownSig = await ownHeadSignature();
      if (ownSig == null || done) return;
      let newId = null;
      for (const cand of fresh) {
        const candSig = await firstUserHead(path.join(dir, `${cand.id}.jsonl`));
        if (candSig != null && candSig === ownSig) { newId = cand.id; break; }
      }
      if (!newId || done) return;
      finish();
      const prev = resumeIdMap.get(oldId);
      if (prev) statusAlias.delete(prev); // drop stale alias from an earlier resume
      resumeIdMap.set(oldId, newId);
      statusAlias.set(newId, oldId);
      // Push the live status onto the sidebar row right away.
      send('session-status', { sessionId: oldId, status: readSessionStatus(newId) });
    } catch (_) { /* never crash the deck over a status nicety */
    } finally {
      scanning = false;
    }
  };
  try {
    watcher = fs.watch(dir, () => { scan(); });
  } catch (_) { /* inotify refused -> the poll alone covers us */ }
  timer = setInterval(scan, 2000); // safety net under fs.watch
  scan();
}

// v47.x /clear re-anchor (L2 companion to detectResumedSession): a click-armed,
// pane-SCOPED, one-shot adopter for the CLICKING pane's own « /clear » fork.
// The L1 detector above adopts a fork ONLY when it shares oldId's history head;
// a /clear session shares NONE — that refusal IS the isolation guarantee (probe
// 12/12). But the pane that clicked must still FOLLOW its fresh session. The
// renderer knows which pane clicked, so it arms this positive attribution: the
// FIRST new .jsonl in the pane's project dir that no OTHER live pane owns is P's
// /clear fork. NO content-lineage check here (a fresh head is the whole point).
// It fires ONLY from the pane-expect-clear IPC, is time-boxed + one-shot, and
// never scans on behalf of any other pane -> it cannot reintroduce the
// cross-pane adoption bug. Fails closed on any missing/unreadable state (Rule #7).
const CLEAR_EXPECT_WINDOW_MS = 30 * 1000;
const clearExpectations = new Map(); // paneId -> disarm fn (one armed expectation per pane)

function expectClearFork(paneId) {
  try {
    if (typeof paneId !== 'string' || !paneId) return;
    const entry = ptys.get(paneId);
    const sid = entry && entry.sessionId;
    if (!sid) return; // no live session on this pane -> nothing to re-anchor
    // The /clear fork is born in the SAME project dir as the pane's current
    // session. sessionDirs (last scan) first; else the blessed resolver — the
    // dir is NEVER reconstructed from cwd (that encoding is lossy, transcripts.js).
    let dir = sessionDirs.get(sid);
    if (!dir) {
      const eff = resumeIdMap.get(sid) || sid;
      const f = findSessionFile(eff) || findSessionFile(sid);
      dir = f ? path.dirname(f) : null;
    }
    if (!dir) return; // dir unknown -> adopt nothing (fail closed)
    let beforeSet;
    try { beforeSet = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))); }
    catch (_) { return; } // unreadable dir -> fail closed
    // Re-arm: a second click replaces any expectation still armed for this pane.
    const prior = clearExpectations.get(paneId);
    if (prior) prior();

    let done = false;
    let watcher = null;
    let timer = null;
    let deadline = null;
    const disarm = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(deadline);
      if (watcher) { try { watcher.close(); } catch (_) { /* already dead */ } watcher = null; }
      if (clearExpectations.get(paneId) === disarm) clearExpectations.delete(paneId);
    };
    const scan = () => {
      if (done) return;
      try {
        // Pane closed or re-spawned onto another session mid-window -> stand down.
        const cur = ptys.get(paneId);
        if (!cur || cur.sessionId !== sid) { disarm(); return; }
        let names;
        try { names = fs.readdirSync(dir); } catch (_) { return; }
        for (const f of names) {
          if (!f.endsWith('.jsonl') || beforeSet.has(f)) continue;
          const id = f.slice(0, -'.jsonl'.length);
          if (!UUID_RE.test(id)) continue;
          if (deckSpawnedIds.has(id)) continue; // a sibling pane's brand-new deck session, never a /clear fork
          let owned = false;
          for (const e of ptys.values()) {
            if (e.sessionId === id || resumeIdMap.get(e.sessionId) === id) { owned = true; break; }
          }
          if (owned) continue; // owned by ANOTHER live pane -> not P's fork
          // P's /clear fork. Adopt it FOR P only — mirror detectResumedSession's
          // wiring so the transcript tick re-anchors P onto the fresh file.
          const prev = resumeIdMap.get(sid);
          if (prev) statusAlias.delete(prev); // drop the stale alias from a prior resume/clear
          resumeIdMap.set(sid, id);
          statusAlias.set(id, sid);
          disarm();
          send('session-status', { sessionId: sid, status: readSessionStatus(id) });
          return;
        }
      } catch (_) { /* never crash the deck over a re-anchor nicety */ }
    };
    try { watcher = fs.watch(dir, () => { scan(); }); } catch (_) { /* inotify refused -> the poll covers us */ }
    timer = setInterval(scan, 1000); // safety net under fs.watch
    deadline = setTimeout(disarm, CLEAR_EXPECT_WINDOW_MS); // belt: never linger past the window
    clearExpectations.set(paneId, disarm);
    scan(); // in case a fast /clear already minted the file
  } catch (_) { /* arming must never crash the deck */ }
}

// FIX #2: mark a session closed both durably (status file, so a sidebar
// refresh re-reads 'closed', not the stale live status) and immediately (push).
function markSessionClosed(sessionId) {
  persistPendingName(sessionId); // v28: a closed session is the safe write window
  persistPendingRename(sessionId); // v32: deferred rename, same safe window
  const effectiveId = resumeIdMap.get(sessionId) || sessionId;
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATUS_DIR, `${effectiveId}.json`),
      JSON.stringify({ status: 'closed', event: 'PtyExit', ts: new Date().toISOString() }) + '\n'
    );
  } catch (_) { /* best effort; the direct push below still fixes the UI */ }
  statusCache.set(effectiveId, 'closed'); // v33: keep the scan cache coherent
  send('session-status', { sessionId, status: 'closed' });
}

// v46.2: an Esc interrupt aborts the turn WITHOUT firing the Stop hook —
// the status file stays 'working' and the whole UI (sidebar badge, activity
// strip, stop button, queue) reads a phantom busy until the 5min fossil
// guard. The transcript IS the truth here: Claude Code logs '[Request
// interrupted by user…]' — when the reader sees it land, force the file to
// idle. Guard: only over a still-busy entry (never clobber a fresher real
// status — the user may already have sent the next prompt).
const INTERRUPT_BUSY = new Set(['working', 'running', 'waiting']);
function markInterruptedIdle(sessionId, markerTs) {
  const entry = readSessionStatusEntry(sessionId);
  if (!INTERRUPT_BUSY.has(entry.status)) return; // already quiet/closed
  // Review attack #4: a status file WRITTEN AFTER the interrupt marker is a
  // legitimately-busy NEXT turn (rapid interrupt→resend) — never idle it.
  if (markerTs && entry.ts && Date.parse(entry.ts) > Date.parse(markerTs)) return;
  const effectiveId = resumeIdMap.get(sessionId) || sessionId;
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATUS_DIR, `${effectiveId}.json`),
      JSON.stringify({ status: 'idle', event: 'UserInterrupt', ts: new Date().toISOString() }) + '\n'
    );
  } catch (_) { /* best effort; the push below still fixes the UI */ }
  statusCache.set(effectiveId, 'idle');
  const displayId = statusAlias.get(sessionId) || sessionId;
  send('session-status', { sessionId: displayId, status: 'idle' });
}

// The permission menu left the terminal (the renderer read its pane twice: no
// menu, composer box back), so the `waiting` the hook wrote for it is over.
// Restores the status held before the menu — the hook's "prev" on the waiting
// record, else `working` — keeping the "sub" marker so a second menu of the
// same foreground run is still attributed. The RAW file is read (readSession-
// StatusEntry exposes neither prev nor sub) and only a parsed `waiting` record
// is touched. seenAt = epoch ms of the renderer's FIRST « menu gone » read: a
// record stamped after it is a newer Notification (another menu) and stays.
// The hook's ts has one-second resolution, hence the floor. Atomic like the
// hook (temp file in STATUS_DIR, then rename): the watcher never sees a half
// write. A failed write pushes nothing — the file is the shared truth.
// Returns true when it wrote.
const MENU_GONE_PREV = new Set(['working', 'running', 'idle', 'active']);
function markMenuGone(sessionId, seenAt) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return false; // no path crosses the bridge
  if (!Number.isFinite(seenAt)) return false; // the newer-menu guard cannot be evaluated
  const effectiveId = resumeIdMap.get(sessionId) || sessionId;
  if (!UUID_RE.test(effectiveId)) return false;
  if (askTickets.has(effectiveId)) return false; // a live ask owns the record: no menu on screen is expected then
  const file = path.join(STATUS_DIR, `${effectiveId}.json`);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return false; } // missing / malformed
  if (!rec || typeof rec !== 'object' || rec.status !== 'waiting') return false;
  const tsMs = Date.parse(rec.ts);
  if (Number.isFinite(tsMs) && tsMs > Math.floor(seenAt / 1000) * 1000) return false; // a newer menu
  const status = MENU_GONE_PREV.has(rec.prev) ? rec.prev : 'working';
  const out = { status, event: 'MenuGone', ts: hookTs() };
  if (rec.sub === 1) out.sub = 1; // last key, as the hook writes it: `...,"sub":1}`
  if (!writeStatusFile(effectiveId, out)) return false;
  pushStatus(sessionId, effectiveId, status);
  return true;
}

const hookTs = (at = Date.now()) => new Date(at).toISOString().replace(/\.\d+Z$/, 'Z'); // the hook's format

// Atomic like the hook (temp file in STATUS_DIR, then rename): the watcher never sees a half write.
function writeStatusFile(effectiveId, out) {
  const tmp = path.join(STATUS_DIR, `.${effectiveId}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out) + '\n');
    fs.renameSync(tmp, path.join(STATUS_DIR, `${effectiveId}.json`));
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* nothing to clean */ }
    return false;
  }
}

function pushStatus(sessionId, effectiveId, status) {
  statusCache.set(effectiveId, status);
  const displayId = statusAlias.get(sessionId) || sessionId;
  send('session-status', { sessionId: displayId, status });
}

// A question waits in the ask channel: no Notification fires while the ask hook blocks, so the
// deck writes the `waiting` record itself, in the hook's format, `prev` = the status it replaces.
// The status hook's PreToolUse write for the same tool can land after ours and replace it: one
// re-apply ASK_REAPPLY_MS later, only over that write. A newer `waiting` (a Notification) is never touched.
const ASK_REAPPLY_MS = 1000;
const ASK_REAPPLY_FROM = new Set(['working', 'running']);
const askTickets = new Map(); // effectiveId -> live ticket { seenAt, cancel }; markMenuGone leaves these records alone
function writeAskWaiting(sessionId, effectiveId, ticket, again) {
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(path.join(STATUS_DIR, `${effectiveId}.json`), 'utf8')); } catch (_) { /* none yet */ }
  if (!cur || typeof cur !== 'object') cur = {};
  if (cur.status === 'waiting') return false; // a menu (or our own record) already says it
  if (again && !ASK_REAPPLY_FROM.has(cur.status)) return false; // the turn moved on: not ours to re-assert
  const at = Date.now();
  const prev = MENU_GONE_PREV.has(cur.status) ? cur.status : 'working';
  const out = { status: 'waiting', event: 'AskWaiting', ts: hookTs(at), prev, owner: '' };
  if (cur.sub === 1) out.sub = 1;
  if (!writeStatusFile(effectiveId, out)) return false;
  ticket.seenAt = at; // epoch ms of the record's write: what markMenuGone(…, seenAt) compares a newer record against
  pushStatus(sessionId, effectiveId, 'waiting');
  return true;
}

// Returns a ticket { seenAt, cancel() } or null (nothing written). On close: cancel(), then
// markMenuGone(sessionId, ticket.seenAt) restores the status held before the question.
function markAskWaiting(sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
  const effectiveId = resumeIdMap.get(sessionId) || sessionId;
  if (!UUID_RE.test(effectiveId)) return null;
  const ticket = { seenAt: NaN, timer: null };
  ticket.cancel = () => {
    clearTimeout(ticket.timer);
    if (askTickets.get(effectiveId) === ticket) askTickets.delete(effectiveId);
  };
  if (!writeAskWaiting(sessionId, effectiveId, ticket, false)) return null;
  const older = askTickets.get(effectiveId);
  if (older) older.cancel();
  askTickets.set(effectiveId, ticket);
  ticket.timer = setTimeout(() => {
    if (askTickets.get(effectiveId) === ticket) writeAskWaiting(sessionId, effectiveId, ticket, true);
  }, ASK_REAPPLY_MS);
  if (ticket.timer.unref) ticket.timer.unref();
  return ticket;
}

// FIX #2: punctual reconciliation (no heavy polling) — deck-spawned panes
// whose status looks alive but whose PID is gone (ESRCH) are forced closed.
// Sessions not spawned by the deck have no known PID -> hook-only (out of scope).
function reconcileOpenPanes() {
  for (const entry of ptys.values()) {
    if (!entry.sessionId) continue;
    const effectiveId = resumeIdMap.get(entry.sessionId) || entry.sessionId;
    if (!LIVE_STATUSES.has(readSessionStatus(effectiveId))) continue;
    try {
      process.kill(entry.proc.pid, 0); // signal 0 = liveness probe
    } catch (err) {
      if (err && err.code === 'ESRCH') markSessionClosed(entry.sessionId);
    }
  }
}

// Busy = a deck pane runs this session with a live PID (phase-3 tracking), or
// its hook status says a claude process is mid-work (covers out-of-deck runs).
function isSessionBusy(sessionId) {
  for (const entry of ptys.values()) {
    if (!entry.sessionId) continue;
    const ids = [entry.sessionId, resumeIdMap.get(entry.sessionId)].filter(Boolean);
    if (!ids.includes(sessionId)) continue;
    try {
      process.kill(entry.proc.pid, 0); // liveness probe
      return true;
    } catch (_) { /* dead PID -> not busy via this pane */ }
  }
  return LIVE_STATUSES.has(readSessionStatus(resumeIdMap.get(sessionId) || sessionId));
}

// P3 (2026-09-18): display-path twin of isSessionBusy — SAME signal (deck
// pane PID alive, or hook status says mid-work) for the sidebar's per-row
// "is this session live" check (feeds the sidebar-agents liveness gate,
// session-activity.js). isSessionBusy's write-guards (rename/delete) stay on
// the DIRECT read on purpose (v33 comment above); this one reads the CACHE
// instead, because sessions-list calls it once per row on every auto-refresh
// scan — the same v33 invariant the display path already promises (zero
// disk reads per scan, proven by auto-refresh-probe's t5 gate). A stale
// cache is fine here (self-heals on the next watcher event); it must never
// be used as a write guard.
function isSessionLiveCached(sessionId) {
  for (const entry of ptys.values()) {
    if (!entry.sessionId) continue;
    const ids = [entry.sessionId, resumeIdMap.get(entry.sessionId)].filter(Boolean);
    if (!ids.includes(sessionId)) continue;
    try {
      process.kill(entry.proc.pid, 0); // liveness probe
      return true;
    } catch (_) { /* dead PID -> not live via this pane */ }
  }
  return LIVE_STATUSES.has(readSessionStatusCached(resumeIdMap.get(sessionId) || sessionId));
}

// Epoch ms of a session's CLEAN SessionEnd (status `closed` + event `SessionEnd`,
// the CLI's own exit record, bin/deck-status-hook.sh), else null: no status file,
// a PtyExit/other writer, a live status, an unparseable ts. Same key as the status
// leg of the sidebar row. A direct read on purpose (the cache keeps no event/ts):
// the display path calls it lazily, only for a row with a running agent.
function sessionEndedAtMs(sessionId) {
  const e = readSessionStatusEntry(resumeIdMap.get(sessionId) || sessionId);
  if (e.status !== 'closed' || e.event !== 'SessionEnd') return null;
  const t = Date.parse(e.ts);
  return Number.isFinite(t) ? t : null;
}

// Read-only pane lookups (the ask drawer finds the pane of a question, the liveness getter
// below judges a session). PURE reads of the pane table (state.js `ptys`), the two resume
// alias maps and the status FILE: no statusCache write, no signal, no send(). Not a write
// guard either (isSessionBusy stays that): the verdict can be stale a moment later.
// A busy status untouched this long is a fossil (session died without SessionEnd);
// same 5 min rule as rooms.js ROOM_STALE_BUSY_MS and ipc/transcript.js STALE_BUSY_MS,
// mirrored here because those modules cannot be required from this one.
const SESSION_STATE_STALE_BUSY_MS = 5 * 60 * 1000;

// A pane counts as live while its PID answers signal 0.
function isPaneAlive(entry) {
  if (!entry) return false;
  try {
    process.kill(entry.proc.pid, 0); // liveness probe
    return true;
  } catch (_) {
    return false; // dead PID (ESRCH) or no proc -> not live
  }
}

// The LIVE deck pane holding `sessionId`, or null. A reopened pane keeps the ORIGINAL
// session id in its entry while Claude Code may write under a newer one, so the id is
// matched three ways: itself, the id it is aliased to (resumeIdMap old -> new) and the
// id aliased to it (statusAlias new -> old), against the pane's own id and its fork.
// Returns { paneId, sessionId, cwd, spawnedAt } where `sessionId` is the id the pane entry holds
// (the original one), which is what submitToPane / the room registry know it by, and `spawnedAt` the ms the pane's
// CLI process was spawned (undefined for an entry that carries none).
function paneOfSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const wanted = new Set(
    [sessionId, resumeIdMap.get(sessionId), statusAlias.get(sessionId)].filter(Boolean),
  );
  for (const [paneId, entry] of ptys) {
    if (!entry || !entry.sessionId) continue;
    const held = [entry.sessionId, resumeIdMap.get(entry.sessionId)].filter(Boolean);
    if (!held.some((id) => wanted.has(id))) continue;
    if (!isPaneAlive(entry)) continue;
    return { paneId, sessionId: entry.sessionId, cwd: entry.cwd, spawnedAt: entry.spawnedAt };
  }
  return null;
}

// The LIVE deck pane whose claude process is one of `pids` (a hook's ancestor chain), or null. It does not depend on the
// session id, so a question still finds its pane after the id changed with no alias recorded (a /clear typed in the
// terminal arms nothing, a resume whose fork went undetected).
function paneOfPids(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return null;
  for (const [paneId, entry] of ptys) {
    if (!entry || !entry.proc || !pids.includes(entry.proc.pid)) continue;
    if (!isPaneAlive(entry)) continue;
    return { paneId, sessionId: entry.sessionId, cwd: entry.cwd };
  }
  return null;
}

// Tri-state liveness of a session (contract K3a): true = alive, false = dead, null = unknown. A session counts DEAD only on
// the deck's own PtyExit write (markSessionClosed, a pane that really ended); a hook SessionEnd (exit, /clear, /resume,
// logout) proves nothing about the pane, so it is `null`. CACHE FIRST: an idle/active cache costs no disk read; a busy or
// closed cache is confirmed by ONE direct read, judged by the entry actually read (the cache may be a debounce behind).
// Pure read: no cache write, no send(). Not a write guard (isSessionBusy stays that).
function sessionLiveness(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const key = resumeIdMap.get(sessionId) || sessionId;
  const cached = readSessionStatusCached(key);
  const pane = paneOfSession(sessionId) !== null;
  const settled = cached !== 'closed' && !LIVE_STATUSES.has(cached); // idle, active
  if (settled) return pane ? true : null;
  if (pane && cached !== 'closed') return true; // a live pane under a busy cache needs no read
  const entry = readSessionStatusEntry(key);
  if (entry.status === 'closed') {
    if (entry.mtimeMs === null) return pane ? true : null; // no file, or an unparsable one
    return entry.event === 'PtyExit' ? false : null; // PtyExit wins over a live pane; any SessionEnd is unknown
  }
  if (LIVE_STATUSES.has(entry.status)) {
    if (pane) return true;
    const age = statusAgeMs(entry);
    return Number.isFinite(age) && age <= SESSION_STATE_STALE_BUSY_MS ? true : null; // older busy = fossil
  }
  return pane ? true : null; // idle / active written since the cache was filled
}

// The getter the agent lifecycle is handed (D-PB): `{ live, sinceMs }`, `live` exactly sessionLiveness's tri-state and
// `sinceMs` the spawn time of the live deck pane holding the session (null with no pane, or when the session is not
// live). A run whose start and last own record both predate `sinceMs` belonged to a CLI process that is gone.
function sessionLivenessSince(sessionId) {
  const live = sessionLiveness(sessionId);
  const pane = live === true ? paneOfSession(sessionId) : null;
  return { live, sinceMs: pane && Number.isFinite(pane.spawnedAt) ? pane.spawnedAt : null };
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// <STATUS_DIR>/<uuid>.effort is written by bin/deck-collector.sh from the statusline data.
// Anything but a known level (junk, empty, missing file) is null: the renderer hides the control.
function readSessionEffort(sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
  try {
    const level = fs.readFileSync(path.join(STATUS_DIR, `${sessionId}.effort`), 'utf8').trim();
    return EFFORT_LEVELS.has(level) ? level : null;
  } catch (_) { return null; }
}

const statusTimers = new Map(); // filename -> debounce timer

function startStatusWatcher() {
  try { fs.mkdirSync(STATUS_DIR, { recursive: true }); } catch (_) { /* best effort */ }
  try {
    fs.watch(STATUS_DIR, (_event, filename) => {
      if (!filename) return;
      const isEffort = filename.endsWith('.effort');
      if (!isEffort && !filename.endsWith('.json')) return;
      const sessionId = filename.slice(0, -(isEffort ? '.effort' : '.json').length);
      if (!UUID_RE.test(sessionId)) return;
      // Debounce per file: the hook writes via tmp+rename, events come in bursts.
      clearTimeout(statusTimers.get(filename));
      statusTimers.set(filename, setTimeout(() => {
        statusTimers.delete(filename);
        if (isEffort) {
          send('session-effort', { sessionId: statusAlias.get(sessionId) || sessionId, level: readSessionEffort(sessionId) });
          return;
        }
        global.__deckStatusEvents = (global.__deckStatusEvents || 0) + 1; // probe seam
        // FIX #1: a status arriving under a forked newId updates the oldId row.
        const displayId = statusAlias.get(sessionId) || sessionId;
        const status = readSessionStatus(sessionId);
        statusCache.set(sessionId, status); // v33: watcher = cache invalidation
        // v32: out-of-deck sessions close via the SessionEnd hook, not a pane
        // exit — inject any deferred rename on that transition too.
        if (status === 'closed') persistPendingRename(displayId);
        send('session-status', { sessionId: displayId, status });
        noteSessionStatus(displayId); // room registry: pick up the native session name once its file exists
      }, 50));
    });
  } catch (err) {
    // Watcher is an enhancement: app still works with static badges.
    console.error('deck-status watcher unavailable:', err.message);
  }
}

module.exports = {
  readSessionStatus,
  readSessionStatusEntry,
  statusAgeMs,
  readSessionStatusCached,
  statusCache,
  CLEAR_EXPECT_WINDOW_MS,
  detectResumedSession,
  expectClearFork,
  markSessionClosed,
  markInterruptedIdle,
  markMenuGone,
  markAskWaiting,
  reconcileOpenPanes,
  isSessionBusy,
  isSessionLiveCached,
  sessionEndedAtMs,
  paneOfSession,
  paneOfPids,
  sessionLiveness,
  sessionLivenessSince,
  startStatusWatcher,
  readSessionEffort,
};
