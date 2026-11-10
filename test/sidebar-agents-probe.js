// test/sidebar-agents-probe.js — E2E probe: sidebar "running agents" list
// per session. The sidebar classifies every sub-agent dispatch found in a
// session's MAIN transcript (never the subagents/ dir — M1) using the SAME
// wire signals transcript.js already parses for the per-pane chat feed
// (tool_use dispatch, tool_result ACK/completion, <task-notification>,
// TaskOutput <retrieval_status>), C2 precedence: is_error/failed/killed/
// stopped -> "bloqué" (rank 1, terminal), a real completion -> "terminé"
// (rank 2, terminal), an async ACK alone -> stays "en cours" (rank 3), the
// dispatch itself -> "en cours" (rank 4, birth). Main-process membership (C1,
// session-activity.js, untouched by this lot): the current turn's agents +
// every agent still "en cours" from an earlier turn; a finished/blocked
// agent from an OLDER turn drops off there already.
//
// THIS LOT (D1/D2, user report 2026-09-18, RENDERER ONLY):
//   D1 — the RENDERER now filters the main-process `agents` payload down to
//        `state === 'running'` before it ever builds a row, header count, or
//        toggle (`setSessionAgents`, renderer/js/sidebar.js). A done/blocked
//        agent from the CURRENT turn used to render unconditionally (the
//        exact bug reported) — main-process membership can still list it,
//        the renderer just never draws it. A session left with zero running
//        agents shows no toggle and no list at all (same end state sa16/
//        sa17 already assert for closed/stale sessions).
//   D2 — a rendered row carries ONLY the agent name (`.sa-type`, CSS-clamped
//        with ellipsis so a long name — real names reach 24 chars, e.g.
//        "proposal-review-attacker" — never pushes the row past the 280px
//        sidebar) and a short status word (`.sa-status`, from the SAME
//        state->word map as the old aria label: "en cours"/"terminé"/
//        "bloqué"). Description and the elapsed m:ss counter are gone from
//        the row; `.sa-blocked-word` is removed outright (D1's filter means
//        a.state is always 'running' by the time a row is built, so it had
//        no row left to ever apply to).
//
// Fixtures:
//   S_A — never opened in a pane, two turns. Turn 1: T_old (dispatch +
//         non-ack completion -> "terminé", but from an OLDER turn -> C1
//         drops it) and T_bgRun (background dispatch + ACK only, no
//         completion ever -> "running", but from an OLDER turn AND S_A is
//         never live (no pty, no status file) -> the liveness gate (lot P3)
//         drops it too). Turn 2: T_fg (non-ack completion -> "terminé"),
//         T_ack (ACK only, completed later by sa10/sa11 via an appended
//         <task-notification>), T_block (is_error result -> "bloqué"),
//         T_fail (ACK then a <task-notification> status=failed ->
//         "bloqué"), T_to (ACK then a TaskOutput <retrieval_status>
//         completed -> "terminé"). Main-process membership stays 5 (T_old
//         and T_bgRun excluded there already); THIS lot's D1 filter then
//         keeps only T_ack (the one 'running' entry) — the other 4
//         (2 terminé / 2 bloqué, all CURRENT-turn) are the exact class of
//         row the user reported and must be absent BY NAME, not just by
//         count.
//   S_B — one turn, no Task dispatch at all -> no agents row.
//   S_C — one turn, one dispatch + non-ack completion -> its single agent is
//         'done' -> D1's zero-state case: the session's own row-set is empty
//         even though it HAS agent history, so no toggle/list at all.
//   S_D — an 8-line bridge-session file, no dispatch anywhere -> no agents
//         row (C1: a bridge session with no dispatch is never listed). The
//         subagents/ journal dimension (C3) is S3's concern, not this probe's.
//   S_E/S_F/S_G — lot P3 liveness gate, each a T_bgRun-shaped cross-turn
//         dangling dispatch (never completes): S_E has no status file
//         (closed, never live) -> zero agent rows (sa16). S_F has a LIVE
//         status file but a backdated transcript mtime -> zero agent rows
//         too (sa17, "open but idle"). S_G has a LIVE status file and a
//         fresh mtime -> its running agent still shows (sa18, non-regression
//         floor). THIS lot gives S_G the 24-char agentType
//         "proposal-review-attacker" for sa22 (D2 CSS ellipsis clamp).
//         (No E2E gate for the empty-description guard: `entry.description`
//         — session-activity.js:111, `ev.summary || ''` — can never actually
//         be empty for a Task ledger entry; see the NOTE near sa12 below.)
//   S_H — same live+fresh shape as S_G, dedicated to sa12: its description
//         carries the XSS payload. D2 amendment (user decision, 2026-09-18):
//         hovering a row now reveals the full description via a native
//         `title` attribute (`btn.title = a.description`, an attribute
//         write, never an HTML sink) — the row's VISIBLE text still stays
//         name + status only. S_H proves the tooltip carries the raw
//         description verbatim while creating zero DOM elements.
//
// Run: cd claude-deck && CLAUDE_DECK_ZOOM=1.0 node_modules/.bin/electron test/sidebar-agents-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sidebar-agents-probe-'));
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });

const S_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const S_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const S_C = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const S_D = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const S_E = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e'; // closed, dangling running -> zero rows
const S_F = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f'; // live but stale transcript -> zero rows
const S_G = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a'; // live and fresh -> running agent still shows, 24-char name (sa22)
const S_H = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b'; // live and fresh -> running agent carries an XSS agentType (sa12, F1)
const fileA = path.join(projDir, `${S_A}.jsonl`);
const fileB = path.join(projDir, `${S_B}.jsonl`);
const fileC = path.join(projDir, `${S_C}.jsonl`);
const fileD = path.join(projDir, `${S_D}.jsonl`);
const fileE = path.join(projDir, `${S_E}.jsonl`);
const fileF = path.join(projDir, `${S_F}.jsonl`);
const fileG = path.join(projDir, `${S_G}.jsonl`);
const fileH = path.join(projDir, `${S_H}.jsonl`);

const ts = (i) => `2026-09-17T10:${String(i).padStart(2, '0')}:00.000Z`;
const ASYNC_ACK_TEXT = 'Async agent launched successfully in the background.';

