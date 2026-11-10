'use strict';
// plans-view-full-probe — plans-html-fullscreen: the « Plein écran » / « Réduire » control of the HTML plan view of the Plans tab
// (#pp-view holding the closed deckpage:// frame), mirror of the report full screen of the Plugins panel (plugin-view-full-probe).
// The REAL app boots over throwaway fixtures: one session with two .html FILE plans and one markdown plan. Every click is a trusted
// mouse event at the centre of the control (webContents.sendInputEvent). Each gate prints `OK <name> <detail>` or `FAIL <name> <detail>`.
//   a_button_only_on_html_plan  (DoD 2a) an .html FILE plan shown: « Plein écran » visible inside #pp-view, aria-pressed false; a markdown plan: no visible button
//   b_enter_fills_window        (DoD 2b) click: the plan iframe rect equals innerWidth x innerHeight (+-1 px), label « Réduire », aria-pressed true,
//                               the frame is the same element and URL (no re-mount), the window corners hit the view (above the header)
//   b2_enter_with_sp_max        #side-panel.sp-max (separate existing mode) still works: full screen over it, and back to the maximized rect
//   c_reduire_restores          (DoD 2c) click again: the iframe rect is back inside #side-panel, label « Plein écran », aria-pressed false
//   m_motion_family_and_reduced enter glides 280 ms (--dur-drawer) from opacity 0.5, exit 200 ms (--dur-pop), transform / opacity only, instant under reduced motion
//   f_every_exit_resets         (DoD 2f) another plan, a markdown plan, another side-panel tab, the panel closed: full screen off, no ...fullscreen class left,
//                               and a reopened panel is back to the default rect
//   d_escape_order              (DoD 2d) Escape with the focus in the Deck: full screen off and the panel still open, the next Escape closes the panel
//   d2_escape_order_sp_max      (DoD 2d) with #side-panel.sp-max: full screen off, then max restored, then the panel closed, one step per Escape
//   d3_escape_popup_first       (DoD 2d) an open ask composer keeps its own Escape first: popup closed (full screen still on), then full screen off
//   e_escape_inside_frame       (DoD 2e) Escape typed with the focus INSIDE the plan frame (trusted key event): full screen off, one step only;
//                               outside full screen it changes nothing
//   g_chip_and_ask_above_view   (DoD 2g) in full screen (and over sp-max): the « Demander à Claude » chip, then the popup it opens, are the
//                               elementFromPoint hit at their own centre, the chip click opens the ask and the send reaches the session
//   g2_dock_above_view          (DoD 2g) the answers dock #pp-asks, when not hidden, is the hit at its own centre, inside the window; docked again after « Réduire »
//   u2_os_window_stays_windowed (U2) entering full screen never puts the OS window in full screen: BrowserWindow.isFullScreen() false and the window bounds
//                               unchanged in main, document.fullscreenElement null in the renderer, before, during and after
//   d4_escape_popup_in_workspace (OE1) over #side-panel.sp-max (which hides #workspace), a role=dialog hosted INSIDE #workspace (the usage page) owns the
//                               Escape too: full screen stays; with the dialog gone the next Escape leaves it
//   h_chip_follows_toggle       the « Demander à Claude » chip is either hidden or on the live selection after each full-screen toggle (it is fixed in body
//                               and the frame moves under it)
//   i_full_above_session_panes  (DoD 2b) with a LIVE session pane open on its terminal face (its .xterm-viewport is z-index 3 in the root stacking context),
//                               in full screen (and over sp-max) the hit at the pane centre and on its scrollbar is inside the plan view, as are the corners
// Run (from the repo root): xvfb-run -a node_modules/.bin/electron test/plans-view-full-probe.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const REPO = path.join(__dirname, '..');
const NAMES = ['a_button_only_on_html_plan', 'b_enter_fills_window', 'b2_enter_with_sp_max', 'c_reduire_restores', 'm_motion_family_and_reduced', 'f_every_exit_resets',
  'd_escape_order', 'd2_escape_order_sp_max', 'd3_escape_popup_first', 'e_escape_inside_frame', 'g_chip_and_ask_above_view', 'g2_dock_above_view',
  'u2_os_window_stays_windowed', 'd4_escape_popup_in_workspace', 'h_chip_follows_toggle', 'i_full_above_session_panes'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const detail = {};
let finished = false;

// The page's own script: selects its text on demand (the relay served with the plans slot posts the selection to the Deck) and reports every
// key it receives to the Deck, which proves an Escape typed with the focus in the frame did arrive there.
const PAGE_SCRIPT = [
  'addEventListener("message", function (e) {',
  '  var t = document.getElementById("t"), s = getSelection();',
  '  if (e.data === "sel") { var r = document.createRange(); r.selectNodeContents(t); s.removeAllRanges(); s.addRange(r); }',
  '  else if (e.data === "clear") s.removeAllRanges();',
  '});',
  'addEventListener("keydown", function (e) { parent.postMessage({ probeKey: e.key }, "*"); }, true);',
].join('\n');
const SEL_TEXT = 'Page factice de la sonde plein écran';
const pageOf = (title, bg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
  + `<body style="margin:0;padding:24px;background:${bg};color:#111827;font:16px sans-serif"><h1>${title}</h1><p id="t" style="width:240px">${SEL_TEXT}</p>`
  + `<script>${PAGE_SCRIPT}</script></body></html>\n`;
const PLAN_A = 'full-a.html';
const PLAN_B = 'full-b.html';
const PLAN_C = 'full-c.plan.md';
const SID = '99999999-9999-4999-8999-999999999999';

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plans-full-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), home: path.join(root, 'home'), projects: path.join(root, 'projects'), ask: path.join(root, 'ask'),
    status: path.join(root, 'status'), plugins: path.join(root, 'plugins'), proj: path.join(root, 'proj') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const plansDir = path.join(dirs.proj, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, PLAN_A), pageOf('Plan A', '#F4F5F7'));
  fs.writeFileSync(path.join(plansDir, PLAN_B), pageOf('Plan B', '#EEF2FF'));
  fs.writeFileSync(path.join(plansDir, PLAN_C), '# Plan C\n\nmarkdown body, no frame\n');
  const projDir = path.join(dirs.projects, 'proj-test');
  fs.mkdirSync(projDir, { recursive: true });
  const toolLine = (file, i) => JSON.stringify({ type: 'assistant', timestamp: `2026-06-05T10:0${i}:00.000Z`,
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(plansDir, file) } }] } }) + '\n';
  fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({ type: 'summary', cwd: dirs.proj }) + '\n' + toolLine(PLAN_A, 0) + toolLine(PLAN_B, 1) + toolLine(PLAN_C, 2));
  return dirs;
}

