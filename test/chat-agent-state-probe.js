// test/chat-agent-state-probe.js — E2E probe (real app, real feed) for lot-chat-roster (plan Step L5): the chat view
// follows the agent lifecycle pushed by the feed as `{kind:'agentState', toolUseId, state, seq, agentType, summary}`.
//
// What it pins (renderer/js/chat-view.js applyAgentState / applyAgentCard / refreshTasks):
//   waiting      row `ctk-waiting` + « en attente », card `ct-waiting` + title « En attente de ses tâches de fond », still running
//   stale seq    an event whose seq is not above the last one of its toolUseId changes nothing (chat.agentSeq, per id)
//   re-open      running after a terminal puts the row and the card back to running (the card settles again at the next terminal)
//   closed       row « interrompu », card `interrupted` with no bgFinal (not a verdict)
//   unknown      row hidden from the « Tâches » list, card pulse off, nothing settled; a later terminal state settles it
//   row-less     unknown / done / blocked / closed for an id with no row: no row, no renderer error; running/waiting CREATES the
//                row (D-U1); a resume call id never creates one, and a dispatch resumed live defers to the call's row
//   reload       a re-anchor (file rewritten in place) while running / waiting: rows back with their state, card not `ok`,
//                an out-of-window dispatch included; a second chat on the same transcript (fresh subscribe) gets the same rows
//
// Fixtures: mkdtemp trees under a faked HOME (never ~/.claude). Sessions SA (live sequence + reload), SC (fresh subscribe) and
// SB (resume link) hold fresh `working` status files except SB. Clock (M-3): real app, no seam; fixture records are written
// relative to Date.now(), appended ones use `new Date()`.
//
// Run (worktree root, NO CLAUDE_DECK_STATUS_DIR: the probe fakes HOME):
//   env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 CLAUDE_DECK_ZOOM=1.0 <CENV minus STATUS_DIR> \
//     xvfb-run -a -s "-screen 0 3840x2160x24 -nolisten tcp" timeout 180 node_modules/.bin/electron test/chat-agent-state-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-state-home-'));
process.env.HOME = FAKE_HOME;
process.env.XDG_CONFIG_HOME = path.join(FAKE_HOME, '.config');
process.env.XDG_CACHE_HOME = path.join(FAKE_HOME, '.cache');
process.env.XDG_DATA_HOME = path.join(FAKE_HOME, '.local', 'share');
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) fs.mkdirSync(process.env[k], { recursive: true });
const PROJ_ROOT = path.join(FAKE_HOME, '.claude', 'projects');
const PROJ_DIR = path.join(PROJ_ROOT, 'proj-test');
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
process.env.CLAUDE_DECK_STATUS_DIR = STATUS_DIR;
process.env.CLAUDE_DECK_PROJECTS_DIR = PROJ_ROOT;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_AI_URL = 'about:blank';
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN, '#!/bin/bash\n( while :; do echo .; sleep 1; done ) &\nexec cat > /dev/null\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;