function dispatchLine(id, agentType, desc, t, opts = {}) {
  const input = { subagent_type: agentType, description: desc };
  if (opts.bg) input.run_in_background = true;
  return { type: 'assistant', timestamp: t,
    message: { content: [{ type: 'tool_use', id, name: 'Task', input }] } };
}
function resultLine(id, text, t, opts = {}) {
  const block = { type: 'tool_result', tool_use_id: id, content: text };
  if (opts.isError) block.is_error = true;
  const line = { type: 'user', timestamp: t, message: { content: [block] } };
  if (opts.agentId) line.toolUseResult = { isAsync: true, agentId: opts.agentId };
  // FOREGROUND completion: the harness writes the agentId at the top level but NO `isAsync`.
  else if (opts.fgAgentId) {
    line.toolUseResult = { status: 'completed', agentId: opts.fgAgentId, agentType: 'planner', canContinueAgent: true };
  }
  return line;
}
// SendMessage that RESUMED a finished sub-agent: the harness result carries `resumedAgentId`.
function sendMessageLine(id, agentId, t) {
  return { type: 'assistant', timestamp: t,
    message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to: agentId, summary: 'fold', message: 'fold it' } }] } };
}
function resumeResultLine(id, agentId, t) {
  const message = `Resuming agent ${agentId.slice(0, 7)}`;
  return { type: 'user', timestamp: t,
    toolUseResult: { success: true, message, resumedAgentId: agentId },
    message: { content: [{ type: 'tool_result', tool_use_id: id,
      content: JSON.stringify({ success: true, message, resumedAgentId: agentId }) }] } };
}
function textNotifLine(text, t) {
  return { type: 'user', timestamp: t, message: { content: [{ type: 'text', text }] } };
}
function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

writeJsonl(fileA, [
  { type: 'summary', cwd: proj, gitBranch: 'main' },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'old' } },
  dispatchLine('toolu_old', 'kt-explore', 'Sweep stale locks', ts(1)),
  resultLine('toolu_old', 'Sweep complete: nothing stale.', ts(2)),
  dispatchLine('toolu_bgrun', 'notes', 'Log daily notes', ts(3), { bg: true }),
  resultLine('toolu_bgrun', ASYNC_ACK_TEXT, ts(4), { ack: true, agentId: 'agent_bgrun_1' }),
  { type: 'user', cwd: proj, timestamp: ts(5), message: { role: 'user', content: 'go' } },
  dispatchLine('toolu_fg', 'arch', 'Trace flow C', ts(6)),
  resultLine('toolu_fg', 'Trace complete: 3 call sites found.', ts(7)),
  dispatchLine('toolu_ack', 'search-docs', 'Check API docs', ts(8), { bg: true }),
  resultLine('toolu_ack', ASYNC_ACK_TEXT, ts(9), { agentId: 'agent_ack_1' }),
  dispatchLine('toolu_block', 'py-dev', 'Touch prod secrets', ts(10)),
  resultLine('toolu_block', 'PreToolUse:Agent hook error: DISPATCH GUIDE/QUALITY GATE', ts(11), { isError: true }),
  dispatchLine('toolu_fail', 'kt-spring-ddd', 'Implement lot 2', ts(12), { bg: true }),
  resultLine('toolu_fail', ASYNC_ACK_TEXT, ts(13), { agentId: 'agent_fail_1' }),
  textNotifLine('[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification><tool-use-id>toolu_fail</tool-use-id><status>failed</status></task-notification>', ts(14)),
  dispatchLine('toolu_to', 'vibe-check', 'Review plan quality', ts(15), { bg: true }),
  resultLine('toolu_to', ASYNC_ACK_TEXT, ts(16), { agentId: 'agent_to_1' }),
  resultLine('toolu_poll1', '<retrieval_status><task_id>agent_to_1</task_id><status>completed</status></retrieval_status>', ts(17)),
]);

writeJsonl(fileB, [
  { type: 'summary', cwd: proj, gitBranch: 'main' },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'hello' } },
  { type: 'assistant', timestamp: ts(1), message: { content: [{ type: 'text', text: 'Hi, how can I help?' }] } },
]);

writeJsonl(fileC, [
  { type: 'summary', cwd: proj, gitBranch: 'main' },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'run check' } },
  dispatchLine('toolu_c1', 'code-quality', 'Quick lint check', ts(1)),
  resultLine('toolu_c1', 'Check complete: nothing to report.', ts(2)),
]);

writeJsonl(fileD, Array.from({ length: 8 }, (_, i) =>
  ({ type: 'bridge-session', cwd: proj, idx: i, timestamp: ts(i) })));

// S_E/S_F/S_G: same cross-turn dangling-dispatch shape as S_A's T_bgRun — one
// background dispatch (ACK only, never completes), then a SECOND real user
// message so the dispatch falls out of the current turn (C1) into the
// liveness-gated fallback branch. Distinct first-user text per fixture (v11
// lineage dedup collapses rows sharing an identical first user message).
// agentType/description are parameterized so S_G (the only one whose row
// survives to be inspected) can carry a real-length name (sa22) and the XSS
// payload (sa12) without disturbing S_E/S_F's zero-row assertions.
function crossTurnDangleFixture(toolUseId, label, agentType, description) {
  return [
    { type: 'summary', cwd: proj, gitBranch: 'main' },
    { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: `start-${label}` } },
    dispatchLine(toolUseId, agentType, description, ts(1), { bg: true }),
    resultLine(toolUseId, ASYNC_ACK_TEXT, ts(2), { ack: true, agentId: `agent_${toolUseId}` }),
    { type: 'user', cwd: proj, timestamp: ts(3), message: { role: 'user', content: `continue-${label}` } },
  ];
}
// D2 amendment (user decision, 2026-09-18): hover now reveals the full
// description via a native `title` attribute (plain attribute write, not an
// HTML sink) — that restores description as a real rendered surface, so the
// XSS check moves BACK onto description (S_H), on a RUNNING fixture so the
// row actually exists to be checked. S_G stays dedicated to the 24-char
// agentType clamp (sa22) and doubles as the EMPTY-description case (its own
// description is '' — session-activity.js's `ev.summary || ''` can hand the
// renderer an empty string, and the row must show NO title attribute at all
// for it, never a dangling empty one).
const XSS_DESC = '<img src=x onerror="window.__sbXss=true">Quick lint check';
const LONG_AGENT_TYPE = 'proposal-review-attacker'; // 24 chars, a real agent name
writeJsonl(fileE, crossTurnDangleFixture('toolu_e_bg', 'e', 'notes', 'Log daily notes'));
writeJsonl(fileF, crossTurnDangleFixture('toolu_f_bg', 'f', 'notes', 'Log daily notes'));
writeJsonl(fileG, crossTurnDangleFixture('toolu_g_bg', 'g', LONG_AGENT_TYPE, 'Log daily notes'));
writeJsonl(fileH, crossTurnDangleFixture('toolu_h_bg', 'h', 'notes', XSS_DESC));

