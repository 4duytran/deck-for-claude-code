// claude-deck — renderer/panes: one xterm + one PTY each.
'use strict';

import { panes, minimized, layoutState, modeState, sessionMeta } from './state.js';
import { XTERM_THEME, MONO_FONT } from './theme.js';
import {
  attachWebglRenderer, scheduleResync, toggleMaximize, minimizePane, selectPane, clearSelection,
} from './layout.js';
import { setMode } from './mode.js';
import { toggleChatView, setChatView, teardownChatView } from './chat-view.js';
import { mountAskHost, onAskHostChange } from './ask-drawer.js';
import { toggleSidePanel } from './side-panel.js';
import { closePanelTerminal } from './terminal-panel.js';
import { wireTermKeys } from './term-keys.js';

let paneSeq = 0;

// Terminal-face ask drawer: .pane-ask is a flex sibling above .pane-term (the chat
// face mounts its own), so the xterm container shrinks and the existing resync
// pipeline refits it. A drawer open/collapse is told to that pipeline explicitly.
function mountPaneAsk(paneId, el) {
  const slot = el.querySelector('.pane-ask');
  const unmount = mountAskHost(paneId, 'terminal', slot);
  let wasOpen = false;
  const unsub = onAskHostChange(paneId, ({ open }) => {
    if (open === wasOpen) return;
    wasOpen = open;
    scheduleResync(paneId);
  });
  const syncFace = () => { slot.hidden = el.classList.contains('chat-mode'); };
  const mo = new MutationObserver(syncFace);
  mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  syncFace();
  return () => { mo.disconnect(); unsub(); unmount(); };
}

// Single-pane policy: at most ONE live pane per session. A second
// `claude --resume <id>` would fork ANOTHER new session id, the two panes
// would fight over the same sidebar row, and closing either one would mark
// the shared row 'closed' while the other still runs. 'exited' panes don't
// count: their PTY is dead, re-clicking is the legit way to relaunch.
export function findLivePane(sessionId) {
  for (const pane of panes.values()) {
    if (pane.sessionId === sessionId && !pane.el.classList.contains('exited')) return pane;
  }
  return null;
}

// Header data (rule 7: unknown stays hidden). Project and branch come from the
// sidebar scan (sessionMeta, keyed by session id); the model chip is written by
// chat-view.js renderModel. Idempotent: call it whenever sessionMeta or a pane's
// sessionId changes.
export function refreshPaneHeaders() {
  for (const pane of panes.values()) {
    const meta = pane.sessionId ? sessionMeta.get(pane.sessionId) : null;
    const project = (meta && meta.project) || '';
    const branch = (meta && meta.branch) || '';
    const projectEl = pane.el.querySelector('.ph-project');
    const branchEl = pane.el.querySelector('.ph-branch');
    const nameEl = pane.el.querySelector('.ph-branch-name');
    if (projectEl) {
      if (projectEl.textContent !== project) projectEl.textContent = project;
      projectEl.hidden = !project;
    }
    if (branchEl && nameEl) {
      if (nameEl.textContent !== branch) nameEl.textContent = branch;
      branchEl.title = branch;
      branchEl.hidden = !branch;
    }
  }
}

