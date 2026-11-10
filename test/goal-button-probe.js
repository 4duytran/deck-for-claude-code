// v49 probe — /goal ARM toggle (chat composer). The 🎯 button no longer opens a
// field: it arms goal-mode (lights up), and the NEXT normal composer send goes
// out as « /goal <message> », then the button disarms. Fake claude (cat>>PTY_LOG,
// bracketed paste) captures EXACTLY what reaches the pty.
// Gates:
//   g1 🎯 arms goal-mode (class .armed + aria-pressed=true); NO inline field exists
//   g2 armed + normal send -> pty gets « /goal <msg> » + button disarms + input cleared
//   g3 🎯 is a toggle: click on->off
//   g4 NOT armed + normal send -> pty gets the PLAIN message (no /goal prefix)
//   g5 NOT armed + typed /command -> slash guard still blocks (warn, no pty)
//   g6 busy -> 🎯 disabled, can't arm
//   g7 armed + empty input + Enter -> nothing sent, STAYS armed
//   g7b (L10b) armed -> button.cc-more carries data-goal="on" with the « ⋯ » menu closed
// Run: <repo>/node_modules/.bin/electron test/goal-button-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-goal-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
const setStatus = (sid, status) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: '2026-06-08T10:00:00.000Z' }) + '\n');

