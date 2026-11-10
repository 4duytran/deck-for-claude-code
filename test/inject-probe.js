// v35 P3 — settings injection probe (argv ground truth).
// Three modes (process.argv[2]): noinject | fresh | wired.
// Isolation rule (incident 2026-06-04): HOME = mkdtemp BEFORE require(main.js)
// + app.setPath('userData', mkdtemp).
// deck-modern-ui L16: the AskUserQuestion hook (bin/deck-ask-hook.js, injected by buildInjectedSettings) is pinned in
// every mode on the REAL argv of an ordinary pane, never duplicated when the user's settings carry it.
// Run with CLAUDE_DECK_ASK_DIR=<mktemp -d> like every probe since L09 (a probe must never reach a live deck's channel).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const MODE = process.argv[2] || 'fresh';
const DECK = path.join(__dirname, '..');
const H = fs.mkdtempSync(path.join(os.tmpdir(), `deck-inj-${MODE}-`));
process.env.HOME = H;
fs.mkdirSync(path.join(H, '.claude'), { recursive: true });

// fake claude bin: dumps argv to a file, then stays alive reading stdin
const DUMP = path.join(H, 'argv-dump.txt');
const FAKE = path.join(H, 'fake-claude.sh');
fs.writeFileSync(FAKE, `#!/bin/sh\nprintf '%s\\n' "$@" > "${DUMP}"\nexec cat >/dev/null\n`);
fs.chmodSync(FAKE, 0o755);
process.env.CLAUDE_DECK_BIN = FAKE;
if (MODE !== 'noinject') process.env.CLAUDE_DECK_FORCE_INJECT = '1';

