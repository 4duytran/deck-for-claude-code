// test/agent-closed-session-probe.js — main half of A2 (D2), A9, A11, A7/A8/A10 (stub side), A12/H1, M1,
// plus its Electron half: A9/R3 (pane kill), A7/R4, A10/R5, A15/R15, A8/R6 through the REAL sidebar scan.
// Electron half (runs first): the real app (main.js, a /bin/bash shim as the CLI, HOME / status dir / projects dir /
// rooms dir all under one mkdtemp), the sidebar scan `sessions-list` -> ipc/sessions.js, the renderer DOM. `send` is a
// recording pass-through, so every push of the app is seen. The window is blanked at the end of that half.
// Headless half: the REAL session-activity.js over mkdtemp session fixtures, liveness injected as a counting stub
// FUNCTION (`() => false` only through a function, K5) or as a raw value (M1). Sessions carry fresh timestamps (no
// clock seam); the H1 row alone writes its last own record 4 h back. Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-closed-session-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-closed-session-probe-'));
const projDir = path.join(base, 'projects', 'proj-closed');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(path.join(base, 'status'), { recursive: true });
fs.mkdirSync(path.join(base, 'home'), { recursive: true });
process.env.HOME = path.join(base, 'home');
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
process.env.CLAUDE_DECK_STATUS_DIR = path.join(base, 'status');
process.env.CLAUDE_DECK_ROOMS_DIR = path.join(base, 'rooms');
process.env.CLAUDE_DECK_NO_OPEN = '1';
const SHIM = path.join(base, 'fake-claude.sh'); // the pane process: a bash shim, never the real claude
fs.writeFileSync(SHIM, '#!/bin/bash\nexec sleep 600\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHIM;
const pushes = [];
const winMod = require('../src/main/window');
const origSend = winMod.send;
winMod.send = (ch, p) => { pushes.push({ ch, p }); try { return origSend(ch, p); } catch (_) { return undefined; } };
const sa = require('../src/main/session-activity.js');
const ss = require('../src/main/session-status.js');
const { ptys } = require('../src/main/state.js');

const MIN = 60 * 1000;
const NOW0 = Date.now();
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wj = (f, ls) => fs.writeFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const aj = (f, ls) => fs.appendFileSync(f, ls.map((o) => JSON.stringify(o)).join('\n') + '\n');
const ACK = 'Async agent launched successfully in the background.';

let seq = 0;
function session(key, o = {}) {
  const start = o.start !== undefined ? o.start : NOW0 - 20 * MIN;
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
  const s = { sid, key, file: path.join(projDir, `${sid}.jsonl`), dir: path.join(projDir, sid, 'subagents'), ag: [] };
  const lines = [{ type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(start), message: { role: 'user', content: `start ${key}` } }];
  for (let i = 0; i < (o.agents || 1); i++) {
    const D = `toolu_${key}_${i}`; const A = `ag${seq}x${i}`;
    s.ag.push({ D, A });
    lines.push({ type: 'assistant', timestamp: iso(start + 1000 + i), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: `${key} ${i}`, run_in_background: true } }] } });
    lines.push({ type: 'user', timestamp: iso(start + 2000 + i), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } });
  }
  if (o.crossTurn) lines.push({ type: 'user', cwd: base, timestamp: iso(start + 10000), message: { role: 'user', content: `next ${key}` } });
  wj(s.file, lines);
  fs.mkdirSync(s.dir, { recursive: true });
  return s;
}
const ownFile = (s, i = 0) => path.join(s.dir, `agent-${s.ag[i].A}.jsonl`);
const asst = (t, x = {}, m = {}) => ({ type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }], ...x, ...m } });
const endTurn = (t) => asst(t, { stop_reason: 'end_turn' });
const stopTail = (t) => ({ type: 'attachment', isSidechain: true, timestamp: iso(t), attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } });
const live = (v) => { const f = () => { f.calls += 1; return f.value; }; f.calls = 0; f.value = v; return f; };
const act = (s) => sa.sessionActivity(s.sid);
const st = (s, liveness, i = 0) => sa.agentStatesOf(s.sid, liveness).get(s.ag[i].D);
const payload = (a, s, liveness, i = 0) => sa.activityFlags(a, liveness, s.sid).agents.find((x) => x.toolUseId === s.ag[i].D);
const ownFresh = (s, i = 0) => wj(ownFile(s, i), [asst(NOW0 - 5 * MIN), asst(NOW0 - 2 * MIN)]);

