// claude-deck — ipc/room: the deck's own room panel surface. Reads the room
// feed + registry (so the human SEES the inter-session chat) and lets the human
// POST a message as themselves (from:'user', label:'you'). The append re-enters
// the running router (rooms.js fs.watch) exactly like a CLI post — same delivery
// path, no special-casing. The live feed is pushed via rooms.setRoomListener.
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const { ROOMS_DIR, ROOM_FILE, REGISTRY_FILE, ROOM_MAX_TEXT, ROOM_HUMAN_LABEL, ROOM_FEED_DEFAULT } = require('../config');
const { send } = require('../window');
const { setRoomListener, setControlListener, clearRoomLog, relabelMessage } = require('../rooms');
const roomDb = require('../room-db'); // durable history source for the panel feed

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {
    return [];
  }
}

function registerRoomIpc() {
  // Push every routed message to the panel as it lands (live feed). relabelMessage
  // swaps a sender's spawn-time fallback label (workspace-<shortid>) / a missing
  // to_label for the deck's canonical name, so a live row reads "<name> (<shortid>)".
  setRoomListener((msg) => send('room-append', relabelMessage(msg)));

  // Forward lifecycle control records (room spawn/resume) to the renderer, which
  // owns pane creation (openPane). Same one-way push as the live feed.
  setControlListener((rec) => send('room-control', rec));

  // Panel history now comes from the DURABLE archive (room-db), not a tail of the
  // ephemeral main.jsonl — so it survives "Vider"/restart. `limit` is the panel's
  // chosen size (0 = "Tout"); fall back to the configured default when unset.
  ipcMain.handle('room-recent', (_e, limit) => ({
    ok: true,
    // Re-resolve labels against the CURRENT roomLabels so already-archived rows
    // (frozen with a fallback/absent label) also display the real session name.
    messages: roomDb.recent(limit == null ? ROOM_FEED_DEFAULT : limit).map(relabelMessage),
  }));

  ipcMain.handle('room-who', () => ({ ok: true, sessions: readRegistry() }));

  ipcMain.handle('room-send', (_e, { to, text } = {}) => {
    const target = typeof to === 'string' ? to.trim() : '';
    const body = typeof text === 'string' ? text.trim() : '';
    if (!target) return { ok: false, error: 'no target' };
    if (!body) return { ok: false, error: 'empty message' };
    const msg = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      from: 'user',
      from_label: ROOM_HUMAN_LABEL,
      to: target,
      text: body.slice(0, ROOM_MAX_TEXT),
    };
    try {
      fs.mkdirSync(ROOMS_DIR, { recursive: true });
      fs.appendFileSync(ROOM_FILE, `${JSON.stringify(msg)}\n`);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true };
  });

  // Clear the room message log (the panel's "clean" button). Delegated to
  // rooms.clearRoomLog so it runs IN the router process: it drains any pending
  // lines first (no silent drop), truncates main.jsonl, and resets the watcher
  // cursor — no cross-process truncate race, no backlog replay. NOTE: this wipes
  // the LOG + the panel feed only; messages already delivered into session panes
  // are part of those conversations and cannot be retracted.
  ipcMain.handle('room-clear', () => clearRoomLog());
}

module.exports = { registerRoomIpc };
