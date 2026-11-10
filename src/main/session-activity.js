// claude-deck — session-activity: THE one-pass transcript scan (v39.2/v40/v41).
// Session truth, not folder enumeration: parse the session transcript(s) for
// file-touching tool calls and derive (a) the git repos the session WROTE in,
// (b) the plans it made/consumed, (c) the sidebar presence flags. ONE parser,
// stamp-cached — extend it here, NEVER add a second transcript scan.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { UUID_RE } = require('./config');
const { ptys, resumeIdMap } = require('./state');
const { send } = require('./window');
const { sessionTranscripts, archiveDirsOf } = require('./transcripts');
const { normalizeLine } = require('./transcript-normalize'); // S2: per-session agent ledger
const { classifyOwnRecord, newOwnFold, foldOwnRecord, agentState } = require('./agent-lifecycle'); // K2 own-transcript evidence, K3 reducer

// File-WRITING tool calls — repo counts use WRITES only (v39.2 semantics).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'mcp__filesystem__write_file', 'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file']);
// v40: plans are session truth too — same one-pass transcript parse. A
// "plan" is (a) a */plans/*.{md,html,htm} file the session touched (WRITTEN = it made
// it, READ-only = it consumed one — an impl session driven by a plan), or
// (b) a native plan-mode exit (ExitPlanMode tool_use, plan markdown inline).
// No ExitPlanMode tool_use exists in any local transcript today (checked) —
// supported anyway: it is THE standard CC plan mechanism, ~10 lines here.
const READ_TOOLS = new Set(['Read', 'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_file', 'mcp__filesystem__read_multiple_files']);
const PLAN_PATH_RE = /\/plans\/[^/]+\.(?:md|html?)$/i;

// An agent run is shown from its EVIDENCE (contract K3, agent-lifecycle.js agentState), never from the
// session's liveness alone: a run with no terminal evidence reads `running` / `waiting` only while the
// session is positively live (liveness `true`), `closed` on positive death evidence (`false` = the deck's own
// PtyExit file), `unknown` (hidden) when liveness is `null` or the run's OWN transcript has been silent for
// this window. Liveness is a fact this module never imports: the caller injects it (see activityFlags below).
// MEASURED 2026-09-18 over local ~/.claude/projects/*.jsonl (files > 300KB,
// consecutive-line gaps under 2h to exclude cross-day/overnight breaks): the
// largest same-session gap between two transcript lines was 102.46 minutes —
// a long background dispatch or extended thinking stretch can leave the
// PARENT transcript untouched for well over the naive 15-minute default (a
// cited subagent in this very session ran 469s/~8min end to end, and other
// real dispatches clearly ran far longer without a parent-side append). Set
// at 3h, ~1.76x the measured 102.46min ceiling: enough margin for a slow
// dispatch, still tight enough to catch a pane left open and genuinely idle
// for half a workday.
// The same window also bounds how long a sub-agent's OWN transcript may stay
// silent before its cross-turn 'running' entry is dropped (see findAgentMeta).
const STALE_AGENT_MS = 3 * 60 * 60 * 1000;

// B28: a linked worktree holds a `.git` FILE, `gitdir: <main>/.git/worktrees/<name>`, whose
// `commondir` (relative to it) names `<main>/.git`: the worktree counts for <main>, so a repo and
// its worktrees are ONE project. Anything that does not parse to a live main working tree (garbage,
// dangling gitdir, no commondir = submodule, bare common dir) leaves `wt` itself the root.
function repoRootOf(wt) {
  try {
    const dotGit = path.join(wt, '.git');
    const st = fs.statSync(dotGit);
    if (!st.isFile() || st.size > 4096) return wt;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return wt;
    const gitdir = path.resolve(wt, m[1]);
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    return path.basename(common) === '.git' && fs.statSync(common).isDirectory() ? path.dirname(common) : wt;
  } catch (_) { return wt; }
}

// dir -> git root | null (memo, cross-session). Only a folder that EXISTS is trusted or stored: a
// removed worktree must not keep its root (rule 7), nor leave a null for a folder re-added later.
const gitRootCache = new Map();
function gitRootOf(dir) {
  if (gitRootCache.has(dir)) {
    if (fs.existsSync(dir)) return gitRootCache.get(dir);
    gitRootCache.delete(dir);
  }
  let cur = dir;
  let root = null;
  const walked = [];
  while (cur && cur !== path.dirname(cur)) {
    if (gitRootCache.has(cur) && fs.existsSync(cur)) { root = gitRootCache.get(cur); break; }
    walked.push(cur);
    if (fs.existsSync(path.join(cur, '.git'))) { root = repoRootOf(cur); break; }
    cur = path.dirname(cur);
  }
  for (const d of walked) if (fs.existsSync(d)) gitRootCache.set(d, root);
  return root;
}

// A write inside a LINKED worktree: the first `.git` up the tree is a FILE that repoRootOf maps to another
// tree. Returns { root: the folder holding that file, branch: <gitdir>/HEAD's branch, null when detached } or
// null. No memo: the branch must be read at fold time and a removed folder must not be trusted.
function worktreeRootOf(dir) {
  for (let cur = dir; cur && cur !== path.dirname(cur); cur = path.dirname(cur)) {
    const dotGit = path.join(cur, '.git');
    if (!fs.existsSync(dotGit)) continue;
    try {
      if (!fs.statSync(dotGit).isFile() || repoRootOf(cur) === cur) return null;
      const gitdir = path.resolve(cur, /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))[1]);
      const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8'));
      return { root: cur, branch: m ? m[1] : null };
    } catch (_) { return null; }
  }
  return null;
}

function planInlineTitle(markdown) {
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.length > 80 ? line.slice(0, 79) + '…' : line;
  }
  return 'plan (sans titre)';
}

// S2: per-session agent ledger — folded over files[0] (the main transcript)
// ONLY, inside the SAME line loop as the repo/plan scan below (D2: one pass,
// zero new IO). D4 prefilters: a cheap substring OR before the expensive
// JSON.parse + normalizeLine call, mirroring the '"tool_use"' fast-path
// pattern already used for the repo/plan scan. Rule 5 ("type":"user" without
// "tool_result") is what lets a genuine chat message through — the ledger
// needs it to find the CURRENT turn's start (C1 membership), using the same
// noise-filtered 'user' kind normalizeLine already computes. Rule 6 (a
// "tool_use_id" belonging to an already-known dispatch) is what lets a
// completion/result line through without parsing EVERY tool result in the
// session (Read/Bash/Edit results are typically the bulk of a transcript).
const LEDGER_TOOL_USE_ID_RE = /"tool_use_id":"([^"]+)"/;
function ledgerPrefilter(line, knownDispatchIds) {
  if (line.includes('"subagent_type"')) return true; // a dispatch (birth) line
  if (line.includes('"isAsync"')) return true; // an async-launch ACK result
  if (line.includes('"resumedAgentId"')) return true; // a SendMessage result that RESUMED an agent
  if (line.includes('task-notification')) return true; // bg completion signal
  if (line.includes('was stopped by the user')) return true; // the plain-text stop notice (no XML)
  if (line.includes('retrieval_status')) return true; // TaskOutput poll result
  if (line.includes('"type":"user"') && !line.includes('"tool_result"')) return true; // turn boundary
  const m = LEDGER_TOOL_USE_ID_RE.exec(line);
  return !!(m && knownDispatchIds.has(m[1])); // a result closing a KNOWN dispatch
}

