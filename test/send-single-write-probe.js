// send-single-write-probe.js — Lot 1 (claude-deck-send-single-write): every
// chat-face submit must reach the PTY as ONE write (bracketed paste + '\r'
// together) when bracketed paste mode is ON, not the old pane.term.paste(text)
// + setTimeout(writeInput('\r'), SEND_CR_MS) two-write shape. [MEASURED on a real
// claude TUI]: any gap between the two writes stuck clean-box sends 4/8; zero gap
// submitted 10/10.
//
// v_next F3 (review F2, user repro "corrige ca bug" 2026-09-23): when
// bracketed paste mode is OFF (or ignoreBracketedPasteMode is true), Claude
// Code treats a CR bundled into the SAME unbracketed chunk as text as a
// literal newline, not a submit — so submitPasted's UNBRACKETED branch
// reverts to the pre-fix TWO-write shape (text, then a separately-timed lone
// CR). This probe now covers BOTH branches.
//
// v3 (review F1, blocking, 2026-09-23): capturePasteBytes()'s REAL term.paste()
// tap was itself forwarded to the fake PTY by panes.js's own onData listener,
// and callers read `startOffset` before those bytes landed in the capture
// file — so the tap leaked into the NEXT measured window (extra bytes ==
// exactly the tap's length). Fix: capturePasteBytes() now blocks until its
// own tap bytes have landed in CAP before returning (bounded wait; a timeout
// is a FAIL gate, never a silent pass), and the split-write timing gate's
// crAt is now a byte-content match (prefix+text+'\r'), not a length match.
//
// STATIC gates: the source no longer contains SEND_CR_MS; every one of the
// 7 submit sites (sendNow's paste closure + the 6 slash sites) calls the
// submitPasted() helper; UNBRACKETED_CR_MS is defined and stays below
// SEND_GAP_MS; the unbracketed branch's shape (text write, guarded delayed
// CR) is present in source.
// RUNTIME gates (fake-PTY, same pattern as dblsend-repro-probe.js):
//  - BRACKETED (mode ON, ignoreBracketedPasteMode falsy): for each site, tap
//    term.onData() (a SECOND listener alongside panes.js's own — xterm
//    supports multiple) to assert EXACTLY ONE onData event carries the whole
//    bracketed-paste+CR payload, byte-identical to a REAL term.paste(text)
//    tap on the SAME terminal/mode (never a hand-reimplemented formula) + a
//    separately-appended '\r'; the fake-PTY byte capture proves write ORDER
//    and that NOTHING MORE arrives after a >100ms settle. A closing case
//    re-checks SEND_GAP_MS chain serialization across two rapid sends.
//  - UNBRACKETED (mode OFF, or ignoreBracketedPasteMode: true): the pasted
//    text's term.onData write is byte-identical to that SAME real
//    term.paste(text) tap (this time under the unbracketed mode, so it comes
//    back with no bracket), the PTY capture shows that text immediately
//    followed by a LONE '\r' and nothing else, and that lone '\r' lands
//    >= UNBRACKETED_CR_MS and < SEND_GAP_MS after the text write (the CR
//    write itself bypasses term.input — it's a direct window.api.writeInput
//    call from a setTimeout — so its arrival is timed off the PTY capture
//    file, not off term.onData). Content cases: short text, CRLF text, and
//    text containing a raw ESC byte plus a literal '\x1b[201~' end-marker
//    substring (never mistaken for a real bracket close since this branch
//    never brackets).
//
// Run: <repo>/node_modules/.bin/electron test/send-single-write-probe.js --no-sandbox
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = false;
const results = [];
function gate(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
}
// v3 (review F1, blocking): capturePasteBytes() timeouts are collected here
// instead of a silent pass — see the gate emitted right before VERDICT.
const capWaitFails = [];

