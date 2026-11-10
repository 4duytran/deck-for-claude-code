// test/agent-three-consumer-probe.js — E2E probe (real app) for plan Step L8 / spec D5: ONE agent state for every consumer.
//
// One scripted timeline on a fixture session (mkdtemp projects dir, a bash shim as the CLI, a real pane, the chat view open on it):
//   dispatch + ACK -> waiting notice -> own records -> own SubagentStop tail -> own record after it (resume)
//   -> SendMessage resume -> delayed model push held across the pane kill (A11) -> pane kill -> the session is live again
//   -> an own record newer than the death.
// A second fixture session (own pane) adds the two A5 checkpoints while its agent runs: a fresh chat subscribe and a transcript
// reset (re-anchor, the main file rewritten shorter in place).
//
// At EVERY checkpoint the five readers are read together, polled until they stop moving (or 14 s), and must all say the expected state:
//   flags   the `session-flags` payload the sidebar gets for the agent (inline from the sessions-list scan, else the push that fills it);
//           `absent` = unknown or cross-turn closed (a state this timeline never expects)
//   states  `agentStatesOf` in the probe's main process, fed the liveness getter production injects
//   feed    the last `agentState` event the chat feed pushed to the pane for the dispatch id (and for the resume call id once it exists)
//   dom     the chat roster `.ctk-row` of the agent (working / en attente / terminé / interrompu; `none` = no row)
//   journal the `agent-journal-subscribe` reply's agent.state (the journal header)
// The detail of each gate prints the five values.
//
// Clock (D-PB): the pane is spawned first and EVERY record is written afterwards with a fresh real timestamp (monotonic `now()`),
// no seam, no faked spawn time. The only fixture records older than the spawn are the opening user line and a padding line.
// Live-again is the out-of-deck shape: a fresh `working` status file after the pane's PtyExit (what a resumed CLI's hook writes).
//
// Run (worktree root): env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 <CENV> xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-three-consumer-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-three-consumer-'));
const projDir = path.join(base, 'projects', 'proj-three');
const statusDir = path.join(base, 'status');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(statusDir, { recursive: true });
fs.mkdirSync(path.join(base, 'home'), { recursive: true });
process.env.HOME = path.join(base, 'home');
for (const [k, d] of [['XDG_CONFIG_HOME', '.config'], ['XDG_CACHE_HOME', '.cache'], ['XDG_DATA_HOME', '.local/share']]) {
  process.env[k] = path.join(base, 'home', d);
  fs.mkdirSync(process.env[k], { recursive: true });
}
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = statusDir;
process.env.CLAUDE_DECK_ROOMS_DIR = path.join(base, 'rooms');
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_AI_URL = 'about:blank';
const SHIM = path.join(base, 'fake-claude.sh'); // the pane process: a bash shim, never the real claude
fs.writeFileSync(SHIM, '#!/bin/bash\nexec sleep 600\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHIM;

// A11 fault injection (as in agent-closed-session-probe): while armed, the stat of ONE own transcript (the model check, the last
// async step before its session-flags push) waits, so the pane can die and the session come back while that check is in flight.
const fsp = require('fs/promises');
const origStat = fsp.stat;
const hold = { file: null, gate: null, release: null, waiting: 0 };
fsp.stat = function stat(p, ...rest) {
  if (hold.file && String(p) === hold.file) { hold.waiting += 1; return hold.gate.then(() => origStat.call(fsp, p, ...rest)); }
  return origStat.call(fsp, p, ...rest);
};
const arm = (file) => { hold.waiting = 0; hold.file = file; hold.gate = new Promise((r) => { hold.release = r; }); };
const disarm = () => { hold.file = null; if (hold.release) hold.release(); };

const sa = require(path.join(__dirname, '..', 'src', 'main', 'session-activity.js'));
const ss = require(path.join(__dirname, '..', 'src', 'main', 'session-status.js'));
const { ptys } = require(path.join(__dirname, '..', 'src', 'main', 'state.js'));
// The liveness getter production injects (ipc/sessions.js, ipc/transcript.js). A tree that predates sessionLivenessSince passes the bare tri-state.
const getter = (sid) => (typeof ss.sessionLivenessSince === 'function' ? () => ss.sessionLivenessSince(sid) : () => ss.sessionLiveness(sid));

const iso = (ms) => new Date(ms).toISOString();
let lastMs = 0;
const now = () => { lastMs = Math.max(Date.now(), lastMs + 1); return lastMs; }; // strictly increasing real wall clock
const L = (o) => JSON.stringify(o) + '\n';
const ACK_TEXT = 'Async agent launched successfully in the background.';
const userLine = (text, ms) => L({ type: 'user', timestamp: iso(ms), cwd: base, message: { role: 'user', content: text } });
const dispatch = (id, type, desc, ms) => L({ type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: desc, run_in_background: true } }] } });
const ack = (id, agentId, ms) => L({ type: 'user', timestamp: iso(ms), toolUseResult: { isAsync: true, agentId, status: 'async_launched' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ACK_TEXT }] } });
const sendMsg = (id, to, ms) => L({ type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'again' } }] } });
const sendRes = (id, resumedAgentId, ms) => {
  const body = { success: true, message: `Resuming agent ${resumedAgentId}`, resumedAgentId };
  return L({ type: 'user', timestamp: iso(ms), toolUseResult: body,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }] }] } });
};
const waitingLine = (aid, tid, ms) => L({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'text',
  text: `<task-notification><task-id>${aid}</task-id><tool-use-id>${tid}</tool-use-id><status>completed</status>`
    + '<summary>Agent "Three consumers" is waiting on its own background work</summary></task-notification>' }] } });
