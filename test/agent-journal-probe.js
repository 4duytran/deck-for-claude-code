// test/agent-journal-probe.js — E2E probe: per-agent JOURNAL overlay
// (lot B, step P2 — RED). One overlay shows a single sub-agent's own
// sidechain transcript (text + tool calls, read-only), opened from a
// sidebar agent-row (P1 contract, `.agent-row[data-tool-use-id]`) or from a
// chat dispatch card's `.ct-agent` badge (already-shipped v44 markup).
//
// THIS STEP IS RED BY DESIGN: no production code exists yet for any of
// this (no `#agent-journal`, no `window.openAgentJournal`, no
// `window.api.agentJournalSubscribe`). Selectors/identifiers below
// (`#agent-journal`, `.aj-feed`, `.aj-line`, `.aj-filter`,
// `.aj-readonly`, `.aj-close`, `.aj-status`,
// `window.openAgentJournal`, `window.api.agentJournalSubscribe`) are the
// CONTRACT this probe fixes for the later GREEN steps (S3/S4/S6a/S6b) to
// implement against — not a description of existing markup.
//
// Resolution order (contract C3, independent of agent run state):
//   live      — `<sid>/subagents/agent-*.meta.json` whose toolUseId matches
//               (path confirmed at src/main/transcripts.js:34).
//   archived  — same match under `subagents-archive/<sid>/<ts>/`, newest
//               timestamp first (NEW for this lot — no production code
//               reads this path yet; this probe fixes the layout).
//   unavailable — no file anywhere -> « Journal indisponible ».
//
// Fixtures (S_A shape COPIED from test/sidebar-agents-probe.js, never
// imported — probes are standalone): the 7-dispatch, 2-turn S_A session
// from P1, with ONE deliberate field change — `toolu_ack`'s agentType is
// 'code-dev' (not 'search-docs') so aj1 has a concrete, realistic aria-label
// to assert against. Three journal-specific dispatches ride on top of the
// unchanged dispatch ids:
//   T_ack  = toolu_ack   (already "en cours", ACK-only) -> LIVE journal
//            under `<sid>/subagents/agent-a1.{meta,jsonl}`; its Bash tool
//            description carries an XSS payload (aj13).
//   T_arch = toolu_fg    (already "terminé")            -> ARCHIVED journal
//            under `subagents-archive/<sid>/2026-09-17-120000/agent-a2.*`.
//   T_gone = toolu_block (already "bloqué")              -> no file anywhere.
// Journal availability does not depend on any of these run states (C3) —
// the three are picked from the existing 6-member set only for a familiar,
// realistic dispatch shape, not because their sidebar state matters here.
//
// Gates: aj1 sidebar-row open + aria-label, aj2 width=620px@zoom1.0, aj3
// feed text+tool content, aj4 filters, aj5 (two halves: live append, then
// main-transcript completion flips the header), aj6 always-follow feed (no toggle),
// aj7 read-only (no inputs), aj8 archived open, aj9 unavailable message,
// aj10 open from a chat dispatch card, aj11 (six ordered pairs, one gate)
// journal-centric exclusivity with git/plans/room, aj12 path-traversal
// safety, aj13 XSS safety, aj14 close stops further events. 14 gates.
//
// Run: cd claude-deck && CLAUDE_DECK_ZOOM=1.0 node_modules/.bin/electron test/agent-journal-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-journal-probe-'));
const proj = path.join(base, 'proj');
fs.mkdirSync(proj, { recursive: true });
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });

const S_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const fileA = path.join(projDir, `${S_A}.jsonl`);

const ts = (i) => `2026-09-17T10:${String(i).padStart(2, '0')}:00.000Z`;
const ASYNC_ACK_TEXT = 'Async agent launched successfully in the background.';

// ---- fixture writer COPIED verbatim (shape) from sidebar-agents-probe.js --
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
  return line;
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
  // T_ack: agentType changed to 'code-dev' (see header note) — everything
  // else about this dispatch (ACK-only, background, "en cours") is P1-shape.
  dispatchLine('toolu_ack', 'code-dev', 'Check API docs', ts(8), { bg: true }),
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

// ---- journal-specific fixtures (NEW for P2) --------------------------------
const T_ACK = 'toolu_ack';
const T_ARCH = 'toolu_fg';
const T_GONE = 'toolu_block'; // deliberately: no subagents file anywhere

// LIVE — <sid>/subagents/agent-*.{meta,jsonl} (real path, transcripts.js:34).
const AGENT_LIVE_DIR = path.join(projDir, S_A, 'subagents');
fs.mkdirSync(AGENT_LIVE_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.meta.json'),
  JSON.stringify({ agentType: 'code-dev', description: 'Check API docs', toolUseId: T_ACK }));
