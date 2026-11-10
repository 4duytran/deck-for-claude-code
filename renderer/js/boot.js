// claude-deck — renderer/boot: THE wiring module (the only entry script in
// index.html). All system access goes through window.api (see preload.js).
// Two invariants live here:
//   1. Single global subscription per IPC channel — the renderer routes
//      events by paneId/sessionId; modules expose notify*() hooks instead of
//      subscribing themselves.
//   2. The PROBE SEAM at the bottom: .scratch probes drive the UI via
//      executeJavaScript and reached top-level functions/consts when the
//      renderer was ONE classic script. ES modules are scoped — everything a
//      probe consumes MUST be exported here onto window, explicitly.
'use strict';

import { panes, minimized, layoutState, overlayState, modeState } from './state.js';
import {
  initLayout, toggleMaximize, minimizePane, restorePane, selectPane,
  resyncAllVisible, resyncPane, webglFallbackToDom,
} from './layout.js';
import { setMode, initMode } from './mode.js';
import { openPane, closePane, findLivePane } from './panes.js';
import {
  renderSessions, startInlineRename, showRowError, openCtxMenu, closeCtxMenu,
  notifySessionStatus, notifySessionFlags, initSidebar,
} from './sidebar.js';
import { initUsage } from './usage.js';
import { initNewSession } from './new-session.js';
import {
  gp, openGitPanel, closeGitPanel, gpLoadStatus, gpLoadDiff,
  gpNotifySessionStatus, initGitPanel,
} from './git-panel.js';
import {
  pp, ppMd, openPlansPanel, closePlansPanel, ppLoadList, ppLoadPlan,
  ppNotifySessionStatus, initPlansPanel,
} from './plans-panel.js';
import { plg, plgLoadList, notifyPluginsChanged, initPluginPanel, closePluginPanel } from './plugin-panel.js';
import { notifyPluginViewEscape } from './plugin-full.js';
import { plansFull } from './plans-full.js';
import { notifyFilesFrameEscape } from './files-full.js';
import { sp, initSidePanel, openSidePanel, closeSidePanel } from './side-panel.js';
import { filesState, openFileInPanel, initFilesPanel } from './files-panel.js';
import { terminalState, initTerminalPanel, notifyPanelTermData, notifyPanelTermExit } from './terminal-panel.js';
import {
  toggleChatView, setChatView, notifyTranscriptAppend, notifySubagentAppend,
  cvNotifySessionStatus, cvNotifySessionContext, cvNotifySessionEffort, cvNotifyPtyData, cvCopyPayload,
  reconcileWaitingGone,
} from './chat-view.js';
import { parseTuiMenu, detectTuiMode, detectTuiBusy, detectMenuNav, readTui } from './tui-prompt.js';
import {
  aj, openAgentJournal, closeAgentJournal, initAgentJournal,
  notifyAgentJournalAppend, notifyAgentJournalFlags,
} from './agent-journal.js';
// L26: ask drawer (hook questions) and the usage page. ask-drawer.js routes by
// paneId itself; boot.js only owns the two pushes and the probe-seam entries.
import { askState, notifyAskRequest, notifyAskClosed } from './ask-drawer.js';
import { mr, initMrReview } from './mr-review.js';
import { openUsagePage, closeUsagePage, usageState } from './usage-page.js';
import * as loading from './loading.js';
import { initHeaderTools, headerTools } from './header-tools.js';

// ---------------------------------------------------------------------------
// Global PTY event routing — single listener per channel, routed by paneId.
// ---------------------------------------------------------------------------

window.api.onData(({ paneId, data }) => {
  const pane = panes.get(paneId);
  if (pane) {
    pane.term.write(data);
    // v38: remember output landing while the grid is hidden (AI mode). xterm
    // never force-scrolls a detached viewport (standard), so a pane left on
    // a reading position would come back showing STALE content while the new
    // lines pile up below (probe (g): viewportY frozen, baseY +132). The
    // return path scrolls flagged panes back to the live bottom.
    if (document.body.dataset.mode === 'ai') pane.outputWhileAi = true;
    // v51: same hazard for any face that hides the terminal host (.pane-term
    // display:none) while output streams — the chat face, a minimized pane AND a
    // pane the single view keeps hidden (B1).
    // xterm never force-scrolls a detached viewport, so the native scrollbar is
    // left parked mid-history. The return paths (toggleChatView / restorePane /
    // selectPane) re-pin flagged panes to the live bottom; an at-bottom pane that
    // never hid stays at the bottom.
    if (pane.el.classList.contains('chat-mode') || pane.el.classList.contains('minimized')
        || (pane.el.parentElement.classList.contains('single') && !pane.el.classList.contains('selected'))) {
      pane.outputWhileTermHidden = true;
    }
    // v46: a TUI menu is a screen redraw, not a transcript event — nudge the
    // chat-face scan (debounced inside; no-op unless the chat face shows).
    // Sandboxed: a scan error must never break terminal output.
    try { cvNotifyPtyData(paneId); } catch (e) { console.error('cv pty-data handler:', e); }
    // A2(b): stale `waiting` on a pane whose chat face is NOT showing. One cheap
    // status check per chunk, a timer only for a waiting pane (see the block below).
    try { waitingGoneOnPtyData(pane); } catch (e) { console.error('waiting-gone pty-data handler:', e); }
  }
});