// ---- Electron half: fixtures, built BEFORE main.js boots (the initial scan lists them) ----------------------------
const fsp = require('fs/promises');
const origStat = fsp.stat;
const hold = { file: null, gate: null, release: null, waiting: 0 };
// Fault injection for A9: while armed, the stat of ONE agent transcript (the model check of the sub-agent, the last
// async step before its session-flags push) waits, so the pane can die while that check is in flight.
fsp.stat = function stat(p, ...rest) {
  if (hold.file && String(p) === hold.file) { hold.waiting += 1; return hold.gate.then(() => origStat.call(fsp, p, ...rest)); }
  return origStat.call(fsp, p, ...rest);
};
const arm = (file) => { hold.waiting = 0; hold.file = file; hold.gate = new Promise((r) => { hold.release = r; }); };
const disarm = () => { hold.file = null; if (hold.release) hold.release(); };
const statusFile = (sid) => path.join(base, 'status', `${sid}.json`);
const putStatus = (sid, o, ageMs = 0) => {
  fs.writeFileSync(statusFile(sid), JSON.stringify({ ts: iso(Date.now() - ageMs), ...o }) + '\n');
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(statusFile(sid), t, t); }
};
const statusOf = (sid) => { try { return JSON.parse(fs.readFileSync(statusFile(sid), 'utf8')); } catch (_) { return null; } };
const freshOwn = (s, i) => wj(ownFile(s, i), [asst(Date.now() - 90000), asst(Date.now() - 30000)]);
function paneSession(key) { // agent 0 dispatched in an earlier turn (cross-turn), agent 1 in the current turn
  const s = session(key, { crossTurn: true });
  const D = `toolu_${key}_cur`; const A = `ag${seq}cur`;
  s.ag.push({ D, A });
  aj(s.file, [
    { type: 'assistant', timestamp: iso(Date.now() - 3 * MIN), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: `${key} cur`, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(Date.now() - 3 * MIN + 1000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } },
  ]);
  freshOwn(s, 0); freshOwn(s, 1);
  return s;
}
const FIX = { p9a: paneSession('p9a'), p9b: paneSession('p9b'), e7: session('e7'), e10: session('e10'), e15: session('e15'), e8: session('e8') };
for (const k of ['e7', 'e10', 'e15', 'e8']) freshOwn(FIX[k], 0);
putStatus(FIX.e7.sid, { status: 'idle', event: 'Stop' }); // A7: out of the deck, turn ended
putStatus(FIX.e15.sid, { status: 'closed', event: 'SessionEnd' }); // A15: the CLI's own exit, no pane of the deck
putStatus(FIX.e8.sid, { status: 'working', event: 'UserPromptSubmit' }, 6 * MIN); // A8: a fossil, ts and mtime 6 min old
require('../main.js');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-closed-session-probe-ud-')));

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });

async function electronHalf() {
  const win = BrowserWindow.getAllWindows()[0];
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const getter = (sid) => () => ss.sessionLiveness(sid);
  const rows = (sid) => j(`(() => {
    const r = document.querySelector('.session-row[data-session-id="${sid}"]');
    if (!r) return { missing: true };
    const l = r.querySelector('.agents-list');
    return { rowCount: l ? l.querySelectorAll('.agent-row').length : 0, toggle: !!r.querySelector('.agents-toggle'), text: r.textContent };
  })()`);
  const rowFlags = async (sid) => { // the flags of the sidebar scan itself (ipc/sessions.js), polled until the cache answers
    for (let i = 0; i < 25; i++) {
      const f = await j(`(async () => {
        const g = await window.api.listSessions();
        const r = g.flatMap((x) => x.sessions).find((s) => s.sessionId === '${sid}');
        return r ? r.flags : 'MISSING';
      })()`);
      if (f !== null) return f;
      await sleep(200);
    }
    return null;
  };
  const journal = (s) => j(`(async () => {
    try {
      if (typeof window.openAgentJournal !== 'function') return 'NO-SEAM';
      await window.openAgentJournal({ sessionId: '${s.sid}', toolUseId: '${s.ag[0].D}' });
      await new Promise((r) => setTimeout(r, 400));
      const el = document.getElementById('agent-journal');
      return el ? el.textContent : 'NO-EL';
    } catch (e) { return 'ERR ' + e.message; }
  })()`);
  const agentsOf = (flags) => (flags && Array.isArray(flags.agents) ? flags.agents.map((a) => a.state) : null);
  await sleep(2500); // the window loads and the initial renderSessions() settles

  // A9 / R3: a pane bound to a session with a running agent; the pane dies (with and without a hook SessionEnd first).
  async function runPane(s, withEnd) {
    const sid = s.sid; const r = {};
    await j(`openPane({ resumeId: '${sid}', title: '${s.key}' })`);
    let entry = null;
    for (let i = 0; i < 80 && !entry; i++) { entry = [...ptys.values()].find((e) => e.sessionId === sid); if (!entry) await sleep(100); }
    r.pane = !!entry;
    if (!entry) return r;
    await sleep(4000); // the open-time scans and model checks settle (MODEL_CHECK_MS = 3000)
    aj(ownFile(s, 1), [asst(Date.now() - 1000, {}, { model: 'claude-probe-model' })]); // the model the held check will learn
    arm(ownFile(s, 1));
    await j('renderSessions({ auto: true })');
    for (let i = 0; i < 40; i++) {
      r.before = await rows(sid);
      if (r.before && r.before.rowCount >= 1 && hold.waiting >= 1) break;
      await sleep(150);
    }
    r.waiting = hold.waiting;
    if (withEnd) { putStatus(sid, { status: 'closed', event: 'SessionEnd' }); await sleep(500); }
    const idx = pushes.length;
    entry.proc.kill();
    for (let i = 0; i < 40; i++) { const f = statusOf(sid); if (f && f.event === 'PtyExit') { r.ptyExit = true; break; } await sleep(100); }
    await sleep(300);
    disarm(); // the held check now completes: its push reads the liveness of THIS moment (getter) or the captured one (boolean)
    const mine = () => pushes.slice(idx).filter((x) => x.ch === 'session-flags' && x.p.sessionId === sid);
    for (let i = 0; i < 50 && !mine().length; i++) await sleep(100);
    await sleep(600);
    r.post = mine().flatMap((x) => (x.p.agents || []).map((g) => g.state));
    r.postPushes = mine().length;
    const flags = await rowFlags(sid);
    r.flagStates = agentsOf(flags);
    const m = sa.agentStatesOf(sid, getter(sid));
    r.crossTurn = (m.get(s.ag[0].D) || {}).state; r.inTurn = (m.get(s.ag[1].D) || {}).state;
    await j('renderSessions({ auto: true })');
    await sleep(600);
    r.after = await rows(sid);
    return r;
  }
  const R9 = {};
  for (const [tag, s, withEnd] of [['a', FIX.p9a, false], ['b', FIX.p9b, true]]) {
    R9[tag] = await runPane(s, withEnd).catch((e) => ({ err: String((e && e.stack) || e) }));
  }
  for (const tag of ['a', 'b']) {
    const r = R9[tag];
    const inf = (o) => JSON.stringify({ ...o, err: r.err });
    await gate(`e9${tag}_live_baseline`, async () => chk(r.pane && r.before && r.before.rowCount >= 1 && r.waiting >= 1 && r.ptyExit === true,
      inf({ pane: r.pane, rowsBeforeKill: r.before && r.before.rowCount, heldChecks: r.waiting, ptyExit: r.ptyExit })));
    await gate(`e9${tag}_late_push_closed`, async () => chk(r.post && r.postPushes >= 1 && !r.post.some((x) => x === 'running' || x === 'waiting') && r.post.includes('closed'),
      inf({ postExitPushes: r.postPushes, states: r.post, expect: 'only closed' })));
    await gate(`e9${tag}_next_flags_closed`, async () => chk(r.flagStates && r.flagStates.length >= 1 && r.flagStates.every((x) => x === 'closed') && r.inTurn === 'closed' && r.crossTurn === 'closed',
      inf({ scanFlags: r.flagStates, inTurn: r.inTurn, crossTurn: r.crossTurn, expect: 'closed everywhere' })));
    await gate(`e9${tag}_sidebar_no_agent_row`, async () => chk(r.after && !r.after.missing && r.after.rowCount === 0 && r.after.toggle === false,
      inf({ rowCount: r.after && r.after.rowCount, toggle: r.after && r.after.toggle })));
  }

  // A7 / A10 / A15 / A8: sessions the deck has no pane for (no pty), read through the same sidebar scan.
  const plain = async (s, re) => {
    const flags = await rowFlags(s.sid);
    const x = sa.agentStatesOf(s.sid, getter(s.sid)).get(s.ag[0].D);
    await j('renderSessions({ auto: true })');
    await sleep(500);
    const r = await rows(s.sid); const jr = await journal(s);
    return { flags: flags !== null, states: agentsOf(flags), state: x && x.state, row: String((r && r.text) || '').slice(0, 120),
      journal: String(jr).slice(0, 120), hit: re.test(String((r && r.text) || '')) || CUT.test(String(jr)) };
  };
  // The sidebar row is checked for both words; the journal only for « interrompu »: a journal opened by id alone
  // (no row to click, so no state handed over) always heads its feed with its default label « En cours ».
  const BAD = /interrompu|en cours/i; const CUT = /interrompu/i;
  const o7 = await plain(FIX.e7, BAD);
  await gate('e7_out_of_deck_idle_not_closed', async () => chk(o7.flags && o7.state !== 'closed' && !(o7.states || []).includes('closed') && !o7.hit, JSON.stringify(o7)));
  const o10 = await plain(FIX.e10, CUT);
  await gate('e10_no_status_file_not_interrupted', async () => chk(o10.flags && o10.state !== 'closed' && !(o10.states || []).includes('closed') && !o10.hit, JSON.stringify(o10)));
  const o15 = await plain(FIX.e15, BAD);
  await gate('e15_out_of_deck_session_end_unknown', async () => chk(o15.flags && o15.state === 'unknown' && !(o15.states || []).includes('closed') && !o15.hit, JSON.stringify(o15)));
  const o8 = await plain(FIX.e8, CUT);
  await gate('e8_fossil_working_not_running', async () => chk(o8.flags && o8.state !== 'running' && !(o8.states || []).includes('running') && !o8.hit, JSON.stringify(o8)));

  try { await win.webContents.loadURL('about:blank'); } catch (_) { /* the renderer must not scan while the headless half writes fixtures */ }
  await sleep(300);
}

