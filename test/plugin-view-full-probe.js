'use strict';
// plugin-view-full-probe — daily-brief-v3 step D6: the report « Plein écran » / « Réduire » control of the Plugins panel (S10).
// The REAL app boots over throwaway fixtures: one plugin folder with one finished run whose report page is this probe's OWN fixture.
// Every click is a trusted mouse event at the centre of the control; Escape is a trusted key event. The report frame is read through WebFrameMain.
//   f5 (measured FIRST, reported verbatim as « F5 MEASURE: … ») Escape typed with the focus INSIDE the report frame: does the full screen exit?
//      The key is sent by two routes (webContents.sendInputEvent, then CDP Input.dispatchKeyEvent); a route counts only when a keydown
//      listener installed in the frame saw the key, so a key that never reached the frame cannot pass for one typed there.
//   f1 « Plein écran » shown only while #plg-view holds a report frame, aria-pressed false
//   f2 a click: #plg-view rect equals the window content rect, label « Réduire », aria-pressed true, the frame is the same element and URL (no reload)
//   f3 « Réduire » and Escape (focus on the Deck) restore the default rect; with a card open Escape closes the card only, then full screen,
//      then the panel
//   f4 prefers-reduced-motion: reduce emulated (Emulation.setEmulatedMedia): the switch is instant, never an animation, never an in-between
//      rect; without it an animation runs (transform / opacity only), passes through in-between rects and ends at the target rect
//   f6 BrowserWindow.isFullScreen() false at every sampling, full screen reached meanwhile; plugin-full.js uses no OS fullscreen API
//   f7 opening the Room while full screen leaves no fullscreen class, and a reopened panel is back to the default rect
//   f8 the report frame sandbox is exactly « allow-scripts », in full screen too; one sandbox assignment in the renderer modules
//   f9 no HTML sink in renderer/js/plugin-panel.js (code only; re-homed from the retired plugin-theme-ui-probe u5, whose diff half is dropped)
// Run (from the repo root): env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//   xvfb-run -a node_modules/.bin/electron test/plugin-view-full-probe.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const REPO = path.join(__dirname, '..');
const NAMES = ['f1_button_only_with_a_frame', 'f2_enter_fills_window_no_reload', 'f3_reduire_and_escape_restore', 'f4_reduced_motion_instant_else_animated',
  'f5_escape_inside_the_frame', 'f6_os_fullscreen_untouched', 'f7_other_surface_clears_fullscreen', 'f8_sandbox_allow_scripts',
  'f9_no_html_sink_in_plugin_panel'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const detail = {};
let finished = false;

const REPORT_HTML = '<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><title>Rapport de la sonde plein écran</title>'
  + '<style>body{margin:0;padding:24px;background:#F4F5F7;color:#111827;font-family:sans-serif}</style></head>'
  + '<body tabindex="-1"><p>Rapport factice de la sonde plein écran</p></body></html>\n';
const PLUGIN_ID = 'full-fixture';

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-view-full-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), plugins: path.join(root, 'plugins'), home: path.join(root, 'home'), projects: path.join(root, 'projects'),
    ask: path.join(root, 'ask'), status: path.join(root, 'status'), sh: path.join(root, 'sh') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const dir = path.join(dirs.plugins, PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id: PLUGIN_ID, label: 'Rapport plein écran', description: 'Fixture de la sonde plein écran.',
    argv: ['run.sh'], trigger: 'manual', env: [] }));
  // the plugin stays disabled (no state): the host never runs it and never reads a shell; this stub only guards that promise
  fs.writeFileSync(path.join(dirs.sh, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const reports = require(path.join(REPO, 'src', 'main', 'plugin-reports.js')).create(path.join(dirs.ud, 'plugin-data'), () => Date.parse('2026-11-02T09:00:00'));
  const entry = reports.newEntry(PLUGIN_ID, 'manual');
  fs.writeFileSync(entry.reportPath, REPORT_HTML);
  reports.finishEntry(PLUGIN_ID, entry.stem, { exit: 0 });
  return dirs;
}

function verdict(code) {
  if (finished) return;
  finished = true;
  for (const n of NAMES) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}${results[n] ? '' : ` ${JSON.stringify(detail[n])}`}`);
  const bad = NAMES.filter((k) => !results[k]);
  console.log(bad.length ? `VERDICT: RED (${NAMES.length - bad.length}/${NAMES.length} green) FAIL: ${bad.join(', ')}` : `VERDICT: ALL GREEN (${NAMES.length}/${NAMES.length})`);
  app.exit(code !== undefined ? code : (bad.length ? 1 : 0));
}

function boot() {
  const dirs = buildFixtures();
  app.setPath('userData', dirs.ud);
  process.env.HOME = dirs.home;
  Object.assign(process.env, {
    CLAUDE_DECK_BIN: '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: dirs.projects, CLAUDE_DECK_ASK_DIR: dirs.ask, CLAUDE_DECK_STATUS_DIR: dirs.status,
    CLAUDE_DECK_PLUGINS_DIR: dirs.plugins, CLAUDE_DECK_PLUGINS_NOW: '2026-11-03T09:00:00', CLAUDE_DECK_PLUGINS_SHELL: path.join(dirs.sh, 'bash'),
  });
  for (const k of ['CLAUDE_DECK_PRICES_URL', 'CLAUDE_DECK_COMMANDS_URL']) {
    process.env[k] ||= 'http://127.0.0.1:1';
  }
  require(path.join(REPO, 'main.js'));
  app.whenReady().then(() => run(dirs)).catch((err) => {
    console.log(`FAIL probe crashed: ${err && err.stack}`);
    verdict(2);
  });
}

async function run() {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 170 s' }; }
    verdict(2);
  }, 170000);
  watchdog.unref();

  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.plg)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
  const rend = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f.url.startsWith('deckpage://'));
  const waitFor = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return true; await sleep(100); }
    return false;
  };
  const click = async (sel) => {
    const c = await rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect();`
      + ' return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width };');
    if (!c || !(c.w > 0)) return false;
    wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    return true;
  };
  // Escape with the focus on the Deck document (the panel itself)
  const escDeck = async () => {
    await rend("document.getElementById('plugin-panel').focus(); return true;");
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(650);
  };
  const near = (a, b) => Math.abs(a - b) <= 1;
  const sameRect = (a, b) => near(a.l, b.l) && near(a.top, b.top) && near(a.w, b.w) && near(a.h, b.h);
  let sawFull = false;
  const fsLog = [];
  const st = async () => {
    const s = await rend(`const p = document.getElementById('plugin-panel'), v = document.getElementById('plg-view'), b = document.getElementById('plg-full'); const r = v.getBoundingClientRect();
      return { open: window.plg.open, cls: p.classList.contains('plg-fullscreen'), rect: { l: r.left, top: r.top, w: r.width, h: r.height }, win: { w: innerWidth, h: innerHeight },
        pos: getComputedStyle(v).position, frames: v.querySelectorAll('iframe').length, anims: v.getAnimations().length, card: !!window.plg.card, docFs: document.fullscreenElement !== null,
        btn: b ? { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), vis: b.getClientRects().length > 0, inView: v.contains(b) } : null };`);
    if (s.cls) sawFull = true;
    fsLog.push(win.isFullScreen() || s.docFs);
    return s;
  };
  const winRect = (s) => ({ l: 0, top: 0, w: s.win.w, h: s.win.h });
  const isWin = (s) => sameRect(s.rect, winRect(s));
  // K5: the panel opens on the list page; the report frame mounts only once a pick opens the detail (Rapport tab: the latest run has a report).
  const openDetail = async (id = PLUGIN_ID) => {
    const sel = `#plg-list .plg-row[data-id="${id}"] [data-act="pick"]`;
    if (!(await waitFor(() => rend(`const n = document.querySelector(${JSON.stringify(sel)}); return !!n && n.getClientRects().length > 0;`)))) return false;
    await click(sel);
    return waitFor(() => rend("return document.getElementById('plugin-panel').dataset.page === 'detail';"));
  };
  const openPanel = async () => {
    await click('#plugin-toggle');
    await sleep(900); // the entrance timer of the overlay
    if (!(await waitFor(() => rend('return plg.open === true;')))) return false;
    if (!(await openDetail())) return false;
    return waitFor(async () => frames().length === 1);
  };
  // The starting state of a measure: panel open, the detail page of PLUGIN_ID on its Rapport tab, one report frame. One Escape steps back one level
  // (full window, detail page, list page, panel), and the push and the keydown of the same key can step two (the Deck document sees the key of the
  // sendInputEvent route as well): from any of those levels, bring the state back. openPanel() clicks the toggle, so it only runs on a closed panel.
  const restoreDetail = async () => {
    const s = await st();
    if (!s.open) return openPanel();
    const page = await rend("return document.getElementById('plugin-panel').dataset.page;");
    if (page !== 'detail' && !(await openDetail())) return false;
    if (!(await waitFor(async () => frames().length === 1, 1500))) await click('#plg-tab-report');
    return waitFor(async () => frames().length === 1);
  };
  const gate = async (name, fn) => {
    try {
      const d = await fn();
      results[name] = d.ok === true;
      detail[name] = d;
    } catch (err) {
      results[name] = false;
      detail[name] = { threw: String(err && err.stack || err).slice(0, 400) };
    }
  };

  const opened = await openPanel();
  if (!opened) { // a half-open start (no panel, no detail page or no report frame) would fail every gate for a reason that is not theirs
    for (const n of NAMES) { results[n] = false; detail[n] = { opened: false, why: 'the initial openPanel() did not reach the panel open on the detail page with one report frame', state: await st().catch(() => null) }; }
    clearTimeout(watchdog);
    verdict(2);
    return;
  }
  let s0 = await st();
  const defRect = s0.rect;

  // ---- f5, measured first ---------------------------------------------------------------------------------------
  await gate('f5_escape_inside_the_frame', async () => {
    const entered = await click('#plg-full');
    await sleep(700);
    const inFull = await st();
    const cdp = (m, p) => wc.debugger.sendCommand(m, p);
    const cdpKey = (type) => cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    win.focus();
    wc.focus();
    // Before each route: full screen on, a key recorder in the frame and one in the Deck, the focus inside the frame by the first method that works.
    const arm = async (wantFull = true) => {
      // the previous route's Escape may have stepped back to the list page or closed the panel: restore the detail page and its frame first
      if (!(await restoreDetail())) throw new Error(`arm: the panel, detail page and report frame were not restored: ${JSON.stringify(await st())}`);
      const s = await st();
      if (wantFull && !s.cls) { await click('#plg-full'); await sleep(700); }
      const f = frames()[0];
      await f.executeJavaScript('window.__keys = []; if (!window.__rec) { window.__rec = true; window.addEventListener("keydown", (e) => window.__keys.push(e.key), true); } document.body.focus(); true');
      await rend('window.__deckKeys = []; if (!window.__deckRec) { window.__deckRec = true; document.addEventListener("keydown", (e) => window.__deckKeys.push(e.key), true); } return true;');
      const has = () => f.executeJavaScript('document.hasFocus()').catch(() => false);
      const tried = [];
      await rend("document.querySelector('#plg-view iframe').focus(); return true;");
      await sleep(200);
      tried.push(['iframe.focus()', await has()]);
      if (!tried[0][1]) {
        const c = await rend("const r = document.querySelector('#plg-view iframe').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
        for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await sleep(200);
        tried.push(['cdp click', await has()]);
      }
      return { f, tried, focused: tried.some((t) => t[1]) };
    };
    const routes = [];
    const routeList = [
      ['sendInputEvent', async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); }],
      ['cdp', async () => { await cdpKey('rawKeyDown'); await cdpKey('keyUp'); }],
    ];
    let focused = false;
    // main side: the Escape keydowns the Deck webContents reports to before-input-event (the push 'plugin-view-escape' hangs off it)
    let mainSaw = 0;
    const onBei = (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') mainSaw++; };
    wc.on('before-input-event', onBei);
    for (const [route, send] of routeList) {
      const a = await arm();
      focused = a.focused;
      mainSaw = 0;
      await send();
      await sleep(600);
      const s = await st();
      const frameKeys = await a.f.executeJavaScript('window.__keys.length').catch(() => -1);
      const deckKeys = await rend('return window.__deckKeys.length;');
      routes.push({ route, focusTried: a.tried, frameKeys, deckKeys, mainSaw, full: s.cls, open: s.open });
      if (frameKeys > 0) break;
    }
    const delivered = routes.find((r) => r.frameKeys > 0);
    const exited = !!delivered && delivered.full === false;
    // Escape typed in the frame OUTSIDE full screen: nothing happens (still not full, the panel stays open, same rect)
    let idle = null;
    if (delivered) {
      const a = await arm(false);
      mainSaw = 0;
      await routeList.find(([r]) => r === delivered.route)[1]();
      await sleep(600);
      const s = await st();
      idle = { frameKeys: await a.f.executeJavaScript('window.__keys.length').catch(() => -1), mainSaw, full: s.cls, open: s.open, same: sameRect(s.rect, defRect) };
    }
    wc.off('before-input-event', onBei);
    const idleOk = !!idle && idle.frameKeys > 0 && idle.full === false && idle.open === true && idle.same === true;
    const measure = { entered, fullBefore: inFull.cls, frameFocused: focused, routes, idle, verdict: !delivered ? 'RED (no route delivered a keydown to the frame: inconclusive)' : !exited ? 'RED (Escape in the frame does not exit)' : !idleOk ? 'RED (Escape in the frame outside full screen changed the view)' : 'GREEN (Escape in the frame exits, and does nothing outside full screen)' };
    console.log(`F5 MEASURE: ${JSON.stringify(measure)}`);
    // leave in a known state: out of full screen, panel open, the Deck focused
    const restored = await restoreDetail(); // f1 needs the detail page and its frame, whatever level the last Escape stepped back to
    const s = await st();
    if (s.cls) { await click('#plg-full'); await sleep(650); }
    await rend("document.getElementById('plugin-panel').focus(); return true;");
    return { ok: entered && inFull.cls && exited && idleOk, restored, ...measure };
  });

  // ---- f1 ----------------------------------------------------------------------------------------------------
  await gate('f1_button_only_with_a_frame', async () => {
    const withFrame = await st();
    await click('#plg-tab-history');
    await sleep(500);
    const history = await st();
    await click('#plg-tab-report');
    const back = await waitFor(async () => (await st()).frames === 1);
    await sleep(300);
    const again = await st();
    const shown = (s) => !!s.btn && s.btn.vis && s.btn.text === 'Plein écran' && s.btn.pressed === 'false' && s.btn.inView;
    return { ok: opened && shown(withFrame) && !withFrame.cls && history.frames === 0 && !(history.btn && history.btn.vis) && back && shown(again),
      withFrame: withFrame.btn, history: { frames: history.frames, btn: history.btn }, again: again.btn };
  });

  // ---- f2 ----------------------------------------------------------------------------------------------------
  await gate('f2_enter_fills_window_no_reload', async () => {
    await rend(`window.__frameEl = document.querySelector('#plg-view iframe'); window.__mounts = 0;
      new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') window.__mounts++; }).observe(document.getElementById('plugin-panel'), { childList: true, subtree: true }); return true;`);
    const urlBefore = frames()[0] ? frames()[0].url : '';
    const clicked = await click('#plg-full');
    await sleep(700);
    const s = await st();
    const same = await rend("return { same: document.querySelector('#plg-view iframe') === window.__frameEl, mounts: window.__mounts };");
    const urlAfter = frames()[0] ? frames()[0].url : '';
    // the view is on top: the corners and the centre of the window all hit it (the header and the workspace are under)
    const covers = await rend(`const v = document.getElementById('plg-view'); const pts = [[6, 6], [innerWidth - 6, 6], [6, innerHeight - 6], [innerWidth - 6, innerHeight - 6], [Math.round(innerWidth / 2), Math.round(innerHeight / 2)]];
      return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && v.contains(e); });`);
    return { ok: clicked && s.cls && isWin(s) && covers.every(Boolean) && s.pos === 'fixed' && !!s.btn && s.btn.text === 'Réduire' && s.btn.pressed === 'true' && same.same && same.mounts === 0 && !!urlBefore && urlBefore === urlAfter,
      clicked, rect: s.rect, win: s.win, covers, btn: s.btn, same, urlBefore, urlAfter };
  });

  // ---- f3 (the panel is in full screen from f2) ------------------------------------------------------------------
  await gate('f3_reduire_and_escape_restore', async () => {
    const byButton = { clicked: await click('#plg-full') };
    await sleep(700);
    const a = await st();
    const aOk = byButton.clicked && !a.cls && sameRect(a.rect, defRect) && !!a.btn && a.btn.text === 'Plein écran' && a.btn.pressed === 'false';
    await click('#plg-full');
    await sleep(700);
    const inFull = await st();
    await escDeck();
    const b = await st();
    const bOk = inFull.cls && !b.cls && b.open && sameRect(b.rect, defRect) && !!b.btn && b.btn.text === 'Plein écran';
    // a card open: Escape closes the card only, then the full screen, then the panel
    await click('#plg-dhead .plg-del'); // « Supprimer » sits in the detail head
    const card = await waitFor(async () => rend("return !!(window.plg.card && window.plg.card.kind === 'delete');"));
    await click('#plg-full');
    await sleep(700);
    const c0 = await st();
    await escDeck();
    const c1 = await st();
    await escDeck();
    const c2 = await st();
    await escDeck(); // then the detail page: back to the list, the panel stays open
    const c3 = await st();
    const page3 = await rend("return document.getElementById('plugin-panel').dataset.page;");
    await escDeck();
    const c4 = await st();
    const cOk = card && c0.cls && c0.card && !c1.card && c1.cls && c1.open && !c2.cls && c2.open && sameRect(c2.rect, defRect) && c3.open && !c3.cls && page3 === 'list' && !c4.open;
    await openPanel(); // the next gates need the panel and its detail again
    return { ok: aOk && bOk && cOk, aOk, bOk, cOk, a: { cls: a.cls, rect: a.rect, btn: a.btn }, defRect, b: { cls: b.cls, rect: b.rect, open: b.open }, card, page3,
      c: [c0, c1, c2, c3, c4].map((x) => ({ cls: x.cls, card: x.card, open: x.open })) };
  });

  // ---- f4 ----------------------------------------------------------------------------------------------------
  await gate('f4_reduced_motion_instant_else_animated', async () => {
    const reduced = (v) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
    const record = async (fromRect, toRect) => {
      await rend(`window.__samples = []; const v = document.getElementById('plg-view'); const t0 = performance.now();
        window.__iv = setInterval(() => { const r = v.getBoundingClientRect(); const an = v.getAnimations();
          window.__samples.push({ at: Math.round(performance.now() - t0), n: an.length, l: r.left, top: r.top, w: r.width, h: r.height,
            keys: [...new Set(an.flatMap((a) => (a.effect ? a.effect.getKeyframes().flatMap((k) => Object.keys(k)) : [])))] }); }, 16); return true;`);
      await click('#plg-full');
      await sleep(900);
      const samples = await rend('clearInterval(window.__iv); return window.__samples;');
      const last = samples[samples.length - 1];
      const inter = samples.filter((x) => !sameRect(x, fromRect) && !sameRect(x, toRect));
      const keys = [...new Set(samples.flatMap((x) => x.keys))];
      return { n: samples.length, animSamples: samples.filter((x) => x.n > 0).length, inBetween: inter.length, ends: sameRect(last, toRect) && last.n === 0, keys };
    };
    const base = await st();
    const win = winRect(base);
    await reduced('no-preference');
    const animIn = await record(defRect, win);
    const animOut = await record(win, defRect);
    await reduced('reduce');
    const matches = await rend("return matchMedia('(prefers-reduced-motion: reduce)').matches;");
    const redIn = await record(defRect, win);
    const redOut = await record(win, defRect);
    await reduced('no-preference');
    const okKeys = (r) => r.keys.every((k) => ['transform', 'opacity', 'translate', 'scale', 'rotate', 'offset', 'easing', 'composite', 'computedOffset'].includes(k));
    const animated = (r) => r.animSamples > 0 && r.inBetween > 0 && r.ends && okKeys(r);
    const instantly = (r) => r.animSamples === 0 && r.inBetween === 0 && r.ends;
    return { ok: matches === true && animated(animIn) && animated(animOut) && instantly(redIn) && instantly(redOut), matches, animIn, animOut, redIn, redOut };
  });

  // ---- f7 ----------------------------------------------------------------------------------------------------
  await gate('f7_other_surface_clears_fullscreen', async () => {
    await click('#plg-full');
    await sleep(700);
    const inFull = await st();
    await rend("document.getElementById('room-toggle').click(); return true;");
    await sleep(700);
    const after = await st();
    const opened2 = await openPanel();
    await sleep(300);
    const reopened = await st();
    return { ok: inFull.cls && !after.cls && after.pos !== 'fixed' && !after.open && opened2 && !reopened.cls && sameRect(reopened.rect, defRect) && !!reopened.btn && reopened.btn.text === 'Plein écran',
      inFull: inFull.cls, after: { cls: after.cls, pos: after.pos, open: after.open }, reopened: { cls: reopened.cls, rect: reopened.rect, btn: reopened.btn }, defRect };
  });

  // ---- f8 (measured in full screen) -------------------------------------------------------------------------------
  await gate('f8_sandbox_allow_scripts', async () => {
    await click('#plg-full');
    await sleep(700);
    const inFull = await st();
    const sb = await rend("const f = document.querySelectorAll('#plg-view iframe'); return { n: f.length, attr: f[0] ? f[0].getAttribute('sandbox') : null, tokens: f[0] ? f[0].sandbox.length : -1 };");
    const code = (f) => (fs.existsSync(path.join(REPO, 'renderer', 'js', f)) ? fs.readFileSync(path.join(REPO, 'renderer', 'js', f), 'utf8') : '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const panel = code('plugin-panel.js');
    const full = code('plugin-full.js');
    const sandboxes = [...(panel + full).matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'/g)].map((m) => m[1]);
    await click('#plg-full');
    await sleep(700);
    return { ok: inFull.cls && sb.n === 1 && sb.attr === 'allow-scripts' && sb.tokens === 1 && full.length > 0 && sandboxes.length === 1 && sandboxes[0] === 'allow-scripts'
      && !/allow-same-origin/.test(panel + full) && !/\bsandbox\b/.test(full), inFull: inFull.cls, sb, sandboxes, fullModule: full.length > 0 };
  });

  // ---- f6 (reads what every sampling above saw) ---------------------------------------------------------------------
  await gate('f6_os_fullscreen_untouched', async () => {
    await st();
    const fullSrc = fs.existsSync(path.join(REPO, 'renderer', 'js', 'plugin-full.js')) ? fs.readFileSync(path.join(REPO, 'renderer', 'js', 'plugin-full.js'), 'utf8') : '';
    const panelSrc = fs.readFileSync(path.join(REPO, 'renderer', 'js', 'plugin-panel.js'), 'utf8');
    const api = /setFullScreen|setSimpleFullScreen|requestFullscreen|webkitRequestFullscreen/;
    return { ok: sawFull && fsLog.length >= 10 && fsLog.every((x) => x === false) && fullSrc.length > 0 && !api.test(fullSrc) && !api.test(panelSrc) && !win.isFullScreen(),
      sawFull, samples: fsLog.length, anyFullscreen: fsLog.some((x) => x), fullModule: fullSrc.length > 0 };
  });

  // ---- f9 (static, re-homed from the retired theme-ui u5) ---------------------------------------------------------------
  await gate('f9_no_html_sink_in_plugin_panel', async () => {
    const sink = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\bDOMParser\b|\beval\(/;
    const file = path.join(REPO, 'renderer', 'js', 'plugin-panel.js');
    const code = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''); // code only
    const control = ['el.innerHTML = x', 'el.outerHTML= x', 'el.insertAdjacentHTML(p, x)', 'document.write(x)', 'new DOMParser()', 'eval(x)'].every((s) => sink.test(s)); // the regex bites
    const hit = code.match(sink);
    return { ok: control && code.length > 0 && !hit, control, panelBytes: code.length, hit: hit ? hit[0] : null };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
