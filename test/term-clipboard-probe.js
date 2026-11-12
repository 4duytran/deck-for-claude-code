// term-clipboard-probe.js — terminal clipboard keys, Linux Ctrl path and the macOS app-menu roles.
// On darwin main.js installs Menu.buildFromTemplate([appMenu, editMenu, windowMenu]); Cmd+C / Cmd+V then run the `copy` /
// `paste` roles (webContents.copy() / paste()) on the focused xterm helper textarea, while renderer/js/term-keys.js only
// intercepts PLAIN Ctrl. This probe pins that division of labour on BOTH terminals (the session pane and the side panel's
// terminal): the Ctrl path acts once, a role click acts once, and a Meta keydown alone writes nothing to the pty, so a
// key and a menu accelerator can never double-act. Bytes headed for a pty are observed at the IPC boundary the renderer
// uses (`pty-input` for a pane, `panel-term-input` for the panel).
// c3 (PRIMARY write) is Linux-only and c8 (a selection leaves the system clipboard alone) is darwin-only: the other
// platform prints SKIP. A role click goes through the menu item's own handler; on Linux the menu is built from the
// same template here, because main.js keeps a null menu there.
//
// Run: bash test/run.sh term-clipboard-probe   (private Xvfb, so the X selection written here is never the user's)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tclip-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'deck-status'), { recursive: true });

const SID = 'c11b0a1d-1111-4111-8111-111111111111';
fs.writeFileSync(path.join(PROJ_DIR, `${SID}.jsonl`), JSON.stringify({
  type: 'assistant', timestamp: '2026-09-21T10:00:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
}) + '\n');

const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM,
  '#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf "\\033[?2004h"\ncat >/dev/null\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';
process.env.CLAUDE_DECK_ASK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tclip-ask-'));
process.env.SHELL = '/bin/bash'; // the panel terminal's shell

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tclip-ud-')));

const { app, BrowserWindow, clipboard, ipcMain, Menu } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_DARWIN = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const WHICH = ['pane', 'panel'];

const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}
function skip(id, why) { results.push(`SKIP ${id} — ${why}`); }

async function until(fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(50);
  }
  return !!(await fn());
}

// What the renderer sent toward each pty, and every PRIMARY write, seen as extra listeners beside main's own.
const inputs = { pane: [], panel: [] };
const primary = [];
ipcMain.on('pty-input', (_e, m) => { if (m && m.paneId === 'pane-1' && typeof m.data === 'string') inputs.pane.push(m.data); });
ipcMain.on('panel-term-input', (_e, m) => { if (m && m.termId === 'pane-1' && typeof m.data === 'string') inputs.panel.push(m.data); });
ipcMain.on('primary-write', (_e, t) => { primary.push(t); });

