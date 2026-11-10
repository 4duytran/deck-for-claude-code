// Probe for src/main/agent-lifecycle.js (lot-core, contract K2 + K3 v8): the own-transcript
// classifier/fold and the pure reducer agentState. No window, no app boot: pure module + fixtures.
// Reads ONLY test/fixtures/agent-lifecycle-seed/ (synthetic, see its README) and in-memory synthetic lines.
// Run (from the worktree root): node_modules/.bin/electron test/agent-lifecycle-core-probe.js
//   (plain `node test/agent-lifecycle-core-probe.js` gives the same verdict)
'use strict';

const fs = require('fs');
const path = require('path');

const MODULE = path.join(__dirname, '..', 'src', 'main', 'agent-lifecycle.js');
const SEED_OWN = path.join(__dirname, 'fixtures', 'agent-lifecycle-seed',
  '00000000-0000-4000-8000-00000000a001', 'subagents', 'agent-a0000000000000a01.jsonl');

let mod = null;
let loadError = null;
try { mod = require(MODULE); } catch (e) { loadError = e; }

const results = {};
const notes = [];
function gate(name, fn) {
  let ok = false;
  try { ok = !!mod && fn() === true; } catch (e) { notes.push(`${name}: threw ${e && e.message}`); }
  results[name] = ok;
}

// ---- timestamps / synthetic record builders ------------------------------------------------
const iso = (mm, ss = '00', ms = '000') => `2026-11-07T12:${mm}:${ss}.${ms}Z`;
const t = (mm, ss, ms) => Date.parse(iso(mm, ss, ms));
const AID = 'a1b2c3d4e5f60718';
const line = (o) => JSON.stringify(o);
const asst = (ts, stop, blocks, extra) => line({ type: 'assistant', agentId: AID, timestamp: ts, message: { role: 'assistant', stop_reason: stop, content: blocks }, ...extra });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input: input || {} });
const text = (s) => ({ type: 'text', text: s });
const endTurn = (ts) => asst(ts, 'end_turn', [text('done')]);
const toolUse = (ts, id, name, input) => asst(ts, 'tool_use', [use(id, name, input)]);
const result = (ts, id, content, o = {}) => line({
  type: 'user', agentId: AID, timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(o.isError ? { is_error: true } : {}) }] },
  ...(o.tur !== undefined ? { toolUseResult: o.tur } : {}),
});
const userText = (ts, s) => line({ type: 'user', agentId: AID, timestamp: ts, message: { role: 'user', content: s } });
const att = (ts, attachment) => line({ type: 'attachment', agentId: AID, timestamp: ts, attachment });
const stopAtt = (ts) => att(ts, { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 });
const otherAtt = (ts) => att(ts, { type: 'date', content: 'x' });
const notif = (tuid, status, summary) => [
  '<task-notification>', '<task-id>bx1</task-id>', tuid ? `<tool-use-id>${tuid}</tool-use-id>` : '',
  `<status>${status}</status>`, `<summary>${summary || 'Background command finished'}</summary>`, '</task-notification>',
].filter(Boolean).join('\n');
const queued = (ts, prompt) => att(ts, { type: 'queued_command', prompt });
const ackTur = { isAsync: true, status: 'async_launched', agentId: 'ab12' };
const ACK_TEXT = 'Async agent launched successfully. (internal metadata)\nagentId: ab12';

function fold(lines) {
  const f = mod.newOwnFold();
  for (const l of lines) mod.foldOwnRecord(f, mod.classifyOwnRecord(l));
  return f;
}
const view = (f) => ({ lastTs: f.lastTs, terminalTs: f.terminalTs, openChildren: f.openChildren });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- module shape ---------------------------------------------------------------------------
gate('module_loads', () => ['classifyOwnRecord', 'newOwnFold', 'foldOwnRecord', 'agentState']
  .every((k) => typeof mod[k] === 'function'));