// C2 state precedence (monotonic): LOWER rank wins. birth(4) < ack(3) <
// done(2) < blocked(1) — an is_error/failed/killed/stopped (1) beats a later
// completed (2) whatever the order; a duplicate or lower-rank event is a
// no-op (rank comparison below is the single enforcement point).
const LEDGER_RANK = { blocked: 1, done: 2, ack: 3, birth: 4 };
const LEDGER_BLOCKED_STATUS = new Set(['failed', 'killed', 'stopped']); // UD3: stopped reads "bloqué" too
// The reducer's `final` (K2): { status, ts (epoch ms | null), source } of the CURRENT run's last non-waiting
// notification, or of its clean / errored `result` (source 'result'). Cleared by applyResume.
function finalOf(status, ts, source) {
  const t = Date.parse(ts);
  return { status, ts: Number.isFinite(t) ? t : null, source };
}
// Resume (a SendMessage to a FINISHED agent, "Resuming agent …"): the agent
// starts a NEW run. Measured on a real transcript (agent a7e351ce02f57e895, 3
// resumes): that run's own <task-notification> carries the SendMessage call's
// id as its <tool-use-id> — NOT the original Agent dispatch id — and the
// previous run's notification can still land AFTER the resume line (queued,
// delivered one turn later; its `remove` line is even stamped after the
// resume). So a run is identified by its call id: `entry.runId` is the id of
// the call that started the CURRENT run (the dispatch id until a resume),
// `runOwner` maps each resume call id back to the entry's dispatch id, and an
// agentDone only closes the entry when it names the CURRENT run — a stale
// notification of an earlier run is a no-op (rule 7: never guess).
// Residual: after a resume, a completion that reaches the ledger ONLY through
// the agentId paths (a TaskOutput poll / a task-id-only notification, both
// resolved to the ORIGINAL dispatch id) no longer closes the entry. A stop does
// not always yield a <task-notification> either (measured: 5 of 7 user stops in
// the corpus emit none), so a stopped or dead resumed run closes through
// scheduleMetaCheck: own-transcript interrupt or silence, both since the resume.
function applyResume(ev, ledger, agentIdMap, runOwner, sessionId) {
  if (!ev.toolUseId || !agentIdMap || !runOwner) return;
  const key = agentIdMap.get(ev.resumedAgentId); // agentId -> dispatch id (Agent result)
  const entry = key ? ledger.get(key) : null;
  if (!entry) return; // unknown agent (peer session, name, spawn outside this transcript): rule 7, no-op
  if (entry.runId === ev.toolUseId) return; // duplicate of a resume already applied
  if (ev.ts && entry.endTs && ev.ts < entry.endTs) return; // older than the completion it would reopen
  runOwner.set(ev.toolUseId, key);
  entry.runId = ev.toolUseId;
  entry.state = 'running';
  entry.rank = LEDGER_RANK.birth; // reset: this run's own completion/kill/failure closes it again
  entry.startTs = ev.ts || entry.startTs; // fresh for the in-current-turn / silentOver (resume ts) gating
  entry.endTs = null;
  entry.final = null; // the previous run's completion and waiting notice never apply to this run (K2)
  entry.waitingTs = null;
  // A stop or a close read the PREVIOUS run's evidence: drop it, and bump the run
  // generation so a meta scan already in flight cannot close this new run. Only THIS session's tables:
  // another session may share the dispatch id (D-MS, D-MS2); no session id, no table touched.
  if (!sessionId) return;
  const own = closedKey(sessionId, key, '');
  for (const k of [...closedAtMemo.keys()]) if (k.startsWith(own)) closedAtMemo.delete(k);
  const mk = metaKey(sessionId, key);
  stoppedAtMemo.delete(mk);
  metaCheckedAt.delete(mk);
  metaResumed.add(mk);
  metaRunGen.set(mk, (metaRunGen.get(mk) || 0) + 1);
}
// The plain-text stop notice names the agent by DESCRIPTION only. It closes the entry only when
// exactly one RUNNING entry carries that description and was started at or before the notice;
// zero or several candidates are a no-op (rule 7: never guess). The twin forms of one stop
// (enqueue + attachment) find the entry already closed the second time.
function applyStopByDesc(ev, ledger) {
  const stopMs = Date.parse(ev.ts);
  if (!ev.description || !Number.isFinite(stopMs)) return;
  let hit = null;
  for (const entry of ledger.values()) {
    if (entry.state !== 'running' || entry.description !== ev.description) continue;
    const startMs = Date.parse(entry.startTs);
    if (!Number.isFinite(startMs) || startMs > stopMs) continue;
    if (hit) return; // ambiguous
    hit = entry;
  }
  if (!hit) return;
  hit.rank = LEDGER_RANK.blocked; // same final state as an XML 'stopped' notification
  hit.state = 'blocked';
  hit.endTs = ev.ts;
  hit.final = finalOf('stopped', ev.ts, 'notification');
}
function applyLedgerEvent(ev, ledger, knownDispatchIds, agentIdMap, runOwner, sessionId) {
  if (ev.kind === 'agentStoppedByDesc') { applyStopByDesc(ev, ledger); return; }
  if (ev.kind === 'tool' && ev.agentType && ev.id) {
    // rank 4 (birth): the dispatch itself. toolSummary() already resolves
    // 'description' for an Agent/Task input (measured: 859/859 real
    // dispatches, never shadowed by file_path/pattern) — no second field.
    knownDispatchIds.add(ev.id);
    if (!ledger.has(ev.id)) {
      ledger.set(ev.id, {
        toolUseId: ev.id, agentType: ev.agentType, description: ev.summary || '',
        state: 'running', startTs: ev.ts || null, endTs: null, rank: LEDGER_RANK.birth,
        runId: ev.id,
        final: null, waitingTs: null, // K2 evidence of the current run (finalOf; epoch ms of the last waiting notice)
        model: ev.model || null, // the alias the dispatch requested; activityFlags prefers the agent's own model
      });
    }
    return;
  }
  if (ev.kind === 'result' && ev.resumedAgentId) { applyResume(ev, ledger, agentIdMap, runOwner, sessionId); return; }
  if (ev.kind === 'result' && ev.toolUseId) {
    const entry = ledger.get(ev.toolUseId);
    if (!entry) return; // a result outside the ledger's known dispatches (rule 7: never guess)
    const rank = ev.isError ? LEDGER_RANK.blocked : (ev.ack ? LEDGER_RANK.ack : LEDGER_RANK.done);
    if (rank >= entry.rank) return; // C2: duplicate/lower-rank event = no-op
    entry.rank = rank;
    if (rank === LEDGER_RANK.blocked) { entry.state = 'blocked'; entry.endTs = ev.ts || entry.endTs; entry.final = finalOf('failed', ev.ts, 'result'); }
    else if (rank === LEDGER_RANK.done) { entry.state = 'done'; entry.endTs = ev.ts || entry.endTs; entry.final = finalOf('completed', ev.ts, 'result'); }
    // rank === ack: stays 'running' (async-launch ACK is not a completion)
    return;
  }
  if (ev.kind === 'agentDone' && ev.toolUseId) {
    // A resumed run's notification names the SendMessage call id: resolve it
    // to its entry, then only the CURRENT run may close it (see applyResume).
    const entry = ledger.get((runOwner && runOwner.get(ev.toolUseId)) || ev.toolUseId);
    if (!entry) return;
    if (entry.runId !== ev.toolUseId) return; // stale notification of an earlier run
    const blocked = LEDGER_BLOCKED_STATUS.has(ev.status);
    const rank = blocked ? LEDGER_RANK.blocked : LEDGER_RANK.done; // 'completed' -> done
    if (rank >= entry.rank) return;
    entry.rank = rank;
    entry.state = blocked ? 'blocked' : 'done';
    entry.endTs = ev.ts || entry.endTs;
    entry.final = finalOf(blocked ? ev.status : 'completed', ev.ts, 'notification');
    return;
  }
  if (ev.kind === 'agentWaiting' && ev.toolUseId) {
    // K2 waitingTs: the last waiting notice of the CURRENT run (same key resolution as agentDone). It never
    // touches `rank` / `state`: a waiting agent is not finished, and a terminal entry stays terminal.
    const entry = ledger.get((runOwner && runOwner.get(ev.toolUseId)) || ev.toolUseId);
    if (!entry || entry.runId !== ev.toolUseId) return;
    const t = Date.parse(ev.ts);
    if (Number.isFinite(t) && (entry.waitingTs === null || t > entry.waitingTs)) entry.waitingTs = t;
  }
}

// Shared predicate: is this ledger entry's dispatch within the CURRENT turn
// (or is turn-boundary tracking off, lastRealUserTs === null)? Used by BOTH
// C1 membership (ledgerAgents, below) and the post-liveness gate
// (activityFlags) — kept as ONE function so the two can never drift apart.
function inCurrentTurn(entry, lastRealUserTs) {
  return lastRealUserTs === null
    || (entry.startTs !== null && entry.startTs >= lastRealUserTs);
}

// C1 membership: the CURRENT turn's agents (startTs >= the session's last
// genuine chat 'user' message) plus every agent still "en cours" from an
// earlier turn — a finished/blocked agent from an OLDER turn drops off.
// `rank` is fold-internal bookkeeping only, never exposed on the entry.
// Sorted startTs DESC (newest dispatch first). NOTE: this is the raw C1 set,
// cached as part of sessionActivity()'s stamp-invalidated result — it does
// NOT apply the P3 liveness gate (that depends on "now" + the caller's
// liveness fact, neither of which the transcript stamp tracks, so gating
// here would serve a stale verdict after a session closes with no new
// transcript write). activityFlags() applies that gate on every call.
function ledgerAgents(ledger, lastRealUserTs) {
  return [...ledger.values()]
    .filter((e) => e.state === 'running' || inCurrentTurn(e, lastRealUserTs))
    .map(({ rank, runId, final, waitingTs, ...entry }) => entry)
    .sort((a, b) => String(b.startTs || '').localeCompare(String(a.startTs || '')));
}

