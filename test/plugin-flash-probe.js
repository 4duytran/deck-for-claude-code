'use strict';
// plugin-flash-probe — plugins-v4-fixes T3 gate: no light area flashes while the plugin report grows to « Plein écran » or shrinks back.
// The REAL app boots over throwaway fixtures; the report is the REAL daily-brief report (deck-plugins test fixture through python3 when the sibling
// repo is there, else a synthetic dark page). Every click is a trusted mouse event. A tight capturePage() loop records the window
// during each transition; per frame, the share of LIGHT pixels (mean of r, g, b >= 128: it also sees a white area behind a half-transparent layer, which a
// near-white >= 235 test misses) is taken in three regions: the report area A (the default #plg-view rect), the whole window, and the ring (window minus A).
// A frame's badness = its light share minus max(start, end) of the SETTLED captures of the same transition; a transition's badness = its worst frame over
// the three regions. Root cause (P1, xvfb): the out-of-process report frame lays out late, so the exposed area shows the iframe element's own background.
// Dark-only (plugins-v4 T9): main serves every plugin report with data-deck-theme="dark" as a constant, so a report stored before the dark-only report
// goes dark too. fl2 and fl4 (light grow / shrink) are RETIRED: the light path no longer exists, nothing is left to measure.
// Gates:
//   fl1  dark report grow, 3 runs: badness <= 2 pts each (RED on the base: about +45 pts in the first frames)
//   fl3  dark report shrink, 2 runs: badness <= 2 pts
//   fl5  the Files and Plans `.fp-frame` background stays rgb(255, 255, 255) / color-scheme light
//   fl6  the served report carries data-deck-theme="dark", `#plg-view` has no data-report-theme, the report frame background is transparent
//   fl7  control: the old white frame background put back at runtime makes the dark grow flash again (>= 10 pts), so a GREEN fl1 is not blind
// Every transition also needs >= 8 captured frames inside its animation, else its gate fails (the instrument saw nothing).
// Run (from the repo root): env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//   xvfb-run -a node_modules/.bin/electron test/plugin-flash-probe.js
// Limit: xvfb software GL is not the user's GPU; the gate proves the exposed area is not light on this compositor, not that no GPU path can lag.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { app, BrowserWindow, session } = require('electron');

const REPO = path.join(__dirname, '..');
const OUT = path.join(__dirname, '_runs', 'flash'); // gitignored: the frames of the worst transition
// optional daily-brief checkout (real report fixture), tried in order: the sibling of this checkout, then the same sibling four levels up (a nested worktree); none found -> a synthetic page
const DECK_PLUGINS_CANDIDATES = [
  { dir: path.join(REPO, '..', 'deck-plugins', 'daily-brief'), tag: 'sibling' },
  { dir: path.join(REPO, '..', '..', '..', '..', 'deck-plugins', 'daily-brief'), tag: 'worktree' },
];
const PLUGIN_ID = 'flash-fixture';
const LIGHT_MEAN = 128; // a pixel is light when the mean of r, g, b is >= this
const MAX_OVER = 0.02; // gate: a frame may exceed max(start, end) by this share at most
const MIN_FRAMES = 8; // captured frames needed inside one animation for its verdict to mean anything
const CONTROL_MIN = 0.1; // fl7: the control must flash at least this much
const REGIONS = ['A', 'win', 'ring'];
const FONTS_URLS = ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'];
const WHITE = 'rgb(255, 255, 255)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const T0 = Date.now();
let finished = false;
let worst = null; // { bad, name, frames: [{rel, img}], start, end }

const PY = 'import sys\nfrom tests.test_report import make_report\nfrom daily_brief import report\nsys.stdout.write(report.render(make_report()))\n';

function syntheticReport() {
  const dark = '--bg:#0B0E13;--surface:#0E1218;--ink:#E6E9EE;--line:rgba(232,236,242,.11);--accent:#9B9BFF';
  let cards = '';
  for (let i = 0; i < 60; i++) cards += `<section class="c"><h3>Carte ${i}</h3><p>Texte de la carte ${i}, assez long pour remplir une ligne ou deux du rapport.</p></section>`;
  return '<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><title>Rapport de la sonde</title><style>'
    + `:root{color-scheme:dark;${dark}}`
    + 'body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 sans-serif}main{max-width:1120px;margin:0 auto;padding:40px 24px;display:flex;flex-direction:column;gap:20px}'
    + '.c{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 20px}h3{margin:0;color:var(--accent)}</style></head>'
    + `<body><main>${cards}</main></body></html>\n`;
}

