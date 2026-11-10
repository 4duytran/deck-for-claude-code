// zoom probe — UI zoom factor.
//   z1 env default applies at load · z2/z3/z4 xterm REFITS on zoom (the RO path)
//   z5 resolveZoom() pure logic (1.0 default / precedence / clamp / 0-trap)
//   z6 real keyboard Ctrl +/-/0 via sendInputEvent (the before-input-event path)
//   z7 persistence (debounced write to userData/deck-zoom)
//   z8 the claude.ai WebContentsView bounds are DIP-corrected at zoom != 1
//   z9 claude.ai CONTENT is force-pinned to native 1.0 (clears persisted leftover)
//
// Run: ./node_modules/.bin/electron test/zoom-probe.js
// FULL ISOLATION: fake HOME + userData before main.js loads.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zoom-home-'));
process.env.HOME = FAKE_HOME;
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, 'Documents', 'workspace'), { recursive: true }); // default new-session dir
const SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHIM, '#!/bin/bash\nexec /bin/bash --norc --noprofile -i\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';
process.env.CLAUDE_DECK_NO_SHELL_ENV = '1';
process.env.CLAUDE_DECK_ZOOM = '1.4'; // env default under test (overrides the sweep's 1.0)

require(path.join(__dirname, '..', 'main.js'));
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zoom-'));
require('electron').app.setPath('userData', USER_DATA);

