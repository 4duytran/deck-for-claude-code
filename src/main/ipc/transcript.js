// claude-deck — ipc/transcript (v42): data feed of the per-pane CHAT VIEW —
// the session .jsonl rendered as normalized chat events instead of raw TUI
// scrollback. One subscription per pane: a bounded full read at subscribe
// time (the reply), then incremental tail pushes (fs.watch + safety poll)
// on the 'transcript-append' channel, routed by paneId.
// Identity follows the same alias discipline as the git/plans panels
// (effectiveSessionId: pty registry + resumeIdMap); the poll re-anchors onto
// the post-resume file when the id drifts mid-flight (reset push — the view
// is rebuilt from a clean full read, never diffed across two files).
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { send } = require('../window');
const { findSessionFile } = require('../transcripts');
const { effectiveSessionId, sessionActivity, agentStatesOf } = require('../session-activity'); // S3: sessionActivity backs the journal subscribe response's `agent` field; L4: agentStatesOf = the lifecycle of every ledger entry
const { readSessionStatusEntry, statusAgeMs, statusCache, markInterruptedIdle, markMenuGone, readSessionEffort, sessionLivenessSince } = require('../session-status');
const { ptys, ptyOpening, resumeIdMap, statusAlias } = require('../state');
const { CONTEXT_WINDOW_TOKENS, UUID_RE } = require('../config'); // v47: chat-mode context strip window; UUID_RE: S3 journal target validation
const { normalizeLine, toolSummary, ASYNC_ACK_RE } = require('./../transcript-normalize'); // S1: pure line/event normalizer (electron-free), shared with session-activity.js

// Bounded costs everywhere: transcripts reach tens of MB on this machine —
// the view reads a bounded TAIL and keeps a bounded number of events; the
// dropped head is flagged so the renderer says so instead of lying by omission.
const READ_CAP_BYTES = 4 * 1024 * 1024;
const TICK_BUSY = new Set(['working', 'running', 'waiting']); // mirror of the renderer's BUSY_STATUSES
const STALE_BUSY_MS = 5 * 60 * 1000; // busy file untouched for 5min = fossil
const MAX_EVENTS = 600;

// v45.2 fossil guard: a BUSY status whose file was not refreshed for
// STALE_BUSY_MS is a leftover from a session that died without
// SessionEnd/PtyExit (crash, reboot) — a LIVE busy session pulses its file
// constantly (UserPromptSubmit/PreToolUse/PostToolUse). Without this, the
// chat strip shows « Claude réfléchit » + bouncing dots from the moment the
// chat opens, on a session doing nothing at all.
function freshStatus(sid) {
  const entry = readSessionStatusEntry(sid);
  if (!TICK_BUSY.has(entry.status)) return entry.status;
  // Age = max(ts, file mtime): while the main agent waits on a FOREGROUND subagent only the
  // subagent's tool events pulse the file — the status hook touches it (mtime only, content
  // untouched), so a long foreground Agent call never reads as a fossil.
  const age = statusAgeMs(entry);
  return (Number.isNaN(age) || age > STALE_BUSY_MS) ? 'idle' : entry.status;
}
const POLL_MS = 2000; // safety net under fs.watch + re-anchor cadence

const subs = new Map(); // paneId -> { paneId, target, file, offset, remainder, watcher, pollTimer }

// ---------------------------------------------------------------------------
// Line -> normalized chat events.
// Event kinds (the renderer's whole vocabulary):
//   { kind:'user',     text, truncated, ts }
//   { kind:'text',     text, truncated, ts, tokens? }   assistant prose
//   { kind:'thinking', text, truncated, ts }
//   { kind:'tool',     id, name, summary, detail, ts, tokens? }
//   { kind:'result',   toolUseId, text, truncated, isError }
//   { kind:'compact',  canceled?, ts }                      /compact boundary
//   { kind:'queuedPrompt', text, ts }   a prompt typed while busy (queued_command attachment): state only, no card
// tokens = { in, out, cache } — attached to the LAST block of an assistant
// message (per-message granularity, like the official desktop app's chips).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v46.6: sub-agent live activity. While an agent dispatch card is OPEN (its
// tool_use has no tool_result yet), the deck tails the sub-agent's own
// transcript (<main-file-minus-.jsonl>/subagents/agent-<id>.jsonl — linked
// by toolUseId in the sibling agent-<id>.meta.json) and pushes each tool
// call as it lands, so the chat card shows WHAT the agent is doing — same
// visibility as the terminal face. Poll-driven off the existing 2s tick:
// no extra fs.watch handles, latency is fine for a progress feed.
// ---------------------------------------------------------------------------

function agentDirOf(file) {
  return file.endsWith('.jsonl') ? `${file.slice(0, -6)}/subagents` : null;
}

// Sidechain lines: only the tool calls matter for the live feed (the user
// asked WHICH command / WHICH tool — text/thinking stay in the sub-agent
// transcript, not in the card).
function agentLineTools(line) {
  if (!line) return [];
  let e;
  try { e = JSON.parse(line); } catch (_) { return []; }
  if (!e || e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) return [];
  const out = [];
  for (const b of e.message.content) {
    if (b && typeof b === 'object' && b.type === 'tool_use') {
      out.push({
        name: b.name || '?', summary: toolSummary(b.input),
        ts: typeof e.timestamp === 'string' ? e.timestamp : null,
      });
    }
  }
  return out;
}

