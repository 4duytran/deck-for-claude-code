// test/slash-picker-probe.js — E2E probe: the « / » command picker of the chat composer (B24 lot K-c1, Amendment 20 K6).
// Real app, fake HOME holding one user skill whose description is hostile markup, a fake claude that logs every PTY byte.
//   s0  the markup exists: a hidden `.slash-pop` (role listbox) beside `.cc-mention`, the composer is enabled
//   s1  « / » at the start opens every listed command (no cap, no dedupe), /compact and the user skill among them, rows are options, first active
//   s2  « / » after other text (same line, new line, glued to a word) opens nothing
//   s3  filter by case-insensitive name prefix; no match hides the list; rows equal the IPC entries (name, args, desc)
//   s4  ↑ ↓ move (wrapping), Enter inserts `/name ` with the caret after it: nothing sent, no new user turn, queue empty
//   s5  Tab inserts and the focus stays in the composer
//   s6  a click inserts, the focus stays in the composer, nothing sent
//   s7  Esc closes and keeps the text, stays closed while the token is typed on, opens again once the composer was cleared
//   s8  a space closes (and stays closed), a token that no longer starts with « / » closes
//   s9  a hostile description renders as text: no img element in the picker
//   s10 the « @ » picker still opens, inserts on Enter, and the « / » picker stays shut meanwhile
//   s11 fast typing: an older answer never overwrites the list of the newer token
// Run: see CLAUDE.md (xvfb-run ... node_modules/.bin/electron test/slash-picker-probe.js)
// FULL ISOLATION: HOME is faked BEFORE main.js loads; the pty spawns a fake claude (cat), never the real one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slash-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace', 'slash-fixture'); // the session folder
const HOSTILE = '<img src=x onerror=alert(1)>';
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
put(path.join(WS, 'notes.md'), '# notes\n');
put(path.join(FAKE_HOME, '.claude', 'skills', 'zz-hostile', 'SKILL.md'),
  `---\nname: zz-hostile\ndescription: ${HOSTILE}\nargument-hint: [x]\n---\nbody\n`);
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });

