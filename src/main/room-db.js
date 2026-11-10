// claude-deck — room-db: the PERSISTENT archive of inter-session room messages.
//
// WHY a second store next to main.jsonl: main.jsonl is the LIVE TRANSPORT — the
// bin/room CLI appends to it, the router fs.watch tails it and injects into the
// target pane, and the "Vider" button TRUNCATES it. So main.jsonl is ephemeral
// by design (truncate/rotation/restart-skip-to-EOF) and the room panel that read
// its tail lost all history on every wipe. This module is the durable archive:
// every routed message the router processes is INSERTed here, so the panel can
// show the last N conversations across restarts and truncations.
//
// SINGLE-WRITER by design: ONLY the Electron router (rooms.js, one process)
// writes here. The CLI never touches SQLite — it keeps appending text to
// main.jsonl (no native dep, no cross-process DB lock to reason about). That
// sidesteps SQLite multi-process contention entirely.
//
// Zero new dependency: uses Node's built-in `node:sqlite` (DatabaseSync),
// confirmed available unflagged in both runtimes this rig uses (system node v26
// for the CLI, Electron-bundled node v24 for the deck). require is LAZY so just
// loading rooms.js headless (the probe) never opens a DB until a message flows.
//
// Contract (mirrors rooms.js): never crash the deck over a room nicety — every
// op is best-effort; if node:sqlite is somehow unavailable the archive silently
// degrades to a no-op (archive() does nothing, recent() returns []).
'use strict';

const fs = require('fs');
const { ROOMS_DIR, ROOM_DB } = require('./config');

const RECENT_CEILING = 500; // DOM-safe cap on a single read/render ("Tout"); full history stays in the DB
// Archive growth bound: keep at most ARCHIVE_MAX rows; older rows are pruned in
// amortised sweeps every PRUNE_EVERY archives (cheap, no delete-per-insert).
// Both env-overridable (probe seam: a small max + interval makes pruning testable).
const ARCHIVE_MAX = Math.max(1, Number(process.env.CLAUDE_DECK_ROOM_ARCHIVE_MAX) || 5000);
const PRUNE_EVERY = Math.max(1, Number(process.env.CLAUDE_DECK_ROOM_PRUNE_EVERY) || 256);

let db = null;            // lazy DatabaseSync handle (null until first use)
let unavailable = false;  // node:sqlite missing / DB unopenable -> degrade to no-op
let sinceLastPrune = 0;   // archives since the last prune sweep

function open() {
  if (db) return db;
  if (unavailable) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
    const handle = new DatabaseSync(ROOM_DB);
    // `from`/`to` are SQL keywords -> store as from_id/to_id and map back on read
    // to the {from,to,...} shape the room panel renders. `id UNIQUE` + INSERT OR
    // IGNORE makes archiving idempotent (a re-processed line never duplicates).
    handle.exec(
      'CREATE TABLE IF NOT EXISTS messages ('
      + ' seq INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' id TEXT UNIQUE,'
      + ' ts TEXT,'
      + ' from_id TEXT,'
      + ' from_label TEXT,'
      + ' to_id TEXT,'
      + ' to_label TEXT,'
      + ' text TEXT'
      + ' );'
    );
    // Migration for a DB created before to_label existed: ADD COLUMN just appends
    // a nullable column (no rewrite). It throws "duplicate column name" once the
    // column is present — the EXPECTED path on every open after the first, and on a
    // fresh DB where the CREATE above already added it — so that specific error is
    // swallowed silently. Any OTHER failure (I/O, lock) leaves the column absent
    // while archive()/recent() reference it, silently breaking THIS session's
    // history until a restart retries the ALTER; surface that once (parity with the
    // unavailable-case log below) so it is diagnosable. open() caches the handle, so
    // this block runs at most once per process — no repeat-log guard needed.
    try {
      handle.exec('ALTER TABLE messages ADD COLUMN to_label TEXT;');
    } catch (e) {
      const emsg = e && e.message ? e.message : String(e);
      if (!/duplicate column/i.test(emsg)) {
        try { console.error(`[deck] room archive migration (add to_label) failed: ${emsg}`); } catch (_) { /* noop */ }
      }
    }
    db = handle;
  } catch (e) {
    if (!unavailable) {
      // Surface ONCE — a silently disabled archive is indistinguishable from an
      // empty room. Log (like the lead-lock fail-open) so an operator can tell a
      // BROKEN archive (node:sqlite absent in this Electron build, locked/unwritable
      // DB) from a genuinely empty room. The live feed/transport still works; only
      // history is disabled.
      try {
        console.error('[deck] room archive unavailable — history disabled: '
          + (e && e.message ? e.message : e));
      } catch (_) { /* noop */ }
    }
    unavailable = true;
    db = null;
  }
  return db;
}

// Archive one routed message (best-effort; never throws back into the watcher).
function archive(msg) {
  if (!msg || typeof msg !== 'object') return;
  const h = open();
  if (!h) return;
  try {
    h.prepare(
      'INSERT OR IGNORE INTO messages (id, ts, from_id, from_label, to_id, to_label, text)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      msg.id != null ? String(msg.id) : null,
      typeof msg.ts === 'string' ? msg.ts : null,
      msg.from != null ? String(msg.from) : null,
      msg.from_label != null ? String(msg.from_label) : null,
      msg.to != null ? String(msg.to) : null,
      msg.to_label != null ? String(msg.to_label) : null,
      msg.text != null ? String(msg.text) : null,
    );
    if (++sinceLastPrune >= PRUNE_EVERY) { sinceLastPrune = 0; prune(h); }
  } catch (_) { /* best-effort archive; never crash the watcher over the DB */ }
}

// Bound the table: drop everything older than the most-recent ARCHIVE_MAX rows.
// Amortised (every PRUNE_EVERY archives) so steady-state growth stays capped
// without a delete on every insert.
function prune(h) {
  try {
    h.prepare(
      'DELETE FROM messages WHERE seq <= (SELECT MAX(seq) FROM messages) - ?',
    ).run(ARCHIVE_MAX);
  } catch (_) { /* best effort */ }
}

// Last `limit` messages, OLDEST-FIRST (the order the panel feed renders).
// limit: a positive int caps to that many; 0 (the "Tout" preset) returns all
// up to RECENT_CEILING; anything invalid falls back to 10.
function recent(limit) {
  const h = open();
  if (!h) return [];
  let n = Number(limit);
  if (limit === 0 || limit === '0') {
    n = RECENT_CEILING; // "Tout"
  } else if (!Number.isFinite(n) || n < 0) {
    n = 10;
  } else {
    n = Math.min(Math.floor(n), RECENT_CEILING);
    if (n === 0) n = 10; // a fractional 0<limit<1 floored to 0 -> default, never empty
  }
  try {
    const rows = h.prepare(
      'SELECT id, ts, from_id, from_label, to_id, to_label, text FROM messages ORDER BY seq DESC LIMIT ?',
    ).all(n);
    rows.reverse(); // newest-N fetched DESC -> chronological for display
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      from: r.from_id,
      from_label: r.from_label,
      to: r.to_id,
      to_label: r.to_label,
      text: r.text,
    }));
  } catch (_) {
    return [];
  }
}

// Wipe the whole archive — the panel's "Vider" purges everything (live + archive),
// per the chosen semantics: clear means clear. Persistence guards against
// AUTOMATIC loss (restart / main.jsonl truncation), not a deliberate wipe.
function wipe() {
  const h = open();
  if (!h) return { ok: true }; // archive disabled -> nothing to wipe, treat as success
  try {
    h.exec('DELETE FROM messages;');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { archive, recent, wipe };
