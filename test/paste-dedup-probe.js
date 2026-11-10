// paste-dedup-probe.js — claude-deck-paste-wrapper-dedup fix.
// ROOT CAUSE (RCA, docs/plans/claude-deck-paste-wrapper-dedup.spec.md): the
// Claude Code CLI wraps a bracket-pasted composer send into
// `<pasted_content id="…">\n…\n</pasted_content id="…">\n` before writing the
// transcript record. The Deck's own optimistic echo (chat-view.js sendNow)
// carries no such wrapper, so the whitespace-only dedup compare
// (normText/sameText) never matched — every Deck send rendered TWICE: the
// plain pending echo AND a transcript bubble showing the literal tags.
// FIX (design A, spec D8): unwrap the genuine wrapper at the one sanctioned
// kind:'user' emission point, src/main/transcript-normalize.js
// (PASTE_WRAP_RE / unwrapPastedContent), so both the live dedup compare
// (chat-view.js:1265 resolvePending) and a bare replay/rebuild compare
// (chat-view.js:3217) see the plain inner text.
//
// This probe drives the REAL file-tailing pipeline (fs append -> main
// process normalizeLine -> IPC -> renderer), never a synthetic
// notifyTranscriptAppend call — it exercises the actual patched reader, not
// only the renderer glue.
//
// Run: <repo>/node_modules/.bin/electron test/paste-dedup-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pdedup-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });
const setStatus = (sid, status) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: new Date().toISOString() }) + '\n');

const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM,
  '#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf "\\033[?2004h"\ncat >/dev/null\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const TS = '2026-09-21T10:00:00.000Z';
const J = (o) => JSON.stringify(o) + '\n';
const userLine = (content) => J({ type: 'user', cwd: WS, timestamp: TS, message: { role: 'user', content } });
const asst = (text) => J({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text }] } });

// --- pane 1: Deck send + real wrapped confirmation (dedup) -----------------
const SID = 'dedee111-1111-4111-8111-111111111111';
const FIXTURE = path.join(PROJ_DIR, `${SID}.jsonl`);
fs.writeFileSync(FIXTURE, asst('bonjour'));
const MSG1 = 'Résumé du repo:\nmerci de lister les fichiers principaux.';
// Real record shape (FACT row, session ccdd8d2b…, id "2691"): outer \n\n, one
// \r?\n boundary on each side of the inner text, matching open/close ids.
const WRAPPED1 = `\n\n<pasted_content id="2691">\n${MSG1}\n</pasted_content id="2691">\n`;

// --- pane 2: replay with NO pending echo (wrapped record present at open) --
const SID2 = 'dedee222-2222-4222-8222-222222222222';
const FIXTURE2 = path.join(PROJ_DIR, `${SID2}.jsonl`);
const MSG2 = 'contenu déjà présent au chargement, sans wrapper visible';
const WRAPPED2 = `<pasted_content id="9001">\n${MSG2}\n</pasted_content id="9001">`;
fs.writeFileSync(FIXTURE2, userLine(WRAPPED2));

// --- pane 3: leave-unchanged battery + CRLF boundary ------------------------
const SID3 = 'dedee333-3333-4333-8333-333333333333';
const FIXTURE3 = path.join(PROJ_DIR, `${SID3}.jsonl`);
// escaped: the CLI's own escape for a paste that contains the literal tag
// (`<\pasted_content …>`) — no genuine open tag, must survive verbatim.
const MSG3 = '<\\pasted_content id="55">\ninner escaped text\n</pasted_content id="55">';
// mixed form: typed prefix + wrapper — the wrapper must span the WHOLE
// string to unwrap; a prefix breaks the anchor.
const MSG4a = 'Voici le contexte:\n<pasted_content id="10">\nfoo bar\n</pasted_content id="10">';
// mismatched ids — the backreference must reject this.
const MSG4b = '<pasted_content id="1">\nfoo\n</pasted_content id="2">';
// non-wrapped look-alike — never matched a wrapper shape at all.
const MSG4c = 'On a parlé du système pasted_content hier, tu te souviens ?';
// several wrappers — only ONE genuine wrapper spanning the whole string
// unwraps; two concatenated wrappers must not.
const MSG4d = '<pasted_content id="1">\nA\n</pasted_content id="1">\n\n<pasted_content id="2">\nB\n</pasted_content id="2">';
// CRLF boundary — unwraps exactly like the LF form.
const MSG5 = 'ligne crlf sans saut interne';
const WRAPPED5 = `<pasted_content id="66">\r\n${MSG5}\r\n</pasted_content id="66">`;
// Tier 1 review Finding 1 repro: two wrappers sharing the SAME id — the
// same-id guard in unwrapPastedContent must leave this untouched, tags
// visible, instead of surfacing an embedded-tag blob.
const MSG4e = '<pasted_content id="1">\nA\n</pasted_content id="1">\n<pasted_content id="1">\nB\n</pasted_content id="1">';
// Tier 1 review Finding 3 repro: wrapped empty-inner and whitespace-only
// records — the unwrap must run BEFORE the empty/noise filters so these
// render no user card at all, same as a bare empty/whitespace paste would.
const WRAPPED_EMPTY = '<pasted_content id="88">\n\n</pasted_content id="88">';
const WRAPPED_WS = '<pasted_content id="89">\n   \n</pasted_content id="89">';
const MSG6 = 'après les deux wrappers vides, la lecture continue normalement';
const WRAPPED6 = `<pasted_content id="90">\n${MSG6}\n</pasted_content id="90">`;
fs.writeFileSync(FIXTURE3, [userLine(MSG3), userLine(MSG4a), userLine(MSG4b)].join(''));

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pdedup-ud-')));

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}

