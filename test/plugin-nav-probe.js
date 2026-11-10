'use strict';
// plugin-nav-probe — plugins-v4 K5: the Plugins panel is a list page and a detail page. Lot u2 gates the SHELL (markup + CSS); lot u3 adds n5+ for the navigation.
// The REAL app boots over throwaway fixtures (empty plugins dir, throwaway userData); every gate reads computed style or DOM from the live renderer.
//   n1 the containers of the page contract exist: #plg-body > #plg-page-list (#plg-empty, #plg-list) and #plg-page-detail (#plg-back, #plg-dhead,
//      #plg-settings); #plg-view and #plg-full still live in #plg-body; every pre-K5 id is still there; the init of the panel ran (#plg-card, #plg-detail, #plg-hist)
//   n2 #plugin-panel[data-page]: "detail" hides the list page, "list" hides the detail page and what belongs to it (#plg-detail, #plg-view, #plg-hist, #plg-full),
//      no attribute shows both pages (the pre-K5 flow keeps working)
//   n3 #plg-view paints the Deck surface token (never transparent, never white); the Deck is dark-only, no theme is selected
//   n4 no plugin row / card / head with a coloured left border wider than its other borders (user rule: no left accent bar), computed and in the stylesheet source
//   n5 a row's pick opens the detail page: head = label + status + actions, tabs Rapport / Journal / Historique / Paramètres, the report frame of that plugin; a row click
//      anywhere opens it too; the latest run without report opens on the Journal tab
//   n6 #plg-back returns to the list page, focus on that row's pick button, the report frame gone
//   n7 Escape order: card -> full screen -> detail -> list -> panel closed; ONE document keydown listener in plugin-panel.js (static)
//   n8 a list row holds label, status and ONE action button (run) besides its pick; no journal / delete / access / switch control;
//      the head holds the import and the close and NO theme control (no #plg-theme* id); #plg-import is the one head element with margin-left:auto (stylesheet source
//      and computed gap), so import + close stay right-aligned: the close ends flush with the head content edge, the import sits one gap before it
//   n9 the Paramètres tab holds the access lines, the options and #plg-retention / #plg-storage, and ONE data-act="access" « Modifier » (V26: in the head of the
//      « Accès » card, same aria-label as before, none in #plg-dhead, one per page); it is disabled while the plugin has a call in flight and « Annuler » gives it the focus back
//   n10 the detail head holds run / delete and NO access control; #plg-full sits over the report frame
//   n11 K3: the history reads « Automatique » for an auto run, « Manuel » for a manual one, and never « Démarrage »
//   n12 (lot u3fix) a run launched from #plg-dhead [data-act="run"] lands on the Journal tab (live), and its successful end shows the Rapport tab with its
//       frame, with no tab click
//   n13 (lot u3fix) .plg-jfull follows the u1 rule at paint time: disabled for a finished entry with no log listed, enabled while the run is live
//   n14 (T6) every list row holds ONE .plg-state badge, « Activé » (ok tone) or « Désactivé » (muted), in .plg-line between the pick and the run button, outside the
//       pick (its accessible name stays the label); the text follows the Paramètres switch (a trusted click flips it, plugins.json agrees) and never the run state
// Run (from the repo root): env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY CLAUDE_DECK_SLACK_API_URL=http://127.0.0.1:1 \
//   CLAUDE_DECK_WEATHER_URL=http://127.0.0.1:1 CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1 \
//   xvfb-run -a node_modules/.bin/electron test/plugin-nav-probe.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const REPO = path.join(__dirname, '..');
const NAMES = ['n1_shell_containers', 'n2_data_page_switch', 'n3_view_background_token', 'n4_no_left_accent_bar', 'n5_row_opens_detail', 'n6_back_to_list', 'n7_escape_order',
  'n8_slim_list_row', 'n9_settings_tab', 'n10_detail_head_actions', 'n11_trigger_labels', 'n12_run_lands_on_journal_then_report', 'n13_journal_complet_enabled_rule', 'n14_row_enabled_badge'];
// a plugin that steps, waits, writes its report, then exits 0 (lot u3fix: n12 / n13 drive it live from the detail head)
const TSTEP = "t() { printf '::deck-step:: %s %s %s%s\\n' \"$1\" \"$2\" \"$(date +%s%3N)\" \"${3:+ $3}\"; }";
const RUN_NAVR = ['#!/bin/bash', TSTEP, "t a wait 'Etape A'", "t a start 'en cours'", 'sleep 2.5',
  `printf '<!doctype html><title>R</title><p>Rapport navr</p>' > "$DECK_PLUGIN_REPORT"`, "t a done 'fini'", 'exit 0'].join('\n') + '\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const results = {};
