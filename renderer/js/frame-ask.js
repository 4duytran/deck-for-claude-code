// claude-deck — renderer/frame-ask: the « Demander à Claude » chip and popup of a closed page frame, shared by its hosts.
// A host (Plans, Files) hands in what a frame reports: the selection shows ONE reused chip, only its click opens the code-ask
// popup, and a press inside the frame closes that popup (a click in the frame never reaches the Deck document).
// host = { label, scope, isLive(), fallbackRect(), placeBubble(bubbleEl) }.
'use strict';

import { openAsk, closeAsk, composeCodeMessage } from './code-ask.js';

let chip = null;
let current = null; // the chip's payload: { text, rect|null, host }
let ours = false; // this module opened the popup and it is still up

function hideChip() {
  current = null;
  if (chip) chip.hidden = true;
}

function chipClick() {
  const sel = current;
  if (!sel || !sel.host.isLive()) return;
  const { host } = sel;
  const words = sel.text.split(/\s+/).slice(0, 8).join(' ');
  const ref = `${host.label} — « ${words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words} »`;
  const r = sel.rect || host.fallbackRect();
  hideChip();
  ours = true;
  openAsk({
    anchorEl: { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height },
    threadRef: ref,
    scope: host.scope,
    compose: (question) => composeCodeMessage(ref, sel.text, question),
    placeBubble: (bubble) => { ours = false; host.placeBubble(bubble); }, // code-ask closes its popup just before placing the bubble
  });
}

// `sel` = { text, rect } from mountClosedFrame; the chip sits at the end of the selection, clamped to the viewport.
export function frameAskSelect(sel, host) {
  if (!host.isLive()) return;
  const text = String(sel.text || '').trim();
  if (!text) { hideChip(); return; }
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pp-ask-chip';
    chip.textContent = 'Demander à Claude';
    chip.hidden = true;
    chip.addEventListener('click', chipClick);
    document.body.appendChild(chip);
  }
  current = { text, rect: sel.rect, host };
  chip.hidden = false;
  const c = chip.getBoundingClientRect();
  const r = sel.rect || host.fallbackRect();
  chip.style.left = `${Math.min(Math.max(8, r.left + r.width), window.innerWidth - c.width - 8)}px`;
  chip.style.top = `${Math.min(Math.max(8, r.top + r.height + 6), window.innerHeight - c.height - 8)}px`;
}

// A press inside the frame: closes the popup this module opened, never another surface's.
export function frameAskPointerDown() {
  if (!ours) return;
  closeAsk();
  ours = false;
}

// The view changed or closed: no chip, and our popup goes with it.
export function frameAskReset() {
  hideChip();
  frameAskPointerDown();
}