// Max mtime across a session's transcript file(s) — the "transcript recently
// active" half of the P3 liveness gate. Reuses the same fs.statSync calls
// activityStamp() already does (below); kept separate so a stamp-cache hit
// still gets a fresh mtime read on every activityFlags() call (liveness must
// never be served from a stale cache — see STALE_AGENT_MS comment above).
function maxMtimeMs(files) {
  let max = 0;
  for (const f of files) {
    try { const m = fs.statSync(f).mtimeMs; if (m > max) max = m; } catch (_) { /* racing writer */ }
  }
  return max || null;
}

// Lot P3 fix (2026-09-18) + deck-ghost-bg-agents (2026-10-12): per-agent
// evidence read, found through the agent's dispatch meta.json
// (agent-<agentId>.meta.json, matched by meta.toolUseId): the meta carries
// stoppedByUser === true (the user interrupted it) -> the `stoppedAt` fact
// (runStoppedAt). The other half, an agent killed by a CLI restart (no
// <task-notification>, no stoppedByUser; measured: session 5ac19a62, 3 ghosts
// "en cours" for 5 days) whose OWN transcript just stops growing, is
// `silentOver` of evaluateAgents: read from the record timestamps of the fold
// (L3a), not from file mtimes, and it hides the run (`unknown`) without closing it.
// Missing evidence never closes: no meta, no own transcript anywhere, or any
// copy that cannot be read (its mtime could be the newest) keeps the entry, so
// a genuinely long-running agent is only touched once it has been truly
// silent (see STALE_AGENT_MS comment above for the measured window).
// The ARCHIVE LOCATION alone is NOT a death signal: the compaction hook
// (session-start--recover-after-compact.sh) mv's EVERY file of subagents/ into
// subagents-archive/<sid>/<ts>/ — live agents included, mtime preserved, and
// the next write lands in either place — hence "newest mtime across all
// copies", never "found in the archive".
// scanMetaDir/findAgentMeta/archiveDirsNewestFirst duplicate
// ipc/transcript.js:579-597's resolveAgentFile two-phase resolution (live
// subagents/ dir first, then subagents-archive/<sid>/<ts>/ newest-first)
// rather than importing it, to keep the main-process module graph acyclic
// (claude-deck/CLAUDE.md § Module architecture). Unlike resolveAgentFile
// (ARCHIVE_MAX_DIRS = 64), the archive walk here is deliberately UNCAPPED.
// Residual (Tier 2 review, 2026-09-18, corrected): the uncovered population
// is not only "an agent that dies without going through the interrupt
// handler" — measured corpus-wide, 4 of 48 metas carrying
// stoppedByUser: true have NO toolUseId field at all, so the strict
// `meta.toolUseId === toolUseId` match below never finds them either and
// those entries never close (roughly 8% of interrupted agents). A
// filename/agentId-based correlation fallback would close this second
// population too, but adding one is an open user decision, not built here.
// A ghost stays visible up to STALE_AGENT_MS after its last write; nothing is final
// any more: a run hidden for silence comes back with the next record it writes.
const META_FILE_RE = /^agent-(.+)\.meta\.json$/;
async function scanMetaDir(dir, toolUseId) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return null; } // dir absent/racing writer
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue; // the stoppedByUser path matches any meta by toolUseId (unchanged)
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (meta && meta.toolUseId === toolUseId) {
      const m = META_FILE_RE.exec(n); // agentId only from an agent-<id>.meta.json name; else null (no own-transcript step)
      return { meta, agentId: m ? m[1] : null, file: path.join(dir, n) };
    }
  }
  return null;
}
// findAgentMeta walks EVERY archive dir, no cap: a ghost never closes by itself and only
// ages, so any fixed cap eventually makes its meta unreachable for good (measured: 100 dirs,
// ghost metas at index 64/75/78). Miss cost 70-99 ms, throttled by META_CHECK_COOLDOWN_MS.
const subagentsDirOf = (mainFile) => path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
// Every subagents-archive/<sid>/<ts>/ dir, newest first: timestamp dirs are
// `YYYY-MM-DD-HHMMSS` (measured on disk) — lexical sort IS chronological
// sort; reverse -> newest first. [] = no archive for this session; null = the
// archive root exists but cannot be listed (unknown).
async function archiveDirsNewestFirst(mainFile, sid) {
  const archiveRoot = path.join(path.dirname(mainFile), 'subagents-archive', sid);
  let dirents;
  try { dirents = await fsp.readdir(archiveRoot, { withFileTypes: true }); } catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
  return dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    .sort().reverse().map((n) => path.join(archiveRoot, n));
}
// -> { meta, agentId } (agentId = the meta file's name, agent-<agentId>.meta.json; null for any other
// *.meta.json name) | null
async function findAgentMeta(mainFile, sid, toolUseId) {
  const live = await scanMetaDir(subagentsDirOf(mainFile), toolUseId);
  if (live) return live;
  const dirs = await archiveDirsNewestFirst(mainFile, sid);
  if (!dirs) return null;
  for (const dir of dirs) {
    const hit = await scanMetaDir(dir, toolUseId);
    if (hit) return hit;
  }
  // No meta anywhere -> caller must NOT close (silence never closes). Also
  // returned when a meta DOES exist but lacks toolUseId (measured 4/48 of
  // stoppedByUser:true metas) — the strict match above skips it, same as
  // true silence; see the residual note on findAgentMeta above.
  return null;
}
// Newest copy ({ mtimeMs, file }) of the agent's OWN transcript across the live
// subagents/ dir and EVERY archive dir (no cap: stat-only, the newest copy decides).
// null = no evidence: no copy at all, or any copy / the archive root that
// cannot be read (ENOENT/ENOTDIR just mean "this dir does not hold it").
async function ownTranscriptNewest(mainFile, sid, agentId) {
  const archived = await archiveDirsNewestFirst(mainFile, sid);
  if (!archived) return null;
  const name = `agent-${agentId}.jsonl`;
  let newest = null;
  for (const dir of [subagentsDirOf(mainFile), ...archived]) {
    const file = path.join(dir, name);
    try {
      const m = (await fsp.stat(file)).mtimeMs;
      if (newest === null || m > newest.mtimeMs) newest = { mtimeMs: m, file };
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return null; // unreadable copy: its mtime could be the newest
    }
  }
  return newest;
}
// Timestamp (ms) of a transcript's LAST record when it is a user text "[Request interrupted
// by user…" (also "… for tool use]"); null otherwise, or when it cannot be read whole (a
// last line longer than the tail window, a half-written line): unknown never closes.
const INTERRUPT_PREFIX = '[Request interrupted by user';
const LAST_RECORD_TAIL_BYTES = 256 * 1024;
async function lastInterruptTsMs(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, LAST_RECORD_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    const rec = JSON.parse(lines[lines.length - 1]);
    const c = rec && rec.type === 'user' && rec.message ? rec.message.content : null;
    const text = typeof c === 'string' ? c
      : (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === 'text' ? c[0].text : null);
    if (typeof text !== 'string' || !text.startsWith(INTERRUPT_PREFIX)) return null;
    const t = Date.parse(rec.timestamp);
    return Number.isFinite(t) ? t : null;
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const sessionActivityCache = new Map(); // sessionId -> { stamp, repos, plans, agents }
// Invalidation key shared by the cache and the v41 sync flags probe: any
// transcript append moves mtime+size -> stamp differs -> recompute (which
// resumes from the per-file byte offsets, see the incremental fold below).
// The archived ts dirs add their mtimes (a moved/added/removed file moves its dir) plus the files of the
// NEWEST dir and of the watched older dirs: an agent still running at compaction keeps appending to its moved
// file, which does not move the dir.
// A14: `watch` = the archive dirs whose files can still grow without moving their dir mtime (the session's
// archiveWatch, see foldArchive); each adds its file signature beside the newest dir's.
function activityStamp(files, watch) {
  try {
    const live = files.map((f) => { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; }).join('|');
    const dirs = archiveDirsOf(files[0]);
    if (!dirs.length) return live;
    const newest = dirs[dirs.length - 1].dir;
    let extra = '';
    if (watch && watch.size) {
      for (const d of dirs) if (d.dir !== newest && watch.has(d.dir)) extra += `|${d.dir}:${archiveFilesSig(d.dir)}`;
    }
    return `${live}|${dirs.map((d) => `${d.dir}:${d.sig}`).join('|')}|${archiveFilesSig(newest)}${extra}`;
  } catch (_) { return ''; /* racing writer — just recompute */ }
}
// Name, mtime and size of an archive dir's transcripts, name-sorted ('' when unreadable).
function archiveFilesSig(dir) {
  return archiveNames(dir).map((n) => {
    try { const s = fs.statSync(path.join(dir, n)); return `${n}:${s.mtimeMs}:${s.size}`; } catch (_) { return `${n}:?`; }
  }).join(',');
}
function archiveNames(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch (_) { return []; }
}

// ---- Incremental fold (deck-lag P3, 2026-10-12) ------------------------------
// Re-reading and re-folding every byte of a 66 MB transcript after each append
// cost ~170 ms of main-thread CPU (keys pass through the main process, so the
// deck lagged while typing). The fold is now RESUMABLE:
//   * per transcript file: the byte offset after its last complete line, a short
//     fingerprint of the bytes right before it, and its OWN partial fold
//     (git-root counts, touched files, plan touches, inline plans);
//   * the agent ledger state (main transcript only: agentIdMap, ledger,
//     knownDispatchIds, runOwner, lastRealUserTs), carried across passes;
//   * the partials are MERGED at read time in sessionTranscripts() order, which
//     is exactly the order a from-zero fold visits them (first-seen Map order for
//     the count ties, "last touch wins" for plan ts), so an append to an earlier
//     file after a later one was folded cannot reorder anything.
// A pass reads only [offset, EOF) of the files whose mtime+size moved. A file
// that no longer extends what was folded (shrunk, other inode, bytes behind the
// offset changed) rebuilds the whole session from byte 0. An unterminated last
// line is folded only when it is already a whole JSON value (what a from-zero
// fold does with it); otherwise the offset stays at its start and the next pass
// re-reads it once its newline lands. Equivalence with the from-zero fold is
// pinned by .scratch/session-activity-incremental-probe.js.
// ARCHIVE (deck-mr-fixes A): the session's archived agent transcripts (subagents-archive/<sid>/<ts>/*.jsonl) join
// the repo/plan fold as ONE partial per ts dir, stamped by the dir mtime, refolded from byte 0 when the dir moves
// (plus the newest dir, and the one that was newest at the last pass, when a file of it grew). They merge in ts
// order BEFORE the live files; the ledger is not fed, and their mtimes never reach lastTouchedMs.
// Pinned by .scratch/session-archive-repos-probe.js.
const FOLD_CHUNK_BYTES = 4 * 1024 * 1024; // bounds a cold pass's memory and yields the event loop between chunks
const FP_BYTES = 256; // fingerprint: the last bytes before a file's offset, re-checked on every resume
const foldStateCache = new Map(); // sessionId -> { mainFile, led, files: Map<path, per-file fold>, archive: Map<dir, { sig, fsig, partial }>, archiveNewest }
const foldLocks = new Map(); // sessionId -> tail of the passes queued for it (a pass mutates the fold state)

function newLedgerFold(sessionId) {
  return {
    sessionId,                   // D-MS: scopes the closedAtMemo clear of a resume to this session
    agentIdMap: new Map(),       // S2: agentId -> toolUseId (ACK correlation)
    ledger: new Map(),           // S2: toolUseId -> ledger entry (files[0] only)
    knownDispatchIds: new Set(), // S2: dispatch ids seen so far (D4 result-line gate)
    runOwner: new Map(),         // S2: SendMessage resume call id -> dispatch id (resumed run's notification key)
    lastRealUserTs: null,        // S2: last genuine chat 'user' ts -> current-turn boundary (C1)
  };
}
function newPartial() {
  return {
    counts: new Map(),    // git root -> touched-file event count
    touched: new Map(),   // git root -> Set<root-relative path> (v55 file scope)
    wtSeen: new Map(),    // main root -> Map<linked worktree root, { count, branch (last seen) }>
    planFiles: new Map(), // abs plan path -> { written, events, ts }
    inlinePlans: [],      // { content, ts } from ExitPlanMode
  };
}
function newFileFold() {
  return { dev: null, ino: null, sig: null, offset: 0, fp: Buffer.alloc(0), ...newPartial() };
}
const fileSig = (st) => `${st.mtimeMs}:${st.size}`; // same terms as activityStamp()
function advanceFp(fp, processed) { // the last FP_BYTES bytes ending at the new offset (always a copy)
  const joined = processed.length >= FP_BYTES ? processed : Buffer.concat([fp, processed]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - FP_BYTES)));
}

