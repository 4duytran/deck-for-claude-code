// test/header-toolbar-probe.js — E2E probe: the priority+ header toolbar (#app-header), proven on the real app.
// Spec: docs/plans/deck-toolbar-fixes.spec.md § U-header. Reference: docs/plans/deck-header-toolbar-maquette.html.
//
// Gates:
//   h00 markup: #hdr-more (« ⋯ ») + #hdr-menu (role=menu), data-prio on the deck's tools and the session pill, lucide
//       icons (lc-messages-square / lc-plug / lc-ellipsis / lc-sparkles + lc-terminal) resolved in the sprite,
//       no emoji left in the labels, every legacy header id kept
//   h01 at 1600 / 1280 / 1024 / 820 / 600: every control is fully inside #app-header and clear of its neighbour, or is
//       an item of the « ⋯ » menu (never both, never lost); the step reached is printed
//   h02 at 1600: nothing in the menu, « ⋯ » absent; at 2000: step 1, the mode switch centred on the header
//   h03 at 600: both gauges visible inside the bar
//   h04 the step never decreases while the window narrows (1600 -> 600)
//   h05 sweep 1600 -> 400 by 20 px: no control is ever cut off, and the menu always holds a prefix of
//       Plugins, Room, Usage, session pill (the departure order of the spec; the assistant module's own button, data-prio 3,
//       joins it between Room and Usage only when the module is loaded, and its gates live in the module)
//   h06 short session pill « N · M » once the step asks for it, tooltips kept at the icon-only step
//   h07 the « ⋯ » menu: closed state, aria, open, focus on the first item, arrows (wrap), Escape (focus back on « ⋯ »),
//       outside click, the open menu stays inside the window and above the page
//   h08 a menu item proxies ONE click to the original button: Plugins panel opens, Room opens, usage page opens
//   h09 Room unread: the dot on « ⋯ » and the badge on the item while Room is in the menu, gone once Room opens
//   h10 the session pill text is mirrored as the info line of the menu and follows its changes
//   h11 AI mode: #ai-back stays inside the bar at 1600 and 600
//   h12 motion: the menu open / close and the label fold animate transform / opacity only, nothing under reduced motion
//   h13 no renderer error
//   h15 flat look (deck-restyle L11): tools without border or fill (--ink-2, --ink on hover) at 1600 / 1024 / 600, header without
//       glass, segmented mode switch (--lift / --lift-2), 2 x 56 px line gauges (--m-1 fill scaled to --p, --s-wait at data-level
//       alert, no ring), the session pill's .wait-t hook, the separators between the groups
// Run: cd <repo> && env CLAUDE_DECK_ZOOM=1.0 CLAUDE_DECK_ASK_DIR=$(mktemp -d) xvfb-run -a node_modules/.bin/electron test/header-toolbar-probe.js
// HEADER_SHOTS_DIR=<dir> also writes header screenshots (1600 / 1024 / 600, and 600 with the menu open).
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DECK = path.join(__dirname, '..');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'header-toolbar-probe-'));
process.env.HOME = BASE;
fs.mkdirSync(path.join(BASE, '.claude'), { recursive: true });
process.env.CLAUDE_DECK_ZOOM = '1.0';
process.env.CLAUDE_DECK_NO_SHELL_ENV = '1';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_ASK_DIR = process.env.CLAUDE_DECK_ASK_DIR || fs.mkdtempSync(path.join(BASE, 'ask-'));
process.env.CLAUDE_DECK_ROOMS_DIR = fs.mkdtempSync(path.join(BASE, 'rooms-'));
process.env.CLAUDE_DECK_STATUS_DIR = fs.mkdtempSync(path.join(BASE, 'status-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = fs.mkdtempSync(path.join(BASE, 'projects-'));
process.env.CLAUDE_DECK_PLUGINS_DIR = fs.mkdtempSync(path.join(BASE, 'plugins-'));
process.env.CLAUDE_DECK_PRICES_URL = 'http://127.0.0.1:1';
process.env.CLAUDE_DECK_COMMANDS_URL = 'http://127.0.0.1:1';
delete process.env.OPENAI_API_KEY;
delete process.env.SLACK_APP_TOKEN;
delete process.env.SLACK_USER_TOKEN;

// Fake `claude` (the CLAUDE_DECK_BIN seam) + fake claude.ai.
const FAKE = path.join(BASE, 'claude');
fs.writeFileSync(FAKE, '#!/bin/sh\nexec cat >/dev/null\n');
fs.chmodSync(FAKE, 0o755);
process.env.CLAUDE_DECK_BIN = FAKE;
const aiServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html data-mode="dark"><head><meta charset="utf-8"><title>fake</title></head><body>ok</body></html>');
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function gate(name, cond, diag) {
  if (cond) { pass += 1; process.stdout.write(`PASS  ${name}\n`); } else { fail += 1; process.stdout.write(`FAIL  ${name}\n`); }
  if (diag !== undefined) process.stdout.write(`      diag ${typeof diag === 'string' ? diag : JSON.stringify(diag)}\n`);
}

const LEGACY_IDS = ['app-header', 'header-left', 'header-right', 'sidebar-fold', 'brand', 'brand-mark', 'mode-switch', 'mode-code',
  'mode-ai', 'session-pill', 'room-toggle', 'room-badge', 'plugin-toggle', 'ai-back', 'usage', 'gauge-5h', 'gauge-7d',
  'usage-open'];
const ORDER = ['plugin-toggle', 'room-toggle', 'usage-open', 'session-pill']; // the deck's departure order
const MOTION_OK = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'offset', 'computedOffset', 'easing', 'composite']);