const detail = {};
let finished = false;

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-nav-probe-'));
  const dirs = { root, ud: path.join(root, 'ud'), plugins: path.join(root, 'plugins'), home: path.join(root, 'home'), projects: path.join(root, 'projects'),
    ask: path.join(root, 'ask'), status: path.join(root, 'status'), sh: path.join(root, 'sh') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'plugins', 'fake-shell.sh'), path.join(dirs.sh, 'bash')); // the host reads this stand-in, never a real shell
  fs.chmodSync(path.join(dirs.sh, 'bash'), 0o755);
  const install = (id, manifest, script = '#!/bin/sh\nexit 0\n') => {
    const dir = path.join(dirs.plugins, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), script, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id, argv: ['run.sh'], trigger: 'manual', ...manifest }));
  };
  install('navp', { label: 'Fixture navp', description: 'Plugin avec rapport.', env: [{ name: 'NAV_TOKEN', label: 'Jeton de test', required: false, hints: ['NAV'] }],
    options: [{ name: 'NAV_MODE', label: 'Appels Claude', default: 'subscription', choices: [{ value: 'subscription', label: 'Abonnement' }, { value: 'api', label: 'API' }] }] });
  install('navq', { label: 'Fixture navq', description: 'Plugin en échec.', env: [] });
  install('navr', { label: 'Fixture navr', description: 'Plugin qui écrit son rapport après un moment.', env: [] }, RUN_NAVR);
  install('navn', { label: 'Fixture navn', description: 'Plugin dont la dernière exécution n’a pas de journal.', env: [] });
  fs.writeFileSync(path.join(dirs.ud, 'plugins.json'), JSON.stringify({ navq: { enabled: true } })); // one enabled plugin for n14, the others stay disabled
  // history written straight into the reports dir (stem = local start minute, sidecar = start / trigger / exit / size / pid)
  const entry = (id, minutesAgo, trigger, exit, report, log = true) => {
    const d = new Date(Date.now() - minutesAgo * 60000);
    d.setSeconds(0, 0);
    const stem = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
    const dir = path.join(dirs.ud, 'plugin-data', id, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ start: d.getTime(), trigger, exit, size: report ? 40 : null, pid: null }));
    if (log) fs.writeFileSync(path.join(dir, `${stem}.log`), 'ligne de journal de la fixture\n');
    if (report) fs.writeFileSync(path.join(dir, `${stem}.html`), '<!doctype html><title>r</title><p>Rapport de la fixture</p>');
  };
  entry('navp', 5, 'auto', 0, true);
  entry('navp', 1445, 'manual', 0, true);
  entry('navp', 2885, 'auto', 1, false);
  entry('navq', 10, 'manual', 1, false);
  entry('navn', 15, 'manual', 1, false, false); // finished, no report, and no log listed
  return dirs;
}

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

function boot() {
  const dirs = buildFixtures();
  app.setPath('userData', dirs.ud);
  process.env.HOME = dirs.home;
  Object.assign(process.env, {
    CLAUDE_DECK_BIN: '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: dirs.projects, CLAUDE_DECK_ASK_DIR: dirs.ask, CLAUDE_DECK_STATUS_DIR: dirs.status,
    CLAUDE_DECK_PLUGINS_DIR: dirs.plugins, CLAUDE_DECK_PLUGINS_NOW: '2026-11-03T09:00:00', CLAUDE_DECK_PLUGINS_SHELL: path.join(dirs.sh, 'bash'),
  });
  for (const k of ['CLAUDE_DECK_PRICES_URL', 'CLAUDE_DECK_COMMANDS_URL']) {
    process.env[k] ||= 'http://127.0.0.1:1';
  }
  require(path.join(REPO, 'main.js'));
  app.whenReady().then(() => run()).catch((err) => {
    console.log(`FAIL probe crashed: ${err && err.stack}`);
    verdict(2);
  });
}