gate('module_pure_requires', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return reqs.every((r) => r === './task-notification' || r === './transcript-normalize');
});
gate('fold_view_shape', () => {
  const f = mod.newOwnFold();
  return same(view(f), { lastTs: null, terminalTs: null, openChildren: 0 });
});

// ---- seed: the synthetic own file (22 records; fixture README) -------------------------------
const seedLines = fs.existsSync(SEED_OWN) ? fs.readFileSync(SEED_OWN, 'utf8').split('\n').filter(Boolean) : [];
const SEED_END = Date.parse('2026-11-07T17:57:28.829Z');
gate('seed_fixture_present', () => seedLines.length === 22);
gate('seed_tail_terminal', () => {
  const v = view(fold(seedLines));
  return v.terminalTs === SEED_END && v.lastTs === SEED_END && v.openChildren === 0;
});
gate('seed_terminal_only_on_stop_tail', () => {
  // replay: the file is terminal ONLY at a prefix that ends in a SubagentStop (the stop at index 13, which
  // the next wake-up notification clears, and the final one at index 21); an open background child is seen mid-file
  const f = mod.newOwnFold();
  const terminalAt = []; let stray = false; let maxOpen = 0;
  seedLines.forEach((l, i) => {
    const r = mod.classifyOwnRecord(l);
    mod.foldOwnRecord(f, r);
    if (f.terminalTs !== null) { terminalAt.push(i); if (r.kind !== 'stop' || f.terminalTs !== r.ts) stray = true; }
    maxOpen = Math.max(maxOpen, f.openChildren);
  });
  return !stray && same(terminalAt, [13, 21]) && f.terminalTs === SEED_END && maxOpen >= 1 && f.openChildren === 0;
});
gate('seed_ts_matches_json', () => seedLines.every((l) => {
  const p = JSON.parse(l);
  const want = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : null;
  return mod.classifyOwnRecord(l).ts === want;
}));
gate('seed_agent_state_done', () => {
  const own = view(fold(seedLines));
  const entry = { startTs: Date.parse('2026-11-07T17:35:55.063Z') };
  return [true, false, null].every((live) => {
    const s = mod.agentState(entry, own, { sessionLive: live, closedAt: null, silentOver: false, stoppedAt: null });
    return s.state === 'done' && s.reason === 'own-tail' && s.endTs === SEED_END;
  });
});

// ---- classifier kinds -----------------------------------------------------------------------
const kindOf = (l) => mod.classifyOwnRecord(l).kind;
gate('classify_stop', () => kindOf(stopAtt(iso('01'))) === 'stop');
gate('classify_endturn', () => kindOf(endTurn(iso('01'))) === 'endTurn');
gate('classify_bglaunch_flag', () => {
  const r = mod.classifyOwnRecord(toolUse(iso('01'), 'c1', 'Bash', { command: 'x', run_in_background: true }));
  return r.kind === 'bgLaunch' && same(r.opens, ['c1']);
});
gate('classify_bglaunch_not_for_plain_tool', () => kindOf(toolUse(iso('01'), 'c1', 'Bash', { command: 'x', run_in_background: false })) === 'other'
  && kindOf(toolUse(iso('01'), 'c1', 'Bash', { command: 'x', run_in_background: 'true' })) === 'other');
