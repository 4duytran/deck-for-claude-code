// claude-deck — renderer/agent-journal (S6a): read-only overlay showing ONE
// sub-agent's own sidechain transcript (text + tool calls), fed by the
// bridge shipped in S4 (window.api.agentJournalSubscribe/Unsubscribe,
// onAgentJournalAppend). Same right-overlay shell family as git/plans/room
// panels, own fixed 620px width (D16: own explicit z-index, never inherited).
//
// S6a shipped the overlay shell only; S6b (this) wires the entry points
// (sidebar row click, chat dispatch card click) and journal-centric
// exclusivity with the other overlay families, via renderer/js/state.js's
// overlayState container — see sidebar.js/chat-view.js/git-panel.js/
// plans-panel.js/room-panel.js.
//
// Renderer performs ZERO IO (rule 3): only { sessionId, toolUseId } crosses
// the bridge — no per-pane identifier anywhere in this feature (finding 9),
// main resolves every path. Every transcript-derived string reaches the DOM through
// textContent ONLY — agent text and tool results are untrusted content
// (CLAUDE.md rule 2, gate aj13).
'use strict';

import { overlayState } from './state.js';
import { skeleton } from './loading.js';

// Module-scoped state (probe seam: exposed on window as `aj` from boot.js,
// same pattern as `gp`/`pp`). toolRows: tool_use id -> { status, result } DOM
// refs, so a later 'result' event can update the row IN PLACE.
export const aj = {
  open: false,
  sessionId: null,
  toolUseId: null,
  journalId: null,
  agent: null, // ledger entry from the subscribe reply / a later flags push
  agentType: null, // best-known label: the open() param, else agent.agentType
  sessionTitle: '',
  filter: 'all', // 'all' | 'text' | 'tools'
  truncatedHead: false,
  toolRows: new Map(),
  paths: [], // path targets of the rendered tool lines: { dirEl, dir }, re-rooted as lines arrive
};

const AJ_STATE_LABEL = { running: 'En cours', waiting: 'En attente', done: 'Terminé', blocked: 'Bloqué', closed: 'Interrompu' };

