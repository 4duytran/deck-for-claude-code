// claude-deck — transcripts: low-level session .jsonl access shared by the
// scan, the title injectors and the activity parse. Real on-disk format
// (verified on this machine): ~/.claude/projects/<encoded>/ contains FLAT
// <uuid>.jsonl files (one per session). There is NO sessions-index.json. The
// folder name encoding (slash->dash) is LOSSY, so the real cwd is read from
// inside each .jsonl instead (see session-meta.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECTS_ROOT, TAIL_BYTES } = require('./config');
const { sessionDirs } = require('./state');

// Locate a session's .jsonl across project dirs. Sync on purpose: the killAll
// path runs during before-quit, where pending async writes would be dropped.
// Fast path: the sidebar scan remembers each session's project dir
// (state.sessionDirs), so one existsSync confirms the hit. The map can be stale
// or lack the id (new session, resume fork, moved or deleted file): any miss or
// failed confirmation falls through to the full scan, which is the lookup of
// record. (Only an id whose file sits in TWO project dirs can differ: the map
// keeps the scan's last dir, the full scan returns the first in readdir order.)
function findSessionFile(sessionId) {
  const known = sessionDirs.get(sessionId);
  if (known) {
    const hit = path.join(known, `${sessionId}.jsonl`);
    if (fs.existsSync(hit)) return hit;
  }
  const root = PROJECTS_ROOT;
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(root, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* no projects dir yet */ }
  return null;
}

// Main transcript + sub-agent transcripts (they edit on the session's behalf
// — same discovery as the usage estimator, v35).
function sessionTranscripts(sessionId) {
  const main = findSessionFile(sessionId);
  if (!main) return [];
  const out = [main];
  try {
    const subDir = path.join(path.dirname(main), sessionId, 'subagents');
    for (const f of fs.readdirSync(subDir)) {
      if (f.endsWith('.jsonl')) out.push(path.join(subDir, f));
    }
  } catch (_) { /* no subagents dir */ }
  return out;
}

// Archived sub-agent transcripts: the compaction hook mv's subagents/ into
// <projectDir>/subagents-archive/<sid>/<ts>/. [{ dir, sig }] ascending by <ts> (YYYY-MM-DD-HHMMSS,
// lexical = chronological), sig = the dir's mtimeMs; [] when the session has no archive. Sync, stat-only.
// archiveDirsOf takes the main transcript (<sid>.jsonl) when the caller already resolved it.
function archiveDirsOf(mainFile) {
  const root = path.join(path.dirname(mainFile), 'subagents-archive', path.basename(mainFile, '.jsonl'));
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(root, n);
    try { out.push({ dir, sig: fs.statSync(dir).mtimeMs }); } catch (_) { /* removed while listing */ }
  }
  return out;
}
function sessionArchiveDirs(sessionId) {
  const main = findSessionFile(sessionId);
  return main ? archiveDirsOf(main) : [];
}

// v31: a native rename writes TWO lines — verified on disk (/rename inside
// claude appends custom-title AND agent-name with the same value; e.g. the
// TNRS / Renovate_04_juin sessions carry both). Claude reloads agent-name at
// boot and re-displays it, so updating only custom-title left the OLD name
// alive on the claude side (deck looked renamed, claude's own UI did not).
function titleLines(name, sessionId) {
  return JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }) + '\n'
       + JSON.stringify({ type: 'agent-name', agentName: name, sessionId }) + '\n';
}

// v32: shared bounded-tail reader for the close-time injectors — last on-disk
// custom-title VALUE (parsed per line: only a root-level type matches, title
// text inside message CONTENT can't) + trailing-newline flag for the glue
// guard. (Bound caveat: a title buried >64K from EOF is invisible here —
// accepted, cf. TAIL_BYTES.)
function readTailTitleState(filePath) {
  const st = fs.statSync(filePath);
  if (!st.size) return { lastTitle: null, endsNewline: true, empty: true };
  const start = Math.max(0, st.size - TAIL_BYTES);
  const tail = Buffer.alloc(st.size - start);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, tail, 0, tail.length, start); }
  finally { fs.closeSync(fd); }
  const text = tail.toString('utf8');
  let lastTitle = null;
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; } // partial first line, messages
    if (e && e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) {
      lastTitle = e.customTitle.trim();
    }
  }
  return { lastTitle, endsNewline: text.endsWith('\n'), empty: false };
}

function appendTitleLinesSync(filePath, name, sessionId, endsNewline) {
  let line = titleLines(name, sessionId);
  if (!endsNewline) line = '\n' + line; // never glue onto the last line
  fs.appendFileSync(filePath, line);
  // mtime moved -> metaCache self-invalidates; next scan reads the title.
}

module.exports = {
  findSessionFile,
  sessionTranscripts,
  sessionArchiveDirs,
  archiveDirsOf,
  titleLines,
  readTailTitleState,
  appendTitleLinesSync,
};