gate('classify_bglaunch_ack', () => {
  const r = mod.classifyOwnRecord(result(iso('01'), 'g1', [{ type: 'text', text: ACK_TEXT }], { tur: ackTur }));
  return r.kind === 'bgLaunch' && same(r.opens, ['g1']);
});
gate('classify_ack_needs_harness_fact', () => {
  // the ACK sentence quoted by a Read/Bash result or a finished foreground agent is NOT a launch
  const quoted = result(iso('01'), 'g1', ACK_TEXT, { tur: { file: { filePath: '/x' } } });
  const fg = result(iso('01'), 'g2', 'the server is running in the background', { tur: { status: 'completed', agentId: 'ab12' } });
  const bare = result(iso('01'), 'g3', ACK_TEXT);
  return [quoted, fg, bare].every((l) => kindOf(l) === 'other');
});
gate('classify_child_final', () => {
  const asText = mod.classifyOwnRecord(userText(iso('01'), `[SYSTEM NOTIFICATION]\n${notif('c1', 'completed')}`));
  const asQueued = mod.classifyOwnRecord(queued(iso('01'), notif('c2', 'failed')));
  return asText.kind === 'childFinal' && same(asText.closes, ['c1']) && asQueued.kind === 'childFinal' && same(asQueued.closes, ['c2']);
});
gate('classify_notification_edges', () => {
  const waiting = userText(iso('01'), notif('c1', 'completed', 'Agent "x" is waiting on its own background work'));
  const noId = queued(iso('01'), notif(null, 'completed'));
  const inToolResult = result(iso('01'), 'z1', notif('c1', 'completed'));
  return [waiting, noId, inToolResult].every((l) => kindOf(l) === 'other');
});
gate('classify_child_error', () => {
  const r = mod.classifyOwnRecord(result(iso('01'), 'c1', 'boom', { isError: true, tur: 'Error: boom' }));
  return r.kind === 'childError' && same(r.closes, ['c1']);
});
gate('classify_other_and_junk', () => {
  const lines = [userText(iso('01'), 'hello'), otherAtt(iso('01')), line({ type: 'api-request', timestamp: iso('01') }),
    '', '   ', '{not json', '{"type":"attachment","attachment":{"hookEvent":"SubagentStop"', 'null', '[]', '42'];
  return lines.every((l) => kindOf(l) === 'other')
    && mod.classifyOwnRecord('{not json').ts === null
    && [null, undefined, 7, {}].every((v) => mod.classifyOwnRecord(v).kind === 'other');
});
gate('classify_ts_edges', () => {
  const noTs = line({ type: 'user', message: { role: 'user', content: 'x' } });
  const badTs = line({ type: 'user', timestamp: 'not a date', message: { role: 'user', content: 'x' } });
  return mod.classifyOwnRecord(noTs).ts === null && mod.classifyOwnRecord(badTs).ts === null
    && mod.classifyOwnRecord(userText(iso('01'), 'x')).ts === t('01');
});
gate('classify_ignores_agent_id', () => {
  // the file is already keyed by agent id: a record with no agentId, or a foreign one, is classified by shape
  const noId = line({ type: 'attachment', timestamp: iso('01'), attachment: { hookEvent: 'SubagentStop' } });
  const foreign = line({ type: 'attachment', agentId: 'someone-else', timestamp: iso('01'), attachment: { hookEvent: 'SubagentStop' } });
  return kindOf(noId) === 'stop' && kindOf(foreign) === 'stop' && !('agentId' in mod.classifyOwnRecord(noId));
});

// ---- fold: terminalTs (K2) ------------------------------------------------------------------
gate('fold_tail_after_endturn', () => same(view(fold([toolUse(iso('01'), 'x', 'Read'), result(iso('02'), 'x', 'ok'), endTurn(iso('03')), stopAtt(iso('04'))])),
  { lastTs: t('04'), terminalTs: t('04'), openChildren: 0 }));
gate('fold_tail_after_handback_result', () => same(view(fold([toolUse(iso('01'), 'h1', 'SubagentHandback', { message: 'r' }),
  result(iso('02'), 'h1', '{"success":true}'), stopAtt(iso('03'))])), { lastTs: t('03'), terminalTs: t('03'), openChildren: 0 }));
gate('fold_stop_not_last', () => same(view(fold([endTurn(iso('01')), stopAtt(iso('02')), userText(iso('03'), '[notification] wake')])),
  { lastTs: t('03'), terminalTs: null, openChildren: 0 }));
