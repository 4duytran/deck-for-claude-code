// test/html-page-probe.js — transport probe of the closed script frame (deck-html-pages L1a), gates t1-t14.
// A page handed to window.api.pageServe(slot, html) runs in <iframe sandbox="allow-scripts" src="deckpage://...">;
// the frame is read through WebFrameMain and a loopback server counts every request it could cause.
// Needs no new module: on base window.api.pageServe is undefined, so every gate that needs it FAILs (t12 does not).
// Run: cd claude-deck && xvfb-run -a node_modules/.bin/electron test/html-page-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, webContents, net } = require('electron');

// PAGE_CSP is module-internal in page-scheme.js (not exported): t9 compares the served header to this literal.
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'";
// Deck main-frame Notification.requestPermission() measured on base 82ec99a (no permission handler: Electron approves).
const T12_BASE = 'granted';
const MIB = 1024 * 1024;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">';

const hits = []; // every request the loopback server sees: a closed frame must cause none
const server = http.createServer((req, res) => { hits.push(req.url); res.statusCode = 404; res.end(); });
server.listen(0, '127.0.0.1', () => boot(server.address().port));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 90 ? `${x.slice(0, 90)}...(${x.length})` : x));
process.on('unhandledRejection', (e) => console.log(`WARN unhandled rejection: ${e && e.message}`));

function boot(PORT) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-page-probe-'));
  const fakeProjects = path.join(base, 'projects');
  fs.mkdirSync(fakeProjects, { recursive: true });
  const pxPath = path.join(base, 'px.png');
  fs.writeFileSync(pxPath, Buffer.from(PNG_B64, 'base64'));
  const navC = path.join(base, 'nav-c.html');
  fs.writeFileSync(navC, '<!doctype html><p id="c">TARGET-C</p><script>window.__tgt = "C";</script>');

  process.env.CLAUDE_DECK_BIN = '/bin/bash';
  process.env.CLAUDE_DECK_NO_OPEN = '1';
  process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;
  process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-page-ask-'));
  process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-page-status-'));
  require(path.join(__dirname, '..', 'main.js'));
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

  app.whenReady().then(() => run({ PORT, pxPath, navC })).catch((e) => { console.log(`FAIL probe crashed: ${e && e.stack}`); app.exit(2); });
}

