// claude-deck — session-meta: bounded head+tail scan of one session .jsonl
// for the sidebar (cwd, branch, displayed title). Format drifts across Claude
// Code versions -> read defensively: parse line by line, ignore anything
// unexpected, never throw.
'use strict';

const fsp = require('fs/promises');
const { HEAD_BYTES, TAIL_BYTES } = require('./config');

// mtime cache: pay the head+tail read only for files that actually changed.
// stat() is near-free vs the 16K+64K reads; a rename appends a line -> mtime
// moves -> the entry self-invalidates (no manual busting needed). null metas
// are cached too (files without cwd would otherwise re-scan every refresh).
const metaCache = new Map(); // filePath -> { mtimeMs, meta }
let titleScans = 0; // observability: real tail-scans performed (probe + perf)

async function readSessionMeta(filePath, fileSize) {
  titleScans += 1;
  global.__deckTitleScans = titleScans;
  // Returns { cwd, gitBranch, summary } or null (no cwd found / unreadable).
  // Displayed title priority: custom-title (/rename) > ai-title > summary line
  // > first plain-text user prompt.
  const state = {
    cwd: null, gitBranch: null, summary: null, firstUserText: null,
    customTitle: null, aiTitle: null, entrypoint: null,
  };

  const scanChunk = (text, skipFirstLine) => {
    const lines = text.split('\n');
    if (skipFirstLine) lines.shift(); // tail chunk starts mid-line
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch (_) { continue; } // garbage or partial line
      if (!entry || typeof entry !== 'object') continue;

      // cwd/gitBranch are root-level fields of some entries (NOT guaranteed on line 1).
      if (!state.cwd && typeof entry.cwd === 'string' && entry.cwd) state.cwd = entry.cwd;
      // 'cli' = interactive session; 'sdk-cli' = headless (claude -p / Agent SDK).
      // The native /resume picker hides headless sessions — measured here: 13
      // 'cli' vs 45 'sdk-cli' in the workspace dir, matching the picker exactly.
      if (!state.entrypoint && typeof entry.entrypoint === 'string' && entry.entrypoint) {
        state.entrypoint = entry.entrypoint;
      }
      if (!state.gitBranch && typeof entry.gitBranch === 'string' && entry.gitBranch) {
        state.gitBranch = entry.gitBranch;
      }
      // Some Claude Code versions write {"type":"summary","summary":"..."} lines —
      // typically near the END of the file, hence the tail scan below.
      if (!state.summary && entry.type === 'summary' && typeof entry.summary === 'string') {
        state.summary = entry.summary;
      }
      // Title lines — verified on-disk format:
      // {"type":"custom-title","customTitle":"..."} (user /rename) and
      // {"type":"ai-title","aiTitle":"..."} (auto title). They are appended,
      // so the LAST occurrence wins: always overwrite (head scans before tail).
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
        state.customTitle = entry.customTitle.trim();
      }
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
        state.aiTitle = entry.aiTitle.trim();
      }
      // Fallback summary: first plain-text user prompt (skip XML command noise).
      if (!state.firstUserText && entry.type === 'user' && entry.message) {
        const content = entry.message.content;
        if (typeof content === 'string') {
          const text2 = content.trim();
          if (text2 && !text2.startsWith('<')) state.firstUserText = text2;
        }
      }
    }
  };

  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(Math.min(HEAD_BYTES, fileSize));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    scanChunk(head.toString('utf8', 0, bytesRead), false);

    // Summary AND title lines live near the end of the file -> always tail-scan
    // files larger than the head window (bounded read, never the whole file).
    if (fileSize > HEAD_BYTES) {
      const start = Math.max(HEAD_BYTES, fileSize - TAIL_BYTES);
      const tail = Buffer.alloc(fileSize - start);
      const res = await fh.read(tail, 0, tail.length, start);
      scanChunk(tail.toString('utf8', 0, res.bytesRead), true);
    }

    if (!state.cwd) return null;
    return {
      cwd: state.cwd,
      gitBranch: state.gitBranch,
      summary: state.customTitle || state.aiTitle || state.summary || state.firstUserText || null,
      // v28: exposed raw so sessions-list can tell a NATIVE title apart from a
      // deck-side pending creation name (native wins -> pending entry dropped).
      customTitle: state.customTitle,
      // Raw first user message — lineage key for sidebar dedup (NOT the display
      // title: two sessions of one lineage may differ in custom/ai titles).
      firstUserText: state.firstUserText,
      entrypoint: state.entrypoint,
    };
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { metaCache, readSessionMeta };
