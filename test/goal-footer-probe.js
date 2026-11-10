// v50 probe — /goal in the chat face: « Goal défini » chip + « Goal actif »
// footer (elapsed) + auto-clear + ✕→/goal clear. Integration path: raw JSONL is
// appended to the active session file, the real main-side tailer (fs.watch +
// poll) parses it (normalizeLine) and pushes transcript-append to the renderer —
// so this exercises the PARSER and the RENDERER together, exactly like prod.
// Fake claude = cat >> PTY_LOG (no bracketed-paste escape needed; assertions are
// substring-based) so we can confirm the ✕ pastes « /goal clear ».
// Gates:
//   f1 « Goal set: » surfaces a chip (was dropped as noise) + footer shows w/ text
//   f2 footer elapsed timer ticks (> 0s after a second)
//   f3 auto-clear: goal-named Stop hook, preventedContinuation=false -> footer hides
//   f4 « /goal clear » stdout -> footer hides
//   f5 ✕ button -> pastes « /goal clear » to the pty + footer hides
//   f6 goal Stop hook still BLOCKING (prevented=true) -> footer STAYS (not premature)
//   f7 regression: a non-goal <command-name> user line stays noise (no bubble)
//   f8 goal text is rendered as TEXT (no HTML injection from the condition)
//   f9 goal hook GONE from a later stop roster -> footer clears (co-hook may still block)
//   f10 (v51) long goal collapses to 1 line; click expands to full VISIBLE text (no h/v clip)
//   f11 (v51) « Goal défini » chip click expands the goal to the full visible text
//   f12 (v51) set->set: a new goal reopens collapsed (no stale .expanded) [attack #5]
//   f13 (v51) click with an active text selection does NOT toggle (copy intact) [attack #2]
// Run: <repo>/node_modules/.bin/electron test/goal-footer-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-goalf-home-'));
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
fs.writeFileSync(FAKE_BIN, '#!/bin/bash\nexec cat >> "' + PTY_LOG + '"\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

const SID = '88888888-bbbb-4ccc-8ddd-888888888888';
// Recent ts so the goal's elapsed renders as live seconds ("Ns"). A FIXED
// past TS made fmtElapsed cross its 1h threshold as the wall clock advanced,
// dropping the seconds component ("1h28m") and flaking f2's /\d+s/ check. The
// goal's ts IS recent in reality — a user just ran /goal.
const TS = new Date(Date.now() - 3000).toISOString();
const FIXTURE = path.join(PROJ_DIR, `${SID}.jsonl`);
const J = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(FIXTURE, [
  J({ type: 'user', cwd: WS, timestamp: TS, message: { role: 'user', content: 'démarre' } }),
  J({ type: 'assistant', timestamp: TS,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }],
                 usage: { input_tokens: 3, output_tokens: 2 } } }),
].join(''));

