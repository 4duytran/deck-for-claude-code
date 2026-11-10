'use strict';

// claude-deck — transcript-normalize: pure, electron-free line/event
// normalizer for the chat feed (S1 extraction from ipc/transcript.js).
// Required by BOTH the streaming reader (ipc/transcript.js) and the
// aggregate pass (session-activity.js) — the main graph forbids the
// latter requiring the former.

const { parseTaskNotification, parseTaskNotificationIds, parseWaitingNotification, parseTaskOutputResult } =
  require('./task-notification'); // v68/v74: bg agent completion signals (electron-free, unit-tested)

// ---------------------------------------------------------------------------
// Line -> normalized chat events.
// Event kinds (the renderer's whole vocabulary):
//   { kind:'user',     text, truncated, ts }
//   { kind:'text',     text, truncated, ts, tokens? }   assistant prose
//   { kind:'thinking', text, truncated, ts }
//   { kind:'tool',     id, name, summary, detail, ts, tokens? }
//   { kind:'result',   toolUseId, text, truncated, isError, ack, ts, resumedAgentId?, agentId?,
//                      handback?, report?, reportTruncated? }   (report = toolUseResult.handbackReport.text)
//   { kind:'compact',  canceled?, ts }                      /compact boundary
//   { kind:'agentReport', agentId, text, truncated, ts }    a sub-agent's final report (v81)
// tokens = { in, out, cache } — attached to the LAST block of an assistant
// message (per-message granularity, like the official desktop app's chips).
// ---------------------------------------------------------------------------

const TEXT_CAP = 20000; // user/assistant text per block
const THINK_CAP = 4000;
const DETAIL_CAP = 2000; // pretty-printed tool input
const PREVIEW_CAP = 6000; // per-option AskUserQuestion preview (chat ask-panel mirror)
const RESULT_CAP = 4000; // tool result text
function capText(s, cap) {
  if (typeof s !== 'string') return { text: '', truncated: false };
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, cap), truncated: true };
}

// tool_result / user content arrives as a string OR [{type:'text', text}…].
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// The one line a collapsed tool card shows — the most telling input field.
// 'path' LAST among the specific keys: tools that carry it usually carry a
// more telling field too (Grep: pattern + path — the pattern is the story).
// v52: 'description' BEFORE 'command' — a Bash tool's description is the curated
// human label (« Rebuild the search index »), far more legible in the activity
// strip / collapsed card than a raw multi-line shell command. The full command
// still shows in the UNFOLDED card body; this only changes the one-line summary.
const SUMMARY_KEYS = [
  'file_path', 'pattern', 'description', 'command', 'query', 'url',
  'subject', 'skill', 'prompt', 'path',
];
function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of SUMMARY_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) {
      // collapse internal whitespace/newlines -> ONE clean line (a multi-line or
      // 200-char command would otherwise sprawl across the status strip).
      return input[k].trim().replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  const keys = Object.keys(input);
  return keys.length ? keys.join(', ').slice(0, 200) : '';
}