const { resolveZoom } = require(path.join(__dirname, '..', 'src', 'main', 'window'));
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
const near = (a, b, t = 0.02) => Math.abs(a - b) < t;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}
function finish() {
  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'zoom-probe.out'), report + '\n');
  console.log('\n=== zoom probe ===\n' + report);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    await sleep(1400);
    const win = BrowserWindow.getAllWindows()[0];
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const keyCtrl = async (k) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] });
      await sleep(180);
    };

    // z1 — env default CLAUDE_DECK_ZOOM=1.4 applied at load.
    gate('z1 env zoom factor applied at load', near(win.webContents.getZoomFactor(), 1.4),
      `getZoomFactor=${win.webContents.getZoomFactor().toFixed(3)} (expected ~1.4)`);

    // open a terminal pane and read its cols at zoom 1.4
    await js(`document.getElementById('new-session').click()`);
    await sleep(300);
    await js(`(document.getElementById('ns-send')||{click(){}}).click()`); // start screen: default dir, no name
    await sleep(1500);
    const paneId = await js(`[...panes.keys()][0] || 'NONE'`);
    await js(`panes.has('${paneId}') ? setChatView('${paneId}', false) : 0`);
    await sleep(500);
    const cols14 = await js(`(panes.get('${paneId}')||{term:{}}).term.cols || -1`);
    gate('z2 pane has cols at zoom 1.4', Number.isInteger(cols14) && cols14 > 0, `cols@1.4=${cols14}`);

    // z3 — direct zoom IN to 1.9 -> RO refit -> FEWER cols.
    win.webContents.setZoomFactor(1.9);
    await sleep(700);
    const cols19 = await js(`panes.get('${paneId}').term.cols`);
    gate('z3 zoom-in refits xterm (fewer cols)',
      near(win.webContents.getZoomFactor(), 1.9) && cols19 < cols14,
      `cols ${cols14} -> ${cols19} (must shrink)`);

    // z4 — direct zoom OUT to 0.8 -> refit -> MORE cols.
    win.webContents.setZoomFactor(0.8);
    await sleep(700);
    const cols08 = await js(`panes.get('${paneId}').term.cols`);
    gate('z4 zoom-out refits xterm (more cols)',
      near(win.webContents.getZoomFactor(), 0.8) && cols08 > cols14,
      `cols ${cols14} -> ${cols08} (must grow)`);

    // z5 — resolveZoom() pure: default 1.0 (window.js DEFAULT_ZOOM, user decision 2026-10-28: Verre
    // reads too big at 1.2), env/persisted precedence, clamp, 0-trap (falls to the 1.0 baseline).
    const r = {
      def: resolveZoom(undefined, null),
      env: resolveZoom('1.6', null),
      persisted: resolveZoom(undefined, '1.5'),
      envWins: resolveZoom('1.4', '1.5'),
      zeroTrap: resolveZoom('0', null),
      clampHi: resolveZoom('99', null),
      clampLo: resolveZoom('0.1', null),
    };
    gate('z5 resolveZoom default/precedence/clamp',
      r.def === 1 && r.env === 1.6 && r.persisted === 1.5 && r.envWins === 1.4
        && r.zeroTrap === 1 && r.clampHi === 2.5 && r.clampLo === 0.6,
      JSON.stringify(r));

    // z6 — real keyboard via sendInputEvent (drives before-input-event).
    await keyCtrl('0'); // reset to env baseline 1.4 (also re-syncs currentZoom)
    const zReset = win.webContents.getZoomFactor();
    await keyCtrl('='); // Ctrl+= zoom IN -> ~1.5
    const zIn = win.webContents.getZoomFactor();
    await keyCtrl('-'); // Ctrl+- zoom OUT -> ~1.4
    const zOut = win.webContents.getZoomFactor();
    gate('z6 keyboard Ctrl +/-/0 adjusts zoom',
      near(zReset, 1.4) && near(zIn, 1.5) && near(zOut, 1.4),
      `reset=${zReset.toFixed(2)} in=${zIn.toFixed(2)} out=${zOut.toFixed(2)}`);

    // z7 — persistence: the debounced write lands the current factor on disk.
    await sleep(400); // > 250ms debounce
    let persisted = -1;
    try { persisted = Number(fs.readFileSync(path.join(USER_DATA, 'deck-zoom'), 'utf8')); } catch (_) {}
    gate('z7 zoom persisted to userData/deck-zoom', near(persisted, win.webContents.getZoomFactor()),
      `file=${persisted} live=${win.webContents.getZoomFactor().toFixed(2)}`);

    // z8 — AI WebContentsView bounds are DIP-corrected (rawCss * zoom), not raw.
    await keyCtrl('0'); // known zoom 1.4
    const zAi = win.webContents.getZoomFactor();
    await js(`setMode('ai')`);
    await sleep(900); // ensureAiView (about:blank) + ai-show -> setBounds
    const rawW = await js(`(document.getElementById('ai-frame')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width`);
    const dip = global.__deckAiBounds;
    gate('z8 AI view bounds DIP-corrected for zoom',
      !!dip && zAi > 1.05 && rawW > 0 && Math.abs(dip.width - rawW * zAi) <= 2,
      `dipW=${dip && dip.width} rawW=${rawW && rawW.toFixed(1)} zoom=${zAi.toFixed(2)} expected~${rawW ? Math.round(rawW * zAi) : '?'}`);

    // z9 — claude.ai content is pinned to native 1.0 even after a non-1 zoom is
    // applied (simulates a value an earlier build persisted in the partition).
    // Deck is at 1.4 here (zAi) yet the panel content must settle at 1.0.
    const aiwc = global.__deckAiWC;
    let before = -1, after = -1;
    if (aiwc && !aiwc.isDestroyed()) {
      aiwc.setZoomFactor(1.6);          // leftover/persisted-style zoom
      await sleep(60);
      before = aiwc.getZoomFactor();    // ~1.6
      aiwc.reload();                    // refires dom-ready -> code forces native
      await sleep(700);
      after = aiwc.getZoomFactor();     // must be ~1.0
    }
    gate('z9 claude.ai content force-pinned native (clears leftover zoom)',
      !!aiwc && near(before, 1.6) && near(after, 1.0) && near(global.__deckAiZoom, 1.0) && zAi > 1.05,
      `before=${before.toFixed?before.toFixed(2):before} after=${after.toFixed?after.toFixed(2):after} domReadyZoom=${global.__deckAiZoom} deckZoom=${zAi.toFixed(2)}`);

    finish();
  } catch (e) {
    results.push(`FAIL probe-crash — ${e && e.stack ? e.stack : e}`);
    failed = true;
    finish();
  }
});