async function run({ PORT, pxPath, navC }) {
  const L = `http://127.0.0.1:${PORT}`;
  const MARK = `RAN-${crypto.randomBytes(4).toString('hex')}`;
  const results = {};
  const detail = {};
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 280s'); app.exit(2); }, 280000);
  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win) {
      const ready = await win.webContents.executeJavaScript(`!!(window.api && window.api.filesList)`, true).catch(() => false);
      if (!ready) win = null;
    }
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  const j = (code) => wc.executeJavaScript(code, true);
  const withTimeout = (p, ms, label) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })])
      .finally(() => clearTimeout(t));
  };
  const hitsOn = (re) => hits.filter((h) => re.test(h));

  // Frames are found by frameTreeNodeId: a blocked navigation can change a frame's url but never its node id.
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f.parent);
  const fr = (id) => frames().find((f) => f.frameTreeNodeId === id) || null;
  const inFrame = (id, code, gesture = false, ms = 8000) => {
    const f = fr(id);
    return f ? withTimeout(f.executeJavaScript(code, gesture), ms, 'frame script') : Promise.reject(new Error('frame gone'));
  };
  const READ_MARK = "(document.getElementById('m') || {}).textContent";

  const serveJs = async (slotJs, htmlJs) => {
    const res = await j(`(() => { if (!window.api || typeof window.api.pageServe !== 'function') return { missing: true };
      return window.api.pageServe(${slotJs}, ${htmlJs}); })()`);
    if (res && res.missing) throw new Error('window.api.pageServe is not a function');
    return res;
  };
  const serve = (html, slot = 'files') => serveJs(JSON.stringify(slot), JSON.stringify(html));
  const servedOk = (res) => !!res && res.ok === true && typeof res.url === 'string' && res.url.startsWith('deckpage://');
  const unmount = () => j("document.querySelectorAll('iframe.probe-frame').forEach((x) => x.remove())").catch(() => {});
  const mount = async (html, { ready = true } = {}) => {
    const res = await serve(html);
    if (!servedOk(res)) throw new Error(`pageServe refused: ${short(res)}`);
    await j(`(() => { document.querySelectorAll('iframe.probe-frame').forEach((x) => x.remove());
      const f = document.createElement('iframe'); f.className = 'probe-frame'; f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:320px;z-index:99999;background:#fff';
      f.src = ${JSON.stringify(res.url)}; document.body.appendChild(f); })()`);
    let found = null;
    for (const t0 = Date.now(); !found && Date.now() - t0 < 6000;) {
      found = frames().find((x) => x.url.startsWith('deckpage://')) || null;
      if (!found) await sleep(50);
    }
    if (!found) throw new Error('frame never committed to deckpage://');
    const id = found.frameTreeNodeId;
    if (ready) {
      let v = null;
      for (const t0 = Date.now(); v !== MARK && Date.now() - t0 < 5000;) {
        v = await inFrame(id, READ_MARK, false, 1500).catch(() => null);
        if (v !== MARK) await sleep(60);
      }
      if (v !== MARK) throw new Error(`marker not written by the frame script (read ${short(v)})`);
    }
    return { id, url: res.url };
  };

  const gate = async (name, fn, ms = 40000) => {
    try { results[name] = !!(await withTimeout(Promise.resolve().then(fn), ms, `gate ${name}`)); } catch (e) {
      results[name] = false;
      detail[name] = { ...(detail[name] && typeof detail[name] === 'object' ? detail[name] : {}), threw: e && e.message };
    }
    await unmount();
    console.log(`${results[name] ? 'PASS' : 'FAIL'} ${name}${detail[name] !== undefined ? ` ${short(detail[name])}` : ''}`);
  };

  const page = (head, body, script) => `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>${head}</head>`
    + `<body>${body}<script>${script}</script></body></html>`;
  const SET_MARK = `document.getElementById('m').textContent = ${JSON.stringify(MARK)};`;
  const SLOT_P = '<p id="m">PENDING</p>';
  const BASIC = page('', SLOT_P, SET_MARK);
  const EGRESS = page(`<link rel="stylesheet" href="${L}/css-static">`, `${SLOT_P}<img src="${L}/img-static">`,
    `${SET_MARK} fetch('${L}/fetch-script').catch(() => {}); new Image().src = '${L}/img-script';
     const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${L}/css-script'; document.head.appendChild(l);`);
  const deck0 = wc.getURL();

  await gate('t1_script_runs_transport', async () => {
    const m = await mount(BASIC);
    const r = await inFrame(m.id, `({ mark: ${READ_MARK}, url: location.href })`);
    detail.t1_script_runs_transport = r;
    return r.mark === MARK && r.url === m.url;
  });

  await gate('t2_parent_unreachable', async () => {
    const m = await mount(BASIC);
    const r = await inFrame(m.id, `(() => { const o = { origin: self.origin, framed: parent !== self };
      try { o.parentTitle = String(parent.document.title); o.parentThrew = null; } catch (e) { o.parentThrew = e.name; }
      try { o.topTitle = String(top.document.title); o.topThrew = null; } catch (e) { o.topThrew = e.name; }
      return o; })()`);
    detail.t2_parent_unreachable = r;
    return r.framed && r.parentThrew !== null && r.topThrew !== null && r.origin === 'null';
  });

  await gate('t3_no_api', async () => {
    const m = await mount(BASIC);
    const r = await inFrame(m.id, `({ api: typeof window.api, req: typeof require, proc: typeof process,
      ipc: typeof ipcRenderer, electron: typeof electron })`);
    r.deckApi = await j('typeof window.api'); // control: the Deck itself has the bridge
    detail.t3_no_api = r;
    return r.api === 'undefined' && r.req === 'undefined' && r.proc === 'undefined' && r.ipc === 'undefined'
      && r.electron === 'undefined' && r.deckApi === 'object';
  });

  await gate('t4_no_loopback_egress', async () => {
    hits.length = 0;
    await net.fetch(`${L}/control`).then((r) => r.arrayBuffer());
    const control = hits.includes('/control'); // the counter sees a request the probe sends itself
    hits.length = 0;
    const m = await mount(EGRESS);
    await inFrame(m.id, `(async () => { try { await fetch('${L}/fetch-exec'); } catch (_) { /* blocked */ }
      new Image().src = '${L}/img-exec'; const l = document.createElement('link'); l.rel = 'stylesheet';
      l.href = '${L}/css-exec'; document.head.appendChild(l); return 1; })()`);
    await sleep(1500);
    const egress = hitsOn(/^\/(fetch|img|css)-/);
    detail.t4_no_loopback_egress = { control, egress };
    return control && egress.length === 0;
  });

  await gate('t5_no_file_subresource', async () => {
    const m = await mount(BASIC);
    const r = await inFrame(m.id, `(async () => { const load = (src) => new Promise((res) => { const i = new Image();
      i.onload = () => res('load'); i.onerror = () => res('error'); i.src = src; setTimeout(() => res('timeout'), 4000); });
      return { file: await load(${JSON.stringify(pathToFileURL(pxPath).href)}),
        data: await load(${JSON.stringify(`data:image/png;base64,${PNG_B64}`)}) }; })()`, false, 12000);
    detail.t5_no_file_subresource = r; // control: the same PNG as data: loads, so the file: error is the barrier
    return r.file === 'error' && r.data === 'load';
  });

  // A data:/blob: target inherits PAGE_CSP from its initiator, so "no script at the target" rests on the marker
  // read: no target marker readable = the target document never committed.
  await gate('t6_nav_blocked', async () => {
    const out = {};
    detail.t6_nav_blocked = {};
    const tgt = (n) => `<!doctype html><title>T</title><body><script>window.__tgt = "${n}";`
      + `document.documentElement.setAttribute("data-tgt", "${n}"); fetch("${L}/nav-${n}").catch(() => {});`
      + `new Image().src = "${L}/nav-${n}-img";</script></body>`;
    const attempt = async (name, attackJs, keepsPage) => {
      try {
        hits.length = 0;
        const m = await mount(BASIC);
        const url0 = fr(m.id).url;
        const issued = await inFrame(m.id, attackJs).catch((e) => `threw:${e.message}`);
        await sleep(1300);
        const f = fr(m.id);
        const mark = await inFrame(m.id, READ_MARK, false, 2000).catch(() => null);
        const tg = await inFrame(m.id, 'window.__tgt || document.documentElement.getAttribute("data-tgt") || null', false, 2000)
          .catch(() => null);
        const info = { issued: short(issued), same: !!f && f.url === url0, mark: mark === MARK, deckSame: wc.getURL() === deck0,
          hits: hitsOn(/^\/nav-/).length, target: tg };
        detail.t6_nav_blocked[name] = info;
        out[name] = info.deckSame && info.hits === 0 && !tg && (!keepsPage || (info.same && info.mark));
      } catch (e) { out[name] = false; detail.t6_nav_blocked[name] = { threw: e.message }; }
    };
    await attempt('a_script_location', `location.href = ${JSON.stringify(`${L}/nav-a`)}; 'issued'`, true);
    await attempt('b_link_click', `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(`${L}/nav-b`)};
      document.body.appendChild(a); a.click(); return 'issued'; })()`, true);
    await attempt('c_file', `location.href = ${JSON.stringify(pathToFileURL(navC).href)}; 'issued'`, true);
    await attempt('d_top_location', `(() => { try { top.location.href = ${JSON.stringify(`${L}/nav-d`)}; return 'no-throw'; }
      catch (e) { return e.name; } })()`, true);
    await attempt('e_data', `location.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(tgt('e'))}); 'issued'`, false);
    await attempt('f_blob', `location.href = URL.createObjectURL(new Blob([${JSON.stringify(tgt('f'))}], { type: 'text/html' })); 'issued'`, false);
    return Object.keys(out).length === 6 && Object.values(out).every(Boolean);
  }, 80000);

  await gate('t7_no_popup', async () => {
    const m = await mount(BASIC);
    const w0 = BrowserWindow.getAllWindows().length;
    const c0 = webContents.getAllWebContents().length;
    hits.length = 0;
    const r = await inFrame(m.id, `(() => { try { return window.open(${JSON.stringify(`${L}/popup`)}) === null ? 'null' : 'window'; }
      catch (e) { return 'threw:' + e.name; } })()`, true);
    await sleep(1000);
    const w1 = BrowserWindow.getAllWindows().length;
    const c1 = webContents.getAllWebContents().length;
    detail.t7_no_popup = { open: r, windows: [w0, w1], contents: [c0, c1], hits: hitsOn(/^\/popup/).length };
    return r !== 'window' && w1 === w0 && c1 === c0 && hitsOn(/^\/popup/).length === 0;
  });

  await gate('t8_perm_denied', async () => {
    const m = await mount(BASIC);
    const out = {};
    detail.t8_perm_denied = {};
    const sub = async (name, fn) => {
      try { const v = await fn(); detail.t8_perm_denied[name] = v; out[name] = v; } catch (e) { out[name] = false; detail.t8_perm_denied[name] = `threw: ${e.message}`; }
    };
    await sub('frame_permission', async () => (await inFrame(m.id, 'Notification.permission')) === 'denied' && 'denied');
    await sub('frame_request', async () => (await inFrame(m.id, 'Notification.requestPermission()', true)) === 'denied' && 'denied');
    await sub('nested_srcdoc', async () => {
      const r = await inFrame(m.id, `new Promise((resolve) => {
        const f = document.createElement('iframe');
        window.addEventListener('message', (ev) => { if (ev.source === f.contentWindow) resolve(ev.data); });
        f.srcdoc = '<script>Notification.requestPermission().then((r) => parent.postMessage({ req: r, perm: Notification.permission }, "*"),'
          + ' (e) => parent.postMessage({ err: String(e) }, "*"));</script>';
        document.body.appendChild(f);
        setTimeout(() => resolve({ err: 'timeout' }), 5000);
      })`, false, 9000);
      detail.t8_perm_denied.nested_raw = r;
      return r.req === 'denied' && r.perm === 'denied';
    });
    return Object.keys(out).length === 3 && Object.values(out).every(Boolean);
  });

  await gate('t9_policy_fonts_only', async () => {
    const res = await serve(page(FONTS_LINK, SLOT_P, SET_MARK)); // served only, never mounted: no network
    if (!servedOk(res)) throw new Error(`pageServe refused: ${short(res)}`);
    const r = await net.fetch(res.url);
    const hdr = r.headers.get('content-security-policy');
    const body = await r.text();
    const remote = ((hdr || '').match(/https?:\/\/[^\s;]+/g) || []).sort();
    const wide = /(^|[\s;])(\*|https?:|wss?:|ftp:)(?=[\s;]|$)/.test(hdr || '');
    detail.t9_policy_fonts_only = { status: r.status, hdr, remote, wide, link: body.includes(FONTS_LINK) };
    return r.status === 200 && hdr === PAGE_CSP && !wide && body.includes(FONTS_LINK)
      && JSON.stringify(remote) === JSON.stringify(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  });

  await gate('t10_frame_out_of_process', async () => {
    const m = await mount(BASIC);
    const f = fr(m.id);
    const deckPid = wc.mainFrame.osProcessId;
    detail.t10_frame_out_of_process = { frame: f.osProcessId, deck: deckPid };
    return f.osProcessId > 0 && deckPid > 0 && f.osProcessId !== deckPid;
  });

  await gate('t11_deck_responsive', async () => {
    const m = await mount(page('', SLOT_P, 'for (;;) {}'), { ready: false });
    const pid = fr(m.id).osProcessId;
    try {
      let busy = false; // control: the frame's own thread no longer answers, so the loop is engaged
      for (let i = 0; i < 8 && !busy; i++) {
        busy = await inFrame(m.id, '1 + 1', false, 400).then(() => false, () => true);
        if (!busy) await sleep(150);
      }
      const t0 = Date.now();
      const v = await Promise.race([j('1 + 1'), sleep(1000).then(() => 'timeout')]);
      const ms = Date.now() - t0;
      detail.t11_deck_responsive = { busy, value: v, ms };
      return busy && v === 2 && ms <= 1000;
    } finally {
      await unmount();
      if (pid > 1 && pid !== process.pid && pid !== wc.mainFrame.osProcessId) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
    }
  });

  await gate('t12_deck_permission_unchanged', async () => {
    const v = await j('Notification.requestPermission()');
    detail.t12_deck_permission_unchanged = { observed: v, expected: T12_BASE };
    return v === T12_BASE;
  });

  await gate('t13_serve_bounds', async () => {
    const out = {};
    const tooLarge = (r) => !!r && r.ok === false && r.error === 'tooLarge';
    out.over_cap = tooLarge(await serveJs("'files'", `'x'.repeat(${MIB + 1})`));
    out.over_cap_multibyte = tooLarge(await serveJs("'files'", `'\\u00e9'.repeat(${MIB / 2 + 1})`)); // 2 bytes a char
    out.at_cap_accepted = servedOk(await serveJs("'files'", `'x'.repeat(${MIB})`));
    const other = await serve('<p>x</p>', 'other');
    out.slot_other = !!other && other.ok === false && other.url === undefined;
    const proto = await serve('<p>x</p>', '__proto__');
    out.slot_proto = !!proto && proto.ok === false && proto.url === undefined;
    detail.t13_serve_bounds = out;
    return Object.values(out).every(Boolean);
  });

  await gate('t14_token_lifecycle', async () => {
    const a = await serve('<p id="m">A</p>');
    const b = await serve('<p id="m">B</p>');
    if (!servedOk(a) || !servedOk(b)) throw new Error(`pageServe refused: ${short([a, b])}`);
    const second = await net.fetch(b.url);
    const secondBody = await second.text();
    const first = await net.fetch(a.url);
    const fresh = await net.fetch(`deckpage://page/${crypto.randomUUID()}`);
    detail.t14_token_lifecycle = { differ: a.url !== b.url, second: second.status, first: first.status, fresh: fresh.status };
    return a.url !== b.url && second.status === 200 && secondBody.includes('>B<') && first.status === 404 && fresh.status === 404;
  });

  clearTimeout(watchdog);
  const names = Object.keys(results);
  const bad = names.filter((k) => !results[k]);
  console.log(bad.length
    ? `VERDICT: RED (${names.length - bad.length}/${names.length} green) FAIL: ${bad.join(', ')}`
    : `VERDICT: ALL GREEN (${names.length}/${names.length})`);
  app.exit(bad.length ? 1 : 0);
}