const ownTask = (aid, ms) => L({ type: 'user', isSidechain: true, agentId: aid, timestamp: iso(ms), message: { role: 'user', content: 'task' } });
const ownTool = (aid, ms, model) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', ...(model ? { model } : {}), content: [{ type: 'tool_use', id: `toolu_own_${ms}`, name: 'Grep', input: { pattern: 'x' } }] } });
const ownEndTurn = (aid, ms) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const ownStop = (aid, ms) => L({ type: 'attachment', isSidechain: true, agentId: aid, timestamp: iso(ms),
  attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 } });

// A fixture session: a main file that exists (and is listed) before the app boots, holding only an opening user line and a padding
// line; every agent record is appended later. `mainLines` mirrors the file so the re-anchor can rewrite it shorter.
function session(sid, type, D, R, AID) {
  const dir = path.join(projDir, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const padding = L({ type: 'assistant', timestamp: iso(Date.now() - 4000), message: { role: 'assistant', content: [{ type: 'text', text: 'pad '.repeat(1500) }] } });
  const mainLines = [L({ type: 'summary', cwd: base, gitBranch: 'main' }), userLine('go', Date.now() - 5000), padding];
  const ctx = { sid, type, D, R, AID, dir, padding, mainLines, file: path.join(projDir, `${sid}.jsonl`), own: path.join(dir, `agent-${AID}.jsonl`),
    paneId: null, proc: null, resumeSeen: false };
  fs.writeFileSync(ctx.file, mainLines.join(''));
  return ctx;
}
const S1 = session('6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d', 'code-dev', 'toolu_three_d', 'toolu_three_r', 'aThree');
const S3 = session('6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e', 'kt-explore', 'toolu_fresh_d', null, 'aFresh');
const appendMain = (c, s) => { c.mainLines.push(s); fs.appendFileSync(c.file, s); };
const appendOwn = (c, s) => fs.appendFileSync(c.own, s);
const startAgent = (c) => { // dispatch + ACK in the main file, then the agent's own transcript (meta first, as the CLI does)
  appendMain(c, dispatch(c.D, c.type, 'Three consumers', now()));
  appendMain(c, ack(c.D, c.AID, now()));
  fs.writeFileSync(path.join(c.dir, `agent-${c.AID}.meta.json`), JSON.stringify({ agentType: c.type, description: 'Three consumers', toolUseId: c.D }));
  appendOwn(c, ownTask(c.AID, now()) + ownTool(c.AID, now()));
};

require(path.join(__dirname, '..', 'main.js'));
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-three-consumer-ud-')));

const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, ok: ok === true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step); } return !!(await pred()); };
const statusOf = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(statusDir, `${sid}.json`), 'utf8')); } catch (_) { return null; } };