// Track open agent dispatches from a batch of NORMALIZED main-feed events.
// Open: tool event with an agentType + id. Close: its result lands — final
// drain (writes can race the result), then drop the tail.
function trackDispatches(sub, events) {
  for (const ev of events) {
    if (ev.kind === 'tool' && ev.agentType && ev.id) {
      sub.openDispatches.set(ev.id, ev.agentType);
      if (ev.bg) sub.bgDispatches.add(ev.id); // v65: its ack must not close the tail
    } else if (ev.kind === 'result' && ev.toolUseId && sub.openDispatches.has(ev.toolUseId)) {
      // v65: a backgrounded dispatch's tool_result is the immediate ACK, not the
      // agent's completion — keep it open so the sidechain tail keeps feeding the
      // card. The session going (confirmed) quiet reaps it via tick's
      // resetAgentTracking, so it is bounded, not a leak.
      // v67: promote an async-ACK result to background (see ASYNC_ACK_RE) so a
      // sub-agent launched WITHOUT run_in_background (but run async by the harness)
      // keeps its working row until the real completion, instead of closing here.
      if (ASYNC_ACK_RE.test(ev.text || '')) sub.bgDispatches.add(ev.toolUseId);
      if (sub.bgDispatches.has(ev.toolUseId)) continue;
      closeDispatch(sub, ev.toolUseId);
    }
  }
}

// Close one open dispatch: final drain of its tail, then drop it. Shared by a non-bg result, by a stranded
// foreground dispatch of a confirmed-quiet session, and (L4) by a bg dispatch whose lifecycle state is terminal.
function closeDispatch(sub, id) {
  const agentType = sub.openDispatches.get(id) || '';
  sub.openDispatches.delete(id);
  sub.bgDispatches.delete(id);
  const tail = sub.agentTails.get(id);
  if (tail) {
    drainAgentTail(sub, id, tail).finally(() => { sub.agentTails.delete(id); });
  } else {
    // v46.8: resolved WITHOUT ever having a live tail — an anchor replay
    // (rebuilt card has no feed) or an ultra-short dispatch. The history
    // is on disk: restore it once via a one-shot drain at the next scan.
    sub.resolvedDispatches.set(id, agentType);
  }
}

function resetAgentTracking(sub) {
  sub.openDispatches.clear();
  sub.bgDispatches.clear(); // v65: background dispatch ids (ack ≠ completion)
  sub.agentTails.clear();
  sub.agentMetaSeen.clear();
}

// Match new agent-<id>.meta.json files to open dispatches. A meta whose
// dispatch is not (yet) known stays unmarked — re-checked next tick (the
// meta can land before the main drain sees the tool_use).
// Review attack #1 (v46.8 cycle): a resolved id whose meta NEVER lands
// (subagents dir absent, meta deleted) must not pin a per-tick readdir for
// the pane's remaining life — the dispatch is over, its files either exist
// now or never will. N fruitless scans and the map drops.
function bumpResolvedMisses(sub) {
  if (!sub.resolvedDispatches.size) return;
  if (++sub.resolvedScanMisses >= 5) {
    sub.resolvedDispatches.clear();
    sub.resolvedScanMisses = 0;
  }
}

async function scanAgentDir(sub) {
  if (!sub.file || (!sub.openDispatches.size && !sub.resolvedDispatches.size)) return;
  const dir = agentDirOf(sub.file);
  if (!dir) return;
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { bumpResolvedMisses(sub); return; } // no subagents yet
  const replays = [];
  for (const n of names) {
    if (!n.endsWith('.meta.json') || sub.agentMetaSeen.has(n)) continue;
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    const id = meta && typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
    if (!id) continue;
    const jsonl = path.join(dir, n.replace(/\.meta\.json$/, '.jsonl'));
    if (sub.openDispatches.has(id) && !sub.agentTails.has(id)) {
      sub.agentMetaSeen.add(n);
      sub.agentTails.set(id, { file: jsonl, offset: 0, remainder: Buffer.alloc(0) });
    } else if (sub.resolvedDispatches.has(id)) {
      // v46.8 archive replay: one-shot full drain (same cap/push machinery,
      // throwaway tail — nothing stays open, the per-tick cost converges to 0).
      sub.agentMetaSeen.add(n);
      sub.resolvedDispatches.delete(id);
      replays.push(drainAgentTail(sub, id, { file: jsonl, offset: 0, remainder: Buffer.alloc(0) }));
    }
  }
  if (replays.length) {
    sub.resolvedScanMisses = 0;
    // Independent files — same concurrency rule as the live tails (attack #5).
    await Promise.all(replays);
  } else bumpResolvedMisses(sub);
}

// Review attack #4 (v46.6 cycle): a sub-agent transcript also stores its
// TOOL RESULTS — one fat result can put megabytes between two ticks. The
// feed is a progress view, not an archive: skip ahead and only parse the
// last chunk (the cut head line fails JSON.parse and is dropped).
const AGENT_DELTA_CAP = 1024 * 1024;
const AGENT_DELTA_KEEP = 64 * 1024;

async function drainAgentTail(sub, toolUseId, tail) {
  let st;
  try { st = await fsp.stat(tail.file); } catch (_) { return; } // .jsonl after meta: next tick
  if (st.size <= tail.offset) return;
  if (st.size - tail.offset > AGENT_DELTA_CAP) {
    tail.offset = st.size - AGENT_DELTA_KEEP;
    tail.remainder = Buffer.alloc(0);
  }
  let chunk;
  try { chunk = await readSlice(tail.file, tail.offset, st.size); } catch (_) { return; }
  tail.offset = st.size;
  const { lines, rest } = splitLines(Buffer.concat([tail.remainder, chunk]));
  tail.remainder = rest;
  const events = [];
  for (const line of lines) events.push(...agentLineTools(line));
  if (events.length) send('subagent-append', { paneId: sub.paneId, toolUseId, events });
}

async function agentTick(sub) {
  if (sub.agentScanBusy) return; // coalesce — a slow disk must not stack scans
  sub.agentScanBusy = true;
  try {
    await scanAgentDir(sub);
    // Review attack #3 (v46.6 cycle): tails are independent files — drain
    // them CONCURRENTLY so N parallel dispatches on a slow disk don't
    // serialize the advertised ≤2s feed latency.
    await Promise.all([...sub.agentTails].map(([id, t]) => drainAgentTail(sub, id, t)));
  } finally { sub.agentScanBusy = false; }
}

