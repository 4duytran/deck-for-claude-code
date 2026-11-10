// test/refresh-spin-probe.js — E2E probe, spec docs/plans/deck-toolbar-fixes.spec.md § U-refresh (B3):
// every refresh button (circular arrows) spins when clicked. Boots the REAL app against throwaway fixtures, holds
// the IPC channel behind each site's reload, and drives a REAL mouse click (sendInputEvent) on the button.
//
// Sites: refresh-sessions (sessions-list), rp-refresh (room-recent), fp-refresh (files-list), fp-vrefresh (files-read),
//        gp-refresh (git-panel-status), pp-refresh (plans-list), up-refresh (usage-report, the usage page).
// Legs per site:
//   icon      the button holds the lc-refresh-cw svg (no text glyph)
//   hit       the click point lands on the button
//   start     within 600 ms of the click a running `transform` animation sits on the icon
//   held      the reload request reached main and is parked
//   keeps     1 s later (reload still pending) the same icon is still running and has turned >= 360 degrees, and is still turning
//   stops     released: no transform animation is left on the icon, and it rests at `transform: none`
//   whole     the stop is on a whole turn (the animation's iteration count is a whole number >= 1 and the last
//             animated frame sits within 40 degrees of a whole turn)
//   instant   an unheld (instant) reload still turns at least one whole turn (>= 320 degrees sampled, whole stop)
//   reduced   `prefers-reduced-motion: reduce` (emulated): no transform animation at all, but the button's own look
//             (colour or background) differs from its hovered rest while the reload is pending, and is back after
//
// Run: cd claude-deck && xvfb-run -a node_modules/.bin/electron test/refresh-spin-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CLAUDE_DECK_ZOOM = process.env.CLAUDE_DECK_ZOOM || '1.0';

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rspin-'));
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const proj = path.join(base, 'proj');
const plansDir = path.join(proj, 'docs', 'plans');
fs.mkdirSync(path.join(proj, 'alpha'), { recursive: true });
fs.mkdirSync(plansDir, { recursive: true });
fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello from the session folder\n');
fs.writeFileSync(path.join(proj, 'alpha', 'a.txt'), 'a\n');
fs.writeFileSync(path.join(plansDir, 'a-one.plan.md'), '# H:a-one\n\nbody\n');
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });
const ts = (i) => `2026-06-05T10:0${i}:00.000Z`;
fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), [
  { type: 'summary', cwd: proj },
  { type: 'user', cwd: proj, timestamp: ts(0), message: { role: 'user', content: 'hi' } },
  { type: 'assistant', cwd: proj, timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(plansDir, 'a-one.plan.md') } }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

process.env.HOME = home;
process.env.CLAUDE_DECK_BIN = '/bin/bash';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;
process.env.CLAUDE_DECK_ROOMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rspin-rooms-'));
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rspin-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rspin-status-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => JSON.stringify(s);
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 80 ? `${x.slice(0, 80)}...` : x));

// ---- holds: wrap the registered invoke handlers (pass | hold), release from the probe -----------------------------
const CH = ['sessions-list', 'room-recent', 'files-list', 'files-read', 'git-panel-status', 'plans-list', 'usage-report'];
const H = {};
function installHolds() {
  const map = ipcMain._invokeHandlers;
  if (!map) throw new Error('ipcMain._invokeHandlers missing');
  for (const ch of CH) {
    const orig = map.get(ch);
    if (!orig) throw new Error(`no handler registered for ${ch}`);
    const h = (H[ch] = { mode: 'pass', q: [], orig });
    map.set(ch, (e, ...args) => {
      if (h.mode !== 'hold') return orig(e, ...args);
      const rec = { e, args, done: false };
      rec.p = new Promise((res, rej) => { rec.res = res; rec.rej = rej; });
      h.q.push(rec);
      return rec.p;
    });
  }
}
async function settle(ch, rec) {
  if (rec.done) return;
  rec.done = true;
  const old = typeof rec.e._reply === 'function';
  try { const v = await H[ch].orig(rec.e, ...rec.args); rec.res(v); } catch (err) { if (old) rec.e._throw(err); else rec.rej(err); }
}
const pending = (ch) => H[ch].q.filter((r) => !r.done);
const startHold = (ch) => { H[ch].mode = 'hold'; H[ch].q = []; };
const release = async (ch) => { H[ch].mode = 'pass'; for (const r of pending(ch)) await settle(ch, r); };
const releaseAll = async () => { for (const ch of CH) await release(ch); };

