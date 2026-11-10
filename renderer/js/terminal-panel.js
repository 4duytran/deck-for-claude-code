// claude-deck — renderer/terminal-panel: the Terminal tab of the side panel. One shell per LIVE pane (key paneId), run by
// main (ipc/panel-term.js) and drawn by one xterm per entry; a target with no live pane (the last pane closed, the panel
// still open) shows « Aucune session sélectionnée » and starts nothing. An entry outlives tab and session switches and
// panel closes; only closing its pane ends it. Not a session: outside the sidebar and `ptys`. Imports side-panel.js,
// state.js, theme.js and term-keys.js only (panes.js calls closePanelTerminal, never the reverse).
'use strict';

import { registerSideTab, showSideTab, sp } from './side-panel.js';
import { panes } from './state.js';
import { XTERM_THEME, MONO_FONT } from './theme.js';
import { wireTermKeys } from './term-keys.js';

const RESIZE_DEBOUNCE_MS = 50;
const MSG_NO_SESSION = 'Aucune session sélectionnée';
const MSG_NO_CWD = 'Dossier de la session introuvable';
const MSG_SPAWN = 'Impossible de lancer le terminal';
const MSG_EXITED = 'Terminal terminé';

// Live state, read by the probes. entries: termId -> { id, term, fit, host, ro, timer, pid, status, target, sent, reason }
//   status: 'new' | 'starting' | 'live' | 'exited' | 'failed'   shownId: the entry on screen (null = none)
export const terminalState = { shownId: null, entries: new Map() };

let note = null; // the centred message over the hosts: a line of text and the « Relancer » button
let noteText = null;
let noteBtn = null;

const $ = (id) => document.getElementById(id);
// The target's pane id while that pane is live; a target with no live pane has no terminal.
const termIdOf = (t) => (t && t.paneId && panes.has(t.paneId) ? t.paneId : null);
const shownEntry = () => (terminalState.shownId ? terminalState.entries.get(terminalState.shownId) || null : null);

// The size the shell should get, or null while the host is hidden or has no size (a hidden host is never fitted).
function fitNow(e) {
  if (!e.host.offsetWidth || !e.host.offsetHeight) return null;
  try { e.fit.fit(); } catch (_) { return null; }
  const { cols, rows } = e.term;
  return cols > 0 && rows > 0 ? { cols, rows } : null;
}

function sendSize(e) {
  const d = fitNow(e);
  if (!d || e.status !== 'live') return;
  if (e.sent && e.sent.cols === d.cols && e.sent.rows === d.rows) return;
  e.sent = d;
  window.api.panelTermResize({ termId: e.id, cols: d.cols, rows: d.rows });
}

function scheduleSize(e) {
  clearTimeout(e.timer);
  e.timer = setTimeout(() => { e.timer = null; sendSize(e); }, RESIZE_DEBOUNCE_MS);
}

function setNote(text, withRestart) {
  noteText.textContent = text;
  noteBtn.hidden = !withRestart;
  note.hidden = false;
}

// Shows the current entry only, and the message its state calls for.
function render() {
  const cur = shownEntry();
  for (const e of terminalState.entries.values()) {
    e.host.hidden = e !== cur || e.status === 'failed';
    e.host.classList.toggle('ended', e.status === 'exited');
  }
  if (!cur) setNote(MSG_NO_SESSION, false);
  else if (cur.status === 'failed') setNote(cur.reason, false);
  else if (cur.status === 'exited') setNote(MSG_EXITED, true);
  else note.hidden = true;
  if (cur) scheduleSize(cur);
}