if (MODE === 'wired') {
  // user already has the global hook + a statusline with cosmetic keys
  fs.writeFileSync(path.join(H, '.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'bash /home/user/my-sl.sh', padding: 1 },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/home/user/.claude/hooks/deck-status.sh' }] }] },
  }));
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-inj-ud-')));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ [${MODE}] ${m}`); };
const ko = (m) => { fail++; console.log(`  ✗ [${MODE}] ${m}`); };
const gate = (cond, m, detail) => (cond ? ok(m) : ko(detail === undefined ? m : `${m}: ${detail}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(DECK, 'main.js'));

const DECK_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'PreCompact'];
const ASK_NEEDLE = 'deck-ask-hook';
const count = (s, needle) => s.split(needle).length - 1;

app.whenReady().then(async () => {
  await sleep(800); // window + watchers up
  const win = BrowserWindow.getAllWindows()[0];
  const ejs = (code) => win.webContents.executeJavaScript(code, true);
  // open one pane through the real renderer bridge (ground truth path)
  await ejs(`window.api.openTerminal({ paneId: 'probe-1', cols: 80, rows: 24, cwd: ${JSON.stringify(H)} })`);
  await sleep(700);

  const args = global.__deckLastSpawnArgs || [];
  const dumped = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8').split('\n').filter(Boolean) : [];

  const { ASK_DIR } = require(path.join(DECK, 'src/main/config'));
  const ASK_ELEMENT = {
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command: `node "${path.join(DECK, 'bin', 'deck-ask-hook.js')}" ask "${ASK_DIR}"`, timeout: 86400 }],
  };

  if (MODE === 'noinject') {
    !args.includes('--settings') ? ok('seam argv has NO --settings') : ko(`seam argv: ${args.join(' ')}`);
    !dumped.includes('--settings') ? ok('real argv has NO --settings (probes regression-safe)') : ko(`real argv: ${dumped.join(' ')}`);
  } else {
    const i = dumped.indexOf('--settings');
    i >= 0 ? ok('real argv contains --settings') : ko(`real argv: ${dumped.join(' ')}`);
    let parsed = null;
    try { parsed = JSON.parse(dumped[i + 1]); } catch (_) {}
    parsed ? ok('injected settings JSON parses') : ko('injected JSON unparsable');
    if (parsed) {
      parsed.statusLine && parsed.statusLine.command.includes('bin/deck-collector.sh')
        ? ok('statusLine -> shipped collector') : ko(`statusLine: ${JSON.stringify(parsed.statusLine)}`);
      const raw = dumped[i + 1];
      if (MODE === 'fresh') {
        const evs = Object.keys(parsed.hooks || {}).sort().join(',');
        // intended behaviour confirmed by b61b20c (PreCompact added to DECK_HOOK_EVENTS)
        evs === 'Notification,PostToolUse,PreCompact,PreToolUse,SessionEnd,SessionStart,Stop,UserPromptSubmit'
          ? ok('hooks injected for all 8 events') : ko(`hooks events: ${evs}`);
        const allCmd = JSON.stringify(parsed.hooks || {});
        allCmd.includes('bin/deck-status-hook.sh') ? ok('hook commands -> shipped status hook') : ko('hook command wrong');
        const h = parsed.hooks || {};
        const pre = Array.isArray(h.PreToolUse) ? h.PreToolUse : [];
        gate(pre.length === 2 && JSON.stringify(pre[0]).includes('deck-status-hook.sh') && isDeepStrictEqual(pre[1], ASK_ELEMENT),
          'ordinary PreToolUse = [deck-status, the ask hook: matcher AskUserQuestion, node deck-ask-hook.js ask <ASK_DIR>, timeout 86400 (24 h: the question waits as long as the terminal would)]', JSON.stringify(pre));
        gate(DECK_HOOK_EVENTS.filter((ev) => ev !== 'PreToolUse').every((ev) => Array.isArray(h[ev]) && h[ev].length === 1 && JSON.stringify(h[ev]).includes('deck-status-hook.sh')),
          'the 7 other events hold the deck-status element alone (the ask hook sits under PreToolUse only)');
      } else { // wired
        // deck-status is already wired globally (no duplicate status hooks), the ask hook is still injected
        gate(isDeepStrictEqual(parsed.hooks, { PreToolUse: [ASK_ELEMENT] }),
          'hooks injected = the ask hook alone under PreToolUse (deck-status already wired globally — no duplicate)', JSON.stringify(parsed.hooks));
        parsed.statusLine.padding === 1 ? ok('cosmetic key (padding) replicated') : ko(`padding: ${parsed.statusLine.padding}`);
      }
      gate(count(raw, ASK_NEEDLE) === 1, 'the ask hook appears exactly once in the ordinary --settings', `count ${count(raw, ASK_NEEDLE)}`);
      gate(ASK_DIR === process.env.CLAUDE_DECK_ASK_DIR || ASK_DIR.startsWith(H),
        'the injected ask dir is the probe\'s own (CLAUDE_DECK_ASK_DIR or under the temp HOME), never a live deck\'s', ASK_DIR);

      if (MODE === 'wired') {
        // not duplicated when the user's own settings already reference the ask hook (a fresh process reads that home)
        const askUser = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node /home/user/bin/deck-ask-hook.js ask /home/user/ask' }] };
        const inChild = (name, userSettings) => {
          const home = fs.mkdtempSync(path.join(os.tmpdir(), `deck-inj-${name}-`));
          fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
          fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(userSettings));
          try {
            return JSON.parse(require('child_process').execFileSync(process.execPath, [
              '-e', 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({ordinary:s.INJECTED_SETTINGS_JSON}))',
              path.join(DECK, 'src/main/settings-injection'),
            ], { env: { ...process.env, HOME: home, CLAUDE_DECK_FORCE_INJECT: '1', ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 }));
          } catch (_) { return null; }
        };
        const both = inChild('dedup-both', { hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '/home/user/.claude/hooks/deck-status.sh' }] }], PreToolUse: [askUser],
        } });
        gate(!!both && JSON.parse(both.ordinary).hooks === undefined,
          'user settings already hold deck-status AND the ask hook: no hooks injected at all', both && both.ordinary);
        const askOnly = inChild('dedup-ask', { hooks: { PreToolUse: [askUser] } });
        const askOnlyHooks = askOnly ? JSON.parse(askOnly.ordinary).hooks : null;
        gate(!!askOnlyHooks && !askOnly.ordinary.includes(ASK_NEEDLE) && Object.keys(askOnlyHooks).length === 8
          && DECK_HOOK_EVENTS.every((ev) => Array.isArray(askOnlyHooks[ev]) && askOnlyHooks[ev].length === 1),
        'user settings hold the ask hook but not deck-status: the 8 status events are injected with one element each, the ask hook is NOT injected a second time', askOnly && askOnly.ordinary);
      }
    }
  }

  console.log('---');
  console.log(`[${MODE}] PASS=${pass} FAIL=${fail}`);
  console.log(fail === 0 ? `P3[${MODE}] VERDICT: GREEN` : `P3[${MODE}] VERDICT: RED`);
  app.exit(fail === 0 ? 0 : 1);
});