const PTY_LOG = path.join(FAKE_HOME, 'pty-input.log');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN,
  `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf '\\033[?2004h'\nexec cat >> "${PTY_LOG}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const SID = '99999999-cccc-4ddd-8eee-999999999999';
const TS = '2026-06-08T10:00:00.000Z';
const J = (o) => JSON.stringify(o) + '\n';
const FIXTURE = path.join(PROJ_DIR, `${SID}.jsonl`);
fs.writeFileSync(FIXTURE, [
  J({ type: 'user', cwd: WS, timestamp: TS, message: { role: 'user', content: 'démarre' } }),
  J({ type: 'assistant', timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }],
                 usage: { input_tokens: 3, output_tokens: 2 } } }),
].join(''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptySize = () => { try { return fs.statSync(PTY_LOG).size; } catch (_) { return 0; } };
const ptyText = () => { try { return fs.readFileSync(PTY_LOG, 'latin1'); } catch (_) { return ''; } };

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-goal-ud-')));
const { app, BrowserWindow } = require('electron');

const results = [];
function gate(id, ok, detail) { results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`); }

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  await js(`openPane({ resumeId: '${SID}', title: 'goal-fixture' })`);
  await sleep(800);
  await js(`setChatView('pane-1', true)`);
  await sleep(900);
  setStatus(SID, 'idle');
  await sleep(500);

  // g1 — 🎯 arms goal-mode; no inline field is created.
  const g1 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const btn = el.querySelector('.cc-goal');
    btn.click();
    return { armed: btn.classList.contains('armed'),
             pressed: btn.getAttribute('aria-pressed'),
             noField: !el.querySelector('.cc-goal-row'),
             stillArmedState: panes.get('pane-1').chat.goalArmed };
  })()`);
  gate('g1 🎯 arms goal-mode (lit, no inline field)',
       g1.armed === true && g1.pressed === 'true' && g1.noField === true && g1.stillArmedState === true,
       JSON.stringify(g1));

  // g2 — armed + a NORMAL composer send -> « /goal <msg> » to pty, then disarm.
  const pre2 = ptySize();
  const g2 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const ta = el.querySelector('.chat-input');
    ta.value = 'tous les tests passent';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { tav: ta.value };
  })()`);
  await sleep(300);
  const g2b = await js(`(() => { const b = panes.get('pane-1').el.querySelector('.cc-goal');
    return { armed: b.classList.contains('armed'), pressed: b.getAttribute('aria-pressed') }; })()`);
  gate('g2 armed normal send -> « /goal <msg> » + disarm + input cleared',
       ptyText().includes('/goal tous les tests passent') && ptySize() > pre2
       && g2.tav === '' && g2b.armed === false && g2b.pressed === 'false',
       JSON.stringify({ ptyDelta: ptySize() - pre2, ...g2, ...g2b }));

  // g3 — toggle: on then off.
  const g3 = await js(`(() => {
    const b = panes.get('pane-1').el.querySelector('.cc-goal');
    b.click(); const on = b.classList.contains('armed');
    b.click(); const off = b.classList.contains('armed');
    return { on, off };
  })()`);
  gate('g3 🎯 is a toggle (on -> off)', g3.on === true && g3.off === false, JSON.stringify(g3));

  // g4 — NOT armed: a normal message reaches the pty WITHOUT a /goal prefix.
  const pre4 = ptySize();
  await js(`(() => {
    const ta = panes.get('pane-1').el.querySelector('.chat-input');
    ta.value = 'message normal sans goal';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  gate('g4 not armed -> plain message to pty (no /goal prefix)',
       ptyText().includes('message normal sans goal')
       && !ptyText().includes('/goal message normal sans goal') && ptySize() > pre4,
       JSON.stringify({ ptyDelta: ptySize() - pre4 }));
  setStatus(SID, 'idle'); await sleep(400);

  // g5 — regression: a typed /command (not armed) is still blocked.
  const pre5 = ptySize();
  await js(`(() => {
    const el = panes.get('pane-1').el; const ta = el.querySelector('.chat-input');
    ta.value = '/model';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(500); // B24 K7: the send reads the command list first; a bare /model answers with its banner
  const g5 = await js(`(() => { const w = panes.get('pane-1').el.querySelector('.chat-slash-warn');
    return { warn: !w.hidden && w.textContent.includes('menu du composeur') }; })()`);
  gate('g5 regression: a typed bare /model still gets its banner, nothing sent',
       ptySize() === pre5 && g5.warn && !ptyText().includes('/model'),
       JSON.stringify({ ptyDelta: ptySize() - pre5, ...g5 }));

  // g6 — busy: the 🎯 button is disabled, can't arm. Drive the status handler
  // SYNCHRONOUSLY (seam) and assert in the SAME tick: a file-driven 'working'
  // decays to idle within ~500ms in the fake-TUI harness (phantom-busy
  // reconciler: blank screen + stale pty), which would race a sleep-then-check.
  const g6 = await js(`(() => {
    cvNotifySessionStatus('${SID}', 'working');
    const b = panes.get('pane-1').el.querySelector('.cc-goal');
    const disabled = b.disabled;
    b.click(); // disabled -> no event
    return { disabled, armed: b.classList.contains('armed') };
  })()`);
  gate('g6 busy -> 🎯 disabled, cannot arm',
       g6.disabled === true && g6.armed === false, JSON.stringify(g6));
  await js(`cvNotifySessionStatus('${SID}', 'idle')`); await sleep(200);

  // g7 — armed + EMPTY input + Enter -> nothing sent, stays armed. Force a clean
  // idle synchronously first so the arm is never refused by a stale busy status.
  const pre7 = ptySize();
  const g7 = await js(`(() => {
    cvNotifySessionStatus('${SID}', 'idle');
    const el = panes.get('pane-1').el;
    const b = el.querySelector('.cc-goal'); b.click(); // arm
    const ta = el.querySelector('.chat-input'); ta.value = '';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { armed: b.classList.contains('armed') };
  })()`);
  await sleep(200);
  gate('g7 armed + empty send -> nothing sent, stays armed',
       ptySize() === pre7 && g7.armed === true, JSON.stringify({ ptyDelta: ptySize() - pre7, ...g7 }));

  // g7b (L10b) — the armed state stays visible with the « ⋯ » menu CLOSED: button.cc-more carries data-goal="on"
  // while goal is armed and loses it on disarm. g7 left the goal armed at rest; the gate re-arms it for g8.
  const g7b = await js(`(() => {
    const el = panes.get('pane-1').el;
    const more = el.querySelector('button.cc-more'); const menu = el.querySelector('.cc-menu[role="menu"]');
    const goal = el.querySelector('.cc-goal');
    const read = () => (more ? more.getAttribute('data-goal') : null);
    const armedState = panes.get('pane-1').chat.goalArmed;
    const closed = !!more && !!menu && more.getAttribute('aria-expanded') === 'false' && (menu.hidden || menu.getClientRects().length === 0);
    const on = read();
    goal.click(); // disarm
    const off = read(); const offState = panes.get('pane-1').chat.goalArmed;
    goal.click(); // re-arm for g8
    const back = read();
    return { armedState, closed, on, off, offState, back };
  })()`);
  gate('g7b armed -> data-goal="on" on .cc-more with the menu closed (gone on disarm)',
       g7b.armedState === true && g7b.closed === true && g7b.on === 'on' && g7b.off === null && g7b.offState === false && g7b.back === 'on',
       JSON.stringify(g7b));

  // g8 (attack #3) — armed THEN busy: disabled + lit fill NEUTRALIZED (reads as
  // disabled, not « lit but greyed »); the armed STATE persists for re-light at
  // rest. Arm at idle then go busy, all synchronous (same anti-decay rationale).
  const g8 = await js(`(() => {
    cvNotifySessionStatus('${SID}', 'idle');
    const b = panes.get('pane-1').el.querySelector('.cc-goal');
    if (!b.classList.contains('armed')) b.click(); // ensure armed
    cvNotifySessionStatus('${SID}', 'working');
    // .cc-goal has a 150ms background TRANSITION: g7 left it settled on accent, so
    // going disabled animates accent->transparent and a same-tick read catches the
    // accent end. Kill the transition + reflow so getComputedStyle returns the
    // SETTLED target of .cc-goal.armed:disabled (what the user sees once it lands).
    b.style.transition = 'none'; void b.offsetWidth;
    const bg = getComputedStyle(b).backgroundColor;
    b.style.transition = '';
    return { disabled: b.disabled, armed: b.classList.contains('armed'), bg };
  })()`);
  gate('g8 armed+busy -> disabled + armed kept + NOT lit (no accent fill)',
       g8.disabled === true && g8.armed === true && !g8.bg.includes('217, 119, 87'),
       JSON.stringify(g8));
  await js(`cvNotifySessionStatus('${SID}', 'idle')`); await sleep(200);

  // g9 (attack #2) — a 'closed' push disarms goal mode (a dead pane is never lit).
  setStatus(SID, 'closed'); await sleep(500);
  const g9 = await js(`(() => {
    const b = panes.get('pane-1').el.querySelector('.cc-goal');
    return { armed: b.classList.contains('armed'), state: panes.get('pane-1').chat.goalArmed };
  })()`);
  gate('g9 closed push -> goal disarmed', g9.armed === false && g9.state === false, JSON.stringify(g9));

  console.log('\n=== goal-button-probe ===');
  for (const r of results) console.log(r);
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\nVERDICT: ${fails.length ? 'RED' : 'ALL GREEN'} (${results.length - fails.length}/${results.length})`);
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) {}
  setTimeout(() => app.exit(fails.length ? 1 : 0), 300);
}).catch((e) => {
  console.log('PROBE_FATAL:', String((e && e.message) || e));
  console.log((e && e.stack) || '');
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) {}
  app.exit(3);
});
