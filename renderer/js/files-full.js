// claude-deck — renderer/files-full: « Plein écran » / « Réduire » of an HTML page shown in the Files tab viewer (view-full.js, like plans-full.js).
// Self-wiring module (own <script type="module">). The page is either the script-free « Format riche » frame (inside `.fp-rich`, beside the code-ask
// overlay) or the closed deckpage: frame (a direct child of #fp-vbody): the view holds a text or a message otherwise, and shows no button then.
// The Files tab is open while its panel is shown AND the viewer is: closing the viewer, the panel or showing another tab resets the full screen.
'use strict';

import { wireViewFull, wireFullGuards } from './view-full.js';
import { frameAskReset } from './frame-ask.js';
import { closeAsk } from './code-ask.js';

const $ = (id) => document.getElementById(id);
const panel = $('files-panel');
const viewer = $('fp-viewer');

export const filesFull = wireViewFull({
  panel,
  view: $('fp-vbody'),
  btn: $('fp-full'),
  park: viewer,
  cls: 'fp-fullscreen',
  holdFrame: true,
  isOpen: () => !panel.hidden && !viewer.hidden,
  frameSel: ':scope > iframe, :scope > .fp-rich > iframe',
  watch: [viewer],
});

// closeAsk: the popup of the script-free page is not the chip's (frame-ask.js only closes its own).
wireFullGuards({ full: filesFull, panel, reset: () => { frameAskReset(); closeAsk(); } });

// Escape typed with the focus in the frame, relayed by boot.js from main's push. The script-free frame is same-origin: its Escape already reaches
// this document (files-panel.js lockFrame re-dispatches it, and the guard above takes it), so acting on the push too would step back twice.
export function notifyFilesFrameEscape() {
  const f = document.activeElement;
  if (f && f.tagName === 'IFRAME' && !f.hasAttribute('srcdoc')) filesFull.frameEscape();
}
