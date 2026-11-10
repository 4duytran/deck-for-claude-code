'use strict';
// plugin-motion-probe — plugins-v4 step m1 (K6): the page-swap primitives of renderer/js/motion.js and the full-screen transition of plugin-full.js.
// The REAL app boots over throwaway fixtures (empty plugins folder); the renderer imports the live motion.js module and the probe reads real
// Animation objects (WAAPI), so a verdict is what the page actually ran. Token durations are overridden on :root (333 / 444 ms) to prove
// the primitives read the tokens and not a fallback.
//   v1 swapIn / revealFrame exported, swapOut absent; each animates opacity / transform only, one finite iteration, duration = its token
//      (in --dur-drawer), the slide is 8-12 px and flips sign with dir, nothing is left behind after the end (no animation,
//      no inline transform / opacity)
//   v2 prefers-reduced-motion: reduce emulated (Emulation.setEmulatedMedia): zero animation objects, the end state at once (swapIn
//      shows, revealFrame reveals on load with nothing running), swapOut still absent
//   v3 revealFrame(iframe) keeps opacity 0 until the frame's `load`, then 1 (a fade, opacity only); a frame that never loads is revealed by a bound
//   v4 full screen enter / exit (#plg-full over a report frame): transform / opacity only, finite, enter on --dur-drawer with a cross-fade from
//      below 1, exit on --dur-pop, no inline transform / opacity left, and under reduced motion no animation at all
//   v5 list <-> detail (plugin-panel.js): the incoming page runs swapIn (opacity / transform only, one finite iteration, --dur-drawer, no fill, 8-12 px from the
//      side it is read from: forward from the right, back from the left) and nothing is left behind (no animation, no inline transform / opacity)
//   v6 tab swaps report -> journal -> report -> history -> settings and a history pick: the content on screen is replaced at once (no leaving fade), the next one arrives with
//      swapIn (journal, #plg-hist, #plg-settings) or is revealed on its load (report frame); every animation is opacity / transform only and finite
//   v7 an incoming report iframe stays at opacity 0 until its `load` (a stylesheet held back by the probe keeps the load ~350 ms away), then fades to 1
//   v8 no white frame: per-frame capturePage samples of #plg-view during report -> journal -> report (the panel and its reports are dark-only) stay within the dark baseline
//      (the white of an iframe that paints before its page is ready is the regression this pins)
//   v9 prefers-reduced-motion: every swap (page, tab, history pick, frame) ends with zero animation objects, in the same task for the synchronous ones
//   v10 full screen toggled during a page swap ends at inset 0 with no transform or animation left on any ancestor of #plg-view, and leaves cleanly
//   v11 no animation with infinite iterations in the panel, whatever the swaps before it started (the animations they collected are re-read)
// Run (from the repo root): env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//   xvfb-run -a node_modules/.bin/electron test/plugin-motion-probe.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const REPO = path.join(__dirname, '..');
// restyle lot L4 (motion.js options, additive):
//   v12 exitThen(el, kf, {dur: '--token'}) runs on that token (a made-up --dur-probe = 777 ms proves the read), no option = --dur-drawer as before,
//       numeric {duration} still honoured, an unknown token takes the helper's fallback; transform / opacity only, hidden at the end
//   v13 swapIn(el, {dir, dur}) the same: token duration, default --dur-drawer, side slide kept, nothing left behind
//   v14 collapse / expand(el, {scope}): over a nested fixture (scope > section > card > body, later siblings at each level) every in-flow later
//       sibling of el and of each ancestor below the scope glides by the same distance (composite add), earlier / out-of-flow / outside-scope
//       ones do not; every rect is read before the single display write; without a scope only the direct siblings glide, one read, one write
const NAMES = ['v1_swap_primitives_token_timing', 'v2_reduced_motion_no_animation', 'v3_reveal_frame_waits_for_load', 'v4_full_screen_same_timing_family',
  'v5_page_swap_list_detail', 'v6_tab_swaps_and_history_pick', 'v7_report_frame_held_until_load', 'v8_no_white_frame_in_dark', 'v9_reduced_motion_panel_swaps',
  'v10_full_screen_during_page_swap', 'v11_no_infinite_animation', 'v12_exit_dur_token', 'v13_swap_dur_token', 'v14_collapse_scope'];
const pad = (n) => String(n).padStart(2, '0');
// the report of the fixture plugin: a dark page, as every plugin report is served (so its settled state is the dark baseline of v8); the Google Fonts stylesheet (allowed by the plugin page CSP) is held back by the
// probe (run()), so the frame's `load` comes ~350 ms after it is attached and the white of an unrevealed iframe has time to show
const REPORT_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>r</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
  + '<style>html{background:#14161a;color:#9aa4b2}body{margin:16px}</style></head><body><p>Rapport de la fixture</p></body></html>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const detail = {};