function verdict(code) {
  if (finished) return;
  finished = true;
  for (const n of NAMES) console.log(`${results[n] ? 'OK' : 'FAIL'} ${n} ${JSON.stringify(detail[n])}`);
  const bad = NAMES.filter((k) => !results[k]);
  console.log(bad.length ? `VERDICT: RED (${NAMES.length - bad.length}/${NAMES.length} green) FAIL: ${bad.join(', ')}` : `VERDICT: ALL GREEN (${NAMES.length}/${NAMES.length})`);
  app.exit(code !== undefined ? code : (bad.length ? 1 : 0));
}

function boot() {
  const dirs = buildFixtures();
  app.setPath('userData', dirs.ud);
  process.env.HOME = dirs.home;
  for (const k of ['OPENAI_API_KEY', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN']) delete process.env[k];
  Object.assign(process.env, {
    CLAUDE_DECK_BIN: '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: dirs.projects, CLAUDE_DECK_ASK_DIR: dirs.ask, CLAUDE_DECK_STATUS_DIR: dirs.status,
    CLAUDE_DECK_PLUGINS_DIR: dirs.plugins,
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

async function run(dirs) {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 300 s' }; }
    verdict(2);
  }, 300000);
  watchdog.unref();

  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.pp && window.openPlansPanel && window.openSidePanel && window.sp)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
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
  const near = (a, b) => Math.abs(a - b) <= 1;
  const sameRect = (a, b) => !!a && !!b && near(a.l, b.l) && near(a.top, b.top) && near(a.w, b.w) && near(a.h, b.h);
  const inside = (r, o) => !!r && !!o && r.l >= o.l - 1 && r.top >= o.top - 1 && r.l + r.w <= o.l + o.w + 1 && r.top + r.h <= o.top + o.h + 1;
  const isWin = (s) => !!s.frame && near(s.frame.w, s.win.w) && near(s.frame.h, s.win.h) && near(s.frame.l, 0) && near(s.frame.top, 0);
  const FS_SEL = '[class*="fullscreen"]';
  // the window corners and centre all hit the view (or its frame): the header and the workspace are under it
  const covers = () => rend(`const v = document.getElementById('pp-view'); const pts = [[6, 6], [innerWidth - 6, 6], [6, innerHeight - 6], [innerWidth - 6, innerHeight - 6], [Math.round(innerWidth / 2), Math.round(innerHeight / 2)]];
    return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && v.contains(e); });`);
  const st = () => rend(`const p = document.getElementById('plans-panel'), sp = document.getElementById('side-panel'), v = document.getElementById('pp-view'), b = document.getElementById('pp-full');
    const f = v.querySelector(':scope > iframe'); const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, top: r.top, w: r.width, h: r.height }; };
    return { open: !p.hidden && sp.hidden === false, selected: window.pp.selected, win: { w: innerWidth, h: innerHeight }, frame: box(f), sp: box(sp), view: box(v),
      fsEls: [...document.querySelectorAll(${JSON.stringify(FS_SEL)})].map((e) => e.id || e.tagName), spMax: sp.classList.contains('sp-max'),
      viewPos: getComputedStyle(v).position, anims: v.getAnimations().length,
      btn: b ? { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'), vis: b.getClientRects().length > 0, inView: v.contains(b) } : null };`);
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
  // Shows a plan of the fixture session and waits until its frame (html) or its markdown is in the view.
  const showPlan = async (name) => {
    const idx = await rend(`return window.pp.names.indexOf(${JSON.stringify(name)});`);
    if (idx < 0) return false;
    await rend(`window.ppLoadPlan(${idx}); return true;`);
    const html = /\.html$/.test(name);
    return waitFor(() => rend(html
      ? `return !!document.querySelector('#pp-view > iframe') && window.pp.selected === ${idx};`
      : `return window.pp.selected === ${idx} && !!document.querySelector('#pp-view h1') && !document.querySelector('#pp-view > iframe');`));
  };
  const openPanel = async () => {
    await rend(`window.openPlansPanel({ sessionId: ${JSON.stringify(SID)} }); return true;`);
    return waitFor(() => rend("return document.querySelectorAll('#pp-list .pp-row').length === 3;"));
  };
  const settled = (s) => s.anims === 0;
  const waitSettled = async () => { await waitFor(async () => settled(await st()), 3000); await sleep(150); return st(); };
  const enter = async (expectFull) => {
    const clicked = await click('#pp-full');
    await waitFor(async () => ((await st()).fsEls.length > base.fsEls.length) === expectFull, 2000);
    return { clicked, s: await waitSettled() };
  };

  const opened = await openPanel();
  const base = await st();
  const shownA = opened && (await showPlan(PLAN_A));
  if (!shownA) { // a half-open start would fail every gate for a reason that is not theirs
    for (const n of NAMES) { results[n] = false; detail[n] = { opened, why: 'the Plans tab did not reach the HTML plan A with its frame', state: await st().catch(() => null) }; }
    clearTimeout(watchdog);
    verdict(2);
    return;
  }

  // ---- a (DoD 2a) ---------------------------------------------------------------------------------------------------
  await gate('a_button_only_on_html_plan', async () => {
    await sleep(300);
    const html = await st();
    const shown = (s) => !!s.btn && s.btn.vis && s.btn.text === 'Plein écran' && s.btn.pressed === 'false' && s.btn.inView;
    const mdShown = await showPlan(PLAN_C);
    await sleep(300);
    const md = await st();
    const backShown = await showPlan(PLAN_A);
    await sleep(300);
    const back = await st();
    return { ok: shown(html) && mdShown && !(md.btn && md.btn.vis) && !(md.btn && md.btn.inView) && backShown && shown(back) && html.fsEls.length === base.fsEls.length,
      html: html.btn, markdown: md.btn, again: back.btn };
  });

  // ---- b (DoD 2b) ---------------------------------------------------------------------------------------------------
  const defRect = (await st()).frame;
  const spRect = (await st()).sp;
  await gate('b_enter_fills_window', async () => {
    await rend(`window.__frameEl = document.querySelector('#pp-view > iframe'); window.__mounts = 0;
      new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') window.__mounts++; }).observe(document.getElementById('plans-panel'), { childList: true, subtree: true }); return true;`);
    const urlBefore = frames()[0] ? frames()[0].url : '';
    const { clicked, s } = await enter(true);
    const same = await rend("return { same: document.querySelector('#pp-view > iframe') === window.__frameEl, mounts: window.__mounts };");
    const urlAfter = frames()[0] ? frames()[0].url : '';
    const cov = await covers();
    return { ok: clicked && isWin(s) && cov.every(Boolean) && !!s.btn && s.btn.text === 'Réduire' && s.btn.pressed === 'true' && s.fsEls.length > base.fsEls.length
      && same.same && same.mounts === 0 && !!urlBefore && urlBefore === urlAfter,
      clicked, frameRect: s.frame, win: s.win, defaultRect: defRect, covers: cov, btn: s.btn, viewPos: s.viewPos, fsEls: s.fsEls, same, urlBefore, urlAfter };
  });

  // ---- c (DoD 2c) (the view is in full screen from b) -----------------------------------------------------------------
  await gate('c_reduire_restores', async () => {
    const { clicked, s } = await enter(false);
    return { ok: clicked && inside(s.frame, s.sp) && sameRect(s.frame, defRect) && !isWin(s) && !!s.btn && s.btn.text === 'Plein écran' && s.btn.pressed === 'false'
      && s.fsEls.length === base.fsEls.length && s.viewPos !== 'fixed',
      clicked, frameRect: s.frame, sidePanel: s.sp, defaultRect: defRect, btn: s.btn, fsEls: s.fsEls, viewPos: s.viewPos };
  });

  // ---- b2: the maximized side panel is a separate mode that keeps working ---------------------------------------------------
  await gate('b2_enter_with_sp_max', async () => {
    await click('#sp-max');
    await waitFor(async () => (await st()).spMax, 2000);
    await sleep(300);
    const maxed = await st();
    const { clicked, s } = await enter(true);
    const cov = await covers();
    const out = await enter(false);
    await click('#sp-max');
    await waitFor(async () => !(await st()).spMax, 2000);
    await sleep(300);
    const back = await st();
    const ok = maxed.spMax && clicked && isWin(s) && cov.every(Boolean) && s.spMax && out.clicked && inside(out.s.frame, out.s.sp) && sameRect(out.s.frame, maxed.frame) && out.s.fsEls.length === base.fsEls.length
      && !back.spMax && sameRect(back.frame, defRect);
    return { ok, maxedFrame: maxed.frame, fullFrame: s.frame, covers: cov, afterFrame: out.s.frame, win: s.win, restoredFrame: back.frame, defaultRect: defRect };
  });

  // ---- u2: the full screen is the Deck window's own layout, never the OS window's --------------------------------------------------
  await gate('u2_os_window_stays_windowed', async () => {
    const snap = async () => ({ os: win.isFullScreen(), bounds: win.getBounds(), domNull: await rend('return document.fullscreenElement === null;') });
    const same = (a, b) => ['x', 'y', 'width', 'height'].every((k) => a[k] === b[k]);
    const before = await snap();
    const { clicked, s } = await enter(true);
    const during = await snap();
    const out = await enter(false);
    const after = await snap();
    return { ok: clicked && isWin(s) && out.clicked && before.os === false && before.domNull && during.os === false && during.domNull && same(before.bounds, during.bounds)
      && after.os === false && after.domNull && same(before.bounds, after.bounds),
      before, during, after, fullFrame: s.frame };
  });

  // ---- m: the plugin report's timing family (flipFrom of motion.js), instant under reduced motion --------------------------------
  await gate('m_motion_family_and_reduced', async () => {
    try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
    const reduced = (v) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
    const record = async () => {
      await rend(`window.__samples = []; const v = document.getElementById('pp-view'); const t0 = performance.now();
        window.__iv = setInterval(() => { const r = v.getBoundingClientRect(); const an = v.getAnimations();
          window.__samples.push({ n: an.length, l: r.left, top: r.top, w: r.width, h: r.height,
            durs: an.map((a) => a.effect.getTiming().duration), keys: [...new Set(an.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))],
            op0: an.length ? an[0].effect.getKeyframes()[0].opacity : null }); }, 8); return true;`);
      await click('#pp-full');
      await sleep(800);
      const samples = await rend('clearInterval(window.__iv); return window.__samples;');
      const anim = samples.filter((x) => x.n > 0);
      return { samples: samples.length, animSamples: anim.length, durs: [...new Set(anim.flatMap((x) => x.durs))], keys: [...new Set(anim.flatMap((x) => x.keys))],
        opacityFrom: anim.length ? anim[0].op0 : null, inBetween: samples.filter((x) => !sameRect(x, samples[0]) && !sameRect(x, samples[samples.length - 1])).length };
    };
    const tok = (n) => rend(`return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(n)}));`);
    const drawer = await tok('--dur-drawer');
    const pop = await tok('--dur-pop');
    const okKeys = (r) => r.keys.every((k) => ['transform', 'opacity', 'offset', 'easing', 'composite', 'computedOffset'].includes(k));
    await reduced('no-preference');
    const enterM = await record();
    const exitM = await record();
    await reduced('reduce');
    const matches = await rend("return matchMedia('(prefers-reduced-motion: reduce)').matches;");
    const enterR = await record();
    const exitR = await record();
    await reduced('no-preference');
    const s = await st();
    const animated = (r, dur) => r.animSamples > 0 && r.inBetween > 0 && okKeys(r) && r.durs.length === 1 && r.durs[0] === dur;
    const instantly = (r) => r.animSamples === 0 && r.inBetween === 0;
    return { ok: drawer > 0 && pop > 0 && animated(enterM, drawer) && Number(enterM.opacityFrom) === 0.5 && animated(exitM, pop) && matches === true && instantly(enterR) && instantly(exitR)
      && s.fsEls.length === base.fsEls.length, drawer, pop, enterM, exitM, matches, enterR, exitR };
  });

  // ---- f (DoD 2f) ---------------------------------------------------------------------------------------------------
  await gate('f_every_exit_resets', async () => {
    const out = {};
    const fullFromA = async () => { // the starting state of a case: plan A shown, in full screen
      if (!(await showPlan(PLAN_A))) throw new Error('plan A not shown');
      await sleep(200);
      const r = await enter(true);
      if (!r.clicked || !isWin(r.s)) throw new Error(`not in full screen: ${JSON.stringify(r.s.frame)}`);
      return r.s;
    };
    const noFs = (s) => s.fsEls.length === base.fsEls.length;
    const clean = (s) => noFs(s) && !s.spMax;
    const reset = (s) => clean(s) && !!s.btn && s.btn.text === 'Plein écran' && s.btn.pressed === 'false';
    // 1. another HTML plan
    await fullFromA();
    const gotB = await showPlan(PLAN_B);
    await sleep(300);
    const s1 = await waitSettled();
    out.otherPlan = { shown: gotB, fsEls: s1.fsEls, frame: s1.frame, btn: s1.btn };
    const ok1 = gotB && reset(s1) && inside(s1.frame, s1.sp) && sameRect(s1.frame, defRect);
    // 2. a markdown plan
    await fullFromA();
    const gotC = await showPlan(PLAN_C);
    await sleep(300);
    const s2 = await waitSettled();
    out.markdownPlan = { shown: gotC, fsEls: s2.fsEls, btn: s2.btn, viewPos: s2.viewPos, view: s2.view };
    const ok2 = gotC && clean(s2) && !(s2.btn && s2.btn.vis) && inside(s2.view, s2.sp);
    // 3. another side-panel tab (the full-screen view covers the tab bar: the switch is the one a shortcut or the API makes)
    await fullFromA();
    await rend("window.openSidePanel('git'); return true;");
    await waitFor(async () => !(await st()).open || (await rend('return window.sp.tab;')) === 'git', 3000);
    await sleep(300);
    const s3 = await st();
    const tab3 = await rend('return window.sp.tab;');
    out.otherTab = { tab: tab3, fsEls: s3.fsEls, open: s3.open };
    const ok3 = tab3 === 'git' && noFs(s3); // the Git tab maximizes the side panel by itself: only the full-screen class is asserted
    // back to the Plans tab: the default rect, not full
    const reopen3 = await openPanel();
    const shown3 = reopen3 && (await showPlan(PLAN_A));
    await sleep(300);
    const r3 = await waitSettled();
    out.otherTab.back = { shown: shown3, frame: r3.frame, btn: r3.btn };
    const ok3b = shown3 && reset(r3) && sameRect(r3.frame, defRect);
    // 4. the panel closed
    await fullFromA();
    await rend('window.closeSidePanel(); return true;');
    await sleep(400);
    const s4 = await st();
    out.panelClosed = { open: s4.open, fsEls: s4.fsEls };
    const ok4 = !s4.open && clean(s4);
    const reopen4 = await openPanel();
    const shown4 = reopen4 && (await showPlan(PLAN_A));
    await sleep(300);
    const r4 = await waitSettled();
    out.panelClosed.back = { shown: shown4, frame: r4.frame, btn: r4.btn };
    const ok4b = shown4 && reset(r4) && sameRect(r4.frame, defRect);
    return { ok: ok1 && ok2 && ok3 && ok3b && ok4 && ok4b, cases: { ok1, ok2, ok3, ok3b, ok4, ok4b }, defaultRect: defRect, sidePanel: spRect, ...out };
  });

  // ==== d, e, g (Escape order, Escape inside the frame, the selection ask above the full-screen view) ============================
  win.focus();
  wc.focus();
  // Deck side instruments: the keys the plan page received, and the ask send (askFromPanel stubbed through the shared state.js instance, so no pty write).
  await rend(`window.__fkeys = []; window.__asks = [];
    addEventListener('message', (e) => { if (e.data && e.data.probeKey) window.__fkeys.push(e.data.probeKey); });
    const st = await import('./js/state.js');
    st.overlayState.askFromPanel = (paneId, text, sink) => { window.__asks.push({ paneId, text, sink }); return { ok: true, queued: false }; };
    return true;`);
  const esc = async () => { // a trusted Escape to the focused element of the Deck document
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(500);
    return waitSettled();
  };
  // The starting state of a case: the Plans panel open on plan A (its frame freshly mounted: full screen off), the side panel not maximized.
  const ready = async (wantMax = false) => {
    if (!(await openPanel())) throw new Error('the Plans panel did not reopen');
    if (!(await showPlan(PLAN_A))) throw new Error('plan A not shown');
    if (!(await waitFor(async () => frames().length === 1, 5000))) throw new Error('the plan frame did not load');
    await sleep(300);
    let s = await waitSettled();
    if (s.spMax !== wantMax) {
      await click('#sp-max');
      await waitFor(async () => (await st()).spMax === wantMax, 2000);
      await sleep(300);
      s = await waitSettled();
    }
    if (s.fsEls.length > base.fsEls.length) throw new Error(`full screen left on: ${JSON.stringify(s.fsEls)}`);
    return s;
  };
  const goFull = async () => {
    const r = await enter(true);
    if (!r.clicked || !isWin(r.s)) throw new Error(`not in full screen: ${JSON.stringify(r.s.frame)}`);
    return r.s;
  };
  const noFull = (s) => s.fsEls.length === base.fsEls.length;
  const focusOf = () => rend("const a = document.activeElement; return a ? (a.id || a.tagName) : null;");
  // Selects the text of the plan page and waits for the chip (posts again until the relay reports it: frame load race, debounce).
  const selectInFrame = async () => {
    await rend("const f = document.querySelector('#pp-view > iframe'); if (f) f.contentWindow.postMessage('clear', '*'); return true;");
    await sleep(200);
    return rend(`const end = Date.now() + 5000;
      const on = () => { const c = document.querySelector('.pp-ask-chip'); if (!c || c.hidden) return false; const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      while (Date.now() < end) {
        const f = document.querySelector('#pp-view > iframe');
        if (f) { f.contentWindow.postMessage('sel', '*'); await new Promise((r) => setTimeout(r, 350)); if (on()) return true; }
        else await new Promise((r) => setTimeout(r, 100));
      }
      return false;`);
  };
  // The hit at the centre of an element is the element itself or one of its descendants, and its box lies inside the window.
  const hitOf = (sel) => rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
    const b = n.getBoundingClientRect(); const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
    const h = document.elementFromPoint(cx, cy);
    const name = (e) => e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '');
    return { cx, cy, hit: h ? name(h) : null, onTop: !!h && n.contains(h), inWin: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
      box: { l: b.left, top: b.top, w: b.width, h: b.height }, pos: getComputedStyle(n).position, hidden: n.hidden };`);

  // ---- d (DoD 2d): Escape with the focus in the Deck document ---------------------------------------------------------------
  await gate('d_escape_order', async () => {
    await ready();
    const full = await goFull();
    const focus = await focusOf();
    const e1 = await esc();
    const e2 = await esc();
    return { ok: isWin(full) && noFull(e1) && e1.open && !e1.spMax && inside(e1.frame, e1.sp) && sameRect(e1.frame, defRect) && !e2.open && noFull(e2),
      focus, afterEsc1: { open: e1.open, fsEls: e1.fsEls, frame: e1.frame }, afterEsc2: { open: e2.open, fsEls: e2.fsEls } };
  });

  // With #side-panel.sp-max on: full screen off, then the maximize restored, then the panel closed.
  await gate('d2_escape_order_sp_max', async () => {
    const r0 = await ready(true);
    const full = await goFull();
    const e1 = await esc();
    const e2 = await esc();
    const e3 = await esc();
    return { ok: r0.spMax && isWin(full) && full.spMax && noFull(e1) && e1.open && e1.spMax && e2.open && e2.spMax === false && noFull(e2) && !e3.open && noFull(e3) && !e3.spMax,
      afterEsc1: { open: e1.open, spMax: e1.spMax, fsEls: e1.fsEls }, afterEsc2: { open: e2.open, spMax: e2.spMax, fsEls: e2.fsEls }, afterEsc3: { open: e3.open, spMax: e3.spMax, fsEls: e3.fsEls } };
  });

  // An open ask composer (the popup the chip opens) keeps its own Escape first: it closes alone, the full screen stays, the next Escape leaves it.
  await gate('d3_escape_popup_first', async () => {
    await ready();
    await goFull();
    const shown = await selectInFrame();
    const clicked = shown && (await click('.pp-ask-chip'));
    await waitFor(() => rend("return document.querySelectorAll('.ca-popup').length === 1;"), 2000);
    const up = await rend("const i = document.querySelector('.ca-popup .ca-input'); return { n: document.querySelectorAll('.ca-popup').length, input: !!i && document.activeElement === i };");
    const e1 = await esc();
    const popupAfter1 = await rend("return document.querySelectorAll('.ca-popup').length;");
    const e2 = await esc();
    const popupAfter2 = await rend("return document.querySelectorAll('.ca-popup').length;");
    return { ok: shown && clicked && up.n === 1 && up.input && popupAfter1 === 0 && !noFull(e1) && isWin(e1) && e1.open && noFull(e2) && e2.open && popupAfter2 === 0,
      shown, clicked, popupUp: up, afterEsc1: { popups: popupAfter1, fsEls: e1.fsEls, open: e1.open }, afterEsc2: { popups: popupAfter2, fsEls: e2.fsEls, open: e2.open } };
  });

  // ---- d4 (OE1): a popup hosted by #workspace, read through the maximize hiding --------------------------------------------------
  // Over #side-panel.sp-max the workspace is `visibility: hidden`, and a role=dialog inside it (the usage page) inherits that, so a plain
  // visibility test reads it as closed. A hidden subtree cannot take the focus: the Escape is dispatched at an input of the dialog (an editable
  // target, which the Plans panel's own document handler leaves alone), so only the full-screen owner decides.
  await gate('d4_escape_popup_in_workspace', async () => {
    await ready(true);
    const full = await goFull();
    try {
      const probe = await rend(`const w = document.getElementById('workspace'); const d = document.createElement('div'); d.id = '__probe-dialog'; d.setAttribute('role', 'dialog');
        d.style.cssText = 'width:120px;height:40px'; d.append(document.createElement('input')); w.append(d);
        return { wsVisibility: w.style.visibility, dialogVisibility: getComputedStyle(d).visibility, rects: d.getClientRects().length };`);
      await rend(`document.querySelector('#__probe-dialog input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 300)); return true;`);
      const held = await waitSettled();
      await rend("document.getElementById('__probe-dialog').remove(); return true;");
      const e2 = await esc();
      return { ok: probe.wsVisibility === 'hidden' && probe.dialogVisibility === 'hidden' && probe.rects > 0 && isWin(full) && full.spMax
        && !noFull(held) && isWin(held) && held.open && held.spMax && noFull(e2) && e2.open && e2.spMax,
        setup: probe, afterEscWithDialog: { fsEls: held.fsEls, open: held.open, spMax: held.spMax, frame: held.frame }, afterEscNoDialog: { fsEls: e2.fsEls, open: e2.open, spMax: e2.spMax } };
    } finally {
      await rend("const d = document.getElementById('__probe-dialog'); if (d) d.remove(); return true;");
    }
  });

  // ---- e (DoD 2e): Escape typed with the focus INSIDE the plan frame --------------------------------------------------------
  await gate('e_escape_inside_frame', async () => {
    const cdp = (m, p) => wc.debugger.sendCommand(m, p);
    try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
    // The focus must be really inside the frame: the frame's own document has focus AND the Deck document reports the iframe as its active element.
    // iframe.focus() first, else a real click in the frame.
    const frameHasFocus = () => (frames()[0] ? frames()[0].executeJavaScript('document.hasFocus()').catch(() => false) : false);
    const deckActive = () => rend("return document.activeElement === document.querySelector('#pp-view > iframe');");
    const focusFrame = async () => {
      await rend("document.querySelector('#pp-view > iframe').focus(); return true;");
      await sleep(200);
      let has = await frameHasFocus();
      if (!has) {
        const c = await rend("const r = document.querySelector('#pp-view > iframe').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
        for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await sleep(300);
        has = await frameHasFocus();
      }
      return has && (await deckActive());
    };
    const routes = [
      ['sendInputEvent', async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); }],
      ['cdp', async () => { for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); }],
    ];
    let mainSaw = 0;
    const onBei = (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') mainSaw++; };
    wc.on('before-input-event', onBei);
    // one case: arm (full screen / maximize), focus in the frame, send Escape by the first route the frame receives it on
    const inFrame = async (wantFull, wantMax, preferred) => {
      await ready(wantMax);
      if (wantFull) await goFull();
      const active = await focusFrame();
      const tried = [];
      for (const [route, send] of routes) {
        if (preferred && route !== preferred) continue;
        await rend('window.__fkeys.length = 0; return true;');
        mainSaw = 0;
        await send();
        await sleep(600);
        const frameKeys = await rend('return window.__fkeys.length;');
        tried.push({ route, frameKeys, mainSaw });
        if (frameKeys > 0) return { active, route, tried, s: await waitSettled() };
        await ready(wantMax); // the route that missed the frame may have reached the Deck: start the next one clean
        if (wantFull) await goFull();
        await focusFrame();
      }
      return { active, route: null, tried, s: await st() };
    };
    try {
      const a = await inFrame(true, false);
      const idle = await inFrame(false, false, a.route);
      const m = await inFrame(true, true, a.route);
      const ok = !!a.route && a.active && noFull(a.s) && a.s.open && !a.s.spMax && sameRect(a.s.frame, defRect)
        && idle.active && idle.route === a.route && noFull(idle.s) && idle.s.open && sameRect(idle.s.frame, defRect)
        && m.active && m.route === a.route && noFull(m.s) && m.s.open && m.s.spMax;
      return { ok, route: a.route, full: { tried: a.tried, active: a.active, fsEls: a.s.fsEls, open: a.s.open, spMax: a.s.spMax },
        idle: { tried: idle.tried, fsEls: idle.s.fsEls, open: idle.s.open, sameRect: sameRect(idle.s.frame, defRect) },
        fullWithMax: { tried: m.tried, fsEls: m.s.fsEls, open: m.s.open, spMax: m.s.spMax } };
    } finally {
      wc.off('before-input-event', onBei);
    }
  });

  // ---- g (DoD 2g): the selection ask above the full-screen view -------------------------------------------------------------
  // One flow per mode: select in the plan, the chip, its click, the popup, the send, the answer in the dock, « Réduire ».
  const askFlow = async (wantMax) => {
    const out = {};
    await ready(wantMax);
    await goFull();
    await rend("window.__asks.length = 0; return true;");
    out.selected = await selectInFrame();
    out.chip = await hitOf('.pp-ask-chip');
    out.clicked = out.selected && (await click('.pp-ask-chip'));
    await waitFor(() => rend("return document.querySelectorAll('.ca-popup').length === 1;"), 2000);
    out.popup = await hitOf('.ca-popup');
    out.popupN = await rend("return document.querySelectorAll('.ca-popup').length;");
    out.title = await rend("const t = document.querySelector('.ca-popup .ca-title'); return t ? t.textContent : null;");
    out.sent = await rend(`const i = document.querySelector('.ca-popup .ca-input'); if (!i) return null;
      i.value = 'Pourquoi ceci ?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const a = window.__asks[0]; if (a) { a.sink.update('Réponse de test'); a.sink.done(); }
      return { n: window.__asks.length, text: a ? a.text : null, popups: document.querySelectorAll('.ca-popup').length };`);
    await sleep(300);
    out.dock = await hitOf('#pp-asks');
    out.bubble = await hitOf('#pp-asks .ca-bubble');
    out.full = isWin(await st());
    await click('#pp-full'); // « Réduire »
    await waitSettled();
    out.after = await hitOf('#pp-asks');
    out.afterSp = (await st()).sp;
    out.afterFull = !noFull(await st());
    return out;
  };
  const flows = {};
  for (const [k, m] of [['plain', false], ['max', true]]) {
    try { flows[k] = await askFlow(m); } catch (err) { flows[k] = { threw: String(err && err.stack || err).slice(0, 300) }; }
  }
  await gate('g_chip_and_ask_above_view', async () => {
    const good = (f) => !!f && !f.threw && f.selected && !!f.chip && f.chip.onTop && f.chip.inWin && f.clicked && f.popupN === 1 && f.title === 'Demander à Claude'
      && !!f.popup && f.popup.onTop && f.popup.inWin && !!f.sent && f.sent.n === 1 && f.sent.popups === 0
      && f.sent.text === `${PLAN_A} — « ${SEL_TEXT} »\n\n\`\`\`\n${SEL_TEXT}\n\`\`\`\n\nPourquoi ceci ?`; // 7 words: the whole text is in the ref
    return { ok: good(flows.plain) && good(flows.max), plain: flows.plain && { threw: flows.plain.threw, chip: flows.plain.chip, popup: flows.plain.popup, popupN: flows.plain.popupN, sent: flows.plain.sent },
      max: flows.max && { threw: flows.max.threw, chip: flows.max.chip, popup: flows.max.popup, popupN: flows.max.popupN, sent: flows.max.sent } };
  });
  await gate('g2_dock_above_view', async () => {
    const good = (f) => !!f && !f.threw && f.full === true && !!f.dock && f.dock.hidden === false && f.dock.onTop && f.dock.inWin && !!f.bubble && f.bubble.onTop
      && !!f.after && f.after.hidden === false && f.after.pos !== 'fixed' && f.afterFull === false
      && f.after.box.l >= f.afterSp.l - 1 && f.after.box.top >= f.afterSp.top - 1 && f.after.box.l + f.after.box.w <= f.afterSp.l + f.afterSp.w + 1 && f.after.box.top + f.after.box.h <= f.afterSp.top + f.afterSp.h + 1;
    return { ok: good(flows.plain) && good(flows.max), plain: flows.plain && { threw: flows.plain.threw, dock: flows.plain.dock, bubble: flows.plain.bubble, after: flows.plain.after, sidePanel: flows.plain.afterSp },
      max: flows.max && { threw: flows.max.threw, dock: flows.max.dock, bubble: flows.max.bubble, after: flows.max.after, sidePanel: flows.max.afterSp } };
  });

  // ---- h: the chip after a full-screen toggle ---------------------------------------------------------------------------------------
  // The chip is fixed in body at the selection's Deck coordinates; the toggle moves the frame under it. After each toggle it must be hidden or sit
  // where the live selection (read in the frame itself) ends: the expected spot is frame-ask.js's own rule applied to the frame's current box.
  const chipVsSelection = async () => {
    const c = await rend(`const n = document.querySelector('.pp-ask-chip'); if (!n) return null; const b = n.getBoundingClientRect(); const f = document.querySelector('#pp-view > iframe').getBoundingClientRect();
      return { vis: !n.hidden && b.width > 0 && b.height > 0, l: b.left, top: b.top, w: b.width, h: b.height, fl: f.left, ft: f.top, iw: innerWidth, ih: innerHeight };`);
    const sel = await frames()[0].executeJavaScript(`(() => { const s = getSelection(); if (!s.rangeCount || s.isCollapsed) return null; const r = s.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    if (!c) return { vis: false, noChip: true, selKept: !!sel };
    const expL = Math.min(Math.max(8, c.fl + (sel ? sel.left + sel.width : 0)), c.iw - c.w - 8);
    const expT = Math.min(Math.max(8, c.ft + (sel ? sel.top + sel.height : 0) + 6), c.ih - c.h - 8);
    return { vis: c.vis, left: Math.round(c.l), top: Math.round(c.top), expectedLeft: Math.round(expL), expectedTop: Math.round(expT), off: Math.round(Math.hypot(c.l - expL, c.top - expT)), selKept: !!sel };
  };
  await gate('h_chip_follows_toggle', async () => {
    await ready();
    const shown = await selectInFrame();
    const atRest = await chipVsSelection();
    const inFull = await enter(true);
    await sleep(500); // the page's relay debounces 120 ms: a re-post of the selection, if there is one, has landed
    const duringFull = await chipVsSelection();
    const outFull = await enter(false);
    await sleep(500);
    const afterExit = await chipVsSelection();
    const fine = (m) => !m.vis || (m.selKept && m.off <= 2);
    return { ok: shown && atRest.vis && atRest.off <= 2 && isWin(inFull.s) && fine(duringFull) && !isWin(outFull.s) && fine(afterExit),
      shown, atRest, duringFull, afterExit };
  });

  // ---- i (DoD 2b): the view above a live session pane ---------------------------------------------------------------------------------
  // A session pane's .xterm-viewport (z-index 3) lives in the root stacking context: a full-screen view that does not outrank it would paint and take
  // the clicks under it (the Escape rule and the keys would then go to the terminal). The pane is opened the user's way (its terminal face), the plan is
  // entered in full screen, and the hit at the pane centre and on its scrollbar must be inside the view. At rest the same points are the xterm layer,
  // so a pane that is not under those points (hidden, off-window) cannot pass the gate for free.
  const paneHits = () => rend(`const v = document.getElementById('pp-view'); const vp = document.querySelector('#grid .pane .xterm-viewport'); if (!vp) return null;
    const r = vp.getBoundingClientRect(); const name = (e) => (e ? e.tagName + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') : null);
    const at = (x, y) => { const e = document.elementFromPoint(x, y); return { hit: name(e), inView: !!e && v.contains(e), inXterm: !!e && !!e.closest('.xterm') }; };
    return { rect: { l: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, centre: at(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)),
      scrollbar: at(Math.round(r.right - 4), Math.round(r.top + r.height / 2)) };`);
  await gate('i_full_above_session_panes', async () => {
    await rend(`openPane({ cwd: ${JSON.stringify(dirs.proj)}, resumeId: ${JSON.stringify(SID)}, title: 'z' }); return true;`);
    const paneUp = await waitFor(() => rend("return !!document.querySelector('#grid .pane .xterm-viewport');"), 10000);
    await rend(`const p = document.querySelector('#grid .pane'); const seg = p && p.querySelector('.pv-seg[data-face="terminal"]'); if (seg && p.classList.contains('chat-mode')) seg.click(); return true;`);
    await sleep(500);
    const flow = async (wantMax) => {
      await ready(wantMax);
      const rest = await paneHits();
      const full = await goFull();
      const hits = await paneHits();
      // the corners and the centre hit the view, or the answers dock that gate g left at the window bottom (it rides above the view on purpose)
      const corners = await rend(`const v = document.getElementById('pp-view'), d = document.getElementById('pp-asks');
        const pts = [[6, 6], [innerWidth - 6, 6], [6, innerHeight - 6], [innerWidth - 6, innerHeight - 6], [Math.round(innerWidth / 2), Math.round(innerHeight / 2)]];
        return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y);
          return { who: e ? e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') : null, ok: !!e && (v.contains(e) || d.contains(e)) }; });`);
      await enter(false);
      return { rest, hits, corners, fills: isWin(full), spMax: full.spMax };
    };
    const plain = await flow(false);
    const max = await flow(true);
    const above = (f) => !!f.hits && f.hits.centre.inView && f.hits.scrollbar.inView && f.corners.every((c) => c.ok) && f.fills;
    return { ok: paneUp && !!plain.rest && plain.rest.rect.w > 0 && plain.rest.centre.inXterm && plain.rest.scrollbar.inXterm && above(plain) && max.spMax === true && above(max),
      paneUp, plain, max };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