// ---------------------------------------------------------------------------
// Tail-reading machinery. The remainder is kept as a BUFFER, not a string:
// a multi-byte UTF-8 char split across two drains must never go through
// toString at the cut point (it would decay to U+FFFD on both sides — the
// same class of silent corruption the refactor audit hunted).
// v43 perf: ALL reads are async (fs/promises) — a 4MB initial read must
// never block the main-process event loop (review finding). Concurrency is
// tamed by two guards on the sub: `draining` (coalesce overlapping drains)
// and `epoch` (an anchor/unsubscribe invalidates any in-flight read before
// it can mutate state or push stale events).
// ---------------------------------------------------------------------------

async function readSlice(file, start, end) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, buf.length, start);
    return buf;
  } finally {
    await fh.close();
  }
}

// Split on the LAST newline: parse the complete-lines prefix, keep the
// partial tail (claude mid-write) as the next remainder.
function splitLines(buf) {
  const cut = buf.lastIndexOf(0x0a);
  if (cut === -1) return { lines: [], rest: buf };
  return { lines: buf.slice(0, cut).toString('utf8').split('\n'), rest: buf.slice(cut + 1) };
}

// v46.6+S3: `opts` is threaded straight to normalizeLine and otherwise
// unused here — the per-pane call (`initialRead(file, sub.agentIdMap)`)
// passes no third argument, so its bounded-read behaviour (READ_CAP_BYTES /
// MAX_EVENTS / truncatedHead) is unchanged; the journal subscribe handler
// below reuses this SAME function with `initialRead(file, null, { sidechain: true })`
// (D7: same cap, same truncation contract, no second bounded-read implementation).
async function initialRead(file, agentIdMap, opts) {
  const st = await fsp.stat(file);
  let start = 0;
  let truncatedHead = false;
  if (st.size > READ_CAP_BYTES) {
    start = st.size - READ_CAP_BYTES;
    truncatedHead = true;
  }
  let buf = st.size ? await readSlice(file, start, st.size) : Buffer.alloc(0);
  if (start > 0) {
    const nl = buf.indexOf(0x0a); // drop the partial first line of the window
    buf = nl === -1 ? Buffer.alloc(0) : buf.slice(nl + 1);
  }
  const { lines, rest } = splitLines(buf);
  let events = [];
  for (const line of lines) {
    for (const ev of normalizeLine(line, agentIdMap, opts)) events.push(ev);
  }
  if (events.length > MAX_EVENTS) {
    events = events.slice(events.length - MAX_EVENTS);
    truncatedHead = true;
    // Edge accepted: a 'result' kept while its 'tool' card fell over the cut
    // has no card to land on — the renderer drops orphan results silently.
  }
  return { events, truncatedHead, offset: st.size, remainder: rest };
}

// ---------------------------------------------------------------------------
// Subscriptions.
// ---------------------------------------------------------------------------

// Pane first (pty registry + resumeIdMap — alias-aware while the pty lives),
// then the renderer-known sessionId, alias-resolved by hand (exited pane:
// the pty entry is gone but the resume drift may already be recorded).
function resolveSid(target) {
  const viaPane = effectiveSessionId({ paneId: target.paneId });
  if (viaPane) return viaPane;
  const sid = typeof target.sessionId === 'string' ? target.sessionId : null;
  return sid ? (resumeIdMap.get(sid) || sid) : null;
}

// v47: chat-mode context strip — the deck computes the window fill ITSELF from
// the transcript (no statusline/collector dependency, though the injected
// --settings statusLine does run next to a user statusLine). "used" = the
// LATEST main-chain assistant message's input-side tokens; window = a deck
// constant (the transcript carries no window size). isSidechain lines are
// already dropped by normalizeLine, so sub-agent usage never leaks in.
function latestCtxTokens(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i] && events[i].tokens;
    if (t && typeof t.ctx === 'number' && t.ctx > 0) return t.ctx;
  }
  return null;
}
// v66: model of the latest main-chain event carrying one — an assistant message,
// or (v73.1) a « /model » modelSet event on the user branch, which carries the
// confirmation LABEL in that same .model field. normalizeLine already dropped
// unusable ids, so a present field is by construction usable.
function latestModel(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const md = events[i] && events[i].model;
    if (typeof md === 'string' && md) return md;
  }
  return null;
}
function ctxPayload(used, model, confirmed = false) {
  if (used == null) return null;
  return {
    used_tokens: used,
    window: CONTEXT_WINDOW_TOKENS,
    used_percentage: Math.min(100, (used / CONTEXT_WINDOW_TOKENS) * 100),
    // v66: session model — null whenever nothing usable has been observed.
    model: model || null,
    // v73: true only on a push carrying a « /model » CONFIRMATION. The renderer
    // drops its pending hint on it even when the model is UNCHANGED (a re-pick
    // of the same model is still a confirmed switch).
    model_confirmed: confirmed === true,
  };
}
// v73.1: `live` marks a DRAIN batch (lines freshly appended to the file). An
// anchor read replays a bounded historical tail, where a past « /model » line is
// NOT a live confirmation — counting it would push model_confirmed on every
// (re)anchor and bypass the event dedupe below.
function maybePushCtx(sub, events, live = false) {
  // v73: a « /model » confirmation carries NO usage, so a confirmation-only
  // batch used to return here and the badge stayed pending until the next
  // assistant message. Replay the last known ctx value instead — the model
  // derivation below is UNCHANGED: latestModel already returns the confirmed
  // label because the modelSet event carries .model like an assistant one.
  const confirmed = live && events.some((ev) => ev && ev.kind === 'modelSet');
  let used = latestCtxTokens(events);
  if (used == null) {
    if (!confirmed || sub.lastUsed == null) return; // keep the last value
    used = sub.lastUsed;
  } else {
    sub.lastUsed = used;
  }
  // v66: a usage-only batch still pushes the LAST KNOWN model; a batch whose
  // model is absent or unusable never erases it (only a rewrite reset does).
  const model = latestModel(events) || sub.lastModel || null;
  sub.lastModel = model;
  const sid = resolveSid(sub.target);
  if (!sid) return;
  // Dedup on DESTINATION:value (not value alone) — status parity (lastPushedKey,
  // :572): a resume-fork alias wiring changes the destination id while the ctx
  // value is unchanged; a value-only dedup would strand the strip on the forked
  // pane until ctx happened to change (review attack #4).
  const dest = statusAlias.get(sid) || sid;
  const key = `${dest}:${used}:${model || ''}`;
  // v73: the dedup guards a VALUE re-push; a confirmation is an EVENT and must
  // always land. Re-picking the SAME model yields an identical key, and
  // deduping it would strand the pending hint until the 60 s fallback.
  if (!confirmed && key === sub.lastCtxKey) return;
  sub.lastCtxKey = key;
  send('session-context', { sessionId: dest, context: ctxPayload(used, model, confirmed) });
}