// Everything the page reports about the header at its current width.
const MEASURE = `(() => {
  const $ = (id) => document.getElementById(id);
  const hdr = $('app-header');
  const H = hdr.getBoundingClientRect();
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ids = ['sidebar-fold', 'mode-code', 'mode-ai', 'session-pill', 'room-toggle', 'plugin-toggle',
    'gauge-5h', 'gauge-7d', 'usage-open', 'hdr-more', 'ai-back'];
  const listed = new Set([...document.querySelectorAll('#hdr-menu [data-for]')].map((n) => n.dataset.for));
  const aiMode = document.body.dataset.mode === 'ai';
  const viol = [];
  const bar = [];
  for (const id of ids) {
    const el = $(id);
    if (!el) { if (id !== 'hdr-more') viol.push(id + ':missing'); continue; }
    const s = shown(el);
    const r = el.getBoundingClientRect();
    if (s) {
      bar.push({ id, l: r.left, r: r.right });
      if (r.left < H.left - 0.5 || r.right > H.right + 0.5 || r.top < H.top - 0.5 || r.bottom > H.bottom + 0.5) viol.push(id + ':outside');
      if (listed.has(id)) viol.push(id + ':both');
    } else {
      const quiet = (id === 'ai-back' && !aiMode) || (id === 'hdr-more' && listed.size === 0)
        || (id === 'session-pill' && (aiMode || !el.textContent.trim()));
      if (!quiet && !listed.has(id)) viol.push(id + ':lost');
    }
  }
  if ($('hdr-more') && listed.size > 0 && !shown($('hdr-more'))) viol.push('hdr-more:hidden-while-menu-has-items');
  bar.sort((a, b) => a.l - b.l);
  for (let i = 0; i + 1 < bar.length; i++) if (bar[i].r > bar[i + 1].l + 0.5) viol.push(bar[i].id + '/' + bar[i + 1].id + ':overlap');
  const sw = $('mode-switch').getBoundingClientRect();
  return {
    w: window.innerWidth, step: hdr.dataset.step || null, viol, listed: [...listed],
    moreShown: shown($('hdr-more')), modeDelta: (sw.left + sw.right) / 2 - (H.left + H.right) / 2,
    gaugesShown: shown($('gauge-5h')) && shown($('gauge-7d')),
  };
})()`;

