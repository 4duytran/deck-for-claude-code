// v46.9.8 probe — slash-command guard + deck-managed /compact button.
// Run: <repo>/node_modules/.bin/electron test/compact-slash-probe.js
//
// FULL ISOLATION (incident rule 2026-06-04): HOME faked BEFORE main.js loads;
// pty spawns a fake claude (cat, bracketed-paste enabled) that captures stdin
// to PTY_LOG so we can assert EXACTLY what reached the pty (a real Esc = 1
// byte; a guarded/swallowed one = 0). Compaction markers are appended to the
// fixture .jsonl to drive the deterministic resolution path end-to-end.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-compact-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
const setStatus = (sid, status, ts) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: ts || new Date().toISOString() }) + '\n');

const PTY_LOG = path.join(FAKE_HOME, 'pty-input.log');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN,
  `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf '\\033[?2004h'\nexec cat >> "${PTY_LOG}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const SID = '55555555-cccc-4ddd-8eee-555555555555';
const TS = '2026-06-07T10:00:00.000Z';
const J = (o) => JSON.stringify(o) + '\n';
const FIXTURE = path.join(PROJ_DIR, `${SID}.jsonl`);
fs.writeFileSync(FIXTURE, [
  J({ type: 'user', cwd: WS, timestamp: TS,
      message: { role: 'user', content: 'Bonjour, démarre la session' } }),
  J({ type: 'assistant', timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Salut !' }],
                 usage: { input_tokens: 5, output_tokens: 4 } } }),
].join(''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptySize = () => { try { return fs.statSync(PTY_LOG).size; } catch (_) { return 0; } };
const ptyText = () => { try { return fs.readFileSync(PTY_LOG, 'latin1'); } catch (_) { return ''; } };

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-compact-ud-')));
const { app, BrowserWindow } = require('electron');

const results = [];
function gate(id, ok, detail) { results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`); }