// >>> A2b waiting-gone wiring (this block is executed verbatim by .scratch/waiting-gone-wiring-probe.js: keep it self-contained — only `panes` and `reconcileWaitingGone` from outside)
// « Menu gone » for panes with no chat-face scan. scanAsk (chat face showing) already
// feeds reconcileWaitingGone; a pane on the terminal face, a minimized terminal-face
// pane and a pane with no chat at all have no scan, so a stale `waiting` (banner,
// sidebar badge, message queue) would stay stuck after the user answered the menu
// in the terminal. Here the raw PTY stream drives the same idempotent check.
//  - Cost rule: a PTY chunk on a pane whose last status is not `waiting` costs one
//    status read and nothing else (no timer, no buffer read). No interval anywhere.
//  - Coalescing: the first chunk of a burst arms ONE timeout; the rest of the burst
//    is ignored while it is pending, so N chunks = one call, and a continuous
//    stream is not starved (a trailing debounce would never fire under it).
//  - A non-waiting status push for such a pane calls the function once with that
//    status: its state and its confirm timer clear.
const WAITING_GONE_DEBOUNCE_MS = 300;

// Last status pushed for the pane's session. pane.pushedStatus is fed by the
// onSessionStatus listener below for EVERY pane (chat or not); before the first
// push the chat's own primed lastStatus is the only source; neither = unknown.
function lastStatusOf(pane) {
  if (pane.pushedStatus !== undefined) return pane.pushedStatus;
  return pane.chat ? pane.chat.lastStatus : undefined;
}

// « Chat face shows » = the pane is on the shared TUI poll (askPolling), whose
// scanAsk already feeds reconcileWaitingGone — do not double-read the buffer.
function chatFaceShows(pane) {
  return !!(pane.chat && pane.chat.askPolling);
}

function waitingGoneOnPtyData(pane) {
  if (lastStatusOf(pane) !== 'waiting' || chatFaceShows(pane)) return;
  if (pane.waitingGoneTimer) return; // a read is already scheduled for this burst
  pane.waitingGoneTimer = setTimeout(() => {
    pane.waitingGoneTimer = null;
    if (panes.get(pane.paneId) !== pane) return; // closed meanwhile
    if (lastStatusOf(pane) !== 'waiting' || chatFaceShows(pane)) return; // moved on / chat face took over
    reconcileWaitingGone(pane, 'waiting');
  }, WAITING_GONE_DEBOUNCE_MS);
}

function waitingGoneOnStatus(sessionId, status) {
  for (const pane of panes.values()) {
    if (pane.sessionId !== sessionId) continue;
    const was = lastStatusOf(pane); // read BEFORE recording: the chat fallback may already hold the new status
    pane.pushedStatus = status;
    if (status === 'waiting') continue;
    clearTimeout(pane.waitingGoneTimer); // a pending read is moot
    pane.waitingGoneTimer = null;
    if (was === 'waiting' && !chatFaceShows(pane)) reconcileWaitingGone(pane, status); // clears the function's state + confirm timer
  }
}
// <<< A2b waiting-gone wiring

window.api.onExit(({ paneId, exitCode }) => {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.term.write(`\r\n\x1b[90m[claude exited with code ${exitCode}]\x1b[0m\r\n`);
  pane.el.classList.add('exited');
  // A pane that dies while minimized is unreachable (its ✕ is hidden away):
  // drop it — the sidebar row already flips to 'closed' via markSessionClosed.
  if (minimized.has(paneId)) closePane(paneId);
});

