'use strict';
// send-stuck-retry-probe: Re-open 2 (stuck-send safety net, docs/plans/
// claude-deck-send-single-write.spec.md § "Amendment — Re-open 2"). Lot B1
// (this section) covers the parser layer only: renderer/js/tui-prompt.js's
// new read-only readComposerBox(term) export. Pure-function checks over a
// REAL xterm.js Terminal seeded from real Claude Code 2.1.281 captures —
// no window/app boot needed for this lot (same shape as ask-all-questions-
// probe.js's Lot 1). Lot B2 (chat-view.js / pty.js / preload.js: the actual
// retry) will add its own section below this one; keep ONE aggregate
// VERDICT line at the end for the whole file.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Terminal } = require('@xterm/xterm');

const ROOT = path.join(__dirname, '..');
const results = {};

// B2 needs the real RETRY_CHECK_MS value (chat-view.js) to time its waits —
// parsed from source, never hardcoded, so a future tuning of the constant
// can't silently desync the probe from production.
const CHAT_VIEW_SRC = fs.readFileSync(path.join(ROOT, 'renderer/js/chat-view.js'), 'utf8');
const RETRY_MS = Number((CHAT_VIEW_SRC.match(/const RETRY_CHECK_MS = (\d+)/) || [])[1]);
// Since ca23ef8 (retry poll) the check REPEATS every RETRY_POLL_MS until RETRY_DEADLINE_MS after the
// arm; a send whose box stays empty therefore holds the send chain for the whole deadline, not for
// RETRY_MS only (the R4 chain-hold case below waits for it). Parsed from source for the same reason.
const RETRY_DEADLINE_MS = Number((CHAT_VIEW_SRC.match(/const RETRY_DEADLINE_MS = (\d+)/) || [])[1]);

function rowsOf(name) {
  return JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test/fixtures/tui-2.1.281', name + '.json'), 'utf8')).rows;
}

// Seed a REAL xterm.js Terminal with a captured/derived screen: write every
// row then CRLF so each lands on its own buffer line, exactly what readTui/
// readComposerBox scrape from term.buffer.active in production.
function termFromRows(rows) {
  return new Promise((resolve) => {
    const term = new Terminal({ cols: 220, rows: rows.length });
    term.write(rows.join('\r\n'), () => resolve(term));
  });
}

