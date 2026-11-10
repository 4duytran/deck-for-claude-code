// claude-deck — state: the shared mutable registries of the main process.
// Data ONLY (Maps), no logic and no requires — any module can depend on this
// without ever creating a cycle. Each registry's lifecycle is owned by the
// module that documents it below; others only read.
'use strict';

// paneId -> { proc: IPty, sessionId: string|null, cwd } — owned by ipc/pty.js.
// v39: cwd kept for the git panel — ALWAYS resolved main-side from this
// registry (the renderer never supplies a path to run git in).
const ptys = new Map();

// paneIds whose `pty-open` is in flight (the spawn is not registered in `ptys` yet) — owned by ipc/pty.js. The chat
// feed reads it: until the pane's pty registers, liveness has no spawn time for a run recorded before the pane opened.
const ptyOpening = new Set();

// FIX #1 (resume id drift): `claude --resume <oldId>` forks a NEW session id;
// hooks then write status under newId while the sidebar row keeps oldId.
// We detect the new .jsonl on disk and alias newId -> oldId for routing.
const sessionDirs = new Map(); // sessionId -> ~/.claude/projects/<dir> (from last scan)
const resumeIdMap = new Map(); // oldId (sidebar row) -> newId (live status)
const statusAlias = new Map(); // newId -> oldId (route status events back to the row)
// v46.9.5: ids the deck itself created (`claude --session-id <uuid>`). A
// brand-new session births its .jsonl in the SAME project dir as a sibling
// resume — the fork detector must NEVER adopt one of these (user repro:
// resumed pane re-anchored onto the new pane's transcript). Durable for the
// deck's lifetime: the pane may be closed by the time a detector scans.
const deckSpawnedIds = new Set();

// v28 named new sessions: an optional name picked at creation. The deck fixes
// the session id ITSELF (`claude --session-id <uuid>`) so it knows the session
// from tick one. The name overrides the sidebar summary while the session
// lives, and is persisted as NATIVE title lines once it closes —
// never appended while claude may still be writing the file (same caution as
// the rename busy-guard).
const pendingNames = new Map(); // sessionId (deck-generated) -> chosen name

// v32 deferred rename: renaming a BUSY session no longer fails — the new name
// is held here, shown at once in the sidebar (italic = not on disk yet) and
// injected as native title lines once the session closes (pane exit, or the
// hook's 'closed' status for out-of-deck sessions). In-memory only, same
// crash caveat as pendingNames. oldTitle = the on-disk custom-title at rename
// time: the injection guard compares VALUES, not positions — a live claude
// keeps RE-APPENDING its in-memory title near EOF, so anything position-based
// would always see "a newer title" and never inject.
const pendingRenames = new Map(); // sessionId -> { name, oldTitle }

module.exports = {
  ptys,
  ptyOpening,
  sessionDirs,
  deckSpawnedIds,
  resumeIdMap,
  statusAlias,
  pendingNames,
  pendingRenames,
};
