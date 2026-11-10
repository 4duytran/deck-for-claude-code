// claude-deck — task-notification: pure, dependency-free parser for the
// background/async sub-agent COMPLETION that Claude Code injects into the
// transcript as a <task-notification> user line.
//
// WHY it exists: a run_in_background (or harness-async) dispatch returns its
// tool_result IMMEDIATELY — an ACK (« Async agent launched… »), not the agent's
// completion. The real completion lands later as a <task-notification> user turn
// that the chat body hides as noise (transcript.js USER_NOISE_RE). But that line
// carries the ORIGINAL dispatch's <tool-use-id>, so transcript.js lifts a
// completion SIGNAL out of it (kind:'agentDone') to flip the activity-tree row
// « working » -> « terminé » — the ACK never could (v65 keeps a bg row working).
//
// Kept electron-free in its own module so the parse is unit-testable headlessly
// (.scratch/agent-done-notif-probe.js) — transcript.js itself requires electron.
'use strict';

// A user line is a task-notification iff it CARRIES the tag. v70: match the tag
// ANYWHERE, not just at line start. A BACKGROUND-agent completion is injected with a
// harness prefix BEFORE the tag — « [SYSTEM NOTIFICATION - NOT USER INPUT] … <task-
// notification> » (and « [Request interrupted by user] <task-notification> » on a kill).
// The old ^-anchor missed every prefixed completion, so parseTaskNotification returned
// null -> no agentDone -> the backgrounded agent's activity-tree / « Tâches » row stuck
// « working » forever (user repro: stale « working » rows after a deck restart; the strip
// hid it via its idle wipe, the persistent roster exposed it). The <tool-use-id> below is
// the real correlator — a stray mention without one still returns null (no false reap).
const TASK_NOTIF_RE = /<task-notification\b/;
// The dispatch handle: the original tool_use id, === the activity-tree row key.
const TUID_RE = /<tool-use-id>\s*([^<\s]+?)\s*<\/tool-use-id>/i;
// Terminal status word (completed / failed / killed / …) — display only.
const STATUS_RE = /<status>\s*([A-Za-z_]+)\s*<\/status>/i;

// A « waiting » notification (summary `Agent "…" is waiting on its own background work`) is NOT a
// completion although it carries <status>completed</status>: the agent is parked on its own
// background work and its real final comes later. Only the notification's OWN <summary> is read
// (the first one before any <result>, which may quote anything) and the phrase must END it:
// 453/453 real waiting summaries do.
const WAITING_SUMMARY_RE = /\bis waiting on its own background work\s*$/i;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/i;
const OWN_END_RE = /<result>|<\/task-notification>/i;

// The inner text of the first <summary> between the first <task-notification and the first
// <result> or </task-notification>; null when there is none.
function ownSummary(text) {
  const start = text.search(TASK_NOTIF_RE);
  if (start < 0) return null;
  const tail = text.slice(start);
  const end = tail.search(OWN_END_RE);
  const m = SUMMARY_RE.exec(end < 0 ? tail : tail.slice(0, end));
  return m ? m[1] : null;
}

function isWaiting(text) {
  const summary = ownSummary(text);
  return summary !== null && WAITING_SUMMARY_RE.test(summary);
}

// Returns { toolUseId, status } for a <task-notification> that carries a
// correlatable tool-use-id; null for anything else — a non-notification line, a
// « waiting » notification, or a notification with no id (which stays hidden
// noise with no tree effect).
function parseTaskNotification(text) {
  if (typeof text !== 'string' || !TASK_NOTIF_RE.test(text)) return null;
  if (isWaiting(text)) return null;
  const idm = TUID_RE.exec(text);
  if (!idm) return null;
  const sm = STATUS_RE.exec(text);
  return { toolUseId: idm[1], status: sm ? sm[1].toLowerCase() : 'completed' };
}

