'use strict';
// Probe: plugin-slot serving of the deckpage: scheme (contract C12): meta neutralised, theme attribute,
// script-free response header, files / plans slots served with the selection relay (header unchanged), slotOfUrl.
// Run under xvfb with the plan's electron prefix; every gate prints PASS / FAIL, exit 1 on any FAIL.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, net } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/main/page-scheme.js');
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'";
const PLUGIN_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'";
const NOPE = 'deckpage://page/nope';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-serve-')));
const ps = require(SRC);
ps.registerPageScheme();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let win = null;

async function gate(name, fn) {
  let verdict;
  try { verdict = await fn(); } catch (e) { verdict = `threw ${e && e.message}`; }
  const ok = verdict === null;
  results.push(ok);
  console.log(ok ? `PASS ${name}` : `FAIL ${name}: ${verdict}`);
}

const frame = () => win.webContents.mainFrame.frames[0];
const evalParent = (code) => win.webContents.executeJavaScript(code);
const msgs = async (type) => (await evalParent('JSON.parse(JSON.stringify(window.__msgs))')).filter((m) => m.data && m.data.type === type);

async function until(cond, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v || Date.now() > end) return v;
    await wait(50);
  }
}

async function served(url) {
  const res = await net.fetch(url);
  return { status: res.status, body: await res.text(), csp: res.headers.get('content-security-policy') };
}

// Puts a page, fetches what the handler answers and loads it in the sandboxed frame (waits for the frame load event).
async function putFetchLoad(slot, html, opts) {
  const r = ps.putPage(slot, html, opts);
  if (!r.ok) throw new Error(`putPage ${r.error}`);
  const res = await served(r.url);
  await evalParent(`window.__load(${JSON.stringify(r.url)})`);
  if (!(await until(async () => (await evalParent('window.__loads')) >= 1, 4000))) throw new Error('frame load event never fired');
  return { url: r.url, ...res };
}

const metaCount = (html) => evalParent(`new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html').querySelectorAll('meta').length`);
const doc = (head) => `<!doctype html><html><head>${head}<title>t</title></head><body><p>b</p></body></html>`;
const refreshPage = doc(`<meta http-equiv="refresh" content="0;url=${NOPE}">`);
const scriptPage = '<!doctype html><html lang="fr"><head><title>s</title></head><body><script>parent.postMessage({type:"probe-loaded"},"*");</script></body></html>';

