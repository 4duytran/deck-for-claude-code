// test/mode-switch-probe.js — E2E probe: v27 animated mode switch
// ("fade-through" — DOM-only motion, native show/hide inside the dark gap).
//   t1 code->ai is STAGED: right after the click the dataset is still 'code'
//      (fade-out in flight), the body carries .mode-fade-out, the AI tab is
//      already active (immediate header feedback), the view is still hidden.
//   t2 after the fade window: dataset='ai', view visible, fade class gone.
//   t3 native bounds NOT skewed by the transform: getBounds() must equal the
//      placeholder rect (the animated #grid/#sidebar never touch #ai-frame).
//   t4 ai->code is SYNCHRONOUS (openPane mode-guard contract, v19): the same
//      executeJavaScript that clicks reads dataset 'code' + .mode-fade-in;
//      the view hides at once; the class self-cleans after MODE_IN_MS.
//   t5 cancel mid-fade: ai click then code click 50ms later -> data-mode
//      NEVER reaches 'ai' (MutationObserver log), the view never shows.
//   t6 no residual lock: a final toggle to AI still lands (switching reset).
// Run: cd claude-deck && npx electron test/mode-switch-probe.js
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Fake claude.ai over HTTP — instant responses (no race under test here).
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html data-mode="dark"><head><meta charset="utf-8">' +
    '<title>fake-claudeai</title></head><body>ok</body></html>');
});