// Harness/meta user lines (slash-command echoes, reminders, background-agent
// <task-notification> completions injected as user turns) — transcript
// plumbing, not conversation; the chat hides them like claude's own UI does.
const USER_NOISE_RE = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|task-notification)/;
// v72: a BARE slash-command user line (« /compact », « /room-lead ») is always a
// command echo, never real conversation — the composer blocks slash-commands
// (showSlashWarning), so the only ones that reach the transcript are the deck's own
// button-driven pastes (startCompact / room-lead). USER_NOISE_RE keys on the
// <command-name> WRAPPER; a PASTED slash-command is recorded by Claude Code as plain
// user text with no wrapper, so it slips that filter. Drop it here by shape instead.
const SLASH_ECHO_RE = /^\s*\/[a-zA-Z][\w-]*\s*$/;
// v76 (paste-dedup fix): a bracket-pasted composer send is wrapped by the
// Claude Code CLI into `<pasted_content id="…">\n…\n</pasted_content id="…">`
// before it ever reaches the transcript — the Deck's own optimistic echo
// (chat-view.js) has no such wrapper, so the whitespace-only dedup compare
// never matches and the send renders twice (plain echo + literal-tag
// bubble). Unwrapped HERE, the one sanctioned kind:'user' emission point, so
// both the dedup compare and a bare transcript replay see the plain text.
// Matches ONLY a single genuine wrapper spanning the WHOLE string (outer
// whitespace aside) with matching open/close ids (backreference) — an
// escaped `<\pasted_content` (the CLI's own escape when the user's paste
// itself contains the literal tag), a typed prefix, or a mismatched-id pair
// all fail the anchored match and pass through untouched. Several wrappers
// with DIFFERENT ids likewise fail (no closer satisfies the backreference at
// the string's end); several wrappers sharing the SAME id can still satisfy
// the anchored match (the lazy inner capture backtracks past the first
// closer when the immediate `\s*$` tail check fails) — the same-id guard in
// unwrapPastedContent below catches that case and leaves it untouched too.
// Strips only the boundary — outer whitespace plus the one `\r?\n` on each
// side of the inner text — the inner text itself is never trimmed or altered.
// LAZY capture is load-bearing: a GREEDY `[\s\S]*` lets its optional `\r?` on
// the closing boundary backtrack into matching zero-width, so the capture
// swallows the CR of a CRLF boundary and only the bare `\n` is left to close
// the match — the inner text then keeps a stray trailing `\r` (measured via
// the probe below, CRLF gate). Lazy stops at the FIRST (shortest, i.e.
// correct) split, before that ambiguity can bite.
const PASTE_WRAP_RE = /^\s*<pasted_content id="([^"]*)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">\s*$/;
function unwrapPastedContent(text) {
  const m = PASTE_WRAP_RE.exec(text);
  if (!m) return text;
  // Tier 1 review Finding 1: two (or more) wrappers sharing the SAME id can
  // still satisfy the anchored regex above — the lazy capture backtracks
  // past the first closer once the immediate `\s*$` tail check fails,
  // swallowing a second same-id wrapper whole and leaving its tags embedded
  // in m[2]. That was never a single genuine wrapper; if the captured inner
  // text still contains the id's own closing tag, leave the text untouched
  // instead of surfacing embedded tags to the chat bubble.
  if (m[2].includes(`</pasted_content id="${m[1]}">`)) return text;
  return m[2];
}
// v68: a background/async sub-agent's COMPLETION is one of those noise lines — a
// <task-notification> user turn. It stays hidden from the chat body, but
// parseTaskNotification (../task-notification) lifts a completion SIGNAL out of
// it (the dispatch's tool-use-id + status) so the activity tree can flip that row
// « working » -> « terminé » — the immediate ACK never could (v65 keeps a bg row
// working). Parser kept electron-free in its own module to be unit-testable.
// v50: /goal lifecycle surfaced in the chat face. The slash echo stays noise,
// but the « Goal set: <text> » stdout is a real confirmation the chat must show
// (the user runs /goal a lot and otherwise sees nothing land). The session Stop
// hook Claude Code installs is NAMED after the goal text and re-runs on every
// Stop, only ceasing to block (preventedContinuation=false) once the goal is
// met — that stop_hook_summary is the deterministic auto-clear signal.
const GOAL_SET_RE = /^\s*<local-command-stdout>\s*Goal set:\s*([\s\S]*?)\s*<\/local-command-stdout>/i;
const GOAL_CLEAR_RE = /^\s*<local-command-stdout>\s*Goal (?:cleared|removed)/i;
// v73: « /model <alias> » writes TWO user entries at the same timestamp — the
// command echo (USER_NOISE_RE drops it) then this stdout confirmation, naming
// the model Claude Code ACTUALLY switched to. It is the EARLIEST model fact of
// a switch: no assistant entry carries the new id until the next turn, so the
// badge's « command issued » hint used to survive a done deal. Anchored on the
// exact sentence INSIDE the stdout tag (rule #7) — free text naming a model is
// never a confirmation.
const MODEL_SET_RE = /^\s*<local-command-stdout>\s*Set model to\s+`([^`\n]+)`[^<]*<\/local-command-stdout>\s*$/i;
// Harness assistant lines: Claude Code logs this exact text when a turn ends
// without a user-facing reply (hook wake-ups, background notifications). Not
// conversation — exact match only, never a substring filter.
const ASSISTANT_NOISE = new Set(['No response requested.']);
// v67: an ASYNC Agent() dispatch returns an immediate tool_result ACK even when
// run_in_background is NOT set (this harness runs sub-agents async by default).
// The ACK is not the agent's completion (that lands later as a <task-notification>),
// so a dispatch whose result matches this sentinel is promoted to background and
// its row stays « working » instead of closing on the ACK — the bug where a
// no-flag async agent flashed and vanished from the (folded) activity tree.
const ASYNC_ACK_RE = /Async agent launched successfully|(?:working|running|started|launched) in the background/i;

// AskUserQuestion options carry per-option `preview` (multi-line code/text the
// real TUI shows in a side panel). The generic `detail` is capped (DETAIL_CAP)
// and would truncate them, so lift label+description+preview into a dedicated,
// lightly-capped field the chat ask-panel can mirror. Flattened across the
// tool's questions; the panel correlates back to the scraped menu by label.
// Strip Unicode bidi/override controls (Trojan-Source, CVE-2021-42574) so the
// rendered preview cannot visually reorder vs its real bytes, then mark a
// PREVIEW_CAP truncation VISIBLY (mirrors the DETAIL_CAP '…' pattern) — a
// reader must never approve on a silently-clipped preview. (Attacker #5/#4.)
const BIDI_CTRL_RE = /[\u202A-\u202E\u2066-\u2069]/g;
function sanitizePreview(s) {
  if (typeof s !== 'string') return '';
  const clean = s.replace(BIDI_CTRL_RE, '');
  return clean.length > PREVIEW_CAP ? clean.slice(0, PREVIEW_CAP) + '\n…(preview tronqué)' : clean;
}
function askOptions(input, name) {
  if (name !== 'AskUserQuestion' || !input || !Array.isArray(input.questions)) return null;
  const out = [];
  for (const q of input.questions) {
    if (!q || !Array.isArray(q.options)) continue;
    for (const o of q.options) {
      if (!o || typeof o.label !== 'string') continue;
      out.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : '',
        preview: sanitizePreview(o.preview),
      });
    }
  }
  return out.length ? out : null;
}

// v79 (ask-all-questions): the terminal widget shows ONE question of a
// multi-question AskUserQuestion call at a time (tab bar); the transcript's
// tool_use already carries every question, so lot 2 (chat-view) renders an
// overview of all of them from this field. Unlike askOptions() above (which
// FLATTENS every question's options into one list for the preview mirror,
// and must stay byte-identical for that mirror — never touch it from here),
// this keeps the question boundaries: one entry per question, in call order.
// Same sanitisation policy as askOptions (strip Trojan-Source bidi/override
// controls, cap with a VISIBLE truncation marker so a reader never sees a
// silently-clipped question or option) applied to every string field here.
const ASK_TEXT_CAP = 2000; // header/question/option label+description — mirrors DETAIL_CAP/PREVIEW_CAP sizing
function sanitizeAskText(s) {
  if (typeof s !== 'string') return '';
  const clean = s.replace(BIDI_CTRL_RE, '');
  return clean.length > ASK_TEXT_CAP ? clean.slice(0, ASK_TEXT_CAP) + '\n…(tronqué)' : clean;
}
function askQuestions(input, name) {
  if (name !== 'AskUserQuestion' || !input || !Array.isArray(input.questions)) return null;
  const out = [];
  for (const q of input.questions) {
    if (!q || !Array.isArray(q.options)) continue; // malformed question — skip, like askOptions
    const options = [];
    for (const o of q.options) {
      if (!o || typeof o.label !== 'string') continue; // malformed option — skip, like askOptions
      options.push({
        label: sanitizeAskText(o.label),
        description: typeof o.description === 'string' ? sanitizeAskText(o.description) : '',
      });
    }
    if (!options.length) continue; // every option malformed -> the whole question is malformed
    out.push({
      header: typeof q.header === 'string' ? sanitizeAskText(q.header) : '',
      question: typeof q.question === 'string' ? sanitizeAskText(q.question) : '',
      multiSelect: !!q.multiSelect,
      options,
    });
  }
  return out.length ? out : null;
}

// v74: shared resolver for a <task-notification> text found in ANY of its wire
// shapes — 'attachment' (queued_command prompt) or 'queue-operation' (enqueue
// content); the plain user text block below still parses inline (unchanged).
// Tries the precise path first (a <tool-use-id> IS the toolUseId, no lookup
// needed); falls back to the agentId map ONLY when the notification carries
// <task-id>(s) but no <tool-use-id> of its own (a "stopped" batch can list
// several) — an id missing from the map (its ACK happened outside this file's
// read window) is silently dropped, never guessed onto another row.
// A resumed run's « waiting » notice names its task and the resume call's id; the later task-id-only
// final must close THAT run, not the dispatch id the agentIdMap keeps. Side tables keyed by the agentIdMap
// object (same lifetime and reset): taskId -> resume call id (kept on read, the 3 copies of one final resolve
// alike; dropped by the agent's next resume) and the call ids such a resume superseded. A tool-use id belongs
// to one call only: a late copy of a superseded waiting notice (queue remove, attachment) is ignored.
const waitingRunByTask = new WeakMap();
const supersededRuns = new WeakMap();

// Returns the parsed waiting notice (or null) so the caller can emit its `agentWaiting` event; the
// bookkeeping needs the agentId map, the event does not.
function recordWaiting(text, agentIdMap) {
  const w = parseWaitingNotification(text);
  if (!w) return null;
  if (agentIdMap) {
    const dead = supersededRuns.get(agentIdMap);
    if (!(dead && dead.has(w.toolUseId))) {
      let runs = waitingRunByTask.get(agentIdMap);
      if (!runs) waitingRunByTask.set(agentIdMap, runs = new Map());
      runs.set(w.taskId, w.toolUseId);
    }
  }
  return w;
}

const waitingEvent = (w, ts) => ({ kind: 'agentWaiting', toolUseId: w.toolUseId, taskId: w.taskId, ts });

function taskNotificationEvents(text, ts, agentIdMap) {
  // v75 (F2 fix): the wire shapes here (attachment prompt / queue-operation
  // content) carry NOTHING but the notification — a genuine carrier always
  // OPENS the text. A quoted/pasted block after prose is a false positive
  // (measured 2026-09-17: 2657/2657 genuine carriers start with the tag), so
  // require it.
  if (typeof text !== 'string' || !/^\s*<task-notification\b/.test(text)) return [];
  // A waiting notice is a state, never a completion: both done-parsers return null on it.
  const waitingNotice = recordWaiting(text, agentIdMap);
  if (waitingNotice) return [waitingEvent(waitingNotice, ts)];
  const direct = parseTaskNotification(text);
  if (direct) return [{ kind: 'agentDone', toolUseId: direct.toolUseId, status: direct.status, ts }];
  const byIds = parseTaskNotificationIds(text);
  if (!byIds || !agentIdMap) return [];
  const out = [];
  const waiting = waitingRunByTask.get(agentIdMap);
  for (const taskId of byIds.taskIds) {
    const toolUseId = (waiting && waiting.get(taskId)) || agentIdMap.get(taskId);
    if (toolUseId) out.push({ kind: 'agentDone', toolUseId, status: byIds.status, ts });
  }
  return out;
}

// The harness's PLAIN-TEXT stop notice. When the user stops a background agent it often writes NO
// <task-notification> (measured: 5 of 7 stops), only `Background agent "<description>" was stopped
// by the user.` as a queue-operation `enqueue` content, an attachment queued_command prompt, or a
// user text block. The notice names the agent by its description alone (no id): the ledger closes
// the one running entry that carries it. The greedy group ends at the LAST `" was stopped`, so a
// description holding quotes still parses; whitespace is collapsed like toolSummary() does.
const STOPPED_BY_USER_RE = /^\s*Background agent "([\s\S]+)" was stopped by the user\.\s*$/;
function stopTextEvents(text, ts) {
  if (typeof text !== 'string') return [];
  const m = STOPPED_BY_USER_RE.exec(text);
  const description = m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  return description ? [{ kind: 'agentStoppedByDesc', description, ts }] : [];
}