// S_I/S_K: a sub-agent RESUMED with SendMessage after it finished (user report
// 2026-10-27). Both are live+fresh like S_G so a running entry is drawn; the
// dispatch sits in an OLDER turn, so only `state === 'running'` keeps it listed.
//   S_I — FOREGROUND origin: the dispatch result carries `agentId` but no
//         `isAsync`. The resume must reopen the entry; a <task-notification>
//         naming the SendMessage tool-use id (appended live by sa24) closes it.
//   S_K — BACKGROUND origin (async ACK, then a completion notification, then
//         the resume): the control, it already reopened before the fix.
const S_I = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';
const S_K = 'adadadad-adad-4dad-8dad-adadadadadad';
const fileI = path.join(projDir, `${S_I}.jsonl`);
const fileK = path.join(projDir, `${S_K}.jsonl`);
writeJsonl(fileI, [
  { type: 'summary', cwd: proj, gitBranch: 'main' },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'start-i' } },
  dispatchLine('toolu_i_d', 'planner', 'Plan the retirement', ts(1)),
  resultLine('toolu_i_d', 'agentId: agent_i_fg1', ts(2), { fgAgentId: 'agent_i_fg1' }),
  { type: 'user', cwd: proj, timestamp: ts(3), message: { role: 'user', content: 'continue-i' } },
  sendMessageLine('toolu_i_s', 'agent_i_fg1', ts(4)),
  resumeResultLine('toolu_i_s', 'agent_i_fg1', ts(5)),
]);
writeJsonl(fileK, [
  { type: 'summary', cwd: proj, gitBranch: 'main' },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'start-k' } },
  dispatchLine('toolu_k_d', 'planner', 'Plan the retirement', ts(1), { bg: true }),
  resultLine('toolu_k_d', ASYNC_ACK_TEXT, ts(2), { agentId: 'agent_k_bg1' }),
  textNotifLine('<task-notification><tool-use-id>toolu_k_d</tool-use-id><status>completed</status></task-notification>', ts(3)),
  { type: 'user', cwd: proj, timestamp: ts(4), message: { role: 'user', content: 'continue-k' } },
  sendMessageLine('toolu_k_s', 'agent_k_bg1', ts(5)),
  resumeResultLine('toolu_k_s', 'agent_k_bg1', ts(6)),
]);

const statusDir = path.join(base, 'status');
fs.mkdirSync(statusDir, { recursive: true });
function writeStatus(sessionId, status) {
  fs.writeFileSync(path.join(statusDir, `${sessionId}.json`),
    JSON.stringify({ status, event: 'probe', ts: new Date().toISOString() }));
}
// S_F/S_G/S_H: LIVE status ('working' is in LIVE_STATUSES). S_E gets none -> closed.
writeStatus(S_F, 'working');
writeStatus(S_G, 'working');
writeStatus(S_H, 'working');
writeStatus(S_I, 'working');
writeStatus(S_K, 'working');
// L3b (D-M1): a session shows its running agents only while it is positively live. S_A used to have no status
// (an in-turn running row showed while NOT live, the old C3 rule); it is LIVE now, so its running rows show and its
// turn-1 cross-turn survivor (toolu_bgrun) shows with them.
writeStatus(S_A, 'working');
// S_F only: backdate the transcript's mtime past the staleness threshold
// (session-activity.js STALE_AGENT_MS, measured at 3h) so a LIVE session
// with an old transcript still reads as "open but idle". S_G/S_H keep a
// fresh mtime (untouched) so their running agent still shows.
const STALE_PAST = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5h ago > 3h threshold
fs.utimesSync(fileF, STALE_PAST, STALE_PAST);

process.env.CLAUDE_DECK_BIN = '/bin/bash'; // real shell, never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // real ~/.claude untouched
process.env.CLAUDE_DECK_STATUS_DIR = statusDir; // isolated hook-status dir (probe seam, room-router-probe.js pattern)
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sidebar-agents-userdata-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');

