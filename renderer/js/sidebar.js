// claude-deck — renderer/sidebar: past sessions grouped by project cwd, with
// live status badges, presence icons (v41), per-row actions (copy id/rename/
// delete) and the v33 structural render cache.
'use strict';

import { panes, layoutState, lastFlags, newSessionState, sessionMeta, overlayState } from './state.js';
import { STATUS_META } from './theme.js';
import { openPane, findLivePane, refreshPaneHeaders } from './panes.js';
import { selectPane } from './layout.js';
import { openAgentJournal } from './agent-journal.js';
import { agentModelLabel } from './model-label.js';
import { fadeIn, spinWhile } from './motion.js';
import { skeleton, progressBar } from './loading.js';

// A5: French short age — « maint. », « N min », « N h », « N j », then the date.
function relativeDate(ms) {
  if (!Number.isFinite(ms)) return ''; // rule 7: no timestamp -> nothing, never a date guess
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'maint.';
  if (diffMin < 60) return `${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} j`;
  return new Date(ms).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Per-session actions — one shared HTML dropdown (right-click or ⋮), styled
// with the deck palette (no native Electron menu).
// ---------------------------------------------------------------------------

let ctxMenuEl = null;

export function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}

export function openCtxMenu(x, y, row) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button class="ctx-item" data-action="copyid" role="menuitem">Copier l'ID de session</button>
    <button class="ctx-item" data-action="rename" role="menuitem">Renommer</button>
    <button class="ctx-item ctx-danger" data-action="delete" role="menuitem">Supprimer</button>`;
  document.body.appendChild(menu);
  // Keep the dropdown inside the viewport.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  ctxMenuEl = menu;

  menu.addEventListener('click', (e) => {
    const action = e.target && e.target.dataset ? e.target.dataset.action : null;
    closeCtxMenu();
    if (action === 'rename') startInlineRename(row);
    if (action === 'delete') deleteSessionFlow(row);
    if (action === 'copyid' && row.dataset.sessionId) window.api.clipboardWrite(row.dataset.sessionId);
  });
}

// Transient inline error on a row (e.g. busy-guard refusal), auto-restored.
// v49: target .meta-text (not .meta) — the presence icons now live inside
// .meta as a sibling of .meta-text, so a swap on .meta would wipe them.
// v49.1: preserve the actual child NODES, not textContent. .meta-text holds
// the .meta-repo span + the branch·date span; assigning textContent would
// DESTROY .meta-repo for good (setSessionIcons later reads it — a one-way
// loss until a full rebuild). We stash the live nodes and re-insert them on
// restore, so the repo segment + structure survive the 3s toast intact.
export function showRowError(row, message) {
  const meta = row.querySelector('.meta-text');
  if (!meta) return;
  if (!meta._restore) meta._restore = [...meta.childNodes]; // first call only
  meta.replaceChildren(document.createTextNode(message));
  meta.classList.add('meta-error');
  clearTimeout(Number(meta.dataset.timer || 0));
  meta.dataset.timer = String(setTimeout(() => {
    if (meta._restore) { meta.replaceChildren(...meta._restore); delete meta._restore; }
    meta.classList.remove('meta-error');
  }, 3000));
}

// Rename: swap the summary for an inline input (Enter = commit, Escape = cancel).
export function startInlineRename(row) {
  const summary = row.querySelector('.summary');
  if (!summary || row.querySelector('.summary-edit')) return;
  const oldName = summary.textContent;
  const input = document.createElement('input');
  input.className = 'summary-edit';
  input.value = oldName;
  input.maxLength = 200;
  summary.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commitValue) => {
    if (done) return;
    done = true;
    const restored = document.createElement('span');
    restored.className = 'summary';
    restored.textContent = commitValue || oldName;
    input.replaceWith(restored);
    return restored;
  };

  input.addEventListener('keydown', async (e) => {
    e.stopPropagation(); // keep row click/shortcuts out of the editor
    if (e.key === 'Escape') { finish(null); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name || name === oldName) { finish(null); return; }
    try {
      const res = await window.api.renameSession(row.dataset.sessionId, name);
      if (res && res.ok) {
        const el = finish(res.name);
        if (el) row.dataset.initials = initialsOf(el.textContent);
        // v32: busy session -> the rename is DEFERRED (injected at close);
        // show it italic right away so the display never lies about disk.
        if (res.pending && el) {
          el.classList.add('pending-rename');
          el.title = 'Renommage en attente — appliqué à la fermeture de la session';
        }
      } else {
        finish(null);
        showRowError(row, (res && res.error) || 'rename failed');
      }
    } catch (_) {
      finish(null);
      showRowError(row, 'rename failed');
    }
  });
  input.addEventListener('blur', () => finish(null));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Delete: themed confirmation modal -> trash move -> row removed immediately.
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true">
        <p class="modal-msg"></p>
        <p class="modal-hint">Déplacée vers ~/.claude/deck-trash — récupérable.</p>
        <div class="modal-actions">
          <button class="modal-cancel">Annuler</button>
          <button class="modal-confirm">Supprimer</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-msg').textContent = message;
    // Capture + stopImmediatePropagation: the modal owns Escape, the side panel and its tab handlers never see it.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(false); } };
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-cancel').focus();
  });
}

// B7: session search + status chips. The state is in memory only (rule 3); the
// filter only toggles `hidden` on rows / groups, it never touches session data.
const FILTER_CHIPS = {
  all: null,
  open: new Set(Object.keys(STATUS_META).filter((s) => s !== 'closed')),
  busy: new Set(['working', 'running', 'compacting']),
  mine: new Set(['idle', 'waiting']),
};
const filterState = { query: '', chip: 'all', ws: new Set() }; // ws = checked group cwds, empty = all

// B21: workspace multi-select — a button + a checkbox popover (menuitemcheckbox items).
const WS_ALL = 'Tous les workspaces';
let wsGroups = []; // { cwd, project } of the last full render, in list order

const wsItems = () => [...document.querySelectorAll('#session-ws-pop [role="menuitemcheckbox"]')];

// The pill shows only a count (icon + count + chevron); the long label (« Tous les workspaces », the one
// checked name, « N workspaces ») is its accessible name and tooltip. Checked marks follow filterState.ws;
// no item is rebuilt, so a focused item stays focused.
function paintWorkspaceFilter() {
  const btn = document.getElementById('session-ws-filter');
  if (!btn) return;
  const n = filterState.ws.size;
  const one = n === 1 ? wsGroups.find((g) => filterState.ws.has(g.cwd)) : null;
  const label = n === 0 ? WS_ALL : (one ? one.project : `${n} workspaces`);
  const name = `Filtrer par workspace : ${label}`;
  btn.setAttribute('aria-label', name);
  btn.title = name;
  const count = btn.querySelector('.ws-count');
  if (count) count.textContent = n > 0 ? String(n) : '';
  btn.classList.toggle('is-filtered', n > 0);
  for (const it of wsItems()) {
    it.setAttribute('aria-checked', String(it.dataset.cwd ? filterState.ws.has(it.dataset.cwd) : n === 0));
  }
}

// The items are rebuilt from the freshly listed groups after each full render; a cwd that vanished
// leaves the set (an emptied set means « Tous »); an open popover keeps its focused item.
function syncWorkspaceFilter(groups) {
  const pop = document.getElementById('session-ws-pop');
  if (!pop) return;
  wsGroups = groups.map((g) => ({ cwd: g.cwd, project: g.project }));
  for (const cwd of [...filterState.ws]) if (!wsGroups.some((g) => g.cwd === cwd)) filterState.ws.delete(cwd);
  const focusedCwd = pop.contains(document.activeElement) ? document.activeElement.dataset.cwd : null;
  const mk = (label, cwd) => {
    const it = document.createElement('button');
    it.type = 'button';
    it.setAttribute('role', 'menuitemcheckbox');
    it.className = 'ws-item';
    it.tabIndex = -1;
    it.dataset.cwd = cwd; // '' = « Tous »
    it.textContent = label;
    if (cwd) it.title = cwd;
    return it;
  };
  pop.replaceChildren(mk(WS_ALL, ''), ...wsGroups.map((g) => mk(g.project, g.cwd)));
  paintWorkspaceFilter();
  if (focusedCwd !== null) (wsItems().find((i) => i.dataset.cwd === focusedCwd) || wsItems()[0]).focus();
}

function setWorkspaceOpen(open, { focus = false, restoreFocus = false } = {}) {
  const btn = document.getElementById('session-ws-filter');
  const pop = document.getElementById('session-ws-pop');
  if (!btn || !pop) return;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open && focus) wsItems()[0].focus();
  if (!open && restoreFocus) btn.focus();
}

// « Tous » ('') clears the set; a group item flips its cwd; an emptied set reads as « Tous ».
function toggleWorkspace(cwd) {
  if (!cwd) filterState.ws.clear();
  else if (!filterState.ws.delete(cwd)) filterState.ws.add(cwd);
  paintWorkspaceFilter();
  applySessionFilter();
}

function initWorkspaceFilter() {
  const wrap = document.getElementById('session-ws');
  const btn = document.getElementById('session-ws-filter');
  const pop = document.getElementById('session-ws-pop');
  if (!wrap || !btn || !pop) return;
  const isOpen = () => !pop.hidden;
  const is = (e, name, code) => e.key === name || e.code === (code || name);
  btn.addEventListener('click', () => setWorkspaceOpen(!isOpen()));
  btn.addEventListener('keydown', (e) => {
    if (!is(e, 'Enter') && !is(e, ' ', 'Space') && !is(e, 'ArrowDown')) return;
    e.preventDefault();
    setWorkspaceOpen(true, { focus: true });
  });
  pop.addEventListener('click', (e) => {
    const it = e.target.closest('[role="menuitemcheckbox"]');
    if (it) toggleWorkspace(it.dataset.cwd);
  });
  pop.addEventListener('keydown', (e) => {
    const items = wsItems();
    const at = items.indexOf(document.activeElement);
    if (is(e, 'ArrowDown') || is(e, 'ArrowUp')) {
      e.preventDefault();
      items[(at + (is(e, 'ArrowDown') ? 1 : -1) + items.length) % items.length].focus();
    } else if (is(e, 'Enter') || is(e, ' ', 'Space')) {
      e.preventDefault();
      if (at >= 0) toggleWorkspace(items[at].dataset.cwd);
    }
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation(); // this Esc only closes the popover: the search query and the panels keep their state
    setWorkspaceOpen(false, { restoreFocus: true });
  });
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !wrap.contains(e.relatedTarget)) setWorkspaceOpen(false); // Tab or a click moved the focus away
  });
  document.addEventListener('click', (e) => {
    if (!isOpen() || wrap.contains(e.target)) return;
    const ae = document.activeElement;
    const focusElsewhere = !!ae && ae !== document.body && !pop.contains(ae); // do not steal a field's focus
    setWorkspaceOpen(false, { restoreFocus: !focusElsewhere });
  });
}

// NFD + strip combining marks + lowercase: « resume » finds « Résumé ».
function foldText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function applySessionFilter() {
  const needle = foldText(filterState.query.trim());
  const statuses = FILTER_CHIPS[filterState.chip] || null;
  let rowTotal = 0;
  let shownTotal = 0;
  for (const group of document.querySelectorAll('#session-list .project-group')) {
    const project = foldText((group.querySelector('.pg-name') || {}).textContent);
    const wsOk = !filterState.ws.size || filterState.ws.has(group.dataset.cwd);
    let shown = 0;
    for (const row of group.querySelectorAll('.session-row')) {
      const sid = row.dataset.sessionId;
      const branch = (sessionMeta.get(sid) || {}).branch;
      const title = (row.querySelector('.summary') || {}).textContent;
      const textOk = !needle || [title, project, branch, sid].some((f) => foldText(f).includes(needle));
      const statusOk = !statuses || statuses.has(row.dataset.status);
      // A row under inline rename stays: hiding it would orphan the user's input.
      const show = (wsOk && textOk && statusOk) || !!row.querySelector('.summary-edit');
      row.hidden = !show;
      rowTotal++;
      if (show) shown++;
    }
    group.hidden = shown === 0;
    const countEl = group.querySelector('.pg-count');
    if (countEl) countEl.textContent = String(shown);
    shownTotal += shown;
  }
  const empty = document.getElementById('session-filter-empty');
  if (empty) empty.hidden = !(rowTotal > 0 && shownTotal === 0);
}

function setFilterChip(chip) {
  filterState.chip = chip;
  for (const b of document.querySelectorAll('#session-filters [data-filter]')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === chip));
  }
  applySessionFilter();
}

function initSessionFilter() {
  const input = document.getElementById('session-search-input');
  if (input) {
    input.addEventListener('input', () => { filterState.query = input.value; applySessionFilter(); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !input.value) return;
      e.preventDefault();
      e.stopPropagation(); // this Esc only clears the field, no panel closes with it
      input.value = '';
      filterState.query = '';
      applySessionFilter();
    });
    // #session-search is a div, not a label (a label would hand a click inside the workspace popover to the input): a left press
    // on the magnifier or the field padding focuses the input; the workspace pill and its popover keep their own clicks.
    const field = document.getElementById('session-search');
    if (field) {
      field.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target === input || e.target.closest('#session-ws')) return;
        e.preventDefault(); // no blur / selection start on the field's own chrome
        input.focus();
      });
    }
  }
  initWorkspaceFilter();
  const chips = document.getElementById('session-filters');
  if (chips) {
    chips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (btn) setFilterChip(btn.dataset.filter);
    });
  }
}

// Header pill (A6): « N sessions, M attend », read live from the rendered
// rows (no IO, rule 3). Called after every DOM change that adds, removes or
// re-statuses a row, including the empty-list and error paths — which is why
// it also re-applies the B7 filter (the one choke point of all those changes).
// Only « M attend » is coloured, and only while M > 0 (a state): the span `.wait-t`.
// header-tools.js reads the pill's textContent for its short « N · M » form.
function updateSessionPill() {
  applySessionFilter();
  const pill = document.getElementById('session-pill');
  if (!pill) return;
  const rows = document.querySelectorAll('#session-list .session-row');
  const waiting = document.querySelectorAll('#session-list .session-row[data-status="waiting"]').length;
  const count = document.createElement('b');
  count.textContent = String(rows.length);
  const tail = ` session${rows.length > 1 ? 's' : ''}, `;
  if (waiting > 0) {
    const wait = document.createElement('span');
    wait.className = 'wait-t';
    wait.textContent = `${waiting} attend`;
    pill.replaceChildren(count, tail, wait);
  } else {
    pill.replaceChildren(count, `${tail}${waiting} attend`);
  }
}

async function deleteSessionFlow(row) {
  const name = (row.querySelector('.summary') || {}).textContent || row.dataset.sessionId;
  const yes = await confirmDialog(`Supprimer « ${name} » ?`);
  if (!yes) return;
  try {
    const res = await window.api.deleteSession(row.dataset.sessionId);
    if (res && res.ok) {
      const group = row.closest('.project-group');
      row.remove();
      if (group && !group.querySelector('.session-row')) group.remove();
      // v48 + B7: the heading's count chip shows the VISIBLE rows and is written
      // by the filter pass (updateSessionPill), so this in-place removal keeps it in sync.
      updateSessionPill();
    } else {
      showRowError(row, (res && res.error) || 'delete failed');
    }
  } catch (_) {
    showRowError(row, 'delete failed');
  }
}

// v41: presence icons — shape carries the meaning (branch glyph = files
// modified, document glyph = plan created), never colour alone. Static
// markup only (no dynamic data) -> innerHTML is safe here.
const SICON_SVG = {
  git: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="1.8"/><circle cx="12" cy="4" r="1.8"/><circle cx="4" cy="12" r="1.8"/><path d="M4 5.8v4.4M12 5.8V7a2 2 0 0 1-2 2H6"/></svg>',
  plan: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5h-5a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V4z"/><path d="M9.5 1.5V4H12M6 7.5h4M6 10.5h4"/></svg>',
};
const SICON_TIP = {
  git: 'fichiers modifiés par cette session',
  plan: 'plan créé par cette session',
};
// flags: { git, plans, repo, repoCount } | null (indeterminate -> NOTHING,
// never a false positive). The .session-icons slot itself always stays in
// the DOM — fixed height in CSS, so cards never jump when an icon
// appears/disappears. Also feeds the meta line's repo segment (v41.1):
// same activity truth, same two delivery paths (inline or push).
function setSessionIcons(row, flags) {
  const slot = row.querySelector('.session-icons');
  if (!slot) return;
  slot.textContent = '';
  if (flags) {
    for (const kind of ['git', 'plan']) { // fixed order: git then plan
      if (kind === 'git' ? !flags.git : !flags.plans) continue;
      const i = document.createElement('span');
      i.className = 'sicon';
      i.dataset.kind = kind;
      i.title = SICON_TIP[kind];
      i.innerHTML = SICON_SVG[kind];
      slot.appendChild(i);
    }
  }
  // v41.1: " · <top repo> +N" after the status word — what the session worked ON.
  const seg = row.querySelector('.meta-repo');
  if (seg) {
    if (flags && flags.repo) {
      const extra = flags.repoCount > 1 ? ` +${flags.repoCount - 1}` : '';
      seg.textContent = ` · ${flags.repo}${extra}`;
      seg.title = 'repo le plus touché par cette session';
    } else {
      seg.textContent = '';
      seg.title = '';
    }
  }
}

// ---------------------------------------------------------------------------
// v?? S5: sidebar "running agents" list per session — filled in place from
// s.flags.agents (cache hit) and from the 'session-flags' push (cache miss,
// arrives later), same out-of-band delivery as the v41 presence icons
// (structKey at :286-289 stays untouched — agents never enter the structural
// fingerprint). D11: folded by default, expanded state kept per session in
// this module-level Map so it survives a full (non-auto) renderSessions()
// rebuild, which the DOM itself cannot.
// ---------------------------------------------------------------------------
const agentsExpanded = new Map(); // sessionId -> boolean (default: folded)
const AGENT_STATE_ARIA = { running: 'en cours', waiting: 'en attente', done: 'terminé', blocked: 'bloqué', closed: 'interrompu' };
// Static markup only (no dynamic data) -> innerHTML is safe here, same rule
// as SICON_SVG (:198-201).
const SA_CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';

// D12: live agents lead the headline, then blocked, else the all-finished
// summary — a blocked-only list must never read "terminés".
function agentsHeaderText(total, running, blocked, waiting = 0) {
  const agentWord = total === 1 ? 'agent' : 'agents';
  if (running > 0 && waiting > 0) return `${total} ${agentWord} · ${running} en cours · ${waiting} en attente`;
  if (running > 0) return `${total} ${agentWord} · ${running} en cours`;
  if (waiting > 0) return `${total} ${agentWord} · ${waiting} en attente`;
  if (blocked > 0) return `${total} ${agentWord} · ${blocked} bloqué${blocked > 1 ? 's' : ''}`;
  return `${total} ${agentWord} terminé${total > 1 ? 's' : ''}`;
}

// Fills the row's ALWAYS-in-DOM `.session-agents` container in place —
// same rule-8 pattern as setSessionIcons (`:211`): empty -> hidden, never a
// false-positive toggle (rule 7). `agents` is s.flags.agents (cache hit) or
// the 'session-flags' push payload's `agents` field (cache miss, then live).
function setSessionAgents(row, agents) {
  const wrap = row.querySelector('.session-agents');
  if (!wrap) return;
  const all = Array.isArray(agents) ? agents : [];
  // D1 (user report, 2026-09-18): a done/blocked agent must never draw a row,
  // even one dispatched in the current turn — only 'running' survives here.
  // Filtering in the RENDERER (not upstream) leaves agent-journal.js's own
  // 'session-flags' consumer and the raw agent-journal-subscribe IPC reading
  // the unfiltered set, both out of scope for this fix.
  // Lifecycle: only 'running' and 'waiting' draw a row; unknown, closed and any
  // other value render nothing (main already drops 'unknown' from the payload).
  const list = all.filter((a) => a && (a.state === 'running' || a.state === 'waiting'));
  const runningN = list.filter((a) => a.state === 'running').length;
  const waitingN = list.length - runningN;
  // Only the running count feeds the « N agents en cours » status word (A4).
  if (runningN) row.dataset.agents = String(runningN); else delete row.dataset.agents;
  syncStatusLabel(row);
  wrap.textContent = '';
  if (!list.length) { wrap.hidden = true; return; } // D1: no running agent -> no toggle, no list
  wrap.hidden = false;

  const sessionId = row.dataset.sessionId;
  const title = (row.querySelector('.summary') || {}).textContent || '';
  const blocked = 0;
  const expanded = agentsExpanded.get(sessionId) === true; // D11: folded by default

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'agents-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? 'Masquer' : 'Afficher'} les agents de ${title}`);
  const chevron = document.createElement('span');
  chevron.className = 'sa-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = SA_CHEVRON_SVG;
  const headerText = document.createElement('span');
  headerText.className = 'sa-header-text';
  headerText.textContent = agentsHeaderText(list.length, runningN, blocked, waitingN);
  toggle.append(chevron, headerText);

  const ul = document.createElement('ul');
  ul.className = 'agents-list';
  ul.hidden = !expanded;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation(); // A1: the container sits inside the session row (sa15) — same rule as :375-379
    const next = !(agentsExpanded.get(sessionId) === true);
    agentsExpanded.set(sessionId, next);
    ul.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    toggle.setAttribute('aria-label', `${next ? 'Masquer' : 'Afficher'} les agents de ${title}`);
  });

  for (const a of list) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-row';
    btn.dataset.state = a.state;
    btn.dataset.toolUseId = a.toolUseId;
    // A1 (sa15): isolate from the row's own resume click, then open the
    // read-only agent journal overlay for this agent.
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAgentJournal({
        sessionId, toolUseId: a.toolUseId, agentType: a.agentType,
        description: a.description, sessionTitle: title,
      });
    });

    const dot = document.createElement('span');
    dot.className = 'agent-dot';
    dot.setAttribute('aria-hidden', 'true');

    const type = document.createElement('span');
    type.className = 'sa-type';
    type.textContent = a.agentType;

    // D2 (user report, 2026-09-18): row carries only the agent name + its
    // status — description (unbounded free text) and the elapsed counter are
    // dropped. Status text reuses AGENT_STATE_ARIA (already short: 'en
    // cours'/'terminé'/'bloqué'); with D1's filter above every row reaching
    // this loop is 'running', so it always reads 'en cours' today, but the
    // element stays state-driven rather than hardcoded.
    const status = document.createElement('span');
    status.className = 'sa-status';
    status.textContent = AGENT_STATE_ARIA[a.state] || a.state;

    // Sub-agent model (full id or requested alias) sits right after the name.
    // Unknown / null / absent (older main) renders nothing — rule 7.
    const modelLabel = agentModelLabel(a.model);
    if (modelLabel) {
      const model = document.createElement('span');
      model.className = 'sa-model';
      model.textContent = modelLabel;
      btn.append(dot, type, model, status);
    } else {
      btn.append(dot, type, status);
    }
    // .sa-blocked-word removed, not just left unreachable: D1's filter means
    // a.state is only 'running' or 'waiting' by the time a row is built, so the old
    // `if (a.state === 'blocked')` branch was dead code with no row left to
    // ever apply it to. Description stays off the visible row (D2's "name +
    // status only" is unchanged) but reaches the user two ways, both plain
    // attribute writes — never an HTML sink, so a hostile description can
    // never execute: aria-label (screen-reader context) and `title` (D2
    // amendment, user decision 2026-09-18 — two concurrent same-type agents
    // are otherwise indistinguishable; native hover tooltip, no new
    // plumbing). `description` can be empty (session-activity.js `ev.summary
    // || ''`) — guarded so an empty description never leaves a dangling
    // empty `title` attribute on the row.
    btn.setAttribute('aria-label',
      `${a.agentType} — ${modelLabel ? `${modelLabel} — ` : ''}${a.description} — ${AGENT_STATE_ARIA[a.state] || a.state}`);
    if (a.description) btn.title = a.description;
    else if (a.state === 'waiting') btn.title = 'En attente de ses tâches de fond';

    li.appendChild(btn);
    ul.appendChild(li);
  }

  wrap.append(toggle, ul);
}

