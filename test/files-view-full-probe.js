'use strict';
// files-view-full-probe — U-files-full: the « Plein écran » / « Réduire » control of the Files tab viewer (#fp-vbody) while it holds an HTML page
// frame, mirror of plans-view-full-probe. Two kinds of frame: « Format riche » (the script-free page, srcdoc, same-origin) and the closed
// deckpage:// frame of a page that holds script. The file is opened through openFileInPanel, the target of a chat file link.
// The REAL app boots over throwaway fixtures. Every click is a trusted mouse event at the centre of the control (webContents.sendInputEvent).
// Each gate prints `OK <name> <detail>` or `FAIL <name> <detail>`; per-kind gates need both kinds.
//   a_button_only_on_html_frame (DoD) both kinds shown: « Plein écran » visible inside #fp-vbody, aria-pressed false; « Texte » mode, a text file, a
//                               closed viewer: no visible button
//   b_enter_fills_window        click: the frame rect equals innerWidth x innerHeight (+-1 px), label « Réduire », aria-pressed true, the frame is the same
//                               element and content (no re-mount), the window corners hit the view (above the header)
//   b2_enter_with_sp_max        #side-panel.sp-max still works: full screen over it, and back to the maximized rect
//   c_reduire_restores          click again: the frame rect is back inside #side-panel, label « Plein écran », aria-pressed false
//   m_motion_family_and_reduced enter glides 280 ms (--dur-drawer) from opacity 0.5, exit 200 ms (--dur-pop), transform / opacity only, instant under reduced motion
//   f_every_exit_resets         another file, a text file, « Texte », the viewer closed, another side-panel tab, the panel closed: full screen off, no
//                               ...fullscreen class left, and a reopened panel is back to the default rect
//   d_escape_order              Escape with the focus in the Deck: full screen off (viewer and panel still open), then the viewer closes, then the panel
//   d2_escape_order_sp_max      with #side-panel.sp-max: full screen off, then max restored, then the viewer closed, then the panel closed
//   d3_escape_popup_first       an open ask popup keeps its own Escape first: popup closed (full screen still on), then full screen off
//   d4_escape_popup_in_workspace over sp-max (which hides #workspace), a role=dialog hosted INSIDE #workspace owns the Escape too: full screen and viewer stay
//   e_escape_inside_frame       Escape typed with the focus INSIDE the frame (trusted key event): full screen off, ONE step only (the viewer stays);
//                               the srcdoc frame is run 3 times (its Escape also reaches the Deck through lockFrame: a double step would show)
//   g_chip_and_ask_above_view   in full screen (and over sp-max): the chip / popup are the elementFromPoint hit at their own centre, the send reaches the session
//   g2_dock_above_view          the answers dock #fp-asks, when not hidden, is the hit at its own centre, inside the window; docked again after « Réduire »
//   h_chip_follows_toggle       the chip is either hidden or on the live selection after each full-screen toggle
//   u2_os_window_stays_windowed entering full screen never puts the OS window in full screen
//   i_full_above_session_panes  with a LIVE session pane (its .xterm-viewport is z-index 3), in full screen (and over sp-max) the hit at the pane centre and on
//                               its scrollbar is inside the Files view, as are the corners
// Run (from the repo root): xvfb-run -a node_modules/.bin/electron test/files-view-full-probe.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const REPO = path.join(__dirname, '..');
const NAMES = ['a_button_only_on_html_frame', 'b_enter_fills_window', 'b2_enter_with_sp_max', 'c_reduire_restores', 'm_motion_family_and_reduced', 'f_every_exit_resets',
  'd_escape_order', 'd2_escape_order_sp_max', 'd3_escape_popup_first', 'd4_escape_popup_in_workspace', 'e_escape_inside_frame', 'g_chip_and_ask_above_view',
  'g2_dock_above_view', 'h_chip_follows_toggle', 'u2_os_window_stays_windowed', 'i_full_above_session_panes'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const detail = {};
let finished = false;

// The closed page's own script: selects its text on demand (the relay served with the files slot posts the selection to the Deck) and reports every
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
const body = (title, bg) => `<body style="margin:0;padding:24px;background:${bg};color:#111827;font:16px sans-serif"><h1>${title}</h1><p id="t" style="width:240px">${SEL_TEXT}</p>`;
const richPage = (title, bg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>${body(title, bg)}</body></html>\n`;
const scriptPage = (title, bg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>${body(title, bg)}<script>${PAGE_SCRIPT}</script></body></html>\n`;
const REL = { rich: 'docs/rich.html', page: 'docs/page.html', other: 'docs/other.html', txt: 'docs/notes.txt' };
const KINDS = [{ kind: 'rich', rel: REL.rich }, { kind: 'page', rel: REL.page }];
const RICH = KINDS[0];
const PAGE = KINDS[1];
const SID = '99999999-9999-4999-8999-999999999999';

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-files-full-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), home: path.join(root, 'home'), projects: path.join(root, 'projects'), ask: path.join(root, 'ask'),
    status: path.join(root, 'status'), plugins: path.join(root, 'plugins'), proj: path.join(root, 'proj') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dirs.proj, REL.rich), richPage('Rich A', '#F4F5F7'));
  fs.writeFileSync(path.join(dirs.proj, REL.page), scriptPage('Page B', '#EEF2FF'));
  fs.writeFileSync(path.join(dirs.proj, REL.other), richPage('Rich C', '#FEF3C7'));
  fs.writeFileSync(path.join(dirs.proj, REL.txt), 'plain text file\nsecond line\n');
  const projDir = path.join(dirs.projects, 'proj-test');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({ type: 'summary', cwd: dirs.proj }) + '\n'
    + JSON.stringify({ type: 'user', cwd: dirs.proj, sessionId: SID, timestamp: '2026-06-05T10:00:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n');
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
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 540 s' }; }
    verdict(2);
  }, 540000);
  watchdog.unref();

  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.filesState && window.openFileInPanel && window.openSidePanel && window.sp && window.overlayState)', true).catch(() => false))) win = null;
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
  const VIEW = '#fp-vbody';
  const FRAME = '#fp-vbody iframe';
  const TJ = JSON.stringify({ paneId: null, sessionId: SID });
  // the window corners and centre all hit the view (or its frame): the header and the workspace are under it
  const covers = () => rend(`const v = document.getElementById('fp-vbody'); const pts = [[6, 6], [innerWidth - 6, 6], [6, innerHeight - 6], [innerWidth - 6, innerHeight - 6], [Math.round(innerWidth / 2), Math.round(innerHeight / 2)]];
    return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && v.contains(e); });`);
  const st = () => rend(`const p = document.getElementById('files-panel'), sp = document.getElementById('side-panel'), v = document.getElementById('fp-vbody'), b = document.getElementById('fp-full'), vw = document.getElementById('fp-viewer');
    const f = v.querySelector('iframe'); const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, top: r.top, w: r.width, h: r.height }; };
    return { open: !p.hidden && sp.hidden === false, viewer: !vw.hidden, mode: window.filesState.mode, tab: window.sp.tab, win: { w: innerWidth, h: innerHeight }, frame: box(f), sp: box(sp), view: box(v),
      fsEls: [...document.querySelectorAll(${JSON.stringify(FS_SEL)})].map((e) => e.id || e.tagName), spMax: sp.classList.contains('sp-max'),
      viewPos: getComputedStyle(v).position, anims: v.getAnimations().length, srcdoc: f ? f.hasAttribute('srcdoc') : null,
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
  // Opens a file the way a chat link does and waits until its frame (rich / page) or its text is in the viewer.
  const openFile = async (rel, k) => {
    await rend('closeSidePanel(); return true;');
    await sleep(100);
    await rend(`openFileInPanel(${TJ}, ${JSON.stringify(rel)}); return true;`);
    const kind = k ? k.kind : 'text';
    if (kind === 'text') return waitFor(() => rend("return !!document.querySelector('#fp-vbody .fp-code-wrap') && !document.querySelector('#fp-vbody iframe');"));
    const up = await waitFor(() => rend(`const f = document.querySelector('#fp-vbody iframe'); if (!f || !(f.getBoundingClientRect().width > 0)) return false;
      ${kind === 'rich' ? "const d = f.contentDocument; return f.hasAttribute('srcdoc') && !!d && d.URL === 'about:srcdoc' && d.readyState === 'complete';" : "return !f.hasAttribute('srcdoc');"}`));
    if (!up || kind !== 'page') return up;
    return waitFor(() => (frames()[0] ? frames()[0].executeJavaScript('document.readyState === "complete"').catch(() => false) : false));
  };
  const settled = (s) => s.anims === 0;
  const waitSettled = async () => { await waitFor(async () => settled(await st()), 3000); await sleep(150); return st(); };
  let base = null;
  const enter = async (expectFull) => {
    const clicked = await click('#fp-full');
    await waitFor(async () => ((await st()).fsEls.length > base.fsEls.length) === expectFull, 2000);
    return { clicked, s: await waitSettled() };
  };
  const noFull = (s) => s.fsEls.length === base.fsEls.length;
  // The starting state of a case: the file open in the viewer with its frame, full screen off, the side panel maximized or not.
  const ready = async (k, wantMax = false) => {
    if (!(await openFile(k.rel, k))) throw new Error(`${k.kind} frame did not load`);
    await sleep(300);
    let s = await waitSettled();
    if (s.spMax !== wantMax) {
      await click('#sp-max');
      await waitFor(async () => (await st()).spMax === wantMax, 2000);
      await sleep(300);
      s = await waitSettled();
    }
    if (s.fsEls.length > (base ? base.fsEls.length : 0)) throw new Error(`full screen left on: ${JSON.stringify(s.fsEls)}`);
    if (!s.viewer || !s.frame) throw new Error(`no viewer / frame: ${JSON.stringify(s)}`);
    return s;
  };
  const goFull = async () => {
    const r = await enter(true);
    if (!r.clicked || !isWin(r.s)) throw new Error(`not in full screen: ${JSON.stringify(r.s.frame)} clicked=${r.clicked}`);
    return r.s;
  };

  // The probe starts on the script-free page: a half-open start would fail every gate for a reason that is not theirs.
  const started = await openFile(REL.rich, RICH);
  base = await st();
  if (!started) {
    for (const n of NAMES) { results[n] = false; detail[n] = { why: 'the Files tab did not reach the script-free page with its frame', state: await st().catch(() => null) }; }
    clearTimeout(watchdog);
    verdict(2);
    return;
  }
  const defRect = {};
  for (const k of KINDS) { await ready(k); defRect[k.kind] = (await st()).frame; }
  const spRect = (await st()).sp;

  // ---- a -----------------------------------------------------------------------------------------------------------------
  await gate('a_button_only_on_html_frame', async () => {
    const out = {};
    const shown = (s) => !!s.btn && s.btn.vis && s.btn.text === 'Plein écran' && s.btn.pressed === 'false' && s.btn.inView && s.fsEls.length === base.fsEls.length;
    const gone = (s) => !(s.btn && s.btn.vis) && !(s.btn && s.btn.inView);
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      const s = await st();
      out[k.kind] = s.btn;
      ok = ok && shown(s);
    }
    // « Texte » of the script-free page, then back to « Format riche »
    await ready(RICH);
    await rend("document.querySelector('#fp-mode [data-mode=\"text\"]').click(); return true;");
    await waitFor(() => rend("return !document.querySelector('#fp-vbody iframe') && !!document.querySelector('#fp-vbody .fp-code-wrap');"));
    await sleep(300);
    const texte = await st();
    out.texte = texte.btn;
    ok = ok && gone(texte);
    await rend("document.querySelector('#fp-mode [data-mode=\"rich\"]').click(); return true;");
    await waitFor(() => rend("return !!document.querySelector('#fp-vbody iframe');"));
    await sleep(400);
    const back = await st();
    out.richAgain = back.btn;
    ok = ok && shown(back);
    // a non-HTML file
    await openFile(REL.txt);
    await sleep(300);
    const txt = await st();
    out.textFile = txt.btn;
    ok = ok && gone(txt);
    // the viewer closed (the frame stays mounted under the hidden viewer): nothing visible
    await ready(PAGE);
    await rend("document.getElementById('fp-back').click(); return true;");
    await sleep(300);
    const closed = await st();
    out.viewerClosed = { btn: closed.btn, viewer: closed.viewer };
    ok = ok && !closed.viewer && !(closed.btn && closed.btn.vis);
    return { ok, ...out };
  });

  // ---- b -----------------------------------------------------------------------------------------------------------------
  await gate('b_enter_fills_window', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      await rend(`window.__frameEl = document.querySelector('#fp-vbody iframe'); window.__mounts = 0; window.__content = window.__frameEl.getAttribute('srcdoc') || window.__frameEl.getAttribute('src');
        if (window.__mo) window.__mo.disconnect();
        window.__mo = new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') window.__mounts++; }); window.__mo.observe(document.getElementById('files-panel'), { childList: true, subtree: true }); return true;`);
      const { clicked, s } = await enter(true);
      const same = await rend("const f = document.querySelector('#fp-vbody iframe'); return { same: f === window.__frameEl, mounts: window.__mounts, content: !!f && (f.getAttribute('srcdoc') || f.getAttribute('src')) === window.__content };");
      const cov = await covers();
      const good = clicked && isWin(s) && cov.every(Boolean) && !!s.btn && s.btn.text === 'Réduire' && s.btn.pressed === 'true' && s.fsEls.length > base.fsEls.length
        && same.same && same.mounts === 0 && same.content;
      out[k.kind] = { clicked, frameRect: s.frame, win: s.win, defaultRect: defRect[k.kind], covers: cov, btn: s.btn, viewPos: s.viewPos, fsEls: s.fsEls, same };
      ok = ok && good;
      await enter(false);
    }
    return { ok, ...out };
  });

  // ---- c -----------------------------------------------------------------------------------------------------------------
  await gate('c_reduire_restores', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      await goFull();
      const { clicked, s } = await enter(false);
      const good = clicked && inside(s.frame, s.sp) && sameRect(s.frame, defRect[k.kind]) && !isWin(s) && !!s.btn && s.btn.text === 'Plein écran' && s.btn.pressed === 'false'
        && noFull(s) && s.viewPos !== 'fixed';
      out[k.kind] = { clicked, frameRect: s.frame, sidePanel: s.sp, defaultRect: defRect[k.kind], btn: s.btn, fsEls: s.fsEls, viewPos: s.viewPos };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // ---- b2 ----------------------------------------------------------------------------------------------------------------
  await gate('b2_enter_with_sp_max', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      const maxed = await ready(k, true);
      const { clicked, s } = await enter(true);
      const cov = await covers();
      const o = await enter(false);
      await click('#sp-max');
      await waitFor(async () => !(await st()).spMax, 2000);
      await sleep(300);
      const back = await waitSettled();
      const good = maxed.spMax && clicked && isWin(s) && cov.every(Boolean) && s.spMax && o.clicked && inside(o.s.frame, o.s.sp) && sameRect(o.s.frame, maxed.frame) && noFull(o.s)
        && !back.spMax && sameRect(back.frame, defRect[k.kind]);
      out[k.kind] = { maxedFrame: maxed.frame, fullFrame: s.frame, covers: cov, afterFrame: o.s.frame, restoredFrame: back.frame, defaultRect: defRect[k.kind] };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // ---- u2 ----------------------------------------------------------------------------------------------------------------
  await gate('u2_os_window_stays_windowed', async () => {
    const snap = async () => ({ os: win.isFullScreen(), bounds: win.getBounds(), domNull: await rend('return document.fullscreenElement === null;') });
    const same = (a, b) => ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key]);
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      const before = await snap();
      const { clicked, s } = await enter(true);
      const during = await snap();
      const o = await enter(false);
      const after = await snap();
      const good = clicked && isWin(s) && o.clicked && before.os === false && before.domNull && during.os === false && during.domNull && same(before.bounds, during.bounds)
        && after.os === false && after.domNull && same(before.bounds, after.bounds);
      out[k.kind] = { before, during, after };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // ---- m -----------------------------------------------------------------------------------------------------------------
  await gate('m_motion_family_and_reduced', async () => {
    try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
    const reduced = (v) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
    await ready(RICH);
    const record = async () => {
      await rend(`window.__samples = []; const v = document.getElementById('fp-vbody'); const t0 = performance.now();
        window.__iv = setInterval(() => { const r = v.getBoundingClientRect(); const an = v.getAnimations();
          window.__samples.push({ n: an.length, l: r.left, top: r.top, w: r.width, h: r.height,
            durs: an.map((a) => a.effect.getTiming().duration), keys: [...new Set(an.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))],
            op0: an.length ? an[0].effect.getKeyframes()[0].opacity : null }); }, 8); return true;`);
      await click('#fp-full');
      await sleep(800);
      const samples = await rend('clearInterval(window.__iv); return window.__samples;');
      const anim = samples.filter((x) => x.n > 0);
      return { samples: samples.length, animSamples: anim.length, durs: [...new Set(anim.flatMap((x) => x.durs))], keys: [...new Set(anim.flatMap((x) => x.keys))],
        opacityFrom: anim.length ? anim[0].op0 : null, inBetween: samples.filter((x) => !sameRect(x, samples[0]) && !sameRect(x, samples[samples.length - 1])).length };
    };
    const tok = (n) => rend(`return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(n)}));`);
    const drawer = await tok('--dur-drawer');
    const pop = await tok('--dur-pop');
    const okKeys = (r) => r.keys.every((key) => ['transform', 'opacity', 'offset', 'easing', 'composite', 'computedOffset'].includes(key));
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
      && noFull(s), drawer, pop, enterM, exitM, matches, enterR, exitR };
  });

  // ---- f -----------------------------------------------------------------------------------------------------------------
  await gate('f_every_exit_resets', async () => {
    const out = {};
    const clean = (s) => noFull(s) && !s.spMax;
    const reset = (s) => clean(s) && !!s.btn && s.btn.text === 'Plein écran' && s.btn.pressed === 'false';
    const cases = {};
    for (const k of KINDS) {
      const fullFrom = async () => { await ready(k); return goFull(); };
      // 1. another file (a script-free page)
      await fullFrom();
      await rend(`openFileInPanel(${TJ}, ${JSON.stringify(REL.other)}); return true;`);
      const gotOther = await waitFor(() => rend("const f = document.querySelector('#fp-vbody iframe'); return !!f && f.hasAttribute('srcdoc') && f.getBoundingClientRect().width > 0 && !!f.contentDocument && f.contentDocument.title === 'Rich C';"));
      await sleep(400);
      const s1 = await waitSettled();
      const ok1 = gotOther && reset(s1) && inside(s1.frame, s1.sp) && sameRect(s1.frame, defRect.rich);
      // 2. a text file
      await fullFrom();
      await rend(`openFileInPanel(${TJ}, ${JSON.stringify(REL.txt)}); return true;`);
      await waitFor(() => rend("return !!document.querySelector('#fp-vbody .fp-code-wrap') && !document.querySelector('#fp-vbody iframe');"));
      await sleep(400);
      const s2 = await waitSettled();
      const ok2 = clean(s2) && !(s2.btn && s2.btn.vis) && inside(s2.view, s2.sp);
      // 3. « Texte » (the script-free page only: a closed page has no text toggle)
      let ok3 = true;
      let s3 = null;
      if (k.kind === 'rich') {
        await fullFrom();
        await rend("document.querySelector('#fp-mode [data-mode=\"text\"]').click(); return true;");
        await waitFor(() => rend("return !document.querySelector('#fp-vbody iframe');"));
        await sleep(400);
        s3 = await waitSettled();
        ok3 = clean(s3) && !(s3.btn && s3.btn.vis) && inside(s3.view, s3.sp);
      }
      // 4. the viewer closed, then the same file again
      await fullFrom();
      await rend("document.getElementById('fp-back').click(); return true;");
      await sleep(400);
      const s4 = await waitSettled();
      const ok4 = clean(s4) && !s4.viewer;
      await rend(`openFileInPanel(${TJ}, ${JSON.stringify(k.rel)}); return true;`);
      await waitFor(() => rend("const f = document.querySelector('#fp-vbody iframe'); return !!f && f.getBoundingClientRect().width > 0;"));
      await sleep(500);
      const r4 = await waitSettled();
      const ok4b = reset(r4) && sameRect(r4.frame, defRect[k.kind]);
      // 5. another side-panel tab (the full-screen view covers the tab bar: the switch is the one a shortcut or the API makes), then back with no path
      await fullFrom();
      await rend("window.openSidePanel('plans'); return true;");
      await waitFor(async () => (await rend('return window.sp.tab;')) === 'plans', 3000);
      await sleep(300);
      const s5 = await st();
      const ok5 = s5.tab === 'plans' && noFull(s5);
      await rend(`window.openSidePanel('files', ${TJ}); return true;`);
      await waitFor(async () => (await st()).open && (await st()).tab === 'files', 3000);
      await sleep(600);
      const r5 = await waitSettled();
      const ok5b = r5.tab === 'files' && r5.viewer && reset(r5) && sameRect(r5.frame, defRect[k.kind]);
      // 6. the panel closed, then reopened with no path (the viewer and its frame come back: full screen must not)
      await fullFrom();
      await rend('window.closeSidePanel(); return true;');
      await sleep(400);
      const s6 = await st();
      const ok6 = !s6.open && clean(s6);
      await rend(`window.openSidePanel('files', ${TJ}); return true;`);
      await waitFor(async () => (await st()).open && (await st()).tab === 'files', 3000);
      await sleep(600);
      const r6 = await waitSettled();
      const ok6b = r6.viewer && reset(r6) && sameRect(r6.frame, defRect[k.kind]);
      cases[k.kind] = { ok1, ok2, ok3, ok4, ok4b, ok5, ok5b, ok6, ok6b };
      out[k.kind] = { otherFile: { shown: gotOther, fsEls: s1.fsEls, btn: s1.btn }, textFile: { fsEls: s2.fsEls, btn: s2.btn }, texte: s3 && { fsEls: s3.fsEls, btn: s3.btn },
        viewerClosed: { fsEls: s4.fsEls, viewer: s4.viewer, back: { frame: r4.frame, btn: r4.btn } }, otherTab: { tab: s5.tab, fsEls: s5.fsEls, back: { frame: r5.frame, btn: r5.btn } },
        panelClosed: { open: s6.open, fsEls: s6.fsEls, back: { frame: r6.frame, btn: r6.btn } } };
    }
    const all = Object.values(cases).every((c) => Object.values(c).every(Boolean));
    return { ok: all, cases, defaultRect: defRect, sidePanel: spRect, ...out };
  });

  // ==== d, e, g (Escape order, Escape inside the frame, the selection ask above the full-screen view) =============================
  win.focus();
  wc.focus();
  // Deck side instruments: the keys the closed page received, and the ask send (askFromPanel stubbed, so no pty write).
  await rend(`window.__fkeys = []; window.__asks = [];
    addEventListener('message', (e) => { if (e.data && e.data.probeKey) window.__fkeys.push(e.data.probeKey); });
    overlayState.askFromPanel = (paneId, text, sink) => { window.__asks.push({ paneId, text, sink }); return { ok: true, queued: false }; };
    return true;`);
  const esc = async () => { // a trusted Escape to the focused element of the Deck document
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(500);
    return waitSettled();
  };
  const focusOf = () => rend('const a = document.activeElement; return a ? (a.id || a.tagName) : null;');

  // ---- d -----------------------------------------------------------------------------------------------------------------
  await gate('d_escape_order', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      const full = await goFull();
      const focus = await focusOf();
      const e1 = await esc();
      const e2 = await esc();
      const e3 = await esc();
      const good = isWin(full) && noFull(e1) && e1.open && e1.viewer && !e1.spMax && inside(e1.frame, e1.sp) && sameRect(e1.frame, defRect[k.kind])
        && e2.open && !e2.viewer && noFull(e2) && !e3.open && noFull(e3);
      out[k.kind] = { focus, afterEsc1: { open: e1.open, viewer: e1.viewer, fsEls: e1.fsEls, frame: e1.frame }, afterEsc2: { open: e2.open, viewer: e2.viewer }, afterEsc3: { open: e3.open } };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // With #side-panel.sp-max on: full screen off, then the maximize restored, then the viewer closed, then the panel closed.
  await gate('d2_escape_order_sp_max', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      const r0 = await ready(k, true);
      const full = await goFull();
      const e1 = await esc();
      const e2 = await esc();
      const e3 = await esc();
      const e4 = await esc();
      const good = r0.spMax && isWin(full) && full.spMax && noFull(e1) && e1.open && e1.viewer && e1.spMax && e2.open && e2.viewer && e2.spMax === false && noFull(e2)
        && e3.open && !e3.viewer && !e4.open && noFull(e4);
      out[k.kind] = { afterEsc1: { open: e1.open, spMax: e1.spMax, viewer: e1.viewer, fsEls: e1.fsEls }, afterEsc2: { open: e2.open, spMax: e2.spMax, viewer: e2.viewer },
        afterEsc3: { open: e3.open, viewer: e3.viewer }, afterEsc4: { open: e4.open } };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // Selects the text of the page and waits for the popup (script-free page: the selection in its own document opens it) or the chip (closed page).
  const selectRich = () => rend(`const f = document.querySelector('#fp-vbody iframe'); const d = f && f.contentDocument; const t = d && d.getElementById('t'); if (!t) return false;
    const r = d.createRange(); r.selectNodeContents(t); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
    d.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true;`);
  const selectInFrame = async () => {
    await rend("const f = document.querySelector('#fp-vbody iframe'); if (f) f.contentWindow.postMessage('clear', '*'); return true;");
    await sleep(200);
    return rend(`const end = Date.now() + 5000;
      const on = () => { const c = document.querySelector('.pp-ask-chip'); if (!c || c.hidden) return false; const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      while (Date.now() < end) {
        const f = document.querySelector('#fp-vbody iframe');
        if (f) { f.contentWindow.postMessage('sel', '*'); await new Promise((r) => setTimeout(r, 350)); if (on()) return true; }
        else await new Promise((r) => setTimeout(r, 100));
      }
      return false;`);
  };
  const popupCount = () => rend("return document.querySelectorAll('.ca-popup').length;");
  const popupUp = async (k) => {
    if (k.kind === 'rich') {
      const sel = await selectRich();
      await waitFor(async () => (await popupCount()) === 1, 2000);
      return { selected: sel, clicked: true };
    }
    const sel = await selectInFrame();
    const clicked = sel && (await click('.pp-ask-chip'));
    await waitFor(async () => (await popupCount()) === 1, 2000);
    return { selected: sel, clicked };
  };

  // An open ask popup keeps its own Escape first: it closes alone, the full screen stays, the next Escape leaves it.
  await gate('d3_escape_popup_first', async () => {
    const out = {};
    let ok = true;
    for (const k of KINDS) {
      await ready(k);
      await goFull();
      const up0 = await popupUp(k);
      const up = await rend("const i = document.querySelector('.ca-popup .ca-input'); return { n: document.querySelectorAll('.ca-popup').length, input: !!i && document.activeElement === i };");
      const e1 = await esc();
      const popupAfter1 = await popupCount();
      const e2 = await esc();
      const popupAfter2 = await popupCount();
      const good = up0.selected && up0.clicked && up.n === 1 && up.input && popupAfter1 === 0 && !noFull(e1) && isWin(e1) && e1.open && e1.viewer
        && noFull(e2) && e2.open && e2.viewer && popupAfter2 === 0;
      out[k.kind] = { popup: up0, popupUp: up, afterEsc1: { popups: popupAfter1, fsEls: e1.fsEls, open: e1.open, viewer: e1.viewer }, afterEsc2: { popups: popupAfter2, fsEls: e2.fsEls, open: e2.open, viewer: e2.viewer } };
      ok = ok && good;
    }
    return { ok, ...out };
  });

  // ---- d4: a popup hosted by #workspace, read through the maximize hiding --------------------------------------------------------
  // Over #side-panel.sp-max the workspace is `visibility: hidden`, and a role=dialog inside it (the usage page) inherits that, so a plain
  // visibility test reads it as closed. The Escape is dispatched at an input of the dialog: the dialog's owner closes it, the Files viewer and
  // the full screen wait.
  await gate('d4_escape_popup_in_workspace', async () => {
    await ready(RICH, true);
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
        && !noFull(held) && isWin(held) && held.open && held.viewer && held.spMax && noFull(e2) && e2.open && e2.viewer && e2.spMax,
        setup: probe, afterEscWithDialog: { fsEls: held.fsEls, open: held.open, viewer: held.viewer, spMax: held.spMax, frame: held.frame },
        afterEscNoDialog: { fsEls: e2.fsEls, open: e2.open, viewer: e2.viewer, spMax: e2.spMax } };
    } finally {
      await rend("const d = document.getElementById('__probe-dialog'); if (d) d.remove(); return true;");
    }
  });

  // ---- e: Escape typed with the focus INSIDE the frame ------------------------------------------------------------------------------
  // The closed page is a separate process: main sees the Escape (plugin-view-escape) and the Deck acts only when that frame has the focus. The
  // script-free page is a same-origin frame whose Escape ALSO reaches the Deck document by itself (files-panel.js lockFrame): both paths run for
  // one press, so a press that stepped back twice would show as the viewer closing with the full screen.
  await gate('e_escape_inside_frame', async () => {
    const cdp = (m, p) => wc.debugger.sendCommand(m, p);
    try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
    const frameHasFocus = (k) => (k.kind === 'rich'
      ? rend("const f = document.querySelector('#fp-vbody iframe'); return !!f && f.contentDocument.hasFocus();").catch(() => false)
      : (frames()[0] ? frames()[0].executeJavaScript('document.hasFocus()').catch(() => false) : false));
    const deckActive = () => rend("return document.activeElement === document.querySelector('#fp-vbody iframe');");
    const focusFrame = async (k) => {
      await rend("document.querySelector('#fp-vbody iframe').focus(); return true;");
      await sleep(200);
      let has = await frameHasFocus(k);
      if (!has) {
        const c = await rend("const r = document.querySelector('#fp-vbody iframe').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };");
        for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await sleep(300);
        has = await frameHasFocus(k);
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
    // the script-free frame is same-origin: the probe listens in its own document to prove the key arrived there
    const watchRich = () => rend("const f = document.querySelector('#fp-vbody iframe'); f.contentDocument.addEventListener('keydown', (e) => { window.__fkeys.push(e.key); }, true); return true;");
    const inFrame = async (k, wantFull, wantMax, preferred) => {
      const arm = async () => { await ready(k, wantMax); if (k.kind === 'rich') await watchRich(); if (wantFull) await goFull(); return focusFrame(k); };
      let active = await arm();
      const tried = [];
      for (const [route, send] of routes) {
        if (preferred && route !== preferred) continue;
        await rend('window.__fkeys.length = 0; return true;');
        mainSaw = 0;
        await send();
        await sleep(700);
        const frameKeys = await rend('return window.__fkeys.length;');
        tried.push({ route, frameKeys, mainSaw });
        if (frameKeys > 0) return { active, route, tried, s: await waitSettled() };
        active = await arm(); // the route that missed the frame may have reached the Deck: start the next one clean
      }
      return { active, route: null, tried, s: await st() };
    };
    try {
      const out = {};
      let ok = true;
      for (const k of KINDS) {
        const a = await inFrame(k, true, false);
        const idle = await inFrame(k, false, false, a.route);
        const m = await inFrame(k, true, true, a.route);
        const rep = [];
        if (k.kind === 'rich') for (let i = 0; i < 2; i++) rep.push(await inFrame(k, true, false, a.route));
        // one press, one step: the full screen is off, the viewer is still open on its frame, the panel too
        const oneStep = (r) => !!r.route && r.active && noFull(r.s) && r.s.open && r.s.viewer && !!r.s.frame;
        const good = !!a.route && oneStep(a) && !a.s.spMax && sameRect(a.s.frame, defRect[k.kind])
          && idle.active && idle.route === a.route && noFull(idle.s) && idle.s.open && (k.kind === 'rich' || (idle.s.viewer && sameRect(idle.s.frame, defRect[k.kind])))
          && m.active && m.route === a.route && oneStep(m) && m.s.spMax && rep.every(oneStep);
        out[k.kind] = { route: a.route, full: { tried: a.tried, active: a.active, fsEls: a.s.fsEls, open: a.s.open, viewer: a.s.viewer, spMax: a.s.spMax },
          idle: { tried: idle.tried, fsEls: idle.s.fsEls, open: idle.s.open, viewer: idle.s.viewer },
          fullWithMax: { tried: m.tried, fsEls: m.s.fsEls, open: m.s.open, viewer: m.s.viewer, spMax: m.s.spMax },
          repeats: rep.map((r) => ({ route: r.route, fsEls: r.s.fsEls, open: r.s.open, viewer: r.s.viewer })) };
        ok = ok && good;
      }
      return { ok, ...out };
    } finally {
      wc.off('before-input-event', onBei);
    }
  });

  // ---- g: the selection ask above the full-screen view ---------------------------------------------------------------------------
  // The closed page: select, the chip, its click, the popup, the send, the answer in the dock, « Réduire ». The script-free page: the popup, the send.
  const hitOf = (sel) => rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
    const b = n.getBoundingClientRect(); const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
    const h = document.elementFromPoint(cx, cy);
    const name = (e) => e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '');
    return { cx, cy, hit: h ? name(h) : null, onTop: !!h && n.contains(h), inWin: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
      box: { l: b.left, top: b.top, w: b.width, h: b.height }, pos: getComputedStyle(n).position, hidden: n.hidden };`);
  const askFlow = async (k, wantMax) => {
    const out = {};
    await ready(k, wantMax);
    await goFull();
    await rend('window.__asks.length = 0; return true;');
    if (k.kind === 'rich') out.selected = await selectRich();
    else {
      out.selected = await selectInFrame();
      out.chip = await hitOf('.pp-ask-chip');
      out.clicked = out.selected && (await click('.pp-ask-chip'));
    }
    await waitFor(async () => (await popupCount()) === 1, 2000);
    out.popup = await hitOf('.ca-popup');
    out.popupN = await popupCount();
    out.title = await rend("const t = document.querySelector('.ca-popup .ca-title'); return t ? t.textContent : null;");
    out.sent = await rend(`const i = document.querySelector('.ca-popup .ca-input'); if (!i) return null;
      i.value = 'Pourquoi ceci ?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const a = window.__asks[0]; if (a) { a.sink.update('Réponse de test'); a.sink.done(); }
      return { n: window.__asks.length, text: a ? a.text : null, popups: document.querySelectorAll('.ca-popup').length };`);
    await sleep(300);
    out.dock = await hitOf('#fp-asks');
    out.bubble = await hitOf(k.kind === 'rich' ? '#fp-vbody .ca-bubble' : '#fp-asks .ca-bubble');
    out.full = isWin(await st());
    await click('#fp-full'); // « Réduire »
    await waitSettled();
    out.after = await hitOf('#fp-asks');
    out.afterSp = (await st()).sp;
    out.afterFull = !noFull(await st());
    return out;
  };
  const flows = { rich: {}, page: {} };
  for (const k of KINDS) {
    for (const [mode, m] of [['plain', false], ['max', true]]) {
      try { flows[k.kind][mode] = await askFlow(k, m); } catch (err) { flows[k.kind][mode] = { threw: String(err && err.stack || err).slice(0, 300) }; }
    }
  }
  await gate('g_chip_and_ask_above_view', async () => {
    const sentOk = (f) => !!f.sent && f.sent.n === 1 && f.sent.popups === 0 && typeof f.sent.text === 'string' && f.sent.text.includes(SEL_TEXT) && f.sent.text.includes('Pourquoi ceci ?');
    const good = (k, f) => !!f && !f.threw && f.selected && f.popupN === 1 && f.title === 'Demander à Claude' && !!f.popup && f.popup.onTop && f.popup.inWin && sentOk(f)
      && (k.kind === 'rich' || (!!f.chip && f.chip.onTop && f.chip.inWin && f.clicked));
    const slim = (f) => f && { threw: f.threw, chip: f.chip, popup: f.popup, popupN: f.popupN, sent: f.sent };
    return { ok: KINDS.every((k) => good(k, flows[k.kind].plain) && good(k, flows[k.kind].max)),
      rich: { plain: slim(flows.rich.plain), max: slim(flows.rich.max) }, page: { plain: slim(flows.page.plain), max: slim(flows.page.max) } };
  });
  await gate('g2_dock_above_view', async () => {
    const good = (f) => !!f && !f.threw && f.full === true && !!f.dock && f.dock.hidden === false && f.dock.onTop && f.dock.inWin && !!f.bubble && f.bubble.onTop
      && !!f.after && f.after.hidden === false && f.after.pos !== 'fixed' && f.afterFull === false
      && f.after.box.l >= f.afterSp.l - 1 && f.after.box.top >= f.afterSp.top - 1 && f.after.box.l + f.after.box.w <= f.afterSp.l + f.afterSp.w + 1 && f.after.box.top + f.after.box.h <= f.afterSp.top + f.afterSp.h + 1;
    const slim = (f) => f && { threw: f.threw, dock: f.dock, bubble: f.bubble, after: f.after, sidePanel: f.afterSp };
    return { ok: good(flows.page.plain) && good(flows.page.max), plain: slim(flows.page.plain), max: slim(flows.page.max) };
  });

  // ---- h: the chip after a full-screen toggle ----------------------------------------------------------------------------------------
  // The chip is fixed in body at the selection's Deck coordinates; the toggle moves the frame under it. After each toggle it must be hidden or sit
  // where the live selection (read in the frame itself) ends: the expected spot is frame-ask.js's own rule applied to the frame's current box.
  const chipVsSelection = async () => {
    const c = await rend(`const n = document.querySelector('.pp-ask-chip'); if (!n) return null; const b = n.getBoundingClientRect(); const f = document.querySelector('#fp-vbody iframe').getBoundingClientRect();
      return { vis: !n.hidden && b.width > 0 && b.height > 0, l: b.left, top: b.top, w: b.width, h: b.height, fl: f.left, ft: f.top, iw: innerWidth, ih: innerHeight };`);
    const sel = await frames()[0].executeJavaScript(`(() => { const s = getSelection(); if (!s.rangeCount || s.isCollapsed) return null; const r = s.getRangeAt(0).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    if (!c) return { vis: false, noChip: true, selKept: !!sel };
    const expL = Math.min(Math.max(8, c.fl + (sel ? sel.left + sel.width : 0)), c.iw - c.w - 8);
    const expT = Math.min(Math.max(8, c.ft + (sel ? sel.top + sel.height : 0) + 6), c.ih - c.h - 8);
    return { vis: c.vis, left: Math.round(c.l), top: Math.round(c.top), expectedLeft: Math.round(expL), expectedTop: Math.round(expT), off: Math.round(Math.hypot(c.l - expL, c.top - expT)), selKept: !!sel };
  };
  await gate('h_chip_follows_toggle', async () => {
    await ready(PAGE);
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

  // ---- i: the view above a live session pane -------------------------------------------------------------------------------------------
  // A session pane's .xterm-viewport (z-index 3) lives in the root stacking context: a full-screen view that does not outrank it would paint and take
  // the clicks under it. The pane is opened the user's way (its terminal face), the file is entered in full screen, and the hit at the pane centre and on
  // its scrollbar must be inside the view. At rest the same points are the xterm layer, so a pane that is not under those points cannot pass for free.
  const paneHits = () => rend(`const v = document.getElementById('fp-vbody'); const vp = document.querySelector('#grid .pane .xterm-viewport'); if (!vp) return null;
    const r = vp.getBoundingClientRect(); const name = (e) => (e ? e.tagName + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') : null);
    const at = (x, y) => { const e = document.elementFromPoint(x, y); return { hit: name(e), inView: !!e && v.contains(e), inXterm: !!e && !!e.closest('.xterm') }; };
    return { rect: { l: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, centre: at(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)),
      scrollbar: at(Math.round(r.right - 4), Math.round(r.top + r.height / 2)) };`);
  await gate('i_full_above_session_panes', async () => {
    await rend(`openPane({ cwd: ${JSON.stringify(dirs.proj)}, resumeId: ${JSON.stringify(SID)}, title: 'z' }); return true;`);
    const paneUp = await waitFor(() => rend("return !!document.querySelector('#grid .pane .xterm-viewport');"), 10000);
    await rend(`const p = document.querySelector('#grid .pane'); const seg = p && p.querySelector('.pv-seg[data-face="terminal"]'); if (seg && p.classList.contains('chat-mode')) seg.click(); return true;`);
    await sleep(500);
    const flow = async (k, wantMax) => {
      await ready(k, wantMax);
      const rest = await paneHits();
      const full = await goFull();
      const hits = await paneHits();
      // the corners and the centre hit the view, or the answers dock (it rides above the view on purpose)
      const corners = await rend(`const v = document.getElementById('fp-vbody'), d = document.getElementById('fp-asks');
        const pts = [[6, 6], [innerWidth - 6, 6], [6, innerHeight - 6], [innerWidth - 6, innerHeight - 6], [Math.round(innerWidth / 2), Math.round(innerHeight / 2)]];
        return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y);
          return { who: e ? e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') : null, ok: !!e && (v.contains(e) || d.contains(e)) }; });`);
      await enter(false);
      return { rest, hits, corners, fills: isWin(full), spMax: full.spMax };
    };
    const above = (f) => !!f.hits && f.hits.centre.inView && f.hits.scrollbar.inView && f.corners.every((c) => c.ok) && f.fills;
    const out = {};
    let ok = paneUp;
    for (const k of KINDS) {
      const plain = await flow(k, false);
      const max = await flow(k, true);
      out[k.kind] = { plain, max };
      ok = ok && !!plain.rest && plain.rest.rect.w > 0 && plain.rest.centre.inXterm && plain.rest.scrollbar.inXterm && above(plain) && max.spMax === true && above(max);
    }
    return { ok, paneUp, ...out };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
