'use strict';
// plugin-access-probe — step S1a of the daily-brief plan (AMD-3, D20, D23): src/main/plugin-access.js,
// the names-only access layer of the plugin host. Hermetic: no window, no main.js, no real env value.
// The "user's shell" is test/fixtures/plugins/fake-shell.sh (FAKE secrets only, `--norc`, so the real
// rc files are never read); its variants are symlinks to it made in a mkdtemp dir, picked by basename.
//   xvfb-run -a node_modules/.bin/electron test/plugin-access-probe.js
// PLUGIN_ACCESS_SRC=<dir> points the probe at another copy of src/main (mutation proofs).
//
// Gates:
//   a       listNames / detect / status results (JSON.stringify) hold no fake secret value, names only
//   a2      a fake rc printing the fake secret on stdout and stderr -> 0 hits in the listNames result;
//           the shell's own fds 0/1/2 are /dev/null and fd 3 is the pipe (spawn stdio contract)
//   marker  no marker on fd 3 (rc / exec failure) -> « Lecture du shell impossible », told apart from an
//           empty listing; a spawn failure -> same error
//   timeout a hung shell -> error (not ready) at the deadline, the whole process group is killed
//   ic_const the listing always runs the shell as -ic: no flags parameter, no flags source text
//   outer_env os.userInfo() throws + a fake process.env.USER: the spawned shell's env holds no value taken from process.env
//   det-*   Détecter: one match -> filled, several -> candidates, none -> introuvable, CLAUDE_DECK_BIN and
//           the other refused prefixes never a candidate
//   statuses all five slot statuses are produced
//   valid-name, routing (allowlist: bash as given, every other shell through /bin/bash with a note)
//   dash_via_bash, no_compgen (a shell without the compgen builtin fails the listing instead of listing nothing)
//   Every fake shell is a copy of the fixture named `bash` in its own mkdtemp folder (the allowlist goes by basename).
//   macOS support (L7): zsh is listed only on darwin, with its own native command; darwin is stubbed through
//   process.platform on Linux, so the darwin branch is observed on both systems. A gate prints PASS, FAIL or
//   SKIP (a skipped gate counts neither way; run.sh lists it in its SKIPPED line).
//   pa-zsh-list     a real zsh lists the names exported from ~/.zshrc (macOS; Linux only when a zsh is installed)
//   pa-zsh-fake     a zsh-named shell is run as `-ic <zsh listing>` inside the same fence; its output is parsed
//   pa-zsh-fallback a zsh whose listing fails -> the /bin/bash listing and the unsupported note
//   pa-zsh-absent   a zsh path that does not exist -> the /bin/bash fallback and the unsupported note
//   pa-zsh-linux    linux: zsh keeps the bash fallback, even a runnable zsh is never started (skipped on darwin)
//   pa-bash-unchanged bash: same command, args and routing as before, a .bashrc export is listed
//   pa-outer-path   OUTER_PATH of plugin-access and of plugin-runner: Homebrew first on darwin, unchanged on linux
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { spawnSync } = cp;
const { app } = require('electron');

const SRC = process.env.PLUGIN_ACCESS_SRC ? path.resolve(process.env.PLUGIN_ACCESS_SRC) : path.join(__dirname, '..', 'src', 'main');
const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'fake-shell.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugin-access-probe-'));
const ERROR_FR = 'Lecture du shell impossible';
const EXPORTED = ['DECK_FAKE_API_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_APP_TOKEN', 'CLAUDE_HARNESS_API_KEY', 'AIKIDO_API_KEY',
  'ANTHROPIC_API_KEY', 'CLAUDE_DECK_BIN'];
const FAKE_VALUES = EXPORTED.map((n) => `FAKE-SECRET-${n}-7q2x91`);

const origLog = console.log.bind(console);
const results = [];

// A "shell" that records its own env and its first argument, then runs as a plain bash: lets a gate read the real outer env.
// Every fake shell is named `bash` (in its own folder): the listing runs only bash as given, any other name goes to /bin/bash.
function shellNamedBash(folder, content) {
  const dir = path.join(TMP, folder);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'bash');
  fs.writeFileSync(p, content, { mode: 0o755 });
  return p;
}

