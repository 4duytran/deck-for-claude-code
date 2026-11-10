// test/session-activity-probe.js — HERMETIC probe for the P3 meta-close
// fix in src/main/session-activity.js: a cross-turn 'running' ledger entry
// (a background dispatch whose completion event never landed) must close
// ONLY on POSITIVE evidence, of two kinds: (1) its own dispatch's meta.json
// carrying stoppedByUser === true; (2) (deck-ghost-bg-agents, 2026-10-12) its
// OWN transcript agent-<agentId>.jsonl (agentId = the meta file's name) silent
// for longer than STALE_AGENT_MS — newest mtime across the live subagents/ dir
// and EVERY subagents-archive/<sid>/<ts>/ dir (the compaction hook mv's live
// agents into the archive too, so the archive location alone proves nothing).
// It must NEVER close on missing evidence: a meta with no stoppedByUser and no
// readable own transcript anywhere, or no meta file at all, leaves the entry
// running (the accepted behavior for a genuinely long-running agent). A
// resumed agent is judged against its resume ts (ghost-agent-probe.js). Also proves F1 (Tier 2 review, RPN 480)
// and its successor (deck-ghost-archive-cap, 2026-10-27): findAgentMeta's
// archive walk has NO cap — a matching meta in the 70th newest archive dir (past
// the old 64 cap, measured ghost metas at index 64/75/78 of a 100-dir session)
// must still close the entry.
//
// Builds its own throwaway session fixtures (fs.mkdtempSync +
// CLAUDE_DECK_PROJECTS_DIR/CLAUDE_DECK_STATUS_DIR seams, same convention as
// test/sidebar-agents-probe.js) — never depends on the user's live
// ~/.claude/projects corpus.
//
// Run: cd claude-deck && node_modules/.bin/electron test/session-activity-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- hermetic fixtures (built BEFORE app boot) -----------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-session-activity-probe-'));
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });

const SID_CLOSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // meta carries stoppedByUser:true -> must close
const SID_STAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // meta carries NO stoppedByUser -> must stay (over-fire guard)

// L3b: fixtures are dated relative to NOW. Silence is measured from the RECORD timestamps of the fold (K2 silentOver),
// no longer from file mtimes, so a dispatch dated 2026-09-18 would now be silent whatever its mtime says.
const T0 = Date.now() - 60 * 60 * 1000;
const tsAt = (i, shift = 0) => new Date(T0 + shift + i * 60000).toISOString();
const ts = (i) => tsAt(i);
const ASYNC_ACK_TEXT = 'Async agent launched successfully in the background.';

function dispatchLine(id, agentType, desc, t) {
  return {
    type: 'assistant', timestamp: t,
    message: { content: [{ type: 'tool_use', id, name: 'Task',
      input: { subagent_type: agentType, description: desc, run_in_background: true } }] },
  };
}
function resultLine(id, text, t, agentId) {
  // Measured real shape (task evidence): Agent tool_use followed by a
  // tool_result whose toolUseResult carries isAsync:true + status
  // "async_launched" — no sync result, no agentDone ever follows.
  return {
    type: 'user', timestamp: t,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    toolUseResult: { isAsync: true, agentId, status: 'async_launched' },
  };
}
function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// Cross-turn dangling dispatch (same shape as sidebar-agents-probe.js's
// crossTurnDangleFixture): a background dispatch that only ever gets an
// async-launch ACK, followed by a SECOND real user message so the dispatch
// falls out of C1 (current-turn) membership into the P3 liveness-gated
// fallback branch that this fix changes.
// agentId: the ACK's agentId, which the fold joins to the agent's own file (agent-<agentId>.jsonl) as the real ACK does.
function fixture(sid, toolUseId, shift = 0, agentId = `agent_${toolUseId}`) { // shift: ms added to every ts (an old dispatch whose own evidence decides)
  const file = path.join(projDir, `${sid}.jsonl`);
  writeJsonl(file, [
    { type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: tsAt(0, shift), message: { role: 'user', content: `start-${sid}` } },
    dispatchLine(toolUseId, 'py-dev', 'Appliquer les decisions', tsAt(1, shift)),
    resultLine(toolUseId, ASYNC_ACK_TEXT, tsAt(2, shift), agentId),
    { type: 'user', cwd: base, timestamp: tsAt(3, shift), message: { role: 'user', content: `continue-${sid}` } },
  ]);
  return file;
}
const TU_CLOSE = 'toolu_close_1';
const TU_STAY = 'toolu_stay_1';
const fileClose = fixture(SID_CLOSE, TU_CLOSE);
const fileStay = fixture(SID_STAY, TU_STAY);

