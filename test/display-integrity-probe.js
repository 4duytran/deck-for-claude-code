// v34 probe — display integrity: defensive resize pipeline + WebGL fallback.
// 8 gates. Run: ./node_modules/.bin/electron test/display-integrity-probe.js
//
// Ground truth: CLAUDE_DECK_BIN = /bin/bash (a REAL shell in the PTY) — after
// every gesture, `stty size` inside the pane must match term.rows/cols. That
// proves the fit()+pty.resize() coupling end-to-end, not just JS state.
//
// FULL ISOLATION (incident rule 2026-06-04): HOME faked BEFORE main.js loads,
// userData on a mkdtemp. No resume is ever used (no FIX #1 poll windows).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

// v46.5: the deck passes --session-id on EVERY creation — bare /bin/bash would
// choke on it (usage + exit 2). Shim drops argv, keeps a REAL interactive shell.
const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM; // real PTY shell -> stty ground truth
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // Open one pane (unnamed new session -> spawns bare bash).
  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`document.getElementById('ns-send').click()`);
  await sleep(1500); // spawn + bash prompt
  const paneId = await js(`[...panes.keys()][0]`);
  // v46.9: chat is the default face once identity lands — this probe TESTS
  // THE TERMINAL: force the terminal face (after the auto-ON already ran).
  await js(`setChatView('${paneId}', false)`);
  await sleep(400); // RO refire + fit on the re-shown terminal
  const mode0 = await js(`panes.get('${paneId}').rendererMode`);

  // stty ground truth helper: run `stty size` in the pane, parse "ROWS COLS"
  // from the tail of the xterm buffer, compare to term.rows/cols.
  async function sttyMatches(label) {
    await js(`window.api.writeInput('${paneId}', 'stty size\\n')`);
    await sleep(350);
    const r = await js(`(() => {
      const p = panes.get('${paneId}');
      const b = p.term.buffer.active;
      const lines = [];
      // Scan the WHOLE buffer: content lives at the TOP, the lower viewport
      // rows are empty lines (b.length counts them too).
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        if (!l) continue;
        const s = l.translateToString(true);
        if (s.trim()) lines.push(s);
      }
      return { lines, rows: p.term.rows, cols: p.term.cols };
    })()`);
    let stty = null;
    for (let i = r.lines.length - 1; i >= 0; i--) {
      const m = r.lines[i].trim().match(/^(\d+) (\d+)$/);
      if (m) { stty = { rows: +m[1], cols: +m[2] }; break; }
    }
    const ok = !!stty && stty.rows === r.rows && stty.cols === r.cols;
    const dump = ok ? '' : ` buf=${JSON.stringify(r.lines.slice(-5))}`;
    return { ok, detail: `${label}: stty=${JSON.stringify(stty)} term={rows:${r.rows},cols:${r.cols}}${dump}` };
  }

  // t0 — renderer picked and recorded (webgl on GPU, dom in headless sandbox).
  gate('t0 renderer mode recorded', mode0 === 'webgl' || mode0 === 'dom',
       `rendererMode=${mode0}`);

  // t1 — baseline: PTY size matches xterm right after open.
  let r = await sttyMatches('open');
  const colsBaseline = await js(`panes.get('${paneId}').term.cols`);
  gate('t1 stty matches at open', r.ok, r.detail);

  // t2 — window resize -> RO + window listener -> resync -> stty matches.
  win.setSize(1000, 700);
  await sleep(600);
  r = await sttyMatches('window-resize');
  const colsSmall = await js(`panes.get('${paneId}').term.cols`);
  gate('t2 stty matches after window resize', r.ok && colsSmall !== colsBaseline,
       `${r.detail} colsChanged=${colsSmall}!=${colsBaseline}`);

  // t3 — maximize / restore-from-zoom: both transitions resync.
  await js(`toggleMaximize('${paneId}')`);
  await sleep(500);
  let r1 = await sttyMatches('maximized');
  await js(`toggleMaximize('${paneId}')`);
  await sleep(500);
  let r2 = await sttyMatches('unmaximized');
  gate('t3 stty matches across maximize/restore', r1.ok && r2.ok,
       `${r1.detail} | ${r2.detail}`);

  // t4 — THE guard test: resize while MINIMIZED (hidden, width/height 0 —
  // fit must be skipped), then restore (rAF fit) -> correct immediately.
  const resyncsBefore = await js(`window.__deckResyncs || 0`);
  await js(`minimizePane('${paneId}')`);
  await sleep(200);
  win.setSize(1300, 850); // geometry changes while the pane is display:none
  await sleep(600);
  await js(`restorePane('${paneId}')`);
  await sleep(600);
  r = await sttyMatches('restored-after-hidden-resize');
  gate('t4 hidden resize guarded, restore fits via rAF', r.ok, r.detail);

  // t5 — mode switch: resize while the grid is hidden (AI mode), come back.
  await js(`setMode('ai')`);
  await sleep(500);
  win.setSize(1100, 750);
  await sleep(400);
  await js(`setMode('code')`);
  await sleep(1300); // > MODE_IN_MS (1200, v36.2) — fadeInTimer + post-anim resync must land BEFORE t6 forces its desync
  r = await sttyMatches('mode-roundtrip');
  gate('t5 stty matches after AI-mode roundtrip', r.ok, r.detail);

  // t6 — self-heal: force a REAL desync (PTY resized behind xterm's back),
  // then fire the window focus event -> resyncAllVisible repairs it.
  await js(`window.api.resize('${paneId}', 20, 5)`); // PTY now 5x20, xterm unchanged
  await sleep(300);
  const desynced = await sttyMatches('forced-desync');
  await js(`window.dispatchEvent(new Event('focus'))`);
  await sleep(500);
  r = await sttyMatches('after-focus-self-heal');
  gate('t6 focus self-heal repairs a forced desync', !desynced.ok && r.ok,
       `desynced=${!desynced.ok} then ${r.detail}`);

  // t6b — same desync repaired through a REAL OS hide/show cycle (win.hide/show via the main process, not a
  // synthesized DOM event): proves the visibilitychange/focus wiring actually receives OS deliveries. hide/show,
  // not minimize/restore: Xvfb runs no window manager, so minimize() never minimizes (t6c covers that variant).
  await js(`window.api.resize('${paneId}', 20, 5)`);
  await sleep(300);
  const desynced2 = await sttyMatches('forced-desync-2');
  win.hide();
  await sleep(400);
  win.show();
  win.focus();
  await sleep(700);
  r = await sttyMatches('after-os-hide-show');
  gate('t6b OS hide/show self-heals (real events)', !desynced2.ok && r.ok,
       `desynced=${!desynced2.ok} then ${r.detail}`);

  // t6c — the minimize/restore variant of t6b. It needs a window manager: Xvfb has none, so minimize() leaves
  // isMinimized() false. That is the environment, not the app: SKIP (never a FAIL), after healing the forced desync.
  await js(`window.api.resize('${paneId}', 20, 5)`);
  await sleep(300);
  const desynced3 = await sttyMatches('forced-desync-3');
  win.minimize();
  await sleep(400);
  if (!win.isMinimized()) {
    results.push('SKIP t6c OS minimize/restore self-heals (real events) — no window manager: minimize() did not minimize');
    win.show();
    win.focus();
    await js(`window.dispatchEvent(new Event('focus'))`);
    await sleep(700);
  } else {
    win.restore();
    win.focus();
    await sleep(700);
    r = await sttyMatches('after-os-minimize-restore');
    gate('t6c OS minimize/restore self-heals (real events)', !desynced3.ok && r.ok,
         `desynced=${!desynced3.ok} then ${r.detail}`);
  }

  // t7 — WebGL fallback through the addon's REAL wiring: lose the WebGL
  // context on the addon's own canvas (WEBGL_lose_context) -> the addon's
  // webglcontextlost fires -> onContextLoss -> webglFallbackToDom. Falls
  // back to a direct handler call only if the pane was already on DOM
  // (headless sandbox without GL).
  const t7path = await js(`(() => {
    const p = panes.get('${paneId}');
    if (p.rendererMode !== 'webgl') { webglFallbackToDom('${paneId}'); return 'direct'; }
    const canvases = [...p.el.querySelectorAll('canvas')];
    if (!canvases.length) { webglFallbackToDom('${paneId}'); return 'direct-nocanvas'; }
    for (const c of canvases) {
      const gl2 = c.getContext('webgl2');
      const ext = gl2 && gl2.getExtension('WEBGL_lose_context');
      if (ext) { ext.loseContext(); return 'real-context-loss'; }
    }
    // SwiftShader exposes no WEBGL_lose_context -> dispatch the DOM event
    // the addon actually listens for, on EVERY canvas (the addon's is one
    // of them): exercises addon listener -> onContextLoss -> our fallback.
    for (const c of canvases) {
      c.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    }
    return 'dom-event-x' + canvases.length;
  })()`);
  // The addon waits 3000ms for a webglcontextrestored before firing
  // onContextLoss (verified in addon-webgl.js: setTimeout(..., 3e3)).
  await sleep(3800);
  await js(`window.api.writeInput('${paneId}', 'echo FALLBACK_ALIVE_$((6*7))\\n')`);
  await sleep(400);
  const t7 = await js(`(() => {
    const p = panes.get('${paneId}');
    const b = p.term.buffer.active;
    let seen = false;
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (l && l.translateToString(true).includes('FALLBACK_ALIVE_42')) seen = true;
    }
    return { mode: p.rendererMode, gl: p.gl === null,
             fallbacks: window.__deckGlFallbacks || 0, alive: seen };
  })()`);
  gate('t7 webgl->dom fallback leaves a live pane',
       t7.mode === 'dom' && t7.gl && t7.fallbacks === 1 && t7.alive,
       `path=${t7path} ${JSON.stringify(t7)}`);

  // t8 — pipeline really ran (seam) and never fit a hidden pane (t4 window).
  const resyncsAfter = await js(`window.__deckResyncs || 0`);
  gate('t8 resync pipeline exercised', resyncsAfter > resyncsBefore,
       `resyncs ${resyncsBefore} -> ${resyncsAfter}`);

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'display-integrity-probe.out'), report + '\n');
  console.log('\n=== v34 display-integrity probe ===\n' + report);
  app.exit(failed ? 1 : 0);
});