// A4: the status word lives in the row subtitle (.status-label, start of
// .meta-text). « running » carries the agent count only once setSessionAgents
// has recorded one (row.dataset.agents); unknown or zero -> the bare word (rule 7).
function syncStatusLabel(row) {
  const label = row.querySelector('.status-label');
  if (!label) return;
  const status = row.dataset.status;
  const meta = Object.prototype.hasOwnProperty.call(STATUS_META, status)
    ? STATUS_META[status] : STATUS_META.closed;
  const n = Number(row.dataset.agents) || 0;
  label.textContent = status === 'running' && n > 0
    ? `${n} ${n === 1 ? 'agent' : 'agents'} en cours`
    : meta.label;
}

function setBadge(row, status) {
  const known = Object.prototype.hasOwnProperty.call(STATUS_META, status);
  const badge = row.querySelector('.status-badge');
  badge.dataset.status = known ? status : 'closed';
  // v48: mirror the status onto the ROW so the card's left accent rail (CSS)
  // can key off it — the rail can't read a descendant's data-status.
  row.dataset.status = badge.dataset.status;
  // The badge is the dot slot only: no glyph, no text (the dot is drawn by CSS).
  const dot = badge.querySelector('.status-emoji');
  dot.textContent = '';
  dot.setAttribute('aria-hidden', 'true');
  syncStatusLabel(row);
}