// Append a raw transcript line and let the real tailer (fs.watch + 2s poll) pick
// it up — generous wait stays under the poll floor.
const append = (obj) => fs.appendFileSync(FIXTURE, J(obj));
const userLine = (content) => ({ type: 'user', timestamp: TS, message: { role: 'user', content } });
const goalSet = (text) => userLine(`<local-command-stdout>Goal set: ${text}</local-command-stdout>`);
const goalClearStdout = () => userLine('<local-command-stdout>Goal cleared</local-command-stdout>');
const stopHook = (goalText, prevented) => ({
  type: 'system', subtype: 'stop_hook_summary', timestamp: TS,
  hookInfos: [{ command: '/home/x/.claude/hooks/deck-status.sh' },
              { command: goalText, promptText: goalText }],
  preventedContinuation: prevented,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAIL = 1300; // fs.watch is near-instant; this clears the 2s poll floor anyway
const ptySize = () => { try { return fs.statSync(PTY_LOG).size; } catch (_) { return 0; } };
const ptyText = () => { try { return fs.readFileSync(PTY_LOG, 'latin1'); } catch (_) { return ''; } };

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-goalf-ud-')));
const { app, BrowserWindow } = require('electron');

const results = [];
function gate(id, ok, detail) { results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`); }

app.whenReady().then(async () => {
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const footer = () => js(`(() => {
    const f = panes.get('pane-1').el.querySelector('.chat-goal-footer');
    return { hidden: f.hidden, text: f.querySelector('.cgf-text').textContent,
             timer: f.querySelector('.cgf-timer').textContent }; })()`);

  await js(`openPane({ resumeId: '${SID}', title: 'goalf-fixture' })`);
  await sleep(800);
  await js(`setChatView('pane-1', true)`);
  await sleep(900);
  setStatus(SID, 'idle');
  await sleep(500);

  // f1 — « Goal set: » now surfaces a chip AND lights the footer.
  append(goalSet('objectif alpha'));
  await sleep(TAIL);
  const f1f = await footer();
  const f1c = await js(`(() => {
    const c = panes.get('pane-1').el.querySelector('.chat-goal-set .cgs-text');
    return { chip: !!c, text: c ? c.textContent : null }; })()`);
  gate('f1 « Goal set: » -> chip + footer (text shown)',
       f1c.chip && f1c.text === 'objectif alpha'
       && f1f.hidden === false && f1f.text === 'objectif alpha',
       JSON.stringify({ ...f1c, ...f1f }));

  // f2 — the elapsed timer ticks.
  await sleep(1200);
  const f2 = await footer();
  gate('f2 footer elapsed timer ticks (non-empty, >0s)',
       !f2.hidden && /\d+s/.test(f2.timer) && f2.timer !== '0s', JSON.stringify(f2));

  // f6 — the goal Stop hook is STILL blocking (preventedContinuation=true):
  // footer must NOT clear (the goal is not met yet). Checked before f3 so the
  // alpha goal is still live.
  append(stopHook('objectif alpha', true));
  await sleep(TAIL);
  const f6 = await footer();
  gate('f6 hook still blocking -> footer stays', f6.hidden === false, JSON.stringify(f6));

  // f3 — the goal-named Stop hook ran WITHOUT preventing continuation: met -> clear.
  append(stopHook('objectif alpha', false));
  await sleep(TAIL);
  const f3 = await footer();
  gate('f3 hook met (prevented=false) -> footer auto-clears', f3.hidden === true, JSON.stringify(f3));

  // f4 — « /goal clear » stdout clears the footer.
  append(goalSet('objectif beta'));
  await sleep(TAIL);
  const f4mid = await footer();
  append(goalClearStdout());
  await sleep(TAIL);
  const f4 = await footer();
  gate('f4 « Goal cleared » stdout -> footer hides',
       f4mid.hidden === false && f4mid.text === 'objectif beta' && f4.hidden === true,
       JSON.stringify({ mid: f4mid, after: f4 }));

  // f5 — the ✕ ends the goal for real: it pastes « /goal clear » to the pty.
  append(goalSet('objectif gamma'));
  await sleep(TAIL);
  const f5mid = await footer();
  const pre5 = ptySize();
  await js(`panes.get('pane-1').el.querySelector('.cgf-close').click()`);
  await sleep(300);
  const f5 = await footer();
  gate('f5 ✕ -> pastes « /goal clear » + footer hides',
       f5mid.hidden === false && ptyText().includes('/goal clear') && ptySize() > pre5
       && f5.hidden === true,
       JSON.stringify({ mid: f5mid, ptyDelta: ptySize() - pre5, after: f5 }));

  // f7 — regression: a non-goal <command-name> user line is still noise (no bubble).
  append(userLine('<command-name>/model</command-name>'));
  await sleep(TAIL);
  const f7 = await js(`(() => {
    const bubbles = [...panes.get('pane-1').el.querySelectorAll('.chat-user .chat-bubble')];
    return { hasModel: bubbles.some((b) => b.textContent.includes('/model')) }; })()`);
  gate('f7 regression: non-goal command echo stays noise (no bubble)',
       f7.hasModel === false, JSON.stringify(f7));

  // f8 — the goal condition is rendered as TEXT, never HTML (injection guard).
  append(goalSet('<img src=x>BAD'));
  await sleep(TAIL);
  const f8 = await js(`(() => {
    const chips = [...panes.get('pane-1').el.querySelectorAll('.chat-goal-set')];
    const last = chips[chips.length - 1];
    const t = last ? last.querySelector('.cgs-text') : null;
    return { text: t ? t.textContent : null, injected: !!(t && t.querySelector('img')) }; })()`);
  gate('f8 goal text is TEXT, not HTML (no injected <img>)',
       f8.injected === false && f8.text === '<img src=x>BAD', JSON.stringify(f8));

  // f9 (attack #4) — the goal Stop hook is GONE from a later stop roster -> clear,
  // EVEN when a co-installed hook keeps the summary-level preventedContinuation
  // true (it is not per-hook). Set a fresh goal, then a stop_hook_summary whose
  // only promptText is an UNRELATED hook + prevented=true.
  append(goalSet('objectif epsilon'));
  await sleep(TAIL);
  const f9mid = await footer();
  append({ type: 'system', subtype: 'stop_hook_summary', timestamp: TS,
           hookInfos: [{ command: '/home/x/.claude/hooks/deck-status.sh' },
                       { command: 'unrelated review directive', promptText: 'Some unrelated review directive' }],
           preventedContinuation: true });
  await sleep(TAIL);
  const f9 = await footer();
  gate('f9 goal hook absent (+ co-hook still blocking) -> footer clears',
       f9mid.hidden === false && f9mid.text === 'objectif epsilon' && f9.hidden === true,
       JSON.stringify({ mid: f9mid, after: f9 }));

  // f10 (v51) — a long goal collapses to ONE ellipsised line by default; clicking
  // the footer text expands it to the full, wrapping multi-line goal (click again
  // re-collapses). Strengthened (attack #3): assert NO horizontal overflow AND no
  // vertical clip when expanded, plus that all 6 segments of the text are present —
  // so "expanded" means the full goal is actually visible, not merely un-overflowed.
  const GOAL_LONG = 'objectif délibérément très long pour déborder la ligne '.repeat(6).trim();
  append(goalSet(GOAL_LONG));
  await sleep(TAIL);
  const f10 = await js(`(() => {
    const f = panes.get('pane-1').el.querySelector('.chat-goal-footer');
    const t = f.querySelector('.cgf-text');
    const collapsedOverflow = t.scrollWidth > t.clientWidth + 1;
    const collapsedWS = getComputedStyle(t).whiteSpace;
    const h0 = f.offsetHeight;
    t.click();
    const expandedClass = f.classList.contains('expanded');
    const expandedWS = getComputedStyle(t).whiteSpace;
    const grew = f.offsetHeight > h0;
    const noTruncH = t.scrollWidth <= t.clientWidth + 2;
    const noClipV = t.scrollHeight <= t.clientHeight + 2;
    const segs = (t.textContent.match(/objectif/g) || []).length;
    t.click();
    const recollapsed = !f.classList.contains('expanded');
    return { collapsedOverflow, collapsedWS, expandedClass, expandedWS, grew, noTruncH, noClipV, segs, recollapsed };
  })()`);
  gate('f10 footer goal collapses to 1 line; click expands to full VISIBLE text',
       f10.collapsedOverflow && f10.collapsedWS === 'nowrap'
       && f10.expandedClass && f10.expandedWS === 'normal' && f10.grew
       && f10.noTruncH && f10.noClipV && f10.segs === 6 && f10.recollapsed,
       JSON.stringify(f10));

  // f11 (v51) — the in-stream « Goal défini » chip expands the same way (own click
  // handler, built fresh per goal event). Same full-visibility assertions.
  const f11 = await js(`(() => {
    const chips = [...panes.get('pane-1').el.querySelectorAll('.chat-goal-set')];
    const c = chips[chips.length - 1];
    const t = c.querySelector('.cgs-text');
    const collapsedOverflow = t.scrollWidth > t.clientWidth + 1;
    const clickable = c.classList.contains('is-collapsible');
    const h0 = c.offsetHeight;
    c.click();
    const expandedClass = c.classList.contains('expanded');
    const expandedWS = getComputedStyle(t).whiteSpace;
    const grew = c.offsetHeight > h0;
    const noClipV = t.scrollHeight <= t.clientHeight + 2;
    const segs = (t.textContent.match(/objectif/g) || []).length;
    return { collapsedOverflow, clickable, expandedClass, expandedWS, grew, noClipV, segs };
  })()`);
  gate('f11 « Goal défini » chip click expands to full VISIBLE text',
       f11.collapsedOverflow && f11.clickable
       && f11.expandedClass && f11.expandedWS === 'normal' && f11.grew
       && f11.noClipV && f11.segs === 6,
       JSON.stringify(f11));

  // f12 (v51, attack #5) — re-issuing /goal while one is active (no clear between)
  // reopens COLLAPSED: a new condition must NOT inherit the previous goal's expand.
  // Footer currently shows GOAL_LONG (collapsed). Expand it, then set a NEW goal.
  await js(`panes.get('pane-1').el.querySelector('.chat-goal-footer .cgf-text').click()`);
  const f12pre = await js(`panes.get('pane-1').el.querySelector('.chat-goal-footer').classList.contains('expanded')`);
  append(goalSet('objectif tout neuf et different'));
  await sleep(TAIL);
  const f12 = await js(`(() => {
    const f = panes.get('pane-1').el.querySelector('.chat-goal-footer');
    return { expanded: f.classList.contains('expanded'), text: f.querySelector('.cgf-text').textContent }; })()`);
  gate('f12 set->set: a NEW goal reopens collapsed (no stale expand)',
       f12pre === true && f12.expanded === false && f12.text === 'objectif tout neuf et different',
       JSON.stringify({ pre: f12pre, ...f12 }));

  // f13 (v51, attack #2) — clicking the goal text while a SELECTION exists must NOT
  // toggle, so the user can select/copy the condition. Make a real range over the
  // text, dispatch a click, assert the strip did not fold and the selection lived.
  const f13 = await js(`(() => {
    const f = panes.get('pane-1').el.querySelector('.chat-goal-footer');
    const t = f.querySelector('.cgf-text');
    f.classList.remove('expanded');
    const before = f.classList.contains('expanded');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(t);
    sel.removeAllRanges();
    sel.addRange(range);
    t.click();
    const after = f.classList.contains('expanded');
    const selKept = !window.getSelection().isCollapsed;
    sel.removeAllRanges();
    return { before, after, selKept }; })()`);
  gate('f13 click with active text selection does NOT toggle (copy stays intact)',
       f13.before === false && f13.after === false && f13.selKept === true,
       JSON.stringify(f13));

  console.log('\n=== goal-footer-probe ===');
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