// Folds the complete lines appended to `file` since ff.offset into ff (and, for
// the main transcript, into led). Returns 'ok', 'skip' (unreadable right now:
// it contributes nothing, like the old readFile catch) or 'rewound' (the file no
// longer extends what was folded; nothing was touched, the caller rebuilds).
// K2: a sub-agent's OWN transcript (agent-<id>.jsonl, never the main one) also feeds ff.own = { agentId, fold },
// resumed with the file's offset; null for every other file.
const OWN_FILE_RE = /^agent-(.+)\.jsonl$/;
async function foldFile(file, ff, led, isMain) {
  if (ff.own === undefined) {
    const m = isMain ? null : OWN_FILE_RE.exec(path.basename(file));
    ff.own = m ? { agentId: m[1], fold: newOwnFold() } : null;
  }
  let fh;
  let st;
  try { fh = await fsp.open(file, 'r'); st = await fh.stat(); } catch (_) { if (fh) await fh.close().catch(() => {}); return 'skip'; }
  try { return await foldOpenFile(fh, st, ff, led, isMain); } finally { await fh.close().catch(() => {}); }
}

async function foldOpenFile(fh, st, ff, led, isMain) {
  const { counts, touched, planFiles, inlinePlans } = ff;
  const { agentIdMap, ledger, knownDispatchIds, runOwner, sessionId } = led;
  const own = ff.own ? ff.own.fold : null;
  if (ff.ino === null) { ff.dev = st.dev; ff.ino = st.ino; }
  if (st.dev !== ff.dev || st.ino !== ff.ino || st.size < ff.offset) return 'rewound';
  if (ff.fp.length) { // the bytes right before the offset must still be the ones that were folded
    const probe = Buffer.allocUnsafe(ff.fp.length);
    const got = await fh.read(probe, 0, probe.length, ff.offset - probe.length);
    if (got.bytesRead !== probe.length || !probe.equals(ff.fp)) return 'rewound';
  }
  ff.sig = fileSig(st); // taken BEFORE the read: a file that grows meanwhile just moves its signature again
  if (st.size === ff.offset) return 'ok';
  const chunk = Buffer.allocUnsafe(Math.min(FOLD_CHUNK_BYTES, st.size - ff.offset));
  let pos = ff.offset;
  let pending = Buffer.alloc(0); // bytes after the last newline read so far; always starts at ff.offset
  for (;;) {
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
    const eof = bytesRead === 0;
    let data = pending;
    let lines = [];
    let consumed = 0; // bytes of `data` that become part of ff.offset
    if (!eof) {
      data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const nl = data.lastIndexOf(0x0a); // never inside a multi-byte UTF-8 sequence
      if (nl >= 0) { lines = data.toString('utf8', 0, nl).split('\n'); consumed = nl + 1; }
    } else if (pending.length) {
      // End of file inside a line: a from-zero fold would process it, so take it
      // when it is already a whole JSON value; a cut-short one waits for its newline.
      const tail = pending.toString('utf8');
      try { JSON.parse(tail); lines = [tail]; consumed = pending.length; } catch (_) { /* partial line */ }
    }
    // A3/finding20: the ledger fold is scoped to the MAIN transcript ONLY —
    // the repo/plan fold still walks every entry of sessionTranscripts()
    // (main + subagents/*.jsonl); without the isMain guard a rotated/sidechain
    // transcript in files[1..] would double-count an agent or resurrect one
    // already purged from files[0].
    for (const line of lines) {
      if (own) foldOwnRecord(own, classifyOwnRecord(line));
      if (isMain && ledgerPrefilter(line, knownDispatchIds)) {
        for (const ev of normalizeLine(line, agentIdMap)) {
          applyLedgerEvent(ev, ledger, knownDispatchIds, agentIdMap, runOwner, sessionId);
          if (ev.kind === 'user' && ev.ts) led.lastRealUserTs = ev.ts;
        }
      }
      if (!line.includes('"tool_use"')) continue; // cheap pre-filter (estimator pattern)
      let entry;
      try { entry = JSON.parse(line); } catch (_) { continue; }
      const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      const content = entry && entry.message && Array.isArray(entry.message.content)
        ? entry.message.content : [];
      for (const block of content) {
        if (!block || block.type !== 'tool_use') continue;
        if (block.name === 'ExitPlanMode') {
          const plan = block.input && block.input.plan;
          if (typeof plan === 'string' && plan.trim()) inlinePlans.push({ content: plan, ts });
          continue;
        }
        const isWrite = WRITE_TOOLS.has(block.name);
        const isRead = READ_TOOLS.has(block.name);
        if (!isWrite && !isRead) continue;
        const input = block.input || {};
        const cands = [input.file_path, input.path, input.source, input.destination];
        if (Array.isArray(input.paths)) cands.push(...input.paths); // read_multiple_files
        for (const p of cands) {
          if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
          const isPlan = PLAN_PATH_RE.test(p);
          // repo counts: WRITES only (v39.2), MINUS plan files (v54). A plan
          // write (*/plans/*.{md,html,htm}) is bookkeeping an agent may scatter
          // into a SEPARATE docs repo on EVERY coding session; it is already
          // surfaced on the plans axis (plans[] + the sidebar 'plans' flag), so
          // counting its container repo here phantom-lists that docs repo as a
          // "touched project" in the git panel picker. A repo with ANY real
          // (non-plan) write still counts; only plan-ONLY repos drop out.
          // ASSUMPTION: PLAN_PATH_RE matches a FLAT plans layout
          // (plans/<slug>.md, .html or .htm; an html plan is a plan too and
          // stays out of the repo count). If plans are ever NESTED (plans/<sub>/x.md)
          // the regex stops matching -> such a write counts again -> the
          // phantom docs repo silently returns. Keep plans flat, or widen
          // PLAN_PATH_RE in lockstep.
          if (isWrite && !isPlan) {
            const root = gitRootOf(path.dirname(p));
            if (root) {
              counts.set(root, (counts.get(root) || 0) + 1);
              let set = touched.get(root);
              if (!set) { set = new Set(); touched.set(root, set); }
              set.add(path.relative(root, p)); // v55: exact file, for git-panel scope
              const wt = worktreeRootOf(path.dirname(p));
              if (wt) {
                let seen = ff.wtSeen.get(root);
                if (!seen) { seen = new Map(); ff.wtSeen.set(root, seen); }
                const w = seen.get(wt.root) || { count: 0, branch: null };
                w.count += 1;
                w.branch = wt.branch;
                seen.set(wt.root, w);
              }
            }
          }
          if (isPlan) {
            const e = planFiles.get(p) || { written: false, events: 0, ts: null };
            e.events += 1;
            if (isWrite) e.written = true;
            if (ts) e.ts = ts; // last touch wins
            planFiles.set(p, e);
          }
        }
      }
    }
    if (consumed) { ff.fp = advanceFp(ff.fp, data.subarray(0, consumed)); ff.offset += consumed; }
    pending = eof ? Buffer.alloc(0) : Buffer.from(data.subarray(consumed)); // a copy: `chunk` is reused by the next read
    pos += bytesRead;
    if (eof) break;
  }
  return 'ok';
}