gate('fold_stop_after_nonhandback_result', () => same(view(fold([toolUse(iso('01'), 'x', 'Bash'), result(iso('02'), 'x', 'out'), stopAtt(iso('03'))])),
  { lastTs: t('03'), terminalTs: null, openChildren: 0 }));
gate('fold_stop_after_wrong_handback_id', () => same(view(fold([toolUse(iso('01'), 'h1', 'SubagentHandback'), result(iso('02'), 'y9', 'ok'), stopAtt(iso('03'))])).terminalTs, null));
gate('fold_stop_without_predecessor', () => view(fold([stopAtt(iso('01'))])).terminalTs === null
  && view(fold([otherAtt(iso('00')), stopAtt(iso('01'))])).terminalTs === null);
gate('fold_attachments_skipped_for_predecessor', () => view(fold([endTurn(iso('01')), otherAtt(iso('02')), queued(iso('03'), 'no notification'), stopAtt(iso('04'))])).terminalTs === t('04'));
gate('fold_attachment_after_stop_clears', () => {
  const lines = [endTurn(iso('01')), stopAtt(iso('02')), otherAtt(iso('03'))];
  const cleared = view(fold(lines));
  const again = view(fold([...lines, stopAtt(iso('04'))]));
  return cleared.terminalTs === null && cleared.lastTs === t('03') && again.terminalTs === t('04') && again.lastTs === t('04');
});
gate('fold_api_records_count_for_lastts', () => {
  const v = view(fold([endTurn(iso('01')), stopAtt(iso('02')), line({ type: 'api-request-shape', timestamp: iso('05') })]));
  return v.lastTs === t('05') && v.terminalTs === null;
});
gate('fold_malformed_and_tsless_ignored', () => {
  const base = [endTurn(iso('01')), stopAtt(iso('02'))];
  const withJunk = [...base, '{not json', '', line({ type: 'api-request-blob', hash: 'h' })];
  return same(view(fold(withJunk)), { lastTs: t('02'), terminalTs: t('02'), openChildren: 0 })
    && same(view(fold(['{not json'])), { lastTs: null, terminalTs: null, openChildren: 0 });
});
gate('fold_missing_agent_id_by_shape', () => {
  const strip = (l) => { const o = JSON.parse(l); delete o.agentId; return JSON.stringify(o); };
  const v = view(fold([endTurn(iso('01')), stopAtt(iso('02'))].map(strip)));
  return v.terminalTs === t('02') && v.lastTs === t('02');
});
gate('fold_returns_fold_and_survives_null_rec', () => {
  const f = mod.newOwnFold();
  const r = mod.foldOwnRecord(f, mod.classifyOwnRecord(endTurn(iso('01'))));
  mod.foldOwnRecord(f, null); mod.foldOwnRecord(f, undefined); mod.foldOwnRecord(f, {});
  return r === f && f.lastTs === t('01');
});

