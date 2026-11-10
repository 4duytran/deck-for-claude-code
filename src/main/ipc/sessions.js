// claude-deck — ipc/sessions: the sidebar scan (sessions-list) and the two
// session actions — rename (append custom-title + agent-name lines) & delete
// (trash move). Both actions refuse to touch a session that may be written
// by a live claude process (busy-guard in session-status.js).
'use strict';

const { ipcMain } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const {
  PROJECTS_ROOT, TRASH_DIR, UUID_RE, HEADLESS_ENTRYPOINTS,
} = require('../config');
const { sessionDirs, resumeIdMap, pendingNames, pendingRenames } = require('../state');
const { metaCache, readSessionMeta } = require('../session-meta');
const {
  readSessionStatusCached, reconcileOpenPanes, isSessionBusy, sessionLivenessSince,
} = require('../session-status');
const { sessionFlagsSync } = require('../session-activity');
const { findSessionFile, titleLines, readTailTitleState } = require('../transcripts');
const { setRoomLabel, refreshRegistry, writeSessionsSnapshot } = require('../rooms');

// P4 (2026-09-18): sidebar GROUP order, frozen at first scan for the life of
// the process — user's choice (widget mock, verbatim): "recalculé seulement
// au lancement / un nouveau projet apparaît en fin de liste". The mtime KEY
// stays live (any write still updates it), only the resulting POSITION is
// no longer recomputed from it after the first call. In-memory only (module
// state, not state.js — nothing persisted, no config key, dies with the
// process); reset on every app relaunch by construction.
let groupOrder = []; // ordered cwd keys, frozen positions
// F1 (review 2026-09-18): last directory a cwd was actually observed under —
// lets a purge tell a CONFIRMED absence (that directory listed cleanly, this
// cwd just wasn't in it) from an UNOBSERVED one (its directory failed to
// list, or a file inside it was skipped this scan) so a transient fs hiccup
// never gets read as "removed" and re-appended as a stale-position newcomer.
const cwdHomeDir = new Map(); // cwd -> dirPath