let finished = false;

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-motion-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), plugins: path.join(root, 'plugins'), home: path.join(root, 'home'), projects: path.join(root, 'projects'),
    ask: path.join(root, 'ask'), status: path.join(root, 'status'), sh: path.join(root, 'sh') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'plugins', 'fake-shell.sh'), path.join(dirs.sh, 'bash')); // the host reads this stand-in, never a real shell
  fs.chmodSync(path.join(dirs.sh, 'bash'), 0o755);
  const pdir = path.join(dirs.plugins, 'mpa');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pdir, 'deck-plugin.json'), JSON.stringify({ id: 'mpa', argv: ['run.sh'], trigger: 'manual', label: 'Fixture mpa', description: 'Plugin avec rapports.', env: [] }));
  const entry = (minutesAgo, trigger, exit, report) => { // history written straight into the reports dir (stem = local start minute)
    const d = new Date(Date.now() - minutesAgo * 60000);
    d.setSeconds(0, 0);
    const stem = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
    const dir = path.join(dirs.ud, 'plugin-data', 'mpa', 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ start: d.getTime(), trigger, exit, size: report ? REPORT_HTML.length : null, pid: null }));
    fs.writeFileSync(path.join(dir, `${stem}.log`), 'ligne de journal de la fixture\n');
    if (report) fs.writeFileSync(path.join(dir, `${stem}.html`), REPORT_HTML);
  };
  entry(5, 'auto', 0, true);
  entry(1445, 'manual', 0, true);
  entry(2885, 'auto', 1, false);
  return dirs;
}

function verdict(code) {
  if (finished) return;
  finished = true;
  for (const n of NAMES) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}${results[n] ? '' : ` ${JSON.stringify(detail[n])}`}`);
  const v8 = detail['v8_no_white_frame_in_dark'];
  if (v8) console.log(`INFO v8 ${JSON.stringify({ base: v8.base, worst: v8.worst, nBase: v8.nBase, shots: v8.shots, nz: v8.nz, series: v8.series })}`);
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
  app.whenReady().then(() => run()).catch((err) => {
    console.log(`FAIL probe crashed: ${err && err.stack}`);
    verdict(2);
  });
}

const OK_KEYS = ['opacity', 'transform', 'translate', 'scale', 'rotate', 'offset', 'easing', 'composite', 'computedOffset'];
const onlyCompositor = (keys) => Array.isArray(keys) && keys.length > 0 && keys.every((k) => OK_KEYS.includes(k));

// Renderer helpers shared by the gates (inlined into each executeJavaScript call).
const PRELUDE = `
  const m = await import('./js/motion.js');
  const root = document.documentElement;
  const mk = () => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:40px;top:40px;width:120px;height:80px;background:#888'; document.body.append(d); return d; };
  const info = (el) => el.getAnimations().map((a) => { const t = a.effect.getTiming(); const kf = a.effect.getKeyframes();
    return { dur: t.duration, iter: String(t.iterations), fill: t.fill, keys: [...new Set(kf.flatMap((k) => Object.keys(k)))], first: kf[0].transform || null, firstOpacity: kf[0].opacity === undefined ? null : Number(kf[0].opacity) }; });
  const clean = (el) => ({ anims: el.getAnimations().length, tr: el.style.transform, op: el.style.opacity, display: el.style.display });
  const loaded = (f) => new Promise((r) => f.addEventListener('load', r, { once: true }));
  const slide = (s) => { const x = /translateX\\((-?[0-9.]+)px\\)/.exec(s || ''); return x ? Number(x[1]) : null; };
  const tok = (n) => parseFloat(getComputedStyle(root).getPropertyValue(n));
  const panel = document.getElementById('plugin-panel');
  const tag = (t) => (t.id ? '#' + t.id : (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : t.tagName.toLowerCase()));
  const snap = () => document.getAnimations().filter((a) => a.effect && a.effect.target && panel.contains(a.effect.target)).map((a) => {
    const t = a.effect.getTiming(); const kf = a.effect.getKeyframes();
    return { at: tag(a.effect.target), css: a instanceof CSSTransition || a instanceof CSSAnimation, dur: t.duration, iter: String(t.iterations), fill: t.fill,
      keys: [...new Set(kf.flatMap((k) => Object.keys(k)))], o0: kf[0].opacity === undefined ? null : Number(kf[0].opacity),
      o1: kf[kf.length - 1].opacity === undefined ? null : Number(kf[kf.length - 1].opacity), x0: slide(kf[0].transform) }; });
  const watch = async (action, wait) => {
    const seen = new Map();
    const take = () => { for (const s of snap()) seen.set(JSON.stringify(s), s); };
    const iv = setInterval(take, 16);
    take(); action(); take();
    await new Promise((r) => setTimeout(r, wait));
    clearInterval(iv); take();
    const list = [...seen.values()];
    (window.__mp = window.__mp || { seen: [] }).seen.push(...list);
    return list;
  };
  const rest = () => ({ anims: snap().length, inline: [...panel.querySelectorAll('[style]')].filter((n) => /transform|opacity/.test(n.getAttribute('style'))).map(tag) });
