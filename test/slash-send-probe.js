// test/slash-send-probe.js — E2E probe: the chat composer SENDS listed slash commands (B24 lot K-c2, Amendment 20 K7).
// Real app, fake HOME holding one user skill (zz-hostile), a fake claude that logs every PTY byte (bracketed paste on).
//   k0  fixture sanity: the IPC list holds the commands under test, and not /config
//   k1  a listed generic command (/recap), typed by hand, at rest: ONE bracketed write `/recap` + CR, composer cleared, no banner
//   k2  pick + Enter: the picker inserts `/zz-hostile `, the next Enter sends it (the user skill is sent)
//   k3  hand-typed /compact takes the startCompact path (busy state, stop button, PTY `/compact`); `/compact <text>` passes the text
//   k4  /clear takes the startClear path (debounce flag set, PTY `/clear`)
//   k5  /goal <x> -> PTY `/goal <x>`;   k6 /goal clear -> endGoal (the goal footer state ends)
//   k7  /model <name> takes the sendModel path (pending flag + PTY `/model <name>`);   k8 bare /model -> banner, no PTY write
//   k9  hidden /config, unknown /foo and /etc/hosts -> « n'est pas disponible en mode chat », no PTY write, text kept
//   k10 a hostile first token stays text in the banner
//   k11 busy session / open menu -> « Attends la fin du tour », no PTY write, nothing queued, text kept
//   k12 a double Enter sends once
//   k13 control: a normal message and a « / » in the middle of a message are NOT commands
//   k14 a user skill with arguments is sent whole
// Run: see CLAUDE.md (xvfb-run ... node_modules/.bin/electron test/slash-send-probe.js)
// FULL ISOLATION: HOME is faked BEFORE main.js loads; the pty spawns a fake claude (cat), never the real one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slashsend-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace', 'slashsend-fixture');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
put(path.join(WS, 'notes.md'), '# notes\n');
put(path.join(FAKE_HOME, '.claude', 'skills', 'zz-hostile', 'SKILL.md'),
  '---\nname: zz-hostile\ndescription: a user skill\nargument-hint: [x]\n---\nbody\n');
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
const setStatus = (sid, status) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: new Date().toISOString() }) + '\n');

