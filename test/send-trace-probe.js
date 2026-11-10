// send-trace-probe.js — DoD 5 (claude-deck-send-single-write spec): the
// diagnostic send trace in src/main/ipc/pty.js.
//
// Drives the REAL pty.js handlers via window.api.openTerminal/writeInput
// (preload's IPC bridge — no chat-view.js involved) against a fake `claude`
// shell shim that behaves like the real TUI on the wire:
//   - emits \x1b[?2004h immediately (bracketed paste ON)
//   - then emits \x1b[?2004l SPLIT across two separate writes 400ms apart
//     (\x1b[?20 then 04l) to exercise the cross-chunk tail buffer
//   - captures every byte written to its stdin verbatim to a file (CAP),
//     the ground truth for "bytes/timing to the PTY are unchanged".
//
// Assertions (see spec DoD 5):
//   1. mode tracking across the split \x1b[?20 + 04l chunk (2 transitions,
//      unknown->on->off, each logged exactly once)
//   2. one JSON line per submit-shaped write, right kind/len/lines/modeAtWrite
//   3. no line for a plain keystroke
//   4. no message text anywhere in the trace file
//   5. bytes reaching the PTY (CAP) are byte-identical to every writeInput
//      payload sent, in order — trace never mutates or delays them
//   6. rotation at the 1 MB cap
//   7. a throwing fs.appendFileSync never blocks/throws into the PTY write
//
// Run: <repo>/node_modules/.bin/electron test/send-trace-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-trace-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

const CAP = path.join(FAKE_HOME, 'pty-capture.bin');
const SHELL_SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
// stty raw -echo (real TUI raw mode); bracketed-paste ON immediately; then a
// SPLIT bracketed-paste OFF 400ms later (two separate writes, 400ms apart);
// then capture every byte written to stdin (our pty-input writes) verbatim.
fs.writeFileSync(SHELL_SHIM,
  '#!/bin/bash\n' +
  'stty raw -echo 2>/dev/null\n' +
  "printf '\\033[?2004h'\n" +
  'sleep 0.4\n' +
  "printf '\\033[?20'\n" +
  'sleep 0.4\n' +
  "printf '04l'\n" +
  `cat > "${CAP}"\n`,
  { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHELL_SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

require(path.join(__dirname, '..', 'main.js'));
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-trace-userdata-'));
require('electron').app.setPath('userData', USER_DATA);
const TRACE_FILE = path.join(USER_DATA, 'send-trace.jsonl');
const TRACE_FILE_1 = `${TRACE_FILE}.1`;

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const results = [];
function gate(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
}

function readTraceLines(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return raw.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  });
}

const PANE_ID = 'probe-pane-1';
// Message-like substrings that must NEVER leak into the trace file.
const SECRETS = ['hello world', 'hello', 'line1', 'line2', 'partial'];

