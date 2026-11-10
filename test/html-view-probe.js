// test/html-view-probe.js — E2E probe: the Files viewer shows an .html page that holds a script in a CLOSED frame
// (<iframe sandbox="allow-scripts" src="deckpage://...">), and leaves a script-free page as it was (srcdoc, allow-same-origin).
// Gates: u1 files_script_page_runs · u2 files_closed_frame · u3 no_ask_on_script_page · u4 script_free_unchanged ·
// u5 files_view_keeps_fonts_link · u6 files_toggle_script_page. Frames are read through WebFrameMain (framesInSubtree).
// The Google Fonts hosts are cancelled by a webRequest stub set before the app boots: the probe never reaches the network.
// Run: see the plan's xvfb probe prefix, then `node_modules/.bin/electron test/html-view-probe.js`
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, net, session } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 120 ? `${x.slice(0, 120)}...(${x.length})` : x));
const withTimeout = (p, ms, msg) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(msg)), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

const NAMES = ['u1_files_script_page_runs', 'u2_files_closed_frame', 'u3_no_ask_on_script_page', 'u4_script_free_unchanged',
  'u5_files_view_keeps_fonts_link', 'u6_files_toggle_script_page'];
const GATE_MS = 40000; // one gate never blocks the probe longer than this
const FONTS_URLS = ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'];
const SEL_TEXT = 'Texte à sélectionner dans la page';
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Inter&display=swap';
const SCRIPT_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>S</title>'
  + `<link rel="stylesheet" href="${FONTS_HREF}"><style>body{font-family:Inter,sans-serif}</style></head>`
  + `<body><h1>Page avec script</h1><p id="sel">${SEL_TEXT}</p><p id="marker">PENDING</p>`
  + '<script>document.getElementById("marker").textContent = "RAN"</script></body></html>\n';
const PLAIN_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>P</title><style>h1{color:rgb(0,128,0)}</style></head>'
  + `<body><h1>Page sans script</h1><p id="sel">${SEL_TEXT}</p><p id="plain">PLAIN-OK</p></body></html>\n`;

let fontsCancelled = 0;
const results = {};
const detail = {};
let finished = false;

function verdict(code) {
  if (finished) return;
  finished = true;
  const bad = NAMES.filter((k) => !results[k]);
  console.log(`INFO fonts requests cancelled by the stub: ${fontsCancelled}`);
  console.log(bad.length
    ? `VERDICT: RED (${NAMES.length - bad.length}/${NAMES.length} green) FAIL: ${bad.join(', ')}`
    : `VERDICT: ALL GREEN (${NAMES.length}/${NAMES.length})`);
  app.exit(code !== undefined ? code : (bad.length ? 1 : 0));
}