// The menu of the platform under test: the app menu on darwin, the same template built here on Linux (main keeps null).
let menuCache = null;
function roleItem(role) {
  if (!menuCache) {
    menuCache = IS_DARWIN
      ? Menu.getApplicationMenu()
      : Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
  }
  const walk = (items) => {
    for (const it of items) {
      if (String(it.role || '').toLowerCase() === role) return it;
      if (it.submenu) { const r = walk(it.submenu.items); if (r) return r; }
    }
    return null;
  };
  return menuCache ? walk(menuCache.items) : null;
}

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  win.show(); win.focus(); wc.focus();

  const termExpr = (w) => (w === 'pane' ? `panes.get('pane-1').term` : `terminalState.entries.get('pane-1').term`);
  const key = (keyCode, modifiers) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  // Write `text` at the screen's home, select it, focus the helper textarea; the expected text is what xterm reports.
  const selectText = (w, text) => js(`(async () => {
    const t = ${termExpr(w)};
    t.clearSelection();
    await new Promise((r) => t.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(text)}, r));
    t.select(0, 0, ${text.length});
    t.focus();
    return { sel: t.getSelection(), focused: document.activeElement === t.textarea };
  })()`);
  const focusOnly = (w) => js(`(() => { const t = ${termExpr(w)}; t.clearSelection(); t.focus(); return document.activeElement === t.textarea; })()`);
  const resetSeen = () => js(`window.__metaSeen = []`);
  const metaSeen = () => js(`window.__metaSeen`);

  // --- setup: one pane terminal and the side panel's terminal of that same pane ---
  await js(`document.addEventListener('keydown', (ev) => { if (ev.metaKey) (window.__metaSeen = window.__metaSeen || []).push(ev.key); }, true)`);
  await js(`document.addEventListener('paste', (ev) => { (window.__pasteSeen = window.__pasteSeen || []).push({
    types: ev.clipboardData ? [...ev.clipboardData.types] : null,
    text: ev.clipboardData ? ev.clipboardData.getData('text/plain') : null }); }, true)`);
  await js(`openPane({ resumeId: '${SID}', title: 'term-clipboard' })`);
  await sleep(900);
  await js(`setChatView('pane-1', false)`); // a resumed pane opens on its chat view; the terminal is what is under test
  await sleep(600);
  const lay = await js(`(() => {
    const p = panes.get('pane-1'); const r = p.term.element.getBoundingClientRect(); const chain = [];
    for (let n = p.term.element; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n); const b = n.getBoundingClientRect();
      chain.push((n.id || n.className || n.tagName) + ':' + cs.display + '/' + cs.visibility + '/' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
    return { box: [r.width, r.height], mode: modeState.mode, sel: layoutState.selectedPaneId, cls: p.el.className, chain: chain.slice(0, 7) };
  })()`);
  gate('setup: pane terminal is open', await js(`panes.has('pane-1')`) && lay.box[0] > 0 && lay.box[1] > 0, JSON.stringify(lay));
  await sleep(900); // let the shell's first prompt land before any screen write

  for (const w of WHICH) {
    if (w === 'panel') {
      // Opening the side panel collapses the session grid (the pane's xterm gets a 0x0 box and cannot take focus), so
      // the pane terminal is driven first and the panel terminal second.
      await js(`openSidePanel('terminal', { paneId: 'pane-1', sessionId: '${SID}' })`);
      const live = await until(() => js(`(() => { const e = terminalState.entries.get('pane-1'); return !!e && e.status === 'live'; })()`), 8000);
      gate('setup: panel terminal is live', live, `panelLive=${live}`);
      await sleep(900);
    }
    // c1 — Ctrl+C with a selection copies to the system clipboard, no byte reaches the pty.
    {
      const s = await selectText(w, `COPYME-${w}`);
      clipboard.writeText(`OLD-${w}`);
      inputs[w].length = 0;
      key('C', ['control']);
      const ok = await until(() => clipboard.readText() === s.sel, 2500);
      await sleep(300);
      const sent = inputs[w].join('');
      gate(`c1-linux-${w}`, s.focused && ok && sent === '',
        `focused=${s.focused} clipboard=${JSON.stringify(clipboard.readText())} sel=${JSON.stringify(s.sel)} ptyBytes=${JSON.stringify(sent)}`);
    }
    // c2 — Ctrl+V pastes the clipboard text exactly once.
    {
      const text = `PASTEME-${w}`;
      const f = await focusOnly(w);
      clipboard.writeText(text);
      inputs[w].length = 0;
      key('V', ['control']);
      await until(() => inputs[w].join('').includes(text), 2500);
      await sleep(500);
      const sent = inputs[w].join('');
      const n = sent.split(text).length - 1;
      gate(`c2-linux-${w}`, f && n === 1, `focused=${f} occurrences=${n} ptyBytes=${JSON.stringify(sent)}`);
    }
    // c3 — a selection writes PRIMARY (Linux only: main ignores it elsewhere).
    if (IS_LINUX) {
      await js(`${termExpr(w)}.clearSelection()`);
      await sleep(300);
      primary.length = 0;
      const s = await selectText(w, `PRIMARY-${w}`);
      const ok = await until(() => primary.includes(s.sel), 2500);
      gate(`c3-linux-${w}`, ok, `primaryWrites=${JSON.stringify(primary)} sel=${JSON.stringify(s.sel)}`);
    } else {
      skip(`c3-linux-${w}`, 'PRIMARY is Linux-only, covered by macos-ipc-guards-probe primary-darwin-noop');
    }
    // c4 — the `copy` role puts the terminal selection on the clipboard.
    {
      const item = roleItem('copy');
      const s = await selectText(w, `ROLECOPY-${w}`);
      clipboard.writeText(`OLD-${w}`);
      inputs[w].length = 0;
      let err = null;
      try { if (item) item.click(undefined, win, wc); } catch (e) { err = String(e && e.message); }
      const ok = await until(() => clipboard.readText() === s.sel, 2500);
      gate(`c4-role-copy-${w}`, !!item && s.focused && ok && inputs[w].join('') === '',
        `item=${!!item} err=${err} focused=${s.focused} clipboard=${JSON.stringify(clipboard.readText())} sel=${JSON.stringify(s.sel)}`);
    }
    // c5 — the `paste` role delivers the clipboard text to the pty exactly once.
    {
      const item = roleItem('paste');
      const text = `ROLEPASTE-${w}`;
      const f = await focusOnly(w);
      clipboard.writeText(text);
      await sleep(200); // let the write settle before the renderer reads the clipboard
      inputs[w].length = 0;
      await js(`window.__pasteSeen = []`);
      let err = null;
      try { if (item) item.click(undefined, win, wc); } catch (e) { err = String(e && e.message); }
      await until(() => inputs[w].join('').includes(text), 2500);
      await sleep(500);
      const sent = inputs[w].join('');
      const n = sent.split(text).length - 1;
      gate(`c5-role-paste-${w}`, !!item && f && n === 1,
        `item=${!!item} err=${err} focused=${f} occurrences=${n} ptyBytes=${JSON.stringify(sent)} pasteEvents=${JSON.stringify(await js(`window.__pasteSeen`))}`);
    }
    // c6 — Meta+V keydown alone writes nothing (key and menu accelerator cannot double-paste).
    {
      const f = await focusOnly(w);
      clipboard.writeText(`METAPASTE-${w}`);
      inputs[w].length = 0;
      await resetSeen();
      key('V', ['meta']);
      await sleep(600);
      const seen = await metaSeen();
      const sent = inputs[w].join('');
      const reached = IS_LINUX ? seen.length >= 1 : true; // on darwin an accelerator may consume the key before the page
      gate(`c6-meta-v-${w}`, f && reached && sent === '', `focused=${f} metaKeydownSeen=${JSON.stringify(seen)} ptyBytes=${JSON.stringify(sent)}`);
    }
    // c7 — Meta+C keydown with a selection sends no ^C.
    {
      const s = await selectText(w, `METACOPY-${w}`);
      inputs[w].length = 0;
      await resetSeen();
      key('C', ['meta']);
      await sleep(600);
      const seen = await metaSeen();
      const sent = inputs[w].join('');
      const reached = IS_LINUX ? seen.length >= 1 : true;
      gate(`c7-meta-c-${w}`, s.focused && reached && !sent.includes('\x03') && sent === '',
        `focused=${s.focused} metaKeydownSeen=${JSON.stringify(seen)} ptyBytes=${JSON.stringify(sent)}`);
    }
    // c8 — darwin: a selection alone leaves the system clipboard unchanged.
    if (IS_DARWIN) {
      await js(`${termExpr(w)}.clearSelection()`);
      clipboard.writeText(`UNTOUCHED-${w}`);
      await selectText(w, `SELONLY-${w}`);
      await sleep(700); // well past the 150 ms copy-on-select debounce
      gate(`c8-darwin-${w}`, clipboard.readText() === `UNTOUCHED-${w}`, `clipboard=${JSON.stringify(clipboard.readText())}`);
    } else {
      skip(`c8-darwin-${w}`, 'darwin only: PRIMARY (the Linux copy-on-select target) is a separate X selection, covered by c3');
    }
  }

  console.log('\n=== term-clipboard probe ===');
  for (const r of results) console.log(r);
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  const skipped = results.filter((r) => r.startsWith('SKIP')).length;
  const line = `VERDICT: ${failed ? 'FAIL' : 'ALL GREEN'} (${passed}/${results.length - skipped}, ${skipped} skipped)`;
  console.log(`\n${line}`);
  fs.writeFileSync(path.join(__dirname, 'term-clipboard-probe.out'), results.join('\n') + `\n${line}\n`);
  app.exit(failed ? 1 : 0);
});
