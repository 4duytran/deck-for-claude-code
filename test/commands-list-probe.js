// test/commands-list-probe.js — E2E probe: the `commands-list` IPC (B24 lot K-b, src/main/ipc/commands.js):
// the official command list (K1-K3, commands-feed.js) merged with the user's skills / commands read from disk (K4).
// Real app, fake HOME and a fake session folder opened as the pane's cwd; the renderer calls window.api.commandsList.
//   c0  the bridge exists
//   c1  pane list: user and project entries present with the right source, the `user-invocable: false` skill absent
//   c2  a project skill named like an official command replaces it (one entry, source project)
//   c3  a project command beats the user skill AND the user command of the same name
//   c4  a frontmatter-less command file is listed with an empty desc and args
//   c5  a `>` block description is read folded; a quoted description and `argument-hint` are read
//   c6  a description sitting past the 8 KB read cap yields no desc (the entry stays); an over-long one is cut at 160
//   c7  hidden /config absent, no HIDDEN command present, the official entries untouched (three /design by args)
//   c8  an unknown pane and a missing paneId: no throw, official + user entries only
//   c9  a hostile description comes back unchanged as a string
//   c10 shape: {name,args,desc,source} strings, sorted by name, names valid; nested folder, bad name, FIFO skipped
//   c11 a pane whose cwd is the HOME folder: those entries are `user`, none `project`
// Run: cd claude-deck && <env prefix of CLAUDE.md> xvfb-run -a node_modules/.bin/electron test/commands-list-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cmds-probe-'));
const HOME = path.join(base, 'home');
const PROJ = path.join(base, 'proj'); // the session folder
const OTHER = path.join(base, 'other'); // a session folder with no .claude
process.env.HOME = HOME; // os.homedir() reads it at call time: the real ~/.claude is never touched

const HOSTILE = '<img src=x onerror=alert(1)>';
const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });
const put = (file, text) => { mk(path.dirname(file)); fs.writeFileSync(file, text); };
const fm = (...lines) => `---\n${lines.join('\n')}\n---\nbody text\n`;
const skill = (root, dir, ...lines) => put(path.join(root, '.claude', 'skills', dir, 'SKILL.md'), fm(...lines));
const cmd = (root, file, text) => put(path.join(root, '.claude', 'commands', file), text);

mk(OTHER);
// user skills
skill(HOME, 'user-alpha', 'name: user-alpha', 'description: Alpha user skill');
skill(HOME, 'hidden-skill', 'name: hidden-skill', 'description: should not show', 'user-invocable: false');
skill(HOME, 'shared-skill', 'name: shared', 'description: USER-SKILL');
skill(HOME, 'block-skill', 'name: block-skill', 'description: >', '  folded line one', '  line two', 'argument-hint: x');
skill(HOME, 'literal-skill', 'name: literal-skill', 'description: |-', '  keep', '  these');
skill(HOME, 'quoted-skill', 'name: quoted-skill', 'description: "Quoted: with a colon"', 'argument-hint: "[arg]"');
skill(HOME, 'folder-named', 'description: name comes from the folder');
skill(HOME, 'big-desc', 'name: big-desc', `x-pad: ${'a'.repeat(9000)}`, 'description: late description');
skill(HOME, 'long-desc', 'name: long-desc', `description: ${'w'.repeat(300)}`);
skill(HOME, 'hostile', 'name: hostile', `description: ${HOSTILE}`);
skill(HOME, 'bad name!', 'name: bad name!', 'description: invalid name');
skill(HOME, '.dot-skill', 'description: dot start');
// user commands
cmd(HOME, 'plain-cmd.md', 'Do the thing, no frontmatter.\n');
cmd(HOME, 'shared.md', fm('description: USER-CMD'));
cmd(HOME, 'nested/inner.md', fm('description: nested, top level only'));
cmd(HOME, 'not-md.txt', 'ignored');
mk(HOME, '.claude', 'commands');
try { execFileSync('mkfifo', [path.join(HOME, '.claude', 'commands', 'fifo.md')]); } catch (_) { /* no mkfifo: gate still holds */ }
// project entries
skill(PROJ, 'batch', 'name: batch', 'description: PROJECT BATCH');
skill(PROJ, 'proj-only', 'name: proj-only', 'description: Only in the project');
cmd(PROJ, 'shared.md', fm('description: PROJECT-CMD'));
cmd(PROJ, 'proj-cmd.md', fm('description: Project command', 'argument-hint: <file>'));