// The statusline level under the id the renderer holds, null while the session has no collector file:
// main is the one authority at a (re)anchor, the renderer's reset never guesses it.
function pushEffort(sub) {
  const sid = resolveSid(sub.target);
  if (sid) send('session-effort', { sessionId: statusAlias.get(sid) || sid, level: readSessionEffort(sid) });
}

// ---------------------------------------------------------------------------
// L4: agent lifecycle on the feed. ONE source: session-activity's agentStatesOf (the K3 reducer over the cached
// fold). The feed pushes `{kind:'agentState', toolUseId, state, seq, agentType, summary}` in the append push when
// a state differs from the last one sent on this subscription; `unknown` is a state like any other.
// PUSH SET = the tracked dispatches (bounded tail) + every ledger entry running/waiting (the full fold: a dispatch
// older than the tail never shows in `events`) + what was sent before (so a running -> done change still goes out).
// ---------------------------------------------------------------------------
const AGENT_TERMINAL = new Set(['done', 'blocked', 'closed']);
const AGENT_LIVE = new Set(['running', 'waiting']);

// dispatch id and resume call id -> the ledger entry (agentType / description)
function ledgerEntries(activity) {
  const out = new Map();
  for (const a of activity.agents || []) {
    out.set(a.toolUseId, a);
    const ev = activity.agentEv && activity.agentEv.get(a.toolUseId);
    if (ev && ev.runId && ev.runId !== a.toolUseId) out.set(ev.runId, a);
  }
  return out;
}

// A pane's chat subscribes in the same renderer task as, and just ahead of, its pty-open: until that pty is registered the
// liveness has no spawn time for the pane, so a run recorded before the pane opened (it died with the previous CLI) would read
// « live ». The feed waits for its own pane's spawn: while pty-open is in flight (ptyOpening), and for SPAWN_WAIT_MS after the
// subscription for a pty-open still on its way. A subscription whose pane never opens a pty here (none ever shows up) then
// goes on as before, and so does a pane that exited (its entry is gone, the session's PtyExit status answers).
const SPAWN_WAIT_MS = 1000;
const SPAWN_RETRY_MS = 100;
function spawnPending(sub) {
  return !ptys.has(sub.paneId) && (ptyOpening.has(sub.paneId) || Date.now() - sub.bornAt < SPAWN_WAIT_MS);
}

// Compute and push the agentState changes of `sub`, then close the bg dispatches that reached a terminal state.
// Epoch-checked after the only await: a computation started before an anchor never pushes after it (D-A1).
async function agentStateSync(sub, ep) {
  const sid = resolveSid(sub.target);
  if (!sid || !sub.file) return;
  let activity;
  try { activity = await sessionActivity(sid); } catch (_) { return; }
  if (sub.epoch !== ep) return;
  // Change test: with every state terminal and no dispatch open, liveness cannot move a state (K3 rule 4), so the states
  // only move when the cached fold is a new object (any transcript, own-transcript or archive change). A non-terminal
  // state keeps `ledgerOpen` set, so the tick recomputes anyway. Liveness is handed UNREAD: agentStatesOf reads it only
  // for a non-terminal entry (K5), so an all-terminal subscription makes no liveness call at all.
  if (!sub.openDispatches.size && !sub.ledgerOpen && sub.agentActivity === activity) return;
  sub.agentActivity = activity;
  let held = false; // the liveness says « live » with no spawn time while this pane's pty is still to come
  const states = agentStatesOf(sid, () => {
    const lv = sessionLivenessSince(sid);
    held = held || (lv.live === true && lv.sinceMs === null && spawnPending(sub));
    return lv;
  });
  if (held) {
    sub.ledgerOpen = true; // states unknown: keep the tick (and the change test) computing
    // null = owed: the entries the provisional verdict reads live are reported once their state settles (a run that
    // died with the previous CLI gets its `closed` push, as it did after the transient `running`).
    for (const [id, res] of states) if (AGENT_LIVE.has(res.state) && !sub.agentSent.has(id)) sub.agentSent.set(id, null);
    clearTimeout(sub.spawnRetry);
    sub.spawnRetry = setTimeout(() => { sub.spawnRetry = null; agentStateTick(sub); }, SPAWN_RETRY_MS);
    return;
  }
  sub.agentWatch = states.size > 0;
  const entries = ledgerEntries(activity);
  const pushSet = new Set([...sub.openDispatches.keys(), ...sub.agentSent.keys()]);
  for (const [id, res] of states) if (AGENT_LIVE.has(res.state)) pushSet.add(id);
  const events = [];
  for (const id of pushSet) {
    const res = states.get(id);
    if (!res || sub.agentSent.get(id) === res.state) continue;
    sub.agentSent.set(id, res.state);
    const entry = entries.get(id);
    events.push({
      kind: 'agentState', toolUseId: id, state: res.state, seq: ++sub.agentSeq,
      agentType: (entry && entry.agentType) || sub.openDispatches.get(id) || '',
      summary: (entry && entry.description) || '',
    });
  }
  sub.ledgerOpen = [...states.values()].some((r) => !AGENT_TERMINAL.has(r.state));
  if (events.length) send('transcript-append', { paneId: sub.paneId, events });
  for (const id of [...sub.bgDispatches]) {
    const res = states.get(id);
    if (res && AGENT_TERMINAL.has(res.state) && sub.openDispatches.has(id)) closeDispatch(sub, id);
  }
}