async function main() {
  const aiPort = await listen(aiServer);
  process.env.CLAUDE_DECK_AI_URL = `http://127.0.0.1:${aiPort}/`;
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', fs.mkdtempSync(path.join(BASE, 'ud-')));
  require(path.join(DECK, 'main.js'));
  await app.whenReady();
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  // A page script that throws (an element the base lacks) answers { error }, so one missing piece reddens its gates only.
  const ej = (code) => wc.executeJavaScript(code, true).catch((e) => ({ error: String((e && e.message) || e).slice(0, 80) }));
  const errors = [];
  wc.on('console-message', (...args) => {
    const d = args[0];
    const level = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
    const message = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (level === 'error' || level === 3) errors.push(String(message).slice(0, 200));
  });

  const setWidth = async (w) => {
    win.setContentSize(w, 900);
    for (let i = 0; i < 40; i++) { if ((await ej('window.innerWidth')) === w) break; await sleep(25); }
    await sleep(110);
  };
  const measure = async (w) => { await setWidth(w); return ej(MEASURE); };

  // The session pill is filled by the sidebar from its rows (« 0 session · 0 attend » on the empty fixture): give it a known text.
  // The sidebar's own refresh may rewrite it later, so the gates that read it set it again first.
  const PILL = '7 sessions · 2 attend';
  const setPill = (t) => ej(`document.getElementById('session-pill').textContent = ${JSON.stringify(t)}; true`);
  await setPill(PILL);

  // ---- h00 markup ----------------------------------------------------------------------------
  const h00 = await ej(`(() => {
    const $ = (id) => document.getElementById(id);
    const prio = (id) => $(id) && Number($(id).dataset.prio) > 0;
    const use = (id) => [...($(id) ? $(id).querySelectorAll('use') : [])].map((u) => u.getAttribute('href'));
    const sprite = (n) => !!document.querySelector('#lc-sprite symbol#' + n);
    const emoji = /[\\u{1F3A4}\\u{1F4AC}\\u{1F50C}]/u.test($('app-header').textContent);
    return {
      more: !!$('hdr-more'), menu: $('hdr-menu') && $('hdr-menu').getAttribute('role'),
      prios: ['plugin-toggle', 'room-toggle', 'usage-open', 'session-pill'].map(prio),
      roomUse: use('room-toggle'), plugUse: use('plugin-toggle'), moreUse: use('hdr-more'),
      modeUse: [...use('mode-code'), ...use('mode-ai')],
      sprite: ['lc-messages-square', 'lc-plug', 'lc-ellipsis', 'lc-sparkles', 'lc-terminal'].map(sprite),
      emoji, ids: ${JSON.stringify(LEGACY_IDS)}.filter((id) => !$(id)),
    };
  })()`);
  gate('h00 #hdr-more + #hdr-menu[role=menu] exist', h00.more === true && h00.menu === 'menu', h00);
  gate('h00 data-prio on Plugins, Room, Usage and the session pill', h00.prios.length === 4 && h00.prios.every(Boolean));
  gate('h00 stroke icons from the lucide sprite (messages-square, plug, ellipsis, terminal + sparkles) all resolve',
    h00.roomUse.includes('#lc-messages-square') && h00.plugUse.includes('#lc-plug')
    && h00.moreUse.includes('#lc-ellipsis') && h00.modeUse.includes('#lc-terminal') && h00.modeUse.includes('#lc-sparkles')
    && h00.sprite.every(Boolean));
  gate('h00 no emoji left in the header labels', h00.emoji === false);
  gate('h00 every legacy header id is kept', h00.ids.length === 0, h00.ids);

  // ---- h01 / h02 / h03 / h04 the five widths -------------------------------------------------
  const at = {};
  for (const w of [1600, 1280, 1024, 820, 600]) {
    at[w] = await measure(w);
    gate(`h01 ${w}: every control inside the header or in the « ⋯ » menu (step ${at[w].step})`, at[w].w === w && at[w].viol.length === 0,
      { step: at[w].step, viol: at[w].viol, inMenu: at[w].listed });
  }
  gate('h02 1600: nothing in the menu, « ⋯ » absent', at[1600].listed.length === 0 && at[1600].moreShown === false);
  // Step 1 (everything visible, the mode switch centred) needs the right zone to fit in HALF the free width: at 1600 the
  // real content (240 px mode switch, 679 px of tools) first fits at step 2, so the centred step is read at 2000.
  const wide2000 = await measure(2000);
  gate('h02 2000: step 1, the mode switch centred on the header, nothing in the menu',
    wide2000.step === '1' && Math.abs(wide2000.modeDelta) <= 2 && wide2000.listed.length === 0, { step: wide2000.step, delta: wide2000.modeDelta });
  gate('h03 600: both gauges visible', at[600].gaugesShown === true && !at[600].viol.some((v) => v.startsWith('gauge')));
  const steps = [1600, 1280, 1024, 820, 600].map((w) => Number(at[w].step));
  gate('h04 the step never decreases while the window narrows', steps.every((s, i) => Number.isFinite(s) && (i === 0 || s >= steps[i - 1])),
    { steps: Object.fromEntries([1600, 1280, 1024, 820, 600].map((w) => [w, at[w].step])) });

  // ---- h15 flat look (deck-restyle L11): text + icon tools with no border and no fill, a segmented mode switch, 2 x 56 px line
  // gauges, a coloured « attend » hook, separators, no glass. Tokens are read as the colours they resolve to (tokens.css).
  const INK2 = 'rgb(167, 174, 185)'; // --ink-2
  const INK = 'rgb(230, 233, 238)'; // --ink
  const WAIT = 'rgb(210, 164, 98)'; // --s-wait
  const TEAL = 'rgb(94, 234, 212)'; // --m-1
  const FLAT = `(() => {
    const cs = (el, p) => getComputedStyle(el, p || null);
    const tools = [...document.querySelectorAll('#app-header .hdr-tool')].filter((e) => e.getClientRects().length > 0);
    const hdr = document.getElementById('app-header');
    const pill = document.getElementById('session-pill');
    return {
      tools: tools.map((e) => { const c = cs(e); return { id: e.id, bw: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].join('/'), bg: c.backgroundColor, color: c.color }; }),
      hdr: { bf: cs(hdr).backdropFilter, bg: cs(hdr).backgroundColor, bb: cs(hdr).borderBottomWidth, gap: cs(document.getElementById('header-right')).columnGap },
      pill: pill.getClientRects().length > 0 ? { bw: cs(pill).borderTopWidth, bg: cs(pill).backgroundColor, color: cs(pill).color } : null,
    };
  })()`;
  const flatAt = {};
  for (const w of [1600, 1024, 600]) { await setWidth(w); flatAt[w] = await ej(FLAT); }
  const flatBad = [];
  for (const w of [1600, 1024, 600]) {
    const f = flatAt[w];
    if (!f || f.error || !f.tools.length) { flatBad.push(`${w}: ${JSON.stringify(f && f.error)} tools=${f && f.tools && f.tools.length}`); continue; }
    for (const t of f.tools) if (t.bw !== '0px/0px/0px/0px' || t.bg !== 'rgba(0, 0, 0, 0)' || t.color !== INK2) flatBad.push(`${w} ${t.id} ${t.bw} ${t.bg} ${t.color}`);
  }
  gate('h15 tools are flat at 1600 / 1024 / 600: border widths 0, transparent background, --ink-2', flatBad.length === 0, flatBad.slice(0, 5));
  await setWidth(1600);
  const hd = flatAt[1600] && flatAt[1600].hdr;
  gate('h15 header: no glass (backdrop-filter none), no fill, one 1 px hairline, tools 22 px apart',
    !!hd && hd.bf === 'none' && hd.bg === 'rgba(0, 0, 0, 0)' && hd.bb === '1px' && hd.gap === '22px', hd);
  const plug = await ej(`(() => { const r = document.getElementById('plugin-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: Math.round(plug.x), y: Math.round(plug.y) });
  await sleep(450);
  const hov = await ej(`getComputedStyle(document.getElementById('plugin-toggle')).color + '|' + getComputedStyle(document.getElementById('plugin-toggle')).backgroundColor`);
  wc.sendInputEvent({ type: 'mouseMove', x: 5, y: 600 });
  gate('h15 a hovered tool turns --ink and stays without a fill', hov === `${INK}|rgba(0, 0, 0, 0)`, hov);
  const seg = await ej(`(() => {
    const cs = (el) => getComputedStyle(el);
    const sw = document.getElementById('mode-switch'); const on = sw.querySelector('.mode-tab.active'); const off = sw.querySelector('.mode-tab:not(.active)');
    return { bw: cs(sw).borderTopWidth, bg: cs(sw).backgroundColor, radius: cs(sw).borderTopLeftRadius, onBg: cs(on).backgroundColor, onColor: cs(on).color, offBg: cs(off).backgroundColor, offColor: cs(off).color };
  })()`);
  gate('h15 mode switch is segmented on --lift (track), --lift-2 under the active tab, no border',
    seg.bw === '0px' && seg.bg === 'rgba(232, 236, 242, 0.035)' && seg.radius === '7px' && seg.onBg === 'rgba(232, 236, 242, 0.06)'
    && seg.onColor === INK && seg.offBg === 'rgba(0, 0, 0, 0)', seg);
  const gg = await ej(`(() => {
    const out = {};
    for (const id of ['gauge-5h', 'gauge-7d']) {
      const g = document.getElementById(id); const cs = (el, p) => getComputedStyle(el, p || null);
      const wrap = g.querySelector('.g-ring-wrap'); const r = wrap.getBoundingClientRect();
      const lbl = g.querySelector('.g-label').getBoundingClientRect(); const pct = g.querySelector('.g-pct').getBoundingClientRect();
      out[id] = { w: r.width, h: r.height, track: cs(wrap).backgroundColor, ring: cs(g.querySelector('.g-ring')).display,
        order: lbl.right <= r.left + 0.5 && r.right <= pct.left + 0.5, bw: cs(g).borderTopWidth, bg: cs(g).backgroundColor, pctColor: cs(g.querySelector('.g-pct')).color };
    }
    return out;
  })()`);
  gate('h15 gauges are 2 x 56 px lines on --rule-2, label then line then figure, no ring, no border or fill',
    ['gauge-5h', 'gauge-7d'].every((id) => gg[id] && gg[id].w === 56 && gg[id].h === 2 && gg[id].track === 'rgba(232, 236, 242, 0.11)' && gg[id].ring === 'none'
      && gg[id].order === true && gg[id].bw === '0px' && gg[id].bg === 'rgba(0, 0, 0, 0)'), gg);
  // The fill is --p (0..1) scaled from the left in --m-1, --s-wait once renderGauge flags data-level="alert"; the figure stays calm
  // although renderGauge tints it inline from its ramp at 80 % and up.
  await ej(`(() => { const g = document.getElementById('gauge-5h'); g.dataset.level = 'ok'; g.style.setProperty('--p', '0.42'); g.querySelector('.g-pct').style.color = 'rgb(220, 60, 50)'; return true; })()`);
  await sleep(450);
  const okFill = await ej(`(() => { const g = document.getElementById('gauge-5h'); const a = getComputedStyle(g.querySelector('.g-ring-wrap'), '::after'); return { bg: a.backgroundColor, t: a.transform, pct: getComputedStyle(g.querySelector('.g-pct')).color }; })()`);
  await ej(`document.getElementById('gauge-5h').dataset.level = 'alert'; true`);
  await sleep(450);
  const alertFill = await ej(`getComputedStyle(document.getElementById('gauge-5h').querySelector('.g-ring-wrap'), '::after').backgroundColor`);
  await ej(`(() => { const g = document.getElementById('gauge-5h'); g.removeAttribute('data-level'); g.dataset.level = 'none'; g.style.removeProperty('--p'); g.querySelector('.g-pct').style.color = ''; return true; })()`);
  gate('h15 gauge fill: --m-1 scaled to --p, --s-wait at data-level alert, figure kept --ink-3',
    okFill.bg === TEAL && okFill.t === 'matrix(0.42, 0, 0, 1, 0, 0)' && alertFill === WAIT && okFill.pct === 'rgb(110, 118, 130)', { okFill, alertFill });
  await setPill(PILL);
  const pl = await ej(`(() => {
    const p = document.getElementById('session-pill'); const cs = (el) => getComputedStyle(el);
    const base = { color: cs(p).color, bw: cs(p).borderTopWidth, bg: cs(p).backgroundColor };
    const w = document.createElement('span'); w.className = 'wait-t'; w.textContent = '2 attend';
    const b = document.createElement('b'); b.textContent = '7';
    p.replaceChildren(b, ' sessions, ', w);
    return { ...base, wait: cs(w).color, count: cs(b).color, countWeight: cs(b).fontWeight };
  })()`);
  await setPill(PILL);
  gate('h15 session pill: flat --ink-2 text, only the .wait-t part is --s-wait, the count in --ink',
    pl.color === INK2 && pl.bw === '0px' && pl.bg === 'rgba(0, 0, 0, 0)' && pl.wait === WAIT && pl.count === INK && pl.countWeight === '500', pl);
  const sep = await ej(`(() => {
    const cs = (el) => getComputedStyle(el, '::before'); const pill = document.getElementById('session-pill'); const room = document.getElementById('room-toggle');
    const a = cs(room); const u = cs(document.getElementById('usage'));
    const d = (c) => ({ w: c.width, h: c.height, bg: c.backgroundColor, pos: c.position, left: c.left, display: c.display });
    const gap = room.getBoundingClientRect().left - pill.getBoundingClientRect().right;
    const [da, du] = [d(a), d(u)]; // the declarations are live: read them before the count is emptied
    pill.textContent = ''; const emptied = cs(room).display;
    return { a: da, u: du, gap, emptied };
  })()`);
  await setPill(PILL);
  const sepOk = (s) => s.w === '1px' && s.h === '16px' && s.bg === 'rgba(232, 236, 242, 0.11)' && s.pos === 'absolute' && s.left === '-11px' && s.display !== 'none';
  gate('h15 separators: 1 x 16 px --rule-2 centred in the 22 px gap after the session count and before the gauges, gone with an empty count',
    sepOk(sep.a) && sepOk(sep.u) && Math.abs(sep.gap - 22) <= 1 && sep.emptied === 'none', sep);

  // ---- h16 the line gauges are driven by the real renderGauge (usage.js applyUsage, reached through the same module instance
  // boot.js loaded): the fill is --p scaled over the 56 px track, so its width is pct x 56; no data = no fill, --p removed.
  const fillOf = `(() => { const out = {}; for (const id of ['gauge-5h', 'gauge-7d']) { const g = document.getElementById(id);
    const a = getComputedStyle(g.querySelector('.g-ring-wrap'), '::after'); const m = /matrix\\(([-\\d.e]+)/.exec(a.transform);
    out[id] = { w: m ? Number(m[1]) * 56 : null, bg: a.backgroundColor, p: g.style.getPropertyValue('--p'), level: g.dataset.level, pct: g.querySelector('.g-pct').textContent }; }
    return out; })()`;
  await ej(`(async () => { const m = await import('./js/usage.js'); const now = Math.floor(Date.now() / 1000);
    m.applyUsage({ five_hour: { used_percentage: 42, resets_at: now + 7200, source: 'official' }, seven_day: { used_percentage: 85, resets_at: now + 3 * 86400, source: 'official' } }); return true; })()`);
  await sleep(500);
  const seeded = await ej(fillOf);
  await ej(`(async () => { const m = await import('./js/usage.js'); m.applyUsage(null); return true; })()`);
  await sleep(500);
  const empty = await ej(fillOf);
  gate('h16 gauge fill width = pct x 56 px (+-1) at a seeded 42 % / 85 %, teal then --s-wait above 80 %, none and --p removed without data',
    !!seeded['gauge-5h'] && Math.abs(seeded['gauge-5h'].w - 23.52) <= 1 && seeded['gauge-5h'].bg === TEAL
    && Math.abs(seeded['gauge-7d'].w - 47.6) <= 1 && seeded['gauge-7d'].bg === WAIT
    && empty['gauge-5h'].w === 0 && empty['gauge-7d'].w === 0 && empty['gauge-5h'].p === '' && empty['gauge-7d'].p === '', { seeded, empty });

  // ---- h17 the session pill is « N sessions, M attend » with only « M attend » in --s-wait (the span exists only while M > 0),
  // built by sidebar.js from the rendered rows; the short « N · M » fold keeps reading the text. Rows are fakes with the badge parts
  // setBadge needs; notifySessionStatus re-statuses them and calls the pill update (its debounced re-scan runs after the reads).
  await ej(`(async () => { const list = document.getElementById('session-list'); for (const id of ['fk1', 'fk2', 'fk3']) { const r = document.createElement('div');
    r.className = 'session-row'; r.dataset.sessionId = id; r.dataset.status = 'idle'; r.innerHTML = '<span class="status-badge"><span class="status-emoji"></span></span>'; list.append(r); }
    const m = await import('./js/sidebar.js'); m.notifySessionStatus('fk1', 'waiting'); m.notifySessionStatus('fk2', 'waiting'); return true; })()`);
  const pw = await ej(`(() => { const p = document.getElementById('session-pill'); const cs = (e) => getComputedStyle(e); const w = p.querySelector('.wait-t'); const b = p.querySelector('b');
    return { text: p.textContent, wait: w && w.textContent, waitColor: w && cs(w).color, n: b && b.textContent, nColor: b && cs(b).color, pillColor: cs(p).color }; })()`);
  await sleep(150);
  const pm = await ej(`(async () => { const p = document.getElementById('session-pill'); const short = p.dataset.short; const m = await import('./js/sidebar.js');
    m.notifySessionStatus('fk1', 'idle'); m.notifySessionStatus('fk2', 'idle');
    const none = { text: p.textContent, hasWait: !!p.querySelector('.wait-t') };
    document.querySelectorAll('.session-row[data-session-id^="fk"]').forEach((r) => r.remove()); return { short, none }; })()`);
  await setPill(PILL);
  gate('h17 session pill « 3 sessions, 2 attend »: only the « 2 attend » span is --s-wait, the count --ink, the rest --ink-2; no span at 0 waiting; data-short « 3 · 2 »',
    pw.text === '3 sessions, 2 attend' && pw.wait === '2 attend' && pw.waitColor === WAIT && pw.n === '3' && pw.nColor === INK && pw.pillColor === INK2
    && pm.short === '3 · 2' && pm.none.text === '3 sessions, 0 attend' && pm.none.hasWait === false, { pw, pm });

  // ---- h05 sweep -----------------------------------------------------------------------------
  const bad = [];
  const orderBad = [];
  const seenStep = new Set();
  const firstOut = {};
  for (let w = 1600; w >= 400; w -= 20) {
    const m = await measure(w);
    seenStep.add(m.step);
    for (const id of m.listed) if (!(id in firstOut)) firstOut[id] = w;
    if (m.viol.length) bad.push({ w, step: m.step, viol: m.viol });
    const inMenu = ORDER.filter((id) => m.listed.includes(id));
    const prefix = ORDER.slice(0, inMenu.length);
    if (m.listed.some((id) => !ORDER.includes(id)) || inMenu.some((id, i) => id !== prefix[i])) orderBad.push({ w, listed: m.listed });
  }
  gate('h05 1600 -> 400 (every 20 px): no control is ever cut off', bad.length === 0, bad.slice(0, 4));
  gate('h05 the menu always holds a prefix of Plugins, Room, Usage, session pill', orderBad.length === 0, orderBad.slice(0, 3));
  process.stdout.write(`      diag steps seen ${JSON.stringify([...seenStep])} first width out ${JSON.stringify(firstOut)}\n`);

  // ---- h06 short pill, tooltips ----------------------------------------------------------------
  let shortSeen = null;
  await setPill(PILL);
  for (let w = 1400; w >= 600 && !shortSeen; w -= 20) {
    await setWidth(w);
    const r = await ej(`(() => {
      const p = document.getElementById('session-pill');
      if (!p.getClientRects().length) return null;
      return { after: getComputedStyle(p, '::after').content, width: p.getBoundingClientRect().width, w: window.innerWidth };
    })()`);
    if (r && /^"7 · 2"$/.test(r.after)) shortSeen = r;
  }
  await setWidth(1600);
  const wide = await ej(`document.getElementById('session-pill').getBoundingClientRect().width`);
  gate('h06 the session pill folds to « N · M » (narrower than the long form) while it stays in the bar',
    !!shortSeen && shortSeen.width < wide, { shortSeen, wide, PILL });
  const tips = await ej(`['room-toggle', 'plugin-toggle', 'usage-open'].map((id) => document.getElementById(id).title)`);
  gate('h06 tooltips keep the old labels', tips.every((t) => t.length > 0) && tips[1] === 'Plugins', tips);

  // ---- find a width where the four tools and the pill are all in the menu ------------------------
  let narrow = null;
  for (let w = 600; w >= 360; w -= 10) {
    const m = await measure(w);
    if (ORDER.every((id) => m.listed.includes(id))) { narrow = m; break; }
  }
  gate('h07 a width exists where every tool and the session pill are all in the menu', !!narrow, narrow && { w: narrow.w, step: narrow.step });
  if (!narrow) await setWidth(420);

  // ---- h07 the menu ------------------------------------------------------------------------------
  const state = () => ej(`(() => {
    const m = document.getElementById('hdr-menu');
    const more = document.getElementById('hdr-more');
    const items = m ? [...m.querySelectorAll('[role="menuitem"]')] : [];
    const r = m && m.getClientRects().length ? m.getBoundingClientRect() : null;
    const top = r && document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return {
      open: !!r, expanded: more && more.getAttribute('aria-expanded'), popup: more && more.getAttribute('aria-haspopup'),
      items: items.length, role: m && m.getAttribute('role'), focusIdx: items.indexOf(document.activeElement),
      moreFocused: document.activeElement === more,
      inWindow: !!r && r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      aboveSelf: !!(top && m.contains(top)),
    };
  })()`);
  const press = (key) => ej(`(() => { const t = document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true; })()`);
  const clickMore = () => ej(`document.getElementById('hdr-more')?.click(); true`);

  const closed = await state();
  gate('h07 closed: aria-haspopup=menu, aria-expanded=false, menu not displayed, role=menu', closed.open === false
    && closed.expanded === 'false' && closed.popup === 'menu' && closed.role === 'menu' && closed.items >= ORDER.length - 1, closed); // one menuitem per tool; the session pill is an info line
  await clickMore();
  await sleep(120);
  const opened = await state();
  gate('h07 « ⋯ » opens the menu: aria-expanded=true, focus on the first item, inside the window and above the page',
    opened.open && opened.expanded === 'true' && opened.focusIdx === 0 && opened.inWindow && opened.aboveSelf, opened);
  await press('ArrowDown');
  const down = await state();
  await press('ArrowUp');
  await press('ArrowUp');
  const wrap = await state();
  gate('h07 ArrowDown moves to the next item, ArrowUp wraps to the last', down.focusIdx === 1 && wrap.focusIdx === wrap.items - 1, { down: down.focusIdx, wrap: wrap.focusIdx, items: wrap.items });
  await press('Escape');
  await sleep(300); // the exit glide (--dur-exit, 150 ms) must have ended
  const esc = await state();
  gate('h07 Escape closes the menu and puts the focus back on « ⋯ »', esc.open === false && esc.expanded === 'false' && esc.moreFocused, esc);
  await clickMore();
  await sleep(120);
  await ej(`document.getElementById('main-row').click(); true`);
  await sleep(300);
  const outside = await state();
  gate('h07 a click outside closes the menu', outside.open === false && outside.expanded === 'false', outside);

  // ---- h09 Room unread (Room is in the menu) -------------------------------------------------------
  const dot = () => ej(`(() => {
    const d = document.querySelector('#hdr-more .hdr-dot');
    const item = document.querySelector('#hdr-menu [data-for="room-toggle"]');
    const b = item && item.querySelector('.hdr-badge');
    return { dot: !!d && getComputedStyle(d).display !== 'none', badge: b ? b.textContent : null,
      src: document.getElementById('room-badge').hidden ? 'hidden' : document.getElementById('room-badge').textContent };
  })()`);
  const d0 = await dot();
  wc.send('room-append', { from: 'agent', to: 'user', text: 'probe', ts: Date.now() });
  await sleep(200);
  const d1 = await dot();
  gate('h09 no unread: no dot on « ⋯ »; one unread: the dot shows and the Room item carries the count',
    d0.dot === false && d1.dot === true && d1.badge === '1', { d0, d1 });

  // ---- h08 item click proxies exactly one click to the original button ------------------------------
  const tools = [
    ['room-toggle', `document.getElementById('room-panel').classList.contains('open')`, `window.overlayState.closeRoomPanel(); true`],
    ['plugin-toggle', `window.plg.open === true`, `window.overlayState.closePluginPanel(); true`],
    ['usage-open', `window.usageState.open === true`, `window.closeUsagePage(); true`],
  ];
  const clickItem = (id) => ej(`(() => {
    const btn = document.getElementById(${JSON.stringify(id)});
    window.__n = 0;
    btn.addEventListener('click', () => { window.__n += 1; }, { once: false });
    document.getElementById('hdr-more').click();
    return new Promise((res) => setTimeout(() => {
      const item = document.querySelector('#hdr-menu [data-for=' + JSON.stringify(${JSON.stringify(id)}) + ']');
      if (!item) { res({ found: false }); return; }
      item.click();
      res({ found: true, tag: item.tagName });
    }, 150));
  })()`);
  for (const [id, effect, cleanup] of tools) {
    const c = await clickItem(id);
    await sleep(250);
    const seen = await ej(`({ effect: (${effect}), n: window.__n })`);
    const after = await state();
    gate(`h08 « ${id} » item: one proxied click, same effect as the button, the menu closes`,
      c.found === true && seen.effect === true && seen.n === 1 && after.open === false, { c, seen, open: after.open });
    if (id === 'room-toggle') {
      const d2 = await dot();
      gate('h09 opening Room clears the unread: the dot that was showing is gone', d1.dot === true && d2.dot === false, d2);
    }
    await ej(cleanup);
    await sleep(350);
  }

  // ---- h10 the session pill is mirrored in the menu ---------------------------------------------------
  const info = () => ej(`(() => { const i = document.querySelector('#hdr-menu [data-for="session-pill"]'); return i ? i.textContent.trim() : null; })()`);
  await setPill(PILL);
  await sleep(120);
  const i0 = await info();
  await setPill('9 sessions · 4 attend');
  await sleep(120);
  const i1 = await info();
  gate('h10 the pill text is the menu info line, and follows a change', i0 === PILL && i1 === '9 sessions · 4 attend', { i0, i1 });

  // ---- h12 motion ------------------------------------------------------------------------------------------
  const probeMenu = (phase) => ej(`(() => {
    const m = document.getElementById('hdr-menu');
    const more = document.getElementById('hdr-more');
    const read = () => m.getAnimations().map((a) => Object.keys((a.effect.getKeyframes()[0]) || {}));
    if (${JSON.stringify(phase)} === 'open') more.click(); else document.getElementById('main-row').click();
    const props = read().flat();
    return { n: m.getAnimations().length, props: [...new Set(props)], shown: m.getClientRects().length > 0 };
  })()`);
  const o1 = await probeMenu('open');
  await sleep(450);
  const c1 = await probeMenu('close');
  await sleep(450);
  const c1end = await ej(`document.getElementById('hdr-menu').getClientRects().length > 0`);
  gate('h12 menu open and close animate (transform / opacity only) and end in the right state',
    o1.n > 0 && o1.props.every((p) => MOTION_OK.has(p)) && c1.n > 0 && c1.props.every((p) => MOTION_OK.has(p)) && o1.shown === true && c1end === false,
    { o1, c1, c1end });
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(250);
  const o2 = await probeMenu('open');
  const c2 = await probeMenu('close');
  gate('h12 reduced motion: the menu opens and closes at once, no animation', o2.n === 0 && o2.shown === true && c2.n === 0 && c2.shown === false, { o2, c2 });
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  wc.debugger.detach();
  await sleep(200);

  // the label fold: sample every animation under the header while the window narrows
  await setWidth(1600);
  await ej(`(() => {
    window.__fold = { props: new Set(), n: 0, stop: false };
    const tick = () => {
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target;
        if (!t || !document.getElementById('app-header').contains(t)) continue;
        window.__fold.n += 1;
        for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) window.__fold.props.add(p);
      }
      if (!window.__fold.stop) requestAnimationFrame(tick);
    };
    tick();
    return true;
  })()`);
  win.setContentSize(1000, 900);
  await sleep(500);
  win.setContentSize(700, 900);
  await sleep(500);
  const fold = await ej(`(() => { window.__fold.stop = true; return { n: window.__fold.n, props: [...window.__fold.props] }; })()`);
  gate('h12 the label fold animates transform / opacity only', fold.props.every((p) => MOTION_OK.has(p)), fold);

  // ---- h11 AI mode ------------------------------------------------------------------------------------------
  await ej(`document.body.dataset.mode = 'ai'; true`);
  const ai = {};
  for (const w of [1600, 600]) ai[w] = await measure(w);
  await ej(`delete document.body.dataset.mode; true`);
  gate('h11 AI mode: #ai-back and every other control stay inside the bar (1600 and 600)',
    ai[1600].viol.length === 0 && ai[600].viol.length === 0, { a1600: ai[1600].viol, a600: ai[600].viol });
  await setWidth(1280);

  // ---- h14 AI mode: the « ⋯ » menu is a DOM layer, the native claude.ai view always draws above the DOM, so while the
  // menu is open the view is hidden (the existing ai-hide) and shown again on close (ai-show), whatever closes the menu;
  // a switch back to Code closes it with NO ai-show (the view must stay hidden). ipcMain listeners count the real IPC.
  const { ipcMain } = require('electron');
  const ipc = { hide: 0, show: 0 };
  ipcMain.on('ai-hide', () => { ipc.hide += 1; });
  ipcMain.on('ai-show', () => { ipc.show += 1; });
  await setWidth(600);
  await ej(`window.setMode('ai'); true`);
  await sleep(1800);
  const aiView = win.contentView.children[0];
  const viewShown = () => !!aiView && aiView.getVisible();
  const aiMode = await ej(`document.body.dataset.mode`);
  const closeWays = [
    ['Escape', () => press('Escape')],
    ['outside click', () => ej(`document.getElementById('main-row').click(); true`)],
    ['item pick', () => ej(`document.querySelector('#hdr-menu [data-for="usage-open"]').click(); true`)],
  ];
  for (const [way, close] of closeWays) {
    const b = { ...ipc };
    await clickMore();
    await sleep(250);
    const o = { hide: ipc.hide - b.hide, shown: viewShown(), menu: await state() };
    await close();
    await sleep(350);
    const d = { show: ipc.show - b.show, shown: viewShown(), menu: await state() };
    gate(`h14 AI mode, 600, closed by ${way}: open = one ai-hide, view hidden, menu on top; close = one ai-show, view back`,
      aiMode === 'ai' && o.hide === 1 && o.shown === false && o.menu.open === true && o.menu.aboveSelf === true
      && d.show === 1 && d.shown === true && d.menu.open === false, { aiMode, o, d });
  }
  const bm = { ...ipc };
  await clickMore();
  await sleep(250);
  await ej(`document.getElementById('mode-code').click(); true`);
  await sleep(500);
  const dm = { show: ipc.show - bm.show, shown: viewShown(), menu: await state(), mode: await ej(`document.body.dataset.mode`) };
  gate('h14 AI mode, 600, a switch to Code with the menu open: it closes, no ai-show, the view stays hidden',
    dm.mode === 'code' && dm.menu.open === false && dm.show === 0 && dm.shown === false, dm);

  // ---- h14 AI mode, a pick that leaves AI mode (Plugins, Assistant): the item clicks the original FIRST and closes after, so the
  // close sees mode « code » and sends no ai-show (close-then-click used to send ai-show, then the button's setMode('code') ai-hide:
  // a claude.ai flash). Expected: 0 ai-show, the view hidden, the tool's own effect on screen.
  const pickInAi = async (id, effect, cleanup) => {
    await ej(`window.setMode('ai'); true`);
    await sleep(1800);
    const before = { ...ipc };
    const inAi = await ej(`document.body.dataset.mode`);
    await clickMore();
    await sleep(250);
    const found = await ej(`(() => { const i = document.querySelector('#hdr-menu [data-for="${id}"]'); if (!i) return false; i.click(); return true; })()`);
    await sleep(600);
    const r = {
      id, inAi, found, show: ipc.show - before.show, shown: viewShown(), mode: await ej(`document.body.dataset.mode`),
      effect: await ej(effect), menu: (await state()).open,
    };
    await ej(cleanup);
    await sleep(1800); // a cleanup may restore AI mode (fade + commit): wait it out, then back to Code
    await ej(`document.getElementById('mode-code').click(); true`);
    await sleep(500);
    return r;
  };
  for (const [id, effect, cleanup] of [
    ['plugin-toggle', `window.plg.open === true`, `window.overlayState.closePluginPanel(); true`],
  ]) {
    const r = await pickInAi(id, effect, cleanup);
    gate(`h14 AI mode, 600, « ${id} » picked from « ⋯ »: no ai-show, the view stays hidden, Code mode, the tool's effect, the menu closed`,
      r.inAi === 'ai' && r.found === true && r.show === 0 && r.shown === false && r.mode === 'code' && r.effect === true && r.menu === false, r);
  }
  await setWidth(1280);

  // ---- h18 deck-restyle L18e-b: the mockup row (.app grid-template: 40px 1fr) ------------------------------------------------
  // The native AI view is placed from #ai-frame's own rect (mode.js aiFrameRect), so the bar is free to be 40 px; its tools,
  // gauges and pill stay vertically centred and inside it at every width.
  for (const w of [1600, 1280, 1024, 820, 600]) {
    await setWidth(w);
    const m = await ej(`(() => {
      const H = document.getElementById('app-header').getBoundingClientRect();
      const mid = (H.top + H.bottom) / 2;
      const off = [];
      for (const id of ['sidebar-fold', 'brand', 'mode-switch', 'plugin-toggle', 'room-toggle', 'usage-open', 'hdr-more', 'session-pill', 'gauge-5h', 'gauge-7d']) {
        const el = document.getElementById(id);
        if (!el || el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        if (r.top < H.top - 0.5 || r.bottom > H.bottom + 0.5) off.push(id + ':clipped');
        else if (Math.abs((r.top + r.bottom) / 2 - mid) > 2) off.push(id + ':off-centre');
      }
      return { h: H.height, off };
    })()`);
    gate(`h18 ${w}: #app-header is 40 px tall, every visible control inside it and vertically centred`, m && m.h === 40 && Array.isArray(m.off) && m.off.length === 0, m);
  }
  await setWidth(1280);

  // ---- screenshots (optional) -------------------------------------------------------------------------------
  if (process.env.HEADER_SHOTS_DIR) {
    fs.mkdirSync(process.env.HEADER_SHOTS_DIR, { recursive: true });
    const shot = async (w, name, openMenu) => {
      await setWidth(w);
      if (openMenu) { await clickMore(); await sleep(400); }
      const img = await wc.capturePage({ x: 0, y: 0, width: w, height: openMenu ? 330 : 56 });
      fs.writeFileSync(path.join(process.env.HEADER_SHOTS_DIR, name), img.toPNG());
      process.stdout.write(`SCREENSHOT  ${path.join(process.env.HEADER_SHOTS_DIR, name)}\n`);
      if (openMenu) { await press('Escape'); await sleep(200); }
    };
    await shot(1600, 'header-1600.png', false);
    await shot(1024, 'header-1024.png', false);
    await shot(600, 'header-600.png', false);
    await shot(600, 'header-600-menu.png', true);
  }

  gate('h13 no renderer error', errors.length === 0, errors.slice(0, 3));

  // ---- h19 deck-restyle L18e-b: the session pane head is the mockup's 48 px row (.pane grid-template-rows: 48px ...) ------------
  await ej(`openPane({ cwd: ${JSON.stringify(BASE)}, title: 'h17' }); true`);
  await sleep(900);
  const ph = await ej(`(() => {
    const h = document.querySelector('#grid .pane.selected > header') || document.querySelector('.pane > header');
    if (!h) return { missing: true };
    const r = h.getBoundingClientRect();
    return { h: r.height, kids: [...h.children].filter((c) => c.getClientRects().length > 0).length };
  })()`);
  gate('h19 session pane head is 48 px tall', !!ph && ph.h === 48, ph);

  process.stdout.write(`${fail === 0 ? 'VERDICT: ALL GREEN' : 'VERDICT: RED'} (${pass}/${pass + fail})\n`);
  app.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { process.stdout.write(`PROBE CRASH ${String((e && e.stack) || e)}\n`); require('electron').app.exit(2); });