function dumpShell(name) {
  const p = shellNamedBash(`dump-${name}`, '');
  fs.writeFileSync(p, `#!/bin/bash\nenv > '${p}.env'\nprintf '%s\\n' "$1" > '${p}.arg'\nexec /bin/bash --norc "$@"\n`, { mode: 0o755 });
  return p;
}

// A copy of the fixture whose variant switch (`case "${0##*/}"`) sees `fake-shell-<name>.sh`, as when it was linked under that name.
function variant(name) {
  const src = fs.readFileSync(FIXTURE, 'utf8');
  const body = src.replace('case "${0##*/}" in', `case "fake-shell-${name}.sh" in`);
  assert.notStrictEqual(body, src, 'the fixture variant switch moved');
  return shellNamedBash(`variant-${name}`, body);
}
const hits = (obj) => { const s = JSON.stringify(obj); return FAKE_VALUES.filter((v) => s.includes(v)).length + (s.includes('FAKE-SECRET') ? 1 : 0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Skip extends Error {}
const skip = (reason) => { throw new Skip(reason); };

async function gate(name, desc, fn) {
  let ok = true;
  let info = '';
  try { await fn(); } catch (e) {
    if (e instanceof Skip) {
      results.push({ name, ok: true, skipped: true });
      origLog(`SKIP ${name} — ${e.message}`);
      return;
    }
    ok = false;
    info = String((e && e.message) || e).split('\n').slice(0, 3).join(' | ');
  }
  results.push({ name, ok });
  origLog(`${ok ? 'PASS' : 'FAIL'} ${name} — ${desc}${info ? ` :: ${info}` : ''}`);
}

// Linux lists /proc; macOS has no /proc, `ps` prints "pid command" with the arguments space-joined where cmdline is NUL-joined.
const pidsRunning = (needle) => {
  if (process.platform === 'darwin') {
    const flat = needle.replace(/\0/g, ' ');
    const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
    return String(ps.stdout || '').split('\n').filter((l) => l.includes(flat)).map((l) => l.trim().split(/\s+/)[0]);
  }
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
    try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(needle); } catch (_) { return false; }
  });
};