// ---- fold: openChildren (K2) ----------------------------------------------------------------
const bgBash = (ts, id) => toolUse(ts, id, 'Bash', { command: 'sleep 9', run_in_background: true });
gate('children_open_then_tail', () => {
  const f = fold([bgBash(iso('01'), 'c1'), result(iso('02'), 'c1', 'started'), endTurn(iso('03')), stopAtt(iso('04'))]);
  return same(view(f), { lastTs: t('04'), terminalTs: t('04'), openChildren: 1 });
});
gate('children_closed_by_final', () => {
  const open = [bgBash(iso('01'), 'c1'), bgBash(iso('02'), 'c2')];
  const afterOne = view(fold([...open, queued(iso('03'), notif('c1', 'completed'))])).openChildren;
  const afterBoth = view(fold([...open, queued(iso('03'), notif('c1', 'completed')), userText(iso('04'), notif('c2', 'killed'))])).openChildren;
  const unknownId = view(fold([...open, queued(iso('03'), notif('zz', 'completed'))])).openChildren;
  return afterOne === 1 && afterBoth === 0 && unknownId === 2;
});
gate('children_waiting_or_idless_notice_closes_nothing', () => {
  const open = [bgBash(iso('01'), 'c1')];
  const waiting = view(fold([...open, userText(iso('02'), notif('c1', 'completed', 'Agent "x" is waiting on its own background work'))])).openChildren;
  const idless = view(fold([...open, queued(iso('02'), notif(null, 'completed'))])).openChildren;
  return waiting === 1 && idless === 1;
});
gate('children_closed_by_error', () => {
  const f = fold([bgBash(iso('01'), 'c1'), result(iso('02'), 'c1', 'spawn failed', { isError: true, tur: 'Error: spawn failed' })]);
  const stray = fold([toolUse(iso('01'), 'n1', 'Read'), result(iso('02'), 'n1', 'denied', { isError: true })]);
  return f.openChildren === 0 && stray.openChildren === 0;
});
gate('children_ack_promotion_and_dedupe', () => {
  const agent = toolUse(iso('01'), 'g1', 'Agent', { subagent_type: 'x', prompt: 'p' });
  const ack = result(iso('02'), 'g1', [{ type: 'text', text: ACK_TEXT }], { tur: ackTur });
  const promoted = fold([agent, ack]).openChildren;
  const both = fold([toolUse(iso('01'), 'g1', 'Agent', { run_in_background: true }), ack]).openChildren;
  const closed = fold([agent, ack, userText(iso('03'), notif('g1', 'completed'))]).openChildren;
  const fgText = fold([agent, result(iso('02'), 'g1', 'running in the background', { tur: { status: 'completed', agentId: 'ab12' } })]).openChildren;
  return promoted === 1 && both === 1 && closed === 0 && fgText === 0;
});
gate('children_reopen_after_close_id_reuse', () => {
  // a final that precedes its launch record cannot leave a phantom child: the id is closed once seen
  const f = fold([queued(iso('01'), notif('c1', 'completed')), bgBash(iso('02'), 'c1')]);
  return f.openChildren === 1; // launch after a (stale) final is a new launch: counts, never negative
});

// ---- reducer K3 -----------------------------------------------------------------------------
const OWN0 = { lastTs: null, terminalTs: null, openChildren: 0 };
const own = (lastTs, terminalTs = null, openChildren = 0) => ({ lastTs, terminalTs, openChildren });
const F = (o) => ({ sessionLive: true, closedAt: null, silentOver: false, stoppedAt: null, ...o });
const S = (entry, o, facts) => mod.agentState(entry, o, F(facts));
const is = (r, state, reason, endTs) => r.state === state && r.reason === reason && (endTs === undefined || r.endTs === endTs);
const E = (extra) => ({ startTs: t('00'), ...extra });
const fin = (status, ts, extra) => ({ final: { status, ts, ...extra } });

gate('k3_running_live', () => is(S(E(), own(t('00', '30')), {}), 'running', 'live', null)
  && is(S(E(), null, {}), 'running', 'live', null) && is(S(E(), undefined, {}), 'running', 'live', null));
gate('k3_final_any_liveness', () => [true, false, null].every((live) => is(S(E(fin('completed', t('01'))), own(t('00', '30')), { sessionLive: live }), 'done', 'final', t('01'))));
gate('k3_final_statuses', () => is(S(E(fin('failed', t('01'))), own(t('00', '30')), {}), 'blocked', 'final', t('01'))
  && is(S(E(fin('killed', t('01'))), OWN0, {}), 'blocked', 'final', t('01'))
  && is(S(E(fin('stopped', t('01'))), OWN0, {}), 'blocked', 'final', t('01'))
  && is(S(E(fin('completed', t('01'), { source: 'result' })), OWN0, {}), 'done', 'result', t('01'))
  && is(S(E(fin('failed', t('01'), { source: 'result' })), OWN0, {}), 'blocked', 'result', t('01')));
