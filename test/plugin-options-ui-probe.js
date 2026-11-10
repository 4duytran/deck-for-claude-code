'use strict';
// plugin-options-ui-probe — the « Appels Claude » control lives in the Paramètres tab of the Plugins panel and NOT in the access card.
// The REAL app boots over throwaway fixtures: three installed plugins, none enabled, none ever run. `daily-brief` declares the real
// option CLAUDE_MODE (Abonnement / API, default subscription) and the slots JIRA_TOKEN + CLAUDE_KEY (« Clé API Claude (mode API) »,
// not required); `plain` declares one slot and no option; `hostile` declares an option whose labels are markup. The "user's shell" is a
// copy of fake-shell.sh named `bash` (FAKE secrets, --norc): the real rc files are never read. Every click is a trusted mouse event.
//   c1 the daily-brief Paramètres tab shows « Appels Claude », Abonnement pressed by default
//   c2 API: plugins.json options.CLAUDE_MODE === 'api', the pressed state moves, survives the push and a re-entry of the tab, then back
//   c3 the CLAUDE_KEY row of the access card shows « Clé API Claude (mode API) » and « facultatif » (JIRA_TOKEN, required, does not)
//   c4 a plugin without options shows no control in its Paramètres tab nor in its access card
//   c5 text-only DOM: a markup label stays text in Paramètres (no element, no handler run), and plugin-panel.js holds no HTML sink
//   c6 the daily-brief access card is env vars only: no option block, no segment button, and its slot rows show
//   c7 « Enregistrer » on the access card: the « Accès » lines of the Paramètres tab show the saved name at once (no tab change), the focus is on « Modifier »
//   c8 plugin-list-claude-mode: the daily-brief LIST row shows ONE neutral badge « Abonnement » (title « Appels Claude : Abonnement »), right after the state badge
//   c9 the badge follows the pick: API chosen in Paramètres, back on the list the row reads « API » (title « Appels Claude : API »), then « Abonnement » again
//   c10 a plugin with no CLAUDE_MODE option (`plain`) and one with another option name (`hostile`) show no mode badge: the state badge only
//   c11 text-only: a CLAUDE_MODE whose labels are markup (`markup-mode`) stays text in the row (no element, no handler run)
//   c12 a malformed row (value matching no choice, options not an array, missing fields, another name) shows no badge and never the raw value (rows fed through the real plugins-list IPC)
// Run (from the repo root): env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//   xvfb-run -a node_modules/.bin/electron test/plugin-options-ui-probe.js
// PLUGIN_OPTIONS_UI_SHOTS=<dir> writes a PNG of the panel (diagnostic, never a gate).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const REPO = path.join(__dirname, '..');
const NAMES = ['c1_settings_label_subscription_default', 'c2_api_stored_and_pressed', 'c3_claude_key_row_label_optional', 'c4_no_option_no_control', 'c5_text_only_dom', 'c6_access_card_env_only', 'c7_access_lines_refresh_after_save',
  'c8_list_badge_default_abonnement', 'c9_list_badge_follows_pick', 'c10_list_no_badge_without_claude_mode', 'c11_list_badge_text_only', 'c12_list_badge_malformed_rows'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const detail = {};
let finished = false;

const HOSTILE_LABEL = '<img src=x onerror="window.__xss=1">Appels';
const HOSTILE_ABO = '<b>Abo</b>';
const HOSTILE_API = '<i onmouseover="window.__xss=2">API</i>';

// ---- fixtures ----------------------------------------------------------------------------------------------
function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-options-ui-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), plugins: path.join(root, 'plugins'), home: path.join(root, 'home'), projects: path.join(root, 'projects'),
    ask: path.join(root, 'ask'), status: path.join(root, 'status'), sh: path.join(root, 'sh') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const install = (id, manifest) => {
    const dir = path.join(dirs.plugins, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id, argv: ['run.sh'], trigger: 'manual', ...manifest }));
  };
  install('daily-brief', {
    label: 'Brief du jour', description: 'Brief quotidien (fixture)',
    env: [
      { name: 'JIRA_TOKEN', label: 'Jira — jeton API', required: true, hints: ['JIRA', 'TOKEN'] },
      { name: 'CLAUDE_KEY', label: 'Clé API Claude (mode API)', required: false, hints: ['CLAUDE', 'KEY'] },
    ],
    options: [{ name: 'CLAUDE_MODE', label: 'Appels Claude', default: 'subscription',
      choices: [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }] }],
  });
  install('plain', { label: 'Plugin sans option', description: 'Aucune option déclarée',
    env: [{ name: 'PLAIN_TOKEN', label: 'Jeton du plugin simple', required: false, hints: ['PLAIN'] }] });
  install('hostile', { label: 'Plugin piégé', description: 'Libellés de balisage',
    env: [{ name: 'HOSTILE_TOKEN', label: 'Jeton piégé', required: false, hints: ['HOSTILE'] }],
    options: [{ name: 'HOSTILE_MODE', label: HOSTILE_LABEL, default: 'abo', choices: [{ value: 'abo', label: HOSTILE_ABO }, { value: 'api', label: HOSTILE_API }] }] });
  // CLAUDE_MODE itself, but with markup labels: the list-row badge must stay text
  install('markup-mode', { label: 'Plugin balisé', description: 'CLAUDE_MODE aux libellés de balisage',
    env: [{ name: 'MARKUP_TOKEN', label: 'Jeton balisé', required: false, hints: ['MARKUP'] }],
    options: [{ name: 'CLAUDE_MODE', label: HOSTILE_LABEL, default: 'abo', choices: [{ value: 'abo', label: HOSTILE_ABO }, { value: 'api', label: HOSTILE_API }] }] });
  const shell = path.join(dirs.sh, 'bash');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'plugins', 'fake-shell.sh'), shell);
  fs.chmodSync(shell, 0o755);
  return { ...dirs, shell };
}