// L33s: the row of the last-interacted pane's session carries `.is-current`
// (at most one). Only the session id is kept; every render re-applies it and
// drops it once that session has no live pane left (a closed pane never
// changes the structural key, so the class is synced before the auto-skip).
let currentSessionId = null;

function syncCurrentRow() {
  // B1: the current row is the session of the pane the single view shows.
  const shown = panes.get(layoutState.selectedPaneId);
  currentSessionId = shown && shown.sessionId && findLivePane(shown.sessionId) ? shown.sessionId : null;
  for (const r of document.querySelectorAll('.session-row')) {
    r.classList.toggle('is-current', r.dataset.sessionId === currentSessionId);
  }
}

function trackPaneInteraction(e) {
  const paneEl = e.target && e.target.closest && e.target.closest('.pane');
  if (!paneEl) return;
  let sid = null;
  for (const p of panes.values()) {
    if (p.el === paneEl) { sid = p.sessionId; break; }
  }
  if (sid === currentSessionId) return;
  currentSessionId = sid;
  syncCurrentRow();
}

// v33: structural fingerprint of the last rendered list (auto-skip key).
let lastStructKey = null;

export async function renderSessions(opts = {}) {
  const auto = opts.auto === true;
  syncCurrentRow();
  // v33 auto guards: never rebuild under the user's hands — an inline rename
  // input, an open ⋮ menu, or a transient row error toast (3s) reference
  // rows/state the rebuild would orphan or wipe. Skip silently; the next
  // transition (or manual 🔄) retries.
  if (auto && (document.querySelector('.summary-edit')
      || document.getElementById('ctx-menu')
      || document.querySelector('.meta-error'))) {
    return;
  }

  const list = document.getElementById('session-list');
  // First load (no row): placeholder rows. User reload over rows: a strip above
  // the list, rows kept. auto = silent, no flash.
  let loader = null;
  if (!auto) {
    if (list.querySelector('.session-row')) {
      loader = progressBar();
      list.before(loader);
    } else {
      list.textContent = '';
      loader = skeleton();
      list.append(loader);
    }
  }

  let groups = [];
  try {
    groups = await window.api.listSessions();
  } catch (_) {
    if (!auto) {
      list.textContent = 'Impossible de lire les sessions.';
      updateSessionPill(); // the failure text replaced every row
    }
    return;
  } finally {
    loader?.remove();
  }

  // v33 render cache: most transitions (working<->idle of a known session)
  // change NOTHING structural — the badge is already live via the push, so
  // rebuilding the DOM would only cost and steal state. Status and mtime
  // VALUES are excluded on purpose: the sequence itself covers re-sorting,
  // setBadge covers status, ages are re-written in place on a cache hit.
  // LOAD-BEARING INVARIANT: excluding status from the key is only safe while
  // EVERY status writer also pushes 'session-status' (watcher, close marker,
  // resume detect all do) — a silent writer would desync badges forever.
  const structKey = JSON.stringify(groups.map((g) => [g.cwd, g.sessions.map(
    (s) => [s.sessionId, s.summary, s.pendingRename, s.gitBranch])]));
  if (auto && structKey === lastStructKey) {
    // mtime is outside the key: only the age text moves, in place (A5).
    const mtimes = new Map();
    for (const g of groups) for (const s of g.sessions) mtimes.set(s.sessionId, s.mtimeMs);
    for (const r of document.querySelectorAll('#session-list .session-row')) {
      const ageEl = r.querySelector('.session-age');
      const text = relativeDate(mtimes.get(r.dataset.sessionId));
      if (ageEl && ageEl.textContent !== text) ageEl.textContent = text;
    }
    applySessionFilter(); // B7: the cache-hit path re-applies the filter too
    return;
  }
  lastStructKey = structKey;

  closeCtxMenu(); // the menu may point at a row about to be re-rendered
  // Known projects feed the new-session folder menu (v13) — reuse the scan.
  newSessionState.knownProjects = groups.map((g) => ({ project: g.project, cwd: g.cwd }));
  list.textContent = '';
  syncWorkspaceFilter(groups); // before the empty-list return: a gone group resets the choice
  if (!groups.length) {
    list.textContent = 'No sessions found.';
    updateSessionPill();
    return;
  }

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'project-group';
    groupEl.dataset.cwd = group.cwd;

    const heading = document.createElement('h3');
    // v48: project name (ellipsised) + a session-count chip on the right.
    const pgName = document.createElement('span');
    pgName.className = 'pg-name';
    pgName.textContent = group.project;
    const pgCount = document.createElement('span');
    pgCount.className = 'pg-count';
    pgCount.textContent = String(group.sessions.length);
    heading.append(pgName, pgCount);
    heading.title = group.cwd;
    groupEl.appendChild(heading);

    for (const s of group.sessions) {
      // div (not button): the row hosts a nested ⋮ action button + inline input.
      const row = document.createElement('div');
      row.className = 'session-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = s.sessionId;
      row.dataset.sessionId = s.sessionId;
      row.dataset.initials = initialsOf(s.summary);

      const main = document.createElement('span');
      main.className = 'session-main';

      const summary = document.createElement('span');
      summary.className = 'summary';
      summary.textContent = s.summary;
      if (s.pendingRename) {
        // v32 deferred rename: deck-side only until the session closes.
        summary.classList.add('pending-rename');
        summary.title = 'Renommage en attente — appliqué à la fermeture de la session';
      }

      const meta = document.createElement('span');
      meta.className = 'meta';
      // v41.1: repo segment first (activity truth, filled by flags exactly
      // like the icons), then branch · date. The literal 'HEAD' is CC's
      // no-branch fallback (cwd outside a real branch) — pure noise, hidden;
      // a REAL branch name still shows.
      // v49: repo·branch·date live in .meta-text (the ellipsis target); the
      // presence icons ride at the END of the same line (built just below),
      // so the card is 2 lines, not 3.
      // A4/A5: the subtitle reads « word · repo · branch » (the word is the
      // live status, written by setBadge); the age sits in its own .session-age.
      const metaText = document.createElement('span');
      metaText.className = 'meta-text';
      const statusLabel = document.createElement('span');
      statusLabel.className = 'status-label';
      const repoSeg = document.createElement('span');
      repoSeg.className = 'meta-repo';
      const metaTail = document.createElement('span');
      metaTail.className = 'meta-branch';
      const branch = s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null;
      sessionMeta.set(s.sessionId, { branch, project: group.project });
      metaTail.textContent = branch ? ` · ${branch}` : '';
      metaText.append(statusLabel, repoSeg, metaTail);

      // v49: presence icons — moved off the old dedicated bottom strip onto
      // the tail of the meta line (card: 3 lines -> 2). The slot is STILL
      // always in the DOM (setSessionIcons / the 'session-flags' push fill it
      // in place, same as the badge). Empty slot = zero width; the svg is
      // capped under the meta line-height, so the card never jumps when an
      // icon appears/disappears (the v41 stability contract, kept).
      const icons = document.createElement('span');
      icons.className = 'session-icons';

      meta.append(metaText, icons);
      main.append(summary, meta);

      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.innerHTML = '<span class="status-emoji"></span>'; // static markup: the dot slot

      // v?? S5 sidebar agents row — ALWAYS in the DOM, hidden while its
      // session has no dispatched agents (rule-8 precedent .session-icons);
      // filled below by setSessionAgents.
      const agentsWrap = document.createElement('div');
      agentsWrap.className = 'session-agents';

      const age = document.createElement('span');
      age.className = 'session-age';
      age.textContent = relativeDate(s.mtimeMs);

      row.append(badge, main, age, agentsWrap);
      setBadge(row, s.status || 'closed');
      const flagsForRow = s.flags || lastFlags.get(s.sessionId) || null;
      setSessionIcons(row, flagsForRow);
      setSessionAgents(row, (flagsForRow && flagsForRow.agents) || []);

      // Resume MUST run from the session's original cwd (read from its .jsonl).
      row.addEventListener('click', () => {
        if (row.querySelector('.summary-edit')) return; // editing -> no resume
        // A4-6: the focus lands in the pane hidden under the Plugins panel, so the next Escape would reach its chat turn.
        overlayState.closePluginPanel?.();
        const live = findLivePane(s.sessionId);
        if (live) {
          // B1: show that session (replaces the one shown; a minimized pane is
          // un-parked by selectPane). Re-click on the shown one = keyboard back,
          // NO visual effect (v30 user ask: no flash / smooth-scroll blink).
          selectPane(live.paneId);
          return;
        }
        openPane({ // selects the new pane by default
          cwd: group.cwd,
          resumeId: s.sessionId,
          // Pane title = the session's own name (same as the sidebar card),
          // not the project — several resumed panes must stay distinguishable.
          title: s.summary || `${group.project} (resume)`,
        });
      });
      // Right-click is the way to the row menu (Copier l'ID de session, Renommer, Supprimer): no ⋮ button (B20, B22).
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCtxMenu(e.clientX, e.clientY, row);
      });
      groupEl.appendChild(row);
    }
    list.appendChild(groupEl);
  }
  syncCurrentRow();
  updateSessionPill();
  refreshPaneHeaders();
}