gate('k3_final_without_ts_is_terminal', () => {
  const r = S(E({ final: { status: 'completed' } }), own(t('00', '30')), {});
  return r.state === 'done' && r.reason === 'final' && r.endTs === t('00', '30');
});
gate('k3_final_reopened_only_by_later_own_record', () => is(S(E(fin('completed', t('01'))), own(t('02')), {}), 'running', 'live', null)
  && is(S(E(fin('completed', t('01'))), own(t('01')), {}), 'done', 'final', t('01')) // tie is terminal
  && is(S(E(fin('completed', t('01'))), own(t('01', '00', '001')), {}), 'running', 'live', null));
gate('k3_stale_copy_after_terminal', () => {
  // an older own copy (smaller lastTs) arriving after the final changes nothing; a copy whose tail
  // was folded before a later record (terminalTs older than lastTs) is not terminal
  const staleCopy = S(E(fin('completed', t('05'))), own(t('02')), {});
  const staleTail = S(E(), own(t('04', '00', '001'), t('04')), {});
  const staleTailThenDead = S(E(), own(t('04', '00', '001'), t('04')), { sessionLive: false });
  return is(staleCopy, 'done', 'final', t('05')) && is(staleTail, 'running', 'live', null) && is(staleTailThenDead, 'closed', 'session', null);
});
gate('k3_session_false_closes', () => is(S(E(), own(t('00', '30')), { sessionLive: false }), 'closed', 'session', null)
  && is(S(E(), OWN0, { sessionLive: false }), 'closed', 'session', null)
  && is(S(E({ waitingTs: t('01') }), own(t('00', '30')), { sessionLive: false }), 'closed', 'session', null));
gate('k3_terminal_beats_session_false', () => is(S(E(), own(t('03'), t('03')), { sessionLive: false }), 'done', 'own-tail', t('03'))
  && is(S(E(), own(t('03')), { sessionLive: false, stoppedAt: t('03') }), 'blocked', 'stop', t('03')));
gate('k3_own_tail_any_liveness', () => [true, false, null].every((live) => is(S(E(), own(t('03'), t('03')), { sessionLive: live }), 'done', 'own-tail', t('03'))));
gate('k3_null_liveness_unknown', () => is(S(E(), own(t('00', '30')), { sessionLive: null }), 'unknown', 'liveness', null)
  && is(S(E(), own(t('00', '30')), { sessionLive: undefined }), 'unknown', 'liveness', null)
  && is(S(E(), own(t('00', '30')), { sessionLive: null, silentOver: true }), 'unknown', 'silence', null)
  && is(S(E({ waitingTs: t('01') }), own(t('00', '30')), { sessionLive: null }), 'unknown', 'liveness', null)
  && is(S(E(), own(t('03'), t('03'), 2), { sessionLive: null }), 'unknown', 'liveness', null));
gate('k3_waiting', () => is(S(E(), own(t('03'), t('03'), 2), {}), 'waiting', 'waiting', null)
  && is(S(E({ waitingTs: t('03') }), own(t('02')), {}), 'waiting', 'waiting', null)
  && is(S(E({ waitingTs: t('03') }), own(t('03')), {}), 'waiting', 'waiting', null)
  && is(S(E({ waitingTs: t('03') }), own(t('04')), {}), 'running', 'live', null));
gate('k3_f3_closed_at', () => is(S(E(), own(t('02')), { closedAt: t('03') }), 'closed', 'session', t('03'))
  && is(S(E(), own(t('03', '30')), { closedAt: t('03') }), 'running', 'live', null)
  && is(S(E(), own(t('03')), { closedAt: t('03') }), 'closed', 'session', t('03'))
  && is(S(E(), own(t('02')), { closedAt: t('03'), sessionLive: null }), 'closed', 'session', t('03')));