// ---- verdict -----------------------------------------------------------------------------------------------
function verdict(code) {
  if (finished) return;
  finished = true;
  for (const n of NAMES) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}${results[n] ? '' : ` ${JSON.stringify(detail[n])}`}`);
  const bad = NAMES.filter((k) => !results[k]);
  console.log(bad.length ? `VERDICT: RED (${NAMES.length - bad.length}/${NAMES.length} green) FAIL: ${bad.join(', ')}` : `VERDICT: ALL GREEN (${NAMES.length}/${NAMES.length})`);
  app.exit(code !== undefined ? code : (bad.length ? 1 : 0));
}

async function gate(name, fn) {
  try {
    const d = await fn();
    results[name] = d.ok === true;
    detail[name] = d;
  } catch (err) {
    results[name] = false;
    detail[name] = { threw: String(err && err.stack || err).slice(0, 400) };
  }
}

// ---- boot --------------------------------------------------------------------------------------------------
function boot() {
  const dirs = buildFixtures();
  app.setPath('userData', dirs.ud);
  process.env.HOME = dirs.home;
  Object.assign(process.env, {
    CLAUDE_DECK_BIN: '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: dirs.projects, CLAUDE_DECK_ASK_DIR: dirs.ask, CLAUDE_DECK_STATUS_DIR: dirs.status,
    CLAUDE_DECK_PLUGINS_DIR: dirs.plugins, CLAUDE_DECK_PLUGINS_NOW: '2026-11-03T09:00:00', CLAUDE_DECK_PLUGINS_SHELL: dirs.shell,
  });
  for (const k of ['CLAUDE_DECK_PRICES_URL', 'CLAUDE_DECK_COMMANDS_URL']) {
    process.env[k] ||= 'http://127.0.0.1:1';
  }
  require(path.join(REPO, 'main.js'));
  app.whenReady().then(() => run(dirs)).catch((err) => {
    console.log(`FAIL probe crashed: ${err && err.stack}`);
    verdict(2);
  });
}

async function run(dirs) {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 150 s' }; }
    verdict(2);
  }, 150000);
  watchdog.unref();

  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.plg)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  const rend = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const statePath = path.join(dirs.ud, 'plugins.json');
  const stored = (id, name) => {
    try { const e = JSON.parse(fs.readFileSync(statePath, 'utf8'))[id]; return e && e.options ? e.options[name] : undefined; } catch (_) { return undefined; }
  };
  const waitFor = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return true; await sleep(100); }
    return false;
  };
  // a trusted click at the centre of the element; false when the element is missing or empty
  const click = async (sel) => {
    const c = await rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect();`
      + ' return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width };');
    if (!c || !(c.w > 0)) return false;
    wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    return true;
  };
  const shot = async (name) => {
    if (!process.env.PLUGIN_OPTIONS_UI_SHOTS) return;
    const r = await rend("const b = document.getElementById('plugin-panel').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };");
    await sleep(500);
    wc.invalidate();
    await sleep(300);
    fs.writeFileSync(path.join(process.env.PLUGIN_OPTIONS_UI_SHOTS, name), (await wc.capturePage(r)).toPNG());
  };

  // the user's own path: the header button opens the panel, then « Modifier » on a row opens its access card
  await click('#plugin-toggle');
  await sleep(900); // the 900 ms entrance timer of the overlay
  const listed = await waitFor(() => rend("return plg.open === true && ['daily-brief', 'plain', 'hostile', 'markup-mode'].every((id) => !!document.querySelector('#plg-list .plg-row[data-id=\"' + id + '\"]'));"));
  // K5: a pick opens the plugin's detail page; V26: « Modifier » (data-act="access") sits in the « Accès » card of its Paramètres tab, never in the head.
  const openDetail = async (id) => {
    if (await rend(`return plg.page === 'detail' && plg.shown === ${JSON.stringify(id)};`)) return true;
    if (await rend("return plg.page === 'detail';")) { await click('#plg-back'); await waitFor(() => rend("return plg.page === 'list';")); }
    const picked = await click(`#plg-list .plg-row[data-id="${id}"] [data-act="pick"]`);
    return picked && waitFor(() => rend(`return plg.page === 'detail' && plg.shown === ${JSON.stringify(id)};`));
  };
  const closeCard = async () => {
    if (await rend("return !!plg.card;")) { await click('#plg-card [data-act="card-cancel"]'); await waitFor(() => rend('return !plg.card;')); }
  };
  // the Paramètres tab of a plugin, its access state read (the tab reads it again on every entry)
  const openSettings = async (id) => {
    await closeCard();
    const there = await openDetail(id);
    const tab = there && await click('#plg-detail [data-tab="settings"]');
    const ready = tab && await waitFor(() => rend(`return plg.tab === 'settings' && !document.getElementById('plg-settings').hidden && !!plg.set && plg.set.id === ${JSON.stringify(id)} && plg.set.loading === false;`));
    await sleep(300); // the tab swap glides in: a trusted click needs the button at rest
    return ready;
  };
  // leave the Paramètres tab and come back: the tab rebuilds its state from the host
  const reenterSettings = async (id) => {
    const away = await click('#plg-detail [data-tab="history"]');
    const left = away && await waitFor(() => rend("return plg.tab === 'history';"));
    await sleep(300);
    return left && openSettings(id);
  };
  const openCard = async (id) => {
    const onTab = await openSettings(id);
    const clicked = onTab && await click('#plg-settings .plg-set-head [data-act="access"]');
    const ready = clicked && await waitFor(() => rend(`return !!plg.card && plg.card.id === ${JSON.stringify(id)} && plg.card.loading === false && !!document.querySelector('#plg-card-access');`));
    await sleep(150);
    return clicked && ready;
  };
  // what a surface shows: every option block with its label, its group name and its segments
  const optionsIn = (scope) => rend(`return [...document.querySelectorAll(${JSON.stringify(`${scope} .plg-opt`)})].map((o) => ({ name: o.dataset.option || null,
    label: (o.querySelector('.plg-opt-label') || {}).textContent || null,
    group: (o.querySelector('[role="group"]') || { getAttribute: () => null }).getAttribute('aria-label'),
    buttons: [...o.querySelectorAll('button[aria-pressed]')].map((b) => ({ text: b.textContent, value: b.dataset.value || null, pressed: b.getAttribute('aria-pressed') })) }));`);
  const dailyOpt = async () => (await optionsIn('#plg-settings')).find((o) => o.name === 'CLAUDE_MODE');
  // everything an option control could be in a surface: blocks, segment buttons, pick buttons, pressable buttons
  const controlsIn = (scope) => rend(`const root = document.querySelector(${JSON.stringify(scope)});
    return root ? { blocks: root.querySelectorAll('.plg-opt, [data-option]').length, segments: root.querySelectorAll('.plg-seg-btn').length,
      picks: root.querySelectorAll('[data-act="opt-pick"]').length, pressable: root.querySelectorAll('[aria-pressed]').length } : null;`);
  const pressedOf = (o) => (o ? o.buttons.filter((b) => b.pressed === 'true').map((b) => b.text) : []);
  // the LIST page, shown (a card closed, the detail left through « Retour »)
  const showListPage = async () => {
    await closeCard();
    if (await rend("return plg.page === 'detail';")) await click('#plg-back');
    return waitFor(() => rend("return plg.page === 'list' && document.querySelector('#plg-list .plg-row').getBoundingClientRect().width > 0;"));
  };
  // what a list row shows: its line (class of every child, in order), every badge, and every element tag under it
  const rowInfo = (id) => rend(`const id = ${JSON.stringify(id)}; const row = [...document.querySelectorAll('#plg-list .plg-row')].find((r) => r.dataset.id === id);
    if (!row) return null;
    const line = row.querySelector('.plg-line');
    return { w: Math.round(row.getBoundingClientRect().width), text: row.textContent, line: [...line.children].map((n) => n.className),
      badges: [...row.querySelectorAll('.plg-badge')].map((b) => ({ cls: b.className, text: b.textContent, title: b.getAttribute('title'), kids: b.children.length, w: Math.round(b.getBoundingClientRect().width) })),
      tags: [...row.querySelectorAll('*')].map((n) => n.tagName) };`);
  // the badges of a row other than the state one («Activé» / «Désactivé»)
  const modeBadges = (info) => (info ? info.badges.filter((b) => !/\bplg-state\b/.test(b.cls)) : []);
  const isMode = (b, text, title) => !!b && /\bplg-badge\b/.test(b.cls) && /\bplg-mode\b/.test(b.cls) && b.text === text && b.title === title && b.kids === 0 && b.w > 0;

  const dailyOpened = listed && await openSettings('daily-brief');
  await shot('options-subscription.png');

  await gate('c1_settings_label_subscription_default', async () => {
    const o = await dailyOpt();
    const host = await rend("const opt = document.querySelector('#plg-settings .plg-opt'); return !!opt && !!opt.closest('#plg-set-opts');");
    return { ok: listed && dailyOpened && !!o && o.label === 'Appels Claude' && o.group === 'Appels Claude' && o.buttons.length === 2
      && o.buttons[0].text === 'Abonnement' && o.buttons[0].value === 'subscription' && o.buttons[1].text === 'API' && o.buttons[1].value === 'api'
      && o.buttons.every((b) => b.pressed === 'true' || b.pressed === 'false') && pressedOf(o).length === 1 && pressedOf(o)[0] === 'Abonnement'
      && host === true && stored('daily-brief', 'CLAUDE_MODE') === undefined, listed, dailyOpened, option: o, inSettingsOpts: host, stored: stored('daily-brief', 'CLAUDE_MODE') };
  });

  // plugin-list-claude-mode: nothing picked yet (the manifest default), the LIST row says « Abonnement ». Runs here so the default is still unstored.
  await gate('c8_list_badge_default_abonnement', async () => {
    const onList = await showListPage();
    const info = await rowInfo('daily-brief');
    const modes = modeBadges(info);
    const sub = stored('daily-brief', 'CLAUDE_MODE');
    const restored = await openSettings('daily-brief'); // c2 starts on the Paramètres tab
    return { ok: onList && !!info && sub === undefined && info.badges.length === 2 && modes.length === 1 && isMode(modes[0], 'Abonnement', 'Appels Claude : Abonnement')
      && /\bplg-state\b/.test(info.line[1]) && /\bplg-mode\b/.test(info.line[2]) && /\bplg-run\b/.test(info.line[3]),
    onList, stored: sub, info, restored };
  });

  await gate('c2_api_stored_and_pressed', async () => {
    const clicked = await click('#plg-settings .plg-opt[data-option="CLAUDE_MODE"] button[data-value="api"]');
    const wrote = clicked && await waitFor(() => stored('daily-brief', 'CLAUDE_MODE') === 'api');
    await sleep(700); // the plugins-changed push lands and repaints the list: the tab must keep the pick
    const o = await dailyOpt();
    const pressed = pressedOf(o);
    await shot('options-api.png');
    // the tab left and entered again: the host answers the stored pick
    const reopened = await reenterSettings('daily-brief');
    const again = await dailyOpt();
    // and back: the control is not one-way
    const back = reopened && await click('#plg-settings .plg-opt[data-option="CLAUDE_MODE"] button[data-value="subscription"]');
    const wroteBack = back && await waitFor(() => stored('daily-brief', 'CLAUDE_MODE') === 'subscription');
    const last = await dailyOpt();
    return { ok: clicked && wrote && pressed.length === 1 && pressed[0] === 'API' && reopened && pressedOf(again).length === 1 && pressedOf(again)[0] === 'API'
      && back && wroteBack && pressedOf(last).length === 1 && pressedOf(last)[0] === 'Abonnement',
    clicked, wrote, pressed, reopened, pressedAfterReopen: pressedOf(again), back, wroteBack, pressedAfterBack: pressedOf(last), stored: stored('daily-brief', 'CLAUDE_MODE') };
  });

  await gate('c3_claude_key_row_label_optional', async () => {
    const reopened = await openCard('daily-brief');
    const rows = await rend(`return [...document.querySelectorAll('#plg-card .plg-acc-row')].map((r) => ({ slot: r.dataset.slot, label: (r.querySelector('.plg-acc-label') || {}).textContent || null,
      sub: (r.querySelector('.plg-acc-sub') || {}).textContent || null }));`);
    const key = rows.find((r) => r.slot === 'CLAUDE_KEY');
    const jira = rows.find((r) => r.slot === 'JIRA_TOKEN');
    return { ok: reopened && !!key && key.label === 'Clé API Claude (mode API)' && /facultatif/.test(key.sub) && !!jira && !/facultatif/.test(jira.sub), reopened, rows };
  });

  await gate('c4_no_option_no_control', async () => {
    const onTab = await openSettings('plain');
    const inSettings = await controlsIn('#plg-settings');
    const line = await rend("return [...document.querySelectorAll('#plg-settings .plg-set-line')].some((l) => /Jeton du plugin simple/.test(l.textContent));");
    const opened = onTab && await openCard('plain');
    const seen = await rend(`const card = document.getElementById('plg-card');
      return { slotRow: !!card.querySelector('.plg-acc-row[data-slot="PLAIN_TOKEN"]'), title: (card.querySelector('.plg-card-title') || {}).textContent };`);
    const inCard = await controlsIn('#plg-card');
    const none = (c) => !!c && c.blocks === 0 && c.segments === 0 && c.picks === 0 && c.pressable === 0;
    return { ok: onTab && line === true && none(inSettings) && opened && seen.slotRow === true && none(inCard) && /sans option/.test(seen.title || ''), onTab, line, inSettings, opened, seen, inCard };
  });

  await gate('c5_text_only_dom', async () => {
    const opened = await openSettings('hostile');
    const seen = await rend(`const host = document.getElementById('plg-settings'); const o = host.querySelector('.plg-opt');
      const tags = o ? [...o.querySelectorAll('*')].map((n) => n.tagName) : [];
      return { block: !!o, label: o ? (o.querySelector('.plg-opt-label') || {}).textContent : null,
        buttons: o ? [...o.querySelectorAll('button')].map((b) => b.textContent) : [],
        tags, markup: document.getElementById('plg-set-opts').querySelectorAll('img, b, i, script, iframe, svg').length, xss: window.__xss === undefined };`);
    const sink = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\bDOMParser\b|\beval\(/;
    const code = fs.readFileSync(path.join(REPO, 'renderer', 'js', 'plugin-panel.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const plain = seen.tags.every((t) => ['DIV', 'SPAN', 'P', 'BUTTON'].includes(t));
    return { ok: opened && seen.block && seen.label === HOSTILE_LABEL && seen.buttons.length === 2 && seen.buttons[0] === HOSTILE_ABO && seen.buttons[1] === HOSTILE_API
      && plain && seen.markup === 0 && seen.xss && !sink.test(code),
    opened, seen, sinks: code.split('\n').filter((l) => sink.test(l)).slice(0, 3) };
  });

  // « Modifier » edits the environment-variable names only: the option control is not in the card, the slot rows are
  await gate('c6_access_card_env_only', async () => {
    const opened = await openCard('daily-brief');
    const controls = await controlsIn('#plg-card');
    const rows = await rend(`return [...document.querySelectorAll('#plg-card .plg-acc-row')].map((r) => ({ slot: r.dataset.slot, w: Math.round(r.getBoundingClientRect().width) }));`);
    await shot('access-card.png');
    return { ok: opened && !!controls && controls.blocks === 0 && controls.segments === 0 && controls.picks === 0
      && rows.length === 2 && rows.every((r) => r.w > 0) && ['JIRA_TOKEN', 'CLAUDE_KEY'].every((n) => rows.some((r) => r.slot === n)), opened, controls, rows };
  });

  // the lines of the tab are read on entry only: a save from the card must refresh them without a tab change
  await gate('c7_access_lines_refresh_after_save', async () => {
    const opened = await openCard('daily-brief');
    const lineOf = (label) => rend(`const l = [...document.querySelectorAll('#plg-set-acc .plg-set-line')].find((n) => n.querySelector('.plg-set-label').textContent === ${JSON.stringify(label)});
      return l ? { name: l.querySelector('.plg-mono').textContent, text: l.textContent } : null;`);
    const before = await lineOf('Jira — jeton API');
    const focused = opened && await click('#plg-card .plg-acc-row[data-slot="JIRA_TOKEN"] .plg-acc-in');
    // the click's mousedown focuses the input in the renderer, while insertText is a separate IPC: wait for the focus, else the text can land first and go nowhere
    const inFocus = focused && await waitFor(() => rend("const i = document.querySelector('#plg-card .plg-acc-row[data-slot=\"JIRA_TOKEN\"] .plg-acc-in'); return !!i && document.activeElement === i;"));
    if (inFocus) wc.insertText('DECK_FAKE_API_TOKEN');
    const typed = focused && await waitFor(() => rend("const i = document.querySelector('#plg-card .plg-acc-row[data-slot=\"JIRA_TOKEN\"] .plg-acc-in'); return !!i && i.value === 'DECK_FAKE_API_TOKEN';"));
    const saved = typed && await click('#plg-card [data-act="card-confirm"]');
    const closed = saved && await waitFor(() => rend('return !plg.card;'));
    const refreshed = closed && await waitFor(() => rend(`const l = [...document.querySelectorAll('#plg-set-acc .plg-set-line')].find((n) => n.querySelector('.plg-set-label').textContent === 'Jira — jeton API');
      return plg.tab === 'settings' && !!plg.set && plg.set.loading === false && !!l && l.querySelector('.plg-mono').textContent === 'DECK_FAKE_API_TOKEN';`), 3000);
    await sleep(400); // the push that follows the save repaints the tab: the focus must still be on « Modifier »
    const after = await lineOf('Jira — jeton API');
    const seen = await rend(`const a = document.activeElement; return { tab: plg.tab, accText: document.getElementById('plg-set-acc').textContent, focus: a ? a.id : null };`);
    const map = (() => { try { return (JSON.parse(fs.readFileSync(statePath, 'utf8'))['daily-brief'] || {}).envMap || null; } catch (_) { return null; } })();
    return { ok: opened && !!before && /Introuvable/.test(before.text) && typed && closed && refreshed && !!after && after.name === 'DECK_FAKE_API_TOKEN' && !/Introuvable/.test(seen.accText)
      && seen.tab === 'settings' && seen.focus === 'plg-set-edit' && !!map && map.JIRA_TOKEN === 'DECK_FAKE_API_TOKEN',
    opened, before, typed, closed, refreshed, after, seen, map };
  });

  // the pick moves the badge: set in Paramètres, the push repaints the list, the row reads the new label once the list is shown again
  await gate('c9_list_badge_follows_pick', async () => {
    const pickIn = async (value) => {
      const there = await openSettings('daily-brief');
      const clicked = there && await click(`#plg-settings .plg-opt[data-option="CLAUDE_MODE"] button[data-value="${value}"]`);
      const wrote = clicked && await waitFor(() => stored('daily-brief', 'CLAUDE_MODE') === value);
      await sleep(700); // the plugins-changed push lands and repaints the list
      return { there, clicked, wrote };
    };
    const rowShows = async (text, title) => {
      const onList = await showListPage();
      const seen = onList && await waitFor(async () => { const m = modeBadges(await rowInfo('daily-brief')); return m.length === 1 && isMode(m[0], text, title); }, 3000);
      return { onList, seen, badges: modeBadges(await rowInfo('daily-brief')) };
    };
    const toApi = await pickIn('api');
    const api = await rowShows('API', 'Appels Claude : API');
    const toSub = await pickIn('subscription');
    const sub = await rowShows('Abonnement', 'Appels Claude : Abonnement');
    return { ok: toApi.wrote === true && api.seen === true && toSub.wrote === true && sub.seen === true, toApi, api, toSub, sub };
  });

  // no CLAUDE_MODE option (`plain`), or another option name (`hostile`): the state badge only
  await gate('c10_list_no_badge_without_claude_mode', async () => {
    const onList = await showListPage();
    const seen = {};
    for (const id of ['plain', 'hostile']) seen[id] = await rowInfo(id);
    const only = (i) => !!i && i.w > 0 && i.badges.length === 1 && /\bplg-state\b/.test(i.badges[0].cls) && modeBadges(i).length === 0 && !i.line.some((c) => /\bplg-mode\b/.test(c)) && i.line.length === 3;
    return { ok: onList && only(seen.plain) && only(seen.hostile), onList, plain: seen.plain, hostile: seen.hostile };
  });

  // a CLAUDE_MODE whose labels are markup: the row holds that text, no element comes out of it, no handler runs
  await gate('c11_list_badge_text_only', async () => {
    const onList = await showListPage();
    const info = await rowInfo('markup-mode');
    const modes = modeBadges(info);
    const page = await rend("return { markup: document.getElementById('plg-list').querySelectorAll('img, b, i, script, iframe, svg').length, xss: window.__xss === undefined };");
    const plain = !!info && info.tags.every((t) => ['DIV', 'SPAN', 'P', 'BUTTON'].includes(t));
    return { ok: onList && !!info && modes.length === 1 && isMode(modes[0], HOSTILE_ABO, `${HOSTILE_LABEL} : ${HOSTILE_ABO}`) && plain && page.markup === 0 && page.xss,
    onList, info, page };
  });

  // rows fed through the REAL plugins-list IPC (the handler is swapped for fixed rows; the push makes the panel read them): last gate, the host list is not restored
  await gate('c12_list_badge_malformed_rows', async () => {
    const MODE = { name: 'CLAUDE_MODE', label: 'Appels Claude', value: 'api', choices: [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }] };
    const RAW = 'RAWVALUE';
    const defs = {
      'm-ok': { options: [MODE] },
      'm-stale': { options: [{ ...MODE, value: RAW }] },
      'm-notarray': { options: 'CLAUDE_MODE' },
      'm-object': { options: { ...MODE } },
      'm-junk': { options: [null, 42, 'x', [], {}] },
      'm-nochoices': { options: [{ name: 'CLAUDE_MODE', label: 'Appels Claude', value: RAW }] },
      'm-choices-string': { options: [{ ...MODE, choices: RAW }] },
      'm-nolabel': { options: [{ ...MODE, value: RAW, choices: [{ value: RAW }] }] },
      'm-numvalue': { options: [{ ...MODE, value: 1, choices: [{ value: 1, label: RAW }] }] },
      'm-othername': { options: [{ ...MODE, name: 'OTHER_MODE', value: RAW, choices: [{ value: RAW, label: RAW }] }] },
      'm-lowercase': { options: [{ ...MODE, name: 'claude_mode', value: RAW, choices: [{ value: RAW, label: RAW }] }] },
      'm-none': {},
    };
    ipcMain.removeHandler('plugins-list');
    ipcMain.handle('plugins-list', () => Object.entries(defs).map(([id, d]) => ({ id, label: id, enabled: true, ...d })));
    wc.send('plugins-changed');
    const painted = await waitFor(() => rend("return !!document.querySelector('#plg-list .plg-row[data-id=\"m-none\"]');"));
    const onList = painted && await showListPage();
    const infos = {};
    for (const id of Object.keys(defs)) infos[id] = await rowInfo(id);
    const bare = (i) => !!i && i.w > 0 && i.badges.length === 1 && modeBadges(i).length === 0 && !i.text.includes(RAW) && !i.badges.some((b) => (b.title || '').includes(RAW));
    const ctrl = modeBadges(infos['m-ok']);
    const bad = Object.keys(defs).filter((id) => id !== 'm-ok' && !bare(infos[id]));
    return { ok: painted && onList && ctrl.length === 1 && isMode(ctrl[0], 'API', 'Appels Claude : API') && bad.length === 0, painted, onList, control: ctrl, notBare: bad, rows: bad.map((id) => infos[id]) };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