const HEAD_PATH = '/usr/local/bin:/usr/bin:/bin';
const DARWIN_PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:${HEAD_PATH}`;
const WANT_PATH = process.platform === 'darwin' ? DARWIN_PATH : HEAD_PATH;
const UNSUPPORTED = 'shell non pris en charge, lecture via bash';
const BEGIN = '__CLAUDE_DECK_NAMES_BEGIN__';
const FIN = '__CLAUDE_DECK_NAMES_END__';
const ZSH_EXPR = 'print -rl -- ${(k)parameters[(R)*export*]}';
// The bash listing command as it was before the macOS work.
const BASH_LIST_CMD_HEAD = "printf '%s\\n' __CLAUDE_DECK_NAMES_BEGIN__ >&3; compgen -e >&3 || exit 1; printf '%s\\n' __CLAUDE_DECK_NAMES_END__ >&3";

// process.platform for the duration of fn (the module reads it at call time).
async function onPlatform(name, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', saved); }
}
// os.userInfo() pointing at a throwaway HOME, so a real shell never reads the real user's rc files.
async function inHome(home, fn) {
  const saved = os.userInfo;
  os.userInfo = () => ({ username: 'probe', homedir: home, shell: '/bin/sh' });
  try { return await fn(); } finally { os.userInfo = saved; }
}
function tmpHome(rcName, rcBody) {
  const h = fs.mkdtempSync(path.join(TMP, 'home-'));
  if (rcName) fs.writeFileSync(path.join(h, rcName), rcBody);
  return h;
}
// A shell named `base` in its own folder that records its arguments (one per line) in `<path>.args`, then runs `body`.
function recordingShell(base, folder, body) {
  const dir = path.join(TMP, folder);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, base);
  fs.writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' "$@" > '${p}.args'\n${body}`, { mode: 0o755 });
  return p;
}
const argsOf = (p) => fs.readFileSync(`${p}.args`, 'utf8').split('\n').slice(0, -1);
function realZsh() {
  if (process.platform === 'darwin' && fs.existsSync('/bin/zsh')) return '/bin/zsh';
  const r = spawnSync('/bin/sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
  const p = String(r.stdout || '').trim();
  return r.status === 0 && path.isAbsolute(p) ? p : null;
}

async function run() {
  await app.whenReady();
  const access = require(path.join(SRC, 'plugin-access.js'));
  const { listNames, detect, status, validName } = access;
  const plain = variant('plain');

  // The daily-brief slots (contract § 1), reused as the realistic fixture.
  const SLOTS = [
    { name: 'JIRA_URL', label: 'Adresse Jira', required: true, hints: ['JIRA', 'URL'] },
    { name: 'JIRA_EMAIL', label: 'Identifiant Jira (e-mail)', required: true, hints: ['JIRA', 'USER'] },
    { name: 'JIRA_TOKEN', label: 'Jeton Jira', required: true, hints: ['FAKE', 'TOKEN'] },
    { name: 'SLACK_TOKEN', label: 'Jeton Slack (utilisateur)', required: true, hints: ['SLACK', 'USER', 'TOKEN'] },
    { name: 'CLAUDE_KEY', label: 'Clé API Claude (lot test)', required: true, hints: ['CLAUDE', 'KEY'] },
    { name: 'AIKIDO_KEY', label: 'Clé Aikido', required: false, hints: ['AIKIDO', 'KEY'] },
  ];

  await gate('a', 'listNames / detect / status results hold no fake secret value (names only)', async () => {
    const listed = await listNames(plain);
    assert.strictEqual(listed.ok, true, `listing failed: ${JSON.stringify(listed)}`);
    for (const n of EXPORTED) assert.ok(listed.names.includes(n), `missing name ${n}`);
    assert.ok(listed.names.every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), 'a listed line is not a plain name');
    assert.strictEqual(new Set(listed.names).size, listed.names.length, 'duplicate names');
    const d = detect(SLOTS, listed.names);
    const s = status(SLOTS, { JIRA_TOKEN: 'DECK_FAKE_API_TOKEN', SLACK_TOKEN: 'SLACK_USER_TOKEN', AIKIDO_KEY: 'NOT_EXPORTED' }, listed.names);
    assert.strictEqual(hits(listed) + hits(d) + hits(s), 0, 'a fake secret value reached a result');
    // control: the fake shell really exports the values, so a leak would be visible to this scan
    const raw = spawnSync(plain, ['-ic', 'printenv DECK_FAKE_API_TOKEN'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.ok(raw.stdout.includes('FAKE-SECRET-DECK_FAKE_API_TOKEN-7q2x91'), 'control: the fake shell does not export the fake value');
    const keys = new Set(['name', 'label', 'required', 'hints', 'mapped', 'status', 'candidates']);
    assert.ok([...d, ...s].every((r) => Object.keys(r).every((k) => keys.has(k))), 'unexpected key on a row');
  });

  await gate('a2', 'a fake rc printing the fake secret on stdout and stderr: 0 hits in the listNames result', async () => {
    const rc = variant('rc');
    const control = spawnSync(rc, ['-ic', 'true'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.ok(control.stdout.includes('FAKE-SECRET-DECK_FAKE_API_TOKEN-7q2x91'), 'control: the rc does not print on stdout');
    assert.ok(control.stderr.includes('FAKE-SECRET-DECK_FAKE_API_TOKEN-7q2x91'), 'control: the rc does not print on stderr');
    const listed = await listNames(rc);
    assert.strictEqual(listed.ok, true, `listing failed: ${JSON.stringify(listed)}`);
    assert.ok(listed.names.includes('DECK_FAKE_API_TOKEN'));
    assert.strictEqual(hits(listed), 0, 'rc output reached the listNames result');
    const fds = await listNames(variant('fds'));
    assert.strictEqual(fds.ok, true, `spawn stdio is not ['ignore','ignore','ignore','pipe']: ${JSON.stringify(fds)}`);
  });

  await gate('marker', 'no marker on fd 3 -> « Lecture du shell impossible »; an empty listing is not an error', async () => {
    const none = await listNames(variant('nomarker'));
    assert.deepStrictEqual([none.ok, none.error, none.reason], [false, ERROR_FR, 'no-marker']);
    const gone = await listNames(path.join(TMP, 'gone', 'bash'));
    assert.deepStrictEqual([gone.ok, gone.error], [false, ERROR_FR]);
    const empty = await listNames(variant('empty'));
    assert.deepStrictEqual([empty.ok, empty.names], [true, []]);
  });

  await gate('timeout', 'a hung shell -> error at the deadline (not ready), process group killed', async () => {
    const t0 = Date.now();
    const hung = await listNames(variant('hang'), 400);
    const dt = Date.now() - t0;
    assert.deepStrictEqual([hung.ok, hung.error, hung.reason], [false, ERROR_FR, 'timeout']);
    assert.ok(dt >= 350 && dt < 3000, `deadline not honoured: ${dt} ms`);
    await sleep(300);
    assert.deepStrictEqual(pidsRunning('sleep\u000031.7'), [], 'the hung shell group is still alive');
  });

  await gate('ic_const', 'the listing always runs the shell as -ic: no flags parameter reaches it, no flags text left in the module', async () => {
    const sh = dumpShell('arg');
    assert.strictEqual((await listNames(sh)).ok, true);
    assert.strictEqual(fs.readFileSync(`${sh}.arg`, 'utf8').trim(), '-ic');
    const f = variant('flags'); // fails unless it receives -lic
    assert.strictEqual((await listNames(f)).ok, false);
    assert.strictEqual((await listNames(f, ['-lic'])).ok, false, 'a flags argument still reaches the shell');
    assert.strictEqual((await listNames(plain)).ok, true);
    const src = fs.readFileSync(path.join(SRC, 'plugin-access.js'), 'utf8');
    assert.ok(!/validFlags|shellFlags|'flags'/.test(src), 'flags handling is still in plugin-access.js');
  });

  await gate('outer_env', 'os.userInfo() throws + a fake process.env.USER / HOME: the outer env holds no value taken from process.env', async () => {
    const src = fs.readFileSync(path.join(SRC, 'plugin-access.js'), 'utf8');
    assert.ok(!/process\.env/.test(src), 'plugin-access.js still reads process.env');
    assert.ok(!/os\.homedir/.test(src), 'plugin-access.js still calls os.homedir(), which returns $HOME');
    const sh = dumpShell('env');
    const FAKE = 'FAKE-ENV-USER-3k8d55';
    const FAKE_HOME = '/tmp/FAKE-ENV-HOME-7q2w91';
    const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME, HOME: process.env.HOME, userInfo: os.userInfo };
    process.env.USER = FAKE;
    process.env.LOGNAME = FAKE;
    process.env.HOME = FAKE_HOME;
    os.userInfo = () => { throw new Error('no passwd entry'); };
    let r;
    try { r = await listNames(sh); } finally {
      os.userInfo = saved.userInfo;
      for (const k of ['USER', 'LOGNAME', 'HOME']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    assert.strictEqual(r.ok, true, `listing failed: ${JSON.stringify(r)}`);
    const dumped = fs.readFileSync(`${sh}.env`, 'utf8');
    assert.ok(!dumped.includes(FAKE) && !dumped.includes(FAKE_HOME), 'a process.env value reached the outer env');
    const lines = dumped.split('\n');
    assert.ok(lines.includes('USER=') && lines.includes('LOGNAME=') && lines.includes('HOME='), 'USER / LOGNAME / HOME are not empty when there is no passwd entry');
    assert.ok(lines.includes(`PATH=${WANT_PATH}`) && lines.includes(`SHELL=${sh}`), 'PATH / SHELL are not the constants');
  });

  await gate('det-one', 'one match -> pre-filled', async () => {
    const d = detect(SLOTS, ['PATH', 'DECK_FAKE_API_TOKEN', 'DECK_FAKE_API_URL_X', 'HOME']);
    const row = d.find((r) => r.name === 'JIRA_TOKEN');
    assert.deepStrictEqual([row.mapped, row.status, row.candidates], ['DECK_FAKE_API_TOKEN', 'présente', ['DECK_FAKE_API_TOKEN']]);
    assert.deepStrictEqual([row.label, row.required, row.hints], [SLOTS[2].label, true, SLOTS[2].hints]);
    // real listing through the fake shell: the table of the contract
    const names = (await listNames(plain)).names;
    const byName = Object.fromEntries(detect(SLOTS, names).map((r) => [r.name, r]));
    assert.strictEqual(byName.SLACK_TOKEN.mapped, 'SLACK_USER_TOKEN');
    assert.strictEqual(byName.CLAUDE_KEY.mapped, 'CLAUDE_HARNESS_API_KEY');
    assert.strictEqual(byName.AIKIDO_KEY.mapped, 'AIKIDO_API_KEY');
  });

  await gate('det-many', 'two matches -> both candidates, nothing pre-filled', async () => {
    const d = detect(SLOTS, ['DECK_FAKE_API_TOKEN', 'DECK_FAKE_TOKEN_OLD', 'X']).find((r) => r.name === 'JIRA_TOKEN');
    assert.deepStrictEqual([d.mapped, d.status, d.candidates], [null, 'plusieurs trouvées', ['DECK_FAKE_API_TOKEN', 'DECK_FAKE_TOKEN_OLD']]);
  });

  await gate('det-none', 'no match -> « introuvable »', async () => {
    const names = (await listNames(plain)).names;
    const byName = Object.fromEntries(detect(SLOTS, names).map((r) => [r.name, r]));
    for (const n of ['JIRA_URL', 'JIRA_EMAIL']) assert.deepStrictEqual([byName[n].mapped, byName[n].status, byName[n].candidates], [null, 'introuvable', []], n);
    // a slot without hints never matches everything
    const open = detect([{ name: 'X', label: 'x', required: true, hints: [] }], ['A', 'B'])[0];
    assert.deepStrictEqual([open.status, open.candidates], ['introuvable', []]);
  });

  await gate('det-refused', 'CLAUDE_DECK_BIN (and ANTHROPIC_ / ELECTRON_ / DECK_PLUGIN_ names) never a candidate', async () => {
    const names = (await listNames(plain)).names;
    assert.ok(names.includes('CLAUDE_DECK_BIN') && names.includes('ANTHROPIC_API_KEY'), 'control: the refused names are listed');
    const slots = [
      { name: 'A', label: 'a', required: true, hints: ['CLAUDE', 'BIN'] },
      { name: 'B', label: 'b', required: true, hints: ['DECK'] },
      { name: 'C', label: 'c', required: true, hints: ['ANTHROPIC'] },
      { name: 'D', label: 'd', required: true, hints: ['KEY'] },
      { name: 'E', label: 'e', required: true, hints: ['TOKEN'] },
    ];
    const d = Object.fromEntries(detect(slots, [...names, 'ELECTRON_RUN_AS_NODE_KEY', 'DECK_PLUGIN_ID_TOKEN', 'NPM_TOKEN']).map((r) => [r.name, r]));
    for (const n of ['A', 'C']) assert.deepStrictEqual(d[n].candidates, [], n);
    // 'DECK' holds in two refused names and in the fake key: only the fake key (not a refused prefix) stays a candidate
    assert.deepStrictEqual(d.B.candidates, ['DECK_FAKE_API_TOKEN'], 'B');
    assert.ok(!d.D.candidates.some((c) => /^(ANTHROPIC_|CLAUDE_DECK_|ELECTRON_|DECK_PLUGIN_)/.test(c)));
    assert.ok(d.D.candidates.includes('CLAUDE_HARNESS_API_KEY'));
    assert.ok(d.E.candidates.includes('NPM_TOKEN'), 'npm_ is not a refused prefix');
    assert.ok(!d.E.candidates.includes('DECK_PLUGIN_ID_TOKEN'));
  });

  await gate('statuses', 'all five statuses are produced (présente, absente, nom invalide, plusieurs trouvées, introuvable)', async () => {
    const slots = ['S_OK', 'S_GONE', 'S_BAD', 'S_MANY', 'S_NONE', 'constructor'].map((name) => ({ name, label: name, required: true, hints: name === 'S_MANY' ? ['TOK_'] : ['ZZZ'] }));
    const names = ['HOME', 'MY_TOK_A', 'OTHER_TOK_B', 'DECK_FAKE_API_TOKEN'];
    const envMap = { S_OK: 'DECK_FAKE_API_TOKEN', S_GONE: 'NOT_EXPORTED', S_BAD: 'bad name;rm' };
    const rows = Object.fromEntries(status(slots, envMap, names).map((r) => [r.name, r]));
    assert.strictEqual(rows.S_OK.status, 'présente');
    assert.strictEqual(rows.S_GONE.status, 'absente');
    assert.strictEqual(rows.S_BAD.status, 'nom invalide');
    assert.strictEqual(rows.S_MANY.status, 'plusieurs trouvées');
    assert.deepStrictEqual(rows.S_MANY.candidates, ['MY_TOK_A', 'OTHER_TOK_B']);
    assert.strictEqual(rows.S_NONE.status, 'introuvable');
    assert.strictEqual(rows.constructor.status, 'introuvable', 'an inherited property of envMap counted as a mapping');
    assert.deepStrictEqual([rows.S_OK.mapped, rows.S_GONE.mapped, rows.S_BAD.mapped, rows.S_MANY.mapped], ['DECK_FAKE_API_TOKEN', 'NOT_EXPORTED', 'bad name;rm', null]);
    // a mapped name is judged on itself, never pre-filled from a candidate
    assert.strictEqual(status([{ name: 'K', label: 'k', required: true, hints: ['TOK'] }], {}, ['MY_TOK'])[0].mapped, null);
    for (const bad of [42, {}, ['x'], true]) assert.strictEqual(status([{ name: 'K', label: 'k', required: true, hints: ['Q'] }], { K: bad }, [])[0].status, 'nom invalide');
    assert.strictEqual(status(SLOTS, null, null).length, SLOTS.length);
  });

  await gate('valid-name', 'validName: plain names only', async () => {
    for (const ok of ['DECK_FAKE_API_TOKEN', '_x', 'a1', 'A'.repeat(64)]) assert.strictEqual(validName(ok), true, ok);
    for (const bad of ['', '1A', 'A-B', 'A B', 'A=B', 'A;B', '$(x)', 'A\n', 'é', 'A'.repeat(65), null, undefined, 3, {}, ['A']]) assert.strictEqual(validName(bad), false, String(bad));
  });

  await gate('routing', 'allowlist: bash as given; any other shell (zsh, fish, sh, dash, ksh, mksh, ...) is read through /bin/bash with a note', async () => {
    const r = access.listingShell;
    const others = ['/usr/bin/zsh', '/bin/fish', '/usr/bin/tcsh', '/bin/sh', '/bin/dash', '/usr/bin/ksh', '/usr/bin/mksh', '/usr/bin/ash', '/usr/bin/rbash', '/opt/bash/sh', FIXTURE];
    // darwin accepts a zsh that exists (pa-zsh-* gates); every other shell, and zsh elsewhere, goes through bash
    for (const sh of others.filter((s) => !(process.platform === 'darwin' && path.basename(s) === 'zsh'))) assert.deepStrictEqual([r(sh).shell, r(sh).note], ['/bin/bash', 'shell non pris en charge, lecture via bash'], sh);
    for (const sh of ['/usr/bin/bash', '/bin/bash', plain]) assert.deepStrictEqual([r(sh).shell, r(sh).note], [sh, null], sh);
    assert.deepStrictEqual([r('').shell, r(undefined).shell, r('').note, r(null).note], ['/bin/bash', '/bin/bash', null, null]);
  });

  await gate('dash_via_bash', 'a dash shell is listed through /bin/bash: names found, note set (dash has no compgen)', async () => {
    const home = fs.mkdtempSync(path.join(TMP, 'home-')); // the real /bin/bash -ic runs here: no rc of the real user is read
    const saved = os.userInfo;
    os.userInfo = () => ({ username: 'probe', homedir: home, shell: '/bin/dash' });
    let r;
    try { r = await listNames('/bin/dash'); } finally { os.userInfo = saved; }
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.note, 'shell non pris en charge, lecture via bash', `note: ${r.note}`);
    assert.ok(r.names.includes('PATH') && r.names.includes('HOME'), `names read through bash expected, got ${JSON.stringify(r.names)}`);
  });

  await gate('no_compgen', 'a bash-named shell without the compgen builtin -> « Lecture du shell impossible », not an empty listing', async () => {
    const nc = shellNamedBash('nocompgen', "#!/bin/bash\nexec /bin/bash --rcfile <(echo 'enable -n compgen') \"$@\"\n");
    const r = await listNames(nc);
    assert.deepStrictEqual([r.ok, r.error, r.reason], [false, ERROR_FR, 'incomplete'], JSON.stringify(r));
  });

  await gate('pa-zsh-list', 'a real zsh lists the names exported from ~/.zshrc, no unsupported note (darwin; Linux when zsh is installed, darwin stubbed)', async () => {
    const zsh = realZsh();
    if (!zsh) skip('no zsh binary on this machine (/bin/zsh on macOS, command -v zsh elsewhere): the zsh-native listing is proved on macOS only');
    const home = tmpHome('.zshrc', 'export DECK_FAKE_ZSH=1\n');
    const r = await onPlatform('darwin', () => inHome(home, () => listNames(zsh)));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.names.includes('DECK_FAKE_ZSH'), `DECK_FAKE_ZSH missing: ${JSON.stringify(r.names)}`);
    assert.ok(r.names.includes('HOME') && r.names.includes('PATH'), 'the zsh listing misses HOME / PATH');
    assert.strictEqual(r.note, null, `the zsh listing was routed through bash: ${r.note}`);
  });

  await gate('pa-zsh-fake', 'darwin: a zsh-named shell runs -ic with the zsh-native listing inside the fence; its output is parsed like a bash one', async () => {
    const z = recordingShell('zsh', 'fake-zsh', `printf '%s\\n' 'rc noise' ${BEGIN} DECK_FAKE_ZSH PATH PATH 'bad name' 9X '' ${FIN} >&3\n`);
    const r = await onPlatform('darwin', () => inHome(tmpHome(), () => listNames(z)));
    assert.ok(fs.existsSync(`${z}.args`), `the zsh shell was never run, routed elsewhere: ${JSON.stringify({ ok: r.ok, note: r.note })}`);
    const args = argsOf(z);
    assert.strictEqual(args.length, 2, JSON.stringify(args));
    assert.strictEqual(args[0], '-ic');
    const cmd = args[1];
    assert.ok(cmd.includes(ZSH_EXPR), `no zsh-native listing in: ${cmd}`);
    assert.ok(cmd.indexOf(BEGIN) >= 0 && cmd.indexOf(BEGIN) < cmd.indexOf(ZSH_EXPR) && cmd.indexOf(ZSH_EXPR) < cmd.indexOf(FIN), 'the listing is not inside the fence');
    assert.ok(!cmd.includes('compgen'), 'a bash builtin reached the zsh command');
    assert.strictEqual(cmd.split('>&3').length - 1, 3, 'every fence part and the listing go to fd 3');
    assert.deepStrictEqual([r.ok, r.names, r.note], [true, ['DECK_FAKE_ZSH', 'PATH'], null], JSON.stringify(r));
  });

  await gate('pa-zsh-fallback', 'darwin: a zsh whose listing fails -> the /bin/bash listing and the unsupported note', async () => {
    const z = recordingShell('zsh', 'failing-zsh', 'exit 1\n');
    const r = await onPlatform('darwin', () => inHome(tmpHome(), () => listNames(z)));
    assert.deepStrictEqual([r.ok, r.note], [true, UNSUPPORTED], JSON.stringify(r));
    assert.ok(r.names.includes('PATH') && r.names.includes('HOME'), `names read through bash expected, got ${JSON.stringify(r.names)}`);
  });

  await gate('pa-zsh-absent', 'a zsh path that does not exist -> the /bin/bash fallback and the unsupported note, on both platforms', async () => {
    const gone = '/nonexistent/zsh';
    for (const plat of ['darwin', 'linux']) {
      await onPlatform(plat, async () => {
        const s = access.listingShell(gone);
        assert.deepStrictEqual([s.shell, s.note], ['/bin/bash', UNSUPPORTED], plat);
        const r = await inHome(tmpHome(), () => listNames(gone));
        assert.deepStrictEqual([r.ok, r.note], [true, UNSUPPORTED], `${plat}: ${JSON.stringify(r)}`);
        assert.ok(r.names.includes('PATH'), `${plat}: names read through bash expected`);
      });
    }
  });

  await gate('pa-zsh-linux', 'linux: zsh keeps the /bin/bash fallback and the unsupported note; a runnable zsh is never started', async () => {
    if (process.platform === 'darwin') skip('darwin accepts zsh (see pa-zsh-list)');
    const z = recordingShell('zsh', 'linux-zsh', 'exit 0\n');
    for (const sh of ['/bin/zsh', '/usr/bin/zsh', z]) {
      const s = access.listingShell(sh);
      assert.deepStrictEqual([s.shell, s.note], ['/bin/bash', UNSUPPORTED], sh);
    }
    const r = await inHome(tmpHome(), () => listNames(z));
    assert.deepStrictEqual([r.ok, r.note], [true, UNSUPPORTED], JSON.stringify(r));
    assert.ok(!fs.existsSync(`${z}.args`), 'a zsh shell was started on linux');
  });

  await gate('pa-bash-unchanged', 'SHELL=/bin/bash: same routing, command and args as before; the listing holds a .bashrc export', async () => {
    assert.deepStrictEqual(access.listingShell('/bin/bash'), { shell: '/bin/bash', note: null });
    const rec = recordingShell('bash', 'argv-bash', 'exec /bin/bash --norc "$@"\n');
    assert.strictEqual((await listNames(rec)).ok, true);
    assert.deepStrictEqual(argsOf(rec), ['-ic', BASH_LIST_CMD_HEAD]);
    const home = tmpHome('.bashrc', 'export DECK_FAKE_BASHRC=1\n');
    const r = await inHome(home, () => listNames('/bin/bash'));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.names.includes('DECK_FAKE_BASHRC'), `DECK_FAKE_BASHRC missing: ${JSON.stringify(r.names)}`);
    assert.strictEqual(r.note, null);
  });

  await gate('pa-outer-path', 'OUTER_PATH (access and runner): Homebrew first on darwin, the previous value on linux', async () => {
    const accessPath = (plat) => onPlatform(plat, async () => {
      const sh = dumpShell(`path-${plat}`);
      assert.strictEqual((await listNames(sh)).ok, true);
      return fs.readFileSync(`${sh}.env`, 'utf8').split('\n').find((l) => l.startsWith('PATH=')).slice(5);
    });
    // The runner holds OUTER_PATH as a constant read at load: load a fresh copy under each platform, capture the spawn env.
    const runnerFile = path.join(SRC, 'plugin-runner.js');
    const runnerPath = async (plat) => {
      const dir = path.join(fs.mkdtempSync(path.join(TMP, `runner-${plat}-`)), 'p', 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const reports = { newEntry: () => ({ stem: 's1', reportPath: path.join(dir, 's1.html'), logPath: path.join(dir, 's1.log') }), finishEntry() {}, setPid() {}, latest: () => null };
      const mod = await onPlatform(plat, () => { delete require.cache[runnerFile]; return require(runnerFile); });
      delete require.cache[runnerFile];
      const realSpawn = cp.spawn;
      let seen = null;
      cp.spawn = (cmd, args, opts) => {
        seen = opts.env.PATH;
        const c = new EventEmitter();
        c.pid = undefined;
        c.unref = () => {};
        setImmediate(() => c.emit('exit', 0, null));
        return c;
      };
      try {
        const r = mod.create({ reports, validName, shellPath: '/bin/bash' }).run({ id: 'p', dir, argv: ['/bin/true'] }, {}, 'auto', {});
        assert.strictEqual(r.ok, true, JSON.stringify(r));
      } finally { cp.spawn = realSpawn; }
      return seen;
    };
    const same = (got, want, label) => assert.ok(got === want, `${label}: PATH=${got}`);
    same(await accessPath('darwin'), DARWIN_PATH, 'access, darwin');
    same(await accessPath('linux'), HEAD_PATH, 'access, linux');
    same(await runnerPath('darwin'), DARWIN_PATH, 'runner, darwin');
    same(await runnerPath('linux'), HEAD_PATH, 'runner, linux');
    assert.ok(DARWIN_PATH.split(':').includes('/opt/homebrew/bin'), 'control: the expected darwin value holds Homebrew');
  });

  const bad = results.filter((r) => !r.ok);
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  origLog(bad.length ? `VERDICT: FAILED (${ran - bad.length}/${ran}) ${bad.map((r) => r.name).join(' ')}`
    : `VERDICT: ALL GREEN (${ran}/${ran})${skipped ? ` + ${skipped} skipped` : ''}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* tmp stays */ }
  app.exit(bad.length ? 1 : 0);
}

setTimeout(() => { origLog('FAIL watchdog - probe exceeded 40 s'); app.exit(3); }, 40000).unref();
run().catch((e) => { origLog(`FAIL harness - ${(e && e.stack) || e}`.split('\n').slice(0, 3).join(' | ')); app.exit(2); });
