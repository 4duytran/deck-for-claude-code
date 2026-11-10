// claude-deck — room-control: turns inter-session ROOM lifecycle records
// (`room spawn`, `room resume`) into deck pane actions. Deliberately ISOLATED,
// like room-panel.js: its own <script> tag, no boot.js wiring, self-initialised,
// trivially removable. It drives the SAME renderer pane path a human click does
// (openPane / findLivePane / restorePane) — no privileged renderer shortcut.
//
// Trust model: the authority to act is `~/.claude/rooms/main.jsonl` write access.
// This is a single-user local app and that path already sits inside the fully
// trusted ~/.claude tree (whoever can append here can already edit settings
// hooks = arbitrary exec). So this widens the room from "poke a running pane"
// to "spawn/resume a pane" WITHIN an already-trusted boundary — not a new one.
'use strict';

import { openPane, findLivePane } from './panes.js';
import { selectPane, focusPaneInput } from './layout.js';
import { minimized } from './state.js';

// Resolve a session id -> its original cwd + name by scanning the same session
// index the sidebar uses. We NEVER resume blind: an unknown id (closed session
// the deck no longer indexes, or a typo) resolves to nothing and is dropped.
async function resolveSession(id) {
  let groups;
  try { groups = await window.api.listSessions(); } catch (_) { return null; }
  for (const g of (groups || [])) {
    const s = (g.sessions || []).find((x) => x && x.sessionId === id);
    if (s) return { cwd: g.cwd, title: s.summary };
  }
  return null;
}

async function onControl(rec) {
  if (!rec || typeof rec !== 'object') return;

  if (rec.action === 'spawn') {
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 200) : '';
    if (!name) return; // main already validated, but never spawn unnamed
    openPane({
      newName: name, title: name, cwd: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : undefined,
      select: false, // a room worker runs in the background
    });
    return;
  }

  if (rec.action === 'resume') {
    const id = typeof rec.session_id === 'string' ? rec.session_id : '';
    if (!id) return;
    // Single-pane policy (same as the sidebar): a live pane is reused, never
    // re-resumed (a second `claude --resume` would fork yet another session id).
    // A MINIMIZED live pane must be un-parked, not just focused, or it stays
    // collapsed off-grid: that is the one case that already brings a pane back
    // for the user, so it selects (selectPane un-parks). Any other live pane is
    // only focused, the shown session is not replaced.
    const live = findLivePane(id);
    if (live) {
      if (minimized.has(live.paneId)) { selectPane(live.paneId); return; }
      try { focusPaneInput(live); } catch (_) { /* pane torn down mid-call */ }
      return;
    }
    const found = await resolveSession(id);
    if (!found || !found.cwd) return; // unknown id -> drop, never resume blind
    openPane({
      cwd: found.cwd, resumeId: id, title: found.title || 'resume', select: false,
    });
  }
}

function init() {
  if (window.api && typeof window.api.onRoomControl === 'function') {
    window.api.onRoomControl(onControl);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