function createEntry(id, target) {
  const host = document.createElement('div');
  host.className = 'tp-term pane-term'; // pane-term: every Escape guard of the app already knows it
  $('terminal-panel').insertBefore(host, note);
  const term = new Terminal({
    fontSize: 13, fontFamily: MONO_FONT, lineHeight: 1.25, cursorBlink: true, theme: XTERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host); // DOM renderer on purpose: the session panes keep the WebGL contexts
  const e = {
    id, term, fit, host, ro: null, timer: null, pid: null, status: 'new', target, sent: null, reason: null, exitSeen: false,
  };
  const sendInput = (data) => {
    if (e.status === 'live' || e.status === 'starting') window.api.panelTermInput({ termId: id, data });
  };
  term.onData(sendInput);
  wireTermKeys(term, { isAlive: () => terminalState.entries.get(id) === e, writeRaw: sendInput });
  e.ro = new ResizeObserver(() => scheduleSize(e));
  e.ro.observe(host);
  terminalState.entries.set(id, e);
  return e;
}

async function start(e) {
  e.status = 'starting';
  e.reason = null;
  e.exitSeen = false;
  render();
  const d = fitNow(e);
  const t = e.target;
  let r = null;
  try {
    r = await window.api.panelTermOpen({ termId: e.id, target: { paneId: t.paneId, sessionId: t.sessionId }, ...(d || {}) });
  } catch (_) { r = null; }
  if (terminalState.entries.get(e.id) !== e) { // the pane closed while main was starting the shell
    if (r && r.ok === true) window.api.panelTermKill({ termId: e.id });
    return;
  }
  if (!r || r.ok !== true) {
    e.status = 'failed';
    e.reason = r && r.reason === 'no-cwd' ? MSG_NO_CWD : MSG_SPAWN;
  } else {
    e.pid = r.pid;
    e.status = e.exitSeen ? 'exited' : 'live'; // a shell that ended before the answer came back
    e.sent = d;
    sendSize(e); // the window may have moved on while the shell started
  }
  render();
}

function restart(e) {
  e.term.reset();
  e.pid = null;
  e.sent = null;
  start(e);
  e.term.focus();
}

function open(target, opts) {
  showSideTab('terminal', target);
  const t = sp.target;
  const id = termIdOf(t);
  terminalState.shownId = id;
  let e = id ? terminalState.entries.get(id) : null;
  if (id && !e) e = createEntry(id, t);
  if (e) e.target = t;
  render();
  if (!e) return;
  if (!(opts && opts.keepFocus)) e.term.focus();
  if (e.status === 'new' || e.status === 'failed') start(e);
}

// Only the "shown" state: the shell keeps running with its scrollback.
function close() {
  terminalState.shownId = null;
}

export function notifyPanelTermData(p) {
  const e = p && terminalState.entries.get(p.termId);
  if (e && typeof p.data === 'string') e.term.write(p.data);
}

// An entry the view closed itself is already out of the map: its exit shows nothing.
export function notifyPanelTermExit(p) {
  const e = p && terminalState.entries.get(p.termId);
  if (!e) return;
  if (e.status === 'starting') { e.exitSeen = true; return; }
  if (e.status !== 'live') return;
  e.status = 'exited';
  render();
}

// Called by closePane (every way a pane ends goes through it): kills the shell and drops the view of it.
export function closePanelTerminal(paneId) {
  const e = terminalState.entries.get(paneId);
  if (!e) return;
  terminalState.entries.delete(paneId);
  clearTimeout(e.timer);
  e.ro.disconnect();
  window.api.panelTermKill({ termId: paneId });
  e.term.dispose();
  e.host.remove();
  if (terminalState.shownId === paneId) {
    terminalState.shownId = null;
    render();
  }
}

export function initTerminalPanel() {
  // A renderer reload rebuilds the panes while main keeps its shells: end them before any view starts one.
  window.api.panelTermReset();
  note = document.createElement('div');
  note.className = 'tp-note';
  note.hidden = true;
  note.setAttribute('aria-live', 'polite');
  noteText = document.createElement('p');
  noteText.className = 'tp-note-text';
  noteBtn = document.createElement('button');
  noteBtn.type = 'button';
  noteBtn.className = 'tp-btn';
  noteBtn.textContent = 'Relancer';
  noteBtn.hidden = true;
  noteBtn.addEventListener('click', () => {
    const e = shownEntry();
    if (e && e.status === 'exited') restart(e);
  });
  note.append(noteText, noteBtn);
  $('terminal-panel').appendChild(note);
  registerSideTab('terminal', { open, close });
}