const PTY_LOG = path.join(FAKE_HOME, 'pty-input.log');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN,
  `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf '\\033[?2004h'\nexec cat >> "${PTY_LOG}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const SID = '77777777-aaaa-4bbb-8ccc-777777777777';
const TS = '2026-10-28T10:00:00.000Z';
const J = (o) => JSON.stringify(o) + '\n';
const FIXTURE = path.join(PROJ_DIR, `${SID}.jsonl`);
fs.writeFileSync(FIXTURE, [
  J({ type: 'user', cwd: WS, timestamp: TS, message: { role: 'user', content: 'Bonjour' } }),
  J({ type: 'assistant', timestamp: TS, message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'Salut.' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 } } }),
].join(''));
setStatus(SID, 'idle');

const { app, BrowserWindow } = require('electron');
require(path.join(__dirname, '..', 'main.js'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slashsend-ud-')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function gate(id, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}
const BR = (text) => `\x1b[200~${text}\x1b[201~\r`; // one bracketed paste + CR, the shape of submitPasted

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 120s'); app.exit(2); }, 120000);
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    const PANE = `panes.get('pane-1').el`;
    const INPUT = `${PANE}.querySelector('.chat-input')`;
    const POP = `${PANE}.querySelector('.slash-pop')`;
    const ptyText = () => { try { return fs.readFileSync(PTY_LOG, 'latin1'); } catch (_) { return ''; } };
    const key = (keyCode, modifiers) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const st = () => js(`(() => { const p = panes.get('pane-1'); const c = p.chat; const w = c.slashWarnEl;
      return { value: c.inputEl.value, warn: !w.hidden, warnText: w.textContent, warnKids: w.children.length,
        queue: c.queue.length, pending: c.pendingSends.length, compacting: !!c.compacting, clearing: !!c.clearing,
        goalArmed: !!c.goalArmed, goalActive: !!c.goalActive, modelPending: typeof c.modelPendingFromId === 'string',
        isStop: p.el.querySelector('.chat-send').classList.contains('is-stop'), status: c.lastStatus }; })()`);
    // back to rest: no banner, empty composer, idle, nothing compacting / clearing, picker shut
    const toRest = async () => {
      setStatus(SID, 'idle');
      const end = Date.now() + 4000;
      let s;
      while (Date.now() < end) {
        s = await st();
        if (s.status === 'idle' && !s.compacting && !s.clearing) break;
        await sleep(100);
      }
      await js(`(() => { const c = panes.get('pane-1').chat; clearTimeout(c.slashWarnId); c.slashWarnEl.hidden = true;
        c.slashWarnEl.classList.remove('show'); c.slashWarnEl.textContent = ''; c.inputEl.value = '';
        c.inputEl.focus(); c.inputEl.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);
    };
    // set the composer and fire Enter at the element (no input event: the pickers stay shut), then let the async send settle
    const sendText = async (text, settle = 500) => {
      await js(`(() => { const i = ${INPUT}; i.value = ${JSON.stringify(text)};
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await sleep(settle);
    };
    const count = (hay, needle) => hay.split(needle).length - 1;

    win.focus();
    await js(`openPane({ resumeId: '${SID}', cwd: ${JSON.stringify(WS)}, title: 'slashsend-fixture' })`);
    await sleep(800);
    await js(`setChatView('pane-1', true)`);
    await sleep(1500);
    setStatus(SID, 'idle');
    await sleep(500);

    // k0 — fixture sanity
    const list = await js(`window.api.commandsList('pane-1')`);
    const have = (n) => Array.isArray(list) && list.some((e) => e.name === n);
    gate('k0 the IPC list holds the commands under test, not /config',
      ['/recap', '/compact', '/clear', '/goal', '/model', '/zz-hostile'].every(have) && !have('/config'),
      JSON.stringify({ len: Array.isArray(list) ? list.length : list, config: have('/config') }));

    // k1 — generic listed command typed by hand, at rest
    await toRest();
    let before = ptyText().length;
    wc.insertText('/recap ');
    await sleep(200);
    key('Enter');
    await sleep(700);
    let d = ptyText().slice(before);
    let s = await st();
    gate('k1 /recap at rest: one bracketed write `/recap` + CR, composer cleared, no banner, nothing queued',
      d === BR('/recap') && s.value === '' && !s.warn && s.queue === 0 && !s.compacting,
      JSON.stringify({ pty: d, ...s }));

    // k2 — pick + Enter
    await toRest();
    before = ptyText().length;
    wc.insertText('/zz-h');
    const end2 = Date.now() + 2500;
    let rows2 = 0;
    while (Date.now() < end2 && rows2 !== 1) {
      rows2 = await js(`(() => { const p = ${POP}; return p && !p.hidden ? p.querySelectorAll('.sp-item').length : 0; })()`);
      if (rows2 !== 1) await sleep(80);
    }
    key('Enter');
    await sleep(500);
    const picked = await st();
    const afterPick = ptyText().slice(before);
    key('Enter');
    await sleep(700);
    d = ptyText().slice(before);
    s = await st();
    gate('k2 pick inserts `/zz-hostile ` and sends nothing; the next Enter sends the picked user skill',
      rows2 === 1 && picked.value === '/zz-hostile ' && afterPick === '' && d === BR('/zz-hostile') && s.value === '' && !s.warn,
      JSON.stringify({ rows: rows2, picked: picked.value, afterPick, pty: d, value: s.value, warn: s.warn }));

    // k3 — /compact
    await toRest();
    before = ptyText().length;
    await sendText('/compact', 600);
    d = ptyText().slice(before);
    s = await st();
    gate('k3 hand-typed /compact -> startCompact path (compacting, stop button) and PTY `/compact`',
      s.compacting && s.isStop && d === BR('/compact') && s.value === '' && !s.warn,
      JSON.stringify({ pty: d, ...s }));
    fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary', sessionId: SID, timestamp: TS, content: '',
      compactMetadata: { trigger: 'manual' } }));
    await toRest();
    before = ptyText().length;
    await sendText('/compact keep the tests', 600);
    d = ptyText().slice(before);
    s = await st();
    gate('k3b `/compact <instructions>` passes the instructions through and starts the compaction',
      s.compacting && d === BR('/compact keep the tests') && s.value === '',
      JSON.stringify({ pty: d, compacting: s.compacting, value: s.value }));
    fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary', sessionId: SID, timestamp: TS, content: '',
      compactMetadata: { trigger: 'manual' } }));

    // k4 — /clear
    await toRest();
    before = ptyText().length;
    await sendText('/clear', 300);
    d = ptyText().slice(before);
    s = await st();
    gate('k4 /clear -> startClear path (debounce flag set) and PTY `/clear`',
      s.clearing && d === BR('/clear') && s.value === '' && !s.warn,
      JSON.stringify({ pty: d, clearing: s.clearing, value: s.value, warn: s.warn }));
    await sleep(1200); // CLEAR_GUARD_MS

    // k5 — /goal <x>
    await toRest();
    before = ptyText().length;
    await sendText('/goal ship it', 600);
    d = ptyText().slice(before);
    s = await st();
    gate('k5 /goal <x> -> PTY `/goal <x>`, composer cleared, goal mode disarmed',
      d === BR('/goal ship it') && s.value === '' && !s.goalArmed && !s.warn,
      JSON.stringify({ pty: d, ...s }));

    // k6 — /goal clear
    await toRest();
    await js(`(() => { const c = panes.get('pane-1').chat; c.goalActive = true; c.goalText = 'x'; c.goalSince = Date.now(); })()`);
    before = ptyText().length;
    await sendText('/goal clear', 600);
    d = ptyText().slice(before);
    s = await st();
    gate('k6 /goal clear -> endGoal (goal state ends) and PTY `/goal clear`',
      d === BR('/goal clear') && !s.goalActive && s.value === '' && !s.warn,
      JSON.stringify({ pty: d, goalActive: s.goalActive, value: s.value, warn: s.warn }));

    // k7 — /model <name>
    await toRest();
    before = ptyText().length;
    await sendText('/model sonnet', 400);
    d = ptyText().slice(before);
    s = await st();
    gate('k7 /model <name> -> sendModel path (pending flag) and PTY `/model <name>`',
      d === BR('/model sonnet') && s.modelPending && s.value === '' && !s.warn,
      JSON.stringify({ pty: d, modelPending: s.modelPending, value: s.value, warn: s.warn }));
    await js(`(() => { const c = panes.get('pane-1').chat; c.modelPendingFromId = null; clearTimeout(c.modelPendingTimer); })()`);

    // k8 — bare /model
    await toRest();
    before = ptyText().length;
    await sendText('/model', 500);
    d = ptyText().slice(before);
    s = await st();
    gate('k8 bare /model -> banner pointing at the menu, no PTY write, text kept',
      d === '' && s.warn && s.warnText.includes('/model') && s.warnText.includes('menu du composeur') && s.value === '/model' && !s.modelPending,
      JSON.stringify({ pty: d, warn: s.warn, text: s.warnText, value: s.value }));

    // k9 — hidden and unknown
    const notAvail = [];
    for (const text of ['/config', '/foo', "/etc/hosts a besoin d'une ligne"]) {
      await toRest();
      before = ptyText().length;
      await sendText(text, 500);
      d = ptyText().slice(before);
      s = await st();
      const tok = text.split(/\s+/)[0];
      notAvail.push({ text, ok: d === '' && s.warn && s.warnText.includes(`${tok} n'est pas disponible en mode chat`)
        && s.value === text && s.pending === 0 && s.queue === 0, pty: d, warn: s.warnText });
    }
    gate('k9 hidden /config, unknown /foo and /etc/hosts -> « n\'est pas disponible en mode chat », no PTY write, text kept',
      notAvail.every((x) => x.ok), JSON.stringify(notAvail));

    // k10 — hostile first token stays text
    await toRest();
    before = ptyText().length;
    await sendText('/<img src=x onerror=alert(1)> x', 500);
    d = ptyText().slice(before);
    s = await st();
    gate('k10 a hostile first token renders as text in the banner (no element), no PTY write',
      d === '' && s.warn && s.warnKids === 0 && s.warnText.includes('/<img') && s.warnText.includes("n'est pas disponible en mode chat"),
      JSON.stringify({ pty: d, kids: s.warnKids, text: s.warnText }));

    // k11 — busy session, then an open menu
    await toRest();
    await js(`window.__hold = setInterval(() => { panes.get('pane-1').chat.lastStatus = 'working'; }, 10)`);
    await sleep(100);
    before = ptyText().length;
    await sendText('/recap', 500);
    d = ptyText().slice(before);
    s = await st();
    const busy = { pty: d, warn: s.warn, text: s.warnText, value: s.value, queue: s.queue };
    await js(`clearInterval(window.__hold)`);
    await toRest();
    await js(`panes.get('pane-1').chat.askEl.hidden = false`);
    before = ptyText().length;
    await sendText('/recap', 500);
    const dMenu = ptyText().slice(before);
    const sMenu = await st();
    await js(`panes.get('pane-1').chat.askEl.hidden = true`);
    gate('k11 busy session or open menu -> « Attends la fin du tour », no PTY write, nothing queued, text kept',
      busy.pty === '' && busy.warn && busy.text.includes('Attends la fin du tour') && busy.text.includes('/recap')
        && busy.value === '/recap' && busy.queue === 0
        && dMenu === '' && sMenu.warn && sMenu.warnText.includes('Attends la fin du tour') && sMenu.value === '/recap' && sMenu.queue === 0,
      JSON.stringify({ busy, menu: { pty: dMenu, warn: sMenu.warn, text: sMenu.warnText, value: sMenu.value } }));

    // k12 — double Enter
    await toRest();
    before = ptyText().length;
    await js(`(() => { const i = ${INPUT}; i.value = '/recap';
      for (let n = 0; n < 2; n++) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(700);
    const dSame = ptyText().slice(before);
    await toRest();
    before = ptyText().length;
    wc.insertText('/recap ');
    await sleep(200);
    key('Enter');
    key('Enter');
    await sleep(700);
    const dReal = ptyText().slice(before);
    gate('k12 a double Enter sends once (same tick and real keys)',
      dSame === BR('/recap') && dReal === BR('/recap'),
      JSON.stringify({ sameTick: dSame, realKeys: dReal }));

    // k14 — user skill with arguments
    await toRest();
    before = ptyText().length;
    await sendText('/zz-hostile fais ceci', 700);
    d = ptyText().slice(before);
    s = await st();
    gate('k14 a user skill with arguments is sent whole',
      d === BR('/zz-hostile fais ceci') && s.value === '' && !s.warn,
      JSON.stringify({ pty: d, value: s.value, warn: s.warn }));

    // k13 — control, LAST (a normal send leaves the session busy): a « / » in the middle of a message is not a command
    await toRest();
    before = ptyText().length;
    await sendText('regarde /etc/hosts stp', 700);
    const dMid = ptyText().slice(before);
    s = await st();
    gate('k13 control: a message with a « / » in the middle reaches the PTY, no banner',
      dMid.includes('regarde /etc/hosts stp') && !s.warn,
      JSON.stringify({ mid: dMid, warn: s.warn }));
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
