// claude-deck — agent-lifecycle: the ONE pure lifecycle function of a sub-agent run.
//
//   classifyOwnRecord(line)  one raw line of an agent's OWN transcript (agent-<id>.jsonl) -> a small record
//   newOwnFold() / foldOwnRecord(fold, rec)  one-pass fold -> { lastTs, terminalTs, openChildren }   (contract K2)
//   agentState(entry, own, facts)  the reducer -> { state, endTs, reason }                           (contract K3)
//
// Pure and electron-free: it requires only the two parsers it shares with the rest of the main process.
// It reads no clock and no file; liveness, the `closedAt` / `stoppedAt` memos and `silentOver` arrive as facts.
// `reason` is probe-only (no production consumer, no IPC payload).
'use strict';

const { parseTaskNotification } = require('./task-notification');
const { ASYNC_ACK_RE } = require('./transcript-normalize');

const EMPTY = Object.freeze([]);
const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]*)"/;
// A line holding none of these cannot change anything but `lastTs`: it skips JSON.parse.
const MARKERS = ['"tool_result"', '"SubagentStop"', '"end_turn"', '"run_in_background"', 'SubagentHandback', '<task-notification'];
const BLOCKED_STATUS = new Set(['failed', 'killed', 'stopped']);

function ms(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// kind: stop | endTurn | bgLaunch | childFinal | childError | other. `handbackResult` needs the tool_use name
// of an EARLIER record, so the fold resolves it from `handbackIds` / `resultIds`.
// opens = child ids launched here; closes = child ids closed here; att = an `attachment` record.
function rec(kind, ts, att, extra) {
  return { kind, ts, att, opens: EMPTY, closes: EMPTY, handbackIds: EMPTY, resultIds: EMPTY, ...extra };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

// An async-launch ACK: the sentence AND the harness-written fact on the record (`toolUseResult`), because the
// sentence alone is quoted by Read/Bash output and by a finished foreground agent's final message.
function isAck(block, tur) {
  return !!tur && typeof tur === 'object' && (tur.status === 'async_launched' || tur.isAsync === true)
    && ASYNC_ACK_RE.test(textOf(block.content));
}

function classifyAttachment(o, ts) {
  const a = o.attachment;
  if (a && typeof a === 'object') {
    if (a.hookEvent === 'SubagentStop') return rec('stop', ts, true);
    if (a.type === 'queued_command' && typeof a.prompt === 'string') {
      const n = parseTaskNotification(a.prompt);
      if (n) return rec('childFinal', ts, true, { closes: [n.toolUseId] });
    }
  }
  return rec('other', ts, true);
}

function classifyAssistant(o, ts) {
  const msg = o.message && typeof o.message === 'object' ? o.message : {};
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const bg = []; const handback = [];
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
    if (b.name === 'SubagentHandback') handback.push(b.id);
    if (b.input && b.input.run_in_background === true) bg.push(b.id);
  }
  if (msg.stop_reason === 'end_turn') return rec('endTurn', ts, false);
  return rec(bg.length ? 'bgLaunch' : 'other', ts, false, { opens: bg, handbackIds: handback });
}

function classifyUser(o, ts) {
  const content = o.message && o.message.content;
  const opens = []; const closes = []; const resultIds = [];
  let fin = false; let err = false;
  const note = (text) => {
    const n = parseTaskNotification(text);
    if (n) { closes.push(n.toolUseId); fin = true; }
  };
  if (typeof content === 'string') note(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') note(b.text);
      else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultIds.push(b.tool_use_id);
        if (b.is_error === true) { closes.push(b.tool_use_id); err = true; }
        else if (isAck(b, o.toolUseResult)) opens.push(b.tool_use_id);
      }
    }
  }
  const kind = fin ? 'childFinal' : err ? 'childError' : opens.length ? 'bgLaunch' : 'other';
  return rec(kind, ts, false, { opens, closes, resultIds });
}