// v74: a "stopped" batch (session-start requeue of agents that didn't finish
// notifying before the previous session ended) lists ONE OR MORE <task-id> with
// NO <tool-use-id> of its own — the id that IS correlatable is the dispatch's
// AGENT id, resolved by the caller through the map built from ACK lines
// (toolUseResult.agentId). Global match: a batch genuinely lists several.
const TASK_ID_RE = /<task-id>\s*([^<\s]+?)\s*<\/task-id>/gi;

function taskIdsOf(text) {
  const ids = [];
  TASK_ID_RE.lastIndex = 0; // the regex is `g` and reused across calls — reset before every scan
  let m;
  while ((m = TASK_ID_RE.exec(text))) ids.push(m[1]);
  return ids;
}

// Returns { taskIds, status } for ANY <task-notification> that carries at least
// one <task-id> (regardless of a <tool-use-id> also being present); null for a
// non-notification line, a « waiting » notification, or one with no id at all
// to correlate.
function parseTaskNotificationIds(text) {
  if (typeof text !== 'string' || !TASK_NOTIF_RE.test(text)) return null;
  if (isWaiting(text)) return null;
  const ids = taskIdsOf(text);
  if (!ids.length) return null;
  const sm = STATUS_RE.exec(text);
  return { taskIds: ids, status: sm ? sm[1].toLowerCase() : 'completed' };
}

// Returns { taskId, toolUseId } for a « waiting » notification that carries
// exactly ONE <task-id> and a <tool-use-id> (the call that started this run);
// null otherwise. The normalizer records it so the later task-id-only final
// resolves to that run.
function parseWaitingNotification(text) {
  if (typeof text !== 'string' || !TASK_NOTIF_RE.test(text) || !isWaiting(text)) return null;
  const ids = taskIdsOf(text);
  const idm = TUID_RE.exec(text);
  if (ids.length !== 1 || !idm) return null;
  return { taskId: ids[0], toolUseId: idm[1] };
}

// v74: the OTHER completion shape — a TaskOutput retrieval tool_result (manual
// poll / SendMessage), keyed by task_id === the ACK's agentId (an UNDERSCORE
// tag, distinct from the hyphenated <task-id> above). Unlike a <task-notification>
// (which only ever fires on a real stop), this text is also written for an
// in-flight poll — status 'running' (or any other non-terminal word) means "not
// done yet", so it must yield no signal rather than a premature completion.
// v75 (F2 fix): anchored — a Bash stdout that quotes a PRIOR TaskOutput block
// after other text (e.g. a grep over a transcript) must not re-signal a
// completion. Measured 2026-09-17 over 1857 transcripts: 538/538 real
// TaskOutput results start with the tag, so anchoring closes no real row.
// Residue, accepted (user decision B): an echo whose text STARTS with the tag
// still parses (0 of the 66 tagged non-TaskOutput results that day); it can
// only repeat a status already emitted, and the renderer's done flag is monotonic.
const TASKOUTPUT_MARKER_RE = /^\s*<retrieval_status>/;
const TASKOUTPUT_TASK_ID_RE = /<task_id>\s*([^<\s]+?)\s*<\/task_id>/i;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

// Returns { taskId, status } for a TaskOutput result carrying a TERMINAL status;
// null for a non-TaskOutput text, a malformed one (no task_id), or a non-terminal
// status (running, or anything else not in TERMINAL_STATUSES).
function parseTaskOutputResult(text) {
  if (typeof text !== 'string' || !TASKOUTPUT_MARKER_RE.test(text)) return null;
  const idm = TASKOUTPUT_TASK_ID_RE.exec(text);
  if (!idm) return null;
  const sm = STATUS_RE.exec(text);
  const status = sm ? sm[1].toLowerCase() : null;
  if (!status || !TERMINAL_STATUSES.has(status)) return null;
  return { taskId: idm[1], status };
}

module.exports = {
  parseTaskNotification,
  parseTaskNotificationIds,
  parseWaitingNotification,
  parseTaskOutputResult,
};