// D13-style elapsed (m:ss), same convention as sidebar.js agentElapsed — kept
// as a local copy: agent-journal.js must not import sidebar.js (Scope OUT).
function ajElapsed(startTs, endTs) {
  const start = startTs ? Date.parse(startTs) : NaN;
  if (Number.isNaN(start)) return '0:00';
  const end = endTs ? Date.parse(endTs) : Date.now();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function ajFmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// HH:MM:SS of an event timestamp; '' when the feed carries none (never invented).
function ajFmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Tools whose target (the summary) is a file path: folder dimmed, file name in ink.
const AJ_FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Re-root every path target: the agent's cwd when the ledger carries one, else the
// longest directory shared by the absolute paths seen so far (it needs two distinct
// directories, a lone path keeps its folder). The hidden part reads as « …/ ».
function ajApplyPathRoot() {
  const cwd = aj.agent && typeof aj.agent.cwd === 'string' && aj.agent.cwd.startsWith('/')
    ? `${aj.agent.cwd.replace(/\/+$/, '')}/` : '';
  let root = cwd;
  if (!root) {
    const dirs = [...new Set(aj.paths.map((p) => p.dir).filter((d) => d.startsWith('/')))];
    if (dirs.length > 1) {
      let common = dirs[0].split('/').slice(0, -1);
      for (const d of dirs.slice(1)) {
        const seg = d.split('/').slice(0, -1);
        let i = 0;
        while (i < common.length && i < seg.length && common[i] === seg[i]) i++;
        common = common.slice(0, i);
      }
      if (common.length > 1) root = `${common.join('/')}/`;
    }
  }
  for (const p of aj.paths) {
    p.dirEl.textContent = root && p.dir.startsWith(root) ? `…/${p.dir.slice(root.length)}` : p.dir;
  }
}

// Filter tab counts and the footer « N outils · M erreur(s) », both read from the
// rendered top-level lines (the nested result block is never a line of its own).
function updateCounts() {
  const feed = ajFeed();
  if (!feed) return;
  const lines = [...feed.children].filter((c) => c.classList.contains('aj-line'));
  const tools = lines.filter((l) => l.dataset.kind === 'tool');
  const n = { all: lines.length, text: lines.length - tools.length, tools: tools.length };
  document.querySelectorAll('#agent-journal .aj-filter').forEach((btn) => {
    const c = btn.querySelector('.aj-count');
    if (c) c.textContent = String(n[btn.dataset.filter] ?? 0);
  });
  const foot = document.getElementById('aj-foot-count');
  if (!foot) return;
  const errs = tools.filter((l) => l.dataset.status === 'err').length;
  foot.textContent = tools.length
    ? `${tools.length} outil${tools.length > 1 ? 's' : ''}${errs ? ` · ${errs} erreur${errs > 1 ? 's' : ''}` : ''}`
    : '';
}

// A line is visible under the active filter: 'all' shows everything, 'text'
// shows assistant text only, 'tools' shows tool rows (+ their nested result
// line — same data-kind) only.
function ajLineVisible(kind) {
  if (aj.filter === 'all') return true;
  if (aj.filter === 'text') return kind === 'text';
  return kind === 'tool';
}

function ajFeed() { return document.getElementById('aj-feed'); }

// ---------------------------------------------------------------------------
// Header — type/status/description/meta. Independent of journal availability
// (C3): the agent's ledger state renders here even when source is null.
// ---------------------------------------------------------------------------

function renderHeaderStatic(agentType, description, sessionTitle) {
  aj.agentType = typeof agentType === 'string' && agentType ? agentType : null;
  aj.sessionTitle = typeof sessionTitle === 'string' ? sessionTitle : '';
  document.getElementById('aj-type').textContent = aj.agentType || '';
  document.getElementById('aj-desc').textContent = typeof description === 'string' ? description : '';
  document.getElementById('aj-meta').textContent = aj.sessionTitle ? `Session ${aj.sessionTitle}` : '';
}

function renderHeaderFromAgent(agent) {
  const el = document.getElementById('agent-journal');
  const type = (agent && typeof agent.agentType === 'string' && agent.agentType) || aj.agentType || '';
  if (type) {
    aj.agentType = type;
    document.getElementById('aj-type').textContent = type;
  }
  el.setAttribute('aria-label', type ? `Journal de l'agent ${type}` : "Journal de l'agent");
  const statusEl = document.getElementById('aj-status');
  const elapsedEl = document.getElementById('aj-elapsed');
  // The pearl, the state word and the footer dot read these two attributes (style.css).
  const known = !!agent && Object.prototype.hasOwnProperty.call(AJ_STATE_LABEL, agent.state);
  if (known) el.dataset.state = agent.state; else delete el.dataset.state;
  el.dataset.live = String(!!agent && (agent.state === 'running' || agent.state === 'waiting'));
  if (!agent) { statusEl.textContent = ''; elapsedEl.textContent = ''; return; }
  // A state with no label (unknown) renders neither a status nor a clock.
  const label = known ? AJ_STATE_LABEL[agent.state] : '';
  statusEl.textContent = label;
  elapsedEl.textContent = !label || agent.state === 'blocked' || agent.state === 'closed'
    ? '' : ajElapsed(agent.startTs, agent.endTs);
  if (aj.sessionTitle && agent.startTs) {
    document.getElementById('aj-meta').textContent =
      `Session ${aj.sessionTitle} · lancé à ${ajFmtTime(agent.startTs)}`;
  }
  ajApplyPathRoot(); // the ledger may now carry the agent's cwd
}

function resetFilterUi() {
  document.querySelectorAll('#agent-journal .aj-filter').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === 'all'));
  });
  const footLabel = document.getElementById('aj-foot-label');
  if (footLabel) footLabel.textContent = 'En direct';
}

