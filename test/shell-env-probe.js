// shell-env probe — proves the deck spawns `claude` with the user's
// INTERACTIVE-shell environment (~/.bashrc exports), not Electron's bare GUI
// env. This is the JIRA-401 fix: a secret exported in ~/.bashrc but ABSENT from
// process.env (the desktop-launch case) must reach the PTY child.
//
// Run: ./node_modules/.bin/electron test/shell-env-probe.js
//
// FULL ISOLATION: HOME faked BEFORE main.js loads. A fake ~/.bashrc exports the
// "secret"; ~/.bash_profile exports a DIFFERENT marker to PROVE we use an
// interactive NON-login shell (-i, reads .bashrc) and NOT a login shell (-l,
// reads .bash_profile). The PTY shim is `bash --norc --noprofile` so the child
// sources NOTHING — any marker it sees was INHERITED from the spawn env, which
// is exactly what we're testing.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shellenv-home-'));
process.env.HOME = FAKE_HOME;
process.env.SHELL = '/bin/bash';
fs.mkdirSync(path.join(FAKE_HOME, 'Documents', 'workspace'), { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'projects'), { recursive: true });

// The "secret" + precedence fixtures live in ~/.bashrc (interactive non-login).
fs.writeFileSync(path.join(FAKE_HOME, '.bashrc'),
  'export DECK_SHELL_SECRET=token_abc123\n' +   // the secret missing from GUI env
  'export DECK_NONSEAM=fromshell\n' +            // non-seam: shell value must win
  'export CLAUDE_DECK_SEAM_TEST=fromshell\n' +   // deck seam: process.env must win
  'deckfn() { echo hi; }\nexport -f deckfn\n'); // exported FUNCTION -> BASH_FUNC_ entry (g8)
// A login-only file — must NOT be picked up (proves -i, not -l).
fs.writeFileSync(path.join(FAKE_HOME, '.bash_profile'),
  'export DECK_PROFILE_SECRET=should_not_appear\n');