gate('k3_stopped_at_m5', () => is(S(E(), own(t('02')), { stoppedAt: t('02') }), 'blocked', 'stop', t('02'))
  && is(S(E(), own(t('02', '00', '001')), { stoppedAt: t('02') }), 'running', 'live', null)
  && is(S(E(), OWN0, { stoppedAt: t('02') }), 'blocked', 'stop', t('02'))
  && is(S(E(), own(t('02')), { stoppedAt: t('02'), sessionLive: null }), 'blocked', 'stop', t('02')));
gate('k3_tie_rows_h1', () => [true, false, null].every((live) => is(S(E(), own(t('03'), t('03')), { sessionLive: live }), 'done', 'own-tail', t('03')))
  && is(S(E(), own(t('03', '00', '001'), t('03')), {}), 'running', 'live', null)
  && is(S(E(), own(t('02')), { stoppedAt: t('02') }), 'blocked', 'stop', t('02')));
gate('k3_mixed_v8_stop_after_final', () => is(S(E(fin('completed', t('01'))), own(t('02')), { stoppedAt: t('02') }), 'blocked', 'stop', t('02')));
gate('k3_mixed_v8_closed_not_done', () => {
  const entry = E(fin('completed', t('01')));
  const first = S(entry, own(t('01', '30')), { sessionLive: false }); // final older than R: ignored, session dead -> closed
  const second = S(entry, own(t('01', '30')), { sessionLive: true, closedAt: t('03') });
  const third = S(entry, own(t('01', '30')), { sessionLive: false, closedAt: t('03') });
  return is(first, 'closed', 'session', null) && is(second, 'closed', 'session', t('03')) && is(third, 'closed', 'session', t('03'));
});
gate('k3_mixed_v8_final_ties_older_stop', () => is(S(E(fin('completed', t('01'))), own(t('01')), { stoppedAt: t('00') }), 'done', 'final', t('01')));
gate('k3_mixed_v8_final_stopped_newer_than_closed', () => is(S(E(fin('stopped', t('04'))), own(t('02')), { closedAt: t('03') }), 'blocked', 'final', t('04')));
gate('k3_equal_timestamp_order', () => {
  const at = t('03');
  const e = E(fin('failed', at));
  return is(S(e, own(at, at), { stoppedAt: at, closedAt: at }), 'blocked', 'final', at) // final > own-tail
    && is(S(E(), own(at, at), { stoppedAt: at, closedAt: at }), 'done', 'own-tail', at) // own-tail > stoppedAt
    && is(S(E(), own(at), { stoppedAt: at, closedAt: at }), 'blocked', 'stop', at) // stoppedAt > closedAt
    && is(S(E(), own(at), { closedAt: at }), 'closed', 'session', at);
});
gate('k3_items_older_than_start_ignored', () => is(S({ startTs: t('05') }, OWN0, { closedAt: t('01'), stoppedAt: t('02') }), 'running', 'live', null)
  && is(S({ startTs: t('05'), ...fin('completed', t('04')) }, OWN0, {}), 'running', 'live', null));
gate('k3_reopen_via_open_children_not_terminal', () => is(S(E(), own(t('03'), t('03'), 1), {}), 'waiting', 'waiting', null)
  && is(S(E(), own(t('03'), t('03'), 0), {}), 'done', 'own-tail', t('03')));