// CRITICAL ORDER: main.js const-captures AI_URL at load time — the server
// must be listening (port known, env set) BEFORE require(main.js).
let base = null;
const serverReady = new Promise((r) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.CLAUDE_DECK_AI_URL = `${base}/`; // DIRECT assignment, pre-require
  require(path.join(__dirname, '..', 'main.js'));
  // Isolate ALL storage (the persist:claudeai partition lives under
  // userData): a probe must NEVER share ~/.config/claude-deck with a live
  // deck — two instances on one profile = LevelDB lock contention
  // (incident 2026-06-04: blanked the user's running AI view).
  require('electron').app.setPath('userData',
    fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
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

    results.setup_url_seam_effective = process.env.CLAUDE_DECK_AI_URL === `${base}/`;

    // Log every data-mode flip — lets t5 prove 'ai' NEVER appeared.
    await j(`(() => {
      window.__modeLog = [document.body.dataset.mode];
      new MutationObserver(() =>
        window.__modeLog.push(document.body.dataset.mode || 'code'))
        .observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
      return true;
    })()`);

    // t1 — click AI, read the staged state in the SAME script (same tick).
    const t1 = await j(`(() => {
      document.getElementById('mode-ai').click();
      return {
        mode: document.body.dataset.mode || 'code',
        fadeOut: document.body.classList.contains('mode-fade-out'),
        tabAi: document.getElementById('mode-ai').classList.contains('active'),
      };
    })()`);
    const noViewYet = win.contentView.children.length === 0;
    results.diag_t1 = { ...t1, noViewYet };
    results.t1_fade_out_staged =
      t1.mode === 'code' && t1.fadeOut === true && t1.tabAi === true && noViewYet === true;

    // t2 — after fade (130ms) + load + skin reveal: committed and visible.
    await sleep(900);
    const view = win.contentView.children[0];
    const t2 = await j(`(() => ({
      mode: document.body.dataset.mode,
      fadeOut: document.body.classList.contains('mode-fade-out'),
    }))()`);
    results.diag_t2 = { ...t2, visible: view && view.getVisible() };
    results.t2_committed_and_revealed =
      t2.mode === 'ai' && t2.fadeOut === false && view.getVisible() === true;

    // t3 — bounds skew check: native bounds === placeholder rect (rounded).
    const rect = await j(`(() => {
      const r = document.getElementById('ai-frame').getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y),
               width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    const b = view.getBounds();
    results.diag_t3 = { rect, bounds: b };
    results.t3_bounds_not_skewed =
      b.x === rect.x && b.y === rect.y &&
      b.width === rect.width && b.height === rect.height &&
      rect.width > 0 && rect.height > 0;

    // t4 — ai->code: swap is synchronous, fade-in runs then self-cleans.
    const t4 = await j(`(() => {
      document.getElementById('mode-code').click();
      return {
        mode: document.body.dataset.mode,                            // same tick!
        fadeIn: document.body.classList.contains('mode-fade-in'),
      };
    })()`);
    await sleep(60);
    const hiddenAtOnce = view.getVisible() === false;
    await sleep(1300); // > MODE_IN_MS (1200, v36.2: 300ms delay + 850ms slide-in)
    const t4b = await j(`(() => ({
      fadeIn: document.body.classList.contains('mode-fade-in'),
      fadeOut: document.body.classList.contains('mode-fade-out'),
    }))()`);
    results.diag_t4 = { ...t4, hiddenAtOnce, after: t4b };
    results.t4_return_synchronous_and_clean =
      t4.mode === 'code' && t4.fadeIn === true && hiddenAtOnce === true &&
      t4b.fadeIn === false && t4b.fadeOut === false;

    // t5 — cancel mid-fade: ai then code 50ms later; 'ai' must never commit.
    await j(`window.__modeLog = [document.body.dataset.mode]; true`);
    await j(`document.getElementById('mode-ai').click(); true`);
    await sleep(50); // well inside the 400ms fade-out window (v36)
    await j(`document.getElementById('mode-code').click(); true`);
    await sleep(550); // > MODE_OUT_MS (400) + margin
    const t5 = await j(`(() => ({
      mode: document.body.dataset.mode,
      log: window.__modeLog,
      tabCode: document.getElementById('mode-code').classList.contains('active'),
      fadeOut: document.body.classList.contains('mode-fade-out'),
    }))()`);
    results.diag_t5 = { ...t5, viewVisible: view.getVisible() };
    results.t5_cancel_never_shows_ai =
      t5.mode === 'code' && !t5.log.includes('ai') && t5.tabCode === true &&
      t5.fadeOut === false && view.getVisible() === false;

    // t6 — no residual lock: a normal switch to AI still works after t5.
    await j(`document.getElementById('mode-ai').click(); true`);
    await sleep(550); // > MODE_OUT_MS (400) + margin
    const t6mode = await j(`document.body.dataset.mode`);
    results.diag_t6 = { mode: t6mode, visible: view.getVisible() };
    results.t6_no_residual_lock = t6mode === 'ai' && view.getVisible() === true;

    // t7 — row 19 (L12a): an open Room panel rides the mode switch on the same 350 ms ease-in as #grid / #sidebar,
    // although its own close transition is on --dur-pop; the body.mode-fade-* scope pins the timing back.
    const t7 = await j(`(() => {
      const p = document.getElementById('room-panel');
      const wasHidden = p.hidden;
      p.hidden = false;
      p.classList.add('open');
      const read = (cls) => {
        document.body.classList.add(cls);
        const cs = getComputedStyle(p);
        const r = { dur: cs.transitionDuration, fn: cs.transitionTimingFunction };
        document.body.classList.remove(cls);
        return r;
      };
      const out = read('mode-fade-out');
      const inn = read('mode-fade-in');
      const grid = getComputedStyle(document.getElementById('grid')).transitionDuration;
      p.classList.remove('open');
      p.hidden = wasHidden;
      return { out, inn, grid };
    })()`);
    results.diag_t7 = t7;
    results.t7_room_mode_fade_timing =
      t7.out.dur === '0.35s, 0.35s' && t7.out.dur === t7.grid && t7.out.fn === 'ease-in, ease-in' && t7.inn.dur === '0.35s, 0.35s';
  } catch (err) {
    results.error = String((err && err.stack) || err);
  } finally {
    try { server.close(); } catch (_) { /* cleanup */ }
    const tKeys = Object.keys(results).filter((k) => /^(t\d|setup)/.test(k));
    const pass = !results.error && tKeys.length > 0 && tKeys.every((k) => results[k] === true);
    console.log(JSON.stringify({ pass, results }, null, 2));
    app.exit(pass ? 0 : 1);
  }
});
});
