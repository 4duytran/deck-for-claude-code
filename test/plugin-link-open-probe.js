// test/plugin-link-open-probe.js — gates l1-l8 of daily-brief-v2 step D3 (contract C13), l9-l15 of daily-brief-v3 step D5.
// A click (trusted mouse / key events through CDP Input.*) on an https link inside a PLUGIN report frame must reach
// shell.openExternal exactly once per OPEN_MIN_INTERVAL_MS, with the exact URL; every other scheme, every other
// slot (files / plans), a fragment link and target=_blank must not. shell.openExternal is STUBBED before main.js
// loads (a real browser is never opened); the frame URL, the Deck URL and the window count must stay as they were.
// Each refusal gate ends with an https control click on a plugin link, so a dead guard cannot pass it vacuously.
// l9-l15 (Slack app links): dialog.showMessageBox and child_process.execFile (xdg-mime / xdg-open ONLY, every other
// command goes to the real one) are STUBBED before main.js loads, so the real opener and the real Slack never run;
// each gate scripts the fake answer / exit status of the handler check and of xdg-open.
// Run: env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY ... xvfb-run -a node_modules/.bin/electron test/plugin-link-open-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const cp = require('child_process');
// Second layer under the execFile stub: a native launch (Chromium's own external-protocol handler, or an execFile
// that escaped the stub) finds these fakes first on PATH, so the real opener never runs. PATH is set from constants.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-link-bin-'));
const nativeLog = path.join(fakeBin, 'native.log');
for (const name of ['xdg-open', 'xdg-mime']) fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${nativeLog}"\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${fakeBin}:/usr/local/bin:/usr/bin:/bin`;
const nativeLaunches = () => { try { return fs.readFileSync(nativeLog, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const { app, BrowserWindow, webContents, shell, dialog } = require('electron');

const opened = [];
const stub = async (url) => { opened.push(url); };
shell.openExternal = stub;
if (require('electron').shell.openExternal !== stub) { console.log('FAIL shell.openExternal stub did not take: aborting before any window'); process.exit(2); }

// Slack opening fakes. mime: { out } present / empty, { fail } exit status, { hang } answers only through opts.timeout.
// open: { code, after } exit status after `after` ms, { hang, lateAfter, lateCode } still running, exits late.
const dialogs = [];
const dialogStub = async (...a) => { dialogs.push(a[a.length - 1]); return { response: 0 }; };
dialog.showMessageBox = dialogStub;
if (require('electron').dialog.showMessageBox !== dialogStub) { console.log('FAIL dialog stub did not take: aborting before any window'); process.exit(2); }
const calls = [];
const PRESENT = { out: 'slack.desktop\n' };
const EXIT_OK = { code: 0, after: 40 };
let mime = PRESENT;
let openFake = EXIT_OK;
const realExecFile = cp.execFile;
const fakeExecFile = function (file, ...rest) {
  if (file !== 'xdg-mime' && file !== 'xdg-open') return realExecFile.call(cp, file, ...rest);
  const args = rest.find((x) => Array.isArray(x)) || [];
  const opts = rest.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
  const cb = rest.find((x) => typeof x === 'function') || (() => {});
  calls.push({ file, args: args.slice(), opts: { ...opts } });
  const exitErr = (code) => Object.assign(new Error(`fake ${file} exit ${code}`), { code });
  const later = (ms, f) => setTimeout(f, ms);
  if (file === 'xdg-mime') {
    if (mime.hang) later(opts.timeout || 60000, () => cb(Object.assign(new Error('fake timeout'), { killed: true, signal: 'SIGTERM', code: null }), '', ''));
    else if (mime.fail) later(20, () => cb(exitErr(mime.fail), '', ''));
    else later(20, () => cb(null, mime.out, ''));
  } else if (openFake.hang) later(openFake.lateAfter, () => cb(exitErr(openFake.lateCode), '', ''));
  else later(openFake.after, () => cb(openFake.code === 0 ? null : exitErr(openFake.code), '', ''));
  return { pid: 0, unref() {}, kill() {}, on() { return this; }, once() { return this; } };
};
if (realExecFile[util.promisify.custom]) fakeExecFile[util.promisify.custom] = realExecFile[util.promisify.custom];
cp.execFile = fakeExecFile;
if (require('child_process').execFile !== fakeExecFile) { console.log('FAIL execFile stub did not take: aborting before any window'); process.exit(2); }
const warns = [];
const realWarn = console.warn.bind(console);
console.warn = (...a) => { warns.push(a.join(' ')); realWarn(...a); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 90 ? `${x.slice(0, 90)}...(${x.length})` : x));
process.on('unhandledRejection', (e) => console.log(`WARN unhandled rejection: ${e && e.message}`));

const OPEN_MIN_INTERVAL_MS = 1000; // mirrors src/main/window.js
const URL_A = 'https://example.org/report/a?x=1&y=2';
const URL_B = 'https://example.org/report/b';
const CONTROL = 'https://example.org/control';
const SLACK_OK = 'slack://channel?team=T012ABCDE&id=C012ABCDE';
const DIALOG_MSG = 'Impossible d’ouvrir Slack';
const DETAIL_NONE = 'Aucune application n’est associée aux liens slack:// sur cet ordinateur. Installe Slack ou ouvre-le une fois, puis réessaie.';
const DETAIL_FAILED = 'Slack n’a pas pu ouvrir ce lien.';

process.env.CLAUDE_DECK_BIN = '/bin/bash';
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_ZOOM = '1.0';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-link-probe-'));
process.env.CLAUDE_DECK_PROJECTS_DIR = path.join(base, 'projects');
fs.mkdirSync(process.env.CLAUDE_DECK_PROJECTS_DIR, { recursive: true });
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-link-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-link-status-'));
require(path.join(__dirname, '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
app.whenReady().then(run).catch((e) => { console.log(`FAIL probe crashed: ${e && e.stack}`); app.exit(2); });

// Link i sits at a fixed viewport position: x 10..310, y 10+50i .. 50+50i (clicked at 160, 30+50i).
const linkPage = (links, extra = '') => '<!doctype html><html><head><title>probe</title></head><body style="margin:0">'
  + links.map((l, i) => `<a href="${l.href}"${l.target ? ` target="${l.target}"` : ''} style="position:fixed;left:10px;top:${10 + 50 * i}px;`
    + `width:300px;height:40px;background:#ccd;display:block">${l.text || `link ${i}`}</a>`).join('')
  + `${extra}</body></html>`;

async function run() {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 300s'); app.exit(2); }, 300000);
  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win) {
      const ready = await win.webContents.executeJavaScript('!!(window.api && window.api.pageServe)', true).catch(() => false);
      if (!ready) win = null;
    }
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  win.show(); wc.focus();
  const j = (code) => wc.executeJavaScript(code, true);
  const frames = () => wc.mainFrame.framesInSubtree.filter((f) => f.parent);
  const frameAt = (url) => frames().find((f) => f.url === url || f.url.split('#')[0] === url) || null;
  const results = {};

  const mount = async (slot, html) => {
    const res = await j(`window.api.pageServe(${JSON.stringify(slot)}, ${JSON.stringify(html)})`);
    if (!res || res.ok !== true || typeof res.url !== 'string' || !res.url.startsWith('deckpage://')) throw new Error(`pageServe refused: ${short(res)}`);
    await j(`(() => { document.querySelectorAll('iframe.probe-frame').forEach((x) => x.remove());
      const f = document.createElement('iframe'); f.className = 'probe-frame'; f.setAttribute('sandbox', 'allow-scripts');
      f.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:520px;z-index:99999;background:#fff;border:0';
      f.src = ${JSON.stringify(res.url)}; document.body.appendChild(f); })()`);
    let found = null;
    for (const t0 = Date.now(); !found && Date.now() - t0 < 6000;) {
      found = frameAt(res.url);
      if (!found) await sleep(50);
    }
    if (!found) throw new Error('frame never committed to its deckpage:// URL');
    await sleep(350);
    return { id: found.frameTreeNodeId, url: res.url };
  };
  const unmount = () => j("document.querySelectorAll('iframe.probe-frame').forEach((x) => x.remove())").catch(() => {});
  // The report frame is out of process: wc.sendInputEvent never reaches it (measured: no click landed), CDP Input.* is routed to it.
  wc.debugger.attach('1.3');
  const cdp = (method, params) => wc.debugger.sendCommand(method, params);
  const clickAt = async (x, y, settle = 250) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(settle);
  };
  const click = (i, settle) => clickAt(160, 30 + 50 * i, settle);
  const KEYS = {
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  };
  const key = async (name) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[name] });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[name] });
  };
  const stays = (m) => { const f = frames().find((x) => x.frameTreeNodeId === m.id); return !!f && f.url === m.url; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const gate = async (name, fn) => {
    let detail;
    try {
      await sleep(OPEN_MIN_INTERVAL_MS + 150); // the previous gate's opening must be out of the rate window
      opened.length = 0; calls.length = 0; dialogs.length = 0; mime = PRESENT; openFake = EXIT_OK;
      detail = await fn();
    } catch (e) { detail = { threw: e && e.message }; }
    const ok = !!detail && detail.ok === true;
    results[name] = ok;
    await unmount();
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${short(detail)}`}`);
  };

  await gate('l1_https_in_plugin_frame_opens_once', async () => {
    const deckUrl = wc.getURL();
    const m = await mount('plugin', linkPage([{ href: URL_A }]));
    await click(0);
    return { ok: same(opened, [URL_A]) && stays(m) && wc.getURL() === deckUrl, opened, frameStays: stays(m) };
  });

  await gate('l2_other_schemes_refused', async () => {
    const deckUrl = wc.getURL();
    // One frame per target: a scheme the app CSP frame-src refuses (data:, mailto:, file:) ends its frame on the blocked
    // page (CLAUDE.md rule 2), which would take the next link away. http: reaches the guard, so its frame must stay.
    const bad = ['http://example.org/plain', 'javascript:void(0)', 'data:text/html,x', 'file:///etc/hostname', 'mailto:a@example.org'];
    let httpStays = null;
    for (const href of bad) {
      const m = await mount('plugin', linkPage([{ href }]));
      await click(0);
      if (href.startsWith('http:')) httpStays = stays(m);
    }
    const afterBad = opened.slice();
    await mount('plugin', linkPage([{ href: CONTROL }]));
    await click(0);
    return { ok: afterBad.length === 0 && httpStays === true && same(opened, [CONTROL]) && wc.getURL() === deckUrl, afterBad, httpStays, opened };
  });

  await gate('l3_files_and_plans_frames_do_not_open', async () => {
    const deckUrl = wc.getURL();
    const stayed = {};
    for (const slot of ['files', 'plans']) {
      const m = await mount(slot, linkPage([{ href: URL_A }]));
      await click(0);
      stayed[slot] = stays(m);
    }
    const afterOthers = opened.slice();
    await mount('plugin', linkPage([{ href: CONTROL }]));
    await click(0);
    return { ok: afterOthers.length === 0 && same(opened, [CONTROL]) && stayed.files && stayed.plans && wc.getURL() === deckUrl, afterOthers, opened, stayed };
  });

  await gate('l4_rate_limit', async () => {
    const m = await mount('plugin', linkPage([{ href: URL_A }, { href: URL_B }]));
    const w0 = warns.length;
    await click(0);
    await click(0);
    const afterTwo = opened.slice();
    const dropWarns = warns.length - w0;
    await sleep(OPEN_MIN_INTERVAL_MS + 100);
    await click(1);
    return { ok: same(afterTwo, [URL_A]) && dropWarns === 1 && same(opened, [URL_A, URL_B]) && stays(m), afterTwo, dropWarns, opened };
  });

  await gate('l5_fragment_scrolls_without_opening', async () => {
    const m = await mount('plugin', linkPage([{ href: '#s-cve' }, { href: CONTROL }],
      '<div id="s-cve" style="position:absolute;top:1500px;height:40px">target</div><div style="height:2200px"></div>'));
    await click(0);
    const afterFragment = opened.slice();
    const f = frames().find((x) => x.frameTreeNodeId === m.id);
    const scrollY = f ? await f.executeJavaScript('window.scrollY').catch((e) => `err ${e && e.message}`) : null;
    const url = f ? f.url : null;
    await click(1);
    return { ok: afterFragment.length === 0 && typeof scrollY === 'number' && scrollY > 0 && url === `${m.url}#s-cve` && same(opened, [CONTROL]),
      afterFragment, scrollY, url, opened };
  });

  await gate('l6_ten_enter_keydowns_open_once', async () => {
    const m = await mount('plugin', linkPage([{ href: URL_A }]));
    await clickAt(450, 500); // empty area of the frame: focus in, no link
    const beforeKeys = opened.slice();
    await key('Tab');
    await sleep(60);
    for (let i = 0; i < 10; i++) await key('Enter');
    await sleep(300);
    return { ok: beforeKeys.length === 0 && same(opened, [URL_A]) && stays(m), beforeKeys, opened };
  });

  await gate('l7_target_blank_opens_nothing', async () => {
    const m = await mount('plugin', linkPage([{ href: URL_A, target: '_blank' }, { href: CONTROL }]));
    const wins = BrowserWindow.getAllWindows().length;
    const wcs = webContents.getAllWebContents().length;
    await click(0);
    await sleep(300);
    const afterBlank = opened.slice();
    const same2 = BrowserWindow.getAllWindows().length === wins && webContents.getAllWebContents().length === wcs;
    await click(1);
    return { ok: afterBlank.length === 0 && same2 && same(opened, [CONTROL]) && stays(m), afterBlank, windowsUnchanged: same2, opened };
  });

  await gate('l8_sandbox_exactly_allow_scripts', async () => {
    const seen = {};
    for (const file of ['plugin-panel.js', 'page-frame.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', file), 'utf8');
      seen[file] = [...src.matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'/g)].map((x) => x[1]);
    }
    const ok = Object.values(seen).every((v) => v.length >= 1 && v.every((s) => s === 'allow-scripts'));
    return { ok, seen };
  });

  const xdgOpens = () => calls.filter((c) => c.file === 'xdg-open');
  const mimes = () => calls.filter((c) => c.file === 'xdg-mime');
  const dialogOf = (d) => !!d && d.message === DIALOG_MSG;
  const noLaunch = () => opened.length === 0 && calls.length === 0 && dialogs.length === 0 && nativeLaunches().length === 0;

  await gate('l9_valid_slack_link_opens_once_through_xdg_open', async () => {
    const deckUrl = wc.getURL();
    const m = await mount('plugin', linkPage([{ href: SLACK_OK }]));
    await click(0);
    await sleep(150);
    const x = xdgOpens();
    const exact = x.length === 1 && same(x[0].args, [SLACK_OK]) && !x[0].opts.shell && !('env' in x[0].opts);
    return { ok: exact && mimes().length === 1 && opened.length === 0 && dialogs.length === 0 && nativeLaunches().length === 0 && stays(m) && wc.getURL() === deckUrl,
      xdg: x, mimes: mimes().length, opened, dialogs, native: nativeLaunches(), frameStays: stays(m) };
  });

  await gate('l10_other_slack_shapes_open_nothing', async () => {
    const bad = ['slack://open', 'slack://user?team=T012ABCDE&id=U012ABCDE', 'slack://share-file?team=T012ABCDE&id=C012ABCDE',
      `${SLACK_OK}&extra=1`, 'slack://channel?team=t012abcde&id=c012abcde', 'slack:channel?team=T012ABCDE&id=C012ABCDE', `${SLACK_OK}#x`];
    const m = await mount('plugin', linkPage([...bad.map((href) => ({ href })), { href: CONTROL }]));
    for (let i = 0; i < bad.length; i++) await click(i, 150);
    const afterBad = { opened: opened.slice(), calls: calls.length, dialogs: dialogs.length };
    const quiet = noLaunch() && stays(m);
    await click(bad.length);
    return { ok: quiet && same(opened, [CONTROL]) && calls.length === 0 && dialogs.length === 0, afterBad, opened };
  });

  await gate('l11_valid_slack_link_in_files_and_plans_frames_opens_nothing', async () => {
    const stayed = {};
    for (const slot of ['files', 'plans']) {
      const m = await mount(slot, linkPage([{ href: SLACK_OK }]));
      await click(0);
      stayed[slot] = stays(m);
    }
    const quiet = noLaunch();
    await mount('plugin', linkPage([{ href: CONTROL }]));
    await click(0);
    return { ok: quiet && stayed.files && stayed.plans && same(opened, [CONTROL]) && calls.length === 0 && dialogs.length === 0,
      quiet, stayed, opened, calls: calls.length };
  });

  await gate('l12_no_handler_answer_means_no_xdg_open_and_one_dialog', async () => {
    const m = await mount('plugin', linkPage([{ href: SLACK_OK }]));
    const cases = [['empty', { out: '\n' }, 300], ['failed', { fail: 1 }, 300], ['hung', { hang: true }, 2700]];
    const seen = [];
    for (const [name, answer, settle] of cases) {
      mime = answer;
      const before = dialogs.length;
      await click(0, settle);
      seen.push({ name, newDialogs: dialogs.length - before });
      await sleep(OPEN_MIN_INTERVAL_MS + 150);
    }
    const bound = mimes().map((c) => c.opts.timeout);
    const ok = seen.every((s) => s.newDialogs === 1) && dialogs.length === 3 && dialogs.every((d) => dialogOf(d) && d.detail === DETAIL_NONE && d.type === 'warning')
      && xdgOpens().length === 0 && opened.length === 0 && bound.length === 3 && bound.every((t) => typeof t === 'number' && t > 0 && t <= 2000) && stays(m);
    return { ok, seen, dialogs, bound, xdg: xdgOpens().length, opened };
  });

  await gate('l13_xdg_open_exit_status_decides_the_dialog', async () => {
    const m = await mount('plugin', linkPage([{ href: SLACK_OK }]));
    const detailOk = (d) => dialogOf(d) && d.detail === DETAIL_FAILED && d.type === 'warning';
    openFake = { code: 3, after: 60 };
    await click(0, 400);
    const afterThree = dialogs.slice();
    await sleep(OPEN_MIN_INTERVAL_MS + 150);
    openFake = { code: 4, after: 60 };
    await click(0, 400);
    const afterFour = dialogs.slice();
    await sleep(OPEN_MIN_INTERVAL_MS + 150);
    openFake = { hang: true, lateAfter: 4200, lateCode: 5 };
    await click(0, 3400); // 3.4 s after the click: past the 3 s wait, before the late exit
    const whileRunning = dialogs.length;
    await sleep(1100); // the late exit (code 5) has fired by now: no dialog, the opening was taken as launched
    const afterLate = dialogs.length;
    const ok = afterThree.length === 1 && detailOk(afterThree[0]) && afterFour.length === 2 && detailOk(afterFour[1])
      && whileRunning === 2 && afterLate === 2 && xdgOpens().length === 3 && opened.length === 0 && stays(m);
    return { ok, afterThree: afterThree.length, afterFour: afterFour.length, whileRunning, afterLate, xdg: xdgOpens().length, opened };
  });

  await gate('l14_slack_link_within_a_second_of_an_https_opening_is_dropped', async () => {
    const m = await mount('plugin', linkPage([{ href: URL_A }, { href: SLACK_OK }]));
    const w0 = warns.length;
    await click(0);
    await click(1);
    const afterTwo = { opened: opened.slice(), calls: calls.length, dialogs: dialogs.length };
    const dropWarns = warns.length - w0;
    await sleep(OPEN_MIN_INTERVAL_MS + 100);
    await click(1);
    await sleep(150);
    return { ok: same(afterTwo.opened, [URL_A]) && afterTwo.calls === 0 && afterTwo.dialogs === 0 && dropWarns === 1
      && xdgOpens().length === 1 && same(xdgOpens()[0].args, [SLACK_OK]) && stays(m), afterTwo, dropWarns, xdg: xdgOpens().length };
  });

  await gate('l15_no_handler_answer_is_cached_either_way', async () => {
    const m = await mount('plugin', linkPage([{ href: SLACK_OK }]));
    mime = { out: '\n' };
    await click(0);
    const first = { dialogs: dialogs.length, xdg: xdgOpens().length };
    await sleep(OPEN_MIN_INTERVAL_MS + 150);
    mime = PRESENT;
    await click(0);
    await sleep(150);
    const second = { dialogs: dialogs.length, xdg: xdgOpens().length };
    await sleep(OPEN_MIN_INTERVAL_MS + 150);
    mime = { out: '\n' };
    await click(0);
    const third = { dialogs: dialogs.length, xdg: xdgOpens().length };
    return { ok: first.dialogs === 1 && first.xdg === 0 && second.dialogs === 1 && second.xdg === 1 && third.dialogs === 2 && third.xdg === 1
      && mimes().length === 3 && opened.length === 0 && stays(m), first, second, third, mimes: mimes().length };
  });

  clearTimeout(watchdog);
  const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
  console.log(failed.length === 0 ? `plugin-link-open-probe: ALL GREEN (${Object.keys(results).length}/${Object.keys(results).length})`
    : `plugin-link-open-probe: FAILED ${failed.join(', ')}`);
  app.exit(failed.length === 0 ? 0 : 1);
}