gate('k3_iso_timestamps_accepted', () => is(S({ startTs: iso('00'), final: { status: 'completed', ts: iso('01') } }, { lastTs: iso('00', '30'), terminalTs: null, openChildren: 0 }, {}), 'done', 'final', t('01')));
gate('k3_degenerate_inputs', () => {
  const r = mod.agentState(null, null, null);
  const q = mod.agentState(undefined, { lastTs: 'x', terminalTs: {}, openChildren: 'many' }, { sessionLive: 'yes' });
  return is(r, 'unknown', 'liveness', null) && q.state === 'unknown';
});
gate('k3_pure_no_mutation_fresh_result', () => {
  const deep = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deep(v); }); return Object.freeze(o); };
  const entry = deep(E(fin('completed', t('01'))));
  const o = deep(own(t('00', '30')));
  const facts = deep(F({ closedAt: t('02') }));
  const a = mod.agentState(entry, o, facts); const b = mod.agentState(entry, o, facts);
  return a !== b && same(a, b) && !Object.isFrozen(a);
});
gate('k3_exhaustive_invariants', () => {
  const REASONS = new Set(['final', 'result', 'own-tail', 'session', 'silence', 'stop', 'waiting', 'live', 'liveness']);
  const STATES = new Set(['running', 'waiting', 'unknown', 'done', 'blocked', 'closed']);
  const V = [null, 1, 2, 3].map((x) => (x === null ? null : t('10', String(x * 10))));
  const finals = [null, ['completed', 2], ['failed', 2], ['completed', 3]];
  let bad = 0; let n = 0;
  for (const lastTs of V) for (const terminalTs of V) for (const openChildren of [0, 1])
    for (const fv of finals) for (const stoppedAt of [null, V[2]]) for (const closedAt of [null, V[2]])
      for (const waitingTs of [null, V[2]]) for (const sessionLive of [true, false, null]) for (const silentOver of [false, true]) {
        n += 1;
        const entry = { startTs: V[1], waitingTs, ...(fv ? { final: { status: fv[0], ts: V[fv[1]] } } : {}) };
        const r = mod.agentState(entry, { lastTs, terminalTs, openChildren }, { sessionLive, closedAt, silentOver, stoppedAt });
        const again = mod.agentState(entry, { lastTs, terminalTs, openChildren }, { sessionLive, closedAt, silentOver, stoppedAt });
        const terminalState = r.state === 'done' || r.state === 'blocked' || r.state === 'closed';
        const items = [fv ? V[fv[1]] : null, openChildren === 0 ? terminalTs : null, stoppedAt, closedAt].filter((x) => x !== null);
        const R = Math.max(lastTs === null ? -Infinity : lastTs, V[1]);
        const validTerminal = items.some((x) => x >= R);
        const ok = STATES.has(r.state) && REASONS.has(r.reason) && same(r, again)
          && !(sessionLive !== false && r.state === 'closed' && closedAt === null) // closed needs a death fact
          && !(sessionLive === null && (r.state === 'running' || r.state === 'waiting')) // rule 5
          && (terminalState ? Number.isFinite(r.endTs) || (r.state === 'closed' && r.endTs === null && !validTerminal) : r.endTs === null)
          && (validTerminal ? terminalState : (r.state === 'closed' ? sessionLive === false : !terminalState)) // rule 4 vs rule 3 vs the rest
          && !(r.state === 'closed' && r.reason !== 'session');
        if (!ok) { bad += 1; if (bad <= 3) notes.push(`invariant: ${JSON.stringify({ entry, lastTs, terminalTs, openChildren, sessionLive, closedAt, silentOver, stoppedAt, r })}`); }
      }
  return bad === 0 && n === 4 * 4 * 2 * 4 * 2 * 2 * 2 * 3 * 2;
});

// ---- verdict --------------------------------------------------------------------------------
const names = Object.keys(results);
const failed = names.filter((n) => !results[n]);
for (const n of names) console.log(`${results[n] ? 'PASS' : 'FAIL'}: ${n}`);
if (loadError) console.log(`LOAD: ${loadError.code || loadError.name}: ${String(loadError.message).split('\n')[0]}`);
for (const n of notes) console.log(`NOTE: ${n}`);
console.log(failed.length
  ? `VERDICT: FAIL (${names.length - failed.length}/${names.length})`
  : `VERDICT: ALL GREEN (${names.length}/${names.length})`);
process.exit(failed.length ? 1 : 0);