// --- STATIC gates (no Electron needed) --------------------------------------
const SRC_PATH = path.join(__dirname, '..', 'renderer', 'js', 'chat-view.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
gate('static: SEND_CR_MS timer constant is gone', !/const SEND_CR_MS/.test(src));
// Re-open 2 (contract R1-R8, send-stuck-retry-probe.js § B2): submitPasted
// gained an optional 3rd `stillPending` arg and now returns a Promise<fired>
// (R1/R4) — the signature and the sendNow paste closure shape below changed
// accordingly; both regexes are updated to the new shape, not relaxed away.
gate('static: submitPasted() helper is defined', /function submitPasted\(pane, text, stillPending\)/.test(src));
const siteRegexes = [
  ['sendNow paste closure', /let fired;\s*\n\s*try \{\s*\n\s*fired = submitPasted\(pane, text, \(\) => chat\.pendingSends\.some/],
  ["sendRoomLead ('/room-lead')", /submitPasted\(pane, '\/room-lead'\);/],
  ["startCompact ('/compact')", /submitPasted\(pane, '\/compact'\);/],
  ["startClear ('/clear')", /submitPasted\(pane, '\/clear'\);/],
  ["sendAsGoal ('/goal ' + text)", /submitPasted\(pane, '\/goal ' \+ text\);/],
  ["endGoal ('/goal clear')", /submitPasted\(pane, '\/goal clear'\);/],
  ["sendModel ('/model ' + id)", /submitPasted\(pane, '\/model ' \+ id\);/],
];
for (const [label, re] of siteRegexes) {
  gate(`static: ${label} routes through submitPasted`, re.test(src));
}
gate('static: no site still does term.paste(...) + a separate CR setTimeout',
  !/pane\.term\.paste\([^)]*\);\s*\n\s*setTimeout\(\(\) => window\.api\.writeInput/.test(src));

const unbracketedMs = Number((src.match(/const UNBRACKETED_CR_MS = (\d+)/) || [])[1]);
const sendGapMsVal = Number((src.match(/const SEND_GAP_MS = (\d+)/) || [])[1]);
// Re-open 2 (contract R4, send-stuck-retry-probe.js § B2): submitPasted now
// returns a Promise that only settles after its RETRY_CHECK_MS one-shot check
// has run, and sendNow's chain waits on that promise before releasing the
// NEXT chained send — so the chain-hold gap below is RETRY_CHECK_MS-bound,
// not SEND_GAP_MS-bound, even though the box stays invisible in this harness
// (no real TUI is ever drawn -> the check itself never fires a retry).
const retryCheckMsVal = Number((src.match(/const RETRY_CHECK_MS = (\d+)/) || [])[1]);
// The retry check polls every RETRY_POLL_MS up to RETRY_DEADLINE_MS after the arm (ca23ef8), so with an invisible box
// msg1's chain only releases msg2 at that deadline: the gap-chain case polls for msg2 up to it, never a fixed wait.
const retryDeadlineMsVal = Number((src.match(/const RETRY_DEADLINE_MS = (\d+)/) || [])[1]);
gate('static: RETRY_DEADLINE_MS is defined and is not below RETRY_CHECK_MS',
  Number.isFinite(retryDeadlineMsVal) && Number.isFinite(retryCheckMsVal) && retryDeadlineMsVal >= retryCheckMsVal,
  `RETRY_CHECK_MS=${retryCheckMsVal} RETRY_DEADLINE_MS=${retryDeadlineMsVal}`);
gate('static: UNBRACKETED_CR_MS is defined and stays below SEND_GAP_MS',
  Number.isFinite(unbracketedMs) && unbracketedMs > 0 &&
  Number.isFinite(sendGapMsVal) && unbracketedMs < sendGapMsVal,
  `UNBRACKETED_CR_MS=${unbracketedMs} SEND_GAP_MS=${sendGapMsVal}`);
gate('static: bracketed branch is still the byte-identical single write',
  src.includes("term.input('\\x1b[200~' + prepared + '\\x1b[201~' + '\\r', true);"));
gate('static: unbracketed branch writes prepared text alone, then a delayed lone CR guarded on an exited pane',
  src.includes('term.input(prepared, true);') &&
  src.includes("if (pane.el.classList.contains('exited')) return;") &&
  src.includes("window.api.writeInput(pane.paneId, '\\r');") &&
  src.includes('}, UNBRACKETED_CR_MS);'));

// --- RUNTIME setup (fake PTY, same shim as dblsend-repro-probe.js) ---------
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ssw-home-'));
process.env.HOME = FAKE_HOME;
fs.mkdirSync(path.join(FAKE_HOME, 'Documents', 'workspace'), { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

const CAP = path.join(FAKE_HOME, 'pty-capture.bin');
const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHELL_SHIM,
  `#!/bin/bash\nstty raw -echo 2>/dev/null\nprintf "\\033[?2004h"\ncat > "${CAP}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ssw-')));

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHORT = 'quick smoke check';
const LONG = 'y'.repeat(1490) + ' end'; // ~1500 chars
const MULTI = 'line one\nline two\nline three'; // 3-line text
const CRLF_TEXT = 'line one\r\nline two\r\nline three'; // CRLF must collapse via \r?\n -> \r
const ESC_TEXT = 'before esc \x1b then a literal end-marker \x1b[201~ inside the text, after';

app.whenReady().then(async () => {
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

  const bracketed = await js(`panes.get('${paneId}').term.modes.bracketedPasteMode`);
  gate('setup: fake TUI advertised bracketed paste mode', bracketed === true, `bracketed=${bracketed}`);

  // v2: also clears the DOM `disabled` state updateCompactBtn() sets on
  // compact/goal/clear (busy -> disabled) — the prior 'compact' case flips it
  // true and nothing but a real status push flips it back, so a plain state
  // reset left .cc-clear a no-op button (.click() on disabled fires nothing —
  // measured: /clear onData count=0). Probe-only fix; startClear's own guards
  // (chat-view.js:2501-2520) are untouched.
  const reset = async () => {
    // Let the previous case's send chain settle first (its retry poll runs up to RETRY_DEADLINE_MS with the box
    // invisible here), so a late chained write never leaks into the next case; bounded so a stuck chain cannot hang.
    await js(`(() => {
      const c = panes.get('${paneId}').chat;
      return Promise.race([Promise.resolve(c.sendChain).catch(() => {}),
        new Promise((r) => setTimeout(r, ${retryDeadlineMsVal + 3000}))]);
    })()`);
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
  })()`);
  };

  // Real oracle for "what would xterm's own paste() emit for this text under
  // the terminal's CURRENT mode" — replaces the old hand-reimplemented
  // prepareTextForTerminal+bracket formula (review F2). Taps a temporary
  // SECOND onData listener, fires term.paste(text) (bypasses the composer —
  // no interaction with pane.chat state), and resolves with the single
  // onData string it produced (no trailing submit '\r' — callers append it,
  // or not, per case).
  async function capturePasteBytes(text) {
    const before = fs.existsSync(CAP) ? fs.statSync(CAP).size : 0;
    const tap = await js(`(() => {
      return new Promise((resolve) => {
        const term = panes.get('${paneId}').term;
        const d = term.onData((data) => { d.dispose(); resolve(data); });
        term.paste(${JSON.stringify(text)});
      });
    })()`);
    // v3 (review F1, blocking): panes.js's own onData listener
    // (`term.onData((data) => window.api.writeInput(paneId, data))`) forwards
    // this SAME tap to the fake PTY, so the oracle bytes land in CAP
    // asynchronously (renderer -> IPC -> proc.write -> child -> disk). A
    // caller reading `fs.statSync(CAP).size` right after this promise used to
    // race that landing and count the tap inside its OWN measured window
    // (measured: extra bytes == exactly the tap's length). Block here until
    // the bytes have actually landed, so every subsequent `startOffset` read
    // is always taken after them, never mid-flight. Bounded wait; a timeout
    // is recorded as a FAIL, never a silent pass (see the gate near VERDICT).
    const need = before + Buffer.byteLength(tap, 'binary');
    const deadline = Date.now() + 500;
    let landed = false;
    while (Date.now() < deadline) {
      const size = fs.existsSync(CAP) ? fs.statSync(CAP).size : 0;
      if (size >= need) { landed = true; break; }
      await sleep(5);
    }
    if (!landed) {
      capWaitFails.push(`before=${before} tapLen=${Buffer.byteLength(tap, 'binary')} need=${need} gotSize=${fs.existsSync(CAP) ? fs.statSync(CAP).size : 0}`);
    }
    return tap;
  }

  function setBracketedMode(on) {
    return js(`new Promise((resolve) => {
      panes.get('${paneId}').term.write('\\x1b[?2004${on ? 'h' : 'l'}', () => resolve(true));
    })`);
  }

  function sendExpr(text) {
    return `(() => {
      const pane = panes.get('${paneId}');
      pane.chat.inputEl.value = ${JSON.stringify(text)};
      pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`;
  }

  // Drive one action, tapping a SECOND term.onData listener (xterm allows many)
  // to record every onData firing during the action, and the fake-PTY capture
  // file to record byte ORDER (kill bytes, then the payload) and to prove
  // nothing MORE lands after a settle wait.
  // v2: the fake shell opens the capture file ONCE at PTY spawn (`cat > CAP`)
  // and keeps writing at that single open file description's own advancing
  // offset; truncating the file via a SEPARATE fs.writeFileSync call does not
  // reset that offset, so a later truncate just left a growing sparse/NUL
  // prefix before each case's real bytes (measured: capBeforeLen growing
  // 32 -> 1541 -> 1584 -> ... across cases). Never truncate: record the file's
  // size before driving and slice from that offset instead.
  async function driveAndCapture(driveExpr, settleMs) {
    await js(`(() => {
      const term = panes.get('${paneId}').term;
      window.__cap = [];
      window.__capDispose = term.onData((d) => window.__cap.push(d));
    })()`);
    const startOffset = fs.existsSync(CAP) ? fs.statSync(CAP).size : 0;
    await sleep(50);
    await js(driveExpr);
    await sleep(settleMs);
    const capBefore = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(startOffset);
    await sleep(150); // >100ms — nothing delayed should still be arriving
    const capAfter = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(startOffset);
    const onData = await js(`(() => { window.__capDispose.dispose(); return window.__cap; })()`);
    return { onData, capBefore, capAfter };
  }

  async function assertSite(label, text, capExpectedPrefix, r) {
    gate(`${label}: exactly ONE onData event for the paste+CR`, r.onData.length === 1,
      `count=${r.onData.length}`);
    const payload = r.onData[0] || '';
    const capturedPaste = await capturePasteBytes(text); // REAL term.paste() tap, current (bracketed) mode
    const expected = capturedPaste + '\r';
    gate(`${label}: payload byte-identical to a REAL term.paste(text) tap + '\\r'`, payload === expected,
      `len=${payload.length} expLen=${expected.length}`);
    const fullExpected = capExpectedPrefix + expected;
    gate(`${label}: PTY capture = prefix (unchanged) then the ONE payload, nothing else`,
      r.capBefore === fullExpected,
      `capBeforeLen=${r.capBefore.length} expLen=${fullExpected.length}`);
    gate(`${label}: no delayed write arrives after a >100ms settle`, r.capAfter === r.capBefore,
      `beforeLen=${r.capBefore.length} afterLen=${r.capAfter.length}`);
  }

  // Unbracketed submit (F3): the settle-timed lone CR bypasses term.input
  // entirely (a direct window.api.writeInput call from a setTimeout), so it
  // never reaches a term.onData tap — its arrival is timed off the PTY
  // capture file instead. term.onData still captures the FIRST write (the
  // prepared text, via term.input), with a precise renderer-side timestamp.
  async function driveAndCaptureTimed(driveExpr, expectedFull, pollDeadlineMs) {
    await js(`(() => {
      const term = panes.get('${paneId}').term;
      window.__cap = [];
      window.__capT = [];
      window.__capDispose = term.onData((d) => { window.__cap.push(d); window.__capT.push(Date.now()); });
    })()`);
    const startOffset = fs.existsSync(CAP) ? fs.statSync(CAP).size : 0;
    await sleep(30);
    await js(driveExpr);
    // v3 (review F1): crAt is the first time the capture holds EXACTLY
    // prefix + text + '\r' — a byte-content match, not just a length match —
    // so a leaked/misplaced write of the right length can no longer be
    // mistaken for the real split-write landing.
    const deadline = Date.now() + pollDeadlineMs;
    let crAt = null;
    while (Date.now() < deadline) {
      const cur = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(startOffset);
      if (cur === expectedFull) { crAt = Date.now(); break; }
      await sleep(5);
    }
    await sleep(200); // settle past the target — anything extra would show up here
    const capBefore = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(startOffset);
    await sleep(150); // >100ms further — nothing delayed should still be arriving
    const capAfter = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(startOffset);
    const { onData, onDataT } = await js(`(() => { window.__capDispose.dispose(); return { onData: window.__cap, onDataT: window.__capT }; })()`);
    return { onData, onDataT, crAt, capBefore, capAfter };
  }

  async function assertSplitWrite(label, text, capExpectedPrefix) {
    const preparedOnly = await capturePasteBytes(text); // REAL term.paste() tap, current (unbracketed) mode
    const fullExpected = capExpectedPrefix + preparedOnly + '\r';
    const r = await driveAndCaptureTimed(sendExpr(text), fullExpected, 400);
    gate(`${label}: exactly ONE term write carries the pasted text (no CR bundled into it)`,
      r.onData.length === 1, `count=${r.onData.length}`);
    const firstWrite = r.onData[0] || '';
    gate(`${label}: that write == prepared text alone, byte-identical to a REAL term.paste() tap under this mode (no bracket)`,
      firstWrite === preparedOnly, `len=${firstWrite.length} expLen=${preparedOnly.length}`);
    gate(`${label}: PTY capture = prefix (unchanged), then the text, then a LONE CR — nothing between, nothing after`,
      r.capBefore === fullExpected,
      `capBeforeLen=${r.capBefore.length} expLen=${fullExpected.length}`);
    gate(`${label}: no extra write arrives after settle`, r.capAfter === r.capBefore,
      `beforeLen=${r.capBefore.length} afterLen=${r.capAfter.length}`);
    if (r.onDataT.length === 1 && r.crAt) {
      const delta = r.crAt - r.onDataT[0];
      gate(`${label}: lone CR lands >= UNBRACKETED_CR_MS (${unbracketedMs}ms) after the text write`,
        delta >= unbracketedMs - 25, `delta=${delta}ms`);
      gate(`${label}: lone CR lands < SEND_GAP_MS (${sendGapMsVal}ms) after the text write`,
        delta < sendGapMsVal, `delta=${delta}ms`);
    } else {
      gate(`${label}: CR write observed within the settle window`, false,
        `onDataT.length=${r.onDataT.length} crAt=${r.crAt}`);
    }
  }

  // === sendNow — clean box, short text =======================================
  await reset();
  let r = await driveAndCapture(sendExpr(SHORT), 300);
  await assertSite('sendNow clean/short', SHORT, '\x15\x0b', r);

  // === sendNow — clean box, ~1500-char text ==================================
  await reset();
  r = await driveAndCapture(sendExpr(LONG), 300);
  await assertSite('sendNow clean/long(~1500)', LONG, '\x15\x0b', r);

  // === sendNow — clean box, 3-line text =======================================
  await reset();
  r = await driveAndCapture(sendExpr(MULTI), 300);
  await assertSite('sendNow clean/3-line', MULTI, '\x15\x0b', r);

  // === sendNow — dirty box (post-interrupt restored prompt), short text ======
  await reset();
  await js(`panes.get('${paneId}').chat.dirtyAfterStop = true`);
  r = await driveAndCapture(sendExpr(SHORT), 500); // dirty path waits CLEAR_PASTE_MS (200ms) before pasting
  await assertSite('sendNow dirty/short', SHORT, '\x03', r);

  // === /room-lead ==============================================================
  await reset();
  r = await driveAndCapture(`document.querySelector('.cc-roomlead').click()`, 200);
  await assertSite('/room-lead', '/room-lead', '', r);

  // === /compact =================================================================
  await reset();
  r = await driveAndCapture(`document.querySelector('.cc-compact').click()`, 200);
  await assertSite('/compact', '/compact', '', r);

  // === /clear ====================================================================
  await reset();
  r = await driveAndCapture(`document.querySelector('.cc-clear').click()`, 200);
  await assertSite('/clear', '/clear', '', r);

  // === armed goal send ('/goal ' + text) =======================================
  await reset();
  await js(`panes.get('${paneId}').chat.goalArmed = true`);
  r = await driveAndCapture(sendExpr(SHORT), 200);
  await assertSite('armed goal send', '/goal ' + SHORT, '', r);

  // === /goal clear (endGoal, the ✕ button) =====================================
  await reset();
  r = await driveAndCapture(`document.querySelector('.cgf-close').click()`, 200);
  await assertSite('/goal clear', '/goal clear', '', r);

  // === /model <id> ================================================================
  await reset();
  // `.pane` scope: the start screen keeps its own composer (same classes) in the DOM, first in document order
  const modelId = await js(`document.querySelector('.pane .cc-model-item').dataset.model`);
  r = await driveAndCapture(`document.querySelector('.pane .cc-model-item').click()`, 200);
  await assertSite('/model', '/model ' + modelId, '', r);

  // === SEND_GAP_MS chain serialization across two rapid sends ==================
  await reset();
  const M1 = 'gap chain message one';
  const M2 = 'gap chain message two';
  const m1Bytes = await capturePasteBytes(M1);
  const m2Bytes = await capturePasteBytes(M2);
  const gapStartOffset = fs.existsSync(CAP) ? fs.statSync(CAP).size : 0; // v2: slice, never truncate — see driveAndCapture note
  await sleep(50);
  await js(`(() => {
    const pane = panes.get('${paneId}');
    pane.chat.inputEl.value = ${JSON.stringify(M1)};
    pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    pane.chat.inputEl.value = ${JSON.stringify(M2)};
    pane.chat.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(80); // well before RETRY_CHECK_MS elapses on msg1's resolve (a fortiori before the old SEND_GAP_MS too)
  const capEarly = (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(gapStartOffset);
  // R4 (chain hold): the gap is now RETRY_CHECK_MS-bound, not SEND_GAP_MS-bound
  // (see the const comment above) — msg1's chain only releases msg2 once its
  // submitPasted promise settles, i.e. after its own retry check has run.
  const exp1 = '\x15\x0b' + m1Bytes + '\r';
  const exp2 = '\x15\x0b' + m2Bytes + '\r';
  const readGap = () => (fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '').slice(gapStartOffset);
  // Bounded poll for msg2 (RETRY_DEADLINE_MS + margin), then a short settle so a stray later write would still show.
  const gapDeadline = Date.now() + retryDeadlineMsVal + 2000;
  while (!readGap().includes(exp2) && Date.now() < gapDeadline) await sleep(100);
  await sleep(300);
  const capLate = readGap();
  gate('SEND_GAP_MS: msg1 lands early, msg2 not yet', capEarly === exp1,
    `earlyLen=${capEarly.length} exp1Len=${exp1.length}`);
  gate('SEND_GAP_MS: msg2 lands after the gap, msg1 unchanged', capLate === exp1 + exp2,
    `lateLen=${capLate.length} expLen=${(exp1 + exp2).length}`);

  // === F3: unbracketed submit — bracketed paste mode OFF ========================
  await reset();
  await setBracketedMode(false);
  const offMode = await js(`panes.get('${paneId}').term.modes.bracketedPasteMode`);
  gate('setup: bracketed paste mode turned OFF for the split-write cases', offMode === false, `bracketed=${offMode}`);
  await assertSplitWrite('unbracketed OFF / short text', SHORT, '\x15\x0b');

  // === F3: unbracketed submit — ignoreBracketedPasteMode: true ==================
  await reset();
  await setBracketedMode(true); // protocol mode stays ON — the OPTION forces unbracketed
  await js(`panes.get('${paneId}').term.options.ignoreBracketedPasteMode = true`);
  const ignoreFlag = await js(`panes.get('${paneId}').term.options.ignoreBracketedPasteMode`);
  gate('setup: ignoreBracketedPasteMode option is true (protocol mode stays ON)', ignoreFlag === true, `flag=${ignoreFlag}`);
  await assertSplitWrite('ignoreBracketedPasteMode / short text', SHORT, '\x15\x0b');
  await js(`panes.get('${paneId}').term.options.ignoreBracketedPasteMode = false`);

  // === F3: unbracketed submit — CRLF text ========================================
  await reset();
  await setBracketedMode(false);
  await assertSplitWrite('unbracketed OFF / CRLF text', CRLF_TEXT, '\x15\x0b');

  // === F3: unbracketed submit — ESC byte + literal '\x1b[201~' end-marker =======
  await reset();
  await assertSplitWrite('unbracketed OFF / ESC + literal end-marker text', ESC_TEXT, '\x15\x0b');

  await setBracketedMode(true); // restore, hygiene

  gate('capturePasteBytes: every oracle tap landed in CAP before its caller read startOffset (no leak race)',
    capWaitFails.length === 0, capWaitFails.length ? capWaitFails.join(' | ') : 'no timeouts');

  console.log('\n=== send-single-write probe ===');
  for (const r2 of results) console.log(r2);
  console.log(failed ? 'VERDICT: FAIL' : 'VERDICT: PASS (all-PASS)');
  fs.writeFileSync(path.join(__dirname, 'send-single-write-probe.out'),
    results.join('\n') + '\n' + (failed ? 'VERDICT: FAIL' : 'VERDICT: PASS') + '\n');
  app.exit(failed ? 1 : 0);
});