app.whenReady().then(async () => {
  await sleep(1200); // app boot settle (mirrors dblsend-repro-probe)
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  const openRes = await js(
    `window.api.openTerminal({ paneId: '${PANE_ID}', cwd: ${JSON.stringify(WS)}, cols: 80, rows: 24 })`
  );
  gate('setup: pane opened', !!(openRes && openRes.ok), JSON.stringify(openRes));

  const write = (data, tag) => js(`window.api.writeInput('${PANE_ID}', ${JSON.stringify(data)}` +
    `${tag !== undefined ? ', ' + JSON.stringify(tag) : ''})`);

  // Sent bytes, in order — the single source of truth for the CAP comparison.
  const sent = [];
  const send = async (data, waitMs, tag) => {
    sent.push(data);
    await write(data, tag);
    if (waitMs) await sleep(waitMs);
  };
  const capSize = () => { try { return fs.statSync(CAP).size; } catch (_) { return 0; } };
  const capBytesSince = (offset) => {
    try { return fs.readFileSync(CAP).slice(offset).toString('binary'); } catch (_) { return ''; }
  };

  // --- Phase A: mode = on (immediately after \x1b[?2004h) -------------------
  await sleep(200); // safely after t≈0 2004h, safely before t≈800ms split-off completes
  const W1 = '\x1b[200~hello world\x1b[201~\r';
  await send(W1, 150);

  const K1 = 'a'; // plain keystroke — never submit-shaped
  const linesBeforeK1 = readTraceLines(TRACE_FILE).length;
  await send(K1, 150);
  const linesAfterK1 = readTraceLines(TRACE_FILE).length;
  gate('no trace line for a plain keystroke', linesAfterK1 === linesBeforeK1,
    `before=${linesBeforeK1} after=${linesAfterK1}`);

  // --- Phase B: wait past the split off-sequence (mode -> off) --------------
  await sleep(700); // t is now well past 800ms since spawn: 2004l fully applied

  const W2 = 'hello\r';
  await send(W2, 100);
  const W3 = '\r';
  await send(W3, 100);
  const W4 = 'line1\rline2\r';
  await send(W4, 100);
  const W5 = '\x1b[200~partial\x1b[201~';
  await send(W5, 150);

  // --- Assertions: mode + submit-write lines ---------------------------------
  const allLines = readTraceLines(TRACE_FILE);
  const modeLines = allLines.filter((l) => l && l.kind === 'mode');
  const writeLines = allLines.filter((l) => l && l.kind !== 'mode');

  gate('exactly 2 mode transitions logged (unknown->on, on->off)', modeLines.length === 2,
    JSON.stringify(modeLines));
  if (modeLines.length === 2) {
    gate('mode transition #1 is bracketed:true', modeLines[0].bracketed === true, JSON.stringify(modeLines[0]));
    gate('mode transition #2 is bracketed:false', modeLines[1].bracketed === false, JSON.stringify(modeLines[1]));
    gate('mode lines carry the paneId', modeLines[0].paneId === PANE_ID && modeLines[1].paneId === PANE_ID);
  }

  const expected = [
    { kind: 'bracketed+cr', len: W1.length, lines: 0, modeAtWrite: 'on' },
    { kind: 'text+cr', len: W2.length, lines: 0, modeAtWrite: 'off' },
    { kind: 'lone-cr', len: W3.length, lines: 0, modeAtWrite: 'off' },
    { kind: 'text+cr', len: W4.length, lines: 1, modeAtWrite: 'off' },
    { kind: 'bracketed-no-cr', len: W5.length, lines: 0, modeAtWrite: 'off' },
  ];
  gate('exactly one JSON line per submit-shaped write', writeLines.length === expected.length,
    `got ${writeLines.length}, expected ${expected.length}: ${JSON.stringify(writeLines)}`);
  expected.forEach((exp, i) => {
    const got = writeLines[i];
    const ok = got && got.kind === exp.kind && got.len === exp.len
      && got.lines === exp.lines && got.modeAtWrite === exp.modeAtWrite
      && got.paneId === PANE_ID && typeof got.ts === 'string';
    gate(`write #${i + 1} (${exp.kind}) shape matches`, ok,
      `expected ${JSON.stringify(exp)} got ${JSON.stringify(got)}`);
  });

  const rawTraceText = fs.readFileSync(TRACE_FILE, 'utf8');
  const leaked = SECRETS.filter((s) => rawTraceText.includes(s));
  gate('no message text anywhere in the trace file', leaked.length === 0, JSON.stringify(leaked));

  // --- Phase B2: tag whitelist (Re-open 2 Lot A, contract R5) ----------------
  const linesBeforeTag = readTraceLines(TRACE_FILE).length;

  // tagged 'retry-cr' + data === '\r' -> exactly one retry-cr row, same fields.
  const capOffWT1 = capSize();
  const WT1 = '\r';
  await send(WT1, 150, 'retry-cr');
  const capBytesWT1 = capBytesSince(capOffWT1);
  const afterWT1 = readTraceLines(TRACE_FILE);
  const wt1Line = afterWT1[afterWT1.length - 1];
  gate('tagged retry-cr on lone CR -> retry-cr row',
    afterWT1.length === linesBeforeTag + 1 && wt1Line && wt1Line.kind === 'retry-cr'
    && wt1Line.len === WT1.length && wt1Line.lines === 0
    && wt1Line.modeAtWrite === 'off' && wt1Line.paneId === PANE_ID,
    JSON.stringify(wt1Line));

  // tagged 'retry-cr' on non-CR data -> tag ignored, normal classifySubmitWrite kind.
  const WT2 = 'hello\r';
  await send(WT2, 100, 'retry-cr');
  const afterWT2 = readTraceLines(TRACE_FILE);
  const wt2Line = afterWT2[afterWT2.length - 1];
  gate('tagged retry-cr on non-CR data -> normal kind (tag ignored)',
    afterWT2.length === linesBeforeTag + 2 && wt2Line && wt2Line.kind === 'text+cr',
    JSON.stringify(wt2Line));

  // unrecognised tag value on a lone CR -> tag ignored, normal lone-cr kind.
  const WT3 = '\r';
  await send(WT3, 100, 'some-other-tag');
  const afterWT3 = readTraceLines(TRACE_FILE);
  const wt3Line = afterWT3[afterWT3.length - 1];
  gate('unknown tag value -> normal kind (lone-cr), tag ignored',
    afterWT3.length === linesBeforeTag + 3 && wt3Line && wt3Line.kind === 'lone-cr',
    JSON.stringify(wt3Line));

  // untagged '\r' still -> lone-cr, unchanged.
  const capOffWT4 = capSize();
  const WT4 = '\r';
  await send(WT4, 150);
  const capBytesWT4 = capBytesSince(capOffWT4);
  const afterWT4 = readTraceLines(TRACE_FILE);
  const wt4Line = afterWT4[afterWT4.length - 1];
  gate('untagged lone CR -> lone-cr unchanged',
    afterWT4.length === linesBeforeTag + 4 && wt4Line && wt4Line.kind === 'lone-cr',
    JSON.stringify(wt4Line));

  gate('PTY receives identical bytes for a tagged vs an untagged CR write',
    capBytesWT1 === WT1 && capBytesWT4 === WT4 && capBytesWT1 === capBytesWT4,
    `tagged=${JSON.stringify(capBytesWT1)} untagged=${JSON.stringify(capBytesWT4)}`);

  const tagPhaseText = fs.readFileSync(TRACE_FILE, 'utf8');
  const tagPhaseLeaked = SECRETS.filter((s) => tagPhaseText.includes(s));
  gate('no message text in any tag-phase row', tagPhaseLeaked.length === 0, JSON.stringify(tagPhaseLeaked));

  // --- Phase C: rotation at the 1 MB cap -------------------------------------
  fs.writeFileSync(TRACE_FILE, 'x'.repeat(1024 * 1024 + 4096)); // force > 1 MB
  const W6 = '\r';
  await send(W6, 200);

  const rotated = fs.existsSync(TRACE_FILE_1);
  gate('rotation: .1 file created past the 1 MB cap', rotated);
  if (rotated) {
    const rotSize = fs.statSync(TRACE_FILE_1).size;
    gate('rotation: .1 file holds the old (>1MB) content', rotSize > 1024 * 1024, `size=${rotSize}`);
  }
  const freshLines = readTraceLines(TRACE_FILE);
  gate('rotation: fresh file starts with exactly the new line', freshLines.length === 1
    && freshLines[0].kind === 'lone-cr', JSON.stringify(freshLines));

  // --- Phase D: a throwing fs.appendFileSync must never block the PTY write --
  const fsMod = require('fs');
  const origAppend = fsMod.appendFileSync;
  fsMod.appendFileSync = function patchedAppend(p, ...rest) {
    if (String(p).includes('send-trace.jsonl')) throw new Error('probe: forced fs failure');
    return origAppend.call(fsMod, p, ...rest);
  };
  let threw = false;
  const W7 = '\r';
  try {
    await send(W7, 200);
  } catch (_) {
    threw = true;
  }
  gate('a throwing fs.appendFileSync does not throw out of writeInput', !threw);
  const linesAfterThrow = readTraceLines(TRACE_FILE);
  gate('a throwing fs.appendFileSync drops only the trace line (still 1, not 2)',
    linesAfterThrow.length === 1, JSON.stringify(linesAfterThrow));

  fsMod.appendFileSync = origAppend; // restore
  const W8 = '\r';
  await send(W8, 200);
  const linesAfterRestore = readTraceLines(TRACE_FILE);
  gate('tracing resumes once fs.appendFileSync is restored',
    linesAfterRestore.length === 2 && linesAfterRestore[1].kind === 'lone-cr',
    JSON.stringify(linesAfterRestore));

  // --- Final: every byte sent reached the PTY, unchanged, in order -----------
  await sleep(300);
  const capRaw = fs.existsSync(CAP) ? fs.readFileSync(CAP, 'binary') : '';
  const expectedCap = sent.join('');
  gate('bytes passed to proc.write are byte-identical to every writeInput payload, in order',
    capRaw === expectedCap,
    `capLen=${capRaw.length} expectedLen=${expectedCap.length}`);

  console.log('\n=== send-trace probe ===');
  for (const r of results) console.log(r);
  console.log(failed ? 'VERDICT: FAIL' : 'VERDICT: PASS');
  fs.writeFileSync(path.join(__dirname, 'send-trace-probe.out'),
    results.join('\n') + '\n' + (failed ? 'VERDICT: FAIL' : 'VERDICT: PASS') + '\n');
  app.exit(failed ? 1 : 0);
});