// Poll-driven: a subscription with an open dispatch, a non-terminal ledger entry, or any ledger entry at all (a
// terminal one can re-open). The latter costs one stamp-cached lookup per tick, reads no liveness and recomputes
// nothing while the change test of agentStateSync holds.
async function agentStateTick(sub) {
  if (sub.agentStateBusy || !sub.file) return;
  if (!sub.openDispatches.size && !sub.ledgerOpen && !sub.agentWatch) return;
  sub.agentStateBusy = true;
  try { await agentStateSync(sub, sub.epoch); } finally { sub.agentStateBusy = false; }
}

// The renderer's vocabulary has no consumer for the waiting notice (its state rides agentState).
const forRenderer = (events) => events.filter((ev) => ev.kind !== 'agentWaiting');

async function anchor(sub, file, isReset) {
  if (sub.watcher) {
    try { sub.watcher.close(); } catch (_) { /* already dead */ }
    sub.watcher = null;
  }
  const ep = ++sub.epoch; // invalidate any in-flight drain/anchor
  sub.file = file;
  // v74: rebuilt fresh on every (re)anchor — a reset/resume/fork replays THIS
  // file's own history from scratch, so an old file's agentId associations
  // don't apply (mirrors resetAgentTracking below for the same reason).
  sub.agentIdMap = new Map();
  let read;
  try { read = await initialRead(file, sub.agentIdMap); } catch (_) { return null; } // vanished between find and stat
  if (sub.epoch !== ep) return null; // superseded while reading
  sub.offset = read.offset;
  sub.remainder = read.remainder;
  // v46.6: a (re)anchor rebuilds the dispatch ledger from its own batch —
  // matching agent tails restart at offset 0 (the renderer rebuilt too).
  // v46.8: resolved dispatches re-collected too (archive replay) — cleared
  // ONLY here: an interrupt/quiet purge must not kill a pending one-shot
  // replay (it converges on its own and the renderer ignores duplicates).
  resetAgentTracking(sub);
  sub.resolvedDispatches.clear();
  trackDispatches(sub, read.events);
  // L4: the renderer rebuilds from this anchor, so every agent state is sent again from a fresh baseline.
  sub.agentSent.clear();
  sub.agentSeq = 0;
  sub.ledgerOpen = false;
  sub.agentWatch = false;
  sub.agentActivity = null; // the change test must not skip the pass that re-sends from the new baseline
  try {
    sub.watcher = fs.watch(file, { persistent: false }, () => { drain(sub); });
  } catch (_) { /* inotify refused — the poll still covers us */ }
  if (isReset) {
    send('transcript-append', {
      paneId: sub.paneId, reset: true,
      truncatedHead: read.truncatedHead, events: forRenderer(read.events),
    });
    pushEffort(sub); // after the append: the renderer rebuilds first, then takes the level
    sub.lastCtxKey = null; // v47: a file rewrite/reset must re-push even an unchanged ctx (attack #1)
    sub.lastModel = null; // v66: a rebuilt transcript with no model fact re-pushes model: null (never stale)
    sub.lastUsed = null; // v73: a rebuilt transcript re-derives its ctx value from the file, never from the old one
  }
  maybePushCtx(sub, read.events); // v47: (re)anchor refreshes the context strip
  // L4: the agent states follow the reset batch; on a fresh subscribe they wait for the reply to leave first.
  if (isReset) agentStateSync(sub, ep);
  else setImmediate(() => { agentStateSync(sub, ep); });
  return read;
}

async function drain(sub) {
  if (!sub.file) return;
  if (sub.draining) { sub.drainAgain = true; return; } // coalesce bursts
  sub.draining = true;
  const ep = sub.epoch;
  try {
    let st;
    try { st = await fsp.stat(sub.file); } catch (_) { return; } // deleted: poll re-anchors
    if (sub.epoch !== ep) return;
    if (st.size < sub.offset) { // replaced/rewritten: rebuild, never diff
      await anchor(sub, sub.file, true);
      return;
    }
    if (st.size === sub.offset) return;
    let chunk;
    try { chunk = await readSlice(sub.file, sub.offset, st.size); } catch (_) { return; }
    if (sub.epoch !== ep) return; // re-anchored mid-read: discard stale bytes
    sub.offset = st.size;
    const { lines, rest } = splitLines(Buffer.concat([sub.remainder, chunk]));
    sub.remainder = rest;
    const events = [];
    // v46.2: Esc aborts the turn without a Stop hook — the transcript marker
    // is the only signal that the busy status file is now a lie. TWO wire
    // shapes exist (review attack #5, counted in real transcripts): a USER
    // text block ('[Request interrupted by user]') and a TOOL_RESULT block
    // ('…for tool use]') when Esc lands mid-tool. A REAL user prompt seen
    // AFTER the marker in the same batch means the next turn already started
    // (attack #4) — drop the idle write, the busy file is legitimate again.
    let interruptTs = null;
    for (const line of lines) {
      for (const ev of normalizeLine(line, sub.agentIdMap)) {
        events.push(ev);
        const isMarker = (ev.kind === 'user' || ev.kind === 'result')
          && typeof ev.text === 'string'
          && ev.text.startsWith('[Request interrupted by user');
        if (isMarker) interruptTs = ev.ts || interruptTs || 'unknown';
        else if (ev.kind === 'user') interruptTs = null; // next turn started
      }
    }
    const shown = forRenderer(events);
    if (shown.length) send('transcript-append', { paneId: sub.paneId, events: shown });
    maybePushCtx(sub, events, true); // v47: refresh the strip (v73.1: live -> confirmations count)
    trackDispatches(sub, events); // v46.6: open/close agent tails from this batch
    if (interruptTs) {
      const sid = resolveSid(sub.target);
      if (sid) markInterruptedIdle(sid, interruptTs === 'unknown' ? null : interruptTs);
      // Review attack #2 (v46.6 cycle): an interrupt kills the turn — every
      // open dispatch died with it and its result will NEVER land. Purge the
      // ledger or the per-tick readdir+tail work runs for the pane's life.
      resetAgentTracking(sub);
    }
  } finally {
    sub.draining = false;
    if (sub.drainAgain) {
      sub.drainAgain = false;
      drain(sub); // one more pass for writes that landed mid-drain
    }
  }
}