const fakeProjects = path.join(base, 'projects');
mk(fakeProjects);
// A stub that stays alive: /bin/bash would exit on the injected `--settings` argv and the pane
// registry entry (the source of the session folder) would vanish. Never the real claude.
const STUB = path.join(base, 'fake-claude.sh');
fs.writeFileSync(STUB, '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
process.env.CLAUDE_DECK_BIN = STUB;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects;
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cmds-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cmds-status-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const { visibleCommands, HIDDEN_COMMANDS } = require(path.join(__dirname, '..', 'src', 'main', 'commands-feed.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 80 ? `${x.slice(0, 80)}...(${x.length})` : x));

app.whenReady().then(async () => {
  const results = {};
  const detail = {};
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 90s'); app.exit(2); }, 90000);
  try {
    let win = null;
    for (let i = 0; i < 300 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (win) {
        const ready = await win.webContents.executeJavaScript(
          `!!(window.api && window.api.openTerminal)`, true).catch(() => false);
        if (!ready) win = null;
      }
      if (!win) await sleep(100);
    }
    if (!win) throw new Error('renderer never became ready');
    const j = (code) => win.webContents.executeJavaScript(code, true);
    const gate = (name, cases) => {
      results[name] = cases.length > 0 && cases.every((c) => c[1]);
      detail[name] = cases.filter((c) => !c[1]).map((c) => `${c[0]} -> ${short(c[2])}`);
    };
    // never throws, never hangs: a FIFO that blocked the handler would show here as `hung`
    const list = (paneId) => Promise.race([
      j(`window.api.commandsList(${paneId === undefined ? '' : JSON.stringify(paneId)})`)
        .catch((e) => ({ threw: String(e && e.message || e) })),
      sleep(6000).then(() => ({ hung: true })),
    ]);
    const open = (paneId, cwd) => j(`window.api.openTerminal({ paneId: ${JSON.stringify(paneId)}, cwd: ${JSON.stringify(cwd)}, cols: 80, rows: 24 })`);

    gate('c0_bridge_exists', [['typeof window.api.commandsList', await j(`typeof window.api.commandsList === 'function'`), null]]);

    const o1 = await open('cl-1', PROJ);
    const o2 = await open('cl-2', HOME);
    const registered = require(path.join(__dirname, '..', 'src', 'main', 'state.js')).ptys.has('cl-1');
    const root = await require(path.join(__dirname, '..', 'src', 'main', 'ipc', 'files-panel.js')).sessionRoot({ paneId: 'cl-1' });
    gate('c1a_pane_registry_resolves_the_folder', [
      ['pane cl-1 registered', registered, registered],
      ['sessionRoot -> the session folder', !!root && root.root === fs.realpathSync(PROJ), root],
    ]);
    const L = await list('cl-1');
    const isArr = Array.isArray(L);
    const A = isArr ? L : [];
    const by = (name) => A.filter((e) => e.name === name);
    const one = (name) => (by(name).length === 1 ? by(name)[0] : null);
    const d = (name) => { const e = one(name); return e ? e.desc : undefined; };
    const src = (name) => { const e = one(name); return e ? e.source : undefined; };

    gate('c1_user_and_project_entries', [
      ['panes opened', !!(o1 && o1.ok && o2 && o2.ok), [o1, o2]],
      ['payload is an array', isArr, L],
      ['/user-alpha user', src('/user-alpha') === 'user' && d('/user-alpha') === 'Alpha user skill', one('/user-alpha')],
      ['/proj-only project', src('/proj-only') === 'project' && d('/proj-only') === 'Only in the project', one('/proj-only')],
      ['/proj-cmd project + args', src('/proj-cmd') === 'project' && (one('/proj-cmd') || {}).args === '<file>', one('/proj-cmd')],
      ['/folder-named from the folder', src('/folder-named') === 'user', one('/folder-named')],
      ['user-invocable false absent', by('/hidden-skill').length === 0, by('/hidden-skill')],
    ]);
    gate('c2_project_skill_replaces_official', [
      ['official /batch exists in the applied list', visibleCommands().some((e) => e.name === '/batch'), null],
      ['one /batch, project, PROJECT BATCH', by('/batch').length === 1 && src('/batch') === 'project' && d('/batch') === 'PROJECT BATCH', by('/batch')],
    ]);
    gate('c3_project_command_beats_user', [
      ['one /shared', by('/shared').length === 1, by('/shared')],
      ['source project, PROJECT-CMD', src('/shared') === 'project' && d('/shared') === 'PROJECT-CMD', one('/shared')],
    ]);
    gate('c4_frontmatterless_command_listed', [
      ['/plain-cmd user, empty desc and args',
        !!one('/plain-cmd') && src('/plain-cmd') === 'user' && d('/plain-cmd') === '' && one('/plain-cmd').args === '', one('/plain-cmd')],
    ]);
    gate('c5_scalars_read', [
      ['> block folded', d('/block-skill') === 'folded line one line two' && (one('/block-skill') || {}).args === 'x', one('/block-skill')],
      ['|- block', d('/literal-skill') === 'keep these', one('/literal-skill')],
      ['quoted desc + quoted hint', d('/quoted-skill') === 'Quoted: with a colon' && (one('/quoted-skill') || {}).args === '[arg]', one('/quoted-skill')],
    ]);
    gate('c6_caps', [
      ['past 8 KB: listed, no desc', !!one('/big-desc') && d('/big-desc') === '', one('/big-desc')],
      ['300 chars cut to 160', !!one('/long-desc') && d('/long-desc') === 'w'.repeat(160), one('/long-desc')],
    ]);
    const official = visibleCommands();
    const design = A.filter((e) => e.name === '/design');
    gate('c7_official_list_intact', [
      ['/config absent', by('/config').length === 0, by('/config')],
      ['no hidden command present', !A.some((e) => HIDDEN_COMMANDS.has(e.name)), A.filter((e) => HIDDEN_COMMANDS.has(e.name)).map((e) => e.name)],
      ['three /design told apart by args',
        design.length === 3 && design.every((e) => e.source === 'cli')
        && JSON.stringify(design.map((e) => e.args).sort()) === JSON.stringify(official.filter((e) => e.name === '/design').map((e) => e.args).sort()), design],
      ['every official entry not replaced is there unchanged',
        official.filter((e) => e.name !== '/batch' && e.name !== '/design').every((e) => by(e.name).some((x) => x.source === 'cli' && x.args === e.args && x.desc === e.desc)),
        official.filter((e) => e.name !== '/batch' && e.name !== '/design' && !by(e.name).some((x) => x.source === 'cli')).map((e) => e.name)],
    ]);
    const U = await list('no-such-pane');
    const N = await list();
    const baseOk = (x) => Array.isArray(x) && x.some((e) => e.source === 'cli') && x.some((e) => e.name === '/user-alpha' && e.source === 'user')
      && !x.some((e) => e.source === 'project') && !x.some((e) => e.name === '/proj-only');
    gate('c8_unknown_pane', [
      ['unknown pane: official + user only', baseOk(U), U && U.threw ? U : Array.isArray(U) ? U.filter((e) => e.source === 'project').length : U],
      ['missing paneId: official + user only', baseOk(N), N && N.threw ? N : Array.isArray(N) ? N.filter((e) => e.source === 'project').length : N],
      ['unknown pane still replaced nothing: /batch is the official one', Array.isArray(U) && U.filter((e) => e.name === '/batch').length === 1
        && U.find((e) => e.name === '/batch').source === 'cli', Array.isArray(U) ? U.filter((e) => e.name === '/batch') : U],
    ]);
    const h = one('/hostile');
    gate('c9_hostile_description_is_text', [
      ['desc is exactly the hostile string', !!h && typeof h.desc === 'string' && h.desc === HOSTILE, h],
    ]);
    const NAME_RE = /^\/[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
    const sorted = A.every((e, i) => i === 0 || A[i - 1].name.toLowerCase() <= e.name.toLowerCase());
    gate('c10_shape_and_skips', [
      ['non-empty array', isArr && A.length > 60, A.length],
      ['shape and source set', A.every((e) => JSON.stringify(Object.keys(e).sort()) === '["args","desc","name","source"]'
        && typeof e.name === 'string' && typeof e.args === 'string' && typeof e.desc === 'string' && ['cli', 'user', 'project'].includes(e.source)),
        A.filter((e) => !(typeof e.args === 'string' && typeof e.desc === 'string')).slice(0, 2)],
      ['names valid', A.every((e) => NAME_RE.test(e.name) || /^\/[a-z][a-z0-9-]*$/.test(e.name)), A.filter((e) => !NAME_RE.test(e.name)).map((e) => e.name)],
      ['sorted by name', sorted, A.map((e) => e.name).slice(0, 8)],
      ['nested/inner, not-md, bad name, dot, fifo skipped',
        ['/inner', '/nested/inner', '/not-md', '/bad name!', '/.dot-skill', '/fifo'].every((n) => by(n).length === 0)
        && !A.some((e) => /^\/(nested|bad|\.)/.test(e.name)), A.filter((e) => /inner|nested|not-md|bad|dot|fifo/.test(e.name)).map((e) => e.name)],
    ]);
    const H = await list('cl-2');
    gate('c11_home_folder_pane_is_user_only', [
      ['array', Array.isArray(H), H],
      ['no project source', Array.isArray(H) && !H.some((e) => e.source === 'project'), Array.isArray(H) ? H.filter((e) => e.source === 'project').map((e) => e.name) : H],
      ['/user-alpha user', Array.isArray(H) && H.some((e) => e.name === '/user-alpha' && e.source === 'user'), null],
      ['project-only entries absent', Array.isArray(H) && !H.some((e) => e.name === '/proj-only'), null],
    ]);
  } catch (e) {
    results.probe_crashed = false;
    detail.probe_crashed = [String(e && e.stack || e)];
  }

  clearTimeout(watchdog);
  const names = Object.keys(results);
  for (const n of names) {
    console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}`);
    for (const dl of detail[n] || []) console.log(`     ${dl}`);
  }
  const ok = names.filter((n) => results[n]).length;
  const green = names.length > 0 && ok === names.length;
  console.log(green ? `VERDICT: ALL GREEN (${ok}/${names.length})` : `VERDICT: ${names.length - ok} FAILED (${ok}/${names.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  app.exit(green ? 0 : 1);
});
