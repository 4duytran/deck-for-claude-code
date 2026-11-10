// room-native-transport P1/B3 — `crossSessionInbound: 'accept'` rides the deck's ordinary `{ask:true}` settings ONLY.
// Each case runs src/main/settings-injection.js in a child (HOME + ask dir isolated, like inject-probe):
//   {ask:true}  -> the settings JSON ends with `,"crossSessionInbound":"accept"}`: the one key appended last, every other key intact
//   {ask:false} -> no crossSessionInbound
// Needs no git history: the key's placement is checked on the module's own output.
// Run: electron test/room-inbound-settings-probe.js   (exit 0 = GREEN)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DECK = path.join(__dirname, '..');
const TARGET = path.join(DECK, 'src', 'main', 'settings-injection.js');
const KEY = 'crossSessionInbound';
const SUFFIX = `,"${KEY}":"accept"}`;

let pass = 0, fail = 0;
const gate = (cond, m, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${detail === undefined ? '' : `: ${detail}`}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-room-inbound-'));

const CHILD = `
const m = require(process.argv[1]);
process.stdout.write(JSON.stringify({ ask: m.buildInjectedSettings({ ask: true }), noask: m.buildInjectedSettings({ ask: false }),
  ordinary: m.INJECTED_SETTINGS_JSON }));
`;

const askUser = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node /x/deck-ask-hook.js ask /tmp/a' }] };
const CASES = [
  ['fresh user settings', {}],
  ['user wires deck-status + a cosmetic statusLine', {
    statusLine: { type: 'command', command: 'bash /home/user/my-sl.sh', padding: 1 },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/home/user/.claude/hooks/deck-status.sh' }] }] },
  }],
  ['user already wires the ask hook', { hooks: { PreToolUse: [askUser] } }],
];

for (const [label, userSettings] of CASES) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(userSettings));
  let out = null; let err = '';
  try {
    out = JSON.parse(execFileSync(process.execPath, ['-e', CHILD, TARGET], {
      env: { ...process.env, HOME: home, CLAUDE_DECK_FORCE_INJECT: '1', ELECTRON_RUN_AS_NODE: '1', CLAUDE_DECK_ASK_DIR: fs.mkdtempSync(path.join(tmp, 'ask-')) },
      encoding: 'utf8', timeout: 20000,
    }));
  } catch (e) { err = String(e && e.message || e); }
  console.log(`[${label}]`);
  gate(!!out, 'child loaded the current module', err);
  if (!out) continue;
  const now = out;
  const askObj = JSON.parse(now.ask);
  const { [KEY]: accepted, ...rest } = askObj;
  gate(accepted === 'accept', "{ask:true} carries crossSessionInbound: 'accept'", now.ask);
  gate(now.ask.endsWith(SUFFIX) && Object.keys(askObj).pop() === KEY && JSON.stringify(rest) === `${now.ask.slice(0, -SUFFIX.length)}}`,
    '{ask:true} = its settings JSON + the one key appended last (every other key byte-identical)', now.ask);
  gate(!now.noask.includes(KEY), '{ask:false} carries no crossSessionInbound', now.noask);
  gate(now.ordinary === now.ask && JSON.parse(now.ordinary)[KEY] === 'accept', 'INJECTED_SETTINGS_JSON (ordinary pane) carries the key');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('---');
console.log(`PASS=${pass} FAIL=${fail}`);
console.log(fail === 0 ? 'ROOM-INBOUND-SETTINGS VERDICT: GREEN' : 'ROOM-INBOUND-SETTINGS VERDICT: RED');
const code = fail === 0 ? 0 : 1;
process.exit(code);