function boot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-view-probe-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'script.html'), SCRIPT_PAGE);
  fs.writeFileSync(path.join(proj, 'plain.html'), PLAIN_PAGE);

  const UUID = '66666666-6666-4666-8666-666666666666';
  const fakeProjects = path.join(base, 'projects');
  const projDir = path.join(fakeProjects, 'proj-test');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${UUID}.jsonl`),
    JSON.stringify({ type: 'summary', cwd: proj }) + '\n'
    + JSON.stringify({ type: 'user', cwd: proj, sessionId: UUID, timestamp: '2026-06-05T10:00:00.000Z',
      message: { role: 'user', content: 'hi' } }) + '\n');

  process.env.CLAUDE_DECK_BIN = '/bin/bash';
  process.env.CLAUDE_DECK_NO_OPEN = '1';
  process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;
  process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-view-ask-'));
  process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-view-status-'));
  process.env.CLAUDE_DECK_PRICES_URL ||= 'http://127.0.0.1:1';
  process.env.CLAUDE_DECK_COMMANDS_URL ||= 'http://127.0.0.1:1';

  // Registered BEFORE main.js's own ready handler: the stub is in place before the first window loads.
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: FONTS_URLS }, (d, cb) => { fontsCancelled++; cb({ cancel: true }); });
  });
  require(path.join(__dirname, '..', 'main.js'));
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

  app.whenReady().then(() => run({ UUID })).catch((e) => {
    console.log(`FAIL probe crashed: ${e && e.stack}`);
    verdict(2);
  });
}

async function run({ UUID }) {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; console.log(`FAIL ${n} watchdog: probe stuck for 170s`); }
    verdict(2);
  }, 170000);
  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win) {
      const ready = await win.webContents.executeJavaScript(
        `typeof openSidePanel === 'function' && !!(window.api && window.api.filesRead)`, true).catch(() => false);
      if (!ready) win = null;
    }
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  wc.focus();
  const j = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (code, ms = 6000) => {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await j(code); } catch (_) { /* retry */ }
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await sleep(50);
    }
  };
  const TJ = JSON.stringify({ sessionId: UUID });
  const SETTLED = `(() => { if (document.getElementById('fp-viewer').hidden) return false;
    const b = document.getElementById('fp-vbody'); const m = b.querySelector('.fp-msg');
    return b.children.length > 0 && !(m && /^(Chargement|Recherche)…$/.test(m.textContent)); })()`;
  const FRAME_INFO = `(() => { const f = document.querySelector('#fp-vbody iframe.fp-frame'); if (!f) return null;
    let cd; try { cd = f.contentDocument; } catch (e) { cd = 'threw'; }
    return { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), hasSrcdoc: f.hasAttribute('srcdoc'),
      cdNull: cd === null, frames: document.querySelectorAll('#fp-vbody iframe').length }; })()`;
  const POPUP = `document.querySelector('[data-sp-popup]')`;
  const popupUp = (ms = 2000) => waitFor(`!!${POPUP} && ${POPUP}.getClientRects().length > 0`, ms);
  const clickBtn = (label) => j(`(() => { const b = [...document.querySelectorAll('#fp-mode button')]
    .find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

  // Frame reads. A script-free page sits in a same-origin srcdoc frame whose sandbox forbids scripts, so WebFrameMain cannot run
  // code there: the Deck's own contentDocument serves it. A closed frame has contentDocument === null: WebFrameMain serves it.
  const subFrames = () => wc.mainFrame.framesInSubtree.filter((f) => f.parent !== null);
  const inFrame = async (f, code) => {
    try { return { ok: true, v: await withTimeout(f.executeJavaScript(code), 1500, 'frame script timed out') }; } catch (e) { return { ok: false, err: e && e.message }; }
  };
  const runInFrame = async (body) => {
    const deck = await j(`(() => { const f = document.querySelector('#fp-vbody iframe.fp-frame'); let d = null;
      try { d = f && f.contentDocument; } catch (e) { d = null; }
      if (!d) return { none: true }; return { v: (function (document, window) { ${body} })(d, d.defaultView) }; })()`);
    if (!deck.none) return { via: 'deck', ok: true, v: deck.v === undefined ? null : deck.v };
    for (const f of subFrames()) {
      const r = await inFrame(f, `(function () { ${body} })()`);
      if (r.ok && r.v !== null && r.v !== undefined) return { via: 'frame', ok: true, v: r.v };
    }
    return { via: 'none', ok: false, v: null };
  };
  const frameWith = async (id) => {
    const r = await runInFrame(`const e = document.getElementById(${JSON.stringify(id)}); return e ? e.textContent : null;`);
    return r.ok && r.v !== null ? { via: r.via, text: r.v } : null;
  };
  const waitFrame = async (id, want, ms) => {
    const t0 = Date.now();
    for (;;) {
      const r = await frameWith(id);
      if (r && (want === undefined || r.text === want)) return r;
      if (Date.now() - t0 > ms) return r;
      await sleep(100);
    }
  };
  const openPage = async (rel, id) => {
    await j('closeSidePanel()');
    await sleep(80);
    await j(`openSidePanel('files', ${TJ}, { path: ${JSON.stringify(rel)} })`);
    await waitFor(SETTLED, 5000);
    const fr = await waitFrame(id, undefined, 4000);
    await sleep(400); // the viewer attaches its frame listeners on the frame's load event
    return fr;
  };
  // Selection of #sel inside the frame, then a mouseup from inside it (what a user release does).
  const SELECT_AND_UP = `const e = document.getElementById('sel'); if (!e) return null; const r = document.createRange();
    r.selectNodeContents(e); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    e.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true })); return s.toString();`;

  const gate = async (name, fn) => {
    try {
      const cases = await withTimeout(fn(), GATE_MS, `gate timed out after ${GATE_MS} ms`);
      results[name] = cases.length > 0 && cases.every((c) => c[1]);
      const failed = cases.filter((c) => !c[1]).map((c) => `${c[0]} -> ${short(c[2])}`);
      if (failed.length) detail[name] = failed;
    } catch (e) {
      results[name] = false;
      detail[name] = [`threw: ${e && e.message}`];
    }
    console.log(`${results[name] ? 'PASS' : 'FAIL'} ${name}${detail[name] !== undefined ? ` ${short(detail[name])}` : ''}`);
  };

  // u1 (DoD 1): the script of the page ran inside the frame of the Files viewer.
  await gate(NAMES[0], async () => {
    await openPage('script.html', 'marker');
    const info = await j(FRAME_INFO);
    const r = await waitFrame('marker', 'RAN', 3000);
    return [['the viewer shows a .fp-frame', !!info, info], ['the page marker is found in a frame', !!r, r && r.text],
      ['the marker reads RAN (the page script ran)', !!r && r.text === 'RAN', r && r.text]];
  });

  // u2 (DoD 2): the frame is closed: script only, opaque origin, served by the deckpage scheme.
  await gate(NAMES[1], async () => {
    await openPage('script.html', 'marker');
    const i = await j(FRAME_INFO);
    return [['a .fp-frame exists', !!i, i], ['sandbox is exactly allow-scripts', !!i && i.sandbox === 'allow-scripts', i && i.sandbox],
      ['contentDocument is null (cross-origin)', !!i && i.cdNull === true, i && i.cdNull],
      ['src starts with deckpage://', !!i && typeof i.src === 'string' && i.src.startsWith('deckpage://'), i && i.src]];
  });

  // u3 (DoD 6): a selection + mouseup inside a script frame opens no ask popup. Control: the same gesture on a script-free page does.
  await gate(NAMES[2], async () => {
    await openPage('plain.html', 'sel');
    const ctlSel = await runInFrame(SELECT_AND_UP);
    const control = await popupUp(2000);
    await j(`(() => { const i = document.querySelector('[data-sp-popup] input'); if (i) i.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true })); })()`);
    await waitFor(`!${POPUP}`, 1500);
    await openPage('script.html', 'sel');
    const clean = await j(`!${POPUP}`);
    const sel = await runInFrame(SELECT_AND_UP);
    await sleep(300);
    const popup = await j(`!!${POPUP}`);
    return [['control: the script-free page selection reaches the frame', ctlSel.v === SEL_TEXT, ctlSel],
      ['control: the same gesture opens the popup on a script-free page', control, control],
      ['no popup left before the script page', clean, clean],
      ['the selection exists inside the script frame', sel.v === SEL_TEXT, sel],
      ['no [data-sp-popup] 300 ms after the mouseup', popup === false, popup]];
  });

  // u4 (DoD 5): a script-free page keeps today's view: allow-same-origin + srcdoc.
  await gate(NAMES[3], async () => {
    const fr = await openPage('plain.html', 'plain');
    const i = await j(FRAME_INFO);
    return [['a .fp-frame exists', !!i, i], ['sandbox is exactly allow-same-origin', !!i && i.sandbox === 'allow-same-origin', i && i.sandbox],
      ['filled through srcdoc, no src', !!i && i.hasSrcdoc === true && i.src === null, i],
      ['contentDocument readable (same origin)', !!i && i.cdNull === false, i && i.cdNull],
      ['the page content is shown', !!fr && fr.text === 'PLAIN-OK', fr && fr.text]];
  });

  // u5 (DoD 3, view path): the document the real viewer frame is served still holds the fonts <link>.
  await gate(NAMES[4], async () => {
    await openPage('script.html', 'marker');
    const i = await j(FRAME_INFO);
    const src = i && i.src;
    const isPage = typeof src === 'string' && src.startsWith('deckpage://');
    let status = null;
    let body = '';
    if (isPage) {
      const res = await withTimeout(net.fetch(src), 4000, 'net.fetch timed out');
      status = res.status;
      body = await res.text();
    }
    const links = body.match(/<link\b[^>]*>/gi) || [];
    const kept = links.some((t) => /rel=["']?stylesheet/i.test(t) && t.includes('https://fonts.googleapis.com/'));
    return [['the viewer frame has a deckpage:// src', isPage, src], ['the page is served (200)', status === 200, status],
      ['the served HTML keeps the fonts <link rel=stylesheet>', kept, body.slice(0, 160)]];
  });

  // u6 (DoD 1 + 5): « Texte » shows the source, « Format riche » brings the closed frame back and its script runs.
  await gate(NAMES[5], async () => {
    await openPage('script.html', 'marker');
    const clicked = await clickBtn('Texte');
    await waitFor("!!document.querySelector('#fp-vbody .fp-code')", 2500);
    const t = await j(`(() => { const c = document.querySelector('#fp-vbody .fp-code');
      return { code: c ? c.textContent : null, frame: !!document.querySelector('#fp-vbody iframe') }; })()`);
    await clickBtn('Format riche');
    await waitFor("!!document.querySelector('#fp-vbody iframe.fp-frame')", 2500);
    const i = await j(FRAME_INFO);
    const r = await waitFrame('marker', 'RAN', 3000);
    return [['the Texte button exists', clicked === true, clicked],
      ['Texte shows the source (holds <script)', typeof t.code === 'string' && t.code.includes('<script'), t.code && t.code.slice(0, 80)],
      ['no frame in Texte mode', t.frame === false, t.frame],
      ['back to Format riche: a closed frame (allow-scripts)', !!i && i.sandbox === 'allow-scripts', i && i.sandbox],
      ['back to Format riche: the marker reads RAN', !!r && r.text === 'RAN', r && r.text]];
  });

  clearTimeout(watchdog);
  verdict();
}

boot();