// ---------------------------------------------------------------------------
// Feed — states: normal feed, « Journal indisponible » (C3), « Début du
// journal tronqué » (D7, over READ_CAP_BYTES/MAX_EVENTS).
// ---------------------------------------------------------------------------

function showUnavailable() {
  const feed = ajFeed();
  feed.textContent = '';
  aj.toolRows.clear();
  aj.paths = [];
  const note = document.createElement('div');
  note.className = 'aj-unavailable';
  note.textContent = 'Journal indisponible';
  feed.appendChild(note);
  updateCounts();
}

function makeTextLine(ev) {
  const p = document.createElement('p');
  p.className = 'aj-line';
  p.dataset.kind = 'text';
  p.textContent = ev.text || ''; // textContent only — untrusted transcript text (rule 2, aj13)
  p.hidden = !ajLineVisible('text');
  return p;
}

// Collapsible tool row (D6/D10): one ruled line (time, name, target, status
// word) whose head toggles a nested result block on click, Enter or Space. The
// result block reuses .aj-line[data-kind="tool"] (same class/kind as the row,
// for visual consistency) but is NOT a direct child of #aj-feed, so
// applyFilter()'s `#aj-feed > .aj-line` walk never counts or toggles it — the
// "Outils" filter counts the tool call as ONE feed item, not two (gate aj4); its
// `hidden` state is owned solely by the head's toggle below. It stays a
// descendant of the FIRST tool-kind line (the row) — that property the probe
// still asserts. Every transcript-derived string goes through textContent (aj13).
function makeToolLine(ev) {
  const row = document.createElement('div');
  row.className = 'aj-line aj-tool';
  row.dataset.kind = 'tool';
  row.dataset.status = 'run';
  row.hidden = !ajLineVisible('tool');

  const head = document.createElement('div');
  head.className = 'aj-tool-head';
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', 'false');
  const time = document.createElement('span');
  time.className = 'aj-tool-time';
  time.textContent = ajFmtClock(ev.ts);
  const name = document.createElement('span');
  name.className = 'aj-tool-name';
  name.textContent = ev.name || '?';
  name.title = ev.name || '?';
  const arg = document.createElement('span');
  arg.className = 'aj-tool-arg';
  const summary = ev.summary || '';
  if (summary) arg.title = summary;
  if (summary && AJ_FILE_TOOLS.has(ev.name)) {
    const cut = summary.lastIndexOf('/') + 1;
    const dirEl = document.createElement('span');
    dirEl.className = 'aj-p-dir';
    dirEl.textContent = summary.slice(0, cut);
    const fileEl = document.createElement('span');
    fileEl.className = 'aj-p-file';
    fileEl.textContent = summary.slice(cut);
    arg.classList.add('aj-path');
    arg.append(dirEl, fileEl);
    aj.paths.push({ dirEl, dir: summary.slice(0, cut) });
  } else {
    arg.textContent = summary;
  }
  const status = document.createElement('span');
  status.className = 'aj-tool-status aj-st-run';
  status.textContent = 'en cours';
  head.append(time, name, arg, status);

  const result = document.createElement('div');
  result.className = 'aj-line aj-tool-result';
  result.dataset.kind = 'tool';
  result.hidden = true; // collapsed by default

  const toggle = () => {
    result.hidden = !result.hidden;
    head.setAttribute('aria-expanded', String(!result.hidden));
    row.classList.toggle('open', !result.hidden);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  row.append(head, result);
  if (ev.id) aj.toolRows.set(ev.id, { row, status, result });
  return row;
}

function applyResult(ev) {
  const entry = ev.toolUseId ? aj.toolRows.get(ev.toolUseId) : null;
  if (!entry) return; // orphan result (head-truncated its tool_use) — silent degrade
  const state = ev.isError ? 'err' : 'ok';
  entry.row.dataset.status = state;
  entry.status.className = `aj-tool-status aj-st-${state}`;
  entry.status.textContent = ev.isError ? 'erreur' : 'ok';
  entry.result.textContent = ev.text || ''; // textContent only — tool result is untrusted (aj13)
}

// D6: sidechain events; D14: thinking not shown; feed kinds are text + tool
// only — 'user' (the sidechain's own opening instruction, redundant with the
// description already in the header), 'thinking', 'compact', 'goal',
// 'modelSet', 'agentDone' etc. are silently dropped from the feed.
function appendEvents(events) {
  if (!aj.open || !Array.isArray(events) || !events.length) return;
  const feed = ajFeed();
  let addedLine = false;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'text') { feed.appendChild(makeTextLine(ev)); addedLine = true; }
    else if (ev.kind === 'tool') { feed.appendChild(makeToolLine(ev)); addedLine = true; }
    else if (ev.kind === 'result') { applyResult(ev); }
  }
  ajApplyPathRoot();
  updateCounts();
  if (addedLine) feed.scrollTop = feed.scrollHeight;
}