// Static half of n4: a rule on a plugin selector may not set a left border or a left inset shadow (the accent-bar idioms).
function leftBarRules() {
  const css = fs.readFileSync(path.join(REPO, 'renderer', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  for (const block of css.split('}')) {
    const at = block.indexOf('{');
    if (at < 0) continue;
    const sel = block.slice(0, at).trim();
    const body = block.slice(at + 1);
    if (!/plg-/.test(sel)) continue;
    const left = body.match(/border-left(?:-width)?\s*:\s*([^;]+)/);
    if (left && !/^\s*(0|none)\b/.test(left[1])) bad.push(`${sel} { border-left: ${left[1].trim()} }`);
    if (/box-shadow\s*:[^;]*\binset\s+-?[2-9]px\s+0/.test(body)) bad.push(`${sel} { inset shadow bar }`);
  }
  return bad;
}

// Static half of n8: the selectors of the stylesheet that give a head control a left auto margin (the one that pushes import + close to the right).
function headAutoMarginRules() {
  const css = fs.readFileSync(path.join(REPO, 'renderer', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [];
  for (const block of css.split('}')) {
    const at = block.indexOf('{');
    if (at < 0) continue;
    const sel = block.slice(0, at).trim();
    if (/margin-left\s*:\s*auto\b/.test(block.slice(at + 1)) && /#plg-(head|title|count|import|close)\b/.test(sel)) sels.push(sel.replace(/\s+/g, ' '));
  }
  return sels;
}

async function run() {
  const watchdog = setTimeout(() => {
    for (const n of NAMES) if (!(n in results)) { results[n] = false; detail[n] = { watchdog: 'probe stuck for 90 s' }; }
    verdict(2);
  }, 90000);
  watchdog.unref();

  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.plg && document.getElementById("plg-card"))', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const rend = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);

  await gate('n1_shell_containers', async () => {
    const r = await rend(`
      const $ = (s) => document.querySelector(s);
      const oldIds = ['plg-head', 'plg-title', 'plg-count', 'plg-import', 'plg-close', 'plg-body', 'plg-empty', 'plg-list', 'plg-view', 'plg-full'];
      const initIds = ['plg-card', 'plg-detail', 'plg-hist'];
      const back = $('#plg-back');
      return {
        listPage: !!$('#plg-body > #plg-page-list'), emptyInList: !!$('#plg-page-list #plg-empty'), listInList: !!$('#plg-page-list #plg-list'),
        detailPage: !!$('#plg-body > #plg-page-detail'), back: !!$('#plg-page-detail #plg-back') && back.tagName === 'BUTTON', dhead: !!$('#plg-page-detail #plg-dhead'),
        settings: !!$('#plg-page-detail #plg-settings'), viewInBody: !!$('#plg-body #plg-view'), fullInBody: !!$('#plg-body #plg-full'),
        headControls: !!$('#plg-head #plg-import') && !!$('#plg-head #plg-close'),
        missingOld: oldIds.filter((id) => !document.getElementById(id)), missingInit: initIds.filter((id) => !$('#plg-body #' + id)),
        backLabel: back ? back.textContent.trim() : null };`);
    return { ok: r.listPage && r.emptyInList && r.listInList && r.detailPage && r.back && r.dhead && r.settings && r.viewInBody && r.fullInBody && r.headControls
      && r.missingOld.length === 0 && r.missingInit.length === 0 && /Plugins/.test(r.backLabel || ''), ...r };
  });

  await gate('n2_data_page_switch', async () => {
    const r = await rend(`
      const panel = document.getElementById('plugin-panel');
      const view = document.getElementById('plg-view');
      const probeChild = document.createElement('p');
      view.append(probeChild); // #plg-view:empty is display none on its own
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
      // the elements JS toggles with [hidden] are measured with the attribute lifted, so only the data-page rules speak
      const lifted = ['plg-detail', 'plg-hist', 'plg-full'].map((id) => document.getElementById(id));
      const was = lifted.map((el) => !!el && el.hidden);
      lifted.forEach((el) => { if (el) el.hidden = false; });
      const read = () => ({ list: shown(document.getElementById('plg-page-list')), detail: shown(document.getElementById('plg-page-detail')),
        tabs: shown(lifted[0]), view: shown(view), hist: shown(lifted[1]), full: shown(lifted[2]),
        back: shown(document.getElementById('plg-back')), dhead: shown(document.getElementById('plg-dhead')) });
      const had = panel.getAttribute('data-page');
      panel.removeAttribute('data-page'); const none = read();
      panel.setAttribute('data-page', 'list'); const list = read();
      panel.setAttribute('data-page', 'detail'); const det = read();
      if (had === null) panel.removeAttribute('data-page'); else panel.setAttribute('data-page', had);
      lifted.forEach((el, i) => { if (el) el.hidden = was[i]; });
      probeChild.remove();
      return { none, list, det };`);
    const noneOk = r.none.list && r.none.detail && r.none.view;
    const listOk = r.list.list && !r.list.detail && !r.list.tabs && !r.list.view && !r.list.hist && !r.list.full;
    const detOk = !r.det.list && r.det.detail && r.det.tabs && r.det.view && r.det.hist && r.det.full && r.det.back && r.det.dhead;
    return { ok: noneOk && listOk && detOk, ...r };
  });

  await gate('n3_view_background_token', async () => {
    const seen = await rend(`
      const ref = document.createElement('div');
      ref.style.backgroundColor = 'var(--ground)';
      document.body.append(ref);
      const want = getComputedStyle(ref).backgroundColor;
      ref.remove();
      const got = getComputedStyle(document.getElementById('plg-view')).backgroundColor;
      return { want, got };`);
    const good = (s) => s.got === s.want && s.got !== 'rgba(0, 0, 0, 0)' && s.got !== 'transparent' && s.got !== 'rgb(255, 255, 255)' && s.want !== 'rgba(0, 0, 0, 0)';
    return { ok: good(seen), seen };
  });

  await gate('n4_no_left_accent_bar', async () => {
    const staticBad = leftBarRules();
    const r = await rend(`
      const host = document.getElementById('plg-list');
      const specs = ['plg-row', 'plg-row sel', 'plg-row off', 'plg-card', 'plg-hrow', 'plg-hrow sel', 'plg-fail', 'plg-fail plg-journal', 'plg-fail-box', 'plg-acc-row', 'plg-opt',
        'plg-acc-lock', 'plg-card-replace', 'plg-hrows', 'plg-log', 'plg-detail', 'plg-hist'];
      const made = specs.map((cls) => { const el = document.createElement('div'); el.className = cls; host.append(el); return [cls, el]; });
      const real = ['plg-page-list', 'plg-page-detail', 'plg-back', 'plg-dhead', 'plg-settings', 'plg-view', 'plg-detail', 'plg-hist'].map((id) => ['#' + id, document.getElementById(id)]);
      const bad = [];
      for (const [name, el] of made.concat(real)) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        const w = (side) => (cs['border' + side + 'Style'] === 'none' ? 0 : parseFloat(cs['border' + side + 'Width']) || 0);
        const left = w('Left');
        if (left > 0 && left > Math.max(w('Top'), w('Right'), w('Bottom'))) bad.push({ name, left, top: w('Top') });
      }
      made.forEach(([, el]) => el.remove());
      return { checked: made.length + real.length, bad };`);
    return { ok: r.bad.length === 0 && staticBad.length === 0 && r.checked >= 20, staticBad, ...r };
  });

  const waitFor = async (fn, ms = 5000) => {
    const t = Date.now();
    for (;;) {
      if (await fn()) return true;
      if (Date.now() - t > ms) return false;
      await sleep(50);
    }
  };
  const until = (expr, ms) => waitFor(() => rend(`return !!(${expr});`), ms);
  const press = (key) => rend(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));`);
  const pick = (id) => rend(`document.querySelector('#plg-list .plg-row[data-id="${id}"] [data-act="pick"]').click();`);
  const page = () => rend(`return document.getElementById('plugin-panel').getAttribute('data-page');`);
  const REPORT_FRAME = `(() => { const f = document.querySelector('#plg-view > iframe'); return !!f && /^deckpage:/.test(f.src); })()`;
  const PANEL_SRC = fs.readFileSync(path.join(REPO, 'renderer', 'js', 'plugin-panel.js'), 'utf8');

  await gate('n5_row_opens_detail', async () => {
    await rend(`document.getElementById('plugin-toggle').click();`);
    const listed = await until(`document.querySelectorAll('#plg-list .plg-row').length >= 2`);
    const pageBefore = await page();
    await pick('navp');
    const framed = await until(REPORT_FRAME);
    const r = await rend(`
      const tabs = [...document.querySelectorAll('#plg-detail [role="tab"]')];
      const sel = tabs.find((b) => b.getAttribute('aria-selected') === 'true');
      return { page: document.getElementById('plugin-panel').getAttribute('data-page'), head: document.getElementById('plg-dhead').textContent,
        tabs: tabs.map((b) => b.textContent.trim()), tabKeys: tabs.map((b) => b.dataset.act + ':' + b.dataset.tab), selected: sel ? sel.dataset.tab : null,
        listShown: getComputedStyle(document.getElementById('plg-page-list')).display !== 'none' };`);
    await rend(`document.getElementById('plg-back').click();`);
    await rend(`document.querySelector('#plg-list .plg-row[data-id="navq"] .plg-status').click();`); // a click on the row body, not on a button
    const journaled = await until(`document.querySelector('#plg-view .plg-journal')`);
    const q = await rend(`
      const sel = [...document.querySelectorAll('#plg-detail [role="tab"]')].find((b) => b.getAttribute('aria-selected') === 'true');
      return { page: document.getElementById('plugin-panel').getAttribute('data-page'), selected: sel ? sel.dataset.tab : null, head: document.getElementById('plg-dhead').textContent };`);
    const tabsOk = r.tabs.length === 4 && r.tabs[0] === 'Rapport' && r.tabs[1] === 'Journal' && /^Historique/.test(r.tabs[2]) && r.tabs[3] === 'Paramètres'
      && r.tabKeys.every((k, i) => k.startsWith('tab:') && k.slice(4) === ['report', 'journal', 'history', 'settings'][i]);
    return { ok: listed && pageBefore === 'list' && r.page === 'detail' && !r.listShown && framed && /Fixture navp/.test(r.head) && /Dernier rapport/.test(r.head) && tabsOk && r.selected === 'report'
      && journaled && q.page === 'detail' && q.selected === 'journal' && /Fixture navq/.test(q.head), listed, pageBefore, framed, journaled, r, q };
  });

  await gate('n6_back_to_list', async () => {
    await rend(`document.getElementById('plg-back').click();`); // from navq's detail
    const r = await rend(`
      const want = document.querySelector('#plg-list .plg-row[data-id="navq"] [data-act="pick"]');
      return { page: document.getElementById('plugin-panel').getAttribute('data-page'), focused: !!want && document.activeElement === want,
        active: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null,
        frame: !!document.querySelector('#plg-view iframe'), viewShown: getComputedStyle(document.getElementById('plg-view')).display !== 'none' };`);
    return { ok: r.page === 'list' && r.focused && !r.frame && !r.viewShown, ...r };
  });

  await gate('n7_escape_order', async () => {
    const listeners = (PANEL_SRC.match(/document\.addEventListener\(\s*'keydown'/g) || []).length;
    await pick('navp');
    await until(REPORT_FRAME);
    const snap = () => rend(`const p = document.getElementById('plugin-panel');
      return { page: p.getAttribute('data-page'), card: !document.getElementById('plg-card').hidden, full: p.classList.contains('plg-fullscreen'), open: window.plg.open && p.classList.contains('open') };`);
    const seen = {};
    await rend(`document.querySelector('#plg-dhead [data-act="delete"]').click();`);
    await until(`!document.getElementById('plg-card').hidden`);
    seen.card = await snap();
    await press('Escape'); seen.afterCard = await snap();
    await rend(`document.getElementById('plg-full').click();`);
    await until(`document.getElementById('plugin-panel').classList.contains('plg-fullscreen')`);
    seen.full = await snap();
    await press('Escape'); seen.afterFull = await snap();
    await press('Escape'); seen.afterDetail = await snap();
    await press('Escape'); seen.afterList = await snap();
    const s = seen;
    const ok = listeners === 1 && s.card.card && s.card.page === 'detail' && !s.afterCard.card && s.afterCard.page === 'detail' && s.afterCard.open
      && s.full.full && !s.afterFull.full && s.afterFull.page === 'detail' && s.afterFull.open
      && s.afterDetail.page === 'list' && s.afterDetail.open && !s.afterList.open;
    return { ok, listeners, seen };
  });

  await gate('n8_slim_list_row', async () => {
    await rend(`document.getElementById('plugin-toggle').click();`);
    await until(`document.querySelectorAll('#plg-list .plg-row').length >= 2`);
    const r = await rend(`
      const rows = [...document.querySelectorAll('#plg-list .plg-row')].map((row) => ({
        id: row.dataset.id, label: (row.querySelector('.plg-label') || {}).textContent || '', status: (row.querySelector('.plg-status') || {}).textContent || '',
        acts: [...row.querySelectorAll('[data-act]')].map((b) => b.dataset.act), extra: !!row.querySelector('.plg-journal, .plg-del, .plg-access-edit, .plg-switch, .plg-access') }));
      const head = document.getElementById('plg-head');
      const imp = head.querySelector('#plg-import');
      const close = head.querySelector('#plg-close');
      const count = head.querySelector('#plg-count');
      const hs = getComputedStyle(head);
      const gap = parseFloat(hs.columnGap) || 0;
      const hr = head.getBoundingClientRect();
      const sx = hr.width / head.offsetWidth || 1; // the panel entrance scales it (scale(.96) -> 1): rect deltas are brought back to layout px
      const ir = imp ? imp.getBoundingClientRect() : null;
      const cr = close ? close.getBoundingClientRect() : null;
      const kr = count ? count.getBoundingClientRect() : null;
      const ml = imp ? parseFloat(getComputedStyle(imp).marginLeft) : NaN;
      const leftMargins = [...head.children].filter((el) => el !== imp && parseFloat(getComputedStyle(el).marginLeft) > 0).map((el) => el.id);
      return { page: document.getElementById('plugin-panel').getAttribute('data-page'), rows,
        theme: !!head.querySelector('#plg-theme-seg'), themeIds: [...document.querySelectorAll('[id^="plg-theme"]')].map((el) => el.id),
        imp: !!imp, close: !!close, gap, ml, sx, leftMargins,
        closeFlush: !!cr && Math.abs((hr.right - cr.right) / sx - parseFloat(hs.paddingRight)) <= 1.5,
        importBesideClose: !!ir && !!cr && Math.abs((cr.left - ir.right) / sx - gap) <= 1.5,
        autoGap: !!ir && !!kr && ml > 0 && Math.abs((ir.left - kr.right) / sx - gap - ml) <= 1.5 };`);
    const slim = r.rows.length >= 2 && r.rows.every((x) => x.label && x.status && x.acts.length === 2 && x.acts.includes('pick') && x.acts.includes('run') && !x.extra);
    const autoRules = headAutoMarginRules();
    const headOk = !r.theme && r.themeIds.length === 0 && r.imp && r.close && r.closeFlush && r.importBesideClose && r.autoGap && r.leftMargins.length === 0
      && autoRules.length === 1 && autoRules[0] === '#plg-import';
    return { ok: r.page === 'list' && slim && headOk, headOk, autoRules, ...r };
  });

  await gate('n9_settings_tab', async () => {
    await pick('navp');
    await until(REPORT_FRAME);
    await rend(`document.querySelector('#plg-detail [data-tab="settings"]').click();`);
    const loaded = await until(`document.querySelector('#plg-settings .plg-opt[data-option="NAV_MODE"]')`);
    const r = await rend(`
      const s = document.getElementById('plg-settings');
      const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.hidden;
      return { settings: shown(s), retention: !!s.querySelector('#plg-retention'), storage: !!s.querySelector('#plg-storage'), option: !!s.querySelector('.plg-opt[data-option="NAV_MODE"]'),
        accessLine: s.textContent.includes('Jeton de test'), text: s.textContent.slice(0, 240), accessControls: s.querySelectorAll('[data-act="access"]').length,
        cardAccess: [...s.querySelectorAll('section[aria-label="Accès"] .plg-set-head [data-act="access"]')].map((b) => ({ text: b.textContent.trim(), aria: b.getAttribute('aria-label'), disabled: b.disabled })),
        headAccess: document.querySelectorAll('#plg-dhead [data-act="access"]').length, panelAccess: document.querySelectorAll('#plugin-panel [data-act="access"]').length,
        view: shown(document.getElementById('plg-view')), hist: shown(document.getElementById('plg-hist')), selected: (document.querySelector('#plg-detail [aria-selected="true"]') || {}).dataset.tab };`);
    // V26: disabled while the plugin has a call in flight (the repaint reads plg.busy), enabled again after
    const busy = await rend(`
      const btn = () => document.querySelector('#plg-settings [data-act="access"]');
      plg.busy.add('navp'); await plgLoadList();
      const whileBusy = !!btn() && btn().disabled;
      plg.busy.delete('navp'); await plgLoadList();
      return { whileBusy, idle: !!btn() && !btn().disabled };`);
    // the click opens the access card; « Annuler » gives the focus back to « Modifier »
    await rend(`const b = document.querySelector('#plg-settings [data-act="access"]'); if (b) b.click();`);
    const opened = await until(`plg.card && plg.card.kind === 'access' && plg.card.loading === false`);
    await rend(`const c = document.querySelector('#plg-card [data-act="card-cancel"]'); if (c) c.click();`);
    const back = await rend(`const b = document.querySelector('#plg-settings [data-act="access"]'); return { closed: !plg.card, focused: !!b && document.activeElement === b };`);
    return { ok: loaded && r.settings && r.retention && r.storage && r.option && r.accessLine && r.accessControls === 1 && r.panelAccess === 1 && r.headAccess === 0
      && r.cardAccess.length === 1 && r.cardAccess[0].text === 'Modifier' && r.cardAccess[0].aria === 'Modifier les accès de Fixture navp' && r.cardAccess[0].disabled === false
      && busy.whileBusy && busy.idle && opened && back.closed && back.focused
      && !r.view && !r.hist && r.selected === 'settings', loaded, busy, opened, back, ...r };
  });

  await gate('n10_detail_head_actions', async () => {
    await rend(`document.querySelector('#plg-detail [data-tab="report"]').click();`);
    const framed = await until(REPORT_FRAME);
    const r = await rend(`
      const acts = [...document.querySelectorAll('#plg-dhead [data-act]')].map((b) => b.dataset.act);
      const full = document.getElementById('plg-full');
      return { acts, fullInView: !!full && full.parentNode === document.getElementById('plg-view'), fullShown: !!full && !full.hidden,
        overFrame: !!document.querySelector('#plg-view > iframe') && !!full && full.parentNode === document.getElementById('plg-view') };`);
    return { ok: framed && ['run', 'delete'].every((a) => r.acts.filter((x) => x === a).length === 1) && !r.acts.includes('access') && r.fullInView && r.fullShown && r.overFrame, framed, ...r };
  });

  await gate('n11_trigger_labels', async () => {
    await rend(`document.querySelector('#plg-detail [data-tab="history"]').click();`);
    const rowsIn = await until(`document.querySelectorAll('#plg-rows .plg-hrow').length >= 3`);
    const r = await rend(`
      return { trig: [...document.querySelectorAll('#plg-rows .plg-hrow .plg-h-trig')].map((n) => n.textContent), hist: document.getElementById('plg-hist').textContent };`);
    const staticBad = /TRIGGERS\s*=\s*\{[^}]*Démarrage/.test(PANEL_SRC);
    return { ok: rowsIn && r.trig.join('|') === 'Automatique|Manuel|Automatique' && !/Démarrage/.test(r.hist) && !staticBad, rowsIn, staticBad, trig: r.trig };
  });

  const tabNow = () => rend(`const t = document.querySelector('#plg-detail [role="tab"][aria-selected="true"]'); return t ? t.dataset.tab : null;`);
  const toList = async () => { await rend(`document.getElementById('plg-back').click();`); await until(`document.getElementById('plugin-panel').dataset.page === 'list'`); };
  const JFULL = `document.querySelector('#plg-view .plg-jfull')`;
  const settle = () => until(`(() => { const r = window.plg.rows.find((x) => x.id === 'navr'); return !!r && r.running !== true && !!r.latest && Number.isInteger(r.latest.exit); })()`, 20000);

  // n12: a run launched from the detail head lands on the Journal tab (live), and its successful end shows the Rapport tab with its frame, with no tab click
  await gate('n12_run_lands_on_journal_then_report', async () => {
    await toList();
    await pick('navr');
    await until(`document.getElementById('plugin-panel').dataset.page === 'detail'`);
    await rend(`document.querySelector('#plg-dhead [data-act="run"]').click();`);
    const live = await until(`document.querySelector('#plg-view .plg-journal[data-tone="run"]')`, 8000);
    const onLive = await tabNow();
    const framed = await until(REPORT_FRAME, 20000);
    const r = await rend(`return { journal: !!document.querySelector('#plg-view .plg-journal'), frames: document.querySelectorAll('#plg-view > iframe').length, full: !!document.getElementById('plg-full') && !document.getElementById('plg-full').hidden };`);
    const onEnd = await tabNow();
    return { ok: live && onLive === 'journal' && framed && onEnd === 'report' && !r.journal && r.frames === 1 && r.full, live, onLive, framed, onEnd, ...r };
  });

  // n13: « Journal complet » follows hasJournal at paint time: disabled for a finished entry with no log listed, enabled while the run goes
  await gate('n13_journal_complet_enabled_rule', async () => {
    await settle();
    await toList();
    await pick('navn');
    const shownDone = await until(`document.querySelector('#plg-view .plg-journal') && ${JFULL}`);
    const done = await rend(`const b = ${JFULL}; return { tab: (document.querySelector('#plg-detail [role="tab"][aria-selected="true"]') || {}).dataset.tab, disabled: !!b && b.disabled, pressed: b ? b.getAttribute('aria-pressed') : null };`);
    await rend(`${JFULL}.click();`); // a disabled control takes no click, and the guard keeps the full read off
    const afterClick = await rend(`const b = ${JFULL}; return { pressed: b ? b.getAttribute('aria-pressed') : null, key: window.plg.viewKey };`);
    await toList();
    await pick('navr');
    await until(`document.getElementById('plugin-panel').dataset.page === 'detail'`);
    await rend(`document.querySelector('#plg-dhead [data-act="run"]').click();`);
    const liveShown = await until(`document.querySelector('#plg-view .plg-journal[data-tone="run"]') && ${JFULL}`, 8000);
    const live = await rend(`const b = ${JFULL}; return { disabled: !!b && b.disabled };`);
    await until(REPORT_FRAME, 20000); // let the run end before the app quits
    return { ok: shownDone && done.tab === 'journal' && done.disabled === true && done.pressed === 'false' && afterClick.pressed === 'false' && !/journal:full$/.test(afterClick.key || '')
      && liveShown && live.disabled === false, shownDone, done, afterClick, liveShown, live };
  });

  // n14: the row says « Activé » / « Désactivé » (the Paramètres switch state): one badge between the pick and the run button, text + tone per plugin,
  // untouched by a live run, flipped by a trusted click on the switch with plugins.json agreeing
  await gate('n14_row_enabled_badge', async () => {
    const wc = win.webContents;
    const statePath = path.join(app.getPath('userData'), 'plugins.json');
    const stored = (id) => { try { const e = JSON.parse(fs.readFileSync(statePath, 'utf8'))[id]; return !!e && e.enabled === true; } catch (_) { return null; } };
    const trusted = async (sel) => {
      const c = await rend(`const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width };`);
      if (!c || !(c.w > 0)) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
      wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      return true;
    };
    const readRows = () => rend(`
      return [...document.querySelectorAll('#plg-list .plg-row')].map((row) => {
        const kids = [...row.querySelector('.plg-line').children];
        const states = row.querySelectorAll('.plg-state');
        const st = states[0] || null;
        const pick = row.querySelector('[data-act="pick"]');
        const run = row.querySelector('[data-act="run"], [data-act="stop"]');
        const model = window.plg.rows.find((r) => r.id === row.dataset.id) || {};
        return { id: row.dataset.id, count: states.length, text: st ? st.textContent : null, ok: !!st && st.classList.contains('ok'), badge: !!st && st.classList.contains('plg-badge'),
          color: st ? getComputedStyle(st).color : null,
          order: kids.map((k) => (k === pick ? 'pick' : k === st ? 'state' : k === run ? 'run' : '?')).join('>'),
          inPick: !!pick && !!pick.querySelector('.plg-state'), pickName: pick ? (pick.getAttribute('aria-label') || pick.textContent) : null,
          label: (row.querySelector('.plg-label') || {}).textContent || null, enabled: model.enabled === true, off: row.classList.contains('off'),
          runText: run ? run.textContent : null };
      });`);
    const sane = (r) => r && r.count === 1 && r.badge && r.order === 'pick>state>run' && !r.inPick && r.pickName === r.label && !!r.label
      && r.text === (r.enabled ? 'Activé' : 'Désactivé') && r.ok === r.enabled && r.off === !r.enabled;
    const byId = (rows, id) => rows.find((r) => r.id === id);
    if ((await page()) === 'detail') await toList();
    await until(`document.querySelectorAll('#plg-list .plg-row').length >= 4`);
    const rows0 = await readRows();
    const baseOk = rows0.length >= 4 && rows0.every(sane) && rows0.some((r) => r.enabled) && rows0.some((r) => !r.enabled)
      && rows0.every((r) => stored(r.id) === r.enabled || (r.enabled === false && stored(r.id) !== true));
    const toneOk = (() => { const on = rows0.find((r) => r.enabled); const off = rows0.find((r) => !r.enabled); return !!on && !!off && on.color !== off.color; })();
    // a live run launched from the row changes the run button, never the badge
    const before = byId(rows0, 'navr');
    await rend(`document.querySelector('#plg-list .plg-row[data-id="navr"] [data-act="run"]').click();`);
    const live = await until(`document.querySelector('#plg-list .plg-row[data-id="navr"] [data-act="stop"]')`, 8000);
    const during = live ? byId(await readRows(), 'navr') : null;
    await settle();
    await sleep(300);
    const after = byId(await readRows(), 'navr');
    const runOk = live && !!before && !!during && !!after && sane(during) && sane(after) && during.text === before.text && after.text === before.text
      && /^Arrêt/.test(during.runText || '') && before.text === 'Désactivé';
    // a trusted click on the Paramètres switch of a disabled plugin flips its badge, and plugins.json says so
    if ((await page()) === 'detail') await toList();
    await pick('navn');
    await until(`document.getElementById('plugin-panel').dataset.page === 'detail'`);
    await rend(`document.querySelector('#plg-detail [data-tab="settings"]').click();`);
    await until(`(() => { const s = document.getElementById('plg-set-switch'); const b = s && s.getBoundingClientRect(); return !!b && b.width > 0 && !s.disabled && document.getElementById('plg-settings').offsetParent !== null; })()`);
    await sleep(400);
    const diskBefore = stored('navn');
    const clicked = await trusted('#plg-set-switch');
    const flipped = await until(`(window.plg.rows.find((x) => x.id === 'navn') || {}).enabled === true`);
    const diskAfter = stored('navn');
    await toList();
    const shown = await until(`(() => { const s = document.querySelector('#plg-list .plg-row[data-id="navn"] .plg-state'); return !!s && s.textContent === 'Activé'; })()`);
    const rows1 = await readRows();
    const flipOk = clicked && flipped && shown && diskBefore === false && diskAfter === true && rows1.every(sane) && byId(rows1, 'navn').enabled === true && byId(rows1, 'navn').ok === true
      && byId(rows1, 'navq').text === 'Activé' && byId(rows1, 'navp').text === 'Désactivé' && byId(rows1, 'navr').text === 'Désactivé';
    return { ok: baseOk && toneOk && runOk && flipOk, baseOk, toneOk, runOk, flipOk, rows0, before, during, after, clicked, flipped, shown, diskBefore, diskAfter, rows1 };
  });

  clearTimeout(watchdog);
  verdict();
}

try { boot(); } catch (err) { console.log(`FAIL boot: ${err && err.stack}`); verdict(2); }