// v81 (deck-agent-final-report): a sub-agent's FINAL report no longer rides its Agent
// tool_result (that holds only HANDBACK_PLACEHOLDER_RE's placeholder); the harness hands it to
// the parent as a queued `<agent-message from="<agentId>">` carrying a `[Subagent hand-back]`
// frame line. It arrives in the SAME two wire shapes as a <task-notification> (an 'attachment'
// queued_command prompt; a 'queue-operation' enqueue/remove content), up to 3 copies of the
// same report. A genuine carrier OPENS the text (measured 2026-10-13 over 7260 real carriers:
// 7260 open with the tag, 0 hold two, 7152 framed, the other 108 are peer messages with no
// frame -> not a report). The harness indents EVERY report line by 2 spaces, so the genuine
// closing tag is the only column-zero `</agent-message>`: an indented one inside the report
// body is report text, never the end. No dedupe here (a SendMessage resume hands the SAME
// agentId back twice with two distinct reports): the consumer keys by agentId + text.
const HANDBACK_FRAME_RE = /^\s*<agent-message from="([^"\s]{1,64})">\s*\n\[Subagent hand-back\][^\n]*?The report follows:[^\n]*\n/;
const AGENT_MESSAGE_CLOSE_RE = /(?:^|\n)<\/agent-message>/;
function agentReportEvents(text, ts) {
  if (typeof text !== 'string') return [];
  const frame = HANDBACK_FRAME_RE.exec(text);
  if (!frame) return [];
  let body = text.slice(frame[0].length);
  const close = AGENT_MESSAGE_CLOSE_RE.exec(body);
  if (close) body = body.slice(0, close.index);
  const report = body.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n').trim();
  if (!report) return []; // an empty report is nothing to show (never a guess)
  const t = capText(report, TEXT_CAP);
  return [{ kind: 'agentReport', agentId: frame[1], text: t.text, truncated: t.truncated, ts }];
}

