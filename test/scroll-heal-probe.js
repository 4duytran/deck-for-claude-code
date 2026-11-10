// scroll-heal-probe.js — regression guard for the chat<->terminal scroll bug.
//   Bug A: output written while .pane-term was display:none (chat face) grew
//          the buffer, but the native viewport.scrollTop stayed stale and
//          fit() is a no-op when cols/rows are unchanged -> the scrollbar lied
//          and the user "couldn't scroll lower". Fix: resyncPane heals the DOM
//          scrollTop to the bottom WHEN xterm's model is at the bottom.
//   Bug B: the WebGL addon's LinkRenderLayer canvas (.xterm-link-layer, z:2,
//          pointer-events:auto) covered the scrollbar gutter above the viewport
//          (z:1) -> the native scrollbar was undraggable. Fix: viewport z:3.
//
// REAL bash PTY (scrollback ground truth). FULL ISOLATION (incident rule
// 2026-06-04): HOME faked before main.js loads, userData on a mkdtemp.
// Run: ./node_modules/.bin/electron test/scroll-heal-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
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

  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`document.getElementById('ns-send').click()`);
  await sleep(1500);
  const paneId = await js(`[...panes.keys()][0]`);
  await js(`setChatView('${paneId}', false)`); // force terminal face
  await sleep(500);

  // Snapshot helper: viewport scroll geometry + scrollbar/text hit-tests.
  const SNAP = `(() => {
    const p = panes.get('${paneId}');
    const term = p.term;
    const vp = p.el.querySelector('.xterm-viewport');
    const xt = p.el.querySelector('.xterm');
    const r = vp.getBoundingClientRect();
    const clsOf = (el) => el ? (el.className && el.className.toString ? el.className.toString() : String(el.className)) : null;
    // scrollbar gutter: 5px from the right edge, vertical middle
    const sbHit = document.elementFromPoint(Math.round(r.right - 5), Math.round(r.top + r.height / 2));
    // text area: horizontal/vertical center
    const txHit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      rows: term.rows, cols: term.cols,
      baseY: term.buffer.active.baseY, viewportY: term.buffer.active.viewportY,
      scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
      maxScroll: vp.scrollHeight - vp.clientHeight,
      sbCls: clsOf(sbHit),
      txCls: clsOf(txHit),
      txInsideXterm: !!(txHit && txHit.closest && txHit.closest('.xterm') === xt),
      dpr: window.devicePixelRatio,
    };
  })()`;

  // Fill scrollback well past the viewport.
  await js(`window.api.writeInput('${paneId}', 'seq 1 300\\n')`);
  await sleep(900);
  const fresh = await js(SNAP);

  // s1 — Bug B: the scrollbar gutter hit-tests to the native viewport (the
  // z:2 link canvas no longer covers it) -> the bar is draggable.
  gate('s1 scrollbar gutter hits the viewport (draggable)',
       fresh.sbCls === 'xterm-viewport', `sbCls=${JSON.stringify(fresh.sbCls)}`);

  // s2 — a fresh terminal sitting at the bottom: scrollbar == real bottom.
  // tolerance < 1 CSS px: the residue is one device pixel at DPR 2 (fails
  // identically at e23f6ed, passes at DPR 1)
  gate('s2 fresh terminal scrollbar pinned to bottom',
       fresh.maxScroll - fresh.scrollTop < 1 && fresh.maxScroll > 0,
       `scrollTop=${fresh.scrollTop} maxScroll=${fresh.maxScroll} dpr=${fresh.dpr}`);

  // Switch to chat, grow the buffer WHILE the terminal is display:none, switch
  // back — the exact reported gesture.
  await js(`setChatView('${paneId}', true)`);
  await sleep(600);
  await js(`window.api.writeInput('${paneId}', 'seq 301 500\\n')`);
  await sleep(700);
  await js(`setChatView('${paneId}', false)`);
  await sleep(700); // resync (fit + scroll-heal) window
  const after = await js(SNAP);

  // s3 — Bug A: the healed scrollbar lands at the true bottom even though the
  // growth happened while hidden and cols/rows never changed.
  // tolerance < 1 CSS px: fractional device scale rounds scrollTop by a sub-pixel (measured dpr 2.4: +0.17 / +0.50); an unhealed bar is rows off
  gate('s3 scrollbar healed to bottom after hidden growth',
       Math.abs(after.maxScroll - after.scrollTop) < 1 && after.maxScroll > fresh.maxScroll,
       `scrollTop=${after.scrollTop} maxScroll=${after.maxScroll} (was ${fresh.maxScroll}) dpr=${after.dpr}`);

  // s4 — Bug B holds after the switch too.
  gate('s4 scrollbar still hits the viewport after switch',
       after.sbCls === 'xterm-viewport', `sbCls=${JSON.stringify(after.sbCls)}`);

  // s5 — selection is NOT broken by the raised viewport: a click in the text
  // area lands inside .xterm, so its mousedown bubbles to the root where
  // xterm's SelectionService is bound. Plus the selection API still returns.
  const selOk = await js(`(() => {
    const p = panes.get('${paneId}');
    p.term.clearSelection();
    p.term.selectAll();
    const s = p.term.getSelection();
    return !!(s && s.trim().length > 0);
  })()`);
  gate('s5 selection intact under raised viewport',
       after.txInsideXterm && selOk,
       `txCls=${JSON.stringify(after.txCls)} txInsideXterm=${after.txInsideXterm} selOk=${selOk}`);
  await js(`panes.get('${paneId}').term.clearSelection()`);

  // s6 — heal SAFETY: a user scrolled UP must NOT be snapped to the bottom by
  // a later resync (window resize). Scroll up, fire a resync, assert we stayed.
  await js(`(() => {
    const p = panes.get('${paneId}');
    p.term.scrollLines(-12); // viewportY = baseY - 12
  })()`);
  await sleep(120);
  const upBefore = await js(`(() => { const p = panes.get('${paneId}');
    return { vY: p.term.buffer.active.viewportY, bY: p.term.buffer.active.baseY }; })()`);
  await js(`resyncAllVisible()`); // simulate a window resize (exposed seam)
  await sleep(300);
  const upAfter = await js(`(() => { const p = panes.get('${paneId}');
    const vp = p.el.querySelector('.xterm-viewport');
    return { vY: p.term.buffer.active.viewportY, bY: p.term.buffer.active.baseY,
             top: vp.scrollTop, max: vp.scrollHeight - vp.clientHeight }; })()`);
  gate('s6 scrolled-up position survives a resync (no forced snap)',
       upBefore.vY < upBefore.bY && upAfter.vY === upBefore.vY && upAfter.top < upAfter.max,
       `before=${JSON.stringify(upBefore)} after=${JSON.stringify(upAfter)}`);

  // s7 — same hazard via minimize: a pane minimized (display:none) while output
  // streams, then restored, must also re-pin the scrollbar to the live bottom.
  // Reset to a clean bottom, minimize, grow the buffer, restore.
  await js(`panes.get('${paneId}').term.scrollToBottom()`);
  await sleep(120);
  await js(`minimizePane('${paneId}')`);
  await sleep(150);
  await js(`window.api.writeInput('${paneId}', 'seq 501 760\\n')`);
  await sleep(900);
  await js(`restorePane('${paneId}')`);
  await sleep(600); // rAF resync + one-shot stick
  const mr = await js(SNAP);
  // tolerance < 1 CSS px: fractional device scale rounds scrollTop by a sub-pixel (measured dpr 2.4: +0.17 / +0.50); an unhealed bar is rows off
  gate('s7 minimize->output->restore re-pins scrollbar to bottom',
       Math.abs(mr.maxScroll - mr.scrollTop) < 1 && mr.maxScroll > after.maxScroll,
       `scrollTop=${mr.scrollTop} maxScroll=${mr.maxScroll} (was ${after.maxScroll}) dpr=${mr.dpr}`);

  const report = results.join('\n');
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  fs.writeFileSync(path.join(__dirname, 'scroll-heal-probe.out'),
    report + `\n${pass}/${results.length} PASS\n`);
  console.log('\n=== scroll-heal probe ===\n' + report + `\n${pass}/${results.length} PASS`);
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('PROBE CRASH', e && e.stack ? e.stack : e);
  try { fs.writeFileSync(path.join(__dirname, 'scroll-heal-probe.out'),
    results.join('\n') + `\nPROBE CRASH ${e}\n`); } catch (_) {}
  app.exit(1);
});