function classifyOwnRecord(line) {
  if (typeof line !== 'string' || !line) return rec('other', null, false);
  if (!MARKERS.some((m) => line.includes(m))) {
    const m = TS_RE.exec(line);
    // `att` still matters here: attachments are transparent to the "previous record" test of the fold
    const att = line.includes('"type":"attachment"') && line.includes('"attachment":{');
    return rec('other', m ? ms(m[1]) : null, att);
  }
  let o;
  try { o = JSON.parse(line); } catch (_) { return rec('other', null, false); }
  if (!o || typeof o !== 'object') return rec('other', null, false);
  const ts = ms(o.timestamp);
  if (o.type === 'attachment') return classifyAttachment(o, ts);
  if (o.type === 'assistant') return classifyAssistant(o, ts);
  if (o.type === 'user') return classifyUser(o, ts);
  return rec('other', ts, false);
}

// The public view is { lastTs, terminalTs, openChildren }; the underscore fields are fold bookkeeping.
function newOwnFold() {
  return { lastTs: null, terminalTs: null, openChildren: 0, _children: new Set(), _handback: new Set(), _ready: false };
}

// Mutates and returns `fold`. A record with no usable timestamp (junk, api-request-blob) cannot be ordered and
// counts for nothing. terminalTs = a SubagentStop that is the LAST record and follows an end_turn assistant
// record or a SubagentHandback result (attachments in between are transparent); any later record clears it.
function foldOwnRecord(fold, r) {
  if (!fold || !r || typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return fold;
  fold.terminalTs = r.kind === 'stop' && fold._ready ? r.ts : null;
  if (!r.att) {
    fold._ready = r.kind === 'endTurn' || r.resultIds.some((id) => fold._handback.has(id));
  }
  for (const id of r.handbackIds) fold._handback.add(id);
  for (const id of r.opens) fold._children.add(id);
  for (const id of r.closes) fold._children.delete(id);
  fold.lastTs = r.ts;
  fold.openChildren = fold._children.size;
  return fold;
}

// K3 v8. Terminal evidence of the current run, in tie order: final > own-tail > stoppedAt > closedAt. An item older
// than R = max(own.lastTs, startTs) is ignored (an own record after it re-opens the run); T >= R is terminal.
// endTs = the ts of the item that attains T (null when there is none).
function agentState(entry, own, facts) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const o = own && typeof own === 'object' ? own : {};
  const f = facts && typeof facts === 'object' ? facts : {};
  const live = f.sessionLive === true ? true : f.sessionLive === false ? false : null;
  const startTs = ms(e.startTs);
  const lastTs = ms(o.lastTs);
  const R = Math.max(startTs === null ? -Infinity : startTs, lastTs === null ? -Infinity : lastTs);
  const openChildren = Number.isFinite(o.openChildren) && o.openChildren > 0;
  const tail = ms(o.terminalTs);

  const items = [];
  if (e.final && typeof e.final === 'object' && typeof e.final.status === 'string') {
    // a final without a usable ts cannot be ordered: it is taken as current (never silently dropped)
    const ts = ms(e.final.ts) ?? (Number.isFinite(R) ? R : null);
    if (ts !== null) {
      const blocked = BLOCKED_STATUS.has(e.final.status.toLowerCase());
      items.push({ ts, state: blocked ? 'blocked' : 'done', reason: e.final.source === 'result' ? 'result' : 'final' });
    }
  }
  if (tail !== null && !openChildren) items.push({ ts: tail, state: 'done', reason: 'own-tail' });
  const stoppedAt = ms(f.stoppedAt);
  if (stoppedAt !== null) items.push({ ts: stoppedAt, state: 'blocked', reason: 'stop' });
  const closedAt = ms(f.closedAt);
  if (closedAt !== null) items.push({ ts: closedAt, state: 'closed', reason: 'session' });

  let best = null;
  for (const it of items) if (it.ts >= R && (best === null || it.ts > best.ts)) best = it; // strict >: the earlier item wins a tie
  if (best) return { state: best.state, endTs: best.ts, reason: best.reason };

  if (live === false) return { state: 'closed', endTs: null, reason: 'session' };
  if (live === null) return { state: 'unknown', endTs: null, reason: f.silentOver ? 'silence' : 'liveness' };
  const waitingTs = ms(e.waitingTs);
  if ((tail !== null && openChildren && tail >= R) || (waitingTs !== null && waitingTs >= R)) {
    return { state: 'waiting', endTs: null, reason: 'waiting' };
  }
  return { state: 'running', endTs: null, reason: 'live' };
}

module.exports = { classifyOwnRecord, newOwnFold, foldOwnRecord, agentState };