async function main() {
  ps.startPageProtocol();
  win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  const parentFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-serve-parent-')), 'parent.html');
  fs.writeFileSync(parentFile, '<!doctype html><meta charset="utf-8"><body><iframe id="f" sandbox="allow-scripts" style="width:600px;height:400px" '
    + 'onload="window.__loads=(window.__loads||0)+1"></iframe><script>'
    + 'window.__msgs=[];window.__loads=0;'
    + 'addEventListener("message",function(e){window.__msgs.push({data:e.data});});'
    + 'window.__load=function(u){window.__msgs.length=0;window.__loads=0;document.getElementById("f").src=u;};'
    + '</script></body>');
  await win.loadFile(parentFile);

  await gate('s1_no_meta_left_on_8_spellings', async () => {
    const T = `url=${NOPE}`;
    const spellings = {
      quoted: `<meta http-equiv="refresh" content="0;${T}">`,
      unquoted: `<meta http-equiv=refresh content=0;${T}>`,
      uppercase: `<META HTTP-EQUIV="REFRESH" CONTENT="0;${T.toUpperCase()}">`,
      slash: `<meta/http-equiv="refresh"/content="0;${T}">`,
      newline: `<meta\nhttp-equiv="refresh"\ncontent="0;${T}">`,
      gt_in_value_first: `<meta content="a>b" http-equiv="refresh" data-x="0;${T}">`,
      entity: `<meta http-equiv="re&#102;resh" content="0;${T}">`,
      lone_quote: `<meta http-equiv=refresh content=0;${T}"y>`,
    };
    const bad = [];
    for (const [name, tag] of Object.entries(spellings)) {
      const input = doc(tag);
      if ((await metaCount(input)) < 1) { bad.push(`${name}: instrument sees no meta in the input`); continue; }
      const out = ps.neutralizeMeta(input);
      const left = await metaCount(out);
      if (left !== 0 || /<meta/i.test(out)) bad.push(`${name}: ${left} meta element(s) left`);
      else if (out.split('<link data-deck-meta').length !== 2) bad.push(`${name}: not exactly one inert opener`);
    }
    return bad.length ? bad.join('; ') : null;
  });

  await gate('s2_refresh_keeps_frame_url', async () => {
    const control = await putFetchLoad('files', refreshPage);
    await wait(1500);
    if (frame().url === control.url) return 'instrument: a raw refresh page did not navigate the frame';
    const r = await putFetchLoad('plugin', refreshPage);
    await wait(1500);
    const loads = await evalParent('window.__loads');
    return frame().url === r.url && loads === 1 ? null : `frame url ${frame().url}, loads ${loads}`;
  });

  await gate('s3_plugin_header_blocks_script', async () => {
    const r = await putFetchLoad('plugin', scriptPage);
    if (r.csp !== PLUGIN_CSP) return `plugin header: ${r.csp}`;
    await wait(1000);
    if ((await msgs('probe-loaded')).length) return 'the inline script ran in the plugin slot';
    const f = await putFetchLoad('files', scriptPage);
    if (f.csp !== PAGE_CSP) return `files header: ${f.csp}`;
    const ran = await until(async () => (await msgs('probe-loaded')).length > 0, 4000);
    return ran ? null : 'instrument: the inline script did not run in the files slot';
  });

  await gate('s4_with_theme_cases', async () => {
    const cases = [
      ['attr in html tag', '<!doctype html><html lang="fr"><head></head></html>', 'dark', '<!doctype html><html data-deck-theme="dark" lang="fr"><head></head></html>'],
      ['uppercase tag', '<!DOCTYPE html>\n<HTML><body>x</body></HTML>', 'light', '<!DOCTYPE html>\n<HTML data-deck-theme="light"><body>x</body></HTML>'],
      ['no html tag, doctype', '<!doctype html><p>x</p>', 'dark', '<!doctype html><html data-deck-theme="dark"><p>x</p>'],
      ['no html tag, no doctype', '<p>x</p>', 'light', '<html data-deck-theme="light"><p>x</p>'],
      ['first html tag only', '<!doctype html><html><body><html lang="x"></body></html>', 'dark', '<!doctype html><html data-deck-theme="dark"><body><html lang="x"></body></html>'],
      ['htmlx is not an html tag', '<!doctype html><htmlx><p>x</p>', 'dark', '<!doctype html><html data-deck-theme="dark"><htmlx><p>x</p>'],
      ['unknown theme falls back to light', '<html><body>x</body></html>', 'x"onload="1', '<html data-deck-theme="light"><body>x</body></html>'],
    ];
    const bad = [];
    for (const [name, input, theme, want] of cases) {
      const got = ps.withTheme(input, theme);
      if (got !== want) bad.push(`${name}: ${JSON.stringify(got)}`);
    }
    return bad.length ? bad.join('; ') : null;
  });

  await gate('s4_served_dataset_theme', async () => {
    const page = doc('<meta name="viewport" content="width=device-width">').replace('<html>', '<html lang="fr">');
    const plugin = await putFetchLoad('plugin', page);
    if (/<meta/i.test(plugin.body)) return 'a meta survives in the served plugin body';
    const t = await frame().executeJavaScript('document.documentElement.dataset.deckTheme');
    if (t !== 'dark') return `dataset.deckTheme of the plugin slot: ${t}`;
    const files = await putFetchLoad('files', page);
    const f = await frame().executeJavaScript('String(document.documentElement.dataset.deckTheme)');
    return files.body === ps.withSelectRelay(page) && f === 'undefined' ? null : `files slot: body relayed ${files.body === ps.withSelectRelay(page)}, theme ${f}`;
  });

  // s7: the prolog items the parser skips before a doctype (an XML declaration, a `--!>` comment) do not hide it:
  // the theme goes into the first <html after the doctype, and a page with no <html tag gets its new one AFTER the doctype.
  await gate('s7_with_theme_xml_prolog_doctype', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    const dt = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">';
    const attr = (t) => ` data-deck-theme="${t}"`;
    // A new <html> opens right at the doctype end, so the line break after the doctype follows it.
    const cases = [
      ['xml prolog, doctype, html tag', `${xml}${dt}\n<html lang="fr"><body>x</body></html>`, 'dark', `${xml}${dt}\n<html${attr('dark')} lang="fr"><body>x</body></html>`],
      ['xml prolog, doctype, no html tag', `${xml}${dt}\n<p>x</p>`, 'dark', `${xml}${dt}<html${attr('dark')}>\n<p>x</p>`],
      ['html text in a comment before the doctype', `${xml}<!-- <html lang="old"> -->${dt}\n<html lang="fr"><body>x</body></html>`, 'light', `${xml}<!-- <html lang="old"> -->${dt}\n<html${attr('light')} lang="fr"><body>x</body></html>`],
      ['bang comment, doctype, no html tag', '<!--x--!><!doctype html><p>x</p>', 'light', `<!--x--!><!doctype html><html${attr('light')}><p>x</p>`],
    ];
    const bad = [];
    for (const [name, input, theme, want] of cases) {
      const got = ps.withTheme(input, theme);
      if (got !== want) bad.push(`${name}: ${JSON.stringify(got)}`);
    }
    if (bad.length) return bad.join('; ');
    // In the real frame: standards mode kept (the doctype is not displaced) and the attribute landed on <html.
    await putFetchLoad('plugin', `${xml}${dt}\n<body><p>x</p></body>`, { theme: 'dark' });
    const seen = await frame().executeJavaScript('document.compatMode + "|" + document.documentElement.dataset.deckTheme');
    return seen === 'CSS1Compat|dark' ? null : `frame reports ${seen}, expected CSS1Compat|dark`;
  });

  await gate('s5_files_plans_unchanged', async () => {
    const src = fs.readFileSync(SRC, 'utf8');
    if (!src.includes(`const PAGE_CSP = "${PAGE_CSP}";`)) return 'PAGE_CSP literal differs from the baseline';
    const page = doc('<meta name="x" content="y">');
    const files = await putFetchLoad('files', page);
    if (files.body !== ps.withSelectRelay(page) || files.csp !== PAGE_CSP) return `files: body relay ${files.body === ps.withSelectRelay(page)}, header ${files.csp}`;
    const plans = await putFetchLoad('plans', page);
    if (plans.body !== ps.withSelectRelay(page) || plans.csp !== PAGE_CSP) return `plans: body relay ${plans.body === ps.withSelectRelay(page)}, header ${plans.csp}`;
    return null;
  });

  await gate('s6_slot_of_url', async () => {
    const a = ps.putPage('plugin', '<p>a</p>');
    const f = ps.putPage('files', '<p>f</p>');
    const p = ps.putPage('plans', '<p>p</p>');
    const got = [ps.slotOfUrl(a.url), ps.slotOfUrl(f.url), ps.slotOfUrl(p.url)].join();
    if (got !== 'plugin,files,plans') return `live urls: ${got}`;
    const b = ps.putPage('plugin', '<p>b</p>');
    const token = a.url.split('/').pop();
    const nulls = [a.url, `${a.url}?x=1#h`, 'deckpage://page/nope', 'deckpage://other/' + token, `https://page/${b.url.split('/').pop()}`, 'not a url', '', undefined, null, 42];
    const wrong = nulls.map((u) => [u, ps.slotOfUrl(u)]).filter(([u, s], i) => (i === 1 ? s !== null : s !== null));
    if (wrong.length) return `expected null for ${JSON.stringify(wrong)}`;
    return ps.slotOfUrl(b.url) === 'plugin' ? null : 'the replacing token is not found';
  });

  const failed = results.filter((ok) => !ok).length;
  console.log(`RESULT ${results.length - failed}/${results.length} passed`);
  console.log(failed ? `VERDICT: ${failed} FAILED` : 'VERDICT: ALL GREEN');
  app.exit(failed ? 1 : 0);
}

setTimeout(() => { console.log('FAIL probe-timeout'); app.exit(2); }, 90000).unref();
app.whenReady().then(main).catch((e) => { console.log(`FAIL probe-crash: ${e && e.stack}`); app.exit(2); });