function reportHtml() {
  for (const { dir, tag } of DECK_PLUGINS_CANDIDATES) {
    try {
      if (!fs.existsSync(path.join(dir, 'daily_brief', 'report.py'))) continue;
      const r = cp.spawnSync('python3', ['-B', '-c', PY], { cwd: dir, encoding: 'utf8', maxBuffer: 8 << 20,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
      if (r.status === 0 && r.stdout.startsWith('<!doctype html>')) return { html: r.stdout, src: `daily-brief report.py (test fixture) (${tag})` };
    } catch (_) { /* the next candidate, then the synthetic page */ }
  }
  return { html: syntheticReport(), src: 'synthetic page, daily-brief fixture unavailable (synthetic)' };
}

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-flash-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), plugins: path.join(root, 'plugins'), home: path.join(root, 'home'), projects: path.join(root, 'projects'),
    ask: path.join(root, 'ask'), status: path.join(root, 'status'), sh: path.join(root, 'sh') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const dir = path.join(dirs.plugins, PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id: PLUGIN_ID, label: 'Brief de la sonde', description: 'Fixture de la sonde flash.',
    argv: ['run.sh'], trigger: 'manual', env: [] }));
  fs.writeFileSync(path.join(dirs.sh, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // the plugin stays disabled: the host never runs it
  const reports = require(path.join(REPO, 'src', 'main', 'plugin-reports.js')).create(path.join(dirs.ud, 'plugin-data'), () => Date.parse('2026-11-02T09:00:00'));
  const entry = reports.newEntry(PLUGIN_ID, 'manual');
  const rep = reportHtml();
  fs.writeFileSync(entry.reportPath, rep.html);
  fs.writeFileSync(entry.logPath, '::deck-step:: jira done 1793610000000 39 tickets\nligne de journal simple\n');
  reports.finishEntry(PLUGIN_ID, entry.stem, { exit: 0 });
  dirs.reportSrc = rep.src;
  dirs.reportBytes = Buffer.byteLength(rep.html);
  return dirs;
}

// ---- pixels ---------------------------------------------------------------------------------------------------------------------
// Light share of the report area A, the whole window and the ring (window minus A) of one capture. Rects are CSS px; the bitmap is BGRA and the
// test (a sum of the three channels) is symmetric in r and b.
function lightShares(img, A, win) {
  const { width: w, height: h } = img.getSize();
  const bm = img.toBitmap();
  const s = w / win.w;
  const x0 = Math.round(A.l * s), x1 = Math.round((A.l + A.w) * s), y0 = Math.round(A.top * s), y1 = Math.round((A.top + A.h) * s);
  const LSUM = LIGHT_MEAN * 3;
  let tot = 0, inA = 0, sumTot = 0, sumA = 0; // sum*: the channel sums, for the mean tone (informational: a dark band a shade off is no flash)
  for (let y = 0; y < h; y++) {
    const rowIn = y >= y0 && y < y1;
    let off = y * w * 4;
    for (let x = 0; x < w; x++, off += 4) {
      const sum = bm[off] + bm[off + 1] + bm[off + 2];
      const a = rowIn && x >= x0 && x < x1;
      sumTot += sum;
      if (a) sumA += sum;
      if (sum < LSUM) continue;
      tot++;
      if (a) inA++;
    }
  }
  const areaA = Math.max(1, (x1 - x0) * (y1 - y0));
  const ringN = Math.max(1, w * h - areaA);
  return { A: inA / areaA, win: tot / (w * h), ring: (tot - inA) / ringN, tone: { A: sumA / areaA / 765, win: sumTot / (w * h) / 765, ring: (sumTot - sumA) / ringN / 765 } };
}

const BAND_POINTS = [[1150, 400], [600, 800]]; // CSS px
const rgbOf = (c) => `(${c.join(',')})`;
const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
function pixelAt(img, p, win) { // r, g, b of one CSS-px point of a capture (BGRA bitmap)
  const { width: w } = img.getSize();
  const s = w / win.w;
  const o = (Math.round(p[1] * s) * w + Math.round(p[0] * s)) * 4;
  const bm = img.toBitmap();
  return [bm[o + 2], bm[o + 1], bm[o]];
}

function analyse(name, ref, frames, clickTs, A, win) {
  const S = lightShares(ref.start, A, win);
  const E = lightShares(ref.end, A, win);
  const F = frames.map((f, i) => ({ i, rel: f.t - clickTs, m: lightShares(f.img, A, win) })).filter((f) => f.rel >= -20); // frames from the click on
  const row = { name, frames: F.length, inAnim: F.filter((f) => f.rel >= 0 && f.rel <= 600).length, over: {}, bad: 0, peakRel: NaN };
  for (const r of REGIONS) {
    let peak = null;
    for (const f of F) if (!peak || f.m[r] > peak.m[r]) peak = f;
    const over = peak ? peak.m[r] - Math.max(S[r], E[r]) : NaN;
    let tp = -1;
    for (const f of F) tp = Math.max(tp, f.m.tone[r]);
    row.over[r] = { start: S[r], end: E[r], max: peak ? peak.m[r] : NaN, over, rel: peak ? Math.round(peak.rel) : NaN, tone: tp - Math.max(S.tone[r], E.tone[r]) };
    if (over > row.bad) { row.bad = over; row.peakRel = Math.round(peak.rel); }
  }
  // colour at two points of the report area (right and bottom strips, where the stale band of a grow shows), start / end / the sample 0..150 ms after the
  // click that differs most from both: informational, it tells a band of the right shade from a band a few levels off
  row.band = BAND_POINTS.map((p) => {
    const s0 = pixelAt(ref.start, p, win), s1 = pixelAt(ref.end, p, win);
    let best = null;
    for (const f of F) {
      if (f.rel < 0 || f.rel > 150) continue;
      const c = pixelAt(frames[f.i].img, p, win);
      const d = Math.min(dist(c, s0), dist(c, s1));
      if (!best || d > best.d) best = { c, d, rel: Math.round(f.rel) };
    }
    return `[${p.join(',')}] ${rgbOf(s0)} -> ${rgbOf(s1)}, worst ${best ? `${rgbOf(best.c)} at +${best.rel} ms` : '-'}`;
  });
  if (!worst || row.bad > worst.bad) worst ={ bad: row.bad, name, frames: frames.map((f, i) => ({ i, rel: f.t - clickTs, img: f.img })), start: ref.start, end: ref.end };
  return row;
}

const pts = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function save(file, img) {
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
}

function describe(row) {
  return `${/grow/.test(row.name) ? `band ${row.band.join(' | ')}\n    ` : ''}${row.name}: badness ${pts(row.bad)} pts at +${row.peakRel} ms (A ${pts(row.over.A.over)}, win ${pts(row.over.win.over)}, ring ${pts(row.over.ring.over)}; `
    + `light A ${pct(row.over.A.start)}->${pct(row.over.A.end)}; tone over A ${pts(row.over.A.tone)}, ring ${pts(row.over.ring.tone)}), ${row.inAnim} frames in the animation`;
}

function gate(id, ok, detail) {
  results[id] = !!ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

// A group of runs of one transition: every run needs its frames and a badness under the limit.
function gateRuns(id, label, rows) {
  for (const r of rows) console.log(`    ${describe(r)}`);
  const sparse = rows.filter((r) => r.inAnim < MIN_FRAMES);
  const bad = rows.filter((r) => !(r.bad <= MAX_OVER));
  gate(id, rows.length > 0 && !sparse.length && !bad.length,
    `${label} x${rows.length}: badness ${rows.map((r) => pts(r.bad)).join(' / ')} pts (limit +${(MAX_OVER * 100).toFixed(1)})${sparse.length ? `; ${sparse.length} run(s) under ${MIN_FRAMES} frames` : ''}`);
}

function verdict(code) {
  if (finished) return;
  finished = true;
  const ids = ['fl1', 'fl3', 'fl5', 'fl6', 'fl7'];
  const failed = ids.filter((id) => results[id] !== true);
  if (worst) {
    try {
      save('worst-0-start.png', worst.start);
      worst.frames.forEach((f) => save(`worst-frame-${String(f.i).padStart(2, '0')}-${Math.round(f.rel)}ms.png`, f.img));
      save('worst-9-end.png', worst.end);
      console.log(`worst transition: ${worst.name} (badness ${pts(worst.bad)} pts), frames saved under ${OUT}`);
    } catch (_) { /* the frames are a convenience */ }
  }
  console.log(`elapsed ${Math.round((Date.now() - T0) / 1000)} s`);
  console.log(failed.length === 0 && !code ? `VERDICT: ALL GREEN (${ids.length}/${ids.length})`
    : `VERDICT: FAIL ${failed.join(', ') || 'probe error'} (${ids.length - failed.length}/${ids.length} green)`);
  app.exit(failed.length === 0 && !code ? 0 : 1);
}

function boot() {
  fs.rmSync(OUT, { recursive: true, force: true }); // this probe's own output folder: every run starts clean
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
  // the report links Google Fonts: no network in a probe, the fallback font is used (registered before main.js's own ready handler)
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: FONTS_URLS }, (_d, cb) => cb({ cancel: true }));
  });
  require(path.join(REPO, 'main.js'));
  app.whenReady().then(() => run(dirs)).catch((err) => {
    console.log(`FAIL probe crashed: ${err && err.stack}`);
    verdict(2);
  });
}