// Live status push: update the matching sidebar badge in place.
// v33: a transition may also imply a STRUCTURAL change the badge can't carry
// (a brand-new session's first status, titles injected at close, mtime
// re-ordering) — schedule a debounced silent re-scan on every push. The scan
// is near-free (mtime metaCache + main's statusCache) and the render itself
// is skipped when nothing structural moved (see renderSessions).
let autoRefreshTimer = 0;
export function notifySessionStatus(sessionId, status) {
  const row = document.querySelector(`.session-row[data-session-id="${sessionId}"]`);
  if (status === 'closed') {
    // A closed session has no live agent: drop the cached rows so a later
    // sessions-list row with flags:null cannot redraw them from lastFlags.
    const cached = lastFlags.get(sessionId);
    if (cached) cached.agents = [];
  }
  if (row) {
    if (status === 'closed') setSessionAgents(row, []);
    setBadge(row, status);
    updateSessionPill();
  }
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => renderSessions({ auto: true }), 300);
}

// v41: presence icons land as the background queue completes — same
// in-place pattern as setBadge (the row survives, renders are skipped).
// Excluded from structKey on the SAME invariant as status: every flags
// change reaches the renderer through this push (a sessions-list stamp
// miss always enqueues the compute that emits it).
export function notifySessionFlags(payload) {
  lastFlags.set(payload.sessionId, payload);
  const row = document.querySelector(`.session-row[data-session-id="${payload.sessionId}"]`);
  if (row) {
    setSessionIcons(row, payload);
    setSessionAgents(row, payload.agents || []);
  }
}