const SA = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const SB = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';
const SC = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
const T0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ACK_TEXT = 'Async agent launched successfully in the background.';
const L = (o) => JSON.stringify(o) + '\n';
const dispatch = (id, type, desc, ms) => L({ type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: desc, run_in_background: true } }] } });
const ack = (id, agentId, ms) => L({ type: 'user', timestamp: iso(ms), toolUseResult: { isAsync: true, agentId },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ACK_TEXT }] } });
const asstText = (text, ms) => L({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userLine = (text, ms) => L({ type: 'user', timestamp: iso(ms), cwd: FAKE_HOME, message: { role: 'user', content: text } });
const sendMsg = (id, to, ms) => L({ type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'again' } }] } });
const sendRes = (id, resumedAgentId, ms) => {
  const body = resumedAgentId ? { success: true, message: `Resuming agent ${resumedAgentId}`, resumedAgentId } : { success: true, message: 'delivered' };
  return L({ type: 'user', timestamp: iso(ms), toolUseResult: body,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }] }] } });
};
const ownTask = (aid, ms) => L({ type: 'user', isSidechain: true, agentId: aid, timestamp: iso(ms), message: { role: 'user', content: 'task' } });
const ownTool = (aid, ms, pattern) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_own_${ms}`, name: 'Grep', input: { pattern } }] } });
const ownEndTurn = (aid, ms) => L({ type: 'assistant', isSidechain: true, agentId: aid, timestamp: iso(ms),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const ownStop = (aid, ms) => L({ type: 'attachment', isSidechain: true, agentId: aid, timestamp: iso(ms),
  attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', exitCode: 0 } });
const WAITING_NOTICE = '<task-notification><task-id>aWait</task-id><tool-use-id>toolu_wait</tool-use-id><status>completed</status>'
  + '<summary>Agent "Wait job" is waiting on its own background work</summary></task-notification>';
const waitingLine = (ms) => L({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'text', text: WAITING_NOTICE }] } });

const FILLERS = 650; // > MAX_EVENTS (600): toolu_old falls out of the bounded initial read
function mainRun(withWaiting, fillers = FILLERS) {
  let s = userLine('go', T0 - 300000) + dispatch('toolu_old', 'arch', 'Trace flow C', T0 - 299000);
  for (let i = 0; i < fillers; i++) s += asstText(`filler ${i}`, T0 - 298000 + i);
  s += dispatch('toolu_run', 'code-dev', 'Run job', T0 - 60000) + ack('toolu_run', 'aRun', T0 - 59000);
  s += dispatch('toolu_wait', 'notes', 'Wait job', T0 - 58000) + ack('toolu_wait', 'aWait', T0 - 57000);
  if (withWaiting) s += waitingLine(Date.now());
  return s;
}
const writeSub = (sid, aid, tid, type, desc, ms) => {
  const dir = path.join(PROJ_DIR, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${aid}.meta.json`), JSON.stringify({ agentType: type, description: desc, toolUseId: tid }));
  fs.writeFileSync(path.join(dir, `agent-${aid}.jsonl`), ownTask(aid, ms) + ownTool(aid, ms + 1000, 'first-marker'));
};
const subFile = (sid, aid) => path.join(PROJ_DIR, sid, 'subagents', `agent-${aid}.jsonl`);
const mainFile = (sid) => path.join(PROJ_DIR, `${sid}.jsonl`);
for (const sid of [SA, SC]) {
  fs.writeFileSync(mainFile(sid), mainRun(false));
  writeSub(sid, 'aRun', 'toolu_run', 'code-dev', 'Run job', T0 - 56000);
  writeSub(sid, 'aWait', 'toolu_wait', 'notes', 'Wait job', T0 - 56000);
}
// SB: a finished dispatch, a resume of it (linked: the result names the agent) and a message that resumed nothing
fs.writeFileSync(mainFile(SB), userLine('go', T0 - 120000) + dispatch('toolu_d', 'kt-explore', 'Resume job', T0 - 100000)
  + ack('toolu_d', 'aD', T0 - 99000) + asstText('ok', T0 - 98000)
  + sendMsg('toolu_r', 'aD', T0 - 50000) + sendRes('toolu_r', 'aD', T0 - 49000)
  + sendMsg('toolu_sm', 'peer', T0 - 40000) + sendRes('toolu_sm', null, T0 - 39000));
writeSub(SB, 'aD', 'toolu_d', 'kt-explore', 'Resume job', T0 - 98000);