// Brings the session's fold state up to date with the files on disk and returns
// it. Runs inside the per-session lock (see sessionActivity below).
async function foldSession(sessionId, files) {
  let state = foldStateCache.get(sessionId);
  if (state && state.mainFile !== files[0]) state = null; // another main transcript: nothing carries over
  const kept = state
    ? { archive: state.archive, archiveNewest: state.archiveNewest, archiveWatch: state.archiveWatch }
    : { archive: new Map(), archiveNewest: null, archiveWatch: new Set() };
  for (let attempt = 0; attempt < 2; attempt++) {
    // the archive partials do not depend on the main transcript: a rebuild of the live files keeps them
    if (!state) state = { mainFile: files[0], led: newLedgerFold(sessionId), files: new Map(), ...kept };
    foldStateCache.delete(sessionId); // an exception below must never leave a half-folded state behind
    for (const f of [...state.files.keys()]) if (!files.includes(f)) state.files.delete(f); // a subagent transcript that went away
    let rewound = false;
    for (const file of files) {
      let ff = state.files.get(file);
      if (!ff) { ff = newFileFold(); state.files.set(file, ff); } // a new transcript folds from byte 0
      else { try { if (ff.sig === fileSig(fs.statSync(file))) continue; } catch (_) { /* unreadable: foldFile decides */ } } // not moved since its last fold
      let verdict;
      try { verdict = await foldFile(file, ff, state.led, file === files[0]); } catch (e) {
        if (!e || typeof e.code !== 'string') throw e; // a fold bug must surface; only an I/O error (EISDIR, EIO…) skips the file, as the old readFile catch did
        verdict = 'skip';
      }
      if (verdict === 'rewound') { rewound = true; break; }
      if (verdict === 'skip') { state.files.delete(file); if (file === files[0]) state.led = newLedgerFold(sessionId); }
    }
    if (!rewound) {
      await foldArchive(state);
      foldStateCache.set(sessionId, state);
      return state;
    }
    state = null; // truncated / replaced / rewritten behind the offset: rebuild every file from byte 0
  }
  return null; // unreachable: a state built from scratch cannot rewind
}

// Archived agent transcripts: one partial per ts dir, refolded (every file from byte 0) only when the dir is new or
// moved. A running agent's append leaves the dir mtime alone, so the newest dir, and the dir that was newest at the
// last pass, are also compared on their file signature. Gone dirs drop out. Keyed on the file path: the same file
// name in two ts dirs is a resumed agent and counts twice.
async function foldArchive(state) {
  const dirs = archiveDirsOf(state.mainFile);
  const newest = dirs.length ? dirs[dirs.length - 1].dir : null;
  const next = new Map();
  for (const { dir, sig } of dirs) {
    const old = state.archive.get(dir);
    // A14: an older dir holding an own file that can still grow (state.archiveWatch) is compared on its file signature too
    const cur = dir === newest || dir === state.archiveNewest || state.archiveWatch.has(dir) ? archiveFilesSig(dir) : null;
    if (old && old.sig === sig && (cur === null || cur === old.fsig)) { next.set(dir, old); continue; }
    const fsig = cur === null ? archiveFilesSig(dir) : cur; // taken BEFORE the reads: a file that grows meanwhile moves it again
    next.set(dir, { sig, fsig, partial: await foldArchiveDir(dir, state.led) });
  }
  state.archive = next;
  state.archiveNewest = newest;
  state.archiveWatch = watchedArchiveDirs(next);
}
// A14: the dirs holding an own file whose last record is within STALE_AGENT_MS of now, terminal or not: after 3 h of
// own silence the run reads `unknown` anyway, and killed agents (no tail) would otherwise keep their dir watched
// forever. Residual R6: a resume appended more than 3 h later to an archived file is missed until its dir moves
// (never a false « en cours » / « Interrompu »). Recomputed each pass.
function watchedArchiveDirs(archive) {
  const watch = new Set();
  const now = Date.now();
  for (const [dir, { partial }] of archive) {
    for (const { fold } of partial.owns) {
      if (fold.lastTs !== null && now - fold.lastTs <= STALE_AGENT_MS) {
        watch.add(dir);
        break;
      }
    }
  }
  return watch;
}
async function foldArchiveDir(dir, led) {
  const partial = newPartial();
  partial.owns = []; // [{ agentId, fold }] of the dir's agent-<id>.jsonl files, replaced with the dir's refold
  for (const name of archiveNames(dir)) {
    const ff = newFileFold();
    let verdict;
    try { verdict = await foldFile(path.join(dir, name), ff, led, false); } catch (e) {
      if (!e || typeof e.code !== 'string') throw e; // same rule as the live files: only an I/O error skips the file
      verdict = 'skip';
    }
    if (verdict === 'ok') { mergePartial(partial, ff); if (ff.own) partial.owns.push(ff.own); }
  }
  return partial;
}

// ownByAgent: agentId -> { lastTs, terminalTs, openChildren }, the newest copy by lastTs across the archive dirs
// (ascending) and the live files; a tie goes to the later copy (newer dir, then live). A copy with no usable
// record (lastTs null) is no evidence.
function reduceOwn(state, files) {
  const best = new Map();
  const take = (o) => {
    if (!o || o.fold.lastTs === null) return;
    const cur = best.get(o.agentId);
    if (!cur || o.fold.lastTs >= cur.lastTs) best.set(o.agentId, o.fold);
  };
  for (const { partial } of state.archive.values()) for (const o of partial.owns) take(o);
  for (const file of files) { const ff = state.files.get(file); if (ff) take(ff.own); }
  const out = new Map();
  for (const [id, f] of best) out.set(id, { lastTs: f.lastTs, terminalTs: f.terminalTs, openChildren: f.openChildren });
  return out;
}