// Poll tick: identity drift (resume fork) / late file birth (brand-new
// session subscribes before its first message lands) — then a drain pass
// (covers editors/filesystems where fs.watch under-reports).
function tick(sub) {
  const sid = resolveSid(sub.target);
  const file = sid ? findSessionFile(sid) : null;
  if (file && file !== sub.file) {
    anchor(sub, file, true); // async — epoch guard owns the race
    return;
  }
  drain(sub);
  agentTick(sub); // v46.6: sub-agent live feed (scan + tails), poll-only
  agentStateTick(sub); // L4: lifecycle states (push on change) and terminal bg dispatches
  // v45.2 status safety net (user repro: strip frozen on « réfléchit »): a
  // pane with an open chat re-reads its session's status every tick and
  // pushes it on the STANDARD channel when it changed — covers a missed
  // STATUS_DIR watcher event, a debounce race, or a fossil primed status
  // after a late resume re-anchor. Busy statuses push immediately (they can
  // never trigger a queue drain); QUIET statuses need two consecutive
  // identical reads — right after a queue drain the file still says 'idle'
  // for <1s until the drained message's UserPromptSubmit lands, and a single
  // stale read must never double-drain the next item early.
  if (sid) {
    const status = freshStatus(sid); // direct read: 1 read/2s/pane — cheap, always fresh
    let confirmed = null;
    if (TICK_BUSY.has(status)) {
      sub.quietSeen = null;
      confirmed = status;
    } else if (sub.quietSeen === status) {
      confirmed = status; // stable across two ticks -> trustworthy
      // Review attack #2 (v46.6 cycle), second leg: a turn that ended WITHOUT
      // an interrupt marker (crash, hook-only stop) also strands open
      // dispatches — a CONFIRMED quiet session can't resolve them anymore.
      // (A REAL quiet status only: null = no status file at all — sessions
      // without the hook must keep their live feed.)
      // L4: a bg dispatch outlives the turn and closes only on its own terminal state (agentStateTick); what a
      // quiet session still holds open in the foreground is stranded.
      if (confirmed) for (const id of [...sub.openDispatches.keys()]) if (!sub.bgDispatches.has(id)) closeDispatch(sub, id);
    } else {
      sub.quietSeen = status; // first sighting: wait for the next tick
    }
    // Dedup by DESTINATION+status (v45.2 attack #5): right after a resume,
    // a push may leave under the forked id before detectResumedSession wires
    // the alias — once the alias lands, the same status must be re-pushed
    // under the display id the panes actually know.
    const pushKey = `${statusAlias.get(sid) || sid}:${confirmed}`;
    if (confirmed !== null && pushKey !== sub.lastPushedKey) {
      sub.lastPushedKey = pushKey;
      statusCache.set(sid, confirmed); // keep the sidebar scan cache coherent
      send('session-status', { sessionId: statusAlias.get(sid) || sid, status: confirmed });
    }
  }
}

function unsubscribe(paneId) {
  const sub = subs.get(paneId);
  if (!sub) return;
  sub.epoch++; // kill any in-flight read
  if (sub.watcher) {
    try { sub.watcher.close(); } catch (_) { /* already dead */ }
  }
  clearInterval(sub.pollTimer);
  clearTimeout(sub.spawnRetry);
  subs.delete(paneId);
}

// ---------------------------------------------------------------------------
// S3: pane-independent agent-journal feed. Unlike `subs` above (one per
// pane), this overlay is SINGLE (C4) — `journalSub` holds at most one
// subscription, replaced whenever a new one lands. Resolution is independent
// of the dispatch's run state (C3): a live meta under
// `<projectDir>/<sid>/subagents/`, else the newest-timestamp matching meta
// under `<projectDir>/subagents-archive/<sid>/<ts>/`, else unavailable — the
// renderer shows « Journal indisponible » and nothing else. Reuses this
// file's own bounded-read machinery (initialRead / readSlice / splitLines /
// AGENT_DELTA_CAP) instead of a third transcript parser (CLAUDE.md rule 4).
// ---------------------------------------------------------------------------

// Measured (5933/5933 real tool_use_id values on this machine, max length
// 30, shape `toolu_` + base62 chars): this conservative charset/length cap
// matches every one seen and rejects anything with a path separator.
const JOURNAL_TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ARCHIVE_MAX_DIRS = 64; // safety cap on timestamp-dir scans (measured max 35 for one session)

function validJournalTarget(sid, toolUseId) {
  return UUID_RE.test(String(sid || '')) && JOURNAL_TOOL_USE_ID_RE.test(String(toolUseId || ''));
}