async function run(dirs) {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 240 s'); verdict(2); }, 240000);
  watchdog.unref();
  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.plg)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  const rend = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f.url.startsWith('deckpage://'));
  const waitFor = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return true; await sleep(80); }
    return false;
  };
  const click = async (sel) => {
    const c = await rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect();`
      + ' return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width };');
    if (!c || !(c.w > 0)) throw new Error(`cannot click ${sel}`);
    wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  };
  const winSize = () => rend('return { w: innerWidth, h: innerHeight };');
  const settle = async () => {
    await waitFor(() => rend('return document.getAnimations().length === 0;'), 6000);
    await sleep(350);
  };
  const frameInfo = async () => {
    const f = frames()[0];
    if (!f) return {};
    try {
      const s = await f.executeJavaScript('document.readyState + "|" + (document.documentElement.getAttribute("data-deck-theme") || "")');
      const [rs, theme] = String(s).split('|');
      return { rs, theme };
    } catch (_) { return {}; }
  };

  console.log(`FIXTURE: report from ${dirs.reportSrc}, ${dirs.reportBytes} bytes; light = mean of r, g, b >= ${LIGHT_MEAN}; limit ${(MAX_OVER * 100).toFixed(1)} pts over max(start, end)`);
  await rend("window.__clicks = []; document.addEventListener('click', () => window.__clicks.push(Date.now()), true); return true;");

  const PICK = `#plg-list .plg-row[data-id="${PLUGIN_ID}"] [data-act="pick"]`;
  const isFull = () => rend("return document.getElementById('plugin-panel').classList.contains('plg-fullscreen');");
  const pageOf = () => rend("return document.getElementById('plugin-panel').dataset.page;");

  await click('#plugin-toggle');
  await sleep(1100);
  if (!(await waitFor(() => rend('return plg.open === true;')))) throw new Error('the Plugins panel did not open');
  await waitFor(() => rend(`const n = document.querySelector(${JSON.stringify(PICK)}); return !!n && n.getClientRects().length > 0;`));

  const ensureNotFull = async () => { if (await isFull()) { await click('#plg-full'); await settle(); } };
  const toReport = async () => {
    await ensureNotFull();
    if ((await pageOf()) !== 'detail') { await click(PICK); await waitFor(async () => (await pageOf()) === 'detail'); }
    if ((await rend('return plg.tab;')) !== 'report') await click('#plg-tab-report');
    const ok = await waitFor(async () => { const i = await frameInfo(); return i.rs === 'complete' && i.theme === 'dark'; }, 12000);
    if (!ok) throw new Error(`the dark report frame never loaded: ${JSON.stringify(await frameInfo())}`);
    await settle();
  };
  const toFull = async () => {
    await toReport();
    if (!(await isFull())) { await click('#plg-full'); await waitFor(() => isFull()); await settle(); }
  };

  await toReport();
  const A = await rend("const r = document.getElementById('plg-view').getBoundingClientRect(); return { l: r.left, top: r.top, w: r.width, h: r.height };");
  const win0 = await winSize();
  console.log(`GEOMETRY: window ${win0.w}x${win0.h}, report area (default #plg-view) x=${Math.round(A.l)} y=${Math.round(A.top)} w=${Math.round(A.w)} h=${Math.round(A.h)}`);

  // one transition: prep() brings the start state, trigger() fires it, the capture runs from 150 ms before the click to `ms` after it
  const measureOne = async (name, prep, trigger, ms) => {
    await prep();
    const start = await wc.capturePage();
    const got = [];
    let go = true;
    const loop = (async () => { while (go) { const img = await wc.capturePage(); got.push({ t: Date.now(), img }); } })();
    await sleep(150);
    await trigger();
    await sleep(ms);
    go = false;
    await loop;
    await settle();
    const end = await wc.capturePage();
    const clickTs = await rend('return window.__clicks[window.__clicks.length - 1] || 0;');
    return analyse(name, { start, end }, got, clickTs, A, await winSize());
  };
  const GROW_MS = 750;
  const grow = (n) => measureOne(`dark grow #${n}`, () => toReport(), () => click('#plg-full'), GROW_MS);
  const shrink = (n) => measureOne(`dark shrink #${n}`, () => toFull(), () => click('#plg-full'), GROW_MS);
  const repeat = async (fn, n) => { const rows = []; for (let i = 1; i <= n; i++) rows.push(await fn(i)); return rows; };

  // what #plg-view and its report frame say: the attribute that is gone, the frame's computed background and colour scheme
  const viewState = () => rend("const v = document.getElementById('plg-view'); const f = v.querySelector(':scope > iframe');"
    + ' return { attr: v.getAttribute(\'data-report-theme\'), bg: f ? getComputedStyle(f).backgroundColor : null, scheme: f ? getComputedStyle(f).colorScheme : null };');
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';

  const vs = await viewState();
  const served = await frameInfo();
  console.log(`VIEW: ${JSON.stringify(vs)}; served report: ${JSON.stringify(served)}`);

  // fl5: a Files and a Plans frame, built next to the live ones, keep the white / light look even while the report theme is dark
  const fp = await rend("const out = {}; for (const host of ['fp-vbody', 'pp-view']) { const f = document.createElement('iframe'); f.className = 'fp-frame'; document.getElementById(host).append(f);"
    + ' const s = getComputedStyle(f); out[host] = [s.backgroundColor, s.colorScheme]; f.remove(); } return out;');
  console.log(`FILES / PLANS frames (report theme dark): ${JSON.stringify(fp)}`);
  gate('fl5', Object.values(fp).length === 2 && Object.values(fp).every((v) => v[0] === WHITE && v[1] === 'light'),
    `Files and Plans .fp-frame background and color-scheme: ${JSON.stringify(fp)}`);

  gate('fl6', served.theme === 'dark' && vs.attr === null && vs.bg === TRANSPARENT,
    `served report data-deck-theme ${JSON.stringify(served.theme)}, #plg-view data-report-theme ${JSON.stringify(vs.attr)}, frame background ${vs.bg} (needs "dark", null, ${TRANSPARENT})`);

  gateRuns('fl1', 'dark grow', await repeat(grow, 3));
  gateRuns('fl3', 'dark shrink', await repeat(shrink, 2));

  // fl7: the control. The old frame look is forced back for one dark grow; it must flash, else the instrument is blind.
  const ctl = await wc.insertCSS(`#plg-view .fp-frame { background: ${WHITE} !important; color-scheme: light !important; }`);
  let control = null;
  try { control = await grow('control'); } finally { await wc.removeInsertedCSS(ctl); }
  console.log(`    ${describe(control)}`);
  gate('fl7', control.inAnim >= MIN_FRAMES && control.bad >= CONTROL_MIN, `control (white frame background forced): badness ${pts(control.bad)} pts (needs >= +${(CONTROL_MIN * 100).toFixed(0)})`);

  clearTimeout(watchdog);
  verdict(0);
}

boot();
