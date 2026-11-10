// v30 probe — re-click on an already-open session row = NO visual effect.
// 4 gates. Same isolation harness as named-session-probe (incident rule
// 2026-06-04: fake HOME + userData, never share storage with a live deck).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

const ARGS_FILE = path.join(FAKE_HOME, 'claude-args.txt');
const FAKE_BIN = path.join(FAKE_HOME, 'fake-claude.sh');
fs.writeFileSync(FAKE_BIN, `#!/bin/bash\necho "$@" > "${ARGS_FILE}"\nsleep 300\n`, { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = FAKE_BIN;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

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
  await sleep(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const js = (code) => wc.executeJavaScript(code, true);

  // Setup: NAMED session (deck-chosen id -> pane.sessionId adopted, v28) so
  // the sidebar row maps onto the live pane via findLivePane.
  await js(`document.getElementById('new-session').click()`);
  await sleep(300);
  await js(`(() => {
    document.getElementById('ns-name').value = 'Flash Test';
    document.getElementById('ns-send').click();
  })()`);
  await sleep(1000);
  let sid = null;
  try {
    const m = fs.readFileSync(ARGS_FILE, 'utf8').trim()
      .match(/^--session-id ([0-9a-f-]{36})$/);
    sid = m && m[1];
  } catch (_) {}
  // Materialize the .jsonl so the sidebar grows the row, then refresh.
  const projDir = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), JSON.stringify({
    type: 'user', cwd: WS, message: { role: 'user', content: 'hello probe' },
  }) + '\n');
  await js(`document.getElementById('refresh-sessions').click()`);
  await sleep(500);
  // v46.9: chat became the default face — this probe asserts TERMINAL focus
  // semantics on re-click: force the terminal face (auto-ON already ran).
  await js(`setChatView([...panes.keys()][0], false)`);
  await sleep(300);
  const setup = await js(`(() => {
    const r = document.querySelector('.session-row');
    return { row: !!r, id: r ? r.dataset.sessionId : null,
             panes: document.querySelectorAll('#grid .pane').length };
  })()`);
  gate('t0 setup row+pane', setup.row && setup.id === sid && setup.panes === 1,
       JSON.stringify(setup));

  // Arm watchers: class mutations on the pane (flash / anything), pane count,
  // grid scroll position. Then click the row of the ALREADY-OPEN session.
  await js(`(() => {
    window.__probe = { classEvents: [], scrolled: false };
    const pane = document.querySelector('#grid .pane');
    new MutationObserver((muts) => {
      for (const m of muts) window.__probe.classEvents.push(m.target.className);
    }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    const grid = document.getElementById('grid');
    grid.addEventListener('scroll', () => { window.__probe.scrolled = true; },
                          { once: true });
    document.querySelector('.session-row').click();
  })()`);
  await sleep(900); // > flash duration (700ms) — any flash WOULD have fired

  const t = await js(`(() => {
    const panes = document.querySelectorAll('#grid .pane');
    const ae = document.activeElement;
    return {
      paneCount: panes.length,
      classEvents: window.__probe.classEvents,
      hasFlash: window.__probe.classEvents.some((c) => c.includes('flash')),
      scrolled: window.__probe.scrolled,
      focusInTerm: !!(ae && ae.closest && ae.closest('.pane-term')),
    };
  })()`);

  gate('t1 no new pane', t.paneCount === 1, `paneCount=${t.paneCount}`);
  gate('t2 zero visual mutation', !t.hasFlash && t.classEvents.length === 0
       && !t.scrolled,
       `classEvents=${JSON.stringify(t.classEvents)} scrolled=${t.scrolled}`);
  gate('t3 keyboard back in terminal', t.focusInTerm,
       `activeElement in .pane-term=${t.focusInTerm}`);

  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'reclick-noop-probe.out'), report + '\n');
  console.log('\n=== v30 reclick-noop probe ===\n' + report);
  app.exit(failed ? 1 : 0);
});