const XSS_TOOL_DESC = '<img src=x onerror="window.__ajXss=true">fetch API docs';
writeJsonl(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'), [
  { type: 'user', isSidechain: true, timestamp: ts(8),
    message: { role: 'user', content: 'Check API docs' } },
  { type: 'assistant', isSidechain: true, timestamp: ts(8),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Je vérifie la documentation.' }] } },
  { type: 'assistant', isSidechain: true, timestamp: ts(8),
    message: { role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_aj_bash1', name: 'Bash',
                  input: { command: 'curl -s https://api.example.com/docs', description: XSS_TOOL_DESC } }] } },
  { type: 'user', isSidechain: true, timestamp: ts(8),
    message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_aj_bash1',
                  content: 'HTTP/1.1 200 OK\nContent-Type: application/json\n{"status":"ok"}' }] } },
]);

// ARCHIVED — subagents-archive/<sid>/<ts>/agent-*.{meta,jsonl} (NEW layout,
// no production reader exists yet — this probe fixes it as the contract).
const AGENT_ARCHIVE_DIR = path.join(projDir, 'subagents-archive', S_A, '2026-09-17-120000');
fs.mkdirSync(AGENT_ARCHIVE_DIR, { recursive: true });
fs.writeFileSync(path.join(AGENT_ARCHIVE_DIR, 'agent-a2.meta.json'),
  JSON.stringify({ agentType: 'arch', description: 'Trace flow C', toolUseId: T_ARCH }));