async function main() {
  await electronHalf();
  await gate('in_turn_false_closed', async () => {
    const s = session('c1', { agents: 2 }); ownFresh(s, 0); ownFresh(s, 1);
    const a = await act(s); const f = live(false);
    const s0 = st(s, f, 0); const s1 = st(s, f, 1);
    const p0 = payload(a, s, f, 0); const p1 = payload(a, s, f, 1);
    return chk(s0 && s0.state === 'closed' && s0.reason === 'session' && s1.state === 'closed' && p0 && p0.state === 'closed' && p1 && p1.state === 'closed',
      `agentStatesOf ${s0 && s0.state}/${s1 && s1.state}, in-turn payload keeps ${p0 && p0.state}/${p1 && p1.state} (expect closed)`);
  });
  await gate('stub_called_once_then_converges', async () => {
    const s = session('c1b', { agents: 2 }); ownFresh(s, 0); ownFresh(s, 1);
    const a = await act(s); const f = live(false);
    st(s, f, 0);
    const first = f.calls;
    payload(a, s, f, 0); st(s, f, 1);
    return chk(first === 1 && f.calls === 1, `calls after the first computation (2 entries)=${first}, after two more=${f.calls} (expect 1 then 1: the closedAt memo makes both terminal)`);
  });
  await gate('cross_turn_false_closed_and_dropped', async () => {
    const s = session('c2', { crossTurn: true }); ownFresh(s);
    const a = await act(s); const f = live(false);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'closed' && p === undefined, `state=${x && x.state}, in the payload=${p !== undefined} (expect closed, dropped)`);
  });
  await gate('silent_over_unknown_stub_never_called', async () => {
    const s = session('c3', { start: NOW0 - 5 * 60 * MIN });
    wj(ownFile(s), [asst(NOW0 - 4 * 60 * MIN - 60000), asst(NOW0 - 4 * 60 * MIN)]);
    const a = await act(s); const f = live(true);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'unknown' && x.reason === 'silence' && f.calls === 0 && p === undefined,
      `state=${x && x.state}/${x && x.reason}, stub calls=${f.calls}, in payload=${p !== undefined} (expect unknown/silence, 0 calls, dropped)`);
  });
  await gate('model_push_after_death_carries_no_running', async () => {
    const s = session('c4'); wj(ownFile(s), [asst(NOW0 - 5 * MIN, {}, { model: 'claude-probe-model' }), asst(NOW0 - 2 * MIN, {}, { model: 'claude-probe-model' })]);
    const a = await act(s); const f = live(true);
    const first = payload(a, s, f);
    f.value = false; // the death lands before the scheduled check fires
    for (let i = 0; i < 40 && !pushes.some((x) => x.ch === 'session-flags' && x.p.sessionId === s.sid); i++) await sleep(100);
    const mine = pushes.filter((x) => x.ch === 'session-flags' && x.p.sessionId === s.sid);
    const states = mine.flatMap((x) => x.p.agents.map((g) => g.state));
    return chk(first && first.state === 'running' && mine.length >= 1 && !states.includes('running') && states.includes('closed'),
      `first=${first && first.state}, ${mine.length} push(es) states=${states} (expect running first, then only closed)`);
  });
  await gate('deferred_sync_push_reads_liveness_at_push_time', async () => {
    const s = session('c4b'); ownFresh(s);
    const f = live(true);
    const r = sa.sessionFlagsSync(s.sid, f); // cache miss: queued, computed later
    f.value = false;
    for (let i = 0; i < 40 && !pushes.some((x) => x.ch === 'session-flags' && x.p.sessionId === s.sid); i++) await sleep(100);
    const mine = pushes.filter((x) => x.ch === 'session-flags' && x.p.sessionId === s.sid);
    const states = mine.flatMap((x) => x.p.agents.map((g) => g.state));
    return chk(r === null && mine.length >= 1 && !states.includes('running') && states.includes('closed'), `sync=${r}, pushed states=${states} (liveness not captured: expect closed)`);
  });
  await gate('stays_closed_until_own_record_newer_than_closedAt', async () => {
    const s = session('c5'); ownFresh(s);
    await act(s); const f = live(false);
    const x0 = st(s, f);
    f.value = true; // the session is live again (CLI resumed)
    const x1 = st(s, f); const callsBefore = f.calls;
    await sleep(30);
    aj(ownFile(s), [asst(Date.now())]);
    await act(s);
    const x2 = st(s, f);
    return chk(x0.state === 'closed' && x1.state === 'closed' && callsBefore === 1 && x2.state === 'running' && f.calls === 2,
      `closed=${x0.state}, live again=${x1.state} (calls ${callsBefore}), own record newer=${x2.state} (calls ${f.calls}) (expect closed, closed, running)`);
  });
  await gate('null_unknown_absent_from_payload', async () => {
    const s = session('c6'); ownFresh(s);
    const a = await act(s); const f = live(null);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'unknown' && x.reason === 'liveness' && p === undefined, `state=${x && x.state}/${x && x.reason}, in payload=${p !== undefined} (expect unknown/liveness, dropped)`);
  });
  await gate('null_terminal_own_tail_done', async () => {
    const s = session('c7'); wj(ownFile(s), [asst(NOW0 - 5 * MIN), endTurn(NOW0 - 4 * MIN), stopTail(NOW0 - 4 * MIN + 500)]);
    const a = await act(s); const f = live(null);
    const x = st(s, f); const p = payload(a, s, f);
    return chk(x && x.state === 'done' && x.reason === 'own-tail' && f.calls === 0 && p && p.state === 'done', `state=${x && x.state}/${x && x.reason}, calls=${f.calls}, payload=${p && p.state} (expect done/own-tail, 0 calls, kept in-turn)`);
  });
  await gate('m1_raw_true_is_live', async () => {
    const s = session('m1a'); ownFresh(s); const a = await act(s);
    const x = st(s, true); const p = payload(a, s, true);
    return chk(x && x.state === 'running' && p && p.state === 'running', `raw true -> ${x && x.state}/${p && p.state} (expect running)`);
  });
  await gate('m1_raw_false_is_unknown_not_closed', async () => {
    const s = session('m1b'); ownFresh(s); const a = await act(s);
    const x = st(s, false); const p = payload(a, s, false);
    return chk(x && x.state === 'unknown' && p === undefined, `raw false -> ${x && x.state}, in payload=${p !== undefined} (expect unknown, dropped)`);
  });
  await gate('m1_omitted_is_unknown', async () => {
    const s = session('m1c'); ownFresh(s); const a = await act(s);
    const x = st(s, undefined); const p = payload(a, s, undefined);
    return chk(x && x.state === 'unknown' && p === undefined, `omitted -> ${x && x.state} (expect unknown)`);
  });
  await gate('m1_function_false_is_closed', async () => {
    const s = session('m1d'); ownFresh(s); await act(s);
    const x = st(s, () => false);
    return chk(x && x.state === 'closed', `() => false -> ${x && x.state} (expect closed)`);
  });
  await gate('m1_function_garbage_is_unknown', async () => {
    const s = session('m1e'); ownFresh(s); await act(s);
    const x = st(s, () => 'yes'); const y = st(s, () => { throw new Error('boom'); });
    return chk(x && x.state === 'unknown' && y && y.state === 'unknown', `non-boolean result -> ${x && x.state}, throwing function -> ${y && y.state} (expect unknown)`);
  });

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  process.exit(n === results.length ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