// The Agent tool_result of a handed-back report. Anchored at the START of the text: a tool
// output that merely quotes the sentence further down (a Bash echo, a transcript dump) is not
// a placeholder (measured: 69 such quoting results vs 1417 genuine ones). The id is the quoted
// one, else the `agentId: <id>` line the harness appends below the sentence.
const HANDBACK_PLACEHOLDER_RE = /^\s*This agent's report was delivered to you as a message from\b(?:\s+"([^"\s]{1,64})")?/;
const RESULT_AGENT_ID_LINE_RE = /^agentId:\s*(\S{1,64})/m;
function handbackPlaceholder(text) {
  const m = HANDBACK_PLACEHOLDER_RE.exec(text);
  if (!m) return null;
  const line = m[1] ? null : RESULT_AGENT_ID_LINE_RE.exec(text);
  return { agentId: m[1] || (line ? line[1] : null) };
}

// The harness-written hand-back fields of a tool_result's `toolUseResult` (measured 2026-10-13:
// 1417 of 1417 genuine placeholders carry handback === 'send'; 1356 carry handbackReport.text).
// Only the value 'send' counts ('withheld' = no report was delivered). A `toolUseResult` whose
// agentId disagrees with the id the placeholder text names belongs to another block of a shared
// line: ignored, the text fallback alone applies. `report` is '' when there is no usable text.
function harnessHandback(tur, placeholder) {
  if (!tur || typeof tur !== 'object' || tur.handback !== 'send') return null;
  const turId = typeof tur.agentId === 'string' && tur.agentId ? tur.agentId.slice(0, 64) : null;
  if (placeholder && placeholder.agentId && turId && placeholder.agentId !== turId) return null;
  const r = tur.handbackReport;
  const report = r && typeof r === 'object' && typeof r.text === 'string' ? r.text.trim() : '';
  return { agentId: turId, report };
}