// Adds `src` into `acc`: counts and plan events sum, "last touch wins" for a plan ts, in call order.
function mergePartial(acc, src) {
  for (const [root, n] of src.counts) acc.counts.set(root, (acc.counts.get(root) || 0) + n);
  for (const [root, set] of src.touched) {
    let merged = acc.touched.get(root);
    if (!merged) { merged = new Set(); acc.touched.set(root, merged); }
    for (const p of set) merged.add(p);
  }
  for (const [root, seen] of src.wtSeen) { // copies: `src` is a cached per-file fold, `acc` is mutated by later merges
    let merged = acc.wtSeen.get(root);
    if (!merged) { merged = new Map(); acc.wtSeen.set(root, merged); }
    for (const [wtRoot, w] of seen) {
      const m = merged.get(wtRoot);
      if (m) { m.count += w.count; m.branch = w.branch; } else merged.set(wtRoot, { count: w.count, branch: w.branch });
    }
  }
  for (const [p, e] of src.planFiles) {
    const merged = acc.planFiles.get(p) || { written: false, events: 0, ts: null };
    merged.events += e.events;
    if (e.written) merged.written = true;
    if (e.ts) merged.ts = e.ts;
    acc.planFiles.set(p, merged);
  }
  for (const ip of src.inlinePlans) acc.inlinePlans.push(ip);
}

// The partials combined in the order a from-zero fold visits them: archive ts dirs ascending, then the live files.
function mergeFolds(state, files) {
  const acc = newPartial();
  for (const { partial } of state.archive.values()) mergePartial(acc, partial);
  for (const file of files) {
    const ff = state.files.get(file);
    if (ff) mergePartial(acc, ff);
  }
  return acc;
}

// The archive dirs the session's last pass watches (A14); undefined while a pass holds the state (a stamp built
// without them differs from the cached one, so that call just queues behind the pass).
const watchOf = (sessionId) => { const s = foldStateCache.get(sessionId); return s ? s.archiveWatch : undefined; };

async function sessionActivity(sessionId) {
  const files = sessionTranscripts(sessionId);
  if (!files.length) return { repos: [], plans: [], agents: [] };
  const stamp = activityStamp(files, watchOf(sessionId));
  const hit = sessionActivityCache.get(sessionId);
  if (hit && stamp && hit.stamp === stamp) return hit;
  // Passes of one session run one after the other: a pass mutates the fold state,
  // and a call queued behind it usually finds the fresh result already cached.
  const pass = (foldLocks.get(sessionId) || Promise.resolve()).then(() => computeActivity(sessionId));
  const gate = pass.catch(() => {});
  foldLocks.set(sessionId, gate);
  try { return await pass; } finally { if (foldLocks.get(sessionId) === gate) foldLocks.delete(sessionId); }
}

async function computeActivity(sessionId) {
  const files = sessionTranscripts(sessionId);
  if (!files.length) return { repos: [], plans: [], agents: [] };
  const stamp = activityStamp(files, watchOf(sessionId)); // taken BEFORE the reads: a transcript that grows meanwhile misses the next lookup
  const hit = sessionActivityCache.get(sessionId);
  if (hit && stamp && hit.stamp === stamp) return hit; // a pass queued ahead of this one already did the work
  const state = await foldSession(sessionId, files);
  const { counts, touched, wtSeen, planFiles, inlinePlans } = mergeFolds(state, files);
  const { ledger, lastRealUserTs } = state.led;
  const repos = [...counts.entries()]
    .map(([root, count]) => {
      const entry = { root, name: path.basename(root), count,
        files: [...(touched.get(root) || [])].sort() }; // v55: session file scope
      const seen = wtSeen.get(root);
      if (seen && seen.size) { // linked worktrees written in; `live` is added at read time (sessionTouchedRepos)
        entry.worktrees = [...seen].map(([wtRoot, w]) => ({ root: wtRoot, count: w.count, branch: w.branch }))
          .sort((a, b) => b.count - a.count || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
      }
      return entry;
    })
    .sort((a, b) => b.count - a.count);
  const plans = [
    ...[...planFiles.entries()].map(([p, e]) => ({
      kind: 'file', path: p, name: path.basename(p),
      written: e.written, events: e.events, ts: e.ts,
    })),
    ...inlinePlans.map((ip) => ({
      kind: 'inline', content: ip.content, name: planInlineTitle(ip.content),
      written: true, events: 1, ts: ip.ts,
    })),
    // ts DESC (ISO sorts lexically); name ASC tiebreaker — null-ts entries
    // must keep a TOTAL order or the list/get index contract drifts.
  ].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))
    || a.name.localeCompare(b.name));
  const agents = ledgerAgents(ledger, lastRealUserTs); // S2: C1-filtered, startTs DESC
  // lastTouchedMs/lastRealUserTs: P3 liveness gate inputs, carried on the
  // cached result so activityFlags() can re-derive "is this entry cross-turn"
  // and "is the transcript fresh" on every call without a second parse.
  const agentIds = new Map([...state.led.agentIdMap].map(([agentId, toolUseId]) => [toolUseId, agentId])); // dispatch id -> agentId
  const ownByAgent = reduceOwn(state, files); // K2: agentId -> { lastTs, terminalTs, openChildren }; the join to a dispatch id is the consumer's
  // The reducer's per-run evidence, snapshotted (the ledger entries mutate on the next pass): dispatch id -> { runId, final, waitingTs }
  const agentEv = new Map(agents.map(({ toolUseId }) => {
    const e = ledger.get(toolUseId);
    return [toolUseId, { runId: e.runId, final: e.final ? { ...e.final } : null, waitingTs: e.waitingTs }];
  }));
  const out = { stamp, repos, plans, agents, agentIds, ownByAgent, agentEv, lastTouchedMs: maxMtimeMs(files), lastRealUserTs };
  sessionActivityCache.set(sessionId, out);
  return out;
}

// `live` is derived on EVERY read (fs stats only), never kept in the stamp cache: removing a worktree
// does not move the transcript stamp. A main-only entry is returned as is (no `worktrees` key).
async function sessionTouchedRepos(sessionId) {
  return (await sessionActivity(sessionId)).repos.map((r) => (r.worktrees
    ? { ...r, worktrees: r.worktrees.map((w) => ({ ...w, live: repoRootOf(w.root) === r.root })) }
    : r));
}

async function sessionPlans(sessionId) {
  return (await sessionActivity(sessionId)).plans;
}

// v41: sidebar presence icons — two binary flags derived from the SAME
// one-pass activity parse (never a second transcript mechanism):
//   git   = the session WROTE >=1 file inside a git repo (repos[], v39.2
//           write-only semantics — exactly what the git panel shows on click)
//   plans = the session CREATED >=1 plan (written=true: write tool on
//           */plans/*.{md,html,htm}, or native ExitPlanMode). A plan only READ does
//           NOT light the icon — created != consulted.
// liveness (K5), INJECTED by the caller, this module never imports session-status.js / state.js:
//   - a FUNCTION (ipc: () => sessionLivenessSince(sid)) is called when the verdict is computed, never captured, at most
//     ONCE per computation and only when a run is non-terminal on liveness-independent evidence and not silentOver;
//     its result is kept when true / false / null, anything else (or a throw) is null; it may also return
//     `{ live, sinceMs }` (D-PB): `live` as above, `sinceMs` the spawn time of the live deck pane holding the session;
//   - a raw VALUE is `true` only when `=== true`; false, undefined or a number is null (M1: a captured boolean can
//     never close a live run, so `false` reaches the reducer from a function only).
// Returns { live: true | false | null, sinceMs: number | null }, `sinceMs` only beside `live === true`.
function normalizeLiveness(liveness) {
  const fn = typeof liveness === 'function';
  let v = liveness;
  if (fn) {
    try { v = liveness(); } catch (_) { return { live: null, sinceMs: null }; }
  }
  let sinceMs = null;
  if (v !== null && typeof v === 'object') { sinceMs = Number.isFinite(v.sinceMs) ? v.sinceMs : null; v = v.live; }
  const live = v === true || (fn && v === false) ? v : null;
  return { live, sinceMs: live === true ? sinceMs : null };
}

// closedAtMemo (K2, D-MS): `sessionId:dispatchId:runId` -> Date.now() of the first computation that saw the run
// non-terminal with sessionLive === false (the deck's PtyExit file); never set on null; dropped by applyResume for its
// own session only. A death is a fact about one session, and two sessions can share a dispatch id (a forked transcript),
// so a call with no session id neither reads nor writes it. stoppedAtMemo (M5, D-MS2): `sessionId:dispatchId` (metaKey)
// -> ms of the user stop of the CURRENT run, fed by scheduleMetaCheck. The meta tables below (stoppedAtMemo,
// metaCheckedAt, metaInFlight, metaResumed, metaRunGen) share that key and the same rule: a stop, a resume or a scan in
// one session never touches a same-dispatch-id run of another, and a call with no session id reads and writes none.
const closedKey = (sessionId, dispatchId, runId) => `${sessionId}:${dispatchId}:${runId}`;
const metaKey = (sessionId, dispatchId) => `${sessionId}:${dispatchId}`;
const closedAtMemo = new Map();
const stoppedAtMemo = new Map();