// One directory, one matching pass: parse every *.meta.json until toolUseId
// matches. Meta/jsonl files are small (never the multi-MB transcript itself).
async function journalMetaMatch(dir, toolUseId) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return null; } // dir absent: no match here
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (meta && meta.toolUseId === toolUseId) {
      return { meta, jsonl: path.join(dir, n.replace(/\.meta\.json$/, '.jsonl')) };
    }
  }
  return null;
}

// (sid, toolUseId) ONLY — no paneId anywhere in this feature (C4, finding 9):
// the overlay is single and has no per-pane consumer on the main side.
// Validates BOTH inputs before any fs call — no path ever crosses the
// bridge, whatever the caller passes (aj12 / C9: a traversal attempt like
// '../../etc' / '../passwd' never reaches fs.readdir/readFile at all).
async function resolveAgentFile(sid, toolUseId) {
  if (!validJournalTarget(sid, toolUseId)) return null;
  const main = findSessionFile(sid);
  if (!main) return null; // no session transcript at all -> nothing to resolve
  const live = await journalMetaMatch(agentDirOf(main), toolUseId);
  if (live) return { file: live.jsonl, source: 'live', meta: live.meta };
  const archiveRoot = path.join(path.dirname(main), 'subagents-archive', sid);
  let dirents;
  try { dirents = await fsp.readdir(archiveRoot, { withFileTypes: true }); } catch (_) { return null; }
  // Timestamp dirs are `YYYY-MM-DD-HHMMSS` (measured on disk) — lexical sort
  // IS chronological sort; reverse -> newest first (C3/D8).
  const tsDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    .sort().reverse().slice(0, ARCHIVE_MAX_DIRS);
  for (const tsDir of tsDirs) {
    const hit = await journalMetaMatch(path.join(archiveRoot, tsDir), toolUseId);
    if (hit) return { file: hit.jsonl, source: 'archive', meta: hit.meta };
  }
  return null; // C3: unavailable — no file anywhere
}

let journalSub = null; // the single overlay subscription (or null)
let journalIdSeq = 0;

function unsubscribeJournal() {
  if (!journalSub) return;
  journalSub.epoch++; // invalidate any in-flight read/poll tick still closured on it
  if (journalSub.pollTimer) clearInterval(journalSub.pollTimer);
  journalSub = null;
}

// POLL_MS drain of a LIVE journal file only (an archived/moved file is read
// once at subscribe time and never polled — C4). Mirrors drain()'s delta-cap
// skip-ahead (AGENT_DELTA_CAP/AGENT_DELTA_KEEP) so one huge agent write can't
// block the 2s tick; `sub.epoch` guards every await against a mid-flight
// unsubscribe/resubscribe, `sub.draining` coalesces overlapping ticks on a
// slow disk. A vanished/rotated file stops the poll SILENTLY and keeps the
// already-rendered feed (C4) — it never sends an empty/error event.
async function journalPollTick(sub) {
  if (sub.draining) return;
  sub.draining = true;
  const ep = sub.epoch;
  try {
    let st;
    try { st = await fsp.stat(sub.file); } catch (_) {
      if (sub.epoch === ep && sub.pollTimer) { clearInterval(sub.pollTimer); sub.pollTimer = null; }
      return;
    }
    if (sub.epoch !== ep) return; // superseded while stat-ing
    if (st.size <= sub.offset) return;
    if (st.size - sub.offset > AGENT_DELTA_CAP) {
      sub.offset = st.size - AGENT_DELTA_KEEP;
      sub.remainder = Buffer.alloc(0);
    }
    let chunk;
    try { chunk = await readSlice(sub.file, sub.offset, st.size); } catch (_) { return; }
    if (sub.epoch !== ep) return; // superseded while reading
    sub.offset = st.size;
    const { lines, rest } = splitLines(Buffer.concat([sub.remainder, chunk]));
    sub.remainder = rest;
    const events = [];
    for (const line of lines) events.push(...normalizeLine(line, null, { sidechain: true }));
    if (events.length) send('agent-journal-append', { journalId: sub.journalId, events });
  } finally {
    sub.draining = false;
  }
}