// Page-side sampler: the icon's rotation read from its computed transform every 16 ms (unwrapped, in degrees).
const RS = `(() => { if (window.__rs) return true;
  const isT = (a) => { try { return !!a.effect && a.effect.getKeyframes().some((k) => 'transform' in k); } catch (_) { return false; } };
  const tAnims = (icon) => icon.getAnimations().filter(isT);
  let timer = 0; let rec = null;
  const frame = () => {
    if (!rec) return;
    const cs = getComputedStyle(rec.icon).transform;
    let raw = 0;
    if (cs && cs !== 'none') { const m = new DOMMatrix(cs); raw = Math.atan2(m.b, m.a) * 180 / Math.PI; }
    let d = raw - rec.prev;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    rec.unwrapped += d; rec.prev = raw;
    rec.maxDeg = Math.max(rec.maxDeg, rec.unwrapped);
    const run = tAnims(rec.icon).find((a) => a.playState === 'running');
    if (run) { rec.saw = true; rec.lastAnim = rec.unwrapped; rec.anim = run; }
  };
  window.__rs = {
    start(sel) {
      clearInterval(timer);
      const btn = document.querySelector(sel);
      rec = { icon: btn.querySelector('svg') || btn, unwrapped: 0, prev: 0, maxDeg: 0, lastAnim: null, saw: false, anim: null };
      timer = setInterval(frame, 16);
      return true;
    },
    running() { return !!rec && tAnims(rec.icon).some((a) => a.playState === 'running'); },
    saw() { return !!rec && rec.saw; },
    snap() { return { running: this.running(), deg: Math.round(rec.unwrapped), saw: rec.saw }; },
    final() {
      const m = (((rec.lastAnim == null ? 0 : rec.lastAnim) % 360) + 360) % 360;
      let it = null;
      try { it = rec.anim ? rec.anim.effect.getComputedTiming().iterations : null; } catch (_) { /* gone */ }
      return { it, dist: Math.round(Math.min(m, 360 - m)), last: Math.round(rec.lastAnim == null ? 0 : rec.lastAnim),
        max: Math.round(rec.maxDeg), saw: rec.saw, left: tAnims(rec.icon).length, transform: getComputedStyle(rec.icon).transform };
    },
    look(sel) { const cs = getComputedStyle(document.querySelector(sel)); return cs.color + '|' + cs.backgroundColor; },
    stop() { clearInterval(timer); rec = null; },
  };
  return true; })()`;

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 280s'); app.exit(2); }, 280000);
  let code = 1;
  const report = [];
  try {
    let win = null;
    for (let i = 0; i < 300 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (win) {
        const ready = await win.webContents.executeJavaScript(
          `typeof openSidePanel === 'function' && typeof openPlansPanel === 'function' && typeof openFileInPanel === 'function' && !!(window.api && window.api.plansList)`, true).catch(() => false);
        if (!ready) win = null;
      }
      if (!win) await sleep(100);
    }
    if (!win) throw new Error('renderer never became ready');
    installHolds();
    win.setSize(1600, 950);
    await sleep(500);
    const wc = win.webContents;
    const J = (c) => wc.executeJavaScript(c, true);
    await J(RS);
    try { wc.debugger.attach('1.3'); } catch (_) { /* already attached */ }
    const reduced = (on) => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });

    const wait = async (fn, ms = 3000, step = 50) => {
      const end = Date.now() + ms;
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() >= end) return null;
        await sleep(step);
      }
    };
    const T = JSON.stringify({ sessionId: SID });
    const shown = (sel) => `(() => { const b = document.querySelector(${q(sel)}); return !!b && b.getClientRects().length > 0; })()`;
    const count = (sel) => J(`document.querySelectorAll(${q(sel)}).length`);
    const point = (sel) => J(`(() => { const b = document.querySelector(${q(sel)}); const r = b.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2); const y = Math.round(r.top + r.height / 2); const h = document.elementFromPoint(x, y);
      return { x, y, hit: !!h && (h === b || b.contains(h)) }; })()`);
    const hover = async (sel) => { const p = await point(sel); wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(120); return p; };
    const realClick = async (sel) => {
      const p = await hover(sel);
      wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      return p;
    };
    const parkMouse = async () => { wc.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await sleep(100); };

    const SITES = [
      { id: 'refresh-sessions', sel: '#refresh-sessions', ch: 'sessions-list', prep: async () => true },
      {
        id: 'rp-refresh', sel: '#rp-refresh', ch: 'room-recent',
        prep: async () => { await J(`document.getElementById('room-toggle').click()`); return wait(() => J(shown('#rp-refresh')), 3000); },
        done: async () => { await J(`document.getElementById('rp-close').click()`); await sleep(400); },
      },
      {
        id: 'fp-refresh', sel: '#fp-refresh', ch: 'files-list',
        prep: async () => { await J(`openSidePanel('files', ${T})`); return wait(() => count('#fp-tree .fp-row'), 4000); },
      },
      {
        id: 'fp-vrefresh', sel: '#fp-vrefresh', ch: 'files-read',
        prep: async () => { await J(`openFileInPanel(${T}, 'hello.txt')`); return wait(() => J(`!!document.querySelector('#fp-vbody .fp-code') && ${shown('#fp-vrefresh')}`), 4000); },
      },
      {
        id: 'gp-refresh', sel: '#gp-refresh', ch: 'git-panel-status',
        prep: async () => { await J(`openSidePanel('git', ${T})`); const ok = await wait(() => J(shown('#gp-refresh')), 4000); await sleep(1200); return ok; },
      },
      {
        id: 'pp-refresh', sel: '#pp-refresh', ch: 'plans-list',
        prep: async () => { await J(`openPlansPanel({ sessionId: ${q(SID)} })`); return wait(() => count('#pp-list .pp-row'), 4000); },
      },
      {
        // The usage page reloads on its own at open (an automatic load spins too): wait for it to settle before holding the channel.
        id: 'up-refresh', sel: '#usage-page .up-refresh', ch: 'usage-report',
        prep: async () => {
          await J(`openUsagePage('cost')`);
          return wait(() => J(`(() => { const b = document.querySelector('#usage-page .up-refresh'); return !!b && b.getClientRects().length > 0 && !b.disabled; })()`), 8000);
        },
        done: async () => { await J(`closeUsagePage()`); await sleep(400); },
      },
    ];

    for (const S of SITES) {
      const legs = [];
      const L = (n, ok, info) => legs.push({ n, ok: !!ok, info });
      try {
        await releaseAll();
        await reduced(false);
        await parkMouse();
        L('prep: button shown', await S.prep() && await J(shown(S.sel)));
        await sleep(700); // a panel's own entrance must be over: the click point is measured once
        const href = await J(`(() => { const u = document.querySelector(${q(S.sel)} + ' svg use'); return u ? u.getAttribute('href') : null; })()`);
        L('icon: the lc-refresh-cw svg', href === '#lc-refresh-cw', href);

        // ---- delayed reload, motion on ----
        startHold(S.ch);
        await J(`__rs.start(${q(S.sel)})`);
        const p = await realClick(S.sel);
        L('hit: the click point lands on the button', p.hit, p);
        const started = await wait(() => J(`__rs.running()`), 600, 20);
        L('start: a running transform animation sits on the icon', started);
        L('held: the reload request is parked in main', await wait(() => pending(S.ch).length >= 1, 3000));
        await sleep(1000);
        const mid = await J(`__rs.snap()`);
        await sleep(250);
        const mid2 = await J(`__rs.snap()`);
        L('keeps: still turning while the reload is pending (>= 360 deg, still moving)',
          mid.running && mid2.running && mid.deg >= 360 && mid2.deg > mid.deg + 20, { mid, mid2 });
        await release(S.ch);
        const stopped = await wait(async () => !(await J(`__rs.running()`)), 3500, 30);
        await sleep(150);
        const fin = await J(`__rs.final()`);
        L('stops: no transform animation left, rests at transform none', stopped && fin.left === 0 && fin.transform === 'none', fin);
        L('whole: stops on a whole turn', Number.isInteger(fin.it) && fin.it >= 1 && fin.dist <= 40, fin);

        // ---- instant reload: at least one whole turn ----
        await J(`__rs.start(${q(S.sel)})`);
        await realClick(S.sel);
        await wait(() => J(`__rs.saw()`), 600, 20);
        await wait(async () => !(await J(`__rs.running()`)), 3500, 30);
        await sleep(150);
        const inst = await J(`__rs.final()`);
        L('instant: an instant reload still turns a whole turn', inst.saw && inst.max >= 320 && Number.isInteger(inst.it) && inst.it >= 1 && inst.dist <= 40 && inst.left === 0, inst);
        await release(S.ch);

        // ---- reduced motion: no rotation, a pressed look instead ----
        await reduced(true);
        await sleep(100);
        const rest = await J(`__rs.look(${q(S.sel)})`);
        startHold(S.ch);
        await J(`__rs.start(${q(S.sel)})`);
        await realClick(S.sel);
        await wait(() => pending(S.ch).length >= 1, 3000);
        await sleep(450);
        const during = await J(`({ look: __rs.look(${q(S.sel)}), saw: __rs.saw(), running: __rs.running() })`);
        await release(S.ch);
        await sleep(900);
        const after = await J(`({ look: __rs.look(${q(S.sel)}), saw: __rs.saw() })`);
        L('reduced: no rotation animation', !during.saw && !during.running && !after.saw, { during, after });
        L('reduced: a pressed look while pending, back after', during.look !== rest && after.look === rest, { rest, during: during.look, after: after.look });
        await reduced(false);
      } catch (err) {
        L('exception', false, String((err && err.stack) || err).slice(0, 300));
      } finally {
        await releaseAll().catch(() => {});
        await reduced(false).catch(() => {});
        if (S.done) await S.done().catch(() => {});
      }
      report.push({ id: S.id, legs, ok: legs.length > 0 && legs.every((l) => l.ok) });
    }

    let n = 0;
    for (const s of report) {
      for (const l of s.legs) console.log(`${l.ok ? 'PASS' : 'FAIL'}  ${s.id} :: ${l.n}${l.ok ? '' : `  ${short(l.info)}`}`);
      console.log(`${s.ok ? 'PASS' : 'FAIL'} refresh-spin ${s.id}`);
      if (s.ok) n += 1;
    }
    console.log(`VERDICT: ${n === report.length ? 'ALL GREEN' : 'RED'} (${n}/${report.length})`);
    code = n === report.length ? 0 : 1;
  } catch (err) {
    console.log(`FAIL probe crashed: ${(err && err.stack) || err}`);
    code = 2;
  } finally {
    clearTimeout(watchdog);
    app.exit(code);
  }
});