// Data/state-driven wait — never a fixed delay standing in for a proof. Polls
// a renderer expression until it reports {ok:true} or the timeout elapses.
async function waitFor(js, exprCode, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  const step = intervalMs || 60;
  let last = null;
  while (Date.now() < deadline) {
    last = await js(exprCode);
    if (last && last.ok) return last;
    await sleep(step);
  }
  return last;
}

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // === GATE 1 — Deck send + wrapped transcript confirmation (dedup) ========
  await js(`openPane({ resumeId: '${SID}', title: 'paste-dedup-1' })`);
  await sleep(800);
  await js(`setChatView('pane-1', true)`);
  await sleep(500);
  setStatus(SID, 'idle');
  await js(`(() => { panes.get('pane-1').chat.lastStatus = 'idle'; })()`);
  await sleep(200);

  const sent1 = await js(`(() => {
    const pane = panes.get('pane-1');
    pane.chat.inputEl.value = ${JSON.stringify(MSG1)};
    pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { pending: pane.chat.pendingSends.length,
             cards: pane.chat.streamEl.querySelectorAll('.chat-msg.chat-user').length };
  })()`);
  gate('g1-setup: composer send creates one pending echo, one card',
    sent1.pending === 1 && sent1.cards === 1, JSON.stringify(sent1));

  fs.appendFileSync(FIXTURE, userLine(WRAPPED1));
  const r1 = await waitFor(js, `(() => {
    const chat = panes.get('pane-1').chat;
    const cards = [...chat.streamEl.querySelectorAll('.chat-msg.chat-user')];
    const ok = chat.pendingSends.length === 0 && cards.length === 1 && !cards[0].classList.contains('chat-pending');
    const bubble = cards[0] ? cards[0].querySelector('.chat-bubble') : null;
    return { ok, pending: chat.pendingSends.length, cardCount: cards.length,
             pendingClass: cards[0] ? cards[0].classList.contains('chat-pending') : null,
             text: bubble ? bubble.textContent : null };
  })()`);
  gate('g1: wrapped confirmation resolves the pending echo — ONE chat-user card, not pending, text = inner message, no tags',
    !!r1 && r1.cardCount === 1 && r1.pending === 0 && r1.pendingClass === false &&
    r1.text === MSG1 && !r1.text.includes('pasted_content'),
    JSON.stringify(r1));

  // === GATE 2 — replay with NO pending echo (wrapped record already on disk) =
  await js(`openPane({ resumeId: '${SID2}', title: 'paste-dedup-2' })`);
  await sleep(800);
  await js(`setChatView('pane-2', true)`);
  await sleep(500);
  setStatus(SID2, 'idle');

  const r2 = await waitFor(js, `(() => {
    const chat = panes.get('pane-2').chat;
    const cards = [...chat.streamEl.querySelectorAll('.chat-msg.chat-user')];
    const ok = cards.length === 1;
    const bubble = cards[0] ? cards[0].querySelector('.chat-bubble') : null;
    return { ok, cardCount: cards.length, pending: chat.pendingSends.length,
             text: bubble ? bubble.textContent : null };
  })()`);
  gate('g2: a wrapped record replayed with no pending echo renders inner text, no tags',
    !!r2 && r2.cardCount === 1 && r2.pending === 0 && r2.text === MSG2 && !r2.text.includes('pasted_content'),
    JSON.stringify(r2));

  // === GATES 3/4a/4b — anchor read: escaped / mixed / mismatched-id verbatim =
  await js(`openPane({ resumeId: '${SID3}', title: 'paste-dedup-3' })`);
  await sleep(800);
  await js(`setChatView('pane-3', true)`);
  await sleep(500);
  setStatus(SID3, 'idle');

  const textsExpr = `(() => {
    const chat = panes.get('pane-3').chat;
    const cards = [...chat.streamEl.querySelectorAll('.chat-msg.chat-user')];
    return { cardCount: cards.length,
             texts: cards.map((c) => { const b = c.querySelector('.chat-bubble'); return b ? b.textContent : null; }) };
  })()`;
  const r3 = await waitFor(js, `(() => { const r = ${textsExpr}; return Object.assign(r, { ok: r.cardCount === 3 }); })()`);
  gate('g3 anchor read renders the 3 seeded cards', !!r3 && r3.cardCount === 3, JSON.stringify(r3));
  gate('g3a escaped `<\\pasted_content` kept verbatim (not unwrapped)',
    !!r3 && r3.texts[0] === MSG3, JSON.stringify(r3 && r3.texts[0]));
  gate('g4a mixed form (typed prefix + wrapper) unchanged',
    !!r3 && r3.texts[1] === MSG4a, JSON.stringify(r3 && r3.texts[1]));
  gate('g4b mismatched open/close ids unchanged',
    !!r3 && r3.texts[2] === MSG4b, JSON.stringify(r3 && r3.texts[2]));

  // === GATES 4c/4d/5 — live append: look-alike / several wrappers / CRLF =====
  fs.appendFileSync(FIXTURE3, userLine(MSG4c));
  fs.appendFileSync(FIXTURE3, userLine(MSG4d));
  fs.appendFileSync(FIXTURE3, userLine(WRAPPED5));
  const r4 = await waitFor(js, `(() => { const r = ${textsExpr}; return Object.assign(r, { ok: r.cardCount === 6 }); })()`);
  gate('g4c non-wrapped look-alike (mentions pasted_content) unchanged',
    !!r4 && r4.texts[3] === MSG4c, JSON.stringify(r4 && r4.texts[3]));
  gate('g4d several wrappers concatenated unchanged',
    !!r4 && r4.texts[4] === MSG4d, JSON.stringify(r4 && r4.texts[4]));
  gate('g5 CRLF boundary unwraps like LF — inner text, no tags',
    !!r4 && r4.texts[5] === MSG5 && !r4.texts[5].includes('pasted_content'), JSON.stringify(r4 && r4.texts[5]));

  // === GATE 4e — two wrappers sharing an id: unchanged, tags visible =======
  fs.appendFileSync(FIXTURE3, userLine(MSG4e));
  const r4e = await waitFor(js, `(() => { const r = ${textsExpr}; return Object.assign(r, { ok: r.cardCount === 7 }); })()`);
  gate('g4e two wrappers sharing an id unchanged — visible text keeps both wrapper tags',
    !!r4e && r4e.texts[6] === MSG4e
      && r4e.texts[6].includes('<pasted_content id="1">') && r4e.texts[6].includes('</pasted_content id="1">'),
    JSON.stringify(r4e && r4e.texts[6]));

  // === GATE 6 — empty-inner / whitespace-only wrapped: no user card ========
  fs.appendFileSync(FIXTURE3, userLine(WRAPPED_EMPTY));
  fs.appendFileSync(FIXTURE3, userLine(WRAPPED_WS));
  fs.appendFileSync(FIXTURE3, userLine(WRAPPED6));
  const r6 = await waitFor(js, `(() => { const r = ${textsExpr}; return Object.assign(r, { ok: r.cardCount === 8 }); })()`);
  gate('g6 empty-inner and whitespace-only wrapped records render no user card (only the next genuine record adds one)',
    !!r6 && r6.cardCount === 8 && r6.texts[7] === MSG6, JSON.stringify(r6));

  console.log('\n=== paste-dedup probe ===');
  for (const r of results) console.log(r);
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nVERDICT: ${failed ? 'FAIL' : 'ALL GREEN'} (${passed}/${results.length})`);
  fs.writeFileSync(path.join(__dirname, 'paste-dedup-probe.out'),
    results.join('\n') + `\nVERDICT: ${failed ? 'FAIL' : 'ALL GREEN'} (${passed}/${results.length})\n`);
  app.exit(failed ? 1 : 0);
});
