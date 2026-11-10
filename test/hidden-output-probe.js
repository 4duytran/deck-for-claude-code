// test/hidden-output-probe.js — REPRO probe for the user-reported bug:
// "Code -> AI -> (time passes, output arrives) -> back to Code: the bottom
// of the terminal is not visible".
// DIAGNOSTIC probe (P0.5 smoke + P2 bisection): three variants isolate the
// causal variable. PASS/FAIL here = "matches the EXPECTED-IF-BUG pattern",
// the JSON is the evidence either way.
//   a) control — AI roundtrip, NO output while hidden -> bottom must follow.
//   b) output while hidden — 300 lines printed while the grid is
//      display:none, then back -> does the viewport still follow the bottom
//      (viewportY === baseY)? is the END marker inside the rendered rows?
//   c) same + longer dwell (does time alone change anything?).
// Run: cd claude-deck && npx electron test/hidden-output-probe.js
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Fake claude.ai (CLAUDE_DECK_AI_URL seam) — the probe switches modes for real.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>ok</body></html>');
});
let base = null;
const serverReady = new Promise((r) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.CLAUDE_DECK_AI_URL = `${base}/`;
  // REAL shell in the PTY — without this seam the pane spawns the real
  // `claude` (alternate screen, input box) and the echo commands are TYPED,
  // not executed (first run of this probe: length stuck at 37, fake-green
  // marker matched against the typed command line).
  // v46.5: the deck passes --session-id on EVERY creation — shim drops argv.
  const SHELL_SHIM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shim-')), 'claude-shim.sh');
  fs.writeFileSync(SHELL_SHIM, '#!/bin/bash\nexec /bin/bash\n', { mode: 0o755 });
  process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
  process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ask-ho-')); // never the running deck's ask channel
  require(path.join(__dirname, '..', 'main.js'));
  require('electron').app.setPath('userData',
    fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-'))); // never share a live profile
  r();
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

serverReady.then(() => {
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const results = {};
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const j = (code) => win.webContents.executeJavaScript(code, true);

    // One real pane (bare bash).
    await j(`document.getElementById('new-session').click()`);
    await sleep(300);
    await j(`document.getElementById('ns-send').click()`);
    await sleep(1500); // spawn + bash prompt
    const paneId = await j(`[...panes.keys()][0]`);
    // v46.9: chat became the default face — this probe tests the TERMINAL
    // canvas/scroll: force the terminal face (after the auto-ON already ran).
    await j(`setChatView('${paneId}', false)`);
    await sleep(400); // RO refire + fit on the re-shown terminal

    // Scroll state + what the BOTTOM rendered row actually contains.
    const snap = (label) => j(`(() => {
      const p = panes.get('${paneId}');
      const b = p.term.buffer.active;
      const bottomRow = b.getLine(b.viewportY + p.term.rows - 1);
      return {
        label: '${label}',
        viewportY: b.viewportY, baseY: b.baseY, length: b.length,
        followsBottom: b.viewportY === b.baseY,
        bottomRowText: bottomRow ? bottomRow.translateToString(true).trim() : null,
      };
    })()`);

    const toAI = async () => { await j(`setMode('ai')`); await sleep(550); }; // > MODE_OUT_MS (400)
    const toCode = async () => { await j(`setMode('code')`); await sleep(1400); }; // > MODE_IN_MS (1200, v36.2) + resync

    // Marker search across the LAST viewport: is END visible on screen?
    const endVisible = (marker) => j(`(() => {
      const p = panes.get('${paneId}');
      const b = p.term.buffer.active;
      for (let i = b.viewportY; i < b.viewportY + p.term.rows; i++) {
        const l = b.getLine(i);
        if (l && l.translateToString(true).includes('${marker}')) return true;
      }
      return false;
    })()`);

    // ---- (a) control: roundtrip with NO output while hidden --------------
    await toAI();
    await sleep(400);
    await toCode();
    results.a_control = await snap('a-after-return');
    results.a_follows_bottom = results.a_control.followsBottom;

    // ---- (b) output while hidden ------------------------------------------
    await toAI();
    // 300 lines + marker, typed while the grid is display:none.
    await j(`window.api.writeInput('${paneId}',
      'for i in $(seq 1 300); do echo line-b-$i; done; echo END-B-STREAM\\n')`);
    await sleep(1200); // let the PTY flush into the hidden xterm
    results.b_hidden = await snap('b-while-hidden');
    await toCode();
    results.b_after = await snap('b-after-return');
    results.b_follows_bottom = results.b_after.followsBottom;
    results.b_end_marker_visible = await endVisible('END-B-STREAM');

    // ---- (d) PIXEL truth on the (b) scenario --------------------------------
    // The buffer can be perfect while the WebGL canvas shows a stale frame:
    // capture the pane region and measure how much of it is non-background
    // text. After 300 lines the screen MUST be dense top to bottom; a stale
    // canvas would still show the near-empty post-spawn frame.
    const paneDensity = async (label) => {
      const rect = await j(`(() => {
        const r = panes.get('${paneId}').el.querySelector('.pane-term').getBoundingClientRect();
        return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
      })()`);
      const img = await win.webContents.capturePage(rect);
      const { width, height } = img.getSize();
      const buf = img.toBitmap(); // BGRA
      const third = Math.floor(height / 3);
      const counts = [0, 0, 0]; const totals = [0, 0, 0];
      for (let yy = 0; yy < height; yy += 2) {
        const t = Math.min(2, Math.floor(yy / third));
        for (let xx = 0; xx < width; xx += 2) {
          const i = (yy * width + xx) * 4;
          const b = buf[i], g = buf[i + 1], rch = buf[i + 2];
          totals[t] += 1;
          // background is ~#0d1117 / #161b22 — anything notably brighter = text
          if (rch + g + b > 150) counts[t] += 1;
        }
      }
      return { label, width, height,
        topPct: +(100 * counts[0] / totals[0]).toFixed(2),
        midPct: +(100 * counts[1] / totals[1]).toFixed(2),
        botPct: +(100 * counts[2] / totals[2]).toFixed(2) };
    };
    results.d_pixels_after_return = await paneDensity('d-after-return-of-b');
    // 300 dense lines on screen: every third must carry visible text pixels.
    // 2026-09-18: top third given a 0.5 margin (was >1) — 11 runs (5 unpinned,
    // 6 with --force-device-scale-factor at 1/2/2.4) landed topPct 0.97,
    // midPct 1.09, botPct 1.46; a 12th (post-change validation) read botPct
    // 1.44 — +-0.02 scatter observed on botPct, topPct and midPct held. The
    // top third is structurally the sparsest (prompt/separator rows); pinning
    // the device scale was measured inert on this number. User decision.
    results.d_canvas_repainted = results.d_pixels_after_return.topPct > 0.5
      && results.d_pixels_after_return.midPct > 1
      && results.d_pixels_after_return.botPct > 1;

    // ---- (c) output + longer dwell ----------------------------------------
    await toAI();
    await j(`window.api.writeInput('${paneId}',
      'for i in $(seq 1 300); do echo line-c-$i; done; echo END-C-STREAM\\n')`);
    await sleep(4000); // "un peu de temps"
    results.c_hidden = await snap('c-while-hidden');
    await toCode();
    results.c_after = await snap('c-after-return');
    results.c_follows_bottom = results.c_after.followsBottom;
    results.c_end_marker_visible = await endVisible('END-C-STREAM');
    // ---- (e) PAGE-TRANSLATION truth — the screenshot shows the deck HEADER
    // missing and the legend cut: the whole PAGE looks shifted up, not the
    // terminal content. Classic xterm pitfall: the hidden helper textarea
    // tracks the cursor; focusing it can scrollIntoView the ROOT scroller
    // even under overflow:hidden. The user clicks the terminal after the
    // return — simulate exactly that and measure every scroller + header.y.
    const pageState = (label) => j(`(() => {
      const p = panes.get('${paneId}');
      const headerY = document.getElementById('app-header').getBoundingClientRect().y;
      const ta = p.el.querySelector('.xterm-helper-textarea');
      return {
        label: '${label}',
        headerY,
        docScroll: document.documentElement.scrollTop,
        bodyScroll: document.body.scrollTop,
        gridScroll: document.getElementById('grid').scrollTop,
        paneTermScroll: p.el.querySelector('.pane-term').scrollTop,
        taTop: ta ? ta.getBoundingClientRect().y : null,
      };
    })()`);
    results.e_before_focus = await pageState('e-before-focus');
    await j(`panes.get('${paneId}').term.focus()`);
    await sleep(150);
    results.e_after_focus = await pageState('e-after-focus');
    // Real click inside the terminal (what the user actually does).
    const r = await j(`(() => { const b = panes.get('${paneId}').el
      .querySelector('.pane-term').getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(200);
    results.e_after_click = await pageState('e-after-click');
    results.e_page_translated = results.e_after_focus.headerY < -1
      || results.e_after_click.headerY < -1
      || results.e_after_click.docScroll > 0 || results.e_after_click.bodyScroll > 0
      || results.e_after_click.paneTermScroll > 0;
    // ---- (f) window RESIZE while in AI mode — the untested variable --------
    // t5 (display-integrity) proves STTY matches after this exact flow, but
    // never measured the CANVAS: if fit() no-ops (same cols/rows) or the
    // renderer keeps the old pixel size, the canvas overflows the host and
    // the bottom rows get CLIPPED — which matches the screenshot exactly
    // (last line cut mid-pixel-height; xterm only paints whole rows).
    const geom = (label) => j(`(() => {
      const p = panes.get('${paneId}');
      const host = p.el.querySelector('.pane-term').getBoundingClientRect();
      const screen = p.el.querySelector('.xterm-screen');
      const sr = screen ? screen.getBoundingClientRect() : null;
      const canvas = p.el.querySelector('.xterm-screen canvas');
      const cr = canvas ? canvas.getBoundingClientRect() : null;
      return { label: '${label}',
        hostH: +host.height.toFixed(1), hostW: +host.width.toFixed(1),
        screenH: sr ? +sr.height.toFixed(1) : null,
        canvasH: cr ? +cr.height.toFixed(1) : null,
        rows: p.term.rows, cols: p.term.cols,
        overflowPx: sr ? +(sr.height - host.height).toFixed(1) : null };
    })()`);
    results.f_before = await geom('f-before-ai');
    await toAI();
    const [w0, h0] = win.getSize();
    win.setSize(w0, h0 - 220); // SHRINK while the grid is display:none
    await sleep(600);
    await j(`window.api.writeInput('${paneId}', 'echo END-F-STREAM\\n')`);
    await sleep(600);
    await toCode(); // rAF resync + RO flip + post-anim resync should all refit
    results.f_after = await geom('f-after-return');
    results.f_end_marker_visible = await endVisible('END-F-STREAM');
    // Clipped iff the rendered screen is taller than its host viewport.
    results.f_canvas_clipped = results.f_after.overflowPx !== null
      && results.f_after.overflowPx > 2;
    // ---- (g) viewport DETACHED before the switch — the reading scenario ----
    // ROOT CAUSE (reproduced 2026-06-05, pre-fix run): scrolled-up viewport +
    // output streamed while in AI mode -> xterm (standard) never force-scrolls
    // a detached viewport -> the return showed the OLD reading position with
    // the new content out of sight below (viewportY frozen 550, baseY 682).
    // v38 fix: outputWhileAi flag -> scrollToBottom on the return's first
    // visible frame. This gate now asserts the FIX.
    await j(`panes.get('${paneId}').term.scrollLines(-30)`); // read mode
    results.g_detached_before = await snap('g-detached-before-ai');
    await toAI();
    await j(`window.api.writeInput('${paneId}',
      'for i in $(seq 1 100); do echo line-g-$i; done; echo END-G-STREAM\\n')`);
    await sleep(1200);
    await toCode();
    results.g_after = await snap('g-after-return');
    results.g_end_marker_visible = await endVisible('END-G-STREAM');
    results.g_fix_rejoins_bottom = results.g_detached_before.followsBottom === false
      && results.g_after.followsBottom === true
      && results.g_end_marker_visible === true;

    // ---- (g2) detached + NO output while hidden — fix must NOT fire --------
    // A pane that received nothing keeps the reading position untouched:
    // proves the scroll is keyed on outputWhileAi, not on the mode switch.
    await j(`panes.get('${paneId}').term.scrollLines(-30)`);
    results.g2_detached_before = await snap('g2-detached-before-ai');
    await toAI();
    await sleep(800); // dwell, zero output
    await toCode();
    results.g2_after = await snap('g2-after-return');
    results.g2_reading_position_kept = results.g2_detached_before.followsBottom === false
      && results.g2_after.followsBottom === false
      && results.g2_after.viewportY === results.g2_detached_before.viewportY;
  } catch (err) {
    results.error = String(err && err.stack || err);
  }

  // Post-fix semantics: a..f assert the pipeline stays structurally sound
  // (those bug flags must stay quiet), g/g2 assert the v38 fix + its scoping.
  const pass = results.a_follows_bottom === true
    && results.b_follows_bottom === true && results.b_end_marker_visible === true
    && results.c_follows_bottom === true && results.c_end_marker_visible === true
    && results.d_canvas_repainted === true
    && results.e_page_translated === false
    && results.f_canvas_clipped === false
    && results.g_fix_rejoins_bottom === true
    && results.g2_reading_position_kept === true
    && !results.error;
  console.log(JSON.stringify({ pass, results }, null, 2));
  server.close();
  app.exit(pass ? 0 : 1);
});
});