const PTY_LOG = path.join(FAKE_HOME, 'pty-input.log');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN,
  `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf '\\033[?2004h'\nexec cat >> "${PTY_LOG}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const SID = '66666666-aaaa-4bbb-8ccc-666666666666';
const TS = '2026-10-28T10:00:00.000Z';
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(PROJ_DIR, `${SID}.jsonl`), [
  J({ type: 'user', cwd: WS, timestamp: TS, message: { role: 'user', content: 'Bonjour' } }),
  J({ type: 'assistant', timestamp: TS, message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'Salut.' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 } } }),
].join(''));
fs.writeFileSync(path.join(STATUS_DIR, `${SID}.json`), JSON.stringify({ status: 'idle', event: 'probe', ts: TS }) + '\n');

const { app, BrowserWindow } = require('electron');
require(path.join(__dirname, '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slash-ud-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function gate(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 90s'); app.exit(2); }, 90000);
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    const PANE = `panes.get('pane-1').el`;
    const INPUT = `${PANE}.querySelector('.chat-input')`;
    const POP = `${PANE}.querySelector('.slash-pop')`;
    const rowsCode = `(() => { const p = ${POP}; if (!p || p.hidden) return [];
      const t = (r, s) => { const e = r.querySelector(s); return e ? e.textContent : null; };
      return [...p.querySelectorAll('.sp-item')].map((r) => ({ name: t(r, '.sp-name'), args: t(r, '.sp-args'),
        desc: t(r, '.sp-desc'), sel: r.getAttribute('aria-selected'), role: r.getAttribute('role') })); })()`;
    const rows = () => js(rowsCode);
    const waitRows = async (pred, ms = 2500) => {
      const end = Date.now() + ms;
      let v = [];
      while (Date.now() < end) { v = await rows(); if (pred(v)) return v; await sleep(80); }
      return v;
    };
    const composer = () => js(`${INPUT}.value`);
    const reset = async () => {
      await js(`(() => { const i = ${INPUT}; i.value = ''; i.focus(); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    const ptySent = () => { try { return fs.readFileSync(PTY_LOG, 'utf8'); } catch (_) { return ''; } };
    const key = (keyCode, modifiers) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const state = () => js(`(() => { const c = panes.get('pane-1').chat; const s = getSelection();
      return { users: ${PANE}.querySelectorAll('.chat-user').length, queue: c.queue.length,
        warn: !c.slashWarnEl.hidden, focused: document.activeElement === ${INPUT},
        caretAtEnd: !!(s.isCollapsed && s.anchorNode && s.anchorNode.nodeType === 3 && ${INPUT}.contains(s.anchorNode)
          && s.anchorOffset === s.anchorNode.data.length) }; })()`);
    const names = (r) => r.map((x) => x.name);

    win.focus();
    await js(`openPane({ resumeId: '${SID}', cwd: ${JSON.stringify(WS)}, title: 'slash-fixture' })`);
    await sleep(800);
    await js(`setChatView('pane-1', true)`);
    await sleep(1500);

    const list = await js(`window.api.commandsList('pane-1')`);
    const listRows = (prefix) => list.filter((e) => e.name.toLowerCase().startsWith(prefix))
      .map((e) => JSON.stringify([e.name, e.args, e.desc]));
    const rowsKey = (r) => r.map((x) => JSON.stringify([x.name, x.args, x.desc]));

    // s0 — markup
    const markup = await js(`(() => { const p = ${POP}; const m = ${PANE}.querySelector('.cc-mention');
      return { pop: !!p, hidden: !!p && p.hidden, role: p && p.getAttribute('role'), beside: !!p && !!m && p.parentNode === m.parentNode,
        disabled: ${INPUT}.disabled }; })()`);
    gate('s0 hidden .slash-pop (listbox) beside .cc-mention, composer enabled',
      markup.pop && markup.hidden && markup.role === 'listbox' && markup.beside && !markup.disabled
        && Array.isArray(list) && list.some((e) => e.name === '/compact') && list.some((e) => e.name === '/zz-hostile'),
      JSON.stringify({ ...markup, listLen: Array.isArray(list) ? list.length : list }));

    // s1 — « / » at the start
    await reset();
    wc.insertText('/');
    const r1 = await waitRows((r) => r.length > 0);
    const m1 = await js(`(() => { const m = ${PANE}.querySelector('.cc-mention'); return m ? m.hidden : null; })()`);
    gate('s1 « / » at the start opens every listed command, first row active',
      r1.length === list.length && r1.length >= 10 && names(r1).includes('/compact') && names(r1).includes('/zz-hostile')
        && r1.every((r) => r.role === 'option') && r1[0].sel === 'true' && r1.slice(1).every((r) => r.sel === 'false') && m1 === true,
      JSON.stringify({ rows: r1.length, list: list.length, first: r1[0], mentionHidden: m1 }));

    // s2 — « / » after other text
    await reset();
    wc.insertText('hello ');
    wc.insertText('/');
    await sleep(500);
    const r2a = await rows();
    await reset();
    wc.insertText('hello');
    key('Enter', ['shift']);
    await sleep(150);
    wc.insertText('/');
    await sleep(500);
    const r2b = await rows();
    await reset();
    wc.insertText('a/');
    await sleep(500);
    const r2c = await rows();
    gate('s2 « / » after text opens nothing', r2a.length === 0 && r2b.length === 0 && r2c.length === 0,
      JSON.stringify({ sameLine: r2a.length, newLine: r2b.length, glued: r2c.length }));

    // s3 — filter
    await reset();
    wc.insertText('/');
    await waitRows((r) => r.length > 0);
    wc.insertText('comp');
    const r3 = await waitRows((r) => r.length > 0 && r.length < list.length);
    await sleep(250);
    const r3b = await rows();
    await reset();
    wc.insertText('/COMP');
    const r3u = await waitRows((r) => r.length > 0 && r.length < list.length);
    await reset();
    wc.insertText('/zzzqqq');
    await sleep(600);
    const r3n = await rows();
    const popHidden = await js(`(() => { const p = ${POP}; return !p || p.hidden; })()`);
    gate('s3 prefix filter (case-insensitive), rows = IPC entries, no match hides',
      r3b.length > 0 && names(r3b).every((n) => n.toLowerCase().startsWith('/comp')) && names(r3b).includes('/compact')
        && JSON.stringify(rowsKey(r3b)) === JSON.stringify(listRows('/comp'))
        && JSON.stringify(rowsKey(r3u)) === JSON.stringify(listRows('/comp'))
        && r3n.length === 0 && popHidden,
      JSON.stringify({ typed: r3.length, settled: names(r3b), upper: r3u.length, expected: listRows('/comp').length, noMatch: r3n.length, popHidden }));

    // s4 — arrows wrap, Enter inserts without sending
    await reset();
    wc.insertText('/c');
    const r4 = await waitRows((r) => r.length >= 2);
    const sentBefore = ptySent();
    const before = await state();
    const selIdx = async () => (await rows()).findIndex((r) => r.sel === 'true');
    const trail = [await selIdx()];
    for (const k of ['Down', 'Up', 'Up', 'Down', 'Down']) { key(k); await sleep(150); trail.push(await selIdx()); }
    const last = r4.length - 1;
    key('Enter');
    await sleep(500);
    const v4 = await composer();
    const r4after = await rows();
    const after = await state();
    gate('s4 ↑ ↓ wrap, Enter inserts `/name ` and sends nothing',
      r4.length >= 2 && JSON.stringify(trail) === JSON.stringify([0, 1, 0, last, 0, 1])
        && v4 === `${(r4[1] || {}).name} ` && r4after.length === 0 && ptySent() === sentBefore
        && after.users === before.users && after.queue === 0 && !after.warn && after.caretAtEnd,
      JSON.stringify({ rows: r4.length, trail, expected: `${(r4[1] || {}).name} `, value: v4, listAfter: r4after.length,
        ptyChanged: ptySent() !== sentBefore, users: [before.users, after.users], queue: after.queue, warn: after.warn, caretAtEnd: after.caretAtEnd }));

    // s5 — Tab
    await reset();
    wc.insertText('/zz-h');
    const r5 = await waitRows((r) => r.length === 1);
    key('Tab');
    await sleep(400);
    const v5 = await composer();
    const st5 = await state();
    gate('s5 Tab inserts `/name `, the focus stays in the composer',
      r5.length === 1 && r5[0].name === '/zz-hostile' && v5 === '/zz-hostile ' && st5.focused && st5.caretAtEnd && ptySent() === sentBefore,
      JSON.stringify({ rows: names(r5), value: v5, focused: st5.focused, caretAtEnd: st5.caretAtEnd }));

    // s6 — click
    await reset();
    wc.insertText('/comp');
    await waitRows((r) => r.length > 0);
    await sleep(200);
    const box = await js(`(() => { const row = [...${POP}.querySelectorAll('.sp-item')]
      .find((r) => r.querySelector('.sp-name').textContent === '/compact');
      if (!row) return null; const r = row.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (box) {
      wc.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
      wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(500);
    }
    const v6 = await composer();
    const st6 = await state();
    const r6 = await rows();
    gate('s6 a click inserts `/name `, the focus stays, nothing sent',
      !!box && v6 === '/compact ' && st6.focused && st6.caretAtEnd && r6.length === 0 && ptySent() === sentBefore && st6.queue === 0,
      JSON.stringify({ row: !!box, value: v6, focused: st6.focused, caretAtEnd: st6.caretAtEnd, listAfter: r6.length }));

    // s7 — Esc
    await reset();
    wc.insertText('/comp');
    await waitRows((r) => r.length > 0);
    key('Escape');
    await sleep(300);
    const r7a = await rows();
    const v7a = await composer();
    wc.insertText('a');
    await sleep(500);
    const r7b = await rows();
    const v7b = await composer();
    await reset();
    wc.insertText('/');
    const r7c = await waitRows((r) => r.length > 0);
    gate('s7 Esc closes and keeps the text, stays closed while typing on, reopens after a clear',
      r7a.length === 0 && v7a === '/comp' && r7b.length === 0 && v7b === '/compa' && r7c.length > 0 && ptySent() === sentBefore,
      JSON.stringify({ afterEsc: r7a.length, value: v7a, typedOn: r7b.length, value2: v7b, reopened: r7c.length, ptyChanged: ptySent() !== sentBefore }));

    // s8 — space and non-slash token close
    await reset();
    wc.insertText('/comp');
    const r8open = await waitRows((r) => r.length > 0);
    wc.insertText(' ');
    await sleep(500);
    const r8a = await rows();
    wc.insertText('x');
    await sleep(400);
    const r8b = await rows();
    await reset();
    wc.insertText('/c');
    await waitRows((r) => r.length > 0);
    key('Home');
    await sleep(150);
    wc.insertText('x');
    await sleep(500);
    const r8c = await rows();
    gate('s8 a space closes (and stays closed), a token without « / » closes',
      r8open.length > 0 && r8a.length === 0 && r8b.length === 0 && r8c.length === 0,
      JSON.stringify({ open: r8open.length, afterSpace: r8a.length, typedOn: r8b.length, notSlash: r8c.length }));

    // s9 — hostile description
    await reset();
    wc.insertText('/zz-h');
    const r9 = await waitRows((r) => r.length === 1);
    const dom9 = await js(`(() => { const p = ${POP};
      return { img: p.querySelectorAll('img').length, bad: p.querySelectorAll('img,script,iframe,object,embed,link,style').length,
        html: p.innerHTML.includes('<img'), desc: (p.querySelector('.sp-desc') || {}).textContent }; })()`);
    gate('s9 hostile description renders as text, no img element',
      r9.length === 1 && dom9.img === 0 && dom9.bad === 0 && !dom9.html && dom9.desc === HOSTILE && r9[0].args === '[x]',
      JSON.stringify({ rows: r9.length, ...dom9, args: r9[0] && r9[0].args }));

    // s10 — « @ » still works, « / » shut
    await reset();
    wc.insertText('@');
    const end10 = Date.now() + 2500;
    let at = 0;
    while (Date.now() < end10 && !at) {
      at = await js(`${PANE}.querySelectorAll('.cc-mention:not([hidden]) .cm-item').length`);
      if (!at) await sleep(80);
    }
    const slashDuring = await rows();
    key('Enter');
    await sleep(500);
    const v10 = await composer();
    gate('s10 « @ » picker still opens and inserts on Enter, « / » stays shut',
      at > 0 && slashDuring.length === 0 && v10.startsWith('@') && v10 !== '@' && ptySent() === sentBefore,
      JSON.stringify({ mentionRows: at, slashRows: slashDuring.length, value: v10 }));

    // s11 — fast typing, stale answer
    await reset();
    wc.insertText('/');
    wc.insertText('comp');
    await sleep(900);
    const r11 = await rows();
    gate('s11 fast typing: the list is the one of the last token',
      r11.length > 0 && names(r11).every((n) => n.toLowerCase().startsWith('/comp')) && JSON.stringify(rowsKey(r11)) === JSON.stringify(listRows('/comp')),
      JSON.stringify({ rows: names(r11) }));
  } catch (e) {
    gate('probe ran to the end', false, String(e && e.stack || e));
  }
  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length
    ? `VERDICT: ${failed.length} FAILED (${failed.map((r) => r.id.split(' ')[0]).join(', ')})`
    : `VERDICT: ALL GREEN (${results.length}/${results.length})`);
  app.exit(failed.length ? 1 : 0);
});
