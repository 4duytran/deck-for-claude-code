// claude-deck — renderer/plans-full: « Plein écran » / « Réduire » of the HTML plan view of the Plans tab (view-full.js, like plugin-full.js for the Plugins report).
// Self-wiring module (own <script type="module">). The Plans panel is a tab of the side panel: it is open while its `hidden` flag is off.
// The ask chip reset and the Escape order are the shared wireFullGuards of view-full.js.
'use strict';

import { wireViewFull, wireFullGuards } from './view-full.js';
import { frameAskReset } from './frame-ask.js';

const $ = (id) => document.getElementById(id);

export const plansFull = wireViewFull({
  panel: $('plans-panel'),
  view: $('pp-view'),
  btn: $('pp-full'),
  park: $('pp-body'),
  cls: 'pp-fullscreen',
  holdFrame: true,
  isOpen: () => !$('plans-panel').hidden,
});

wireFullGuards({ full: plansFull, panel: $('plans-panel'), reset: frameAskReset });