const touchStatus = () => { for (const sid of [SA, SC]) fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`), JSON.stringify({ status: 'working', event: 'probe', ts: new Date().toISOString() }) + '\n'); };
touchStatus(); // SB: deliberately no status file

// D-PB (a run dies with its CLI process): the fixture agents above are meant to be ALIVE in the pane's CLI, so that CLI
// must have been spawned before their records (the oldest dispatch is 5 min old, which no real spawn right after boot
// can precede). Every pane spawned by this probe gets a spawn time 10 min before T0; production reads it unchanged.
const { ptys } = require(path.join(__dirname, '..', 'src', 'main', 'state.js'));
const ptysSet = ptys.set.bind(ptys);
ptys.set = (paneId, entry) => { if (entry && typeof entry === 'object') entry.spawnedAt = T0 - 600000; return ptysSet(paneId, entry); };

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-state-userdata-')));

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, ok: ok === true });
}

app.whenReady().then(async () => {
  await sleep(1500);
  setInterval(touchStatus, 1000);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = async (code) => {
    try { return await wc.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const safe = async (pred) => { try { return !!(await pred()); } catch (_) { return false; } };
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await safe(pred)) return true; await sleep(150); } return safe(pred); };
  await js(`window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));`);

  // A missing row reads as ABSENT (never a TypeError in a gate); presence is asked with `in`.
  const ABSENT = { t: undefined, sum: undefined, done: undefined, state: null, lc: false };
  const snap = (pid) => snapRaw(pid).then((r) => {
    const out = (r && r.rows) ? r : { rows: {}, shown: [], seq: {}, errs: [`snap: ${JSON.stringify(r)}`], cards: {} };
    out.rows = new Proxy(out.rows, { get: (t, k) => (k in t ? t[k] : ABSENT) });
    return out;
  });
  const snapRaw = (pid) => js(`(() => {
    const p = panes.get('${pid}');
    if (!p || !p.chat) return { rows: {}, shown: [], seq: {}, errs: ['no chat'], cards: {} };
    const c = p.chat;
    const rows = Object.fromEntries([...c.bgAgents].map(([id, a]) => [id, { t: a.agentType, sum: a.summary, done: a.done, state: a.state || null, lc: !!a.lc }]));
    const card = (id) => {
      const el = c.toolIndex.get(id); if (!el) return null;
      const ico = el.querySelector('.ct-ico');
      return { status: el.dataset.status, waiting: el.classList.contains('ct-waiting'), title: el.title || '', bgFinal: el.dataset.bgFinal || null, anim: ico ? getComputedStyle(ico).animationName : null };
    };
    const shown = c.tasksEl.hidden ? [] : [...c.tasksEl.querySelectorAll('.ctk-row')].map((r) => ({
      name: r.querySelector('.ctk-name').textContent, state: r.querySelector('.ctk-state').textContent,
      waiting: r.classList.contains('ctk-waiting'), done: r.classList.contains('ctk-done') }));
    return { rows, shown, seq: Object.fromEntries(c.agentSeq || []), errs: window.__errs.slice(),
      cards: { run: card('toolu_run'), wait: card('toolu_wait'), old: card('toolu_old'), r: card('toolu_r'), d: card('toolu_d'), sm: card('toolu_sm') } };
  })()`);
  const inject = async (paneId, events) => { wc.send('transcript-append', { paneId, events }); await sleep(200); };
  const st = (toolUseId, state, seq, extra) => ({ kind: 'agentState', toolUseId, state, seq, agentType: 'x-type', summary: 'x-sum', ...(extra || {}) });
  const NO_ROW = { name: '', state: null, waiting: false, done: false };
  const shownOf = (s, name) => { // [0] of an empty answer reads NO_ROW (a failing gate, never a TypeError); length stays honest
    const a = (s.shown || []).filter((r) => r.name === name);
    return new Proxy(a, { get: (t, k) => (k === '0' && !t.length ? NO_ROW : t[k]) });
  };

  const open = async (sid, title) => {
    const before = await js(`panes.size`);
    await js(`openPane({ resumeId: '${sid}', title: '${title}' })`);
    await sleep(800);
    const id = await js(`[...panes.keys()].pop()`);
    await js(`setChatView('${id}', true)`);
    await sleep(900);
    return { id, grew: (await js(`panes.size`)) === before + 1 };
  };

  // === a1 — fresh subscribe, SA: running rows incl. the out-of-window dispatch; the replayed cards read running, never ok ===
  const A = await open(SA, 'fixture-A');
  const aReady = await waitFor(async () => { const s = await snap(A.id); return ['toolu_old', 'toolu_run', 'toolu_wait'].every((i) => s.rows[i] && s.rows[i].state === 'running') && s.cards.run && s.cards.run.status === 'running'; }, 12000);
  let s = await snap(A.id);
  gate('a1_fresh_subscribe_running_rows_incl_out_of_window', aReady && s.cards.old === null && s.rows.toolu_old.t === 'arch' && s.rows.toolu_old.sum === 'Trace flow C'
    && s.rows.toolu_old.lc && !s.rows.toolu_old.done && s.cards.run.status === 'running' && s.cards.wait.status === 'running' && s.cards.run.anim === 'ct-pulse'
    && s.shown.length === 3 && s.shown.every((r) => r.state === 'working'), JSON.stringify({ rows: s.rows, shown: s.shown, cards: [s.cards.run, s.cards.wait] }));

  // === a2 — a second chat on the same kind of transcript (fresh subscribe): same rows ===
  const C = await open(SC, 'fixture-C');
  const cReady = await waitFor(async () => { const t = await snap(C.id); return ['toolu_old', 'toolu_run', 'toolu_wait'].every((i) => t.rows[i] && t.rows[i].state === 'running'); }, 12000);
  const sc = await snap(C.id);
  gate('a2_second_fresh_subscribe_gets_rows', C.grew && cReady && sc.cards.old === null && sc.rows.toolu_old.state === 'running' && sc.shown.length === 3 && sc.cards.run.status === 'running',
    JSON.stringify({ rows: sc.rows, shown: sc.shown }));

  // Idle backstop setup (checked last, a13): the chat reads idle, a lifecycle-owned row and a control row are both 61 min old
  await js(`(() => { const c = panes.get('${C.id}').chat;
    Object.defineProperty(c, 'lastStatus', { get: () => 'idle', set: () => {}, configurable: true });
    const old = Date.now() - 61 * 60 * 1000;
    c.bgAgents.get('toolu_old').since = old;
    c.bgAgents.set('toolu_ctl', { agentType: 'ctl', summary: '', done: false, since: old });
    c.tasksEl && 0; })()`);

  // === a3 — waiting notice (real feed): row and card wear the waiting look, nothing settles ===
  fs.appendFileSync(subFile(SA, 'aWait'), ownTask('aWait', Date.now()));
  await sleep(40);
  fs.appendFileSync(mainFile(SA), waitingLine(Date.now()));
  const gotWait = await waitFor(async () => { const t = await snap(A.id); return t.rows.toolu_wait && t.rows.toolu_wait.state === 'waiting'; }, 9000);
  s = await snap(A.id);
  const wrow = shownOf(s, 'notes')[0];
  gate('a3_waiting_look', gotWait && !!wrow && wrow.waiting && wrow.state === 'en attente' && !wrow.done && s.cards.wait.waiting
    && s.cards.wait.title === 'En attente de ses tâches de fond' && s.cards.wait.status === 'running' && s.cards.wait.bgFinal === null && s.rows.toolu_wait.done === false,
    JSON.stringify({ row: s.rows.toolu_wait, wrow, card: s.cards.wait }));

  // === a4 — a stale seq changes nothing; a higher one applies and clears the waiting look ===
  const lastSeq = s.seq.toolu_wait;
  await inject(A.id, [st('toolu_wait', 'running', Math.max(0, lastSeq - 1))]);
  const afterStale = await snap(A.id);
  await inject(A.id, [st('toolu_wait', 'running', lastSeq + 9000)]);
  const afterFresh = await snap(A.id);
  gate('a4_stale_seq_dropped_fresh_applies', typeof lastSeq === 'number' && afterStale.rows.toolu_wait.state === 'waiting' && afterStale.cards.wait.waiting
    && afterFresh.rows.toolu_wait.state === 'running' && !afterFresh.cards.wait.waiting && afterFresh.cards.wait.title === ''
    && shownOf(afterFresh, 'notes')[0].state === 'working' && afterFresh.seq.toolu_wait === lastSeq + 9000,
    JSON.stringify({ lastSeq, stale: afterStale.rows.toolu_wait, fresh: afterFresh.rows.toolu_wait }));

  // === a5 — done (real feed, own SubagentStop tail): row « terminé », card settles ok (re-opened by the lifecycle first) ===
  fs.appendFileSync(subFile(SA, 'aRun'), ownEndTurn('aRun', Date.now()) + ownStop('aRun', Date.now() + 1));
  const gotDone = await waitFor(async () => { const t = await snap(A.id); return t.rows.toolu_run && t.rows.toolu_run.state === 'done'; }, 9000);
  s = await snap(A.id);
  gate('a5_done_row_and_card', gotDone && s.rows.toolu_run.done === true && shownOf(s, 'code-dev')[0].state === 'terminé' && shownOf(s, 'code-dev')[0].done
    && s.cards.run.status === 'ok' && s.cards.run.anim === 'none', JSON.stringify({ row: s.rows.toolu_run, card: s.cards.run }));

  // === a6 — re-open: running after a terminal puts row and card back; the next terminal settles the card again ===
  const rs = s.seq.toolu_run;
  await inject(A.id, [st('toolu_run', 'running', rs + 9000)]);
  const reopened = await snap(A.id);
  await inject(A.id, [st('toolu_run', 'done', rs + 9001)]);
  const resettled = await snap(A.id);
  gate('a6_reopen_after_terminal', reopened.rows.toolu_run.done === false && reopened.rows.toolu_run.state === 'running' && shownOf(reopened, 'code-dev')[0].state === 'working'
    && reopened.cards.run.status === 'running' && reopened.cards.run.anim === 'ct-pulse'
    && resettled.rows.toolu_run.done === true && resettled.cards.run.status === 'ok',
    JSON.stringify({ reopened: [reopened.rows.toolu_run, reopened.cards.run], resettled: [resettled.rows.toolu_run, resettled.cards.run] }));

  // === a7 — closed: « interrompu », card interrupted, not a verdict (no bgFinal) ===
  await inject(A.id, [st('toolu_wait', 'closed', lastSeq + 9100)]);
  s = await snap(A.id);
  gate('a7_closed_interrupted_no_verdict', s.rows.toolu_wait.done === true && shownOf(s, 'notes')[0].state === 'interrompu' && s.cards.wait.status === 'interrupted'
    && s.cards.wait.bgFinal === null && s.cards.wait.anim === 'none', JSON.stringify({ row: s.rows.toolu_wait, card: s.cards.wait, shown: shownOf(s, 'notes') }));

  // === a8 — unknown after running: row hidden, pulse off, nothing settled; a later terminal settles the card ===
  await inject(A.id, [st('toolu_wait', 'running', lastSeq + 9200)]);
  const back = await snap(A.id);
  await inject(A.id, [st('toolu_wait', 'unknown', lastSeq + 9201)]);
  const unk = await snap(A.id);
  gate('a8_unknown_hides_row_and_stops_pulse', back.cards.wait.status === 'running' && back.rows.toolu_wait.done === false
    && unk.rows.toolu_wait.state === 'unknown' && shownOf(unk, 'notes').length === 0 && unk.shown.length === 2
    && !['running', 'pending', 'ok', 'error', 'interrupted'].includes(unk.cards.wait.status) && unk.cards.wait.anim === 'none' && unk.cards.wait.bgFinal === null,
    JSON.stringify({ back: back.cards.wait, unk: [unk.rows.toolu_wait, unk.cards.wait, unk.shown.length] }));
  await inject(A.id, [st('toolu_wait', 'done', lastSeq + 9202)]);
  s = await snap(A.id);
  gate('a9_terminal_after_unknown_settles_card', s.cards.wait.status === 'ok' && s.rows.toolu_wait.done === true && shownOf(s, 'notes')[0].state === 'terminé',
    JSON.stringify({ row: s.rows.toolu_wait, card: s.cards.wait }));

  // === a10 — row-less ids: unknown / done / blocked / closed make no row and no error; running / waiting create it (D-U1) ===
  const before = await snap(A.id);
  await inject(A.id, ['unknown', 'done', 'blocked', 'closed'].map((state, i) => st('toolu_ghost', state, 1 + i)));
  await inject(A.id, [{ kind: 'agentState', state: 'running', seq: 50 }, st('toolu_ghost2', 'bogus', 51), st('toolu_ghost2', 'running', 'x')]);
  const ghost = await snap(A.id);
  gate('a10_rowless_terminal_states_make_no_row_no_error', !('toolu_ghost' in ghost.rows) && !('toolu_ghost2' in ghost.rows) && Object.keys(ghost.rows).length === Object.keys(before.rows).length + 0
    && ghost.errs.length === 0, JSON.stringify({ rows: Object.keys(ghost.rows), errs: ghost.errs }));
  await inject(A.id, [st('toolu_new', 'running', 1, { agentType: 'arch', summary: 'Made from the event' })]);
  const made = await snap(A.id);
  await inject(A.id, [st('toolu_new', 'waiting', 2)]);
  const madeW = await snap(A.id);
  await inject(A.id, [st('toolu_new', 'done', 3)]);
  const madeD = await snap(A.id);
  gate('a10b_running_waiting_create_row', 'toolu_new' in made.rows && made.rows.toolu_new.t === 'arch' && made.rows.toolu_new.sum === 'Made from the event' && made.rows.toolu_new.lc
    && made.rows.toolu_new.state === 'running' && madeW.rows.toolu_new.state === 'waiting' && madeD.rows.toolu_new.done === true && made.errs.length === 0,
    JSON.stringify({ made: made.rows.toolu_new, w: madeW.rows.toolu_new.state, d: madeD.rows.toolu_new.done }));

  // === a11 — resume call id: never makes a row; the dispatch row is made once; a message that resumed nothing makes none ===
  const B = await open(SB, 'fixture-B');
  const bReady = await waitFor(async () => { const t = await snap(B.id); return t.cards.d && t.cards.r && t.cards.sm; }, 10000);
  await sleep(2500); // let the real feed settle its first states for this session
  const b0 = await snap(B.id);
  await inject(B.id, [st('toolu_sm', 'running', 7000)]);
  const bSm = await snap(B.id);
  await inject(B.id, [st('toolu_r', 'running', 7001)]);
  const bR = await snap(B.id);
  await inject(B.id, [st('toolu_d', 'running', 7002)]);
  const bD = await snap(B.id);
  await inject(B.id, [st('toolu_r', 'running', 7003)]);
  const bR2 = await snap(B.id);
  await inject(B.id, [st('toolu_d', 'done', 7004), st('toolu_r', 'done', 7005)]);
  const bDone = await snap(B.id);
  gate('a11_resume_call_id_never_makes_a_row', bReady && !('toolu_sm' in bSm.rows) && !('toolu_r' in bR.rows) && 'toolu_d' in bD.rows && bD.rows.toolu_d.state === 'running'
    && !('toolu_r' in bR2.rows) && Object.keys(bR2.rows).filter((k) => k !== 'toolu_d' && !b0.rows[k]).length === 0
    && bDone.rows.toolu_d.done === true && bDone.errs.length === 0,
    JSON.stringify({ b0: Object.keys(b0.rows), bSm: Object.keys(bSm.rows), bR: Object.keys(bR.rows), bD: bD.rows.toolu_d, bDone: bDone.rows.toolu_d }));

  // === a12 — reload: the transcript is rewritten in place while a dispatch waits and another runs outside the window ===
  touchStatus();
  fs.writeFileSync(mainFile(SA), mainRun(true, FILLERS - 1)); // shorter than what the feed has read: drain() re-anchors with a reset batch
  const reloaded = await waitFor(async () => { const t = await snap(A.id); return t.rows.toolu_wait && t.rows.toolu_wait.state === 'waiting' && t.rows.toolu_old && t.rows.toolu_old.state === 'running'; }, 15000);
  s = await snap(A.id);
  gate('a12_reload_while_running_and_waiting_rows_back', reloaded && s.cards.wait && s.cards.wait.status === 'running' && s.cards.wait.waiting && s.cards.wait.status !== 'ok'
    && s.cards.old === null && s.rows.toolu_old.lc && !('toolu_run' in s.rows) && !('toolu_new' in s.rows) && s.errs.length === 0
    && s.seq.toolu_old < 9000 && shownOf(s, 'notes')[0].state === 'en attente',
    JSON.stringify({ rows: s.rows, seq: s.seq, wait: s.cards.wait, shown: s.shown, errs: s.errs }));

  // === a13 — the 30 s idle backstop leaves a lifecycle-owned row alone (it reaps the control row, proving the tick ran) ===
  const ticked = await waitFor(async () => (await snap(C.id)).rows.toolu_ctl.done === true, 45000);
  s = await snap(C.id);
  gate('a13_idle_backstop_skips_lifecycle_rows', ticked && s.rows.toolu_old.done === false && s.rows.toolu_old.state === 'running' && s.rows.toolu_old.lc,
    JSON.stringify({ ticked, old: s.rows.toolu_old, ctl: s.rows.toolu_ctl }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'FAIL'} (${failed.length === 0 ? results.length : failed.length}/${results.length})`);
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((e) => {
  console.log(`FAIL probe_exception — ${e && e.stack}`);
  console.log('\nVERDICT: FAIL (probe exception)');
  app.exit(1);
  process.exit(1);
});