// In-page snapshot of the compaction-in-progress indicators. Compaction shows ONE thing: the inline status line
// (`ca-label` + `ca-timer`). Only visible nodes count (the hidden strip keeps its last text), and the stream must hold
// no bar and no in-progress marker (done / canceled / noop dividers from earlier steps stay in it, so they are not counted).
const INLINE = `(() => {
  const el = panes.get('pane-1').el;
  const stream = el.querySelector('.chat-stream');
  const LABEL = 'Compactage de la conversation';
  const hosts = [...el.querySelectorAll('*')].filter((n) =>
    n.children.length === 0 && (n.textContent || '').includes(LABEL) && n.getClientRects().length > 0)
    .map((n) => n.className || n.tagName);
  return { hosts, timer: el.querySelector('.ca-timer').textContent,
           bars: stream.querySelectorAll('.ccd-bar, .ccd-bar-fill, .cc-compacting').length,
           anims: stream.getAnimations({ subtree: true }).length };
})()`;

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  await js(`openPane({ resumeId: '${SID}', title: 'compact-fixture' })`);
  await sleep(800);
  await js(`setChatView('pane-1', true)`);
  await sleep(900);
  setStatus(SID, 'idle');
  await sleep(500);

  // c1 — a slash command is BLOCKED: nothing reaches the pty, the warning
  // shows, no optimistic echo is created.
  const pre1 = ptySize();
  await js(`(() => { const ta = panes.get('pane-1').el.querySelector('.chat-input');
    ta.value = '/model';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(400); // the send reads the command list first
  const c1 = await js(`(() => {
    const el = panes.get('pane-1').el;
    return {
      warnShown: !el.querySelector('.chat-slash-warn').hidden,
      warnTxt: el.querySelector('.chat-slash-warn').textContent,
      pending: panes.get('pane-1').chat.pendingSends.length,
      leaked: el.querySelector('.chat-stream').textContent.includes('/model'),
      kept: el.querySelector('.chat-input').value === '/model',
    };
  })()`);
  gate('c1 bare /model gets its banner (pty untouched, warn shown, text kept, no echo)',
       ptySize() === pre1 && c1.warnShown && c1.warnTxt.includes('/model') && c1.warnTxt.includes('menu du composeur')
       && c1.kept && c1.pending === 0 && !c1.leaked,
       JSON.stringify({ ptyDelta: ptySize() - pre1, ...c1 }));

  // c2 — a hand-typed /compact takes the compact path (the button is the other way in).
  const pre2 = ptySize();
  await js(`(() => { const el = panes.get('pane-1').el;
    el.querySelector('.chat-slash-warn').hidden = true; // c1's banner
    const ta = el.querySelector('.chat-input');
    ta.value = '/compact';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  const c2 = await js(`(() => ({ warnShown: !panes.get('pane-1').el.querySelector('.chat-slash-warn').hidden,
             compacting: panes.get('pane-1').chat.compacting }))()`);
  gate('c2 hand-typed /compact takes the compact path (compacting, pty got /compact, no warn)',
       ptyText().slice(pre2).includes('/compact') && !c2.warnShown && c2.compacting === true,
       JSON.stringify({ ptyDelta: ptySize() - pre2, ...c2 }));
  // end that compaction so c3 starts from rest
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary',
    sessionId: SID, timestamp: TS, content: '', compactMetadata: { trigger: 'manual' } }));
  await sleep(1500);
  setStatus(SID, 'idle'); await sleep(400);

  // c3 — control: a normal message DOES reach the pty (guard is slash-only).
  const pre3 = ptySize();
  await js(`(() => {
    const el = panes.get('pane-1').el;
    const ta = el.querySelector('.chat-input');
    ta.value = 'message normal';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  gate('c3 control: normal text reaches the pty',
       ptyText().includes('message normal'),
       JSON.stringify({ ptyDelta: ptySize() - pre3 }));
  setStatus(SID, 'idle'); await sleep(400); // back to rest for the compact tests

  // c4 — CLICK the compact button: compacting state, the inline status line is the
  // only indicator (one visible « Compactage » label hosted by ca-label, no bar and
  // no in-progress marker in the stream), send flips to STOP, compact btn disabled,
  // and /compact reached the pty.
  const pre4 = ptySize();
  const n4 = (ptyText().match(/\/compact/g) || []).length; // /compact writes before the button (c2)
  const c4 = await js(`(() => {
    const el = panes.get('pane-1').el;
    el.querySelector('.cc-compact').click();
    const chat = panes.get('pane-1').chat;
    return {
      compacting: chat.compacting,
      isStop: el.querySelector('.chat-send').classList.contains('is-stop'),
      btnDisabled: el.querySelector('.cc-compact').disabled,
      strip: el.querySelector('.ca-label').textContent,
      stripShown: !el.querySelector('.chat-activity').hidden,
    };
  })()`);
  await sleep(250); // let the deferred CR land
  const c4i = await js(INLINE);
  gate('c4 compact button -> compacting, inline line only (one ca-label, no bar), stop, disabled, pty got /compact',
       c4.compacting && c4.strip.includes('Compactage') && c4.stripShown
       && c4i.hosts.length === 1 && c4i.hosts[0] === 'ca-label' && c4i.bars === 0
       && c4.isStop && c4.btnDisabled && ptyText().slice(pre4).includes('/compact'),
       JSON.stringify({ ptyHasCompact: ptyText().slice(pre4).includes('/compact'), ...c4, inline: c4i }));

  // c5 — sends DURING compaction go to the QUEUE (pty untouched).
  const pre5 = ptySize();
  const c5 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const ta = el.querySelector('.chat-input');
    ta.value = 'QUEUED-DURING-COMPACT';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { q: [...el.querySelectorAll('.cq-text')].map((x) => x.textContent),
             leaked: el.querySelector('.chat-stream').textContent.includes('QUEUED-DURING-COMPACT') };
  })()`);
  await sleep(200);
  gate('c5 sends during compaction are queued, pty untouched',
       ptySize() === pre5 && c5.q.join(',') === 'QUEUED-DURING-COMPACT' && !c5.leaked,
       JSON.stringify({ ptyDelta: ptySize() - pre5, ...c5 }));

  // c6 — DOUBLE-CLICK the (now hidden-as-stop) compact path is guarded: a
  // second startCompact while compacting must NOT send a second /compact.
  const before6 = (ptyText().match(/\/compact/g) || []).length;
  await js(`(() => { const c = panes.get('pane-1').chat;
    // simulate a rapid second trigger (button is disabled, but prove the guard)
    panes.get('pane-1').el.querySelector('.cc-compact').click();
  })()`);
  await sleep(200);
  const after6 = (ptyText().match(/\/compact/g) || []).length;
  gate('c6 double-trigger compact -> still exactly one /compact sent',
       before6 - n4 === 1 && after6 - n4 === 1,
       JSON.stringify({ before: before6 - n4, after: after6 - n4 }));

  // c7 — compact_boundary lands: card flips to DONE, compacting clears, the
  // queued message DRAINS to the pty; the drain sets lastStatus='working', so the send button IS a stop (the queued
  // message is in flight).
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary',
    sessionId: SID, timestamp: TS, content: '', compactMetadata: { trigger: 'manual' } }));
  await sleep(1500);
  const c7 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const chat = panes.get('pane-1').chat;
    const done = el.querySelector('.chat-compact.cc-done');
    return { compacting: chat.compacting,
             done: !!done,
             label: done ? done.querySelector('.ccd-label').textContent : '',
             isStop: el.querySelector('.chat-send').classList.contains('is-stop'),
             qleft: el.querySelectorAll('.cq-item').length };
  })()`);
  // The drained paste waits behind the c3 send's retry poll (up to RETRY_DEADLINE_MS = 6 s): bounded wait, never a fixed sleep.
  for (const t0 = Date.now(); Date.now() - t0 < 8000 && !ptyText().includes('QUEUED-DURING-COMPACT');) await sleep(100);
  gate('c7 compact_boundary -> done card, cleared, queue drained, queued message in flight (send is a stop)',
       !c7.compacting && c7.done && c7.label.includes('compactée')
       && c7.isStop === true && c7.qleft === 0 && ptyText().includes('QUEUED-DURING-COMPACT'),
       JSON.stringify({ drained: ptyText().includes('QUEUED-DURING-COMPACT'), ...c7 }));

  // c8 — CANCEL path + double-Esc swallow: start a compact, press Esc TWICE
  // rapidly -> exactly ONE \x1b reaches the pty (stopPending guard); then the
  // cancel stderr marker resolves the card as « annulé ».
  setStatus(SID, 'idle'); await sleep(400);
  await js(`panes.get('pane-1').el.querySelector('.cc-compact').click()`);
  await sleep(250);
  const preEsc = ptySize();
  await js(`(() => {
    const el = panes.get('pane-1').el.querySelector('.pane-chat');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);
  const escDelta = ptySize() - preEsc;
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'local_command', timestamp: TS,
    content: '<local-command-stderr>AbortError: Compaction canceled.</local-command-stderr>' }));
  await sleep(1500);
  const c8 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const chat = panes.get('pane-1').chat;
    const cx = el.querySelector('.chat-compact.cc-canceled');
    return { compacting: chat.compacting, canceled: !!cx,
             label: cx ? cx.querySelector('.ccd-label').textContent : '' };
  })()`);
  gate('c8 double-Esc -> ONE \\x1b, cancel marker -> annulé card, cleared',
       escDelta === 1 && !c8.compacting && c8.canceled && c8.label.includes('annulé'),
       JSON.stringify({ escDelta, ...c8 }));

  // c9 — isCompactSummary user line is SUPPRESSED (internal continuation
  // summary, never a chat bubble).
  fs.appendFileSync(FIXTURE, J({ type: 'user', isCompactSummary: true,
    isVisibleInTranscriptOnly: true, timestamp: TS,
    message: { role: 'user', content: 'CONTINUATION-SUMMARY-SECRET' } }));
  await sleep(1200);
  const c9 = await js(
    `panes.get('pane-1').el.querySelector('.chat-stream').textContent.includes('CONTINUATION-SUMMARY-SECRET')`);
  gate('c9 isCompactSummary suppressed (no bubble)', c9 === false, JSON.stringify({ leaked: c9 }));

  // c10 — a compact_boundary while NOT compacting (terminal-triggered / history)
  // renders a standalone divider, no busy state hijack.
  const pre10 = await js(`panes.get('pane-1').el.querySelectorAll('.chat-compact.cc-done').length`);
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary',
    sessionId: SID, timestamp: TS, content: '', compactMetadata: { trigger: 'auto' } }));
  await sleep(1200);
  const c10 = await js(`(() => {
    const chat = panes.get('pane-1').chat;
    return { done: panes.get('pane-1').el.querySelectorAll('.chat-compact.cc-done').length,
             compacting: chat.compacting };
  })()`);
  gate('c10 boundary while idle -> divider added, no compacting hijack',
       c10.done === pre10 + 1 && c10.compacting === false,
       JSON.stringify({ pre: pre10, ...c10 }));

  // c11 (attack #4) — a path-like message starting with '/' is blocked BY
  // DESIGN (user spec: any '/'-leading input). The text is KEPT (not stranded)
  // so the user can recover it / switch to terminal.
  setStatus(SID, 'idle'); await sleep(300);
  const pre11 = ptySize();
  await js(`(() => {
    const el = panes.get('pane-1').el; const ta = el.querySelector('.chat-input');
    el.querySelector('.chat-slash-warn').hidden = true; // an earlier banner
    ta.value = "/etc/hosts a besoin d'une ligne";
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(500); // the send reads the command list first
  const c11 = await js(`(() => {
    const el = panes.get('pane-1').el;
    return { warn: !el.querySelector('.chat-slash-warn').hidden,
             warnTxt: el.querySelector('.chat-slash-warn').textContent,
             kept: el.querySelector('.chat-input').value.startsWith('/etc/hosts') };
  })()`);
  gate('c11 path-like /etc/hosts is not a command (banner, nothing shipped, text kept)',
       ptySize() === pre11 && c11.warn && c11.kept && c11.warnTxt.includes("/etc/hosts n'est pas disponible en mode chat"),
       JSON.stringify({ ptyDelta: ptySize() - pre11, ...c11 }));

  // c12 (attack #5) — the removed sweeping bar must stay removed (measured, not just a
  // missing element): while compacting, the inline line is the one visible label with
  // its elapsed timer ticking, and nothing animates inside the stream.
  await js(`(() => { const el = panes.get('pane-1').el;
    el.querySelector('.chat-input').value = ''; })()`);
  setStatus(SID, 'idle'); await sleep(300);
  await js(`panes.get('pane-1').el.querySelector('.cc-compact').click()`);
  await sleep(1300); // the strip timer ticks once a second
  const c12 = await js(INLINE);
  gate('c12 compacting -> inline line with ticking timer, no bar, nothing animates in the stream',
       c12.hosts.length === 1 && c12.hosts[0] === 'ca-label' && /^\d+s$/.test(c12.timer)
       && c12.bars === 0 && c12.anims === 0,
       JSON.stringify(c12));
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'compact_boundary',
    sessionId: SID, timestamp: TS, content: '', compactMetadata: { trigger: 'manual' } }));
  await sleep(1200);

  // c13 (user repro 2026-06-09) — a /compact that NO-OPS with "Not enough
  // messages to compact." emits a local_command STDOUT, not a compact_boundary
  // and not a cancel/abort. The deck-driven compaction must still RESOLVE — else the
  // optimistic inline line hangs until the 10-min safety timeout (the bug).
  setStatus(SID, 'idle'); await sleep(300);
  await js(`panes.get('pane-1').el.querySelector('.cc-compact').click()`);
  await sleep(250);
  const pre13 = await js(`(() => { const c = panes.get('pane-1').chat;
    return { compacting: c.compacting }; })()`);
  const pre13i = await js(INLINE);
  fs.appendFileSync(FIXTURE, J({ type: 'system', subtype: 'local_command', sessionId: SID, timestamp: TS,
    content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>' }));
  await sleep(1500);
  const c13 = await js(`(() => {
    const el = panes.get('pane-1').el;
    const chat = panes.get('pane-1').chat;
    // target the NEWEST card (an old cc-done from c12 still sits in the DOM)
    const cards = el.querySelectorAll('.chat-compact');
    const last = cards[cards.length - 1];
    const stranded = !!last && last.classList.contains('cc-compacting'); // an in-progress marker left in the stream
    const isNoop = !!last && last.classList.contains('cc-noop'); // neutral state
    const miscat = !!last && (last.classList.contains('cc-canceled') || last.classList.contains('cc-done'));
    return { compacting: chat.compacting, stranded, isNoop, miscat,
             label: last ? last.querySelector('.ccd-label').textContent : '',
             isStop: el.querySelector('.chat-send').classList.contains('is-stop') };
  })()`);
  const post13i = await js(INLINE);
  // clears the inline line AND renders as a DISTINCT neutral outcome divider (cc-noop) — not
  // the cancel/done chrome (a no-op is benign, not an abort or a success).
  gate('c13 no-op /compact ("Not enough messages") -> distinct cc-noop divider, inline line cleared, nothing stranded',
       pre13.compacting && pre13i.hosts.length === 1 && pre13i.hosts[0] === 'ca-label' && pre13i.bars === 0
       && !c13.compacting && !c13.stranded && c13.isNoop && !c13.miscat && !c13.isStop
       && post13i.hosts.length === 0 && post13i.bars === 0
       && /compacter|message/i.test(c13.label),
       JSON.stringify({ pre: pre13, preInline: pre13i, ...c13, postInline: post13i }));

  console.log('\n=== compact-slash-probe ===');
  for (const r of results) console.log(r);
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - fails.length}/${results.length} PASS`);
  setTimeout(() => app.exit(fails.length ? 1 : 0), 300);
});
