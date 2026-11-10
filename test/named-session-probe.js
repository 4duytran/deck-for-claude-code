// v28+v31 probe — named new session + dual-line title persistence. 9 gates.
// Run: npx electron test/named-session-probe.js   (from the repo root)
//
// FULL ISOLATION (incident rule 2026-06-04): HOME is faked BEFORE main.js
// loads (it derives ~/.claude paths at require time) and userData is moved to
// a mkdtemp — a probe must NEVER share storage with a live deck (LevelDB lock
// contention on persist:claudeai blanked the user's running AI view, twice).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Isolation + seams, all BEFORE the app module loads -------------------
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME; // os.homedir() reads $HOME first on POSIX
const WS = path.join(FAKE_HOME, 'Documents', 'workspace'); // the default dir must exist
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

// Fake claude bin: dumps argv, then stays alive (a PTY pane needs a live child).
const ARGS_FILE = path.join(FAKE_HOME, 'claude-args.txt');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN, `#!/bin/bash\necho "$@" > "${ARGS_FILE}"\nsleep 300\n`, { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank'; // never touch the network

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));

const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}

app.whenReady().then(async () => {
  await sleep(1500); // window + renderer boot (renderSessions, defaultDir fetch)
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // t1 — opening the menu shows the optional name input, auto-focused.
  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  const t1 = await js(`(() => {
    const i = document.getElementById('ns-name');
    return { present: !!i, focused: document.activeElement === document.getElementById('ns-input'),
             ph: i ? i.placeholder : '' };
  })()`);
  gate('t1 name field present, composer focused', t1.present && t1.focused
       && t1.ph.includes('facultatif'), JSON.stringify(t1));

  // t2 — type a name, pick the default dir -> pane titled with the name,
  // spawn got exactly `--session-id <uuid>`.
  await js(`(() => {
    document.getElementById('ns-name').value = 'Mon POC';
    document.getElementById('ns-send').click(); // the chip holds the default dir
  })()`);
  await sleep(1000); // dirExists roundtrip + spawn + fake bin write
  const t2title = await js(`(() => {
    const t = document.querySelector('.pane .pane-title');
    return t ? t.textContent : null;
  })()`);
  let argsTxt = '';
  try { argsTxt = fs.readFileSync(ARGS_FILE, 'utf8').trim(); } catch (_) {}
  const m = argsTxt.match(/^--session-id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  gate('t2 named spawn', t2title === 'Mon POC' && !!m,
       `title=${JSON.stringify(t2title)} args="${argsTxt}"`);
  const sid = m ? m[1] : '00000000-0000-0000-0000-000000000000';

  // t3 — sidebar pending override: simulate claude materializing the .jsonl,
  // refresh -> the row shows the creation name (no title line in the file yet).
  const projDir = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const jsonl = path.join(projDir, `${sid}.jsonl`);
  fs.writeFileSync(jsonl, JSON.stringify({
    type: 'user', cwd: WS, gitBranch: '',
    message: { role: 'user', content: 'hello probe' },
  }) + '\n');
  await js(`document.getElementById('refresh-sessions').click()`);
  await sleep(500);
  const t3 = await js(`(() => {
    const r = document.querySelector('.session-row');
    return r ? { summary: r.querySelector('.summary').textContent,
                 id: r.dataset.sessionId } : null;
  })()`);
  gate('t3 sidebar pending name', !!t3 && t3.summary === 'Mon POC' && t3.id === sid,
       JSON.stringify(t3));

  // t4 — no premature write: the live file must NOT contain a custom-title.
  const pre = fs.readFileSync(jsonl, 'utf8');
  gate('t4 no write while live', !pre.includes('custom-title'),
       `pre-close bytes=${pre.length}`);

  // t5 — close the pane -> onExit -> markSessionClosed -> persist: the file
  // now ends with BOTH native title lines (custom-title + agent-name, v31 —
  // claude reloads agent-name at boot, a custom-title alone is not enough).
  await js(`document.querySelector('.pane .pane-close').click()`);
  await sleep(800); // SIGHUP -> onExit (persist is sync once it fires)
  const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n');
  let ctLine = null;
  let anLine = null;
  try { ctLine = JSON.parse(lines[lines.length - 2]); } catch (_) {}
  try { anLine = JSON.parse(lines[lines.length - 1]); } catch (_) {}
  gate('t5 both title lines persisted at close',
       !!ctLine && ctLine.type === 'custom-title'
       && ctLine.customTitle === 'Mon POC' && ctLine.sessionId === sid
       && !!anLine && anLine.type === 'agent-name'
       && anLine.agentName === 'Mon POC' && anLine.sessionId === sid,
       lines.slice(-2).join(' | '));

  // t6 — refresh -> the row STILL shows the name, now from the NATIVE title
  // (pending entry dropped; the meta scan reads the appended line).
  await js(`document.getElementById('refresh-sessions').click()`);
  await sleep(500);
  const t6 = await js(`(() => {
    const r = document.querySelector('.session-row');
    return r ? r.querySelector('.summary').textContent : null;
  })()`);
  gate('t6 native title after close', t6 === 'Mon POC', `summary=${JSON.stringify(t6)}`);

  // t7 — unnamed flow: no name -> "<dir> (new)" title, and since v46.5 the
  // spawn STILL fixes the session id (--session-id, a FRESH uuid) so the
  // chat view is available before the first message (the old flag-less
  // spawn left pane.sessionId null -> chat toggle dead until first message).
  try { fs.unlinkSync(ARGS_FILE); } catch (_) {}
  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`document.getElementById('ns-send').click()`);
  await sleep(1000);
  const t7 = await js(`(() => {
    const ps = [...document.querySelectorAll('.pane')];
    const p = ps[ps.length - 1];
    return p ? { title: p.querySelector('.pane-title').textContent,
                 viewEnabled: !p.querySelector('.pane-view').disabled } : null;
  })()`);
  let args7 = 'MISSING';
  try { args7 = fs.readFileSync(ARGS_FILE, 'utf8').trim(); } catch (_) {}
  const m7 = args7.match(/^--session-id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  gate('t7 unnamed spawn gets fresh id + chat view live',
       !!t7 && t7.title === 'workspace (new)' && !!m7 && m7[1] !== sid && t7.viewEnabled,
       `t7=${JSON.stringify(t7)} args="${args7}"`);

  // t7b — v46.9: chat is the DEFAULT face — the fresh unnamed pane lands on
  // the chat AUTOMATICALLY once its deck-fixed id arrives (waiting
  // empty-state, no transcript yet), and the switch SAYS its state.
  await sleep(300); // margin: auto setChatView ran on identity acquisition
  const t7b = await js(`(() => {
    const ps = [...document.querySelectorAll('.pane')];
    const p = ps[ps.length - 1];
    const empty = p.querySelector('.chat-empty');
    return { chatOn: p.classList.contains('chat-mode'),
             label: p.querySelector('.pv-label').textContent,
             empty: empty ? empty.textContent : null };
  })()`);
  gate('t7b chat is the default face before the first message (v46.9)',
       t7b.chatOn && t7b.label === 'Chat mode ON' && /premier message/.test(t7b.empty || ''),
       JSON.stringify(t7b));
  // ONE click flips back to the terminal — t8 sees the same pane shape as
  // before, and the switch label must follow.
  const t7c = await js(`(() => {
    const ps = [...document.querySelectorAll('.pane')];
    const p = ps[ps.length - 1];
    p.querySelector('.pane-view').click();
    return { chatOn: p.classList.contains('chat-mode'),
             label: p.querySelector('.pv-label').textContent };
  })()`);
  gate('t7c the switch flips back to terminal and says so',
       !t7c.chatOn && t7c.label === 'Terminal mode ON',
       JSON.stringify(t7c));
  await sleep(200);

  // t8 — Enter in the input = quick start in the top dir, menu closed.
  try { fs.unlinkSync(ARGS_FILE); } catch (_) {}
  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`(() => {
    const i = document.getElementById('ns-name');
    i.value = 'Quick Enter';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(1000);
  const t8 = await js(`(() => {
    const ts = [...document.querySelectorAll('.pane .pane-title')];
    return { title: ts.length ? ts[ts.length - 1].textContent : null,
             menuGone: document.getElementById('grid-empty').hidden };
  })()`);
  let args8 = 'MISSING';
  try { args8 = fs.readFileSync(ARGS_FILE, 'utf8').trim(); } catch (_) {}
  gate('t8 Enter quick-start', t8.title === 'Quick Enter' && t8.menuGone
       && /^--session-id [0-9a-f-]{36}$/.test(args8),
       JSON.stringify({ ...t8, args: args8 }));

  // t9 — v31 rename of a CLOSED session appends BOTH native lines. The t2
  // session is closed since t5 and its dir is in sessionDirs since the t6
  // refresh — exactly the state the sidebar rename runs from.
  const t9res = await js(`window.api.renameSession('${sid}', 'POC Renomme')`);
  const lines9 = fs.readFileSync(jsonl, 'utf8').trim().split('\n');
  let ct9 = null;
  let an9 = null;
  try { ct9 = JSON.parse(lines9[lines9.length - 2]); } catch (_) {}
  try { an9 = JSON.parse(lines9[lines9.length - 1]); } catch (_) {}
  gate('t9 rename appends both lines',
       !!t9res && t9res.ok === true
       && !!ct9 && ct9.type === 'custom-title' && ct9.customTitle === 'POC Renomme'
       && !!an9 && an9.type === 'agent-name' && an9.agentName === 'POC Renomme'
       && an9.sessionId === sid,
       JSON.stringify({ res: t9res, last2: lines9.slice(-2) }));

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'named-session-probe.out'), report + '\n');
  console.log('\n=== v28 named-session probe ===\n' + report);
  // app.exit skips before-quit; the PTY master fds close with the process ->
  // the bash children get SIGHUP and die (no orphan sleeps).
  app.exit(failed ? 1 : 0);
});