function buildFeed(events) {
  const feed = ajFeed();
  feed.textContent = '';
  aj.toolRows.clear();
  aj.paths = [];
  if (aj.truncatedHead) {
    const note = document.createElement('div');
    note.className = 'aj-truncated';
    note.textContent = 'Début du journal tronqué';
    feed.appendChild(note);
  }
  appendEvents(events);
}

function applyFilter(filter) {
  aj.filter = filter;
  document.querySelectorAll('#agent-journal .aj-filter').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter));
  });
  // Top-level feed items only (`#aj-feed > .aj-line`) — the nested
  // .aj-tool-result row is also .aj-line/data-kind=tool but is a descendant
  // of its parent .aj-tool row, not a direct child of the feed; its own
  // expand/collapse control owns its `hidden`, never the filter (gate aj4).
  document.querySelectorAll('#aj-feed > .aj-line').forEach((line) => {
    line.hidden = !ajLineVisible(line.dataset.kind);
  });
}

// ---------------------------------------------------------------------------
// Public API — probe seam names (boot.js Object.assign): openAgentJournal,
// closeAgentJournal, aj.
// ---------------------------------------------------------------------------

// opts = { sessionId, toolUseId, agentType?, description?, sessionTitle? } —
// no per-pane identifier (finding 9). agentType/description/sessionTitle are optional
// display hints from the caller; the agent's ledger state (status, elapsed)
// always comes from the subscribe reply / a later flags push, independent of
// journal availability (C3).
export async function openAgentJournal(opts = {}) {
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId : '';
  const toolUseId = typeof opts.toolUseId === 'string' ? opts.toolUseId : '';
  if (!sessionId || !toolUseId) return;

  // S6b: journal-centric exclusivity (aj11) — the journal closes the other
  // overlay families instead of them tracking it individually.
  overlayState.closeSidePanels?.();
  overlayState.closeRoomPanel?.();
  overlayState.closePluginPanel?.();

  const el = document.getElementById('agent-journal');
  aj.open = true;
  aj.sessionId = sessionId;
  aj.toolUseId = toolUseId;
  aj.journalId = null;
  aj.agent = null;
  aj.filter = 'all';
  aj.truncatedHead = false;
  aj.toolRows = new Map();

  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('open')); // slide-in next frame (git/plans convention)
  renderHeaderStatic(opts.agentType, opts.description, opts.sessionTitle);
  resetFilterUi();
  aj.paths = [];
  delete el.dataset.state;
  el.dataset.live = 'false';
  const feed = ajFeed();
  feed.textContent = '';
  updateCounts();
  const loader = skeleton();
  feed.append(loader);
  // preventScroll (git/plans convention, index.html:40 comment on git-panel.js):
  // the panel is still off-screen (translateX) at focus time.
  feed.focus({ preventScroll: true });

  const res = await window.api.agentJournalSubscribe({ sessionId, toolUseId }).catch(() => null);
  loader.remove(); // before the stale-open return below, so a closed journal keeps no loader
  // Closed, or superseded by a newer open() while this await was in flight.
  if (!aj.open || aj.sessionId !== sessionId || aj.toolUseId !== toolUseId) return;
  aj.journalId = (res && res.ok) ? res.journalId : null;
  aj.agent = res ? res.agent : null;
  renderHeaderFromAgent(aj.agent);
  if (!res || !res.ok || res.source === null) {
    showUnavailable(); // C3: unavailable renders this and nothing else — header still shows agent state
    return;
  }
  aj.truncatedHead = !!res.truncatedHead;
  buildFeed(res.events || []);
}