// The agentId behind a dispatch id: the ACK's (agentIds), else the one the model check learnt from the agent's meta.
function agentIdOf(activity, toolUseId) {
  const id = activity.agentIds && activity.agentIds.get(toolUseId);
  if (id) return id;
  const c = agentModelCache.get(toolUseId);
  return (c && c.agentId) || null;
}

// Every C1 entry through the K3 reducer: [{ e, runId, res: { state, endTs, reason } }]. `silentOver` = nothing
// written by the run's own transcript (or since its start / resume) for STALE_AGENT_MS. The liveness function is
// asked once, memoized for the whole pass, and only for an entry that is still non-terminal when the session is
// assumed live (K3 rule 1, or re-opened by rule 2); a silentOver entry takes `null` (Q-H1) and never asks.
function evaluateAgents(activity, liveness, sessionId) {
  const rows = [];
  const entries = activity.agents || [];
  if (!entries.length) return rows;
  const now = Date.now();
  let verdict; let sinceMs = null; let asked = false;
  const sessionLive = () => {
    if (!asked) { asked = true; const r = normalizeLiveness(liveness); verdict = r.live; sinceMs = r.sinceMs; }
    return verdict;
  };
  // K6: a cross-turn entry is believed `running` / `waiting` only while the session's transcript was touched within
  // STALE_AGENT_MS (a pane left open and idle for half a day shows no old background agent); no mtime proves nothing.
  const staleSession = !(typeof activity.lastTouchedMs === 'number' && now - activity.lastTouchedMs <= STALE_AGENT_MS);
  for (const e of entries) {
    const ev = (activity.agentEv && activity.agentEv.get(e.toolUseId)) || {};
    const runId = ev.runId || e.toolUseId;
    const agentId = agentIdOf(activity, e.toolUseId);
    const own = (agentId && activity.ownByAgent && activity.ownByAgent.get(agentId)) || null;
    const startMs = Date.parse(e.startTs);
    const seen = Math.max(own && Number.isFinite(own.lastTs) ? own.lastTs : -Infinity, Number.isFinite(startMs) ? startMs : -Infinity);
    // Silence needs an own transcript to be silent: with none joined (no ACK agentId, no meta yet) nothing was
    // observed, and missing evidence never hides a run (rule 7), as the previous own-silence rule already held.
    const silentOver = own !== null && Number.isFinite(seen) && now - seen > STALE_AGENT_MS;
    const key = sessionId ? closedKey(sessionId, e.toolUseId, runId) : null; // null: no session, no memo
    const mk = sessionId ? metaKey(sessionId, e.toolUseId) : null;
    const facts = {
      sessionLive: true, silentOver,
      closedAt: key !== null && closedAtMemo.has(key) ? closedAtMemo.get(key) : null,
      stoppedAt: mk !== null && stoppedAtMemo.has(mk) ? stoppedAtMemo.get(mk) : null,
    };
    const entry = { startTs: e.startTs, final: ev.final || null, waitingTs: ev.waitingTs === undefined ? null : ev.waitingTs };
    // D-OT: the agent's own terminal tail wins over a parent-side waiting notice (K3 rule 4); `waiting` comes from
    // the own fold (tail with open children) or from a notice while the own fold holds no terminal tail.
    let res = agentState(entry, own, facts);
    if (res.state === 'running' || res.state === 'waiting') { // no terminal evidence: the session's liveness decides
      let live = silentOver ? null : sessionLive();
      // D-PB: a run dies with its CLI process. The live pane was spawned after both the start and the last own record of
      // this run: the process that ran it is gone, and nothing written since says the agent came back (an own record
      // after the spawn would). Same death as a PtyExit close, so the closed memo below keeps the first sighting.
      const lastOwn = own && Number.isFinite(own.lastTs) ? own.lastTs : -Infinity;
      const diedWithProcess = live === true && sinceMs !== null && Number.isFinite(startMs) && startMs < sinceMs && lastOwn < sinceMs;
      if (diedWithProcess) live = false;
      if (live !== true) {
        res = agentState(entry, own, { ...facts, sessionLive: live });
        if (key !== null && live === false && res.state === 'closed' && res.endTs === null) closedAtMemo.set(key, Date.now());
      }
    }
    if (staleSession && (res.state === 'running' || res.state === 'waiting') && !inCurrentTurn(e, activity.lastRealUserTs)) {
      res = { state: 'unknown', endTs: null, reason: 'stale-session' };
    }
    rows.push({ e, runId, res });
  }
  return rows;
}

// K5: the state of every C1 entry of a session's CACHED fold, keyed by dispatch id (and by the resume call id of a
// resumed run). Empty while the session has no cached pass.
function agentStatesOf(sessionId, liveness) {
  const out = new Map();
  const activity = sessionActivityCache.get(sessionId);
  if (!activity) return out;
  for (const { e, runId, res } of evaluateAgents(activity, liveness, sessionId)) {
    out.set(e.toolUseId, res);
    if (runId !== e.toolUseId) out.set(runId, res);
  }
  return out;
}

// Payload membership (K4): C1 as before, with the lifecycle state in place of the ledger one. An in-current-turn
// entry stays unless it reads `unknown` (a `closed` one stays, so the journal header reads « Interrompu »); a
// cross-turn entry stays only while `running` / `waiting` (a closed, finished or unknown one drops off; a stale
// session reads `unknown` for it, K6 in evaluateAgents). The
// non-terminal ones are handed to the model / stop-evidence checks, whose later pushes recompute with `liveness`.
function activityFlags(activity, liveness, sessionId) {
  const rows = evaluateAgents(activity, liveness, sessionId); // the K6 freshness gate is applied there, so agentStatesOf agrees
  const agents = rows.filter(({ e, res }) => (inCurrentTurn(e, activity.lastRealUserTs)
    ? res.state !== 'unknown'
    : res.state === 'running' || res.state === 'waiting'));
  if (sessionId) {
    for (const { e, res } of agents) {
      if (res.state === 'running') scheduleModelCheck(sessionId, e.toolUseId, activity.agentIds, liveness);
      if (res.state === 'running' || res.state === 'waiting') scheduleMetaCheck(sessionId, e.toolUseId, liveness, e.startTs);
    }
  }
  return {
    git: activity.repos.length > 0,
    plans: activity.plans.some((p) => p.written),
    // v41.1: meta line segment — the MOST touched repo (repos[] is already
    // count-DESC) + how many others. Replaces the gitBranch 'HEAD' noise
    // (the no-branch literal CC records when the cwd has no real branch —
    // 13533/13533 entries on this machine).
    repo: activity.repos.length ? activity.repos[0].name : null,
    repoCount: activity.repos.length,
    // S2: per-session agent ledger (C1 membership) with the K3 lifecycle state —
    // empty array = nothing to show, never a guess (rule 7). A run whose
    // session liveness is unknown reads `unknown` and is left out.
    // model: string | null on every entry (see agentModel below).
    agents: agents.map(({ e, res }) => ({ ...e, state: res.state, model: agentModel(e) })),
  };
}