const results = [];
function gate(id, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${id}`;
  console.log(detail ? `${line} — ${detail}` : line);
  results.push({ id, ok });
}

// Underlying main-process state for S_A's turn-2 agents (oracle for the D1
// filter — what the RENDERER must now throw away). toolu_bgrun (turn-1,
// cross-turn 'running') is a live survivor now: S_A has a fresh `working`
// status (L3b), so it shows beside toolu_ack. The cross-turn "not live ->
// hidden" rule is pinned on S_E / S_F (sa16, sa17).
const EXPECTED_STATE = {
  toolu_ack: 'running', toolu_bgrun: 'running',
  toolu_fg: 'done', toolu_to: 'done',
  toolu_block: 'blocked', toolu_fail: 'blocked',
};
const EXPECTED_FIELDS = {
  toolu_bgrun: { type: 'notes', desc: 'Log daily notes' },
  toolu_fg: { type: 'arch', desc: 'Trace flow C' },
  toolu_ack: { type: 'search-docs', desc: 'Check API docs' },
  toolu_block: { type: 'py-dev', desc: 'Touch prod secrets' },
  toolu_fail: { type: 'kt-spring-ddd', desc: 'Implement lot 2' },
  toolu_to: { type: 'vibe-check', desc: 'Review plan quality' },
};
// D1: the ONLY ids that should ever survive the renderer's running-only
// filter for S_A: turn 2's toolu_ack, then the live turn-1 survivor toolu_bgrun (startTs DESC).
const EXPECTED_ORDER = ['toolu_ack', 'toolu_bgrun'];
// D1 regression proof: every CURRENT-turn done/blocked id, named explicitly
// — this is the exact bug class the user reported ("terminé et bloqué...
// on delete from sidebar").
const DONE_OR_BLOCKED_IDS = Object.keys(EXPECTED_STATE).filter((id) => EXPECTED_STATE[id] !== 'running');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const bad = (v) => v && typeof v === 'object' && '__jsError' in v;

  await sleep(1500); // initial renderSessions() on boot settles

  await j(`(() => {
    window.__sbAgentsSnap = (ids) => {
      const out = {};
      for (const id of ids) {
        const row = document.querySelector('.session-row[data-session-id="' + id + '"]');
        if (!row) { out[id] = null; continue; }
        const toggle = row.querySelector('.agents-toggle');
        const list = row.querySelector('.agents-list');
        const rows = list ? Array.from(list.querySelectorAll('.agent-row')) : [];
        out[id] = {
          hasBadge: !!row.querySelector('.status-badge'),
          hasRowMenu: !!row.querySelector('.row-menu'),
          hasToggle: !!toggle,
          toggleText: toggle ? toggle.textContent.replace(/\\s+/g, ' ').trim() : null,
          ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          listHidden: list ? !!list.hidden : null,
          rowCount: rows.length,
          rowIds: rows.map((r) => r.dataset.toolUseId),
          rowStates: rows.map((r) => r.dataset.state),
          rowTexts: rows.map((r) => r.textContent || ''),
          rowTitles: rows.map((r) => r.title), // D2 amendment: hover tooltip (title attr)
          rowHasTitle: rows.map((r) => r.hasAttribute('title')),
          imgCount: list ? list.querySelectorAll('img').length : 0,
        };
      }
      return out;
    };
    window.__sbEnsureExpanded = (id) => {
      const row = document.querySelector('.session-row[data-session-id="' + id + '"]');
      const toggle = row && row.querySelector('.agents-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      return !!toggle;
    };
    return true;
  })()`);

  // --- sa9: nothing has been clicked yet — no pane must have opened --------
  const panes0 = await j('panes.size');
  gate('sa9_no_pane_on_render', panes0 === 0, `panes.size=${JSON.stringify(panes0)}`);

  // --- sa1/sa2/sa3/sa4/sa19: initial (no-click) snapshot ---------------------
  let snap = await j(`window.__sbAgentsSnap(['${S_A}', '${S_B}', '${S_C}', '${S_D}'])`);
  const g = (id) => (bad(snap) ? null : snap[id]) || {};

  // F3 (Tier 2 review, 2026-09-18): every D1 gate below pins BOTH the RAW
  // main-process payload (via listSessions(), same source as sa11) and the
  // DOM in the SAME assertion — so a gate can only pass if the payload still
  // carries the done/blocked entries (main process untouched, per scope)
  // WHILE the DOM shows fewer/none of them (the renderer's own filter did
  // the work). A gate checking DOM alone can't tell "renderer filtered it"
  // from "fixture never had it" / "main process already filtered it".
  const rawFlagsOf = async (sid) => j(`(async () => {
    const groups = await window.api.listSessions();
    const row = groups.flatMap((g2) => g2.sessions).find((s) => s.sessionId === '${sid}');
    return row ? row.flags : null;
  })()`);
  const rawA0 = await rawFlagsOf(S_A);
  const rawC0 = await rawFlagsOf(S_C);
  const rawA0Ids = (rawA0 && Array.isArray(rawA0.agents)) ? rawA0.agents.map((e) => e.toolUseId) : [];
  const cDoneEntry = (rawC0 && Array.isArray(rawC0.agents)) ? rawC0.agents.find((e) => e.toolUseId === 'toolu_c1') : null;

  // D1: S_A's two running agents (toolu_ack, and the live survivor toolu_bgrun)
  // -> "2 agents · 2 en cours" — even though the raw payload still carries all 6
  // (2 terminé / 2 bloqué among them), proven by name.
  gate('sa1_row_text',
    g(S_A).toggleText === '2 agents · 2 en cours'
      && rawA0Ids.length === 6 && rawA0Ids.includes('toolu_fg') && rawA0Ids.includes('toolu_block') && rawA0Ids.includes('toolu_bgrun'),
    JSON.stringify({ toggleText: g(S_A).toggleText, rawA0Ids }));

  // B20: the row keeps its badge and its menu, but the menu is reached by a right-click now — no « ⋮ » button.
  const ctxA = await j(`(() => {
    const row = document.querySelector('.session-row[data-session-id=' + JSON.stringify(${JSON.stringify(S_A)}) + ']');
    if (!row) return null;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    const menu = document.getElementById('ctx-menu');
    const items = menu ? [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim()) : [];
    if (menu) menu.remove();
    return { open: !!menu, items };
  })()`);
  gate('sa2_badge_menu_preserved',
    g(S_A).hasBadge === true && g(S_A).hasRowMenu === false && !!ctxA && ctxA.open
      && JSON.stringify(ctxA.items) === JSON.stringify(["Copier l'ID de session", 'Renommer', 'Supprimer']),
    JSON.stringify({ badge: g(S_A).hasBadge, rowMenuButton: g(S_A).hasRowMenu, ctxA }));

  gate('sa3_no_agents_row',
    g(S_B).hasToggle === false && g(S_D).hasToggle === false,
    JSON.stringify({ b: g(S_B).hasToggle, d: g(S_D).hasToggle }));

  // D1 zero-state: S_C's one agent is 'done' -> no toggle, no list at all,
  // even though the RAW payload still carries it (state 'done') — this is
  // what tells apart "renderer filtered a real done agent" from "S_C simply
  // has no agents" (the latter is sa3's case, S_B/S_D).
  gate('sa19_all_done_zero_agents',
    g(S_C).hasToggle === false && !!cDoneEntry && cDoneEntry.state === 'done',
    JSON.stringify({ domHasToggle: g(S_C).hasToggle, cDoneEntry }));

  gate('sa4_folded_default',
    g(S_A).ariaExpanded === 'false' && g(S_A).listHidden === true,
    JSON.stringify({ a: [g(S_A).ariaExpanded, g(S_A).listHidden] }));

  // --- sa4b: RENDERED collapse state — sa4/sa5/sa14 only ever assert the
  // `hidden` IDL property / attribute, never what the browser actually PAINTS.
  // An author `display` rule with no `[hidden]` qualifier can beat the UA
  // `[hidden] { display: none }` at equal specificity (author normal > UA
  // normal) and leave the list visually rendered while `hidden` stays true —
  // exactly the bug reported: 21 green attribute-only gates coexisted with a
  // dead-looking control. Measure the COMPUTED style + box height in BOTH
  // directions in the SAME gate, so neither an always-hidden nor an
  // always-visible list can satisfy it.
  const collapseRenderSnap = async () => j(`(() => {
    const row = document.querySelector('.session-row[data-session-id="${S_A}"]');
    const list = row ? row.querySelector('.agents-list') : null;
    if (!list) return null;
    const cs = getComputedStyle(list);
    return { display: cs.display, height: list.getBoundingClientRect().height };
  })()`);
  const collapseRendered = await collapseRenderSnap();

  // --- sa5/sa6/sa7/sa8/sa13: expand S_A, inspect its (now single) row ------
  await j(`window.__sbEnsureExpanded('${S_A}')`);
  await sleep(200);
  snap = await j(`window.__sbAgentsSnap(['${S_A}'])`);
  const a = g(S_A);

  const expandRendered = await collapseRenderSnap();
  gate('sa4b_collapse_renders',
    !!collapseRendered && !!expandRendered
      && collapseRendered.display === 'none' && collapseRendered.height === 0
      && expandRendered.display !== 'none' && expandRendered.height > 0,
    JSON.stringify({ collapsed: collapseRendered, expanded: expandRendered }));

  gate('sa5_expand_order',
    a.ariaExpanded === 'true' && a.listHidden === false
      && JSON.stringify(a.rowIds) === JSON.stringify(EXPECTED_ORDER)
      && rawA0Ids.length === 6, // payload still carries all 6 while the DOM shows the 2 running ones
    JSON.stringify({ ariaExpanded: a.ariaExpanded, listHidden: a.listHidden, rowIds: a.rowIds, rawA0Ids }));

  // D1: only 'running' rows ever reach the DOM, and the 4 CURRENT-turn
  // done/blocked ids are absent BY NAME — the exact user-reported bug class —
  // while the RAW payload still carries each of them with its real state
  // (proves the renderer, not the main process, is doing the filtering).
  const rawStatesOk = DONE_OR_BLOCKED_IDS.every((id) => {
    const e = rawA0 && rawA0.agents && rawA0.agents.find((x) => x.toolUseId === id);
    return !!e && e.state === EXPECTED_STATE[id];
  });
  gate('sa6_state_counts',
    a.rowCount === 2
      && (a.rowStates || []).every((st) => st === 'running')
      && DONE_OR_BLOCKED_IDS.every((id) => !(a.rowIds || []).includes(id))
      && rawStatesOk,
    JSON.stringify({ rowCount: a.rowCount, rowStates: a.rowStates, rowIds: a.rowIds, excludedIds: DONE_OR_BLOCKED_IDS, rawStatesOk }));

  // D2: the row's rendered text is EXACTLY agent-name + status word — no
  // description, no m:ss elapsed counter — while the RAW payload's own
  // toolu_ack entry still carries the description (proves the renderer
  // dropped it from the row, not that it was never there).
  const EXPECTED_ROW_TEXT = `${EXPECTED_FIELDS.toolu_ack.type}en cours`; // spans concatenate with no separator (gap is CSS-only)
  const rawAckEntry = rawA0 && rawA0.agents && rawA0.agents.find((e) => e.toolUseId === 'toolu_ack');
  gate('sa7_row_fields',
    (a.rowIds || []).length === 2 && a.rowIds[0] === 'toolu_ack'
      && (a.rowTexts || [])[0] === EXPECTED_ROW_TEXT
      && !(a.rowTexts || [])[0].includes(EXPECTED_FIELDS.toolu_ack.desc)
      && !/\d+:\d{2}/.test((a.rowTexts || [])[0] || '')
      && !!rawAckEntry && rawAckEntry.description === EXPECTED_FIELDS.toolu_ack.desc,
    JSON.stringify({ rowTexts: a.rowTexts, rawAckDesc: rawAckEntry && rawAckEntry.description }));

  // sa8 split in two (lot P3, corrected protocol): the old compound assertion
  // bundled two DIFFERENT mechanisms under one gate name/verdict. For a DONE
  // entry (toolu_old) the liveness disjunct is irrelevant — its absence is
  // explained ONLY by told-exclusion — sa8a isolates that. For toolu_bgrun
  // (state='running', older turn): FLIPPED (L3b) — S_A is live now, so a live
  // session's cross-turn survivor is SHOWN; sa8b isolates that (the
  // "not live -> hidden" half of the old gate lives on S_E / S_F, sa16 / sa17).
  gate('sa8a_told_absent',
    !(a.rowIds || []).includes('toolu_old'),
    JSON.stringify(a.rowIds));

  gate('sa8b_live_survivor_shown',
    (a.rowIds || []).includes('toolu_bgrun') && (a.rowStates || [])[(a.rowIds || []).indexOf('toolu_bgrun')] === 'running',
    JSON.stringify(a.rowIds));

  const tokenSnap = await j(`(() => {
    const list = document.querySelector('.session-row[data-session-id="${S_A}"] .agents-list');
    const row = list ? list.querySelector('.agent-row') : null;
    const dot = list ? list.querySelector('.agent-row[data-state="running"] .agent-dot') : null;
    const wit = document.createElement('span');
    wit.style.fontFamily = 'var(--font-ui)';
    document.body.appendChild(wit);
    const fontUi = getComputedStyle(wit).fontFamily;
    wit.style.color = '';
    wit.style.background = 'var(--accent)';
    const accent = getComputedStyle(wit).backgroundColor;
    wit.style.background = 'var(--c-agent)'; // B12: the running agent dot is violet, via its own token
    const agent = getComputedStyle(wit).backgroundColor;
    wit.remove();
    return {
      rowFont: row ? getComputedStyle(row).fontFamily : null,
      dotBg: dot ? getComputedStyle(dot).backgroundColor : null, // the lit Halo pearl of the running dot
      dotGlow: dot ? getComputedStyle(dot, '::before').animationName : null,
      fontUi, accent, agent,
    };
  })()`);
  gate('sa13_tokens',
    !bad(tokenSnap) && !!tokenSnap.rowFont && tokenSnap.rowFont === tokenSnap.fontUi
      && !!tokenSnap.dotBg && tokenSnap.dotBg === tokenSnap.agent
      && tokenSnap.agent === 'rgb(164, 156, 203)' && tokenSnap.dotBg !== tokenSnap.accent
      && tokenSnap.rowFont.startsWith('"IBM Plex Sans"') && tokenSnap.dotGlow === 'breathe',
    JSON.stringify(tokenSnap));

  // --- sa12: XSS payload in description, reaching the row ONLY via the
  // `title` hover attribute (S_H, D2 amendment) — description is an
  // attribute write (`btn.title = a.description`), never an HTML sink, so it
  // can't execute; but it must still reach the tooltip VERBATIM (proving the
  // amendment actually works) while creating zero DOM elements. This gate
  // CAN fail: swapping `btn.title = a.description` for an HTML-sink write
  // (e.g. `btn.insertAdjacentHTML('beforeend', a.description)`) would create
  // a real <img> (imgCount -> 1), fire onerror (xssFlag -> true), AND the
  // row would stop exposing the description via `.title` at all. ----------
  await j(`window.__sbEnsureExpanded('${S_H}')`);
  await sleep(200);
  const snapH = await j(`window.__sbAgentsSnap(['${S_H}'])`);
  const hRow = (bad(snapH) ? null : snapH[S_H]) || {};
  const xssFlag = await j('window.__sbXss === true');
  gate('sa12_xss_safe',
    hRow.hasToggle === true && hRow.rowCount === 1 && (hRow.rowIds || [])[0] === 'toolu_h_bg'
      && (hRow.rowTexts || [])[0] === 'notesen cours' // visible row text unaffected: name + status only
      && (hRow.rowTitles || [])[0] === XSS_DESC // tooltip carries the raw description verbatim, as an attribute
      && hRow.imgCount === 0 && xssFlag !== true,
    JSON.stringify({ hRow, xssFlag }));

  // NOTE (no sa23 E2E gate): the empty-description guard
  // (`if (a.description) btn.title = a.description;`, sidebar.js) is real
  // defensive code but is NOT exercisable through a real wire-format
  // fixture: toolSummary() (transcript-normalize.js SUMMARY_KEYS) falls back
  // to `Object.keys(input).join(', ')` whenever no summary field has
  // content, and a Task dispatch's `input` always has >=1 key
  // (`subagent_type`), so `ev.summary` — and therefore `entry.description`
  // (session-activity.js:111) — can never actually be empty for an agent
  // ledger entry. Measured: an `{description: ''}` fixture input produced
  // "subagent_type, description, run_in_background", not ''. The guard is
  // correct/harmless defensive code; there is no reachable RED state for it
  // to probe.

  // --- sa22: D2 CSS clamp — a long agentType (24 chars, a real agent name)
  // ellipsises instead of pushing the row past the 280px sidebar ----------
  const clampSnap = await j(`(() => {
    const list = document.querySelector('.session-row[data-session-id="${S_G}"] .agents-list');
    const typeEl = list ? list.querySelector('.sa-type') : null;
    if (!typeEl) return null;
    const cs = getComputedStyle(typeEl);
    return {
      text: typeEl.textContent,
      overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
    };
  })()`);
  gate('sa22_type_ellipsis_clamp',
    !!clampSnap && clampSnap.text === LONG_AGENT_TYPE
      && clampSnap.overflow === 'hidden' && clampSnap.textOverflow === 'ellipsis' && clampSnap.whiteSpace === 'nowrap',
    JSON.stringify(clampSnap));

  // --- sa15: neither the fold toggle nor an agent row opens a pane ----------
  await j(`(() => {
    const row = document.querySelector('.session-row[data-session-id="${S_A}"]');
    const toggle = row && row.querySelector('.agents-toggle');
    if (toggle) toggle.click();
  })()`);
  const panes1 = await j('panes.size');
  await j(`(() => {
    const list = document.querySelector('.session-row[data-session-id="${S_A}"] .agents-list');
    const row = list && list.querySelector('.agent-row');
    if (row) row.click();
  })()`);
  const panes2 = await j('panes.size');
  gate('sa15_no_pane_on_agent_click',
    panes1 === 0 && panes2 === 0,
    JSON.stringify({ panes1, panes2 }));

  // --- sa10: live completion of T_ack via an appended <task-notification> --
  // F2 (Tier 2 review, 2026-09-18): this is the ONLY gate exercising the
  // live-push path (notifySessionFlags -> setSessionAgents), so it must pin
  // the DOM's 1-row -> 0-row transition AGAINST the pushed 'session-flags'
  // payload still carrying toolu_ack (now 'done') — sa11 only proves the
  // payload side (on a LATER, unrelated push) and says nothing about the
  // renderer re-rendering live; this gate proves the other half.
  const before10 = await j(`window.__sbAgentsSnap(['${S_A}'])`);
  const beforeA = (bad(before10) ? null : before10[S_A]) || {};
  await j(`window.__sbFlagsCapture10 = null;
    window.api.onSessionFlags((p) => { if (p && p.sessionId === '${S_A}') window.__sbFlagsCapture10 = p; });`);
  fs.appendFileSync(fileA, JSON.stringify(
    textNotifLine('<task-notification><tool-use-id>toolu_ack</tool-use-id><status>completed</status></task-notification>', ts(20))) + '\n');
  await j('renderSessions({ auto: true })');
  let sa10ok = false; let sa10snap = null; let sa10push = null;
  for (let i = 0; i < 25; i++) { // up to 5s
    await sleep(200);
    sa10snap = await j(`window.__sbAgentsSnap(['${S_A}'])`);
    sa10push = await j('window.__sbFlagsCapture10');
    const s = bad(sa10snap) ? null : sa10snap[S_A];
    // D1: toolu_ack flips running -> done, so its row goes and only the live
    // survivor toolu_bgrun is left (L3b: S_A is live) — while the PUSHED
    // payload still carries toolu_ack, now 'done'.
    if (s && s.rowCount === 1 && (s.rowIds || [])[0] === 'toolu_bgrun' && sa10push) { sa10ok = true; break; }
  }
  const pushedAckEntry = (sa10push && Array.isArray(sa10push.agents))
    ? sa10push.agents.find((e) => e.toolUseId === 'toolu_ack') : null;
  gate('sa10_live_update',
    beforeA.rowCount === 2 && (beforeA.rowIds || [])[0] === 'toolu_ack' && (beforeA.rowStates || [])[0] === 'running'
      && sa10ok
      && !!pushedAckEntry && pushedAckEntry.state === 'done',
    JSON.stringify({ beforeA, sa10snap, pushedAckEntry }));

  // --- sa11: a fresh transcript touch -> flags go indeterminate again, and
  // the following session-flags push carries an `agents` field -------------
  await j(`window.__sbFlagsCapture = null;
    window.api.onSessionFlags((p) => { if (p && p.sessionId === '${S_A}') window.__sbFlagsCapture = p; });`);
  fs.appendFileSync(fileA, JSON.stringify(
    { type: 'user', cwd: proj, timestamp: ts(21), message: { role: 'user', content: 'ping' } }) + '\n');
  const freshFlags = await j(`(async () => {
    const groups = await window.api.listSessions();
    const row = groups.flatMap((g2) => g2.sessions).find((s) => s.sessionId === '${S_A}');
    return row ? row.flags : 'MISSING';
  })()`);
  let pushedFlags = null;
  for (let i = 0; i < 20; i++) { // up to 4s
    await sleep(200);
    pushedFlags = await j('window.__sbFlagsCapture');
    if (pushedFlags) break;
  }
  // C11 F3 (contract, main-process side, untouched by this lot): the live C1
  // purge (terminal agents drop once the next real user message lands) must
  // be provable main-side too. L3b: S_A is live, so the live survivor
  // toolu_bgrun stays and the pushed payload's `agents` is exactly [toolu_bgrun]:
  // every done / blocked id (toolu_ack included) has been purged.
  gate('sa11_flags_null_and_push_agents',
    freshFlags === null && !!pushedFlags && !bad(pushedFlags)
      && Object.prototype.hasOwnProperty.call(pushedFlags, 'agents')
      && Array.isArray(pushedFlags.agents) && pushedFlags.agents.map((e) => e.toolUseId).join() === 'toolu_bgrun',
    JSON.stringify({ freshFlags, pushedFlags }));

  // --- sa14: expanded state survives a full (non-auto) renderSessions() ----
  await j(`window.__sbEnsureExpanded('${S_A}')`);
  await sleep(200);
  await j('renderSessions()');
  await sleep(300);
  // Anchored on S_G (live+fresh, see sa18) rather than S_A: by this point
  // S_A's own list is down to its one live survivor (sa10/sa11 already proved
  // the purge of every done / blocked row), which is a thinner base for the
  // "survives a rerender" check than a fresh running row. S_G keeps one
  // genuinely running agent throughout, so both halves below can still fail
  // for real.
  await j(`window.__sbEnsureExpanded('${S_G}')`);
  await sleep(200);
  await j('renderSessions()');
  await sleep(300);
  const snapPostG = await j(`window.__sbAgentsSnap(['${S_G}'])`);
  const postG = (bad(snapPostG) ? null : snapPostG[S_G]) || {};
  gate('sa14_expand_survives_rerender',
    postG.ariaExpanded === 'true' && postG.listHidden === false && postG.rowCount === 1
      && Array.isArray(postG.rowIds) && postG.rowIds[0] === 'toolu_g_bg'
      && (postG.rowStates || [])[0] === 'running',
    JSON.stringify(postG));

  // --- sa16/sa17/sa18: liveness+freshness gate (lot P3) --------------------
  // (a) not live (no pty, no status file) -> zero agent rows even though the
  // dangling entry's ledger state is 'running'.
  let snapEFG = await j(`window.__sbAgentsSnap(['${S_E}', '${S_F}', '${S_G}'])`);
  const eRow = (bad(snapEFG) ? null : snapEFG[S_E]) || {};
  gate('sa16_closed_session_zero_agents', eRow.hasToggle === false, JSON.stringify(eRow));

  // (b) live (status file says 'working') but the transcript mtime is older
  // than the staleness threshold -> zero rows too ("open but idle").
  const fRow = (bad(snapEFG) ? null : snapEFG[S_F]) || {};
  gate('sa17_stale_open_session_zero_agents', fRow.hasToggle === false, JSON.stringify(fRow));

  // (c) non-regression floor: live AND fresh -> the genuinely running agent
  // still shows, by id and state.
  await j(`window.__sbEnsureExpanded('${S_G}')`);
  await sleep(200);
  snapEFG = await j(`window.__sbAgentsSnap(['${S_G}'])`);
  const gRow = (bad(snapEFG) ? null : snapEFG[S_G]) || {};
  gate('sa18_live_fresh_agent_shows',
    gRow.hasToggle === true && gRow.rowCount === 1
      && Array.isArray(gRow.rowIds) && gRow.rowIds[0] === 'toolu_g_bg'
      && (gRow.rowStates || [])[0] === 'running',
    JSON.stringify(gRow));

  // --- sa23/sa24/sa25: a sub-agent RESUMED by SendMessage (sa23/sa24 FOREGROUND
  // origin, sa25 BACKGROUND-origin control) ----------------------------------
  const rawAgent = async (sid, id) => {
    const f = await rawFlagsOf(sid);
    return (f && Array.isArray(f.agents)) ? (f.agents.find((e) => e.toolUseId === id) || null) : null;
  };
  const runningDrawn = (row, id) => row.hasToggle === true && row.rowCount === 1
    && Array.isArray(row.rowIds) && row.rowIds[0] === id && (row.rowStates || [])[0] === 'running';
  await j('renderSessions()');
  await sleep(300);
  await j(`window.__sbEnsureExpanded('${S_I}'); window.__sbEnsureExpanded('${S_K}'); true`);
  await sleep(200);
  const snapIK = await j(`window.__sbAgentsSnap(['${S_I}', '${S_K}'])`);
  const iRow = (bad(snapIK) ? null : snapIK[S_I]) || {};
  const kRow = (bad(snapIK) ? null : snapIK[S_K]) || {};
  const iRaw = await rawAgent(S_I, 'toolu_i_d');
  const kRaw = await rawAgent(S_K, 'toolu_k_d');
  gate('sa23_fg_resume_running_drawn',
    !!iRaw && iRaw.state === 'running' && runningDrawn(iRow, 'toolu_i_d'),
    JSON.stringify({ iRaw, iRow }));

  // sa24: the resumed run's own <task-notification> names the SendMessage call
  // id. The pre-state (running + drawn) is part of the gate: without the resume
  // the entry is already 'done' and a "closed" check alone would pass vacuously.
  fs.appendFileSync(fileI, JSON.stringify(textNotifLine(
    '<task-notification><tool-use-id>toolu_i_s</tool-use-id><status>completed</status></task-notification>', ts(8))) + '\n');
  await j('renderSessions({ auto: true })');
  let iClosed = false; let iRaw2 = null; let iSnap2 = null;
  for (let i = 0; i < 25; i++) { // up to 5s
    await sleep(200);
    iSnap2 = await j(`window.__sbAgentsSnap(['${S_I}'])`);
    iRaw2 = await rawAgent(S_I, 'toolu_i_d');
    const s = bad(iSnap2) ? null : iSnap2[S_I];
    if (s && s.hasToggle === false && iRaw2 && iRaw2.state === 'done') { iClosed = true; break; }
  }
  gate('sa24_fg_resume_closed_by_notification',
    runningDrawn(iRow, 'toolu_i_d') && iClosed,
    JSON.stringify({ preRunningDrawn: runningDrawn(iRow, 'toolu_i_d'), iRaw2, iSnap2 }));

  gate('sa25_bg_origin_resume_control',
    !!kRaw && kRaw.state === 'running' && runningDrawn(kRow, 'toolu_k_d'),
    JSON.stringify({ kRaw, kRow }));

  // --- sa26..sa29 (lot sidebar-journal): waiting / closed display, driven by
  // the real 'session-flags' / 'session-status' channels (no seam). S_E is a
  // closed session whose main-side agents stay empty, so the pushed payload is
  // the only source of rows.
  const pushFlagsE = (agents) => win.webContents.send('session-flags', { sessionId: S_E, agents });
  const pushStatusE = (status) => win.webContents.send('session-status', { sessionId: S_E, status });
  const snapE = async (pred, settleMs) => {
    let s = {};
    for (let i = 0; i < 15; i++) { // up to 3s
      await sleep(settleMs || 200);
      const all = await j(`window.__sbAgentsSnap(['${S_E}'])`);
      s = (bad(all) ? null : all[S_E]) || {};
      if (pred(s)) return s;
    }
    return s;
  };
  const agentsWrapText = () => j(`(() => {
    const w = document.querySelector('.session-row[data-session-id="${S_E}"] .session-agents');
    return w ? w.textContent : null;
  })()`);
  const L6_AGENTS = [
    { toolUseId: 'toolu_l6_run', agentType: 'l6-runner', description: 'Run job', state: 'running' },
    { toolUseId: 'toolu_l6_wait', agentType: 'l6-waiter', description: '', state: 'waiting' },
    { toolUseId: 'toolu_l6_waitd', agentType: 'l6-waiterd', description: 'Trace flow Z', state: 'waiting' },
  ];
  pushFlagsE(L6_AGENTS);
  const e26 = await snapE((s) => s.rowCount === 3);
  const e26dataAgents = await j(`document.querySelector('.session-row[data-session-id="${S_E}"]').dataset.agents || null`);
  gate('sa26_waiting_rows',
    e26.rowCount === 3
      && JSON.stringify(e26.rowStates) === JSON.stringify(['running', 'waiting', 'waiting'])
      && /en attente/.test(e26.rowTexts[1] || '') && /en attente/.test(e26.rowTexts[2] || '')
      && e26.rowTitles[0] === 'Run job'
      && e26.rowTitles[1] === 'En attente de ses tâches de fond'
      && e26.rowTitles[2] === 'Trace flow Z'
      && e26dataAgents === '1'
      && /1 en cours/.test(e26.toggleText || '') && /2 en attente/.test(e26.toggleText || ''),
    JSON.stringify({ e26, e26dataAgents }));

  pushFlagsE([L6_AGENTS[1]]);
  const e26b = await snapE((s) => s.rowCount === 1 && (s.rowStates || [])[0] === 'waiting');
  gate('sa26b_waiting_only_header_not_terminated',
    e26b.rowCount === 1 && /1 en attente/.test(e26b.toggleText || '') && !/terminé/.test(e26b.toggleText || ''),
    JSON.stringify(e26b));

  // unknown (and the terminal states) render nowhere: no row, no « interrompu ».
  pushFlagsE([
    { toolUseId: 'toolu_l6_unk', agentType: 'l6-unknown', description: 'Hidden one', state: 'unknown' },
    { toolUseId: 'toolu_l6_closed', agentType: 'l6-closed', description: 'Gone one', state: 'closed' },
    { toolUseId: 'toolu_l6_done', agentType: 'l6-done', description: 'Done one', state: 'done' },
  ]);
  await sleep(500);
  const e27 = await snapE((s) => s.hasToggle === false);
  const e27text = await agentsWrapText();
  gate('sa27_unknown_and_closed_render_nowhere',
    e27.hasToggle === false && e27.rowCount === 0 && e27text === '' && !/interrompu/i.test(e27text || ''),
    JSON.stringify({ e27, e27text }));

  // F2: a push that omits a row shown before removes it.
  pushFlagsE([L6_AGENTS[0]]);
  const e28a = await snapE((s) => s.rowCount === 1);
  pushFlagsE([]);
  await sleep(400);
  const e28b = await snapE((s) => s.hasToggle === false);
  gate('sa28_omitted_row_removed',
    e28a.rowCount === 1 && (e28a.rowStates || [])[0] === 'running' && e28b.hasToggle === false && e28b.rowCount === 0,
    JSON.stringify({ e28a, e28b }));

  // closed status: the agent rows leave at once (before the 300ms debounced
  // re-scan) and stay gone after a full rebuild, even when the sessions-list
  // row carries flags:null (lastFlags must not resurrect them).
  pushFlagsE([L6_AGENTS[0], L6_AGENTS[1]]);
  const e29a = await snapE((s) => s.rowCount === 2);
  pushStatusE('closed');
  await sleep(120);
  const e29b = await j(`window.__sbAgentsSnap(['${S_E}'])`);
  const e29bRow = (bad(e29b) ? null : e29b[S_E]) || {};
  await j('renderSessions()');
  await sleep(500);
  const e29c = await snapE((s) => s.hasToggle === false);
  const e29raw = await rawFlagsOf(S_E);
  gate('sa29_closed_status_clears_agents',
    e29a.rowCount === 2 && e29bRow.hasToggle === false && e29bRow.rowCount === 0
      && e29c.hasToggle === false && e29c.rowCount === 0,
    JSON.stringify({ e29a: e29a.rowCount, e29bRow, e29c, sessionsListFlagsNull: e29raw === null }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'RED'} (${results.length - failed.length}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
});
