// test/agent-process-boundary-probe.js — D-PB: a run dies with its CLI process. Real app (main.js, a /bin/bash shim
// `exec sleep 600` as the CLI, HOME / status dir / projects dir / rooms dir all under one mkdtemp), the sidebar scan
// (`sessions-list` -> ipc/sessions.js), the feed (ipc/transcript.js agentStatesOf) and the renderer DOM.
//
//   pb  in-turn Agent dispatch, no result, its own transcript last written BEFORE the pane spawn, pane opened on the
//       session (resume): agentStatesOf `closed`, the scan flags carry no running/waiting, the sidebar shows no « en cours »;
//       the endTs stays the first sighting (closed memo, same as a PtyExit close)
//   pa  same fixture, an own record appended AFTER the spawn (the agent resumed in the new process): `running`, a sidebar row
//   pn  same fixture, NO pane (hook SessionEnd only): unchanged, `unknown` and hidden
//   t43 chat-view t43 (reopened orphan: card « interrompu »): the pinned « Tâches » roster has no « working » row
//
// Liveness is read through the production getter (ss.sessionLivenessSince when the build has it, else the tri-state one), so
// the probe holds on the code before the fix (RED) and after it. Never reads ~/.claude.
// Run: cd <worktree> && CENV xvfb-run -a timeout 180 node_modules/.bin/electron test/agent-process-boundary-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-process-boundary-probe-'));
const projDir = path.join(base, 'projects', 'proj-pb');
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
// One in-turn background Agent dispatch with its ACK (no result), the agent's own transcript last written 2 min ago.
function session(key) {
  seq += 1;
  const sid = `${seq.toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const D = `toolu_${key}`; const A = `agpb${seq}`;
  const s = { sid, key, D, A, file: path.join(projDir, `${sid}.jsonl`), dir: path.join(projDir, sid, 'subagents') };
  wj(s.file, [
    { type: 'summary', cwd: base, gitBranch: 'main' },
    { type: 'user', cwd: base, timestamp: iso(NOW0 - 20 * MIN), message: { role: 'user', content: `start ${key}` } },
    { type: 'assistant', timestamp: iso(NOW0 - 19 * MIN), message: { content: [{ type: 'tool_use', id: D, name: 'Task',
      input: { subagent_type: 'code-dev', description: `${key} agent`, run_in_background: true } }] } },
    { type: 'user', timestamp: iso(NOW0 - 19 * MIN + 1000), message: { content: [{ type: 'tool_result', tool_use_id: D, content: ACK }] },
      toolUseResult: { isAsync: true, agentId: A, status: 'async_launched' } },
  ]);
  fs.mkdirSync(s.dir, { recursive: true });
  wj(path.join(s.dir, `agent-${A}.jsonl`), [asst(NOW0 - 5 * MIN), asst(NOW0 - 2 * MIN)]);
  return s;
}
const ownFile = (s) => path.join(s.dir, `agent-${s.A}.jsonl`);
function asst(t) { return { type: 'assistant', isSidechain: true, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: 'work' }], model: 'claude-probe-model' } }; }
const statusFile = (sid) => path.join(base, 'status', `${sid}.json`);
const putStatus = (sid, o) => fs.writeFileSync(statusFile(sid), JSON.stringify({ ts: iso(Date.now()), ...o }) + '\n');

const FIX = { pb: session('pb'), pa: session('pa'), pn: session('pn') };
putStatus(FIX.pn.sid, { status: 'closed', event: 'SessionEnd' }); // the CLI's own exit, no pane of the deck: liveness null
// t43 (chat-view probe): the session was closed while an agent ran, its result never landed; at rest on reopen.
const T43 = { sid: 'eeeeeeee-aaaa-4bbb-8ccc-eeeeeeeeee43', D: 'toolu_ORPHAN' };
T43.file = path.join(projDir, `${T43.sid}.jsonl`);
wj(T43.file, [
  { type: 'user', cwd: base, timestamp: iso(NOW0 - 10 * MIN), message: { role: 'user', content: 'lance un scan' } },
  { type: 'assistant', timestamp: iso(NOW0 - 10 * MIN + 1000), message: { role: 'assistant', content: [{ type: 'tool_use', id: T43.D, name: 'Task',
    input: { subagent_type: 'py-explore', description: 'Scan long' } }], usage: { input_tokens: 3, output_tokens: 6 } } },
]);
putStatus(T43.sid, { status: 'idle', event: 'Stop' });

require('../main.js');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-process-boundary-probe-ud-')));

const results = [];
async function gate(id, fn) {
  let ok = false; let detail = '';
  try { const r = await fn(); ok = r.ok === true; detail = r.detail || ''; } catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' — ' + detail : ''}`);
  results.push(ok);
}
const chk = (ok, detail) => ({ ok: !!ok, detail });