// Folded-rail label: first letter of the first two words, else the first two letters.
function initialsOf(title) {
  const words = String(title || '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '…';
  const chars = words.length > 1 ? [words[0], words[1]].map((w) => Array.from(w)[0]) : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

// Top-bar fold button: toggles body.sb-mini (in-memory state), announces deck:sidebar.
function initSidebarFold() {
  const btn = document.getElementById('sidebar-fold');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const mini = document.body.classList.toggle('sb-mini');
    const label = mini ? 'Déplier la barre latérale' : 'Replier la barre latérale';
    btn.setAttribute('aria-expanded', String(!mini));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    window.dispatchEvent(new CustomEvent('deck:sidebar', { detail: { mini } }));
    // The width snaps (side-panel.js reads it at the event); only the content that appears fades in.
    fadeIn(mini ? [document.getElementById('session-list')] : document.querySelectorAll('#sidebar > *'));
  });
}

// Global closers + refresh button — called once from boot.js.
export function initSidebar() {
  initSidebarFold();
  // Global closers: click elsewhere, Escape, sidebar scroll.
  document.addEventListener('click', (e) => {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
  document.getElementById('session-list').addEventListener('scroll', closeCtxMenu);
  document.addEventListener('pointerdown', trackPaneInteraction, true);
  document.addEventListener('focusin', trackPaneInteraction, true);
  document.addEventListener('deck:pane-selected', syncCurrentRow); // layout.js selectPane / clearSelection
  document.getElementById('refresh-sessions')
    .addEventListener('click', (e) => spinWhile(e.currentTarget, renderSessions()));
  initSessionFilter();
}