// sessions-list never parses here: cache hit (stamp match) -> flags inline;
// miss -> null (indeterminate -> the renderer shows NOTHING, never a false
// positive) + a SEQUENTIAL background queue computes then pushes
// 'session-flags' (filled in place, same pattern as the status badge).
// One transcript at a time: cold start over the whole corpus (measured
// 146MB / ~50ms per 20MB file) spreads out instead of spiking memory.
// P3 fix: meta-check memo/dedupe, mirroring flagsInFlight/flagsQueue below.
// The four tables below and stoppedAtMemo are keyed by metaKey(sessionId, dispatchId) (D-MS2).
// stoppedAtMemo (declared with the reducer inputs above): ms of the
// user's stop of the current run, the only evidence this check reads (silence
// is the caller's `silentOver` now, computed from the fold).
// metaCheckedAt: ms timestamp of the last check — a NEGATIVE
// memo so a genuinely running agent (no stoppedByUser, own transcript still
// being written) is re-scanned on a COOLDOWN, not on every activityFlags()
// call. Cooldown = 5 minutes: a live agent's meta.json sits in the LIVE
// subagents/ dir (small, typically <10 entries) until an external harness
// sweep archives it, so a legitimately-running agent costs one readdir of
// that dir per check -> 12 checks/hour = 12 extra readdir calls/hour (plus a
// JSON.parse per entry in that dir), and, when no stoppedByUser is found, one
// archive-root readdir + one stat per archive dir — cheap, and tight enough
// that a real close is still detected within 5 minutes of the next
// sessions-list scan.
const META_CHECK_COOLDOWN_MS = 5 * 60 * 1000;
const metaCheckedAt = new Map();
const metaInFlight = new Set();
// metaResumed: the agents a SendMessage RESUMED (applyResume). meta.json and
// the agent's own transcript are shared by every run of an agent, so for these the stop is
// read against the resume ts (R = entry.startTs): (1') meta.stoppedByUser AND the own
// transcript's LAST record an interrupt stamped >= R (the flag alone can be a stop BEFORE
// the resume). metaRunGen counts the resumes: a scan that began before one cannot stop
// the new run.
const metaResumed = new Set();
const metaRunGen = new Map();
// M5: ms of the user's stop of the CURRENT run (the `stoppedAt` fact of the reducer), or null.
// resumeMs: null = original run, else the resume ts (NaN = unknown).
//   (1)  meta.stoppedByUser, not resumed: the ts of the own transcript's last interrupt record,
//        else the meta file's mtime (wall-clock fallback);
//   (1') resumed: the interrupt record, and only when it is stamped >= the resume.
// Missing evidence is no stop. An own record newer than this ts re-opens the run (K3 rule 2).
async function runStoppedAt(found, mainFile, sessionId, resumeMs) {
  if (!found || found.meta.stoppedByUser !== true) return null;
  const resumed = resumeMs !== null;
  if (resumed && !Number.isFinite(resumeMs)) return null; // no resume ts: the old run's evidence cannot be told apart
  const own = found.agentId !== null ? await ownTranscriptNewest(mainFile, sessionId, found.agentId) : null;
  const t = own ? await lastInterruptTsMs(own.file) : null;
  if (resumed) return t !== null && t >= resumeMs ? t : null;
  if (t !== null) return t;
  try { return (await fsp.stat(found.file)).mtimeMs; } catch (_) { return null; }
}
function scheduleMetaCheck(sessionId, toolUseId, liveness, startTs) {
  if (!sessionId) return; // the tables are per session: no session id, no scan and no memo
  const mk = metaKey(sessionId, toolUseId);
  if (metaInFlight.has(mk)) return; // a scan is already running for it
  const last = metaCheckedAt.get(mk);
  if (last !== undefined && (Date.now() - last) < META_CHECK_COOLDOWN_MS) return; // cooldown
  metaInFlight.add(mk);
  const gen = metaRunGen.get(mk) || 0;
  const sameRun = () => (metaRunGen.get(mk) || 0) === gen; // resumed meanwhile: that evidence is the old run's
  const resumeMs = metaResumed.has(mk) ? Date.parse(startTs || '') : null;
  const files = sessionTranscripts(sessionId);
  const mainFile = files[0];
  (mainFile ? findAgentMeta(mainFile, sessionId, toolUseId) : Promise.resolve(null))
    .then(async (found) => {
      const stoppedAt = await runStoppedAt(found, mainFile, sessionId, resumeMs);
      if (!sameRun()) return;
      metaCheckedAt.set(mk, Date.now());
      if (stoppedAt !== null) {
        stoppedAtMemo.set(mk, stoppedAt);
        try {
          const hit = sessionActivityCache.get(sessionId);
          if (hit) send('session-flags', { sessionId, ...activityFlags(hit, liveness, sessionId) });
        } catch (_) { /* no window / push failed -> the next sync call still applies the stop */ }
      }
    })
    .catch(() => { if (sameRun()) metaCheckedAt.set(mk, Date.now()); })
    .finally(() => { metaInFlight.delete(mk); });
}

// Sub-agent model. Per agent: the model of the LATEST assistant record of its OWN transcript (the model
// that ran), else the alias the dispatch requested (entry.model, folded with the ledger), else null.
// The own transcript is read (tail only) for entries shown `running`, re-read only when its mtime+size
// moved; a model learnt after the first push reaches the renderer through the same session-flags
// re-push as scheduleMetaCheck.
const MODEL_CHECK_MS = 3000; // gap between two checks of a running agent's own transcript
const MODEL_LOOKUP_RETRY_MS = 5000; // gap while its agentId / own transcript cannot be found yet
const MODEL_TAIL_BYTES = 256 * 1024;
const agentModelCache = new Map(); // dispatch id -> { agentId, key (own file + mtime + size), model, found, at }
const modelInFlight = new Set();
const agentModel = (e) => {
  const c = agentModelCache.get(e.toolUseId);
  return (c && c.model) || e.model || null;
};
// Model of the last type:"assistant" record in the file's tail; other record types may carry a
// "model" too and are ignored, as is the "<synthetic>" placeholder. null = none found / unreadable.
async function lastAssistantModel(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, MODEL_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // the window starts mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"assistant"')) continue;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
      const m = rec && rec.type === 'assistant' && rec.message ? rec.message.model : null;
      if (typeof m === 'string' && m && !m.startsWith('<')) return m;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}
function scheduleModelCheck(sessionId, toolUseId, agentIds, liveness) {
  if (modelInFlight.has(toolUseId)) return;
  const prev = agentModelCache.get(toolUseId) || { agentId: null, key: null, model: null, found: false, at: 0 };
  if (Date.now() - prev.at < (prev.found ? MODEL_CHECK_MS : MODEL_LOOKUP_RETRY_MS)) return;
  modelInFlight.add(toolUseId);
  const mainFile = sessionTranscripts(sessionId)[0];
  (async () => {
    const next = { ...prev };
    let agentId = prev.agentId || (agentIds && agentIds.get(toolUseId)) || null;
    if (!agentId && mainFile) { // a running foreground agent has no Agent result yet: its meta names the agentId
      const hit = await findAgentMeta(mainFile, sessionId, toolUseId);
      agentId = hit ? hit.agentId : null;
    }
    const own = agentId && mainFile ? await ownTranscriptNewest(mainFile, sessionId, agentId) : null;
    next.agentId = agentId;
    next.found = !!own;
    if (own) {
      let size = -1;
      try { size = (await fsp.stat(own.file)).size; } catch (_) { /* racing writer: the next check re-reads */ }
      const key = `${own.file}:${own.mtimeMs}:${size}`;
      if (key !== prev.key) {
        next.key = key;
        next.model = (await lastAssistantModel(own.file)) || prev.model;
      }
    }
    next.at = Date.now();
    agentModelCache.set(toolUseId, next);
    if (next.model !== prev.model) {
      try {
        const hit = sessionActivityCache.get(sessionId);
        if (hit) send('session-flags', { sessionId, ...activityFlags(hit, liveness, sessionId) });
      } catch (_) { /* no window / push failed -> the next scan carries the model */ }
    }
  })()
    .catch(() => { agentModelCache.set(toolUseId, { ...prev, at: Date.now() }); })
    .finally(() => { modelInFlight.delete(toolUseId); });
}

const flagsInFlight = new Set(); // sessionId queued/running (dedupe)
let flagsQueue = Promise.resolve();
// liveness: the session's liveness fact, INJECTED by the call site (see activityFlags: a function is read when the
// verdict is computed, so the queued push below sees the liveness of the moment it fires, never the one captured
// here; a raw value is `true` only when `=== true`). A third argument (the old SessionEnd thunk) is ignored.
function sessionFlagsSync(sessionId, liveness) {
  const files = sessionTranscripts(sessionId);
  if (!files.length) return { git: false, plans: false, agents: [] }; // no transcript -> nothing
  const stamp = activityStamp(files, watchOf(sessionId)); // the same terms as the cached stamp, or every call would miss
  const hit = sessionActivityCache.get(sessionId);
  if (hit && stamp && hit.stamp === stamp) return activityFlags(hit, liveness, sessionId);
  if (!flagsInFlight.has(sessionId)) {
    flagsInFlight.add(sessionId);
    flagsQueue = flagsQueue.then(async () => {
      try {
        const flags = activityFlags(await sessionActivity(sessionId), liveness, sessionId);
        send('session-flags', { sessionId, ...flags });
      } catch (_) { /* unreadable -> stays indeterminate (never crash) */ }
      flagsInFlight.delete(sessionId);
    });
  }
  return null; // indeterminate for now — the push will fill the icons
}

// A pane's effective session: the resumed id when CC re-keyed it (same
// reconciliation as isSessionBusy).
function effectiveSessionId({ paneId, sessionId } = {}) {
  if (typeof sessionId === 'string' && UUID_RE.test(sessionId)) return sessionId;
  const entry = ptys.get(String(paneId || ''));
  if (entry && entry.sessionId) return resumeIdMap.get(entry.sessionId) || entry.sessionId;
  return null;
}

module.exports = {
  sessionActivity,
  sessionTouchedRepos,
  sessionPlans,
  sessionFlagsSync,
  effectiveSessionId,
  activityFlags, // exported for the session-activity-probe.js P3 gates
  agentStatesOf, // K5: the lifecycle state of every C1 entry of a session's cached fold
};