// select: false = a programmatic spawn (room worker): the pane runs hidden
// and never steals the single view from the session the user is looking at.
// initialPrompt / model / permissionMode / effort: optional launch options of a NEW session, forwarded
// untouched — main validates them and ignores them on a resume.
export async function openPane({
  cwd, resumeId, title, newName, select = true,
  initialPrompt, model, permissionMode, effort,
} = {}) {
  // Panes live in Code mode: opening one while the grid is hidden (AI mode)
  // must land on a VISIBLE grid — no-op when already in Code mode.
  // v27: also cover a fade-out in flight (switching, mode still 'code') —
  // setMode queues 'code', the pending AI commit cancels (probe t5 path)
  // and the grid fades back in WITH the new pane, never hidden behind it.
  if (modeState.mode !== 'code' || modeState.switching) setMode('code');
  const paneId = `pane-${++paneSeq}`;

  const el = document.createElement('section');
  el.className = 'pane';
  el.innerHTML = `
    <header>
      <span class="ph-project" hidden></span>
      <span class="pane-title"></span>
      <span class="ph-branch" hidden><svg width="12" height="12" aria-hidden="true"><use href="#lc-git-branch"/></svg><span class="ph-branch-name"></span></span>
      <span class="ph-model" hidden></span>
      <span class="ph-spacer"></span>
      <span class="ph-ctx"></span>
      <span class="pane-actions">
        <button class="pane-view" title="Basculer chat ↔ terminal">
          <span class="pv-label">Terminal mode ON</span>
          <span class="pv-seg" data-face="terminal">Terminal</span>
          <span class="pv-seg" data-face="chat">Chat</span>
        </button>
        <button class="ph-files" title="Fichiers" aria-label="Fichiers"><svg width="14" height="14" aria-hidden="true"><use href="#lc-file-text"/></svg></button>
        <button class="ph-git" title="Git" aria-label="Git"><svg width="14" height="14" aria-hidden="true"><use href="#lc-git-branch"/></svg></button>
        <button class="ph-plans" title="Plans" aria-label="Plans"><svg width="14" height="14" aria-hidden="true"><use href="#lc-layers"/></svg></button>
        <button class="ph-terminal" title="Terminal" aria-label="Terminal"><svg width="14" height="14" aria-hidden="true"><use href="#lc-terminal"/></svg></button>
        <button class="pane-min" title="Minimize">–</button>
        <button class="pane-max" title="Maximize">▢</button>
        <button class="pane-close" title="Close">&#10005;</button>
      </span>
    </header>
    <div class="pane-ask"></div>
    <div class="pane-term"></div>
    <div class="pane-chat"></div>`;
  el.querySelector('.pane-title').textContent = title || 'claude';
  document.getElementById('grid').appendChild(el);
  // Single view: swap the shown pane NOW so the first fit() below measures a real
  // cell (the full selection, recent list and focus follow in selectPane).
  if (select) {
    for (const p of panes.values()) p.el.classList.remove('selected');
    el.classList.add('selected');
  }

  const term = new Terminal({
    fontSize: 13,
    fontFamily: MONO_FONT, // JetBrains Mono first — unchanged
    lineHeight: 1.25, // comfortable reading rhythm (visual only)
    cursorBlink: true,
    theme: XTERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.pane-term'));
  // v34: WebGL after open (the addon needs the DOM); falls back to DOM.
  const renderer = attachWebglRenderer(paneId, term);
  fit.fit();

  // Keyboard -> PTY.
  term.onData((data) => window.api.writeInput(paneId, data));

  // Smart Ctrl+C / Ctrl+V and copy-on-select to PRIMARY: one wiring shared with the side panel's terminal (term-keys.js).
  // The isAlive guard covers a pane closed before the async paste or the debounce fires (closePane deletes sync).
  wireTermKeys(term, { isAlive: () => panes.has(paneId), writeRaw: (data) => window.api.writeInput(paneId, data) });
  // Pane size -> PTY size. Grid reflows (pane open/close, 1-col -> 2x2,
  // app window resize) fire bursts of RO callbacks — v34: every one funnels
  // into the central resync pipeline (guard + fit + pty.resize + refresh,
  // debounced per pane).
  const ro = new ResizeObserver(() => scheduleResync(paneId));
  ro.observe(el.querySelector('.pane-term'));

  el.querySelector('.pane-close').addEventListener('click', () => closePane(paneId));
  el.querySelector('.pane-min').addEventListener('click', () => minimizePane(paneId));
  el.querySelector('.pane-max').addEventListener('click', () => toggleMaximize(paneId));
  // v42 chat view toggle — disabled until the pane has a session identity
  // (a brand-new unnamed session has no transcript to follow yet).
  const viewBtn = el.querySelector('.pane-view');
  // Terminal | Chat segments: a click on the face already shown is a no-op; the
  // button itself (keyboard, probes calling .click()) still flips the face.
  viewBtn.addEventListener('click', (e) => {
    const seg = e.target.closest('.pv-seg');
    if (seg && (seg.dataset.face === 'chat') === el.classList.contains('chat-mode')) return;
    toggleChatView(paneId);
  });
  if (!resumeId) viewBtn.disabled = true;
  // Side panel toggles: the target is read at click time (the session id of a
  // new pane lands after open) from this pane, never from the selection.
  for (const [cls, tab] of [['.ph-files', 'files'], ['.ph-git', 'git'], ['.ph-plans', 'plans'], ['.ph-terminal', 'terminal']]) {
    el.querySelector(cls).addEventListener('click', () => {
      const p = panes.get(paneId);
      toggleSidePanel(tab, { sessionId: p ? p.sessionId : null, paneId });
    });
  }
  // A 'new' session has no sidebar row mapped to this pane (the deck never
  // learns its id) — minimized, it would be unreachable forever. Hide the
  // minimize control for those; maximize/close still work.
  if (!resumeId) el.querySelector('.pane-min').style.display = 'none';
  panes.set(paneId, {
    paneId, term, fit, el, ro,
    gl: renderer.gl,                   // v34: live WebGL addon (null on DOM)
    rendererMode: renderer.rendererMode, // 'webgl' | 'dom' (fallback target)
    resyncTimer: 0,                    // v34: per-pane resync debounce handle
    sessionId: resumeId || null, // single-pane policy key (null = new session)
    askOff: mountPaneAsk(paneId, el),  // unmounts the terminal-face ask drawer
  });
  refreshPaneHeaders(); // a resumed session already has its scan data
  // v46.9: chat is the DEFAULT face for every session with an identity —
  // the terminal stays one switch away. New sessions join below, the moment
  // their deck-fixed id lands (v46.5 spawn contract).
  if (resumeId) setChatView(paneId, true);
  if (select) selectPane(paneId);

  const openOpts = {
    paneId, cwd, resumeId, newName, cols: term.cols, rows: term.rows,
  };
  // Only the fields that were passed: a spawn without them keeps today's payload exactly.
  const launchOpts = { initialPrompt, model, permissionMode, effort };
  for (const k of Object.keys(launchOpts)) if (launchOpts[k] !== undefined) openOpts[k] = launchOpts[k];
  const res = await window.api.openTerminal(openOpts);
  if (!res.ok) {
    term.write(`\x1b[31mFailed to start claude: ${res.error}\x1b[0m\r\n`);
    el.classList.add('exited');
  } else if (res.sessionId) {
    // v28 named spawn: main fixed the session id (--session-id) — adopt it so
    // the single-pane policy and the sidebar row mapping cover this pane too.
    const p = panes.get(paneId);
    if (p) {
      p.sessionId = res.sessionId;
      refreshPaneHeaders();
      // identity acquired -> the chat view becomes available (v42) and is
      // the default face (v46.9) — « En attente du premier message… »
      // until the transcript is born (v46.5).
      const vb = p.el.querySelector('.pane-view');
      if (vb) vb.disabled = false;
      // identity acquired -> this pane now has a sidebar row to restore it from
      // (the v28 comment above), so the minimize control — hidden at creation
      // for id-less 'new' sessions (would be unreachable minimized) — is now
      // safe to reveal. Mirror the view-toggle re-enable.
      const mb = p.el.querySelector('.pane-min');
      if (mb) mb.style.display = '';
      setChatView(paneId, true);
    }
  }
  if (select) term.focus();
}

export function closePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  // Layout-state hygiene BEFORE the (unchanged) kill/dispose flow: closing
  // the zoomed pane must not leave every other pane hidden behind .zoomed.
  if (layoutState.maximizedPaneId === paneId) toggleMaximize(paneId);
  minimized.delete(paneId);
  const wasSelected = layoutState.selectedPaneId === paneId;
  layoutState.recent = layoutState.recent.filter((id) => id !== paneId);
  window.api.kill(paneId);
  closePanelTerminal(paneId); // the pane's panel shell ends with it, on every path that closes a pane
  teardownChatView(pane); // v42: drop the main-side transcript watcher/poll
  pane.askOff();
  pane.ro.disconnect();
  clearTimeout(pane.resyncTimer); // a scheduled resync must never hit a disposed term
  pane.term.dispose(); // disposes loaded addons too (fit + webgl)
  pane.el.remove();
  panes.delete(paneId);
  // The shown session closed: fall back to the most recently shown one that is
  // still open, else the empty state (never a blank workspace with live sessions).
  if (wasSelected) {
    const next = layoutState.recent.filter((id) => panes.has(id)).pop();
    if (next) selectPane(next); else clearSelection();
  }
}