writeJsonl(path.join(AGENT_ARCHIVE_DIR, 'agent-a2.jsonl'), [
  { type: 'assistant', isSidechain: true, timestamp: ts(6),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Analyse du flux terminée.' }] } },
  { type: 'assistant', isSidechain: true, timestamp: ts(6),
    message: { role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_aj_grep1', name: 'Grep', input: { pattern: 'flowC' } }] } },
  { type: 'user', isSidechain: true, timestamp: ts(6),
    message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_aj_grep1', content: '3 call sites found.' }] } },
]);

// T_GONE (toolu_block) intentionally gets no subagents file at all.

// L3b (D-M1): a session shows its running agents only while it is positively live. S_A gets a fresh `working` status in
// an isolated status dir, so the sidebar row (aj1, aj15-aj17 flows) exists from the first render.
const statusDir = path.join(base, 'status');
fs.mkdirSync(statusDir, { recursive: true });
fs.writeFileSync(path.join(statusDir, `${S_A}.json`), JSON.stringify({ status: 'working', event: 'probe', ts: new Date().toISOString() }));
// L4 (R14 b): the journal reply's header state is the LIFECYCLE's. S_B has no status file and no pane (liveness unknown ->
// `unknown`, empty header status); S_C carries the deck's own PtyExit file and no pane (-> `closed`, « Interrompu»). Both
// hold one background dispatch the ledger still reads `running`, so only the lifecycle can tell the header otherwise.
const S_B = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const S_C = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const T_LIFE = 'toolu_life';
for (const sid of [S_B, S_C]) {
  writeJsonl(path.join(projDir, `${sid}.jsonl`), [
    { type: 'user', cwd: proj, timestamp: ts(30), message: { role: 'user', content: 'go' } },
    dispatchLine(T_LIFE, 'code-dev', 'Check lifecycle', ts(31), { bg: true }),
    resultLine(T_LIFE, ASYNC_ACK_TEXT, ts(32), { agentId: 'agent_life_1' }),
  ]);
}
fs.writeFileSync(path.join(statusDir, `${S_C}.json`), JSON.stringify({ status: 'closed', event: 'PtyExit', ts: new Date().toISOString() }));
process.env.CLAUDE_DECK_STATUS_DIR = statusDir;
process.env.CLAUDE_DECK_BIN = path.join(base, 'fake-claude.sh'); // real streaming shell, never the real claude
fs.writeFileSync(process.env.CLAUDE_DECK_BIN,
  '#!/bin/bash\n( while :; do echo .; sleep 1; done ) &\nexec cat > /dev/null\n',
  { mode: 0o755 });
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // real ~/.claude untouched
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-journal-userdata-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');

const results = [];
function gate(id, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${id}`;
  console.log(detail ? `${line} — ${detail}` : line);
  results.push({ id, ok });
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const bad = (v) => v && typeof v === 'object' && '__jsError' in v;

  await sleep(1500); // initial renderSessions() on boot settles

  // A chat pane on S_A so aj10 has real `.chat-tool` / `.ct-agent` markup to
  // click (that DOM is already shipped — v44 — only the click's EFFECT is RED).
  await j(`openPane({ resumeId: '${S_A}', title: 'fixture' })`);
  await sleep(800);
  await j(`setChatView('pane-1', true)`);
  await sleep(900);

  // ---- small helpers shared by several gates -------------------------------
  const ensureExpanded = async (id) => j(`(() => {
    const row = document.querySelector('.session-row[data-session-id="' + '${id}' + '"]');
    const toggle = row && row.querySelector('.agents-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    return !!toggle;
  })()`);
  const openJournalDirect = async (toolUseId) => j(`(async () => {
    try {
      if (typeof window.openAgentJournal !== 'function') return { err: 'no-seam' };
      await window.openAgentJournal({ sessionId: '${S_A}', toolUseId: '${toolUseId}' });
      return { called: true };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  })()`);
  const journalSnap = () => j(`(() => {
    const el = document.getElementById('agent-journal');
    return el ? { open: el.classList.contains('open'), label: el.getAttribute('aria-label') } : null;
  })()`);

  // === aj1 — sidebar agent-row click opens #agent-journal ===================
  await ensureExpanded(S_A);
  await sleep(200);
  await j(`(() => {
    const row = document.querySelector('.agent-row[data-tool-use-id="${T_ACK}"]');
    if (row) row.click();
  })()`);
  await sleep(300);
  const aj1 = await journalSnap();
  gate('aj1_open_from_sidebar',
    !bad(aj1) && !!aj1 && aj1.open === true && aj1.label === "Journal de l'agent code-dev",
    JSON.stringify(aj1));

  // === aj2 — width === 620px at zoom 1.0 =====================================
  // Decoupled from aj1 (S6b's sidebar-row click is inert until then): opens
  // T_ACK directly, same seam as aj8/aj9/aj13.
  await openJournalDirect(T_ACK);
  await sleep(300);
  const aj2 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    if (!el || !el.classList.contains('open')) return null;
    return { width: el.getBoundingClientRect().width };
  })()`);
  gate('aj2_width_620', !bad(aj2) && !!aj2 && aj2.width === 620, JSON.stringify(aj2));

  // === aj3 — feed: text paragraph + Bash tool row, expanded result =========
  // Decoupled from aj1: opens T_ACK directly (same seam as aj8/aj9/aj13).
  await openJournalDirect(T_ACK);
  await sleep(300);
  const aj3 = await j(`(() => {
    const feed = document.querySelector('#agent-journal .aj-feed');
    if (!feed) return null;
    const textLine = feed.querySelector('.aj-line[data-kind="text"]');
    const toolLine = feed.querySelector('.aj-line[data-kind="tool"]');
    if (toolLine) {
      // Variant A: the row head is the toggle (no separate ▸ button any more).
      const exp = toolLine.querySelector('.aj-tool-head');
      if (exp) exp.click();
    }
    return {
      hasText: !!textLine && /v.rifie/.test(textLine.textContent || ''),
      toolName: toolLine ? (toolLine.querySelector('.aj-tool-name') || {}).textContent : null,
      resultText: toolLine ? (toolLine.querySelector('.aj-tool-result') || {}).textContent : null,
    };
  })()`);
  gate('aj3_feed_text_and_tool',
    !bad(aj3) && !!aj3 && aj3.hasText === true && aj3.toolName === 'Bash'
    && !!aj3.resultText && aj3.resultText.includes('HTTP/1.1 200 OK'),
    JSON.stringify(aj3));

  // === aj3b — variant A « Registre »: a ruled line (no card, no left bar), Enter
  // toggles the result, no ▸ glyph, filter counts and the footer count come from the
  // rendered lines. The row is left collapsed and the read waits out the hover fade.
  const aj3bKeys = await j(`(() => {
    const head = document.querySelector('#aj-feed > .aj-tool > .aj-tool-head');
    if (!head) return null;
    const res = head.parentElement.querySelector('.aj-tool-result');
    const key = () => head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const openNow = res.hidden === false; // aj3 left it expanded
    key(); const closed = res.hidden === true && head.getAttribute('aria-expanded') === 'false';
    key(); const reopened = res.hidden === false && head.getAttribute('aria-expanded') === 'true';
    key();
    return { openNow, closed, reopened, collapsed: res.hidden === true };
  })()`);
  await sleep(500);
  const aj3b = await j(`(() => {
    const el = document.getElementById('agent-journal');
    const feed = document.getElementById('aj-feed');
    const row = feed.querySelector(':scope > .aj-tool');
    const text = feed.querySelector(':scope > p.aj-line');
    if (!row || !text) return null;
    const rs = getComputedStyle(row);
    const ts = getComputedStyle(text);
    const cols = rs.gridTemplateColumns.split(' ');
    const lines = [...feed.children].filter((c) => c.classList.contains('aj-line'));
    const toolN = lines.filter((l) => l.dataset.kind === 'tool').length;
    const cnt = (f) => { const b = el.querySelector('.aj-filter[data-filter="' + f + '"] .aj-count'); return b ? b.textContent : null; };
    const tab = getComputedStyle(el.querySelector('.aj-filter[aria-pressed="true"]'));
    const res = row.querySelector('.aj-tool-result');
    return {
      noGlyph: !row.querySelector('.aj-tool-expand') && !/[▸▾]/.test(row.textContent),
      ruled: rs.borderTopWidth === '0px' && rs.borderLeftWidth === '0px' && rs.borderBottomWidth === '1px'
        && rs.borderTopLeftRadius === '0px' && rs.backgroundColor === 'rgba(0, 0, 0, 0)',
      grid: cols.length === 4 && cols[0] === '58px' && cols[1] === '44px',
      textRuled: ts.display === 'grid' && ts.borderLeftWidth === '0px' && ts.borderBottomWidth === '1px',
      time: row.querySelector('.aj-tool-time').textContent,
      counts: cnt('all') === String(lines.length) && cnt('tools') === String(toolN) && cnt('text') === String(lines.length - toolN),
      foot: document.getElementById('aj-foot-count').textContent,
      tab: tab.borderTopLeftRadius === '0px' && tab.borderTopWidth === '0px' && tab.borderBottomWidth === '1px'
        && tab.backgroundColor === 'rgba(0, 0, 0, 0)',
      well: getComputedStyle(res).borderTopLeftRadius === '6px',
      pearl: !!el.querySelector('#aj-head > .aj-pearl'),
    };
  })()`);
  gate('aj3b_register_look',
    !bad(aj3bKeys) && !!aj3bKeys && aj3bKeys.openNow && aj3bKeys.closed && aj3bKeys.reopened && aj3bKeys.collapsed
    && !bad(aj3b) && !!aj3b && aj3b.noGlyph && aj3b.ruled && aj3b.grid && aj3b.textRuled && aj3b.counts
    && /^\d+ outils?( · \d+ erreurs?)?$/.test(aj3b.foot) && aj3b.tab && aj3b.well && aj3b.pearl
    && /^(\d\d:\d\d:\d\d)?$/.test(aj3b.time),
    JSON.stringify({ aj3bKeys, aj3b }));

  // Screenshot of the register (AJ_SHOT=<png path>, never part of the verdict): the live feed gets a
  // realistic run through the module's own notifyAgentJournalAppend, then one result is opened.
  if (process.env.AJ_SHOT) {
    const W = '/home/user/work/task/';
    const t0 = Date.now() - 180000;
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    const shotEvents = [
      { kind: 'text', text: 'Je regarde la règle du message utilisateur et la sonde qui la vérifie.', ts: at(0) },
      { kind: 'tool', id: 's1', name: 'Read', summary: `${W}test/restyle-look-probe.js`, ts: at(5) },
      { kind: 'result', toolUseId: 's1', isError: false, text: '381  const re = /linear-gradient\\(90deg,…30%…\\)/;\n417  // g7b_user_turn_right' },
      { kind: 'tool', id: 's2', name: 'Edit', summary: `${W}renderer/style.css`, ts: at(11) },
      { kind: 'result', toolUseId: 's2', isError: false, text: '- background-image: linear-gradient(90deg, #F1F3F6 0%, #E6E9EE 30%, #5E6672 100%);\n+ background: var(--surface-band);' },
      { kind: 'tool', id: 's3', name: 'Edit', summary: `${W}test/restyle-look-probe.js`, ts: at(14) },
      { kind: 'result', toolUseId: 's3', isError: false, text: 'ok' },
      { kind: 'tool', id: 's4', name: 'Bash', summary: 'Find stream padding, font tokens and head rules', ts: at(22) },
      { kind: 'result', toolUseId: 's4', isError: false, text: '' },
      { kind: 'tool', id: 's5', name: 'Bash', summary: 'Run restyle-look probe with band screenshot', ts: at(76) },
      { kind: 'result', toolUseId: 's5', isError: true, text: 'FAIL g12_band_shot\nVERDICT: RED (29/30 green)' },
      { kind: 'text', text: 'Vert 30/30. Je passe aux deux autres sondes.', ts: at(89) },
      { kind: 'tool', id: 's6', name: 'Bash', summary: 'Run chat-view probe, log to scratchpad', ts: at(95) },
    ];
    await j(`(async () => {
      const m = await import('./js/agent-journal.js');
      m.notifyAgentJournalAppend({ journalId: window.aj.journalId, events: ${JSON.stringify(shotEvents)} });
      document.querySelector('#aj-feed .aj-tool[data-status="err"] .aj-tool-head').click();
      return true;
    })()`);
    await sleep(500);
    const box = await j(`(() => { const b = document.getElementById('agent-journal').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
    fs.writeFileSync(process.env.AJ_SHOT, (await win.webContents.capturePage(box)).toPNG());
    console.log('SHOT ' + process.env.AJ_SHOT);
  }

  // === aj4 — Tout/Texte/Outils filters change visible counts + aria-pressed =
  // Decoupled from aj1: opens T_ACK directly (same seam as aj8/aj9/aj13).
  await openJournalDirect(T_ACK);
  await sleep(300);
  const aj4 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    if (!el) return null;
    const all = el.querySelector('.aj-filter[data-filter="all"]');
    const textBtn = el.querySelector('.aj-filter[data-filter="text"]');
    const toolsBtn = el.querySelector('.aj-filter[data-filter="tools"]');
    if (!all || !textBtn || !toolsBtn) return null;
    // Top-level feed lines only (#aj-feed > .aj-line) — a descendant query
    // would also count a nested .aj-tool-result sitting under a hidden
    // parent as visible (the defect this gate exists to catch).
    const visibleLines = () => [...document.querySelectorAll('#aj-feed > .aj-line')].filter((l) => !l.hidden);
    const countAll = visibleLines().length;
    textBtn.click();
    const textLines = visibleLines();
    const countText = textLines.length;
    const pressedText = textBtn.getAttribute('aria-pressed');
    toolsBtn.click();
    const toolsLines = visibleLines();
    const countTools = toolsLines.length;
    const pressedTools = toolsBtn.getAttribute('aria-pressed');
    all.click();
    return {
      countAll, countText, countTools, pressedText, pressedTools,
      textAllText: textLines.every((l) => l.dataset.kind === 'text'),
      toolsAllTool: toolsLines.every((l) => l.dataset.kind === 'tool'),
    };
  })()`);
  gate('aj4_filters_toggle',
    !bad(aj4) && !!aj4 && aj4.pressedText === 'true' && aj4.pressedTools === 'true'
    && aj4.countText < aj4.countAll && aj4.countTools < aj4.countAll
    && aj4.textAllText === true && aj4.toolsAllTool === true,
    JSON.stringify(aj4));

  // === aj5 — two halves, one gate: (i) live append surfaces <=6s; (ii) a
  // main-transcript task-notification completed flips the header <=6s ======
  // Decoupled from aj1: opens T_ACK directly (same seam as aj8/aj9/aj13).
  await openJournalDirect(T_ACK);
  await sleep(300);
  fs.appendFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'), JSON.stringify(
    { type: 'assistant', isSidechain: true, timestamp: ts(9),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Documentation vérifiée, tout est conforme.' }] } }) + '\n');
  let aj5a = false;
  for (let i = 0; i < 30; i++) { // up to 6s
    await sleep(200);
    const r = await j(`(() => {
      const feed = document.querySelector('#agent-journal .aj-feed');
      if (!feed) return false;
      return [...feed.querySelectorAll('.aj-line[data-kind="text"]')]
        .some((l) => (l.textContent || '').includes('conforme'));
    })()`);
    if (r === true) { aj5a = true; break; }
  }
  fs.appendFileSync(fileA, JSON.stringify(
    // D-PB: the closed memo of a run that died with its process is stamped at the first sighting (now), so a completion
    // notice written by the live agent carries a fresh ts (a fixture-era ts(22) would predate it and lose to the memo).
    textNotifLine('<task-notification><tool-use-id>toolu_ack</tool-use-id><status>completed</status></task-notification>', new Date().toISOString())) + '\n');
  // Kick the flags-recompute pipeline explicitly — same pattern as sa10 in
  // sidebar-agents-probe.js (identical fileA/toolu_ack notification): the
  // organic watcher alone is not proven to land inside the 6s window.
  await j('renderSessions({ auto: true })');
  let aj5b = false;
  for (let i = 0; i < 30; i++) { // up to 6s
    await sleep(200);
    const r = await j(`(() => {
      const st = document.querySelector('#agent-journal .aj-status');
      return st ? st.textContent.trim() : null;
    })()`);
    if (r === 'Terminé') { aj5b = true; break; }
  }
  gate('aj5_live_append_and_header_flip', aj5a === true && aj5b === true,
    JSON.stringify({ aj5a, aj5b }));

  // === aj6 — always follows: no toggle exists, feed sticks to bottom on any
  // append, unconditionally (no on/off state to flip) ========================
  const aj6NoToggle = await j(`(() => {
    const el = document.getElementById('agent-journal');
    if (!el) return null;
    const hasToggleEl = !!el.querySelector('.aj-follow-toggle');
    const hasToggleText = [...el.querySelectorAll('button')]
      .some((b) => (b.textContent || '').trim() === 'Suivre en direct');
    return hasToggleEl === false && hasToggleText === false;
  })()`);
  // Force real overflow BEFORE the scroll checks below: with only the handful
  // of lines the earlier gates left in place, the feed never exceeds its own
  // clientHeight (measured live: sh===ch, no scrollbar) — so
  // |(scrollHeight-clientHeight)-scrollTop|<=2 is trivially true and
  // scrollTop=0 is a no-op, and (b)/(c) would pass vacuously without ever
  // proving the feed actually follows. One burst of filler sidechain text
  // records (same fixture shape as the rest of this file), appended in ONE
  // write, pushes content height well past the panel's clientHeight first.
  const AJ6_FILL_LINES = Array.from({ length: 40 }, (_, i) => ({
    type: 'assistant', isSidechain: true, timestamp: ts(20),
    message: { role: 'assistant', content: [{ type: 'text',
      text: `Ligne de remplissage ${i} pour forcer le débordement du flux du journal et déclencher le défilement automatique vers le bas.` }] },
  }));
  fs.appendFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'),
    AJ6_FILL_LINES.map((o) => JSON.stringify(o)).join('\n') + '\n');
  await sleep(2200);
  fs.appendFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'), JSON.stringify(
    { type: 'assistant', isSidechain: true, timestamp: ts(10),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ligne supplémentaire un.' }] } }) + '\n');
  await sleep(2200);
  const aj6StuckFirst = await j(`(() => {
    const box = document.querySelector('#agent-journal .aj-feed');
    if (!box) return null;
    const sh = box.scrollHeight, ch = box.clientHeight, st = box.scrollTop;
    return { overflow: sh > ch + 50, stuck: Math.abs((sh - ch) - st) <= 2, sh, ch, st };
  })()`);
  await j(`(() => {
    const box = document.querySelector('#agent-journal .aj-feed');
    if (box) box.scrollTop = 0;
    return box ? box.scrollTop : null;
  })()`);
  fs.appendFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'), JSON.stringify(
    { type: 'assistant', isSidechain: true, timestamp: ts(11),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ligne supplémentaire deux.' }] } }) + '\n');
  await sleep(2200);
  const aj6StuckSecond = await j(`(() => {
    const box = document.querySelector('#agent-journal .aj-feed');
    if (!box) return null;
    const sh = box.scrollHeight, ch = box.clientHeight, st = box.scrollTop;
    return { overflow: sh > ch + 50, stuck: Math.abs((sh - ch) - st) <= 2, sh, ch, st };
  })()`);
  const aj6ok = aj6NoToggle === true
    && !!aj6StuckFirst && aj6StuckFirst.overflow === true && aj6StuckFirst.stuck === true
    && !!aj6StuckSecond && aj6StuckSecond.overflow === true && aj6StuckSecond.stuck === true;
  gate('aj6_always_follow', aj6ok, JSON.stringify({
    a: aj6NoToggle, b: aj6StuckFirst, c: aj6StuckSecond
  }));

  // === aj7 — "Lecture seule" visible, zero interactive elements =============
  const aj7 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    if (!el) return null;
    const label = el.querySelector('.aj-readonly');
    const inputs = el.querySelectorAll('input, textarea, [contenteditable]').length;
    return { label: label ? label.textContent.trim() : null, inputs };
  })()`);
  gate('aj7_read_only_no_inputs',
    !bad(aj7) && !!aj7 && aj7.label === 'Lecture seule' && aj7.inputs === 0,
    JSON.stringify(aj7));

  // === aj8 — T_arch opens FROM THE ARCHIVE ===================================
  const aj8open = await openJournalDirect(T_ARCH);
  await sleep(600);
  const aj8 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    if (!el || !el.classList.contains('open')) return null;
    const feed = el.querySelector('.aj-feed');
    return { hasContent: !!feed && feed.querySelectorAll('.aj-line').length > 0 };
  })()`);
  gate('aj8_archived_open',
    !bad(aj8) && !!aj8 && aj8.hasContent === true, JSON.stringify({ aj8open, aj8 }));

  // === aj9 — T_gone renders « Journal indisponible », no exception ==========
  const aj9open = await openJournalDirect(T_GONE);
  await sleep(600);
  const aj9 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    return el ? (el.textContent || '').includes('Journal indisponible') : null;
  })()`);
  gate('aj9_unavailable_message',
    !bad(aj9open) && !aj9open.err && aj9 === true, JSON.stringify({ aj9open, aj9 }));

  // === aj10 — close first (so a leftover open state from a prior gate can't
  // fake a green), then a chat dispatch card click (pane open on S_A) opens
  // the overlay for the agent the card NAMES (the `.chat-tool`/`.ct-agent`
  // markup already ships — v44 — only the click's effect is RED until S6b).
  await j(`(() => {
    const el = document.getElementById('agent-journal');
    const close = el && el.querySelector('.aj-close');
    if (close) close.click();
  })()`);
  await sleep(300);
  const aj10click = await j(`(() => {
    const badge = [...document.querySelectorAll('.chat-tool .ct-agent')]
      .find((b) => b.textContent === 'code-dev');
    if (badge) { badge.click(); return true; }
    return false;
  })()`);
  await sleep(400);
  const aj10 = await journalSnap();
  gate('aj10_open_from_chat_card',
    aj10click === true && !bad(aj10) && !!aj10 && aj10.open === true
    && aj10.label === "Journal de l'agent code-dev",
    JSON.stringify({ aj10click, aj10 }));

  // === aj11 — journal-centric exclusivity, 6 ordered pairs, ONE gate ========
  // (C7/UD4: asserts NOTHING about git/plans <-> room, a pre-existing,
  // out-of-scope coexistence).
  const OVERLAY_SEL = {
    journal: '#agent-journal', git: '#git-panel', plans: '#plans-panel', room: '#room-panel',
  };
  const isOpen = async (kind) => j(`(() => {
    const el = document.querySelector('${OVERLAY_SEL[kind]}');
    return !!el && el.classList.contains('open');
  })()`);
  const closeAllOverlays = async () => { await j(`(() => {
    try { if (typeof window.closeGitPanel === 'function') window.closeGitPanel(); } catch (e) { /* noop */ }
    try { if (typeof window.closePlansPanel === 'function') window.closePlansPanel(); } catch (e) { /* noop */ }
    const rp = document.getElementById('room-panel');
    if (rp && rp.classList.contains('open')) {
      const t = document.getElementById('room-toggle');
      if (t) t.click();
    }
    const aj = document.getElementById('agent-journal');
    if (aj) {
      const close = aj.querySelector('.aj-close');
      if (close) close.click();
    }
  })()`); await sleep(300); };
  const openOverlay = async (kind) => {
    if (kind === 'journal') { await openJournalDirect(T_ACK); }
    else if (kind === 'git') { await j(`(() => { try { window.openGitPanel({ sessionId: '${S_A}' }); } catch (e) { /* noop */ } })()`); }
    else if (kind === 'plans') { await j(`(() => { try { window.openPlansPanel({ sessionId: '${S_A}' }); } catch (e) { /* noop */ } })()`); }
    else if (kind === 'room') { await j(`(() => { const t = document.getElementById('room-toggle'); if (t) t.click(); })()`); }
    await sleep(400);
  };
  const AJ11_PAIRS = [
    ['journal', 'git'], ['git', 'journal'],
    ['journal', 'plans'], ['plans', 'journal'],
    ['journal', 'room'], ['room', 'journal'],
  ];
  let aj11ok = true;
  const aj11detail = [];
  for (const [a, b] of AJ11_PAIRS) {
    await closeAllOverlays();
    await openOverlay(a);
    await openOverlay(b);
    const states = {};
    for (const k of Object.keys(OVERLAY_SEL)) states[k] = await isOpen(k);
    const openCount = Object.values(states).filter((v) => v === true).length;
    const exclusiveOk = openCount === 1 && states[b] === true;
    await j(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    const afterEsc = {};
    for (const k of Object.keys(OVERLAY_SEL)) afterEsc[k] = await isOpen(k);
    const escOk = afterEsc[b] === false
      && Object.keys(afterEsc).filter((k) => k !== b).every((k) => afterEsc[k] === states[k]);
    const pairOk = exclusiveOk && escOk;
    if (!pairOk) aj11ok = false;
    aj11detail.push({ pair: `${a}->${b}`, states, openCount, escOk, pairOk });
  }
  gate('aj11_exclusivity_six_pairs', aj11ok, JSON.stringify(aj11detail));
  await closeAllOverlays();

  // === aj12 — path traversal: agentJournalSubscribe resolves {ok:false} ====
  const aj12 = await j(`(async () => {
    try {
      if (!window.api || typeof window.api.agentJournalSubscribe !== 'function') return { err: 'no-api' };
      const r = await window.api.agentJournalSubscribe({ sessionId: '../../etc', toolUseId: '../passwd' });
      return { r };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  })()`);
  gate('aj12_path_traversal_safe',
    !bad(aj12) && !!aj12 && !!aj12.r && aj12.r.ok === false, JSON.stringify(aj12));

  // === aj13 — XSS in agent text yields no img node ==========================
  await openJournalDirect(T_ACK);
  await sleep(500);
  const aj13 = await j(`(() => {
    const el = document.getElementById('agent-journal');
    return { imgCount: el ? el.querySelectorAll('img').length : null, xssRan: window.__ajXss === true };
  })()`);
  gate('aj13_xss_safe',
    !bad(aj13) && !!aj13 && aj13.imgCount === 0 && aj13.xssRan !== true, JSON.stringify(aj13));

  // === aj14 — after close, an append pushes no further event ===============
  await j(`(() => {
    const el = document.getElementById('agent-journal');
    const close = el && el.querySelector('.aj-close');
    if (close) close.click();
  })()`);
  await sleep(300);
  const before14 = await j(`(() => {
    const feed = document.querySelector('#agent-journal .aj-feed');
    return feed ? feed.querySelectorAll('.aj-line').length : null;
  })()`);
  fs.appendFileSync(path.join(AGENT_LIVE_DIR, 'agent-a1.jsonl'), JSON.stringify(
    { type: 'assistant', isSidechain: true, timestamp: ts(12),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ligne post-fermeture.' }] } }) + '\n');
  await sleep(2400);
  const after14 = await j(`(() => {
    const feed = document.querySelector('#agent-journal .aj-feed');
    return feed ? feed.querySelectorAll('.aj-line').length : null;
  })()`);
  gate('aj14_close_stops_events',
    !bad(before14) && !bad(after14) && before14 === after14,
    JSON.stringify({ before14, after14 }));

  // === aj15..aj17 (lot sidebar-journal) — waiting / closed labels and the
  // omit-clears rule, driven by the real 'session-flags' channel ============
  const pushJ = (state, extra) => win.webContents.send('session-flags', {
    sessionId: S_A,
    agents: state === null ? [] : [Object.assign({
      toolUseId: T_ACK, agentType: 'search-docs', description: 'Check API docs', state,
      startTs: new Date(Date.now() - 65000).toISOString(),
    }, extra || {})],
  });
  const headerNow = () => j(`(() => {
    const st = document.getElementById('aj-status'); const el = document.getElementById('aj-elapsed');
    return { status: st ? st.textContent.trim() : null, elapsed: el ? el.textContent.trim() : null };
  })()`);
  const setJ = async (state, extra) => { pushJ(state, extra); await sleep(250); return headerNow(); };
  const opened15 = await openJournalDirect(T_ACK);
  await sleep(500);
  const jr = await setJ('running');
  const jw = await setJ('waiting');
  const jc = await setJ('closed');
  const ju = await setJ('unknown');
  gate('aj15_waiting_closed_unknown_labels',
    jr.status === 'En cours' && /^\d+:\d\d$/.test(jr.elapsed)
      && jw.status === 'En attente' && /^\d+:\d\d$/.test(jw.elapsed)
      && jc.status === 'Interrompu' && jc.elapsed === ''
      && ju.status === '' && ju.elapsed === '',
    JSON.stringify({ opened15, jr, jw, jc, ju }));

  await setJ('running');
  const jRunOmit = await setJ(null);
  await setJ('waiting');
  const jWaitOmit = await setJ(null);
  gate('aj16_omitted_running_or_waiting_clears_header',
    jRunOmit.status === '' && jRunOmit.elapsed === '' && jWaitOmit.status === '' && jWaitOmit.elapsed === '',
    JSON.stringify({ jRunOmit, jWaitOmit }));

  const jd = await setJ('done', { endTs: new Date().toISOString() });
  const jdOmit = await setJ(null);
  await setJ('blocked');
  const jbOmit = await setJ(null);
  await setJ('closed');
  const jcOmit = await setJ(null);
  gate('aj17_omitted_terminal_state_stays',
    jd.status === 'Terminé' && jdOmit.status === 'Terminé'
      && jbOmit.status === 'Bloqué' && jcOmit.status === 'Interrompu',
    JSON.stringify({ jd, jdOmit, jbOmit, jcOmit }));

  // === aj18/aj19 (L4, R14 b) — the subscribe reply carries the lifecycle state =============================
  const lifeReply = (sid) => j(`window.api.agentJournalSubscribe({ sessionId: '${sid}', toolUseId: '${T_LIFE}' })
    .then((r) => ({ ok: r.ok, state: r.agent ? r.agent.state : null, type: r.agent ? r.agent.agentType : null }))`);
  const lifeHeader = async (sid) => {
    await j(`window.openAgentJournal({ sessionId: '${sid}', toolUseId: '${T_LIFE}' })`);
    await sleep(500);
    return headerNow();
  };
  const rB = await lifeReply(S_B);
  const hB = await lifeHeader(S_B);
  gate('aj18_unknown_lifecycle_empty_header',
    !bad(rB) && rB.ok === true && rB.state === 'unknown' && rB.type === 'code-dev' && hB.status === '' && hB.elapsed === '',
    JSON.stringify({ rB, hB }));
  const rC = await lifeReply(S_C);
  const hC = await lifeHeader(S_C);
  gate('aj19_closed_lifecycle_interrompu_header',
    !bad(rC) && rC.ok === true && rC.state === 'closed' && rC.type === 'code-dev' && hC.status === 'Interrompu' && hC.elapsed === '',
    JSON.stringify({ rC, hC }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL GREEN' : 'RED'} (${results.length - failed.length}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
});
