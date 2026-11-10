// claude-deck — session-titles: close-time injection of creation names (v28)
// and deferred renames (v32) as NATIVE title lines. A CLOSED session is the
// only window where no live claude can be writing the file — both injectors
// are called from markSessionClosed / the status watcher (session-status.js).
'use strict';

const { pendingNames, pendingRenames, resumeIdMap } = require('./state');
const { findSessionFile, readTailTitleState, appendTitleLinesSync } = require('./transcripts');

// v28: persist a creation-time name as NATIVE title lines — exact same
// shape as session-rename — once the session is CLOSED.
function persistPendingName(sessionId) {
  const name = pendingNames.get(sessionId);
  if (!name) return;
  pendingNames.delete(sessionId); // one shot, even on failure — no retry storms
  try {
    const filePath = findSessionFile(sessionId);
    if (!filePath) return; // session never materialized (no prompt sent) — nothing to name
    const tail = readTailTitleState(filePath);
    if (tail.empty) return;
    // A /rename DURING the session must win over the creation name: the file
    // had NO title at spawn, so ANY on-disk title is newer than ours.
    if (tail.lastTitle !== null) return;
    appendTitleLinesSync(filePath, name, sessionId, tail.endsNewline);
  } catch (_) { /* best effort — the pending display already showed the name */ }
}

// v32: inject a deferred rename in the same safe window. Precedence by VALUE
// (cf. pendingRenames comment in state.js). Last on-disk custom-title:
//   == our name            -> already applied (native rename to same) -> done
//   == oldTitle (or none)  -> only auto re-appends happened -> inject ours
//   anything else          -> a native /rename happened meanwhile -> it wins
// Resume forks: the lineage's LIVE file is the forked newId's — inject there
// too, or the dedup'd sidebar row (most recent file wins) keeps the old name.
function persistPendingRename(sessionId) {
  const entry = pendingRenames.get(sessionId);
  if (!entry) return;
  global.__deckRenameInjectCalls = (global.__deckRenameInjectCalls || 0) + 1; // probe seam
  pendingRenames.delete(sessionId); // one shot, even on failure
  const forkId = resumeIdMap.get(sessionId);
  const ids = forkId && forkId !== sessionId ? [sessionId, forkId] : [sessionId];
  for (const id of ids) {
    try {
      const filePath = findSessionFile(id);
      if (!filePath) continue;
      const tail = readTailTitleState(filePath);
      if (tail.empty) continue;
      if (tail.lastTitle === entry.name) continue; // already applied
      if (tail.lastTitle !== null && tail.lastTitle !== entry.oldTitle) continue; // native wins
      appendTitleLinesSync(filePath, entry.name, id, tail.endsNewline);
      global.__deckRenameInjectWrites = (global.__deckRenameInjectWrites || 0) + 1; // probe seam
    } catch (_) { /* best effort — next scan shows whatever is on disk */ }
  }
}

module.exports = { persistPendingName, persistPendingRename };
