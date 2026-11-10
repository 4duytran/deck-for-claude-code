// claude-deck — renderer/state: the shared mutable state of the renderer.
// Data ONLY — no DOM, no imports — so any module can depend on it without
// cycles (same rule as src/main/state.js). Scalars that several modules
// read/write live inside exported container objects (ES module bindings are
// per-module; a bare `export let` could not be reassigned by importers).
'use strict';

// paneId -> { paneId, term, fit, el, ro, gl, rendererMode, resyncTimer,
// sessionId, outputWhileAi } — owned by panes.js (created in openPane).
export const panes = new Map();

// Window management (v18) — LAYOUT STATE ONLY: PTYs and xterm instances stay
// alive through every transition; visibility is pure CSS (display:none).
export const minimized = new Set(); // paneIds parked out of the grid (PTY alive)
export const layoutState = {
  maximizedPaneId: null, // paneId of the zoomed pane, or null
  selectedPaneId: null, // the one pane the single view shows, or null (empty state)
  recent: [], // paneIds, most recently selected LAST — closePane's fallback order
};

// Mode switch (v19/v27) — owned by mode.js; panes.js reads it (openPane must
// land on a visible grid).
export const modeState = {
  mode: 'code',
  switching: false, // a fade-out is in flight
  queuedMode: null, // last request during the fade — honored at the end
};

// v41 presence-flags store: small transcripts compute SO fast the push can be
// delivered while renderSessions is still awaiting the list (rows not built
// yet -> querySelector miss, probe-caught race). The store covers both
// delivery orders: push-before-build (the build consumes it as the inline
// fallback) and push-after-build (updated in place by the push handler).
export const lastFlags = new Map(); // sessionId -> { git, plans, repo, repoCount }

// sessionId -> { branch, project } from the sidebar scan (branch null = unknown or HEAD).
// Consumers: .ph-branch and .ph-project (panes.js refreshPaneHeaders).
export const sessionMeta = new Map();

// New-session folder menu (v13) — knownProjects captured on every
// renderSessions; defaultDir resolved once from main (~/Documents/workspace).
export const newSessionState = {
  knownProjects: [], // [{ project, cwd }]
  defaultDir: null,
};

// S6b: journal-centric overlay exclusivity. Five close slots + one selection slot, each with a named
// consumer, assigned by the module that owns the close it names (boot.js for
// the first two and closePluginPanel; room-panel.js and usage.js self-assign theirs — not wired
// through boot.js, see their own header comments):
//   closeAgentJournal <- git-panel.js, plans-panel.js, room-panel.js, usage.js, side-panel.js, plugin-panel.js
//   closeSidePanels   <- agent-journal.js, plugin-panel.js (closes git+plans+usage together)
//   closeRoomPanel    <- agent-journal.js, plugin-panel.js
//   closeUsagePage    <- git-panel.js, plans-panel.js, side-panel.js
//   closePluginPanel  <- room-panel.js, agent-journal.js, usage-page.js, side-panel.js, mode.js
//   onPaneSelected    <- layout.js selectPane(pane); consumer: the side panel (P1-09)
export const overlayState = {
  closeAgentJournal: null,
  closeSidePanels: null,
  closeRoomPanel: null,
  closeUsagePage: null,
  closePluginPanel: null,
  onPaneSelected: null,
  onGitRepo: null, // mr-review.js registers; git-panel.js calls (target, root | null) where a load settles a repo
  askFromPanel: null, // chat-view.js registers (paneId, text, sink) -> {ok, queued} | {ok:false, notice}; consumers: the side-panel tabs
};