// PTY shim: drop claude's argv, start a shell that sources NOTHING. A marker the
// child sees can ONLY have been inherited from pty.spawn's env option.
const SHIM = path.join(FAKE_HOME, 'claude-shim.sh');
fs.writeFileSync(SHIM, '#!/bin/bash\nexec /bin/bash --norc --noprofile -i\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = SHIM;
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

// GUI-launch simulation: the secret is NOT in Electron's env. Seam + non-seam
// conflict fixtures ARE in process.env so we can assert merge precedence.
delete process.env.DECK_SHELL_SECRET;
delete process.env.DECK_PROFILE_SECRET;
process.env.CLAUDE_DECK_SEAM_TEST = 'fromproc'; // deck seam present in Electron env
process.env.DECK_NONSEAM = 'fromproc';          // non-seam present in Electron env

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-shellenv-')));

const shellEnv = require(path.join(__dirname, '..', 'src', 'main', 'shell-env'));
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
function gate(id, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  if (!ok) failed = true;
}
function finish() {
  const report = results.join('\n');
  fs.writeFileSync(path.join(__dirname, 'shell-env-probe.out'), report + '\n');
  console.log('\n=== shell-env probe ===\n' + report);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    await sleep(1200);

    // ----- UNIT gates: resolveShellEnv() (same module instance pty.js uses) ---
    const env = await shellEnv.resolveShellEnv();

    // g1 — THE fix: a ~/.bashrc secret absent from process.env is resolved.
    gate('g1 bashrc secret resolved (the JIRA-401 fix)',
      env.DECK_SHELL_SECRET === 'token_abc123' && !('DECK_SHELL_SECRET' in process.env),
      `DECK_SHELL_SECRET=${env.DECK_SHELL_SECRET} (was absent from process.env? ${!('DECK_SHELL_SECRET' in process.env)})`);

    // g2 — deck seam precedence: process.env CLAUDE_DECK_* wins over the shell.
    gate('g2 deck seam re-asserted over shell',
      env.CLAUDE_DECK_SEAM_TEST === 'fromproc',
      `CLAUDE_DECK_SEAM_TEST=${env.CLAUDE_DECK_SEAM_TEST} (shell said fromshell, proc said fromproc)`);

    // g3 — non-seam: the shell value wins (this is how full PATH/secrets flow).
    gate('g3 non-seam var takes the shell value',
      env.DECK_NONSEAM === 'fromshell',
      `DECK_NONSEAM=${env.DECK_NONSEAM} (shell wins for non-CLAUDE_DECK_ keys)`);

    // g4 — -i (non-login) NOT -l: ~/.bash_profile must be ignored.
    gate('g4 interactive non-login (.bash_profile ignored)',
      !('DECK_PROFILE_SECRET' in env),
      `DECK_PROFILE_SECRET present? ${'DECK_PROFILE_SECRET' in env} (must be false)`);

    // g5 — memoized within TTL: back-to-back calls return the same object.
    const env2 = await shellEnv.resolveShellEnv();
    gate('g5 resolveShellEnv memoized', env2 === env,
      `same object: ${env2 === env}`);

    // g8 — exported shell FUNCTIONS (BASH_FUNC_*, the Shellshock vector) and any
    // non-identifier name must be DROPPED, never injected into the spawn env.
    const bashFuncKeys = Object.keys(env).filter((k) => k.includes('BASH_FUNC') || k === 'deckfn');
    gate('g8 BASH_FUNC_/exotic names filtered out',
      bashFuncKeys.length === 0,
      `leaked function/exotic keys: ${JSON.stringify(bashFuncKeys)} (must be [])`);

    // ----- E2E gate: the real pty.js spawn path carries the resolved env ------
    await app.whenReady();
    const win = BrowserWindow.getAllWindows()[0];
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await js(`document.getElementById('new-session').click()`);
    await sleep(300);
    await js(`document.getElementById('ns-send').click()`); // start screen: default dir, no name
    await sleep(1600); // spawn + shim bash prompt
    const paneId = await js(`[...panes.keys()][0]`);
    await js(`setChatView('${paneId}', false)`); // show the terminal face
    await sleep(300);
    // $VAR is unexpanded in the echoed INPUT line, expanded only in the OUTPUT —
    // so RESULT=[token_abc123] matches the child's stdout, not the typed command.
    await js(`window.api.writeInput('${paneId}', 'echo "RESULT=[$DECK_SHELL_SECRET]"\\n')`);
    await sleep(500);
    const seen = await js(`(() => {
      const p = panes.get('${paneId}');
      const b = p.term.buffer.active;
      let txt = '';
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        if (l) txt += l.translateToString(true) + '\\n';
      }
      return txt.includes('RESULT=[token_abc123]');
    })()`);
    gate('g6 PTY child inherits the resolved env (end-to-end)', seen,
      `child echoed RESULT=[token_abc123]: ${seen} (shim sources nothing -> inherited from spawn env)`);

    // g7 — opt-out escape hatch: a FRESH module instance with the skip flag set
    // must NOT resolve the secret (returns bare process.env). Clear the cache so
    // doResolve re-runs; this is a separate instance, pty.js keeps its own.
    process.env.CLAUDE_DECK_NO_SHELL_ENV = '1';
    delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'main', 'shell-env'))];
    const freshEnv = await require(path.join(__dirname, '..', 'src', 'main', 'shell-env')).resolveShellEnv();
    gate('g7 CLAUDE_DECK_NO_SHELL_ENV opt-out skips the shell',
      !('DECK_SHELL_SECRET' in freshEnv),
      `opt-out env has the secret? ${'DECK_SHELL_SECRET' in freshEnv} (must be false)`);
    delete process.env.CLAUDE_DECK_NO_SHELL_ENV;

    // g9 — bounded staleness: with TTL=0 a fresh resolve must pick up a token
    // ROTATED mid-session (defeats the 'memoized forever -> 401 till restart').
    const modPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'shell-env'));
    process.env.CLAUDE_DECK_SHELL_ENV_TTL_MS = '0';
    delete require.cache[modPath];
    const mod9 = require(modPath);
    const before9 = await mod9.resolveShellEnv();
    fs.writeFileSync(path.join(FAKE_HOME, '.bashrc'), 'export DECK_SHELL_SECRET=token_ROTATED\n');
    const after9 = await mod9.resolveShellEnv();
    gate('g9 TTL re-resolves -> rotated secret picked up',
      before9.DECK_SHELL_SECRET === 'token_abc123'
        && after9.DECK_SHELL_SECRET === 'token_ROTATED' && before9 !== after9,
      `before=${before9.DECK_SHELL_SECRET} after=${after9.DECK_SHELL_SECRET} distinct=${before9 !== after9}`);
    delete process.env.CLAUDE_DECK_SHELL_ENV_TTL_MS;

    finish();
  } catch (e) {
    results.push(`FAIL probe-crash — ${e && e.stack ? e.stack : e}`);
    failed = true;
    finish();
  }
});
