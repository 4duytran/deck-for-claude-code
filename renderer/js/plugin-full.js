// claude-deck — renderer/plugin-full: « Plein écran » / « Réduire » of the report view of the Plugins panel (daily-brief-v3, S10).
// Self-wiring module (own <script type="module">) over the shared view-full.js, which holds the control, its
// glide and its reset: a click puts #plugin-panel in .plg-fullscreen, so #plg-view fills the Deck window (fixed, inset 0, see style.css).
// The OS window is never put in full screen. plugin-panel.js sends 'plg-full-exit' on the panel for Escape.
'use strict';

import { wireViewFull } from './view-full.js';

const $ = (id) => document.getElementById(id);
const panel = $('plugin-panel');

const full = wireViewFull({
  panel,
  view: $('plg-view'),
  btn: $('plg-full'), // kept by reference: a view repaint detaches the button, so it cannot be looked up by id
  park: $('plg-body'),
  cls: 'plg-fullscreen',
  isOpen: () => panel.classList.contains('open'),
});

panel.addEventListener('plg-full-exit', full.exit);

// Escape typed with the focus in the report frame: only main sees it (boot.js relays it). A focus anywhere else is the panel's own handler.
export function notifyPluginViewEscape() { full.frameEscape(); }