`;

async function run() {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 300 s' }; }
    verdict(2);
  }, 300000);
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
  const rend = (code) => wc.executeJavaScript(`(async () => { ${PRELUDE} ${code} })()`, true);
  const reduced = (v) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
  const gate = async (name, fn) => {
    try {
      const r = await fn();
      results[name] = !!(r && r.ok);
      detail[name] = r;
    } catch (err) {
      results[name] = false;
      detail[name] = { error: String(err && err.message ? err.message : err) };
    }
  };
  await reduced('no-preference');

  // ---- v1 ------------------------------------------------------------------------------------------------------
  await gate('v1_swap_primitives_token_timing', async () => {
    const r = await rend(`
      const types = ['swapIn', 'revealFrame'].map((k) => typeof m[k]);
      const outType = typeof m.swapOut;
      if (types.some((t) => t !== 'function') || outType !== 'undefined') return { types, outType };
      root.style.setProperty('--dur-drawer', '444ms');
      try {
        const el = mk();
        el.style.display = 'none';
        const pIn = m.swapIn(el, { dir: 'forward' });
        const inFwd = info(el);
        await pIn;
        const afterIn = clean(el);
        el.style.display = 'none';
        const pBack = m.swapIn(el, { dir: 'back' });
        const inBack = info(el);
        await pBack;
        const afterBack = clean(el);
        el.remove();
        return { types, outType, inFwd, afterIn, inBack, afterBack, fwd: slide(inFwd[0] && inFwd[0].first), back: slide(inBack[0] && inBack[0].first) };
      } finally { root.style.removeProperty('--dur-drawer'); }
    `);
    const one = (a, dur) => a.length === 1 && a[0].dur === dur && a[0].iter === '1' && onlyCompositor(a[0].keys);
    const gone = (c) => c.anims === 0 && c.tr === '' && c.op === '';
    const ok = r.types.every((t) => t === 'function') && r.outType === 'undefined'
      && one(r.inFwd, 444) && r.inFwd[0].fill === 'none' && r.inFwd[0].keys.includes('opacity') && r.inFwd[0].keys.includes('transform')
      && r.afterIn.display === '' && gone(r.afterIn) && one(r.inBack, 444) && r.afterBack.display === '' && gone(r.afterBack)
      && Math.abs(r.fwd) >= 8 && Math.abs(r.fwd) <= 12 && Math.abs(r.back) >= 8 && Math.abs(r.back) <= 12 && Math.sign(r.fwd) === -Math.sign(r.back);
    return { ok, ...r };
  });

  // ---- v2 ------------------------------------------------------------------------------------------------------
  await gate('v2_reduced_motion_no_animation', async () => {
    await reduced('reduce');
    try {
      const r = await rend(`
        const matches = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (['swapIn', 'revealFrame'].some((k) => typeof m[k] !== 'function') || typeof m.swapOut !== 'undefined') return { matches, missing: true };
        const el = mk();
        el.style.display = 'none';
        const pIn = m.swapIn(el, { dir: 'back' });
        const syncIn = { ...clean(el), hidden: el.hidden };
        await pIn;
        el.remove();
        const f = document.createElement('iframe');
        f.srcdoc = '<p>x</p>';
        m.revealFrame(f);
        document.body.append(f);
        const lp = loaded(f);
        const beforeLoad = f.style.opacity;
        await lp;
        const rv = { beforeLoad, afterLoad: f.style.opacity, anims: f.getAnimations().length };
        f.remove();
        return { matches, syncIn, rv };
      `);
      const ok = r.matches === true && !r.missing && r.syncIn.anims === 0 && r.syncIn.display === '' && r.syncIn.hidden === false
        && r.syncIn.tr === '' && r.syncIn.op === '' && r.rv.beforeLoad === '0' && r.rv.afterLoad === '' && r.rv.anims === 0;
      return { ok, ...r };
    } finally { await reduced('no-preference'); }
  });

  // ---- v3 ------------------------------------------------------------------------------------------------------
  await gate('v3_reveal_frame_waits_for_load', async () => {
    const r = await rend(`
      if (typeof m.revealFrame !== 'function') return { missing: true };
      const f = document.createElement('iframe');
      f.srcdoc = '<!doctype html><html><body style="background:#123"><p>x</p></body></html>';
      f.style.cssText = 'position:fixed;left:200px;top:40px;width:200px;height:120px;border:0';
      m.revealFrame(f);
      const heldDetached = f.style.opacity;
      await new Promise((r) => setTimeout(r, 150));
      const heldLater = f.style.opacity;
      document.body.append(f);
      const heldAppended = { inline: f.style.opacity, computed: getComputedStyle(f).opacity };
      await loaded(f);
      const atLoad = { inline: f.style.opacity, anims: info(f) };
      await Promise.all(f.getAnimations().map((a) => a.finished));
      const end = { ...clean(f), computed: getComputedStyle(f).opacity };
      f.remove();
      const never = document.createElement('iframe');
      m.revealFrame(never, { maxMs: 120 });
      const neverHeld = never.style.opacity;
      await new Promise((r) => setTimeout(r, 450));
      return { heldDetached, heldLater, heldAppended, atLoad, end, neverHeld, neverAfter: never.style.opacity };
    `);
    const ok = !r.missing && r.heldDetached === '0' && r.heldLater === '0' && r.heldAppended.inline === '0' && r.heldAppended.computed === '0'
      && r.atLoad.inline === '' && r.atLoad.anims.length === 1 && r.atLoad.anims[0].iter === '1' && r.atLoad.anims[0].keys.every((k) => ['opacity', 'offset', 'easing', 'composite', 'computedOffset'].includes(k))
      && r.atLoad.anims[0].firstOpacity === 0 && r.end.anims === 0 && r.end.op === '' && r.end.tr === '' && r.end.computed === '1'
      && r.neverHeld === '0' && r.neverAfter === '';
    return { ok, ...r };
  });

  // ---- panel gates (v5-v11): the REAL panel over the fixture plugin `mpa` -------------------------------------------
  // The stylesheet of the fixture report is held 350 ms and then cancelled, so a frame's `load` is that far away.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://fonts.googleapis.com/*'] }, (_d, cb) => { setTimeout(() => cb({ cancel: true }), 350); });
  const P = {
    pick: `document.querySelector('#plg-list .plg-row[data-id="mpa"] [data-act="pick"]').click();`,
    back: `document.getElementById('plg-back').click();`,
    tab: (t) => `document.querySelector('#plg-detail [data-tab="${t}"]').click();`,
  };
  const until = async (expr, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { if (await rend(`return !!(${expr});`)) return true; await sleep(50); } return false; };
  const FRAME_SETTLED = `(() => { const f = document.querySelector('#plg-view > iframe'); return !!f && f.style.opacity === '' && f.getAnimations().length === 0; })()`;
  const prepPanel = async () => { // closed, then opened on the list page with the fixture row, entrance finished
    await rend(`if (window.plg.open) document.getElementById('plg-close').click(); return true;`);
    await sleep(500);
    await rend(`document.getElementById('plugin-toggle').click(); return true;`);
    const rows = await until(`document.querySelectorAll('#plg-list .plg-row[data-id="mpa"]').length === 1`);
    await sleep(1000);
    return rows;
  };
  const openReport = async () => { await rend(P.pick); return until(FRAME_SETTLED, 8000); };
  const scripted = (xs) => xs.filter((a) => !a.css);
  const calm = (xs) => scripted(xs).every((a) => onlyCompositor(a.keys) && a.iter === '1');
  const slideOk = (x, sign) => Number.isFinite(x) && Math.abs(x) >= 8 && Math.abs(x) <= 12 && Math.sign(x) === sign;
  const arrives = (xs, ats, drawer, sign) => { // an incoming box: swapIn signature (0 -> 1 opacity, token duration, no fill, a 10 px side slide)
    const m = scripted(xs).filter((a) => ats.includes(a.at) && a.o0 === 0 && a.o1 === 1 && a.fill === 'none' && a.dur === drawer && a.iter === '1' && a.keys.includes('transform') && slideOk(a.x0, sign));
    return m.length > 0;
  };

  // ---- v4 ------------------------------------------------------------------------------------------------------
  await gate('v4_full_screen_same_timing_family', async () => {
    const opened = (await prepPanel()) && (await openReport()); // the real report frame of the fixture plugin, in the detail page
    const record = () => rend(`
      const v = document.getElementById('plg-view'), p = document.getElementById('plugin-panel'), b = document.getElementById('plg-full');
      const ms = (n) => parseFloat(getComputedStyle(root).getPropertyValue(n));
      const was = p.classList.contains('plg-fullscreen');
      const samples = [];
      const iv = setInterval(() => { const an = v.getAnimations(); samples.push({ n: an.length,
        t: an.map((a) => { const t = a.effect.getTiming(); const kf = a.effect.getKeyframes();
          return { dur: t.duration, iter: String(t.iterations), keys: kf.flatMap((k) => Object.keys(k)), kfOpacity: kf.map((k) => (k.opacity === undefined ? null : Number(k.opacity))) }; }) }); }, 16);
      b.click();
      await new Promise((r) => setTimeout(r, 900));
      clearInterval(iv);
      const t = samples.flatMap((s) => s.t);
      return { was, now: p.classList.contains('plg-fullscreen'), animSamples: samples.filter((s) => s.n > 0).length,
        keys: [...new Set(t.flatMap((x) => x.keys))], iters: [...new Set(t.map((x) => x.iter))], durs: [...new Set(t.map((x) => x.dur))],
        minOpacity: Math.min(1, ...t.flatMap((x) => x.kfOpacity.filter((o) => o !== null))), pop: ms('--dur-pop'), drawer: ms('--dur-drawer'),
        left: { anims: v.getAnimations().length, tr: v.style.transform, op: v.style.opacity } };
    `);
    await reduced('no-preference');
    const enter = await record();
    const exit = await record();
    await reduced('reduce');
    const matches = await rend("return matchMedia('(prefers-reduced-motion: reduce)').matches;");
    const redIn = await record();
    const redOut = await record();
    await reduced('no-preference');
    const clean = (x) => x.left.anims === 0 && x.left.tr === '' && x.left.op === '';
    const anim = (x) => x.animSamples > 0 && onlyCompositor(x.keys) && x.iters.every((i) => i === '1') && clean(x);
    const still = (x) => x.animSamples === 0 && clean(x);
    const ok = opened && matches === true && enter.was === false && enter.now === true && exit.was === true && exit.now === false && redIn.now === true && redOut.now === false
      && anim(enter) && enter.durs.includes(enter.drawer) && enter.keys.includes('opacity') && enter.minOpacity < 1
      && anim(exit) && exit.durs.includes(exit.pop) && still(redIn) && still(redOut);
    return { ok, opened, matches, enter, exit, redIn, redOut };
  });

  // ---- v5 ------------------------------------------------------------------------------------------------------
  await gate('v5_page_swap_list_detail', async () => {
    const rows = await prepPanel();
    const fwd = await rend(`const r = await watch(() => { ${P.pick} }, 700); return { r, rest: rest(), page: panel.dataset.page, drawer: tok('--dur-drawer'), pop: tok('--dur-pop') };`);
    await until(FRAME_SETTLED, 8000);
    const bck = await rend(`const r = await watch(() => { ${P.back} }, 700); return { r, rest: rest(), page: panel.dataset.page, drawer: tok('--dur-drawer') };`);
    const ok = rows && fwd.page === 'detail' && bck.page === 'list'
      && arrives(fwd.r, ['#plg-dhead', '#plg-detail', '#plg-back'], fwd.drawer, 1) && calm(fwd.r) && fwd.rest.anims === 0 && fwd.rest.inline.length === 0
      && arrives(bck.r, ['#plg-page-list'], bck.drawer, -1) && calm(bck.r) && bck.rest.anims === 0 && bck.rest.inline.length === 0;
    return { ok, rows, fwd, bck };
  });

  // ---- v6 ------------------------------------------------------------------------------------------------------
  await gate('v6_tab_swaps_and_history_pick', async () => {
    const opened = await openReport();
    const step = (code, ms) => rend(`const r = await watch(() => { ${code} }, ${ms}); return { r, rest: rest(), drawer: tok('--dur-drawer'), pop: tok('--dur-pop') };`);
    const outs = (xs) => !scripted(xs).some((a) => a.o0 === 1 && a.o1 === 0 && a.fill === 'forwards'); // the view changes at once: no leaving fade (opacity 1 -> 0, fill forwards) holds the old content
    const reveal = (xs, pop) => scripted(xs).some((a) => a.at === '.fp-frame' && a.o0 === 0 && a.o1 === 1 && a.dur === pop && a.iter === '1' && a.keys.every((k) => ['opacity', 'offset', 'easing', 'composite', 'computedOffset'].includes(k)));
    const toJournal = await step(P.tab('journal'), 900);
    const toReport = await step(P.tab('report'), 1500);
    await until(FRAME_SETTLED, 8000);
    const toHist = await step(P.tab('history'), 700);
    const toSet = await step(P.tab('settings'), 700);
    await step(P.tab('history'), 700);
    const rowsIn = await until(`document.querySelectorAll('#plg-rows .plg-hrow').length >= 2`);
    const pickRow = await step(`document.querySelectorAll('#plg-rows .plg-hrow')[1].click();`, 1600);
    const all = [toJournal, toReport, toHist, toSet, pickRow];
    const ok = opened && rowsIn
      && outs(toJournal.r, toJournal.pop) && arrives(toJournal.r, ['.plg-journal', '.plg-jbox', '.plg-view-note'].concat(toJournal.r.map((a) => a.at)), toJournal.drawer, 1)
      && outs(toReport.r, toReport.pop) && reveal(toReport.r, toReport.pop)
      && arrives(toHist.r, ['#plg-hist'], toHist.drawer, 1) && arrives(toSet.r, ['#plg-settings'], toSet.drawer, 1)
      && reveal(pickRow.r, pickRow.pop)
      && all.every((x) => calm(x.r) && x.rest.anims === 0 && x.rest.inline.length === 0);
    return { ok, opened, rowsIn, toJournal, toReport, toHist, toSet, pickRow };
  });

  // ---- v7 ------------------------------------------------------------------------------------------------------
  await gate('v7_report_frame_held_until_load', async () => {
    await rend(`if (!window.plg.open) document.getElementById('plugin-toggle').click(); return true;`);
    await until(`document.querySelectorAll('#plg-list .plg-row[data-id="mpa"]').length === 1`);
    await rend(`if (panel.dataset.page === 'detail') document.getElementById('plg-back').click(); return true;`);
    await sleep(500);
    const r = await rend(`
      const v = document.getElementById('plg-view');
      const rec = { attach: null, polls: [], load: null, end: null };
      const mo = new MutationObserver(() => {
        const f = v.querySelector(':scope > iframe');
        if (!f || f.__seen) return;
        f.__seen = true;
        rec.f = f;
        rec.attach = { inline: f.style.opacity, computed: getComputedStyle(f).opacity };
        const iv = setInterval(() => rec.polls.push(getComputedStyle(f).opacity), 16);
        f.addEventListener('load', () => { clearInterval(iv); rec.load = { inline: f.style.opacity, anims: info(f) }; }, { once: true });
      });
      mo.observe(v, { childList: true });
      document.querySelector('#plg-list .plg-row[data-id="mpa"] [data-act="pick"]').click();
      for (let i = 0; i < 100 && !rec.load; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 600));
      mo.disconnect();
      rec.end = rec.f ? { inline: rec.f.style.opacity, computed: getComputedStyle(rec.f).opacity, anims: rec.f.getAnimations().length } : null;
      delete rec.f;
      return rec;`);
    const l = r.load && r.load.anims && r.load.anims[0];
    const ok = !!r.attach && r.attach.inline === '0' && r.attach.computed === '0' && r.polls.length >= 5 && r.polls.every((o) => o === '0')
      && !!r.load && r.load.inline === '' && r.load.anims.length === 1 && l.iter === '1' && l.firstOpacity === 0 && l.keys.every((k) => ['opacity', 'offset', 'easing', 'composite', 'computedOffset'].includes(k))
      && !!r.end && r.end.inline === '' && r.end.computed === '1' && r.end.anims === 0;
    return { ok, ...r };
  });

  // ---- v8 ------------------------------------------------------------------------------------------------------
  await gate('v8_no_white_frame_in_dark', async () => {
    await prepPanel();
    await openReport();
    const rect = await rend(`const b = document.getElementById('plg-view').getBoundingClientRect(); const bg = getComputedStyle(document.getElementById('plg-view')).backgroundColor;
      return { x: Math.round(b.left) + 2, y: Math.round(b.top) + 2, width: Math.round(b.width) - 4, height: Math.round(b.height) - 4, bg };`);
    const white = (img) => { // share of near-white pixels
      const { width, height } = img.getSize();
      const px = img.toBitmap();
      let n = 0;
      let nz = 0;
      for (let i = 0; i + 3 < px.length; i += 4) {
        if (px[i] >= 0xf0 && px[i + 1] >= 0xf0 && px[i + 2] >= 0xf0) n++;
        if (px[i] || px[i + 1] || px[i + 2]) nz++;
      }
      const size = width * height;
      return { size, share: size ? n / size : 1, nz: size ? nz / size : 0 }; // nz: an all-zero bitmap is a capture that saw nothing, never a pass
    };
    let stop = false;
    const shots = [];
    const loop = (async () => { while (!stop) { const img = await wc.capturePage({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); shots.push(white(img)); } })();
    await sleep(500); // the dark baseline: the settled report
    const nBase = shots.length;
    await rend(P.tab('journal'));
    await sleep(900);
    await rend(P.tab('report'));
    await sleep(1800);
    stop = true;
    await loop;
    const base = Math.max(...shots.slice(0, nBase).map((s) => s.share));
    const worst = Math.max(...shots.map((s) => s.share));
    const ok = nBase >= 3 && shots.length >= 12 && shots.every((s) => s.size > 0 && s.nz > 0.5) && worst <= base + 0.15;
    return { ok, rect, shots: shots.length, nBase, base, worst, nz: shots.map((s) => Math.round(s.nz * 100)), series: shots.map((s) => Math.round(s.share * 100)) };
  });

  // ---- v9 ------------------------------------------------------------------------------------------------------
  await gate('v9_reduced_motion_panel_swaps', async () => {
    await reduced('reduce');
    try {
      await prepPanel();
      const matches = await rend(`return matchMedia('(prefers-reduced-motion: reduce)').matches;`);
      const sync = await rend(`
        const out = {};
        document.querySelector('#plg-list .plg-row[data-id="mpa"] [data-act="pick"]').click();
        out.pick = { anims: snap().filter((a) => !a.css).length, page: panel.dataset.page };
        return out;`);
      await until(`(() => { const f = document.querySelector('#plg-view > iframe'); return !!f; })()`, 8000);
      const held = await rend(`const f = document.querySelector('#plg-view > iframe'); return { inline: f.style.opacity, anims: snap().filter((a) => !a.css).length };`);
      const framed = await until(FRAME_SETTLED, 8000);
      const tabs = await rend(`
        const out = [];
        for (const t of ['journal', 'history', 'settings', 'report']) {
          document.querySelector('#plg-detail [data-tab="' + t + '"]').click();
          await Promise.resolve();
          out.push({ t, anims: snap().filter((a) => !a.css).length });
        }
        return out;`);
      const framed2 = await until(FRAME_SETTLED, 8000);
      const back = await rend(`document.getElementById('plg-back').click(); return { anims: snap().filter((a) => !a.css).length, page: panel.dataset.page, rest: rest() };`);
      const rows = await rend(`return (window.__mp ? window.__mp.seen.filter((a) => !a.css).length : 0);`);
      const ok = matches === true && sync.pick.anims === 0 && sync.pick.page === 'detail' && held.inline === '0' && held.anims === 0 && framed && tabs.every((x) => x.anims === 0) && framed2
        && back.anims === 0 && back.page === 'list' && back.rest.inline.length === 0;
      return { ok, matches, sync, held, framed, tabs, framed2, back, rows };
    } finally { await reduced('no-preference'); }
  });

  // ---- v10 -----------------------------------------------------------------------------------------------------
  await gate('v10_full_screen_during_page_swap', async () => {
    await prepPanel();
    const r = await rend(`
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector('#plg-list .plg-row[data-id="mpa"] [data-act="pick"]').click();
      for (let i = 0; i < 160 && !document.querySelector('#plg-view > iframe'); i++) await new Promise((r) => setTimeout(r, 25));
      const swapping = snap().length;
      const full = document.getElementById('plg-full');
      full.click();
      await new Promise((r) => setTimeout(r, 1000));
      const v = document.getElementById('plg-view');
      const b = v.getBoundingClientRect();
      const chain = [];
      for (let n = v.parentElement; n; n = n.parentElement) {
        chain.push({ at: tag(n), tr: getComputedStyle(n).transform, inline: n.style.transform, anims: n.getAnimations().length });
      }
      const entered = { full: panel.classList.contains('plg-fullscreen'), pos: getComputedStyle(v).position, rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], win: [innerWidth, innerHeight],
        view: { tr: v.style.transform, op: v.style.opacity, anims: v.getAnimations().length }, chain };
      full.click();
      await new Promise((r) => setTimeout(r, 700));
      const left = { full: panel.classList.contains('plg-fullscreen'), view: { tr: v.style.transform, op: v.style.opacity, anims: v.getAnimations().length }, rest: rest() };
      return { swapping, entered, left };`);
    const e = r.entered;
    const ok = r.swapping > 0 && e.full && e.pos === 'fixed' && e.rect[0] === 0 && e.rect[1] === 0 && Math.abs(e.rect[2] - e.win[0]) <= 1 && Math.abs(e.rect[3] - e.win[1]) <= 1
      && e.view.tr === '' && e.view.anims === 0 && e.chain.every((c) => (c.tr === 'none' || c.tr === '') && c.inline === '' && c.anims === 0)
      && !r.left.full && r.left.view.tr === '' && r.left.view.op === '' && r.left.view.anims === 0 && r.left.rest.anims === 0;
    return { ok, ...r };
  });

  // ---- v11 -----------------------------------------------------------------------------------------------------
  await gate('v11_no_infinite_animation', async () => {
    const r = await rend(`
      const seen = (window.__mp && window.__mp.seen) || [];
      const rest1 = snap();
      return { seen: seen.length, infinite: seen.filter((a) => a.iter !== '1').map((a) => a.at + ':' + a.iter), restInfinite: rest1.filter((a) => a.iter !== '1').map((a) => a.at + ':' + a.iter), rest: rest1.length };`);
    return { ok: r.seen > 0 && r.infinite.length === 0 && r.restInfinite.length === 0, ...r };
  });

  // ---- v12 -----------------------------------------------------------------------------------------------------
  await gate('v12_exit_dur_token', async () => {
    const r = await rend(`
      if (typeof m.exitThen !== 'function') return { missing: true };
      root.style.setProperty('--dur-drawer', '444ms');
      root.style.setProperty('--dur-probe', '777ms');
      const kf = [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(8px)' }];
      const one = async (opts) => {
        const el = mk();
        const p = m.exitThen(el, kf, opts);
        const a = info(el);
        await p;
        const end = clean(el);
        el.remove();
        return { a, end };
      };
      try {
        return { named: await one({ dur: '--dur-probe' }), dflt: await one(undefined), numeric: await one({ duration: 123 }), unknown: await one({ dur: '--dur-nope' }) };
      } finally { root.style.removeProperty('--dur-drawer'); root.style.removeProperty('--dur-probe'); }
    `);
    const run = (x, dur) => x.a.length === 1 && x.a[0].dur === dur && x.a[0].iter === '1' && x.a[0].fill === 'forwards' && onlyCompositor(x.a[0].keys)
      && x.end.display === 'none' && x.end.anims === 0 && x.end.tr === '' && x.end.op === '';
    const ok = !r.missing && run(r.named, 777) && run(r.dflt, 444) && run(r.numeric, 123) && run(r.unknown, 280);
    return { ok, ...r };
  });

  // ---- v13 -----------------------------------------------------------------------------------------------------
  await gate('v13_swap_dur_token', async () => {
    const r = await rend(`
      if (typeof m.swapIn !== 'function') return { missing: true };
      root.style.setProperty('--dur-drawer', '444ms');
      root.style.setProperty('--dur-probe', '777ms');
      const one = async (opts) => {
        const el = mk();
        el.style.display = 'none';
        const p = m.swapIn(el, opts);
        const a = info(el);
        await p;
        const end = clean(el);
        el.remove();
        return { a, end, x: slide(a[0] && a[0].first) };
      };
      try {
        return { named: await one({ dir: 'forward', dur: '--dur-probe' }), back: await one({ dir: 'back', dur: '--dur-probe' }), dflt: await one({ dir: 'forward' }),
          bare: await one(undefined), unknown: await one({ dur: '--dur-nope' }) };
      } finally { root.style.removeProperty('--dur-drawer'); root.style.removeProperty('--dur-probe'); }
    `);
    const run = (x, dur) => x.a.length === 1 && x.a[0].dur === dur && x.a[0].iter === '1' && x.a[0].fill === 'none' && onlyCompositor(x.a[0].keys)
      && x.a[0].keys.includes('opacity') && x.a[0].keys.includes('transform') && Math.abs(x.x) >= 8 && Math.abs(x.x) <= 12
      && x.end.display === '' && x.end.anims === 0 && x.end.tr === '' && x.end.op === '';
    const ok = !r.missing && run(r.named, 777) && run(r.back, 777) && Math.sign(r.named.x) === -Math.sign(r.back.x) && run(r.dflt, 444) && run(r.bare, 444) && run(r.unknown, 280);
    return { ok, ...r };
  });

  // ---- v14 -----------------------------------------------------------------------------------------------------
  await gate('v14_collapse_scope', async () => {
    const r = await rend(`
      if (['collapse', 'expand'].some((k) => typeof m[k] !== 'function')) return { missing: true };
      const H = 60;
      const ty = (s) => { const x = /translateY\\((-?[0-9.]+)px\\)/.exec(s || ''); return x ? Number(x[1]) : null; };
      const box = (id, h, css) => { const d = document.createElement('div'); d.id = id; d.style.cssText = 'height:' + h + 'px;background:#888;' + (css || ''); return d; };
      const build = (hidden) => { // wrap > scope > section > card > [head, body, inCard]; later siblings at every level, plus one out of flow and one outside the scope
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;left:40px;top:40px;width:300px;background:#444';
        const scope = document.createElement('div');
        const section = document.createElement('section');
        const card = document.createElement('article');
        const body = box('bd', H, hidden ? 'display:none' : '');
        card.append(box('head', 24), body, box('inCard', 20));
        section.append(box('beforeCard', 20), card, box('afterCard', 20), box('absCard', 20, 'position:absolute;left:0;top:0;width:10px'));
        scope.append(section, box('afterSection', 20));
        wrap.append(scope, box('outside', 20));
        document.body.append(wrap);
        const ids = ['head', 'beforeCard', 'inCard', 'afterCard', 'absCard', 'afterSection', 'outside'];
        return { wrap, scope, body, nodes: Object.fromEntries(ids.map((id) => [id, wrap.querySelector('#' + id)])) };
      };
      const run = async (op, scoped) => {
        const b = build(op === 'expand');
        const log = [];
        const watched = new Map(Object.entries(b.nodes).map(([id, n]) => [n, id]));
        const origRect = Element.prototype.getBoundingClientRect;
        // each rect read is logged with the inline display of the folded body at that moment: the display write is then seen between two groups of reads
        Element.prototype.getBoundingClientRect = function () { if (watched.has(this)) log.push('r:' + watched.get(this) + '@' + b.body.style.display); return origRect.call(this); };
        let p;
        try { p = m[op](b.body, scoped ? { scope: b.scope } : undefined); } finally { Element.prototype.getBoundingClientRect = origRect; }
        const moved = {};
        for (const [id, n] of Object.entries(b.nodes)) {
          moved[id] = n.getAnimations().filter((a) => a.effect.getKeyframes().some((k) => k.transform)).map((a) => {
            const kf = a.effect.getKeyframes();
            return { from: ty(kf[0].transform), to: ty(kf[kf.length - 1].transform), comp: a.effect.composite, dur: a.effect.getTiming().duration };
          });
        }
        const bodyAnims = b.body.getAnimations().length;
        await p;
        const left = { anims: document.getAnimations().filter((a) => a.effect && b.wrap.contains(a.effect.target)).length, bodyDisplay: b.body.style.display,
          inline: [...b.wrap.querySelectorAll('[style]')].filter((n) => /transform/.test(n.getAttribute('style'))).length };
        b.wrap.remove();
        return { moved, log, bodyAnims, left };
      };
      return { H, colS: await run('collapse', true), colN: await run('collapse', false), expS: await run('expand', true), expN: await run('expand', false) };
    `);
    const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.5;
    const glides = (xs, from, to) => xs.length === 1 && xs[0].comp === 'add' && near(xs[0].from, from) && near(xs[0].to, to) && xs[0].dur > 0;
    const quiet = (x, ids) => ids.every((id) => x.moved[id].length === 0);
    const shape = (log, ids) => { // one read of every follower, all before the display write; then one read of each, all after it; nothing else
      const n = ids.length;
      const want = ids.map((i) => `r:${i}`).sort().join();
      const names = (xs) => xs.map((e) => e.split('@')[0]).sort().join();
      const states = (xs) => [...new Set(xs.map((e) => e.split('@')[1]))];
      const a = log.slice(0, n);
      const z = log.slice(n);
      return log.length === 2 * n && names(a) === want && names(z) === want && states(a).length === 1 && states(z).length === 1 && states(a)[0] !== states(z)[0];
    };
    const LEVELS = ['inCard', 'afterCard', 'afterSection'];
    const case1 = (x, from, to, scoped, display) => {
      const glide = scoped ? LEVELS : ['inCard'];
      const still = ['head', 'beforeCard', 'absCard', 'outside'].concat(scoped ? [] : ['afterCard', 'afterSection']);
      return glide.every((id) => glides(x.moved[id], from, to)) && quiet(x, still) && shape(x.log, glide) && x.bodyAnims >= 1
        && x.left.anims === 0 && x.left.inline === 0 && x.left.bodyDisplay === display;
    };
    const ok = !r.missing && case1(r.colS, 0, -r.H, true, 'none') && case1(r.colN, 0, -r.H, false, 'none')
      && case1(r.expS, -r.H, 0, true, '') && case1(r.expN, -r.H, 0, false, '');
    return { ok, ...r };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