// Live status push: badge + auto re-scan (sidebar), and the two panels'
// settle-triggered refreshes — each module owns its piece of the reaction.
// v45.2: each consumer is SANDBOXED — one throwing handler must never
// starve the ones after it (user repro: sidebar fresh, chat strip frozen —
// the strip was LAST in an unprotected chain).
window.api.onSessionStatus(({ sessionId, status }) => {
  // A2(b): record the pushed status FIRST — cvNotifySessionStatus below overwrites
  // chat.lastStatus, which the pre-push value is read from for a pane with no push yet.
  try { waitingGoneOnStatus(sessionId, status); } catch (e) { console.error('waiting-gone status handler:', e); }
  try { notifySessionStatus(sessionId, status); } catch (e) { console.error('sb status handler:', e); }
  try { gpNotifySessionStatus(sessionId, status); } catch (e) { console.error('gp status handler:', e); }
  try { ppNotifySessionStatus(sessionId, status); } catch (e) { console.error('pp status handler:', e); }
  try { cvNotifySessionStatus(sessionId, status); } catch (e) { console.error('cv status handler:', e); } // v44: activity strip + queue drain
});

// v47: per-session context-window fill (statusline collector -> watcher ->
// here), routed to the chat strip. Sandboxed like every status consumer.
window.api.onSessionContext(({ sessionId, context }) => {
  try { cvNotifySessionContext(sessionId, context); } catch (e) { console.error('cv context handler:', e); }
});

// The statusline's effort level (collector file -> watcher -> here; main also replays it once at
// transcript-subscribe), routed to the composer's effort picker.
window.api.onSessionEffort(({ sessionId, level }) => {
  try { cvNotifySessionEffort(sessionId, level); } catch (e) { console.error('cv effort handler:', e); }
});

// v41: presence icons land as the background queue completes.
// S6a: the same push also re-renders the OPEN agent journal's header status
// when the ledger flips that agent (finding 22 — sandboxed like the other
// onSessionStatus consumers above, one throwing handler must not starve the rest).
window.api.onSessionFlags((payload) => {
  notifySessionFlags(payload);
  try { notifyAgentJournalFlags(payload); } catch (e) { console.error('aj flags handler:', e); }
});

// v42: chat view increments (routed by paneId; reset = rebuild the view).
window.api.onTranscriptAppend((payload) => notifyTranscriptAppend(payload));
window.api.onSubagentAppend((payload) => notifySubagentAppend(payload)); // v46.6
// S6a: agent journal live-tail increments (single overlay, journalId-routed
// inside notifyAgentJournalAppend — C4).
window.api.onAgentJournalAppend((payload) => notifyAgentJournalAppend(payload));
// L26: hook questions -> the ask drawer (sandboxed like the pushes above; ask-closed
// tolerates an id that is already gone).
window.api.onAskRequest((payload) => { try { notifyAskRequest(payload); } catch (e) { console.error('ask request handler:', e); } });
window.api.onAskClosed((payload) => { try { notifyAskClosed(payload); } catch (e) { console.error('ask closed handler:', e); } });
// Plugin host: a run ended, an import or a delete changed the installed set -> the Plugins panel repaints (no-op while hidden).
window.api.onPluginsChanged(() => { try { notifyPluginsChanged(); } catch (e) { console.error('plugins changed handler:', e); } });
// An Escape typed in a page frame (it never reaches this document): leaves the report / plan / file full screen whose frame has focus.
window.api.onPluginViewEscape(() => {
  try { notifyPluginViewEscape(); } catch (e) { console.error('plugin view escape handler:', e); }
  try { plansFull.frameEscape(); } catch (e) { console.error('plans view escape handler:', e); }
  try { notifyFilesFrameEscape(); } catch (e) { console.error('files view escape handler:', e); }
});

// ---------------------------------------------------------------------------
// Wire up.
// ---------------------------------------------------------------------------

initHeaderTools(); // first init: its window capture-phase Escape (the open « ⋯ » menu) is the first listener an init adds. The
// wireFullGuards listeners of plans-full.js / files-full.js (imported above) are added at module evaluation, so they run before
// it; they yield while ownPopupOpen() holds (the open menu is a [role="menu"]), which leaves that Escape to the menu.
initLayout();
initMode();
initSidebar();
initNewSession();
initSidePanel(); // P1-09: tab bar, resize handle, onPaneSelected slot (the tabs register in the three inits below)
initFilesPanel();
initGitPanel();
initMrReview(); // after the git panel: its markup and the onGitRepo slot caller
initPlansPanel();
initPluginPanel(); // registers the Plugins panel; its refresh arrives through the onPluginsChanged listener above
initTerminalPanel(); // registers the Terminal tab; the shell's output and exit arrive through the two hooks below
window.api.onPanelTermData(notifyPanelTermData);
window.api.onPanelTermExit(notifyPanelTermExit);
initAgentJournal();