function registerTranscriptIpc() {
  // Subscribe = the initial bounded read IS the reply (single flow: the
  // renderer clears and rebuilds on every subscribe/reset, appends otherwise).
  ipcMain.handle('transcript-subscribe', async (_e, target = {}) => {
    const paneId = String(target.paneId || '');
    if (!paneId) return { ok: false, reason: 'no-pane' };
    unsubscribe(paneId); // idempotent replace
    const sub = {
      paneId,
      target: { paneId, sessionId: target.sessionId },
      file: null, offset: 0, remainder: Buffer.alloc(0),
      watcher: null, pollTimer: null,
      epoch: 0, draining: false, drainAgain: false,
      // v46.6: sub-agent live feed state
      openDispatches: new Map(), // toolUseId -> agentType (no result yet)
      bgDispatches: new Set(), // v65: toolUseIds dispatched run_in_background — their immediate ack result is NOT completion
      resolvedDispatches: new Map(), // v46.8: resolved without a live tail -> one-shot archive replay
      resolvedScanMisses: 0,     // v46.8: fruitless scans while resolved ids wait (5 strikes -> drop)
      agentTails: new Map(),     // toolUseId -> { file, offset, remainder }
      agentMetaSeen: new Set(),  // matched meta.json names (skip re-parse)
      agentScanBusy: false,
      lastPushedKey: undefined, // v45.2 dedup (displayId:status) for the tick net
      quietSeen: null, // v45.2 two-tick confirmation for quiet statuses
      lastCtxKey: null, // v47: last pushed 'displayId:used:model' (destination-keyed dedup, status parity)
      lastModel: null, // v66: last usable model seen on this subscription (survives usage-only batches)
      lastUsed: null, // v73: last pushed ctx value — replayed by a usage-less /model confirmation
      agentIdMap: new Map(), // v74: agentId -> toolUseId (from ACKs), replaced fresh on every anchor()
      agentSent: new Map(), // L4: toolUseId -> the agentState last sent (cleared by every anchor)
      agentSeq: 0, // L4: per-subscription counter of agentState events, restarted by every anchor
      ledgerOpen: false, // L4: the last pass saw a non-terminal ledger entry (keeps the tick computing)
      agentWatch: false, // the last pass saw any ledger entry (keeps the tick checking for a re-open)
      agentActivity: null, // the cached fold object of the last pass (the change test)
      agentStateBusy: false, // L4: coalesce overlapping tick computations
      bornAt: Date.now(), // D-RF: spawnPending() waits SPAWN_WAIT_MS from here for a pty-open still on its way
      spawnRetry: null, // D-RF: the short retry timer of a pass held while the pane's pty is not registered
    };
    subs.set(paneId, sub);
    sub.pollTimer = setInterval(() => tick(sub), POLL_MS);
    const sid = resolveSid(sub.target);
    // A pane opened after the collector write, or a reloaded renderer, would otherwise wait for the next write.
    pushEffort(sub);
    // v44: prime the renderer's status BEFORE any live push lands — a chat
    // opened on an already-busy session must queue from the first send, not
    // bypass the queue during the unknown-status window (review attack #5).
    // v45.2: fossil-guarded direct read — the cache can hold a busy status
    // from a crashed session; priming it would animate a dead session's strip.
    const status = sid ? freshStatus(sid) : null;
    const file = sid ? findSessionFile(sid) : null;
    if (!file) return { ok: true, pending: true, truncatedHead: false, events: [], status };
    const read = await anchor(sub, file, false);
    if (!read) return { ok: true, pending: true, truncatedHead: false, events: [], status };
    return { ok: true, truncatedHead: read.truncatedHead, events: forRenderer(read.events), status,
             context: ctxPayload(latestCtxTokens(read.events), latestModel(read.events)) };
  });

  ipcMain.on('transcript-unsubscribe', (_e, { paneId } = {}) => {
    unsubscribe(String(paneId || ''));
  });

  // v46.3: phantom-busy reconciliation — the renderer's TUI scan proved the
  // session sits at its prompt (no '(esc to interrupt)' spinner, no menu)
  // while the status file still says busy: an interrupt that left NO
  // transcript trace (stop before the first token — user repro 2026-06-06:
  // zero marker, zero Stop hook). Same guarded write as the marker path:
  // markInterruptedIdle only flips a busy entry, and any later hook write
  // (PreToolUse…) wins the file back — a false positive self-corrects.
  ipcMain.on('status-reconcile-idle', (_e, target = {}) => {
    const sid = resolveSid({
      paneId: String(target.paneId || ''),
      sessionId: typeof target.sessionId === 'string' ? target.sessionId : null,
    });
    if (sid) markInterruptedIdle(sid, null);
  });

  // The renderer read the pane's terminal twice: no permission menu, composer
  // box back. The `waiting` on file (banner, sidebar badge, room
  // gates) is over: markMenuGone restores the pre-menu status, and only over a
  // `waiting` record not newer than the renderer's first read.
  ipcMain.on('status-menu-gone', (_e, target = {}) => {
    const sid = resolveSid({
      paneId: String(target.paneId || ''),
      sessionId: typeof target.sessionId === 'string' ? target.sessionId : null,
    });
    if (sid) markMenuGone(sid, typeof target.seenAt === 'number' ? target.seenAt : NaN);
  });

  // S3: pane-independent agent-journal overlay (C3/C4) — single subscription,
  // replaces on every call. `agent` is the ledger entry from the SAME S2 scan
  // the sidebar already pays for (stamp-cached, off the sidebar path).
  ipcMain.handle('agent-journal-subscribe', async (_e, target = {}) => {
    const sid = typeof target.sessionId === 'string' ? target.sessionId : '';
    const toolUseId = typeof target.toolUseId === 'string' ? target.toolUseId : '';
    if (!validJournalTarget(sid, toolUseId)) return { ok: false }; // aj12/C9: no path crosses the bridge
    unsubscribeJournal(); // C4: single overlay, replace-on-subscribe
    const activity = await sessionActivity(sid);
    const entry = activity.agents.find((a) => a.toolUseId === toolUseId) || null;
    // L4: the header state is the lifecycle's (agentStatesOf), never the ledger's; an entry the map lacks keeps the ledger value.
    const lifecycle = entry ? agentStatesOf(sid, () => sessionLivenessSince(sid)).get(toolUseId) : null;
    const agent = entry && lifecycle ? { ...entry, state: lifecycle.state } : entry;
    const journalId = ++journalIdSeq;
    const found = await resolveAgentFile(sid, toolUseId); // live -> archive -> null (C3)
    if (!found) return { ok: true, journalId, source: null, agent, events: [], truncatedHead: false };
    let read;
    try { read = await initialRead(found.file, null, { sidechain: true }); } // D6/D7: bounded, sidechain opt-in
    catch (_) { return { ok: true, journalId, source: null, agent, events: [], truncatedHead: false }; } // vanished between resolve and read
    const sub = {
      journalId, file: found.file, source: found.source,
      offset: read.offset, remainder: read.remainder,
      epoch: 0, draining: false, pollTimer: null,
    };
    journalSub = sub;
    if (found.source === 'live') sub.pollTimer = setInterval(() => journalPollTick(sub), POLL_MS); // C4: archive is read once, never polled
    return { ok: true, journalId, source: found.source, agent, events: read.events, truncatedHead: read.truncatedHead };
  });

  ipcMain.on('agent-journal-unsubscribe', () => { unsubscribeJournal(); });
}

module.exports = {
  registerTranscriptIpc,
  _internals: { trackDispatches, normalizeLine, resolveAgentFile, validJournalTarget, freshStatus },
};