function registerSessionsIpc() {
  ipcMain.handle('session-rename', async (_e, { sessionId, newName } = {}) => {
    try {
      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return { ok: false, error: 'invalid sessionId' };
      }
      const name = typeof newName === 'string' ? newName.trim() : '';
      if (!name || name.length > 200) return { ok: false, error: 'nom vide ou trop long (max 200)' };
      if (isSessionBusy(sessionId)) {
        // v32: defer instead of refusing. A still-unwritten v28 creation name
        // shares the same injection point — just update it.
        if (pendingNames.has(sessionId)) {
          pendingNames.set(sessionId, name);
          return { ok: true, name, pending: true };
        }
        const livePath = findSessionFile(sessionId);
        if (!livePath) return { ok: false, error: 'session inconnue (refresh ?)' };
        const prev = pendingRenames.get(sessionId);
        // oldTitle anchors the value-based precedence guard; a re-rename keeps
        // the ORIGINAL on-disk anchor (disk hasn't moved since).
        const oldTitle = prev ? prev.oldTitle : readTailTitleState(livePath).lastTitle;
        pendingRenames.set(sessionId, { name, oldTitle });
        return { ok: true, name, pending: true };
      }
      const dir = sessionDirs.get(sessionId);
      if (!dir) return { ok: false, error: 'session inconnue (refresh ?)' };
      const filePath = path.join(dir, `${sessionId}.jsonl`);

      // Exact native line shapes, verified on disk: a native /rename appends
      // BOTH {"type":"custom-title",...} AND {"type":"agent-name",...} (v31).
      let line = titleLines(name, sessionId);

      // Defensive: if the file doesn't end with \n, don't glue onto the last line.
      const st = await fsp.stat(filePath);
      if (st.size > 0) {
        const fh = await fsp.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, st.size - 1);
          if (buf[0] !== 0x0a) line = '\n' + line;
        } finally {
          await fh.close().catch(() => {});
        }
      }
      // Single O_APPEND write — never rewrites the file.
      await fsp.appendFile(filePath, line);
      pendingRenames.delete(sessionId); // v32: a direct rename supersedes a stale pending
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session-delete', async (_e, { sessionId } = {}) => {
    try {
      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return { ok: false, error: 'invalid sessionId' };
      }
      if (isSessionBusy(sessionId)) {
        return { ok: false, error: 'session active — fermez-la avant de supprimer' };
      }
      const dir = sessionDirs.get(sessionId);
      if (!dir) return { ok: false, error: 'session inconnue (refresh ?)' };
      const src = path.join(dir, `${sessionId}.jsonl`);

      await fsp.mkdir(TRASH_DIR, { recursive: true });
      let dest = path.join(TRASH_DIR, `${sessionId}.jsonl`);
      try {
        await fsp.access(dest); // name taken (re-deleted after restore) -> timestamp suffix
        dest = path.join(TRASH_DIR, `${sessionId}.${Date.now()}.jsonl`);
      } catch (_) { /* free slot */ }

      try {
        await fsp.rename(src, dest); // same filesystem (~/.claude) -> atomic move
      } catch (err) {
        if (err && err.code === 'EXDEV') { // exotic mount split: copy then unlink
          await fsp.copyFile(src, dest);
          await fsp.unlink(src);
        } else {
          throw err;
        }
      }
      sessionDirs.delete(sessionId);
      metaCache.delete(src); // purge: a restored-then-rescanned file must re-read
      return { ok: true, trashedTo: dest };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('sessions-list', async () => {
    reconcileOpenPanes(); // FIX #2: punctual PID check on every refresh
    const root = PROJECTS_ROOT;
    const groups = new Map(); // cwd -> { project, cwd, sessions: [] }
    const seenPaths = new Set(); // cache hygiene: sweep entries of vanished files
    const uncleanDirs = new Set(); // dirPath entries this scan could not fully vouch for (F1)

    let dirs = [];
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch (_) {
      return []; // no ~/.claude/projects at all -> empty sidebar, not a crash
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(root, dir.name);

      let files = [];
      try { files = await fsp.readdir(dirPath); } catch (_) { uncleanDirs.add(dirPath); continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!UUID_RE.test(sessionId)) continue;

        const filePath = path.join(dirPath, file);
        let st;
        try { st = await fsp.stat(filePath); } catch (_) { uncleanDirs.add(dirPath); continue; }
        if (!st.isFile() || st.size === 0) { uncleanDirs.add(dirPath); continue; }

        let meta;
        const cached = metaCache.get(filePath);
        if (cached && cached.mtimeMs === st.mtimeMs) {
          meta = cached.meta; // unchanged file -> no tail-scan at all
        } else {
          meta = await readSessionMeta(filePath, st.size);
          metaCache.set(filePath, { mtimeMs: st.mtimeMs, meta });
        }
        seenPaths.add(filePath);
        if (!meta) continue;
        // Picker parity: hide headless sessions (claude -p / Agent SDK) like the
        // native /resume picker does. Defensive: missing or unknown entrypoint ->
        // keep (old Claude Code versions / new writers must never be hidden).
        if (meta.entrypoint && HEADLESS_ENTRYPOINTS.has(meta.entrypoint)) continue;
        sessionDirs.set(sessionId, dirPath); // FIX #1: remembered for resume snapshots
        cwdHomeDir.set(meta.cwd, dirPath); // F1: kept fresh every time this cwd is actually seen

        let group = groups.get(meta.cwd);
        if (!group) {
          group = { project: path.basename(meta.cwd), cwd: meta.cwd, sessions: [] };
          groups.set(meta.cwd, group);
        }
        // v28: a pending creation name overrides the summary until a NATIVE
        // custom-title exists (persisted at close, or a /rename inside claude).
        let summary = meta.summary || sessionId;
        const pending = pendingNames.get(sessionId);
        if (pending) {
          if (meta.customTitle) pendingNames.delete(sessionId); // native title landed
          else summary = pending;
        }
        // v32: a deferred rename overrides the display the same way. Dropped as
        // soon as the disk agrees (injected at close / native rename to the same
        // value) or a DIFFERENT native title landed (it wins, show the disk).
        let pendingRename = false;
        const pendingR = pendingRenames.get(sessionId);
        if (pendingR) {
          const t = meta.customTitle;
          if (t === pendingR.name || (t && t !== pendingR.oldTitle)) {
            pendingRenames.delete(sessionId);
          } else {
            summary = pendingR.name;
            pendingRename = true;
          }
        }
        // Feed the deck's display name into the room registry so `room who` and
        // the room panel show the SAME names as the sidebar (routing stays by
        // precise id). Only a REAL name overrides the spawn fallback — never the
        // bare sessionId.
        if (summary && summary !== sessionId) setRoomLabel(sessionId, summary);
        group.sessions.push({
          sessionId,
          summary,
          pendingRename,
          gitBranch: meta.gitBranch,
          mtimeMs: st.mtimeMs,
          lineageKey: meta.firstUserText || null, // dedup key, stripped before return
          // FIX #1: a resumed row reads its live status under the forked newId.
          // v33: cached — the watcher keeps it fresh, no disk read per row.
          status: readSessionStatusCached(resumeIdMap.get(sessionId) || sessionId),
          // v41: same id as the git/plans panels use on a sidebar row (raw
          // sessionId, see effectiveSessionId) — icon and panel must agree.
          // P3 (2026-09-18): liveness INJECTED here (never imported by
          // session-activity.js itself). sessionLivenessSince (sessionLiveness + the pane's spawn time), not
          // isSessionBusy: this runs once per row on every auto-refresh
          // scan and must hit the status CACHE like the rest of the display
          // path (v33 invariant, auto-refresh-probe t5) — isSessionBusy's
          // direct disk-read fallback is reserved for write-guards (rename/
          // delete above), never the display path.
          // Passed as a GETTER: session-activity calls it only for a row with a
          // non-terminal, non-silent agent entry (cache first, so a scan of rows
          // without one reads nothing) and again when a queued push fires, so a
          // pane that died meanwhile reads closed, never the captured verdict.
          flags: sessionFlagsSync(sessionId, () => sessionLivenessSince(sessionId)),
        });
      }
    }

    const out = [...groups.values()];
    for (const group of out) {
      group.sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
      // Lineage dedup (option A): `--resume` forks a fresh .jsonl per resume and
      // test harnesses re-run identical prompts — collapse rows sharing the same
      // exact first user message, keep the most recent. Files stay on disk
      // untouched (hidden rows remain restorable via any future un-dedup).
      // Trade-off (documented): distinct sessions started with a strictly
      // identical first prompt collapse visually too. Unknown lineage (no first
      // user text) is never collapsed.
      const seen = new Set();
      group.sessions = group.sessions
        .filter((s) => {
          if (!s.lineageKey) return true;
          if (seen.has(s.lineageKey)) return false;
          seen.add(s.lineageKey);
          return true;
        })
        .map(({ lineageKey, ...rest }) => rest); // no per-project cap (v11)
    }
    // Drop cache entries whose files vanished (trash moves, external deletions).
    for (const key of metaCache.keys()) {
      if (!seenPaths.has(key)) metaCache.delete(key);
    }
    // Freeze the GROUP order (session order inside a group is untouched,
    // still recency-sorted above, :225). A key already in groupOrder keeps
    // its recorded position no matter how its mtime moved since. A key
    // never seen before (first call, or a project appearing after having
    // been scanned out) is new: rank new keys among themselves by the same
    // recency rule as before, with a cwd tiebreak so the order never
    // depends on fsp.readdir's unordered enumeration, then append them at
    // the end.
    //
    // Purge is CONFIRMED-absence only (F1, review 2026-09-18): a cwd absent
    // from this scan is dropped from groupOrder (no hole in the output, no
    // stale resurrection if it comes back later — treated as NEW, t6) only
    // when its last-known directory listed CLEANLY this round. A cwd whose
    // directory failed to list, or lost a file to a stat failure/zero-length
    // skip this round, is NOT observed as removed — an unreadable dir looks
    // identical to a deleted one from here, so the scan cannot tell them
    // apart and must not guess; its slot is left untouched, ready to accept
    // the project back in the SAME position the moment the fs cooperates
    // again (t8). Without this, a transient readdir/stat hiccup would be
    // read as removal and the project would resurface pinned to the end of
    // the list for the rest of the process run — the exact reshuffle the
    // user reported, reintroduced through the back door.
    const currentKeys = new Set(out.map((g) => g.cwd));
    groupOrder = groupOrder.filter((cwd) => {
      if (currentKeys.has(cwd)) return true;
      const home = cwdHomeDir.get(cwd);
      if (home !== undefined && uncleanDirs.has(home)) return true; // unobserved -> keep the slot
      cwdHomeDir.delete(cwd); // confirmed absence -> forget its old home too
      return false;
    });
    const recorded = new Set(groupOrder);
    const newGroups = out.filter((g) => !recorded.has(g.cwd));
    newGroups.sort((a, b) => (b.sessions[0]?.mtimeMs || 0) - (a.sessions[0]?.mtimeMs || 0)
      || a.cwd.localeCompare(b.cwd));
    for (const g of newGroups) groupOrder.push(g.cwd);
    const orderIndex = new Map(groupOrder.map((cwd, i) => [cwd, i]));
    out.sort((a, b) => orderIndex.get(a.cwd) - orderIndex.get(b.cwd));
    refreshRegistry(); // room: persist any refreshed session names into registry.json
    writeSessionsSnapshot(out); // room: full live+idle snapshot for the CLI's `room sessions`
    return out;
  });
}

module.exports = { registerSessionsIpc };