async function main() {
  const win = BrowserWindow.getAllWindows()[0];
  const sent = []; // every main -> renderer push, in order
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, payload) => { sent.push({ n: sent.length, ch, p: payload }); return realSend(ch, payload); };
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  await sleep(2000); // boot settles, the initial scan lists both fixture sessions
  await j(`window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));`);

  // ---- the five readers -------------------------------------------------------------------------------------------------
  const flagsOf = async (c) => {
    const idx = sent.length;
    const r = await j(`(async () => { const g = await window.api.listSessions();
      const s = g.flatMap((x) => x.sessions).find((x) => x.sessionId === '${c.sid}'); return s ? { flags: s.flags } : { missing: true }; })()`);
    let flags = r && r.flags ? r.flags : null;
    if (!flags) { // stamp miss: the queued computation pushes 'session-flags' and fills the cache
      const pushed = () => sent.slice(idx).filter((s) => s.ch === 'session-flags' && s.p.sessionId === c.sid).pop();
      await waitFor(() => pushed(), 3000);
      flags = pushed() ? pushed().p : null;
    }
    if (!flags) return 'pending';
    const a = (flags.agents || []).find((x) => x.toolUseId === c.D);
    return a ? a.state : 'absent';
  };
  const statesOf = async (c, id) => {
    await sa.sessionActivity(c.sid);
    const e = sa.agentStatesOf(c.sid, getter(c.sid)).get(id);
    return e ? e.state : 'absent';
  };
  const feedOf = (c, id, since) => {
    const l = sent.filter((s) => s.n >= since && s.ch === 'transcript-append' && s.p && s.p.paneId === c.paneId)
      .flatMap((s) => (s.p.events || []).filter((e) => e.kind === 'agentState' && e.toolUseId === id));
    return l.length ? l[l.length - 1].state : 'none';
  };
  const ROW = { working: 'running', 'en attente': 'waiting', 'terminé': 'done', interrompu: 'closed' };
  const domOf = async (c) => {
    const r = await j(`(() => {
      const p = panes.get('${c.paneId}'); if (!p || !p.chat) return { err: 'no chat' };
      const ch = p.chat;
      const rows = ch.tasksEl.hidden ? [] : [...ch.tasksEl.querySelectorAll('.ctk-row')]
        .filter((r) => r.querySelector('.ctk-name').textContent === '${c.type}').map((r) => r.querySelector('.ctk-state').textContent);
      const el = ch.toolIndex.get('${c.D}');
      return { rows, card: el ? el.dataset.status : null };
    })()`);
    if (!r || r.err || r.__jsError) return { dom: `err:${r && (r.err || r.__jsError)}`, card: null };
    const dom = r.rows.length === 0 ? 'none' : r.rows.length === 1 ? (ROW[r.rows[0]] || `?${r.rows[0]}`) : `dup:${r.rows.join('|')}`;
    return { dom, card: r.card };
  };
  const journalOf = async (c) => {
    const r = await j(`window.api.agentJournalSubscribe({ sessionId: '${c.sid}', toolUseId: '${c.D}' })
      .then((r) => { window.api.agentJournalUnsubscribe(); return { ok: r.ok, state: r.agent ? r.agent.state : null }; })`);
    return r && r.ok === true ? (r.state || 'absent') : `err:${JSON.stringify(r)}`;
  };
  const readAll = async (c, since) => {
    const d = await domOf(c);
    return { flags: await flagsOf(c), states: await statesOf(c, c.D), feed: feedOf(c, c.D, since), dom: d.dom, journal: await journalOf(c),
      card: d.card, ...(c.R && c.resumeSeen ? { feedR: feedOf(c, c.R, since), statesR: await statesOf(c, c.R) } : {}) };
  };
  const agree = (exp, v) => v.flags === (exp === 'unknown' ? 'absent' : exp) && v.states === exp && v.feed === exp && v.dom === exp && v.journal === exp
    && (v.feedR === undefined || ((v.feedR === 'none' || v.feedR === exp) && v.statesR === exp));
  async function checkpoint(id, c, exp, o = {}) {
    const end = Date.now() + 14000; let v; let ok = false; let polls = 0;
    for (;;) {
      v = await readAll(c, o.feedSince || 0); polls += 1;
      ok = agree(exp, v) && (!o.card || o.card(v.card));
      if (ok || Date.now() > end) break;
      await sleep(400);
    }
    gate(id, ok, JSON.stringify({ expect: exp, ...v, polls }));
    return { ok, v };
  }
  const notOk = (card) => card !== 'ok' && card !== null; // A5: a live agent's card is never the settled `ok`

  // ---- a pane on a fixture session, the chat view on it -----------------------------------------------------------------
  async function openPane(c, title, chat) {
    await j(`openPane({ resumeId: '${c.sid}', title: '${title}' })`);
    let found = null;
    await waitFor(() => { found = [...ptys.entries()].find(([, e]) => e && e.sessionId === c.sid) || null; return !!found; }, 12000, 100);
    if (!found) return false;
    c.paneId = found[0]; c.proc = found[1].proc; c.spawnedAt = found[1].spawnedAt;
    await sleep(500); // every record below is stamped after this instant
    if (chat) await openChat(c);
    return true;
  }
  async function openChat(c) {
    await j(`setChatView('${c.paneId}', true)`);
    return waitFor(async () => (await j(`!!(panes.get('${c.paneId}') && panes.get('${c.paneId}').chat)`)) === true, 6000);
  }

  // === setup — the pane is spawned before any agent record ===============================================================
  const up1 = await openPane(S1, 'three-consumers', true);
  const t0 = now();
  gate('setup_pane_spawned_before_records', up1 && (!Number.isFinite(S1.spawnedAt) || S1.spawnedAt < t0) && ss.sessionLiveness(S1.sid) === true,
    JSON.stringify({ up1, spawnedAt: S1.spawnedAt, firstRecordAt: t0, liveness: ss.sessionLiveness(S1.sid) }));
  if (!up1) throw new Error('no pane for the fixture session');

  // === c1 — dispatch + ACK ===============================================================================================
  startAgent(S1);
  await checkpoint('c1_dispatch_ack_running', S1, 'running', { card: notOk });

  // === c2 — waiting notice (the own fold has no terminal tail) ===========================================================
  appendMain(S1, waitingLine(S1.AID, S1.D, now()));
  await checkpoint('c2_waiting_notice_waiting', S1, 'waiting', { card: notOk });

  // === c3 — own records after the notice: running again ==================================================================
  appendOwn(S1, ownTool(S1.AID, now()));
  await checkpoint('c3_own_records_running', S1, 'running', { card: notOk });

  // === c4 — own SubagentStop tail: done ==================================================================================
  appendOwn(S1, ownEndTurn(S1.AID, now()) + ownStop(S1.AID, now()));
  await checkpoint('c4_own_tail_done', S1, 'done', { card: (card) => card === 'ok' });

  // === c5 — an own record after the tail: the agent runs again (resume seen from its own transcript) =====================
  appendOwn(S1, ownTool(S1.AID, now()));
  await checkpoint('c5_own_record_after_tail_running', S1, 'running', { card: notOk });

  // === c6 — SendMessage resume: the dispatch id and the resume call id both read running =================================
  appendMain(S1, sendMsg(S1.R, S1.AID, now()));
  appendMain(S1, sendRes(S1.R, S1.AID, now()));
  S1.resumeSeen = true;
  const c6 = await checkpoint('c6_sendmessage_resume_running', S1, 'running', { card: notOk });
  // The dispatch id already read running, so the checkpoint can settle before the next feed tick pushed the call id: wait for that push.
  await waitFor(() => feedOf(S1, S1.R, 0) === 'running', 8000, 200);
  gate('c6_resume_call_id_pushed_by_the_feed', feedOf(S1, S1.R, 0) === 'running' && c6.v.statesR === 'running', JSON.stringify({ feedR: feedOf(S1, S1.R, 0), statesR: c6.v.statesR }));

  // === A11 — the model check is held, the pane dies, the session comes back, the held push is released ===================
  await sleep(3300); // MODEL_CHECK_MS: the next flags computation may start a model check again
  appendOwn(S1, ownTool(S1.AID, now(), 'claude-probe-model')); // a model the held check will learn
  arm(S1.own);
  let held = false;
  for (let i = 0; i < 40 && !held; i++) { await flagsOf(S1); held = hold.waiting >= 1; if (!held) await sleep(200); }
  const idxKill = sent.length;
  S1.proc.kill(); // the pane's CLI dies; PtyExit is written by the deck
  const exited = await waitFor(() => { const f = statusOf(S1.sid); return !!f && f.event === 'PtyExit'; }, 6000, 100);
  gate('a11_setup_check_held_then_pane_dead', held && exited && ss.sessionLiveness(S1.sid) === false, JSON.stringify({ held, waiting: hold.waiting, ptyExit: exited, liveness: ss.sessionLiveness(S1.sid) }));

  // The held check completes AFTER the death (a stat of the held file blocks every reader, so none runs while it is armed):
  // its push is computed NOW, with the liveness of this moment (a getter), never the one captured when it was scheduled.
  const idxRelease = sent.length;
  disarm();
  const late = () => sent.slice(idxRelease).filter((s) => s.ch === 'session-flags' && s.p.sessionId === S1.sid);
  await waitFor(() => late().length >= 1, 6000, 100);
  await sleep(500);
  const lateStates = late().flatMap((s) => (s.p.agents || []).filter((a) => a.toolUseId === S1.D).map((a) => a.state));
  gate('a11_delayed_model_push_after_death_carries_only_closed', late().length >= 1 && lateStates.length >= 1
    && lateStates.every((s) => s === 'closed'), JSON.stringify({ pushes: late().length, states: lateStates, expect: 'only closed' }));

  // === c7 — the pane is dead: closed everywhere ==========================================================================
  await checkpoint('c7_pane_kill_closed', S1, 'closed', { feedSince: idxKill });

  // The session is live again (a resumed CLI's hook writes a fresh `working` status).
  fs.writeFileSync(path.join(statusDir, `${S1.sid}.json`), JSON.stringify({ status: 'working', event: 'UserPromptSubmit', ts: new Date().toISOString() }) + '\n');
  const live = await waitFor(() => ss.sessionLiveness(S1.sid) === true, 4000, 100);
  gate('a11_session_live_again', live, JSON.stringify({ liveness: ss.sessionLiveness(S1.sid) }));

  // === c8 — live again, no own record newer than the death: still closed; then the newer record: running ================
  await checkpoint('c8a_live_again_still_closed', S1, 'closed', { feedSince: idxKill });
  appendOwn(S1, ownTool(S1.AID, now()));
  await checkpoint('c8b_own_record_newer_than_death_running', S1, 'running', { card: notOk });

  // === c10 — a fresh chat subscribe while the agent runs (second session, its own pane) ==================================
  const up3 = await openPane(S3, 'fresh-subscribe', false);
  if (!up3) throw new Error('no pane for the second fixture session');
  startAgent(S3);
  await sleep(300);
  await openChat(S3);
  await checkpoint('c10_fresh_subscribe_running_card_not_ok', S3, 'running', { card: notOk });

  // === c11 — transcript reset (re-anchor): the main file is rewritten shorter in place ===================================
  const fromReset = sent.length;
  S3.mainLines = S3.mainLines.filter((l) => l !== S3.padding);
  fs.writeFileSync(S3.file, S3.mainLines.join(''));
  const gotReset = await waitFor(() => sent.some((s) => s.n >= fromReset && s.ch === 'transcript-append' && s.p.paneId === S3.paneId && s.p.reset === true), 8000, 100);
  const c11 = await checkpoint('c11_reanchor_running_card_not_ok', S3, 'running', { feedSince: fromReset, card: notOk });
  gate('c11_reset_batch_seen', gotReset && c11.ok, JSON.stringify({ gotReset }));

  const errs = await j('window.__errs.slice()');
  gate('no_renderer_errors', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));
}

app.whenReady().then(main).catch((e) => { console.log('PROBE ERROR', (e && e.stack) || e); gate('probe_error', false, String((e && e.message) || e)); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'FAIL'} (${failed.length === 0 ? results.length : failed.length}/${results.length})`);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
    app.exit(failed.length === 0 ? 0 : 1);
    process.exit(failed.length === 0 ? 0 : 1);
  });