export function closeAgentJournal() {
  if (!aj.open) return;
  aj.open = false;
  aj.journalId = null;
  window.api.agentJournalUnsubscribe(); // C4: stop the poll, main drops the subscription
  const el = document.getElementById('agent-journal');
  el.classList.remove('open');
  el.dataset.live = 'false';
  setTimeout(() => { if (!aj.open) el.hidden = true; }, 260); // > CSS close slide on --dur-pop (200 ms)
}

// Routed by boot.js from window.api.onAgentJournalAppend — journalId-guarded
// so a late push from a superseded/closed subscription is dropped (C4, aj14).
export function notifyAgentJournalAppend(payload) {
  if (!aj.open || !payload || payload.journalId == null || payload.journalId !== aj.journalId) return;
  appendEvents(payload.events);
}

// Routed by boot.js's existing onSessionFlags listener. Sole job (finding
// 22): re-render the OPEN journal's header status when the ledger flips this
// agent (« En cours » -> « Terminé »/« Bloqué »), gate aj5 half (ii).
export function notifyAgentJournalFlags(payload) {
  if (!aj.open || !payload || payload.sessionId !== aj.sessionId) return;
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const agent = agents.find((a) => a && a.toolUseId === aj.toolUseId);
  if (!agent) {
    // The push no longer carries the open agent: a live state shown before is
    // stale (clear status and clock); a shown terminal state stays.
    const shown = aj.agent && aj.agent.state;
    if (shown === 'running' || shown === 'waiting') {
      aj.agent = { ...aj.agent, state: 'unknown' };
      renderHeaderFromAgent(aj.agent);
    }
    return;
  }
  aj.agent = agent;
  renderHeaderFromAgent(agent);
}

// Delegated listeners — called once from boot.js. Entry points (sidebar row,
// chat dispatch card) live in their own modules (sidebar.js, chat-view.js);
// this only wires what's local to the overlay itself (close/filter/Esc).
export function initAgentJournal() {
  // Chrome the static markup does not carry: the head pearl, a count after each
  // filter tab and the footer's tool/error count (index.html stays as it is).
  const head = document.getElementById('aj-head');
  if (head && !head.querySelector('.aj-pearl')) {
    const pearl = document.createElement('span');
    pearl.className = 'aj-pearl';
    pearl.setAttribute('aria-hidden', 'true');
    head.prepend(pearl);
  }
  document.querySelectorAll('#agent-journal .aj-filter').forEach((btn) => {
    if (btn.querySelector('.aj-count')) return;
    const count = document.createElement('em');
    count.className = 'aj-count';
    count.textContent = '0';
    btn.appendChild(count);
  });
  const foot = document.getElementById('aj-foot');
  if (foot && !document.getElementById('aj-foot-count')) {
    const count = document.createElement('span');
    count.id = 'aj-foot-count';
    count.className = 'aj-foot-count';
    foot.appendChild(count);
  }

  const closeBtn = document.querySelector('#agent-journal .aj-close');
  if (closeBtn) closeBtn.addEventListener('click', closeAgentJournal);

  document.querySelectorAll('#agent-journal .aj-filter').forEach((btn) => {
    btn.addEventListener('click', () => applyFilter(btn.dataset.filter));
  });

  // Esc closes (guarded like plans-panel.js:165 — never steal keys from a
  // focused terminal).
  document.addEventListener('keydown', (e) => {
    if (!aj.open) return;
    if (e.target && e.target.closest && e.target.closest('.pane-term')) return;
    if (e.key === 'Escape') { closeAgentJournal(); e.preventDefault(); }
  });
}