// Live subagents/ meta sidecar — exact shape measured in the task evidence,
// matched by meta.toolUseId === toolUseId (never a filename parse).
function writeMeta(mainFile, toolUseId, metaExtra) {
  const dir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    agentType: 'py-dev', description: 'Appliquer les decisions',
    toolUseId, spawnDepth: 1, requestShape: 'background', requestNonInteractive: true,
    ...metaExtra,
  };
  fs.writeFileSync(path.join(dir, `agent-${toolUseId}.meta.json`), JSON.stringify(meta));
}
writeMeta(fileClose, TU_CLOSE, { stoppedByUser: true });
writeMeta(fileStay, TU_STAY, {}); // no stoppedByUser field at all

// F1 (Tier 2 review, RPN 480): findAgentMeta's archive walk must reach the
// OLDEST generation. 25 archive timestamp dirs (> the pre-fix cap of 20),
// matching meta placed in the OLDEST (rank 25 after the reverse-chronological
// sort scanMetaDir/findAgentMeta apply). The beyond-64 case below (SID_BEYOND)
// pins the removal of the later 64 cap.
function writeArchiveMeta(mainFile, sid, tsDir, toolUseId, metaExtra) {
  const dir = path.join(path.dirname(mainFile), 'subagents-archive', sid, tsDir);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    agentType: 'py-dev', description: 'Appliquer les decisions',
    toolUseId, spawnDepth: 1, requestShape: 'background', requestNonInteractive: true,
    ...metaExtra,
  };
  fs.writeFileSync(path.join(dir, `agent-${toolUseId}.meta.json`), JSON.stringify(meta));
}
function padArchiveDirs(mainFile, sid, tsDirs) {
  for (const tsDir of tsDirs) {
    fs.mkdirSync(path.join(path.dirname(mainFile), 'subagents-archive', sid, tsDir), { recursive: true });
  }
}
const SID_DEEP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // meta lives in the 25th (oldest) archive generation
const TU_DEEP = 'toolu_deep_1';
const fileDeep = fixture(SID_DEEP, TU_DEEP);
// Dir names sort lexically = chronologically; 25 generations, one per day.
const archiveDirNames = Array.from({ length: 25 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}-000000`);
padArchiveDirs(fileDeep, SID_DEEP, archiveDirNames.slice(1)); // ranks 1-24 (newest 24), no matching meta
writeArchiveMeta(fileDeep, SID_DEEP, archiveDirNames[0], TU_DEEP, { stoppedByUser: true }); // rank 25 (oldest)

// deck-ghost-archive-cap (2026-10-27): 70 archive generations, ghost meta
// (stoppedByUser:true, matching toolUseId) in the OLDEST = rank 70, past the
// former 64-dir cap. With the cap it is never found and the entry stays running.
const SID_BEYOND = 'beef0000-beef-4000-8000-00000000beef'; // not uuidOf(c): ownScenario('…', 'd') would share the sid and its dirs
const TU_BEYOND = 'toolu_beyond_1';
const fileBeyond = fixture(SID_BEYOND, TU_BEYOND);
const beyondDirNames = Array.from({ length: 70 }, (_, i) => `2026-08-${String(Math.floor(i / 24) + 1).padStart(2, '0')}-${String(i % 24).padStart(2, '0')}0000`);
padArchiveDirs(fileBeyond, SID_BEYOND, beyondDirNames.slice(1)); // ranks 1-69, no matching meta
writeArchiveMeta(fileBeyond, SID_BEYOND, beyondDirNames[0], TU_BEYOND, { stoppedByUser: true }); // rank 70 (oldest)

// ---- own-transcript staleness fixtures (deck-ghost-bg-agents, 2026-10-12) ----
// Real ghost shape (session 5ac19a62): a background `code-quality` agent killed by a
// CLI restart — meta.json carries toolUseId but NO stoppedByUser, no
// <task-notification> ever lands; its own agent-<agentId>.jsonl stopped growing
// and sits in subagents-archive/<sid>/<ts>/ (the compaction hook mv's it there,
// mtime preserved), sometimes with a second later copy in another archive dir.
// Each scenario has its own sid + toolUseId (the meta memo/closed sets are keyed
// by toolUseId, module-global). Ages are literal minutes around the 3 h
// STALE_AGENT_MS (this block runs before the probe's own const of it).
const MIN = 60 * 1000;
const AGE_ANCIENT = 5 * 24 * 60 * MIN; // 5 days
const AGE_JUST_STALE = 190 * MIN;      // 3h10: older than STALE_AGENT_MS
const AGE_JUST_FRESH = 170 * MIN;      // 2h50: younger than STALE_AGENT_MS
const liveDirOf = (mainFile) => path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
const archDirOf = (mainFile, sid, tsDir) => path.join(path.dirname(mainFile), 'subagents-archive', sid, tsDir);
function putAgentJsonl(dir, agentId, ageMs) { // an agent's OWN transcript, mtime = now - ageMs
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - ageMs).toISOString(), message: { role: 'user', content: 'sub-agent prompt' } }) + '\n'); // the record ts carries the age (K2 lastTs), not only the mtime
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}
function putAgentMeta(dir, agentId, toolUseId, metaExtra) { // measured ghost meta: toolUseId, no stoppedByUser
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({
    agentType: 'code-quality', toolUseId, requestShape: 'background', ...metaExtra }));
}
const uuidOf = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const OWN = {};
function ownScenario(key, c, shift = 0) {
  const sid = uuidOf(c);
  const toolUseId = `toolu_own_${key}`;
  const agentId = `a${c.repeat(16)}`; // 17 hex chars, like the measured agent ids
  OWN[key] = { sid, toolUseId, agentId, file: fixture(sid, toolUseId, shift, agentId) };
  return OWN[key];
}
const DISPATCH_4H_AGO = -4 * 60 * MIN; // older than the window: only the agent's own records can keep it shown
// ghost: meta + stale jsonl in one archive dir, a second stale copy (newer, no meta) in another
{
  const s = ownScenario('ghost', 'd', -6 * 24 * 60 * MIN);
  putAgentMeta(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, s.toolUseId, {});
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, AGE_ANCIENT);
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-07-215520'), s.agentId, AGE_ANCIENT - 90 * 1000);
}
// just past the window, live dir: closes
{ const s = ownScenario('justStale', 'e', DISPATCH_4H_AGO);
  putAgentMeta(liveDirOf(s.file), s.agentId, s.toolUseId, {});
  putAgentJsonl(liveDirOf(s.file), s.agentId, AGE_JUST_STALE); }
// just inside the window, live dir: stays
{ const s = ownScenario('justFresh', 'f', DISPATCH_4H_AGO);
  putAgentMeta(liveDirOf(s.file), s.agentId, s.toolUseId, {});
  putAgentJsonl(liveDirOf(s.file), s.agentId, AGE_JUST_FRESH); }
// meta found, no jsonl of its OWN anywhere (another agent's stale jsonl is not evidence): stays
{ const s = ownScenario('noJsonl', '1');
  putAgentMeta(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, s.toolUseId, {});
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-07-202728'), 'abababababababab1', AGE_ANCIENT); }
// stale copy in the archive, FRESH copy in the live dir (compaction mv'd a live agent): stays
{ const s = ownScenario('liveFresh', '2');
  putAgentMeta(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, s.toolUseId, {});
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, AGE_ANCIENT);
  putAgentJsonl(liveDirOf(s.file), s.agentId, 1 * MIN); }
// newest MTIME wins, not newest DIR NAME: the newest-named archive dir holds the stale copy,
// an older-named one the fresh copy: stays
{ const s = ownScenario('archFreshOlderDir', '3');
  putAgentMeta(archDirOf(s.file, s.sid, '2026-10-12-183311'), s.agentId, s.toolUseId, {});
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-12-183311'), s.agentId, AGE_ANCIENT);
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-09-190249'), s.agentId, 5 * MIN); }
// one readable stale copy + one copy in a dir the probe cannot stat into (could be the fresh
// one): unreadable = unknown, never closes
const UNREADABLE_DIR = (() => {
  const s = ownScenario('unreadable', '4', DISPATCH_4H_AGO);
  putAgentMeta(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, s.toolUseId, {});
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-07-202728'), s.agentId, AGE_ANCIENT);
  putAgentJsonl(archDirOf(s.file, s.sid, '2026-10-12-120000'), s.agentId, 1 * MIN);
  const dir = archDirOf(s.file, s.sid, '2026-10-12-120000');
  fs.chmodSync(dir, 0o000);
  return dir;
})();
// resumed agent: its jsonl is silent since the PREVIOUS run (5 d) but the resume is 10 min old;
// silence is measured since the resume (ghost-agent-probe.js covers the rest): stays
{
  const c = '5';
  const sid = uuidOf(c);
  const toolUseId = 'toolu_own_resumed';
  const agentId = `a${c.repeat(16)}`;
  const file = path.join(projDir, `${sid}.jsonl`);
  writeJsonl(file, [
    { type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: ts(0), message: { role: 'user', content: `start-${sid}` } },
    dispatchLine(toolUseId, 'code-quality', 'Gate qualite', ts(1)),
    resultLine(toolUseId, ASYNC_ACK_TEXT, ts(2), agentId),
    { type: 'user', timestamp: new Date(Date.now() - 10 * MIN).toISOString(), // a SendMessage that RESUMED the agent (measured shape), 10 min ago
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_own_resume_call', content: 'Resuming agent in the background.' }] },
      toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: agentId } },
    { type: 'user', cwd: base, timestamp: new Date(Date.now() - 9 * MIN).toISOString(), message: { role: 'user', content: `continue-${sid}` } },
  ]);
  OWN.resumed = { sid, toolUseId, agentId, file };
  putAgentMeta(liveDirOf(file), agentId, toolUseId, {});
  putAgentJsonl(liveDirOf(file), agentId, AGE_ANCIENT);
}
// F3 (Tier 2 review, DoD(4) "stoppedByUser path unchanged"): the meta filter is HEAD's — ANY
// name ending in .meta.json is parsed and matched on meta.toolUseId. Only the own-transcript
// staleness step needs an agent-<agentId> file name, so it is skipped for any other name.
function putPlainMeta(file, stem, toolUseId, metaExtra) { // a meta WITHOUT the agent- prefix
  fs.mkdirSync(liveDirOf(file), { recursive: true });
  fs.writeFileSync(path.join(liveDirOf(file), `${stem}.meta.json`), JSON.stringify({
    agentType: 'code-quality', toolUseId, requestShape: 'background', ...metaExtra }));
}
// non-agent-named meta carrying stoppedByUser:true: still closes (stoppedByUser path unchanged)
{ const s = ownScenario('plainStop', '6');
  putPlainMeta(s.file, 'plain-stop', s.toolUseId, { stoppedByUser: true }); }
// non-agent-named meta, no stoppedByUser: the staleness step is SKIPPED, so it stays — even with
// ancient transcripts under every name a careless id derivation could look up (agent-null,
// agent-undefined, agent-<name minus .meta.json>): a dropped null guard would close it
{ const s = ownScenario('plainStale', '7');
  putPlainMeta(s.file, 'plain-stale', s.toolUseId, {});
  for (const id of ['null', 'undefined', 'plain-stale']) putAgentJsonl(liveDirOf(s.file), id, AGE_ANCIENT); }

// ---- background agent that WAITS on its own background work (deck-bg-agent-waiting) ----
// Measured shapes: the waiting notice is <status>completed</status> + a summary ending "is waiting on
// its own background work"; the final one that follows is task-id only (no <tool-use-id>) in most real
// cases. Both ride a queued_command attachment. A resumed run's waiting notice carries the resume call id.
const SID_WAIT = uuidOf('8');       // dispatch + ACK(A) + waiting(A, D)
const SID_WAITFIN = uuidOf('9');    // the same + task-id-only final(A)
const SID_RESUME_MID = uuidOf('0'); // dispatch + ACK(A) + final(D) + resume(A, R) + waiting(A, R)
const SID_RESUME = 'feed0000-feed-4000-8000-00000000feed'; // the same + task-id-only final(A)
function waitNotif(taskId, toolUseId, waiting) {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    ...(toolUseId ? [`<tool-use-id>${toolUseId}</tool-use-id>`] : []),
    `<output-file>/tmp/${taskId}.output</output-file>`,
    '<status>completed</status>',
    `<summary>Agent "Gate qualite" ${waiting ? 'is waiting on its own background work' : 'finished'}</summary>`,
    ...(waiting
      ? ['<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes.</note>']
      : ['<result>done</result>']),
    '</task-notification>',
  ].join('\n');
}
const notifLine = (text, t) => ({ type: 'attachment', timestamp: t,
  attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification' } });
function resumeLine(callId, agentId, t) { // SendMessage result that RESUMED a finished agent (measured shape)
  return { type: 'user', timestamp: t,
    message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'Resuming agent in the background.' }] },
    toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: agentId } };
}
const WAITING = {};
function waitScenario(key, sid, tail) {
  const D = `toolu_${key}_D`; const A = `agent_${key}`; const R = `toolu_${key}_R`;
  writeJsonl(path.join(projDir, `${sid}.jsonl`), [
    { type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: ts(0), message: { role: 'user', content: `start-${sid}` } },
    dispatchLine(D, 'code-quality', 'Gate qualite', ts(1)),
    resultLine(D, ASYNC_ACK_TEXT, ts(2), A),
    ...tail(D, A, R),
  ]);
  WAITING[key] = { sid, D };
}
waitScenario('wait', SID_WAIT, (D, A) => [notifLine(waitNotif(A, D, true), ts(3))]);
waitScenario('waitfin', SID_WAITFIN, (D, A) => [
  notifLine(waitNotif(A, D, true), ts(3)), notifLine(waitNotif(A, null, false), ts(4))]);
const resumeMidTail = (D, A, R) => [
  notifLine(waitNotif(A, D, false), ts(3)), resumeLine(R, A, ts(4)), notifLine(waitNotif(A, R, true), ts(5))];
waitScenario('resumeMid', SID_RESUME_MID, resumeMidTail);
waitScenario('resume', SID_RESUME, (D, A, R) => [
  ...resumeMidTail(D, A, R), notifLine(waitNotif(A, null, false), ts(6))]);

const statusDir = path.join(base, 'status');
fs.mkdirSync(statusDir, { recursive: true });
function writeStatus(sid, status) {
  fs.writeFileSync(path.join(statusDir, `${sid}.json`),
    JSON.stringify({ status, event: 'probe', ts: new Date().toISOString() }));
}
writeStatus(SID_CLOSE, 'working'); // LIVE — isActive needs isLive=true + fresh transcript
writeStatus(SID_STAY, 'working');
writeStatus(SID_DEEP, 'working');
writeStatus(SID_BEYOND, 'working');
for (const k of Object.keys(OWN)) writeStatus(OWN[k].sid, 'working');

process.env.CLAUDE_DECK_BIN = '/bin/bash';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;
process.env.CLAUDE_DECK_STATUS_DIR = statusDir;
require(path.join(__dirname, '..', 'main.js'));
const { app } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-session-activity-userdata-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push({ id, ok });
}

// LEGACY replica of the PRE-FIX activityFlags() agents filter — used ONLY as
// the RED baseline when session-activity.js does not (yet) export
// activityFlags(). Mirrors the same workaround test/hem5587-diag-probe.js
// already uses for this private function. Once the fix lands and exports the
// real activityFlags(), this probe automatically switches to testing THAT.
const STALE_AGENT_MS = 3 * 60 * 60 * 1000;
function inCurrentTurnLegacy(e, lastRealUserTs) {
  return lastRealUserTs === null || (e.startTs !== null && e.startTs >= lastRealUserTs);
}
function legacyActivityFlags(activity, isLive) {
  const isFresh = typeof activity.lastTouchedMs === 'number'
    && (Date.now() - activity.lastTouchedMs) <= STALE_AGENT_MS;
  const isActive = !!isLive && isFresh;
  return {
    agents: (activity.agents || [])
      .filter((e) => inCurrentTurnLegacy(e, activity.lastRealUserTs) || (e.state === 'running' && isActive)),
  };
}

async function main() {
  const mod = require(path.join(__dirname, '..', 'src', 'main', 'session-activity.js'));
  const usingFix = typeof mod.activityFlags === 'function';
  const activityFlagsFn = usingFix ? mod.activityFlags : legacyActivityFlags;
  console.log('activityFlags exported (fix present):', usingFix);

  async function presentAfterSettle(sid, toolUseId) {
    let activity = await mod.sessionActivity(sid);
    let flags = activityFlagsFn(activity, true, sid);
    if (!usingFix) return flags.agents.some((a) => a.toolUseId === toolUseId); // legacy: synchronous, nothing to await
    // The fix's meta check is fire-and-forget async — poll deterministically
    // bounded (15 x 100ms = 1.5s ceiling) instead of a fixed sleep.
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      activity = await mod.sessionActivity(sid);
      flags = activityFlagsFn(activity, true, sid);
    }
    return flags.agents.some((a) => a.toolUseId === toolUseId);
  }

  const closePresent = await presentAfterSettle(SID_CLOSE, TU_CLOSE);
  gate('agent_stopped_by_user_closes', closePresent === false,
    `stoppedByUser:true meta -> present=${closePresent} (expect false)`);

  const stayPresent = await presentAfterSettle(SID_STAY, TU_STAY);
  gate('agent_without_stop_flag_stays', stayPresent === true,
    `no stoppedByUser meta -> present=${stayPresent} (expect true, over-fire guard)`);

  const deepPresent = await presentAfterSettle(SID_DEEP, TU_DEEP);
  gate('agent_meta_found_beyond_20_archive_dirs', deepPresent === false,
    `stoppedByUser:true meta in archive generation 25/25 (oldest) -> present=${deepPresent} (expect false, F1)`);

  const beyondPresent = await presentAfterSettle(SID_BEYOND, TU_BEYOND);
  gate('agent_meta_found_beyond_64_archive_dirs', beyondPresent === false,
    `stoppedByUser:true meta in archive generation 70/70 (oldest, past the old 64 cap) -> present=${beyondPresent} (expect false)`);

  // ---- own-transcript staleness gates (deck-ghost-bg-agents) ----------------
  const keys = Object.keys(OWN);
  const present = {};
  await Promise.all(keys.map(async (k) => { present[k] = await presentAfterSettle(OWN[k].sid, OWN[k].toolUseId); }));

  gate('own_transcript_stale_closes', present.ghost === false,
    `no stoppedByUser, own jsonl stale 5d in 2 archive dirs -> present=${present.ghost} (expect false, the real ghost)`);
  gate('own_transcript_just_past_window_closes', present.justStale === false,
    `own jsonl 3h10 old (> STALE_AGENT_MS) -> present=${present.justStale} (expect false)`);
  gate('own_transcript_just_inside_window_stays', present.justFresh === true,
    `own jsonl 2h50 old (< STALE_AGENT_MS) -> present=${present.justFresh} (expect true, over-fire guard)`);
  gate('own_transcript_missing_stays', present.noJsonl === true,
    `meta found, no own jsonl anywhere (a foreign stale jsonl exists) -> present=${present.noJsonl} (expect true)`);
  gate('own_transcript_fresh_in_live_dir_stays', present.liveFresh === true,
    `stale copy in archive + fresh copy in live subagents/ -> present=${present.liveFresh} (expect true)`);
  gate('own_transcript_newest_mtime_not_newest_dir', present.archFreshOlderDir === true,
    `stale copy in the newest-named archive dir, fresh copy in an older one -> present=${present.archFreshOlderDir} (expect true)`);
  const denied = (() => { try { fs.statSync(path.join(UNREADABLE_DIR, `agent-${OWN.unreadable.agentId}.jsonl`)); return false; } catch (e) { return !!e && e.code === 'EACCES'; } })();
  // FLIPPED (L3b, K6/Q-H1): the unreadable copy contributes no record, so the run is silent by what the fold can read:
  // it reads `unknown` (hidden), never `closed` — "unknown never closes" now means exactly that.
  const unreadableState = (mod.agentStatesOf(OWN.unreadable.sid, true).get(OWN.unreadable.toolUseId) || {}).state;
  gate('own_transcript_unreadable_copy_unknown_not_closed', denied ? (present.unreadable === false && unreadableState === 'unknown') : true,
    denied ? `readable stale copy + a copy behind a chmod 000 dir -> present=${present.unreadable}, state=${unreadableState} (expect hidden as unknown, never closed)`
      : 'SKIPPED: this fs does not deny the stat (running as root?)');
  gate('own_transcript_resumed_agent_stays', present.resumed === true,
    `resumed 10 min ago, previous-run jsonl silent 5 d -> present=${present.resumed} (expect true, silence is measured since the resume)`);
  gate('plain_named_meta_stopped_by_user_closes', present.plainStop === false,
    `meta named plain-stop.meta.json (no agent- prefix) with stoppedByUser:true -> present=${present.plainStop} (expect false, DoD(4) stoppedByUser path unchanged)`);
  gate('plain_named_meta_staleness_skipped_stays', present.plainStale === true,
    `meta named plain-stale.meta.json, no stoppedByUser, ancient agent-null/undefined/plain-stale jsonl -> present=${present.plainStale} (expect true, no staleness step without an agentId)`);
  try { fs.chmodSync(UNREADABLE_DIR, 0o755); } catch (_) { /* best effort, tmp dir */ }

  // ---- ledger state of a background agent that waits on its own background work ----
  const stateOf = async (key) => {
    const a = ((await mod.sessionActivity(WAITING[key].sid)).agents || []).find((e) => e.toolUseId === WAITING[key].D);
    return a ? a.state : null;
  };
  const sWait = await stateOf('wait');
  gate('waiting_notif_keeps_running', sWait === 'running',
    `dispatch + ACK + waiting notice (tool-use-id = dispatch) -> state=${sWait} (expect running)`);
  const sWaitFin = await stateOf('waitfin');
  gate('final_notif_closes', sWaitFin === 'done',
    `waiting notice then task-id-only final -> state=${sWaitFin} (expect done)`);
  const sResumeMid = await stateOf('resumeMid');
  const sResume = await stateOf('resume');
  gate('resumed_wait_final_closes', sResumeMid === 'running' && sResume === 'done',
    `resumed run: after waiting(resume call id) state=${sResumeMid} (expect running), after the task-id-only final state=${sResume} (expect done)`);

  const passN = results.filter((r) => r.ok).length;
  console.log(`${passN}/${results.length} PASS`);
  console.log(passN === results.length
    ? `VERDICT: ALL GREEN (${passN}/${results.length})`
    : `VERDICT: RED (${passN}/${results.length})`);
}

main().then(() => { app.quit(); }).catch((e) => { console.error('PROBE ERROR', e); app.exit(1); });