// S6b: overlayState slots boot.js owns (D9) — git-panel/plans-panel/
// room-panel/plugin-panel all read closeAgentJournal; agent-journal and plugin-panel read closeSidePanels
// here and closeRoomPanel, self-assigned by room-panel.js (not wired through
// boot.js, own module); closePluginPanel is read by room-panel, agent-journal, usage-page, side-panel and mode.
overlayState.closeAgentJournal = closeAgentJournal;
overlayState.closeSidePanels = () => { closeSidePanel(); closeUsagePage(); };
overlayState.closePluginPanel = closePluginPanel;

renderSessions();
initUsage();

// ---------------------------------------------------------------------------
// PROBE SEAM — contractual. The .scratch probes call these via
// executeJavaScript exactly as they did when renderer.js was one classic
// script (top-level functions/consts were reachable then). Removing or
// renaming an entry here breaks the regression harness — extend it when a
// new probe needs new internals, never prune it casually.
// ---------------------------------------------------------------------------
Object.assign(window, {
  // shared state (live references — Maps/objects mutated in place)
  // S6b: overlayState also doubles as the cross-module-graph seam for
  // room-panel.js, which cannot `import` it directly (D16 — see room-panel.js).
  panes, gp, pp, ppMd, overlayState, modeState,
  // panes & layout (B1: layoutState = selectedPaneId / recent, selectPane = the single-view switch)
  layoutState, selectPane,
  openPane, closePane, findLivePane, toggleMaximize, minimizePane, restorePane,
  resyncAllVisible, resyncPane, webglFallbackToDom, // v53: resyncPane seamed for the scroll-stick probe (rect-0 flag preservation)
  // mode
  setMode,
  // header toolbar (priority+): headerTools.state = { step, steps, out, open }, .relayout() / .open() / .close()
  headerTools,
  // sidebar (v49.1: showRowError exposed for the card-compact probe's
  // error-restore gate — see card-compact-probe.js k10)
  renderSessions, startInlineRename, showRowError, openCtxMenu, closeCtxMenu,
  // panels
  openGitPanel, closeGitPanel, gpLoadStatus, gpLoadDiff,
  mr, // deck-mr-review R4: MR entry state (detected = per-repo-root memo, current, open)
  openPlansPanel, closePlansPanel, ppLoadList, ppLoadPlan,
  // P1-09: docked side panel (sp = live state: open / tab / target / width)
  sp, openSidePanel, closeSidePanel,
  // P1-10: Fichiers tab (filesState = live state: open / target / mode / query / view)
  filesState, openFileInPanel,
  // Terminal tab (terminalState = live state: shownId / entries, one per live pane)
  terminalState,
  // Plugins panel (plg = live state: open / rows / shown / busy / notes; plgLoadList re-reads the listing)
  plg, plgLoadList,
  // S6a: agent journal overlay (aj = live state, same pattern as gp/pp)
  aj, openAgentJournal, closeAgentJournal,
  // chat view (v42; v46.9 setChatView = idempotent face selector)
  // v50: cvNotifySessionStatus exposed too — probe gates drive the status handler
  // SYNCHRONOUSLY (no file->watch->phantom-decay race in the fake-TUI harness).
  toggleChatView, setChatView, cvNotifySessionContext, cvNotifySessionStatus,
  notifyTranscriptAppend, // v62: dblsend-repro probe drives the optimistic-confirm path
  // v71: the copy-button payload lives in a module-scoped WeakMap — this is the
  // only way a probe can assert what a turn's button hands to the clipboard.
  cvCopyPayload,
  // TUI prompt parsing (v46) — namespaced: pure parsers for probe gates
  tuiPrompt: { parseTuiMenu, detectTuiMode, detectTuiBusy, detectMenuNav, readTui },
  // Ask drawer (L26) — askState(paneId?) is the read-only queue snapshot;
  // notifyAskRequest lets a probe push a request without the IPC round trip.
  askState, notifyAskRequest,
  // Usage page (L26) — open/close drive the overlay, usageState reads {open, tab, period} back.
  openUsagePage, closeUsagePage, usageState,
  // Loading states — the loader factories (skeleton, progressBar, inlineBar, shimmer) for the loading probes.
  loading,
});