// Mirrors tui-prompt.js's own bottomTerminalRows() — kept as a SEPARATE
// read-only copy here (the probe must not import production internals) so
// the non-regression check below can feed the exact same rawLines window to
// both the edited module and the pre-edit copy.
function rawLinesOf(term) {
  const buf = term.buffer.active;
  const lines = [];
  const start = Math.max(0, buf.length - term.rows);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function runB1(cur) {
  // --- non-regression: parseTuiMenu/readTui byte-identical to the copy of
  // tui-prompt.js saved BEFORE this lot's edit. HERMETIC (2026-09-30): this used to read
  // /tmp/tui-prompt.before-b1.js, a copy the dispatched agent dropped in /tmp and that a reboot /
  // tmp cleanup erased, which turned the gate into a permanent failure (sweep: 28/29). The original
  // pre-B1 bytes are unrecoverable (measured: the last COMMITTED version before B1, 902018b, differs
  // on c2_busy_300ms / c2_idle_reply / c4_composer_numbered / c4_after_clear because the parseTuiMenu
  // composer exclusion was still uncommitted then). The reference is therefore a PINNED BASELINE:
  // test/fixtures/tui-prompt.baseline.js = `git show 840308b:renderer/js/tui-prompt.js`. It
  // guards parseTuiMenu/readTui against any later drift (tautological at 840308b itself). If the
  // fixture is absent it is rebuilt from that pinned commit (never from HEAD, which would make
  // the gate always green); only when both are unavailable does the gate fail (never a silent skip).
  const BEFORE_FIXTURE = path.join(ROOT, 'test/fixtures/tui-prompt.baseline.js');
  const BEFORE_GIT_REF = '840308b:renderer/js/tui-prompt.js';
  let beforeSrc = null;
  if (fs.existsSync(BEFORE_FIXTURE)) {
    beforeSrc = fs.readFileSync(BEFORE_FIXTURE);
  } else {
    try {
      beforeSrc = require('child_process').execFileSync('git', ['show', BEFORE_GIT_REF], { cwd: ROOT, maxBuffer: 1 << 20 });
      fs.writeFileSync(BEFORE_FIXTURE, beforeSrc);
    } catch (_) { beforeSrc = null; }
  }
  let before = null;
  if (beforeSrc) {
    const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstr-before-'));
    fs.writeFileSync(path.join(beforeDir, 'tui-prompt.mjs'), beforeSrc);
    before = await import(pathToFileURL(path.join(beforeDir, 'tui-prompt.mjs')).href);
  }
  const REAL_CAPTURES = ['c1_idle', 'c2_busy_300ms', 'c2_idle_reply', 'c3_permission_prompt',
    'c4_composer_numbered', 'c4_after_clear', 'c5_askuserquestion'];
  if (before) {
    let ok = true;
    const diffs = [];
    for (const name of REAL_CAPTURES) {
      const term = await termFromRows(rowsOf(name));
      const raw = rawLinesOf(term);
      const a = JSON.stringify({ menu: cur.parseTuiMenu(raw), tui: cur.readTui(term) });
      const b = JSON.stringify({ menu: before.parseTuiMenu(raw), tui: before.readTui(term) });
      if (a !== b) { ok = false; diffs.push(name); }
    }
    if (!ok) console.log('  non-regression DIFF on:', diffs.join(', '));
    results['non-regression: parseTuiMenu/readTui identical to the pinned baseline 840308b (' + REAL_CAPTURES.length + ' captures)'] = ok;
  } else {
    results['non-regression: parseTuiMenu/readTui identical to the pinned baseline 840308b'] = false;
    console.log('  MISSING', BEFORE_FIXTURE, '(and git ref', BEFORE_GIT_REF + ') — cannot prove non-regression');
  }

  // --- real captures --------------------------------------------------------
  const c1 = cur.readComposerBox(await termFromRows(rowsOf('c1_idle')));
  results['c1_idle: composer visible, empty (idle placeholder hint excluded)'] =
    deepEq(c1, { visible: true, text: '' });

  const c4 = cur.readComposerBox(await termFromRows(rowsOf('c4_composer_numbered')));
  results['c4_composer_numbered: composer visible, its typed text'] =
    c4.visible === true && c4.text === '1. alpha\n2. beta\n3. gamma';

  // c2_busy_300ms / c2_idle_reply: both show a bare '❯' row (rule above,
  // rule below) — the box was cleared by the earlier submit and claude has
  // not yet drawn a new idle hint (that only happens on c1_idle, before the
  // box was ever used) — real state is visible, empty, no placeholder text.
  const c2b = cur.readComposerBox(await termFromRows(rowsOf('c2_busy_300ms')));
  results['c2_busy_300ms: composer visible, empty (cleared after submit, mid-turn)'] =
    deepEq(c2b, { visible: true, text: '' });

  const c2i = cur.readComposerBox(await termFromRows(rowsOf('c2_idle_reply')));
  results['c2_idle_reply: composer visible, empty (cleared after submit, reply done)'] =
    deepEq(c2i, { visible: true, text: '' });

  const c3 = cur.readComposerBox(await termFromRows(rowsOf('c3_permission_prompt')));
  results['c3_permission_prompt: no composer (permission menu owns bottom) -> visible false'] =
    c3.visible === false;

  const c5 = cur.readComposerBox(await termFromRows(rowsOf('c5_askuserquestion')));
  results['c5_askuserquestion: no composer (AskUserQuestion menu owns bottom) -> visible false'] =
    c5.visible === false;

  // --- derived from c1_idle: same banner/opening-rule prefix, synthetic
  // composer content + closing rule (edge shapes no single real capture
  // exercises) --------------------------------------------------------------
  const HEADER = rowsOf('c1_idle').slice(0, 6); // banner + 2 blanks + opening rule
  const RULE = HEADER[5];
  const box = (contentRows) => [...HEADER, ...contentRows, RULE, '', ''];

  // measured stuck shape (RCA): claude received "\n" + text — the '❯' row
  // itself left empty, the sent message pushed to the row(s) below it.
  const stuckMsg = 'on a pas le ticket du client, je vais devoir le chercher';
  const rStuck = cur.readComposerBox(await termFromRows(box(['❯', stuckMsg])));
  results['derived from c1_idle: stuck box (empty ❯ row + message next row) -> visible, text ends with message'] =
    rStuck.visible === true && rStuck.text.endsWith(stuckMsg);

  const wrapSegs = ['this is a fairly long message that got wrapped by the',
    'terminal onto a second visual row and even a', 'third one before the closing rule appears'];
  const rWrap = cur.readComposerBox(await termFromRows(box(['❯ ' + wrapSegs[0], wrapSegs[1], wrapSegs[2]])));
  results['derived from c1_idle: long message wrapped over 3 rows -> visible, full text joined'] =
    rWrap.visible === true && rWrap.text === wrapSegs.join('\n');

  const rPaste = cur.readComposerBox(await termFromRows(box(['❯ [Pasted text #1 +8 lines]'])));
  results['derived from c1_idle: paste placeholder row -> visible, text is the placeholder'] =
    rPaste.visible === true && rPaste.text === '[Pasted text #1 +8 lines]';

  const noCloseRows = [...HEADER, '❯ some typed text', '', '']; // no closing rule anywhere below
  const rNoClose = cur.readComposerBox(await termFromRows(noCloseRows));
  results['derived from c1_idle: composer with no closing rule below -> visible false (fail-closed)'] =
    rNoClose.visible === false;
}

// ============================================================================
// Lot B1b — a composer under a LABELED top rule (2026-10-09, fix(chat): find the
// composer box under a labeled top rule). Claude Code draws a named or resumed
// session's label INSIDE the composer's top rule: N rule glyphs, a space, the
// label, a space, one glyph (N = cols - 29 for the 26-char label below: 156 at
// 185 cols, 62 at 91 cols; real captures 2.1.293-2.1.295, send-stuck P1 harness
// dumps). The closing rule is never labeled. Before the fix readComposerBox saw
// no rule above the '❯' row, returned { visible:false } at every poll and the
// retry net logged `retry-skip box-hidden` on every named pane; parseTuiMenu's
// composer exclusion missed it the same way. Screens below are the P1 dump rows
// (idle / stuck, with and without the statusLine), real xterm.js Terminal.
// ============================================================================
async function runB1Labeled(cur) {
  const LABEL = 'Refactor du module billing';
  const labeled = (cols, label = LABEL) => '─'.repeat(cols - label.length - 3) + ' ' + label + ' ─';
  const NB = ' '; // the TUI leaves a no-break space after an empty '❯'
  const MSG = 'ping n6fe83f0d0c short deck send check, please ignore this lin';
  const HIST = ['', '❯ ping na6f1d26208 short deck send check, please ignore this lin', '',
    '❯ ping nfb0ae94c09 short deck send check, please ignore this lin', '']; // echoed history: '❯' rows with a blank above, never a composer
  const FOOT = '  ⏵⏵ auto mode on (shift+tab to cycle)';
  const SL = ['  Opus 5.5  ·  📂 work/shared', '  Context  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  0%   0/1.0M  ·  ⚡ rtk ↓0 0%', '  📋 —'];
  const hint = (cols) => ' '.repeat(cols - 28) + '◐ medium · /effort';
  const screen = (cols, top, body, tail = [FOOT]) =>
    [...Array(8).fill(''), ...HIST, hint(cols), top, ...body, '─'.repeat(cols), ...tail];

  for (const cols of [185, 91]) {
    const tag = cols + ' cols';
    const rIdle = cur.readComposerBox(await termFromRows(screen(cols, labeled(cols), ['❯' + NB])));
    results['B1b labeled top rule, idle, ' + tag + ': composer visible, empty'] =
      deepEq(rIdle, { visible: true, text: '' });

    const rStuck = cur.readComposerBox(await termFromRows(screen(cols, labeled(cols), ['❯' + NB, '  ' + MSG])));
    results['B1b labeled top rule, stuck, ' + tag + ': composer visible, text is the stuck message'] =
      deepEq(rStuck, { visible: true, text: '\n' + MSG });

    const rSl = cur.readComposerBox(await termFromRows(screen(cols, labeled(cols), ['❯' + NB, '  ' + MSG], [...SL, FOOT])));
    results['B1b labeled top rule, stuck, statusLine rows below, ' + tag + ': composer visible, text is the stuck message'] =
      deepEq(rSl, { visible: true, text: '\n' + MSG });
  }

  const rTrunc = cur.readComposerBox(await termFromRows(
    screen(185, '─'.repeat(150) + ' Très long nom de session tronqué par la rè… ─', ['❯' + NB, '  ' + MSG])));
  results['B1b labeled top rule with a truncated label (ends in an ellipsis): composer visible'] =
    deepEq(rTrunc, { visible: true, text: '\n' + MSG });

  const rHeavy = cur.readComposerBox(await termFromRows(screen(91, '━'.repeat(62) + ' ' + LABEL + ' ━', ['❯ ' + MSG])));
  results['B1b labeled heavy top rule: composer visible, its text'] =
    deepEq(rHeavy, { visible: true, text: MSG });

  const wrapSegs = ['a message that the terminal wrapped', 'over a second visual row and', 'a third one before the closing rule'];
  const rWrap = cur.readComposerBox(await termFromRows(screen(91, labeled(91), ['❯ ' + wrapSegs[0], '  ' + wrapSegs[1], '  ' + wrapSegs[2]])));
  results['B1b labeled top rule, text wrapped over 3 rows: composer visible, rows joined'] =
    deepEq(rWrap, { visible: true, text: wrapSegs.join('\n') });

  // parseTuiMenu composer exclusion: unsent numbered text in a named session's composer is NOT a live menu.
  // Derived from the real c4_composer_numbered capture (rows 5..9 = rule / '❯ 1. alpha' / 2 / 3 / rule), only the top rule relabeled.
  const c4rows = rowsOf('c4_composer_numbered');
  const c4labeled = c4rows.map((r, i) => (i === 5 ? labeled(200) : r));
  const mUn = cur.parseTuiMenu(rawLinesOf(await termFromRows(c4rows)));
  results['B1b control c4_composer_numbered (unlabeled top rule): parseTuiMenu null (composer exclusion)'] = mUn === null;
  const mLab = cur.parseTuiMenu(rawLinesOf(await termFromRows(c4labeled)));
  results['B1b c4_composer_numbered under a labeled top rule: parseTuiMenu null (composer exclusion)'] = mLab === null;
  const cLab = cur.readComposerBox(await termFromRows(c4labeled));
  results['B1b c4_composer_numbered under a labeled top rule: readComposerBox visible, its typed text'] =
    cLab.visible === true && cLab.text === '1. alpha\n2. beta\n3. gamma';

  // A live blocking menu is still a menu: the real permission / AskUserQuestion captures carry no composer row.
  for (const name of ['c3_permission_prompt', 'c5_askuserquestion']) {
    const m = cur.parseTuiMenu(rawLinesOf(await termFromRows(rowsOf(name))));
    results['B1b ' + name + ': still a live menu (not swallowed by the labeled-rule exclusion)'] =
      !!m && m.options.length >= 2;
  }

  // NEGATIVE: a labeled-rule-shaped row is only a composer top rule when a '❯' row sits RIGHT below it.
  const RULE = '─'.repeat(91);
  const note = '──── note ────';
  const rNoteBare = cur.readComposerBox(await termFromRows([...Array(6).fill(''), note, 'some prose right below the note', '', '']));
  results['B1b negative: "──── note ────" with no ❯ row anywhere -> visible false'] = rNoteBare.visible === false;

  const rNoteGap = cur.readComposerBox(await termFromRows([...Array(6).fill(''), note, 'prose in between', '❯ typed text', RULE, '']));
  results['B1b negative: "──── note ────" two rows above a ❯ row -> visible false'] = rNoteGap.visible === false;

  const rNoteMenu = cur.parseTuiMenu(rawLinesOf(await termFromRows(
    [...Array(6).fill(''), 'Which one?', '❯ 1. first', '  2. second', note, ''])));
  results['B1b negative: a ❯ menu with a note row elsewhere is still a menu (no composer above it)'] =
    !!rNoteMenu && rNoteMenu.options.length === 2;

  const rNoteThenReal = cur.readComposerBox(await termFromRows(
    [...Array(4).fill(''), note, 'prose', RULE, '❯ the real box', RULE, '']));
  results['B1b negative: a note row above prose does not hide the real unlabeled composer below'] =
    deepEq(rNoteThenReal, { visible: true, text: 'the real box' });

  const rShortGlyphs = cur.readComposerBox(await termFromRows(screen(91, '─ ' + LABEL + ' ─', ['❯ ' + MSG])));
  results['B1b negative: a label between single glyphs (fewer than 3 leading) is not a top rule -> visible false'] =
    rShortGlyphs.visible === false;

  const rOpenClosing = cur.readComposerBox(await termFromRows(
    [...Array(6).fill(''), labeled(91), '❯ some typed text', note, '']));
  results['B1b negative: the CLOSING rule stays a pure rule (a labeled row below the text closes nothing) -> visible false'] =
    rOpenClosing.visible === false;
}

// ============================================================================
// Lot B2 — chat-view.js one-shot stuck-send retry (spec § Amendment — Re-open
// 2, contract R1-R8). Full Electron app boot is required here, unlike B1: the
// retry path is driven through the REAL sendNow/submitPasted/fireRetryCheck
// code, which only exists on a REAL pane.chat + a REAL xterm Terminal, post
// app-boot. The fake shell (same no-op shim as the other send-path probes)
// never draws a real Claude Code TUI, so every composer/menu screen this
// section needs is SEEDED directly into the pane's OWN xterm buffer, DERIVED
// from the same c1_idle capture B1 used (renderer/js/tui-prompt.js
// readComposerBox header comment) — never a hand-drawn screen. Seeded rows
// are top-padded to the pane's REAL term.rows so the box always lands at the
// bottom of the scraped window regardless of the live window's own size (a
// fixed-size fresh Terminal, B1's trick, isn't available here — this is the
// pane's persistent, already-open terminal). window.api.writeInput is
// WRAPPED (never replaced — the real IPC call still fires underneath, so
// every other app behavior stays live) to RECORD every call (paneId, data,
// tag, t): a tagged 'retry-cr' write is byte-identical to any other lone
// '\r' in the raw fake-PTY stream, so the tag is the only thing that tells
// them apart.
// ============================================================================
async function runB2() {
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sstr-b2-home-'));
  process.env.HOME = FAKE_HOME;
  fs.mkdirSync(path.join(FAKE_HOME, 'Documents', 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });
  // MEASURED (this dispatch): window.api is Object.freeze()'d by
  // contextBridge.exposeInMainWorld (preload.js) — a `window.api.writeInput =
  // <wrapper>` re-assignment from the renderer main world silently no-ops
  // (isFrozen===true, no throw, original function kept). So B2 does NOT drive
  // through a "recording fake window.api" wrapper; it uses the SAME real
  // fake-PTY byte-capture file send-single-write-probe.js already proves this
  // exact send path with (CAP, offset-sliced per case) — a tagged 'retry-cr'
  // write is just a lone '\r' byte, so "did it fire" is read directly off
  // the capture: baseline = bytes settled well before RETRY_CHECK_MS elapses
  // (the whole submit sequence, every branch, always completes inside 300ms);
  // fired = baseline + exactly one more '\r' and nothing else, after waiting
  // past RETRY_CHECK_MS.
  const CAP = path.join(FAKE_HOME, 'pty-capture.bin');
  const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
  fs.writeFileSync(SHELL_SHIM,
    `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf "\\033[?2004h"\ncat > "${CAP}"\n`,
    { mode: 0o755 });
  process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
  process.env.CLAUDE_DECK_AI_URL = 'about:blank';

  require(path.join(ROOT, 'main.js'));
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sstr-b2-')));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await app.whenReady();
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`document.getElementById('ns-send').click()`); // start screen: default dir, no name
  await sleep(1800); // let the shim emit 2004h and xterm parse it
  const paneId = await js(`[...panes.keys()][0]`);
  await js(`setChatView('${paneId}', true)`);
  await sleep(400);

  const bracketed0 = await js(`panes.get('${paneId}').term.modes.bracketedPasteMode`);
  results['B2 setup: fake TUI advertised bracketed paste mode'] = bracketed0 === true;

  const realRows = await js(`panes.get('${paneId}').term.rows`);

  const RULE = rowsOf('c1_idle').slice(0, 6)[5]; // the composer's own opening-rule glyph line (same derivation B1 used)
  const box = (contentRows) => [RULE, ...contentRows, RULE, '', ''];
  const EMPTY_BOX = box(['❯']);
  const menuRows = rowsOf('c3_permission_prompt');

  function capSize() { return fs.existsSync(CAP) ? fs.statSync(CAP).size : 0; }
  function capSlice(off) { return fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary').slice(off) : ''; }

  // Writes `rows` at the BOTTOM of the pane's real terminal (top-padded with
  // blanks to realRows so a taller live window can't strand the box above
  // the scraped tail), then restores bracketedPasteMode to `bracketedOn`
  // (term.reset() clears it to the terminal default OFF).
  async function seed(rows, bracketedOn = true) {
    const padded = rows.length < realRows ? [...Array(realRows - rows.length).fill(''), ...rows] : rows;
    await js(`new Promise((resolve) => {
      const term = panes.get('${paneId}').term;
      term.reset();
      term.write(${JSON.stringify(padded.join('\r\n'))}, () => {
        term.write('\\x1b[?2004${bracketedOn ? 'h' : 'l'}', resolve);
      });
    })`);
  }

  async function reset() {
    await js(`(() => {
      const p = panes.get('${paneId}');
      const c = p.chat;
      c.pendingSends = []; c.queue = []; c.inputEl.value = '';
      c.stopRequested = 0; c.lastStatus = 'idle'; c.settled = false;
      c.dirtyAfterStop = false; c.goalArmed = false; c.compacting = false;
      c.clearing = false; c.askEl.hidden = true; c.inputEl.disabled = false;
      if (c.compactBtn) c.compactBtn.disabled = false;
      if (c.goalBtn) c.goalBtn.disabled = false;
      if (c.clearBtn) c.clearBtn.disabled = false;
      c.sendChain = Promise.resolve(); c.streamEl.textContent = '';
      p.el.classList.remove('exited');
    })()`);
    await seed(EMPTY_BOX);
  }

  function sendExpr(text) {
    return `(() => {
      const pane = panes.get('${paneId}');
      pane.chat.inputEl.value = ${JSON.stringify(text)};
      pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`;
  }

  // Drives `driveExpr`, waits 300ms (every submit-sequence branch — bracketed
  // single write, or unbracketed text + its own UNBRACKETED_CR_MS=90ms lone
  // CR — always settles well inside that), captures the baseline bytes, then
  // runs `arrangeFn` (seed a screen / flip a chat flag / …), waits past
  // RETRY_CHECK_MS, and reports whether exactly one extra lone '\r' landed.
  async function driveAndCheckRetry(driveExpr, arrangeFn) {
    const startOffset = capSize();
    await js(driveExpr);
    await sleep(300);
    const baseline = capSlice(startOffset);
    if (arrangeFn) await arrangeFn();
    await sleep(RETRY_MS + 500);
    const after = capSlice(startOffset);
    return { fired: after === baseline + '\r', none: after === baseline, baseline, after };
  }

  // === case: stuck box (measured Re-open 2 shape — the '❯' row itself empty,
  // the sent text pushed to the row below it) + still pending -> exactly one
  // retry-cr ~RETRY_CHECK_MS after the submit write ============================
  await reset();
  const MSG1 = 'stuck message needs the retry';
  let res = await driveAndCheckRetry(sendExpr(MSG1), () => seed(box(['❯', MSG1])));
  results['B2 case stuck+pending: exactly one retry-cr (lone \\r) fired'] = res.fired;

  // === case: paste placeholder -> one ==========================================
  await reset();
  const MSG2 = 'a message that got pasted as a block';
  res = await driveAndCheckRetry(sendExpr(MSG2), () => seed(box(['❯ [Pasted text #1 +8 lines]'])));
  results['B2 case placeholder box: exactly one retry-cr fired'] = res.fired;

  // === case: empty box -> none =================================================
  await reset();
  res = await driveAndCheckRetry(sendExpr('nothing should fire for this one'), () => seed(EMPTY_BOX));
  results['B2 case empty box: no retry-cr'] = res.none;

  // === case: menu open -> none ==================================================
  await reset();
  res = await driveAndCheckRetry(sendExpr('a menu is covering the composer'), () => seed(menuRows));
  results['B2 case menu open (c3_permission_prompt): no retry-cr'] = res.none;

  // === case: box holds a DIFFERENT text -> none ================================
  await reset();
  res = await driveAndCheckRetry(sendExpr('the real sent message'),
    () => seed(box(['❯', 'a totally unrelated line of text'])));
  results['B2 case different text in box: no retry-cr'] = res.none;

  // === case: still stuck after the retry -> no SECOND CR (structural: only
  // ONE check is ever scheduled per submitPasted call) =========================
  await reset();
  const MSG6 = 'still stuck even after the one retry fires';
  const startOffset6 = capSize();
  await js(sendExpr(MSG6));
  await sleep(300);
  const baseline6 = capSlice(startOffset6);
  await seed(box(['❯', MSG6]));
  await sleep(RETRY_MS + 500);
  const afterFirst6 = capSlice(startOffset6);
  await sleep(RETRY_MS + 500); // long past the one-shot check — nothing else is armed, box still stuck
  const afterSecond6 = capSlice(startOffset6);
  results['B2 case still stuck after retry: exactly one fired, never a second'] =
    afterFirst6 === baseline6 + '\r' && afterSecond6 === afterFirst6;

  // === case: pane exited before the check runs -> none =========================
  await reset();
  res = await driveAndCheckRetry(sendExpr('pane will exit before the check'), async () => {
    await seed(box(['❯', 'pane will exit before the check']));
    await js(`panes.get('${paneId}').el.classList.add('exited')`);
  });
  results['B2 case exited pane: no retry-cr'] = res.none;
  await js(`panes.get('${paneId}').el.classList.remove('exited')`);

  // === case: echo confirmed BEFORE the check runs -> none (sendNow's
  // stillPending predicate reads chat.pendingSends live) =======================
  await reset();
  res = await driveAndCheckRetry(sendExpr('this echo confirms before the check'), async () => {
    await seed(box(['❯', 'this echo confirms before the check']));
    await js(`panes.get('${paneId}').chat.pendingSends = []`); // simulates resolvePending()
  });
  results['B2 case echo confirmed before check (sendNow stillPending): no retry-cr'] = res.none;

  // === case: interrupt — dirtyAfterStop -> none (firing would RE-SUBMIT the
  // prompt Esc restored into the box) ===========================================
  await reset();
  res = await driveAndCheckRetry(sendExpr('interrupted by an Esc'), async () => {
    await seed(box(['❯', 'interrupted by an Esc']));
    await js(`panes.get('${paneId}').chat.dirtyAfterStop = true`);
  });
  results['B2 case interrupt (dirtyAfterStop): no retry-cr'] = res.none;

  // === case: interrupt — stopRequested !== 0 -> none ===========================
  await reset();
  res = await driveAndCheckRetry(sendExpr('interrupted, stop window still open'), async () => {
    await seed(box(['❯', 'interrupted, stop window still open']));
    await js(`panes.get('${paneId}').chat.stopRequested = Date.now()`);
  });
  results['B2 case interrupt (stopRequested): no retry-cr'] = res.none;

  // === case: first-write bytes of BOTH branches unchanged (R6) — oracle is a
  // REAL term.paste() tap, exactly like send-single-write-probe.js, landing-
  // race-safe (blocks until the tap's own bytes reach CAP before returning,
  // same v3 fix that probe applies) =============================================
  async function capturePasteBytes(text) {
    const before = capSize();
    const tap = await js(`new Promise((resolve) => {
      const term = panes.get('${paneId}').term;
      const d = term.onData((data) => { d.dispose(); resolve(data); });
      term.paste(${JSON.stringify(text)});
    })`);
    const need = before + Buffer.byteLength(tap, 'binary');
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && capSize() < need) await sleep(5);
    return tap;
  }

  // === case: two rapid sendNow -> msg2's write lands only AFTER msg1's own
  // check has run (R4 chain hold), not after the old bare SEND_GAP_MS =========
  await reset();
  const M1 = 'gap chain b2 message one';
  const M2 = 'gap chain b2 message two';
  const m1Bytes = await capturePasteBytes(M1);
  const m2Bytes = await capturePasteBytes(M2);
  const startOffset10 = capSize();
  await js(`(() => {
    const pane = panes.get('${paneId}');
    pane.chat.inputEl.value = ${JSON.stringify(M1)};
    pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    pane.chat.inputEl.value = ${JSON.stringify(M2)};
    pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  const capEarly = capSlice(startOffset10);
  const exp1 = '\x15\x0b' + m1Bytes + '\r';
  await sleep(RETRY_DEADLINE_MS + 800); // past msg1's whole chain hold (its box stays empty from reset() -> its own poll never fires and runs to RETRY_DEADLINE_MS since ca23ef8)
  const capLate = capSlice(startOffset10);
  const exp2 = '\x15\x0b' + m2Bytes + '\r';
  results['B2 case rapid sendNow: msg1 written early, msg2 not yet'] = capEarly === exp1;
  results["B2 case rapid sendNow: msg2 lands only after msg1's check (R4 chain hold)"] = capLate === exp1 + exp2;

  // === case: a slash site (e.g. /compact) stuck -> one =========================
  await reset();
  res = await driveAndCheckRetry(`document.querySelector('.cc-compact').click()`, () => seed(box(['❯', '/compact'])));
  results['B2 case slash site (/compact) stuck: exactly one retry-cr'] = res.fired;

  // === case R6: bracketed branch's first write byte-identical to a real
  // term.paste() tap + CR ========================================================
  await reset(); // leaves bracketedPasteMode ON (seed()'s default)
  const M12 = 'first write bytes must stay identical';
  const bracketedTap = await capturePasteBytes(M12);
  const startOffset12a = capSize();
  await js(sendExpr(M12));
  await sleep(300);
  const got12a = capSlice(startOffset12a);
  results['B2 case R6 bracketed first write byte-identical to a real term.paste() tap + CR'] =
    got12a === '\x15\x0b' + bracketedTap + '\r';

  // === case R6: unbracketed branch's first write byte-identical to a real
  // term.paste() tap under that mode (no CR bundled), lone CR follows ==========
  await reset();
  await js(`new Promise((resolve) => panes.get('${paneId}').term.write('\\x1b[?2004l', resolve))`); // bracketed paste OFF
  const unbracketedTap = await capturePasteBytes(M12);
  const startOffset12b = capSize();
  await js(sendExpr(M12));
  await sleep(300); // past the text write AND the UNBRACKETED_CR_MS(90ms)-delayed lone CR
  const got12b = capSlice(startOffset12b);
  results['B2 case R6 unbracketed first write byte-identical to a real term.paste() tap, lone CR follows'] =
    got12b === '\x15\x0b' + unbracketedTap + '\r';

  console.log('  B2 R8 (vibe-check fold, spec § Amendment — Re-open 2, Open/Decisive-open): queued/busy composer box has no real 2.1.281 capture available -> UNVERIFIED, not inferred safe.');

  // ============================================================================
  // S1/S2 — R9 (T2 review F1, DEFECT-FIX, 2026-09-24): PERMANENT attack-class
  // gates (project convention: a found bug class stays in the probe forever).
  // fireRetryCheck used to read the CURRENT stop flags, which LATER events
  // clear: sendNow resets stopRequested/consumes dirtyAfterStop, an idle push
  // resets stopRequested — so an armed retry from a STOPPED send could fire
  // AFTER the stop, re-submitting it. Driven through the REAL handlers (Esc
  // keydown -> interruptClaude, cvNotifySessionStatus push, Enter keydown ->
  // sendMessage/sendNow), exactly like the reviewer's reproduction. Asserts no
  // lone '\r' lands between the Esc byte and the next write.
  // ============================================================================
  const sid = await js(`panes.get('${paneId}').sessionId`);
  const enterExpr = (text) => `(() => {
    const c = panes.get('${paneId}').chat;
    c.inputEl.value = ${JSON.stringify(text)};
    c.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`;
  const escExpr = `panes.get('${paneId}').chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;

  // === S1: sendNow — send A, working push, Esc (dirty armed), idle push
  // (real handler resets stopRequested), send B — A's retry check must NOT
  // fire a lone CR into the restored A before B's Ctrl+C clear ================
  await reset();
  const S1A = 'message the user stopped';
  const S1B = 'corrected message';
  let offS1 = capSize();
  await js(enterExpr(S1A));
  await sleep(150);
  const baseS1 = capSlice(offS1);
  await js(`cvNotifySessionStatus(${JSON.stringify(sid)}, 'working')`);
  await seed(box(['❯', S1A])); // Claude restores the interrupted prompt into its box
  await js(escExpr);
  // user starts drafting B — inputEl.value non-empty blocks reclaimPendingSends'
  // "never clobber a draft" guard, exactly like the reviewer's reproduction, so
  // pendingSends (and A's stillPending predicate) survive to the idle push below
  await js(`panes.get('${paneId}').chat.inputEl.value = 'corr'`);
  await js(`cvNotifySessionStatus(${JSON.stringify(sid)}, 'idle')`);
  await js(enterExpr(S1B));
  await sleep(RETRY_MS + 1000);
  const tailS1 = capSlice(offS1).slice(baseS1.length);
  console.log('  S1 bytes after A write=', JSON.stringify(tailS1).slice(0, 200));
  results['S1 (R9 permanent gate, sendNow): no lone CR fires between Esc and B\'s Ctrl+C'] = !/^\x1b\r\x03/.test(tailS1);

  // === S2: slash site (/room-lead) from rest — Esc, idle push (real handler
  // resets stopRequested) — the retry check must NOT fire a lone CR =========
  await reset();
  let offS2 = capSize();
  await js(`document.querySelector('.cc-roomlead').click()`);
  await sleep(150);
  const baseS2 = capSlice(offS2);
  await seed(box(['❯', '/room-lead']));
  await js(escExpr);
  await js(`cvNotifySessionStatus(${JSON.stringify(sid)}, 'idle')`);
  await sleep(RETRY_MS + 800);
  const tailS2 = capSlice(offS2).slice(baseS2.length);
  console.log('  S2 bytes after write=', JSON.stringify(tailS2).slice(0, 200));
  results['S2 (R9 permanent gate, slash /room-lead): no lone CR fires after Esc'] = !/^\x1b\r/.test(tailS2);
}

async function main() {
  const curDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstr-cur-'));
  fs.copyFileSync(path.join(ROOT, 'renderer/js/tui-prompt.js'), path.join(curDir, 'tui-prompt.mjs'));
  const cur = await import(pathToFileURL(path.join(curDir, 'tui-prompt.mjs')).href);

  await runB1(cur);
  await runB1Labeled(cur);
  await runB2();

  let allPass = true;
  for (const [name, pass] of Object.entries(results)) {
    console.log((pass ? 'PASS' : 'FAIL') + ': ' + name);
    if (!pass) allPass = false;
  }
  console.log('VERDICT: ' + (allPass ? 'ALL GREEN' : 'SOME FAILED') + ' (' + Object.values(results).filter(Boolean).length + '/' + Object.keys(results).length + ')');
  // B2 boots the real Electron app (an open BrowserWindow) — process.exit()
  // still forces a clean shutdown regardless, same as every other probe here.
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('PROBE CRASH:', err && err.stack || err);
  process.exit(1);
});