async function main() {
  const win = BrowserWindow.getAllWindows()[0];
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); } catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  // The getter the app injects (ipc/sessions.js, ipc/transcript.js): the build's own when it has the pane-aware one.
  const getter = (sid) => () => (ss.sessionLivenessSince || ss.sessionLiveness)(sid);
  const stateOf = (s, id = s.D) => sa.agentStatesOf(s.sid, getter(s.sid)).get(id);
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
  const flagStates = (f) => (f && Array.isArray(f.agents) ? f.agents.map((a) => a.state) : null);
  const openPane = async (sid, title) => {
    await j(`openPane({ resumeId: '${sid}', title: '${title}' })`);
    let entry = null;
    for (let i = 0; i < 80 && !entry; i++) { entry = [...ptys.values()].find((e) => e.sessionId === sid); if (!entry) await sleep(100); }
    return entry;
  };
  const observe = async (s) => {
    const flags = await rowFlags(s.sid);
    await j('renderSessions({ auto: true })');
    await sleep(600);
    return { st: stateOf(s), flags: flagStates(flags), row: await rows(s.sid) };
  };
  await sleep(2500); // the window loads and the initial renderSessions() settles

  // pb: the pane is opened on the session AFTER its agent's last record: the run belonged to a process that is gone.
  const epb = await openPane(FIX.pb.sid, 'pb');
  await sleep(1500);
  const pb = epb ? await observe(FIX.pb) : null;
  await gate('pb_before_spawn_closed', async () => chk(pb && pb.st && pb.st.state === 'closed' && pb.st.reason === 'session'
    && pb.flags && pb.flags.length >= 1 && !pb.flags.some((x) => x === 'running' || x === 'waiting'),
  `pane=${!!epb}, agentStatesOf=${pb && pb.st && pb.st.state}/${pb && pb.st && pb.st.reason}, scan flags=${pb && pb.flags} (expect closed, nothing running/waiting)`));
  await gate('pb_sidebar_no_en_cours', async () => chk(pb && pb.row && !pb.row.missing && pb.row.rowCount === 0 && pb.row.toggle === false && !/en cours/i.test(pb.row.text),
    `rowCount=${pb && pb.row && pb.row.rowCount}, toggle=${pb && pb.row && pb.row.toggle}, en cours in row=${pb && pb.row && /en cours/i.test(pb.row.text)}`));
  await gate('pb_endTs_stays_first_sighting', async () => {
    const a = stateOf(FIX.pb); await sleep(150); const b = stateOf(FIX.pb);
    return chk(a && b && Number.isFinite(a.endTs) && a.endTs === b.endTs && a.endTs >= epb.spawnedAt,
      `endTs ${a && a.endTs} then ${b && b.endTs}, pane spawnedAt=${epb && epb.spawnedAt} (expect equal, finite, memoized at first sighting)`);
  });

  // pa: the same, then the agent writes again in the new process: it is alive.
  const epa = await openPane(FIX.pa.sid, 'pa');
  await sleep(1500);
  const paBefore = epa ? await observe(FIX.pa) : null;
  await gate('pa_closed_until_an_own_record_after_spawn', async () => chk(paBefore && paBefore.st && paBefore.st.state === 'closed',
    `before the append: ${paBefore && paBefore.st && paBefore.st.state} (expect closed)`));
  await sleep(50);
  aj(ownFile(FIX.pa), [asst(Date.now())]); // strictly after the pane spawn
  await sleep(100);
  const paAfter = await observe(FIX.pa);
  await gate('pa_own_record_after_spawn_running', async () => chk(paAfter.st && paAfter.st.state === 'running' && (paAfter.flags || []).includes('running') && paAfter.row && paAfter.row.rowCount >= 1,
    `agentStatesOf=${paAfter.st && paAfter.st.state}, scan flags=${paAfter.flags}, rowCount=${paAfter.row && paAfter.row.rowCount} (expect running, a row)`));

  // pn: no pane holds the session: no spawn time, the rule does not apply.
  const pn = await observe(FIX.pn);
  await gate('pn_no_pane_unknown_hidden', async () => chk(pn.st && pn.st.state === 'unknown' && !(pn.flags || []).some((x) => x === 'closed' || x === 'running')
    && pn.row && pn.row.rowCount === 0 && !/en cours|interrompu/i.test(pn.row.text),
  `agentStatesOf=${pn.st && pn.st.state}, scan flags=${pn.flags}, rowCount=${pn.row && pn.row.rowCount} (expect unknown, hidden)`));

  // t43: the chat view of a reopened orphan.
  const e43 = await openPane(T43.sid, 'reopen');
  await sleep(800);
  const pane43 = e43 ? e43.paneId : null;
  await j(`setChatView('${pane43}', true)`);
  await sleep(2500);
  const roster = await j(`(() => {
    const p = panes.get('${pane43}'); if (!p) return null;
    const el = p.el.querySelector('.chat-tasks'); const card = p.el.querySelector('.chat-tool');
    return { hidden: el ? el.hidden : null, live: !!(el && el.querySelector('.ctk-live')),
      rows: el ? [...el.querySelectorAll('.ctk-row')].map((r) => (r.querySelector('.ctk-state') || {}).textContent) : null,
      caret: el ? (el.querySelector('.ctk-caret') || {}).textContent : null,
      card: card ? { status: card.dataset.status, note: card.querySelector('.ct-result').textContent } : null };
  })()`);
  const s43 = stateOf({ sid: T43.sid }, T43.D);
  await gate('t43_main_state_closed', async () => chk(s43 && s43.state === 'closed', `agentStatesOf=${s43 && s43.state}/${s43 && s43.reason} (expect closed)`));
  await gate('t43_card_interrupted', async () => chk(roster && roster.card && roster.card.status === 'interrupted' && roster.card.note.includes('interrompu'), JSON.stringify(roster && roster.card)));
  await gate('t43_roster_no_en_cours_row', async () => chk(roster && !(roster.rows || []).some((x) => /working|en cours/i.test(x || '')) && roster.live === false,
    `roster hidden=${roster && roster.hidden}, rows=${JSON.stringify(roster && roster.rows)}, caret=${roster && roster.caret}, live caret=${roster && roster.live} (expect no working row)`));

  const n = results.filter(Boolean).length;
  console.log(n === results.length ? `VERDICT: ALL GREEN (${n}/${results.length})` : `VERDICT: FAIL (${results.length - n}/${results.length})`);
  process.exit(n === results.length ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { console.log('PROBE ERROR', e && e.stack || e); console.log('VERDICT: FAIL (probe error)'); process.exit(1); });