// S3: `opts.sidechain === true` is the ONLY opt-in for a sidechain line — the
// per-agent journal feed (ipc/transcript.js) is the sole caller that ever
// passes it (`normalizeLine(line, null, { sidechain: true })`). Every other
// call site passes no third argument, so `opts` is `undefined` there and
// this guard behaves exactly as before: a sidechain line is dropped.
function normalizeLine(line, agentIdMap, opts) {
  if (!line) return [];
  let e;
  try { e = JSON.parse(line); } catch (_) { return []; } // partial/garbage line
  if (!e || typeof e !== 'object') return [];
  if (e.isSidechain && !(opts && opts.sidechain === true)) return []; // subagent echoes: skip unless opted in
  const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
  // v46.9.8: compaction lifecycle (deterministic, SAME sessionId -> no
  // fork). A successful /compact writes a system 'compact_boundary'; a
  // canceled one a local_command stderr. Both resolve the chat's compaction
  // card. The 'isCompactSummary' user line that follows is the internal
  // continuation summary (isVisibleInTranscriptOnly) -> never a chat bubble.
  if (e.type === 'system') {
    if (e.subtype === 'compact_boundary') return [{ kind: 'compact', ts }];
    if (e.subtype === 'local_command' && typeof e.content === 'string') {
      if (/Compaction (?:cancel|abort)|AbortError/i.test(e.content)) {
        return [{ kind: 'compact', canceled: true, ts }];
      }
      // v55 (user repro 2026-06-09): a /compact that does nothing — « Not
      // enough messages to compact. » — writes a local_command STDOUT, not a
      // compact_boundary and not a cancel/abort. Without recognizing it the
      // deck-driven compaction card hangs on its optimistic bar until the
      // 10-min safety timeout. Resolve it as a no-op (distinct from a user
      // cancel: nothing was compacted, nothing failed). The match stays
      // compact-specific so it never fires on an unrelated slash-command stdout.
      if (/Not enough messages to compact/i.test(e.content)) {
        return [{ kind: 'compact', canceled: true, noop: true, ts }];
      }
    }
    // v50: the Stop-hook roster of a finished turn. The goal hook is the one
    // carrying a promptText (the goal condition); the chat uses its presence +
    // preventedContinuation to auto-clear the « Goal actif » footer once met.
    if (e.subtype === 'stop_hook_summary' && Array.isArray(e.hookInfos)) {
      const prompts = e.hookInfos
        .map((h) => (h && typeof h.promptText === 'string') ? h.promptText : '')
        .filter(Boolean);
      return [{ kind: 'goalhook', prompts, prevented: e.preventedContinuation === true, ts }];
    }
    return [];
  }
  if (e.isCompactSummary) return [];
  // v74: background/async sub-agent completion signals that live OUTSIDE the
  // user/assistant branches below — an 'attachment' line (queued_command
  // carrying the <task-notification> text, tool-use-id present) and a
  // 'queue-operation' line (a "stopped" batch enqueued at session start, often
  // several <task-id> with NO <tool-use-id> — resolved through the agentId map
  // built from ACKs seen earlier in the same stream, see taskNotificationEvents).
  // v81: the same two shapes also carry a sub-agent hand-back (<agent-message> + frame): its
  // 'agentReport' event is ADDED to the notification output (the two carriers never overlap).
  if (e.type === 'attachment') {
    const att = e.attachment;
    const prompt = att && att.type === 'queued_command' && typeof att.prompt === 'string' ? att.prompt : null;
    return prompt ? [
      ...taskNotificationEvents(prompt, ts, agentIdMap), ...agentReportEvents(prompt, ts),
      ...(att.commandMode === 'task-notification' ? stopTextEvents(prompt, ts) : []),
      // a prompt typed while Claude is busy is logged ONLY as this attachment (no `user` line): state-only receipt event
      ...(att.commandMode === 'prompt' && att.origin && att.origin.kind === 'human' ? [{ kind: 'queuedPrompt', text: prompt, ts }] : []),
    ] : [];
  }
  if (e.type === 'queue-operation') {
    return typeof e.content === 'string'
      ? [
        ...taskNotificationEvents(e.content, ts, agentIdMap), ...agentReportEvents(e.content, ts),
        ...(e.operation === 'enqueue' ? stopTextEvents(e.content, ts) : []), // `remove` only echoes the enqueue
      ]
      : [];
  }
  const m = e.message;
  const out = [];
  if (e.type === 'user' && m) {
    const content = m.content;
    const blocks = Array.isArray(content)
      ? content
      : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const full = blockText(b.content);
        // v74: an Agent() result (async ACK or foreground completion) carries the
        // dispatch's agentId at the TOP level (e.toolUseResult), next to THIS
        // block's tool_use_id — the only place the two ids are seen together.
        // Recorded so a later resume / TaskOutput result / task-id-only
        // notification (no tool-use-id of their own) resolves to the known row.
        if (agentIdMap && e.toolUseResult
            && typeof e.toolUseResult.agentId === 'string' && b.tool_use_id) {
          agentIdMap.set(e.toolUseResult.agentId, b.tool_use_id);
        }
        const t = capText(full, RESULT_CAP);
        const resultEv = {
          kind: 'result', toolUseId: b.tool_use_id || null,
          text: t.text, truncated: t.truncated, isError: b.is_error === true,
          // v71: distinguish an async-LAUNCH ack from a real COMPLETION result.
          // Only run_in_background:true emits a later <task-notification>; a
          // NON-background agent returns its final message AS this tool_result
          // (harness: "the agent's final message is returned as the tool result").
          // The bg roster reaps a non-bg row on its real result instead of waiting
          // for an agentDone that will never come (ASYNC_ACK_RE = the same ack
          // detector trackDispatches already uses, kept as the single source).
          ack: ASYNC_ACK_RE.test(full),
          ts, // v46.2: the interrupt detector needs the marker's timestamp
        };
        // v80: two agent ids ride the harness-written `toolUseResult` (never the result text, which any tool
        // output can imitate). `resumedAgentId` = a SendMessage that RESUMED a finished sub-agent (measured
        // shape: {success, message:'Resuming agent …', resumedAgentId, pin}); a message to a peer session or a
        // running agent carries none. The resumed run ends with its own <task-notification> whose tool-use-id
        // is this SendMessage call's id, so the chat roster can key the run by this result's toolUseId.
        // `agentId` = the async-launch ACK's id, so a later resume can be labelled with the agent's type.
        // (v81: a hand-back result carries `agentId` too, set below from the placeholder / handbackReport.)
        const tur = e.toolUseResult;
        if (tur && typeof tur === 'object' && b.is_error !== true) {
          if (typeof tur.resumedAgentId === 'string' && tur.resumedAgentId) {
            resultEv.resumedAgentId = tur.resumedAgentId.slice(0, 64);
            // a new resume supersedes this agent's previous waiting run (other agents' entries stay)
            if (agentIdMap) {
              const runs = waitingRunByTask.get(agentIdMap);
              const old = runs && runs.get(resultEv.resumedAgentId);
              if (old) {
                let dead = supersededRuns.get(agentIdMap);
                if (!dead) supersededRuns.set(agentIdMap, dead = new Set());
                dead.add(old);
                runs.delete(resultEv.resumedAgentId);
              }
            }
          }
          if (tur.isAsync === true && typeof tur.agentId === 'string' && tur.agentId) resultEv.agentId = tur.agentId.slice(0, 64);
          // Background shells: a Bash run_in_background result carries `backgroundTaskId`; a successful TaskStop
          // result is {message:'Successfully stopped task: …', task_id, task_type, command} (a TaskOutput has no such message).
          if (typeof tur.backgroundTaskId === 'string' && tur.backgroundTaskId) resultEv.bgTaskId = tur.backgroundTaskId.slice(0, 64);
          if (typeof tur.message === 'string' && tur.message.startsWith('Successfully stopped task')
              && typeof tur.task_id === 'string' && tur.task_id) resultEv.stoppedTaskId = tur.task_id.slice(0, 64);
        }
        // v81: the hand-back placeholder -> the agent's id + a flag, so the chat can show the
        // agent's 'agentReport' (joined by agentId) instead of the placeholder text. The
        // result's other fields stay exactly as they were; an id already set above is kept.
        const hb = handbackPlaceholder(full);
        // The harness-written `toolUseResult` of the SAME line is the PRIMARY source (it cannot be
        // imitated by a tool output quoting the sentence, and it is unambiguous for a resumed agent
        // handing back twice): `handback === 'send'` + `handbackReport.text` = this call's report.
        // The text detection above stays the fallback for a line without it.
        const hr = harnessHandback(tur, hb);
        if (hb || hr) {
          resultEv.handback = true;
          const hid = (hb && hb.agentId) || (hr && hr.agentId);
          if (hid && !resultEv.agentId) resultEv.agentId = hid;
        }
        if (hr && hr.report) {
          const rep = capText(hr.report, TEXT_CAP);
          resultEv.report = rep.text;
          resultEv.reportTruncated = rep.truncated;
        }
        out.push(resultEv);
        // v74: a TaskOutput retrieval result (manual poll / SendMessage) carries
        // its own terminal <status> keyed by task_id === the ACK's agentId — the
        // SAME completion signal as a <task-notification>, just shaped as a tool
        // result instead of a user turn. This 'result' event above is untouched
        // (still a normal tool card); this is an ADDITIONAL agentDone signal.
        if (agentIdMap) {
          const taskOutput = parseTaskOutputResult(full);
          if (taskOutput) {
            const toolUseId = agentIdMap.get(taskOutput.taskId);
            if (toolUseId) out.push({ kind: 'agentDone', toolUseId, status: taskOutput.status, ts });
          }
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        // The plain-text stop notice as a user turn: only the harness's own (origin task-notification);
        // a line the user typed is a message, never a stop. The line itself flows on unchanged below.
        if (e.origin && e.origin.kind === 'task-notification') out.push(...stopTextEvents(b.text, ts));
        const gset = GOAL_SET_RE.exec(b.text);
        const mset = MODEL_SET_RE.exec(b.text); // v73: /model confirmation
        const doneNotif = parseTaskNotification(b.text); // v68: bg agent completion signal
        const waitingNotif = recordWaiting(b.text, agentIdMap); // never an agentDone
        if (waitingNotif) out.push(waitingEvent(waitingNotif, ts));
        if (gset) {
          out.push({ kind: 'goal', action: 'set', text: gset[1].trim(), ts });
        } else if (mset) {
          // v73: state-only — the badge reads it through session-context, the
          // chat body never shows it (the noise filter below would drop the
          // line anyway). « (default) » is an account-scope suffix Claude Code
          // appends, not part of the model name.
          out.push({ kind: 'modelSet', model: mset[1].replace(/\s+\(default\)$/, ''), ts });
        } else if (GOAL_CLEAR_RE.test(b.text)) {
          out.push({ kind: 'goal', action: 'clear', ts });
        } else if (doneNotif) {
          // v68: surface ONLY the completion signal; the notification itself stays
          // out of the chat body (the USER_NOISE_RE branch below would drop it).
          out.push({ kind: 'agentDone', toolUseId: doneNotif.toolUseId, status: doneNotif.status, ts });
        } else if (waitingNotif) {
          // signal only (the agentWaiting event is pushed above): a prefixed waiting notice would
          // otherwise fall to the user-card branch, which the noise filter only catches unprefixed.
        } else {
          // Tier 1 review Finding 3 (DEFECT-FIX): unwrap ONCE before the
          // empty/noise/slash checks below, not after — those filters must
          // see the same text a bare (unwrapped) record would have produced,
          // so a wrapped empty/whitespace-only paste is dropped like empty
          // text, and a wrapped bare slash-command echo or noise tag is
          // filtered like its unwrapped form, instead of leaking through as
          // a blank or echoed user card.
          const unwrapped = unwrapPastedContent(b.text);
          if (unwrapped.trim() && !e.isMeta && !USER_NOISE_RE.test(unwrapped) && !SLASH_ECHO_RE.test(unwrapped)) {
            const t = capText(unwrapped, TEXT_CAP);
            out.push({ kind: 'user', text: t.text, truncated: t.truncated, ts });
          }
        }
      }
    }
  } else if (e.type === 'assistant' && m && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()
          && !ASSISTANT_NOISE.has(b.text.trim())) {
        const t = capText(b.text, TEXT_CAP);
        out.push({ kind: 'text', text: t.text, truncated: t.truncated, ts });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        const t = capText(b.thinking, THINK_CAP);
        out.push({ kind: 'thinking', text: t.text, truncated: t.truncated, ts });
      } else if (b.type === 'tool_use') {
        let detail = '';
        try { detail = JSON.stringify(b.input, null, 2) || ''; } catch (_) { /* cyclic? never seen */ }
        if (detail.length > DETAIL_CAP) detail = detail.slice(0, DETAIL_CAP) + '\n…';
        // Sub-agent dispatches carry their type — the chat names them (v44).
        const agentType = (b.input && typeof b.input.subagent_type === 'string')
          ? b.input.subagent_type : null;
        // v65: a BACKGROUND dispatch (run_in_background) returns its tool_result
        // IMMEDIATELY (« Agent started in the background… ») — an ACK, NOT the
        // agent's completion (that lands later as a <task-notification> user
        // line, USER_NOISE_RE-filtered). The ack must never close the live tail
        // or flip the tree row to « terminé », else a backgrounded agent never
        // shows as working (foreground OK, background not — user repro).
        const bg = !!(b.input && b.input.run_in_background === true);
        // The model alias the dispatch asked for ("sonnet", "opus"…); null when absent.
        const model = agentType && typeof b.input.model === 'string' && b.input.model ? b.input.model : null;
        out.push({
          kind: 'tool', id: b.id || null, name: b.name || '?',
          summary: toolSummary(b.input), detail, ts, agentType, model, bg,
          ask: askOptions(b.input, b.name),
          askQuestions: askQuestions(b.input, b.name),
        });
      }
    }
    const u = m.usage;
    if (out.length && u && typeof u === 'object') {
      out[out.length - 1].tokens = {
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
        cache: u.cache_read_input_tokens || 0,
        // v47: full input-side context for THIS request (= the chat strip's
        // "used"): prompt + cache read + cache creation. Drops after /compact.
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      };
    }
    // v66: the session's model rides the SAME event as the usage (the message's
    // last event). Unusable ids are noise: '<synthetic>' and non-strings yield NO
    // field at all, so an absent model can never overwrite a real observed one.
    const mdl = m.model;
    if (out.length && typeof mdl === 'string' && mdl && mdl !== '<synthetic>') {
      out[out.length - 1].model = mdl;
    }
  }
  return out;
}

// askOptions/askQuestions exported for probe-level unit testing only (the
// byte-identical contract on askOptions needs to be checked against HEAD in
// isolation, without normalizing a whole line) — normalizeLine stays the one
// real entry point every caller uses.
module.exports = { normalizeLine, toolSummary, ASYNC_ACK_RE, askOptions, askQuestions };
