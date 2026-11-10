// claude-deck — renderer/term-keys: the clipboard keys every xterm of the app shares (the session panes and the side
// panel's terminal). Imports nothing: the caller hands in what differs between them, whether the terminal is still
// alive and where raw bytes go.
'use strict';

const PRIMARY_DEBOUNCE_MS = 150;

// Smart Ctrl+C / Ctrl+V (desktop reflexes, à la VS Code / Windows Terminal):
// - Ctrl+C with an active selection -> COPY to the system CLIPBOARD (no SIGINT); without -> SIGINT.
// - Ctrl+V -> paste the clipboard TEXT; no text (e.g. an image) -> the raw 0x16, so claude code's own image paste works.
// Ctrl+Shift+C/V keep working through main's before-input-event (terminal standard).
export function wireTermKeys(term, { isAlive, writeRaw }) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
    if (!plainCtrl) return true;
    if ((e.key === 'c' || e.key === 'C') && term.hasSelection()) {
      window.api.clipboardWrite(term.getSelection());
      term.clearSelection(); // visual ack — and the next Ctrl+C is a SIGINT again
      e.preventDefault();
      return false; // don't send \x03
    }
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      window.api.clipboardRead()
        .then((t) => {
          if (!isAlive()) return;
          if (t) term.paste(t);
          else writeRaw('\x16'); // image/empty -> raw ^V
        })
        .catch(() => {});
      return false; // the async branch above decides what reaches the shell
    }
    return true;
  });

  // alacritty-style selection -> X11 PRIMARY (copy-on-select). Debounced: onSelectionChange fires continuously while
  // dragging. isAlive covers a terminal closed before the debounce fires. Middle-click PASTE needs no wiring: Chromium
  // pastes the PRIMARY into the focused xterm helper textarea itself (handling auxclick too pastes twice).
  let selTimer = 0;
  term.onSelectionChange(() => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (!isAlive()) return;
      const s = term.getSelection();
      if (s) window.api.writePrimary(s);
    }, PRIMARY_DEBOUNCE_MS);
  });
}
