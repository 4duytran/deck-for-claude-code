// test/plugin-journal-probe.js — part A (gates j1-j7, j16) of daily-brief-v3 step D1: renderer/js/plugin-journal.js.
// The module is pure (no DOM, no IO, no import), so the probe's main process imports a .mjs COPY of it (the copy trick of
// the syntax gate) and asserts on parseJournal's return value. Clock times are built from LOCAL dates, so the HH:MM:SS
// expectations hold in any time zone.
// Part B (gates j8-j15, step D2): the journal view of the Plugins panel in the REAL app. Fake plugins (bash scripts that write journal
// lines with `sleep` between them) are launched by the real runner through a `bash --norc` wrapper standing for the user's shell, over a
// throwaway HOME / userData / plugins dir; a spy on the `plugins-read-log` handler counts the polls. No real plugin, no env value is read.
// Run: env -u SLACK_APP_TOKEN -u SLACK_USER_TOKEN -u OPENAI_API_KEY ... xvfb-run -a node_modules/.bin/electron test/plugin-journal-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'js', 'plugin-journal.js');
const results = {};

const T0 = new Date(2026, 10, 3, 8, 57, 1).getTime();
const stamp = (off) => String(T0 + off);
const step = (id, state, off, text) => `::deck-step:: ${id} ${state} ${stamp(off)}${text ? ` ${text}` : ''}`;
const hms = (off) => new Date(T0 + off).toTimeString().slice(0, 8);
const nl = (...ls) => `${ls.join('\n')}\n`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 90 ? `${x.slice(0, 90)}...(${x.length})` : x));

async function gate(name, fn) {
  let res;
  try { res = await fn(); } catch (e) { res = { ok: false, threw: String(e && e.stack || e) }; }
  results[name] = res.ok === true;
  console.log(`${res.ok === true ? 'PASS' : 'FAIL'}: ${name}`);
  if (res.ok !== true) console.log(`  detail: ${short(res)}`);
}

async function partA(parseJournal) {
  const P = (text, opts) => parseJournal(text, opts);
  const ST = (r) => r.steps.map((s) => `${s.id}:${s.state}`);

  await gate('j1_five_states_parse', () => {
    const text = nl(
      step('alpha', 'wait', 0, 'Alpha'), step('beta', 'wait', 1, 'Beta'), step('gamma', 'wait', 2, 'Gamma'),
      step('delta', 'wait', 3, 'Delta'), step('eps', 'wait', 4, 'Epsilon'), step('zeta', 'wait', 5, 'Zeta'),
      step('beta', 'start', 100, 'appels Claude : abonnement'),
      step('gamma', 'done', 200, '39 tickets (3,1 s)'),
      step('delta', 'warn', 300, 'partiel : il manque 4 droits (11,8 s)'),
      step('eps', 'fail', 400, 'RuntimeError : boom'),
      step('zeta', 'done', 500),
    );
    const r = P(text, { live: false, exit: 0 });
    const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    const ok = eq(ST(r), ['alpha:wait', 'beta:start', 'gamma:done', 'delta:warn', 'eps:fail', 'zeta:done'])
      && by.alpha.label === 'Alpha' && by.alpha.text === '' && by.alpha.startMs === null
      && by.beta.label === 'Beta' && by.beta.text === 'appels Claude : abonnement' && by.beta.startMs === T0 + 100
      && by.gamma.text === '39 tickets (3,1 s)' && by.delta.text === 'partiel : il manque 4 droits (11,8 s)'
      && by.eps.text === 'RuntimeError : boom'
      && by.zeta.text === '' && by.zeta.label === 'Zeta' // O3: the text field is optional
      && r.failed === null;
    return { ok, states: ST(r), by };
  });

  await gate('j2_plain_and_malformed_lines_are_never_steps', () => {
    const bad = [
      'hello world',
      step('Bad1', 'start', 0, 'x'),
      step('1abc', 'start', 0, 'x'),
      step('a'.repeat(33), 'start', 0, 'x'),
      step('jira', 'paused', 0, 'x'),
      `::deck-step:: jira start ${String(T0).slice(0, 12)} x`,
      `::deck-step:: jira start ${stamp(0)}0 x`,
      `::deck-step::jira start ${stamp(0)} x`,
      `::deck-step:: jira start${stamp(0)} x`,
      `::deck-step:: jira done ${stamp(0)} `,
      `::deck-step:: jira done ${stamp(0)}\tx`,
      '::deck-step::',
      ' ::deck-step:: jira start 1 x',
    ];
    const ctl = step('ctl', 'done', 9, 'seen');
    const r = P(nl(...bad, ctl), { live: false, exit: 0 });
    const asIs = bad.every((b, i) => r.allLines[i] === b);
    const ok = eq(ST(r), ['ctl:done']) && asIs && r.allLines.length === bad.length + 1 && r.allLines[bad.length] === `${hms(9)}  ctl · seen`;
    return { ok, states: ST(r), asIs, allLines: r.allLines };
  });

  await gate('j3_caps_ids_text_and_last_lines', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
    const idText = nl(...ids.map((id, i) => step(id, 'wait', i, id.toUpperCase())), step('s01', 'done', 99, 'late'));
    const r1 = P(idText, { live: false, exit: 0 });
    const idsOk = r1.steps.length === 16 && !r1.steps.some((s) => s.id === 's17')
      && r1.steps[0].state === 'done' && r1.steps[0].text === 'late'
      && r1.allLines.includes(step('s17', 'wait', 16, 'S17')); // the 17th id is a plain line, raw

    const t200 = 'x'.repeat(200);
    const b201 = step('b', 'done', 0, 'y'.repeat(201));
    const r2 = P(nl(step('a', 'done', 0, t200), b201, step('c', 'done', 0, 'z'.repeat(500)), 'p'.repeat(1000)), { live: false, exit: 0 });
    // text > 200 chars: the line is not a step (grammar), so it is a plain line, shown raw and clipped to 300
    const textOk = eq(ST(r2), ['a:done']) && r2.steps[0].text.length === 200
      && r2.allLines[1] === b201 && r2.allLines[2].length === 300 && r2.allLines[3].length === 300;

    const plain = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const r3 = P(nl(...plain), { live: false, exit: 0 });
    const r4 = P(nl('only', 'two'), { live: false, exit: 0 });
    const lastOk = eq(r3.lines, plain.slice(12)) && r3.allLines.length === 20 && eq(r4.lines, ['only', 'two']);
    return { ok: idsOk && textOk && lastOk, idsOk, textOk, lastOk, n: r1.steps.length, textLens: r2.allLines.map((l) => l.length), last: r3.lines };
  });

  await gate('j4_live_trailing_line_without_newline_is_not_parsed', () => {
    const full = nl(step('jira', 'wait', 0, 'Jira'), 'plain one');
    const partial = step('jira', 'start', 5, 'detail');
    const live = P(full + partial, { live: true });
    const ended = P(full + partial, { live: false, exit: 0 });
    const cut = P(full + step('jira', 'start', 5, 'detail').slice(0, 30), { live: true });
    const closed = P(`${full}${partial}\n`, { live: true });
    const ok = eq(ST(live), ['jira:wait']) && live.allLines.length === 2 && live.lines.every((l) => !l.includes('detail'))
      && eq(ST(ended), ['jira:start']) && ended.allLines.length === 3
      && cut.allLines.length === 2 && !cut.allLines.some((l) => l.includes('::deck-step'))
      && eq(ST(closed), ['jira:start']);
    return { ok, live: ST(live), ended: ST(ended), cut: cut.allLines, closed: ST(closed) };
  });

  await gate('j5_ended_nonzero_run_shows_a_start_step_failed', () => {
    const text = nl(step('a', 'wait', 0, 'A'), step('b', 'wait', 0, 'B'), step('c', 'wait', 0, 'C'), step('a', 'done', 1, '1'), step('b', 'start', 2, 'x'));
    const bad = P(text, { live: false, exit: 2 });
    const zero = P(text, { live: false, exit: 0 });
    const liveRun = P(text, { live: true, exit: 2 });
    const killed = P(text, { live: false, exit: null });
    const ok = eq(ST(bad), ['a:done', 'b:fail', 'c:wait']) && eq(ST(zero), ['a:done', 'b:start', 'c:wait'])
      && eq(ST(liveRun), ['a:done', 'b:start', 'c:wait']) && eq(ST(killed), ['a:done', 'b:start', 'c:wait']);
    return { ok, bad: ST(bad), zero: ST(zero), liveRun: ST(liveRun), killed: ST(killed) };
  });

  await gate('j6_failing_step_and_one_line_error', () => {
    const noMsg = (c) => `arrêt sans message (code ${c})`;
    const a = P(nl(step('slack', 'wait', 0, 'Slack'), step('slack', 'fail', 1, 'RuntimeError : boom')), { live: false, exit: 1 });
    const b = P(nl(step('slack', 'wait', 0, 'Slack'), step('slack', 'fail', 1)), { live: false, exit: 3 });
    const c = P(nl(step('run', 'wait', 0, 'Démarrage'), step('run', 'start', 1, 'appels Claude : abonnement')), { live: false, exit: 4 });
    const d = P(nl(step('x', 'fail', 0, 'first'), step('y', 'fail', 1, 'second'), step('z', 'done', 2, 'ok')), { live: false, exit: 1 });
    const e = P(nl(step('x', 'fail', 0, 'explicit'), step('y', 'start', 1, 'detail')), { live: false, exit: 1 });
    const f = P(nl('old plugin line', 'another'), { live: false, exit: 7 });
    const g = P(nl(step('x', 'fail', 0, 'boom')), { live: false, exit: 0 });
    const ok = a.failed && a.failed.step.id === 'slack' && a.failed.step.label === 'Slack' && a.failed.text === 'RuntimeError : boom' && a.failed.code === 1
      && b.failed.step.id === 'slack' && b.failed.text === noMsg(3)
      && c.failed.step.id === 'run' && c.failed.text === noMsg(4) && c.steps[0].state === 'fail' // a progress detail is not an error
      && d.failed.step.id === 'y' && d.failed.text === 'second'
      && e.failed.step.id === 'x' && e.failed.text === 'explicit'
      && f.failed.step === null && f.failed.text === noMsg(7) && f.failed.code === 7
      && g.failed === null;
    return { ok, a: a.failed, b: b.failed, c: c.failed, d: d.failed, e: e.failed, f: f.failed, g: g.failed };
  });

  await gate('j7_static_no_innerhtml_eval_function_or_import', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const hits = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\b/, /\bFunction\s*\(/, /\bimport\b/, /\bdocument\b/, /\bwindow\b/, /\brequire\b/]
      .filter((re) => re.test(src)).map(String);
    return { ok: src.length > 0 && hits.length === 0, hits };
  });

  await gate('j16_step_line_text_is_shown_as_is_no_computed_duration', () => {
    const r = P(nl(
      step('jira', 'wait', 0, 'Jira'), step('jira', 'start', 1000), step('jira', 'done', 4100, '39 tickets (3,1 s)'),
      step('slack', 'wait', 0, 'Slack'), step('slack', 'start', 5000), step('slack', 'warn', 16800, 'partiel : il manque 4 droits (11,8 s)'),
      step('cve', 'wait', 0, 'CVE'), step('cve', 'done', 17000, '12 CVE'),
      step('syn', 'wait', 0, 'Synthèse'), step('syn', 'start', 17100, 'appels Claude'), step('syn', 'done', 20200, '3 résumés'),
    ), { live: false, exit: 0 });
    const L = r.allLines;
    const ok = L[0] === `${hms(0)}  Jira` && L[1] === `${hms(1000)}  Jira`
      && L[2] === `${hms(4100)}  Jira · 39 tickets (3,1 s)`
      && L[5] === `${hms(16800)}  Slack · partiel : il manque 4 droits (11,8 s)`
      && L[7] === `${hms(17000)}  CVE · 12 CVE`
      && L[10] === `${hms(20200)}  Synthèse · 3 résumés` // a done closing a start 3 100 ms earlier: no duration added by the Deck
      && L[9] === `${hms(17100)}  Synthèse · appels Claude`
      && eq(r.lines, L.slice(-8));
    return { ok, lines: L };
  });
}

// ---- part B: fixtures, boot, driver ------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = { dirs: null, readLogCalls: 0 };
const TSTEP = "t() { printf '::deck-step:: %s %s %s%s\\n' \"$1\" \"$2\" \"$(date +%s%3N)\" \"${3:+ $3}\"; }";
const SCRIPTS = {
  jok: ['t alpha wait Alpha', 't beta wait Beta', 't gamma wait Gamma', "t alpha start 'lecture'", 'sleep 1', "t alpha done '3 éléments (1,0 s)'", "t beta start 'calcul'", 'sleep 1',
    "t beta done '2 groupes (1,0 s)'", "echo 'ligne simple'", 'sleep 2', `printf '<!doctype html><title>R-JOK</title><p>rapport</p>' > "$DECK_PLUGIN_REPORT"`, 't gamma done', 'exit 0'],
  jfail: ['t jira wait Jira', "t cve wait 'Lecture des CVE'", 't syn wait Synthèse', "t jira start 'six services'", 'sleep 1', "t jira done '39 tickets (1,0 s)'", "t cve start 'lecture'", 'sleep 1',
    "t cve fail 'KeyError : severity'", "echo 'Traceback (most recent call last):'", "echo 'KeyError: severity'", 'exit 1'],
  jhtml: ["t xss wait 'Étape <b>x</b>'", "t xss start '<img src=x onerror=alert(1)>'", "echo '<img src=x onerror=alert(1)>'", "echo '<b>x</b>'", 'sleep 1', "t xss fail '<b>x</b>'", 'exit 1'],
  jold: ["echo 'ligne un'", "echo 'ligne deux'", 'sleep 1', "echo 'ligne trois'", 'exit 1'],
  jlive: ["t a wait 'Étape A'", "t a start 'en cours'", 'sleep 7', "t a done 'fini'", 'exit 0'], // j17-j18: runs long enough to be driven while live
};

function buildFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-journal-probe-b-'));
  const dirs = { root };
  for (const k of ['ud', 'plugins', 'home', 'projects', 'ask', 'status', 'sh']) { dirs[k] = path.join(root, k); fs.mkdirSync(dirs[k], { recursive: true }); }
  for (const [id, lines] of Object.entries(SCRIPTS)) {
    const dir = path.join(dirs.plugins, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), `#!/bin/bash\n${TSTEP}\n${lines.join('\n')}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'deck-plugin.json'), JSON.stringify({ id, label: `Fixture ${id}`, description: 'Fixture de la sonde du journal.', argv: ['run.sh'], trigger: 'manual', env: [] }));
  }
  fs.writeFileSync(path.join(dirs.sh, 'bash'), '#!/bin/bash\nexec /bin/bash --norc "$@"\n', { mode: 0o755 });
  return dirs;
}

function bootApp() {
  const dirs = (B.dirs = buildFixtures());
  app.setPath('userData', dirs.ud);
  process.env.HOME = dirs.home;
  Object.assign(process.env, { CLAUDE_DECK_BIN: '/bin/bash', CLAUDE_DECK_NO_OPEN: '1', CLAUDE_DECK_PROJECTS_DIR: dirs.projects, CLAUDE_DECK_ASK_DIR: dirs.ask,
    CLAUDE_DECK_STATUS_DIR: dirs.status, CLAUDE_DECK_PLUGINS_DIR: dirs.plugins, CLAUDE_DECK_PLUGINS_SHELL: path.join(dirs.sh, 'bash') });
  for (const k of ['CLAUDE_DECK_PRICES_URL', 'CLAUDE_DECK_COMMANDS_URL']) process.env[k] ||= 'http://127.0.0.1:1';
  const realHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => realHandle(ch, ch === 'plugins-read-log' ? (...a) => { B.readLogCalls++; return fn(...a); } : fn); // the IPC spy of j14
  require(path.join(ROOT, 'main.js'));
}

// What #plg-view shows, as plain data.
const SNAP = `const v = document.getElementById('plg-view'); const j = v.querySelector('.plg-journal'); const q = (s) => (j ? j.querySelector(s) : null);
  const lt = q('.plg-log-title'); const ol = q('ol.plg-steps');
  return { frames: v.querySelectorAll('iframe').length, src: v.querySelector('iframe') ? v.querySelector('iframe').src : null, journal: !!j, title: q('.plg-fail-title') ? q('.plg-fail-title').textContent : null,
    steps: j ? [...j.querySelectorAll('li.plg-step')].map((li) => ({ id: li.dataset.id, state: li.dataset.state, label: li.querySelector('.plg-step-label').textContent,
      detail: li.querySelector('.plg-step-detail').textContent, word: li.querySelector('.plg-step-state').textContent })) : [],
    list: ol ? { hidden: ol.hidden } : null, fail: j ? [...j.querySelectorAll('.plg-fail-text')].map((n) => n.textContent) : [], err: q('.plg-fail-err') ? q('.plg-fail-err').textContent : null,
    logTitle: lt && !lt.hidden ? lt.textContent : null, pre: q('pre.plg-log') ? q('pre.plg-log').textContent : null, bad: j ? j.querySelectorAll('img, b').length : 0,
    buttons: v.querySelectorAll('button').length, journalActs: v.querySelectorAll('[data-act="journal"]').length, text: v.textContent };`;

async function partB() {
  const dirs = B.dirs;
  let win = null;
  for (let i = 0; i < 300 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (win && !(await win.webContents.executeJavaScript('!!(window.api && window.api.pluginsList && window.plg)', true).catch(() => false))) win = null;
    if (!win) await sleep(100);
  }
  if (!win) throw new Error('renderer never became ready');
  const wc = win.webContents;
  const rend = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const waitFor = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return true; await sleep(100); }
    return false;
  };
  const snap = () => rend(SNAP);
  const running = (id) => rend(`const r = window.plg.rows.find((x) => x.id === ${JSON.stringify(id)}); return !!r && r.running === true;`);
  // K5: journal and report render on the detail page. A pick opens it (Rapport when the latest run has a report, else Journal); « Lancer maintenant » of
  // its head starts a run and switches to the Journal tab. The list row keeps only the pick button and a quick « Lancer ».
  const openDetail = async (id) => {
    await rend(`document.querySelector('#plg-list .plg-row[data-id="${id}"] [data-act="pick"]').click(); return true;`);
    return waitFor(() => rend(`return plg.page === 'detail' && plg.shown === ${JSON.stringify(id)};`), 4000);
  };
  const openTab = async (name) => {
    await rend(`document.getElementById('plg-tab-${name}').click(); return true;`);
    await sleep(150);
  };
  const headRun = () => rend(`document.querySelector('#plg-dhead [data-act="run"]').click(); return true;`);
  // Opens the plugin's detail, starts the run from its head, samples the view until the run is over, and returns every distinct view seen plus the settled one.
  const runAndWatch = async (id) => {
    await openDetail(id);
    await headRun();
    const seen = [];
    let last = '';
    let sawRun = false;
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const s = await snap();
      const k = JSON.stringify([s.frames, s.title, s.steps.map((x) => x.state), s.pre]);
      if (k !== last) { seen.push(s); last = k; }
      const r = await running(id);
      if (r) sawRun = true;
      if (sawRun && !r) break;
      await sleep(120);
    }
    await sleep(700);
    return { seen, after: await snap(), ended: sawRun };
  };
  const logLines = (id) => {
    const d = path.join(dirs.ud, 'plugin-data', id, 'reports');
    const f = fs.readdirSync(d).filter((n) => n.endsWith('.log')).sort().pop();
    return fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter((l) => l !== '');
  };
  const liveOnly = (run) => run.seen.filter((s) => s.journal && /^En cours/.test(s.title || ''));
  const step = (s, id) => s.steps.find((x) => x.id === id) || {};

  await rend("document.getElementById('plugin-toggle').click(); return true;");
  await waitFor(async () => (await rend("return document.querySelectorAll('#plg-list .plg-row').length;")) === Object.keys(SCRIPTS).length, 10000);

  const ok = await runAndWatch('jok');
  await gate('j8_live_steps_move_wait_running_done_text_as_is', () => {
    const live = liveOnly(ok);
    const beta = live.map((s) => step(s, 'beta').state).filter(Boolean);
    const order = beta.filter((v, i) => v !== beta[i - 1]);
    const betaDone = live.find((s) => step(s, 'beta').state === 'done') || { steps: [], pre: '' };
    const lines = (betaDone.pre || '').split('\n');
    const good = eq(order, ['wait', 'start', 'done']) && ok.ended
      && step(betaDone, 'beta').detail === '2 groupes (1,0 s)' && step(betaDone, 'alpha').detail === '3 éléments (1,0 s)' // the plugin's text, as is
      && step(betaDone, 'beta').label === 'Beta' && step(betaDone, 'alpha').label === 'Alpha'
      && lines.some((l) => /^\d\d:\d\d:\d\d {2}Beta · 2 groupes \(1,0 s\)$/.test(l)) && lines.every((l) => l.split('(').length <= 2) // no duration added by the Deck
      && live.some((s) => s.steps.some((x) => x.state === 'start' && /^en cours · \d+:\d\d$/.test(x.word))) && live.every((s) => s.frames === 0 && /^En cours…/.test(s.title));
    return { ok: good, order, ended: ok.ended, betaDone: step(betaDone, 'beta'), lines, words: live.map((s) => s.steps.map((x) => x.word)).slice(0, 2) };
  });
  await gate('j9_a_successful_end_replaces_the_journal_by_the_report_frame', async () => {
    const a = ok.after;
    await sleep(300);
    const b = await snap();
    return { ok: liveOnly(ok).length > 0 && a.frames === 1 && !a.journal && b.frames === 1 && !b.journal && typeof b.src === 'string' && b.src.startsWith('deckpage://'), a: [a.frames, a.journal], b: [b.frames, b.journal, b.src] };
  });

  await gate('j11_journal_complet_row_action_shows_every_line_of_a_successful_run', async () => {
    await openTab('journal'); // « Journal complet » sits in the Journal tab (#plg-view .plg-jfull); the list row has no journal control
    const sel = '#plg-view .plg-jfull';
    await waitFor(async () => (await rend(`const b = document.querySelector(${JSON.stringify(sel)}); return !!b && !b.disabled;`)), 5000);
    const before = await rend(`return document.querySelectorAll('#plugin-panel [data-act="journal"]').length;`);
    await rend(`document.querySelector(${JSON.stringify(sel)}).click(); return true;`);
    await waitFor(async () => (await snap()).journal, 4000);
    const s = await snap();
    const pressed = await rend(`return document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-pressed');`);
    const disk = logLines('jok');
    const lines = (s.pre || '').split('\n');
    await rend(`document.querySelector(${JSON.stringify(sel)}).click(); return true;`);
    // the second click goes back to the brief journal of the same tab (the control is inside the Journal tab, not a swap with the report frame)
    const back = await waitFor(async () => {
      const x = await snap();
      const p = await rend(`const b = document.querySelector(${JSON.stringify(sel)}); return b ? b.getAttribute('aria-pressed') : null;`);
      return x.journal && x.frames === 0 && x.logTitle === 'Journal · dernières lignes' && p === 'false';
    }, 4000);
    return { ok: before === 1 && s.journal && s.frames === 0 && lines.length === disk.length && /^\d\d:\d\d:\d\d {2}Alpha$/.test(lines[0]) && lines.includes('ligne simple')
      && lines.some((l) => /\(1,0 s\)$/.test(l)) && s.logTitle === 'Journal complet' && s.buttons === 1 && s.journalActs === 1 && pressed === 'true' && back, // the one control is inside the view
    before, n: lines.length, disk: disk.length, first: lines[0], logTitle: s.logTitle, buttons: s.buttons, pressed, back };
  });

  const fail = await runAndWatch('jfail');
  await gate('j10_a_failed_run_default_view_failing_step_error_last_lines_no_frame', () => {
    const f = fail.after;
    const lines = (f.pre || '').split('\n');
    const ok2 = f.journal && f.frames === 0 && /^Échec \(code 1\)/.test(f.title || '') && step(f, 'cve').state === 'fail' && step(f, 'cve').label === 'Lecture des CVE'
      && step(f, 'jira').state === 'done' && step(f, 'syn').state === 'wait'
      && f.fail.some((t) => /code 1/.test(t) && /pendant Lecture des CVE\.$/.test(t)) && f.err === 'KeyError : severity' && f.fail.some((t) => /pas écrit de rapport/.test(t))
      && lines.length === 8 && !/^\d\d:\d\d:\d\d {2}Jira$/m.test(f.pre) && lines.includes('KeyError: severity') && f.logTitle === 'Journal · dernières lignes';
    return { ok: ok2 && fail.ended, title: f.title, steps: f.steps.map((x) => `${x.id}:${x.state}`), fail: f.fail, err: f.err, n: lines.length, logTitle: f.logTitle, frames: f.frames };
  });

  const html = await runAndWatch('jhtml');
  await gate('j12_markup_lines_show_as_text_never_as_elements', async () => {
    const h = html.after;
    const nodes = await rend("return document.querySelectorAll('#plugin-panel img').length;");
    const seenBad = html.seen.reduce((n, s) => n + s.bad, 0);
    return { ok: html.ended && h.journal && h.bad === 0 && seenBad === 0 && nodes === 0 && (h.pre || '').includes('<img src=x onerror=alert(1)>') && (h.pre || '').includes('<b>x</b>')
      && step(h, 'xss').label === 'Étape <b>x</b>' && (h.text || '').includes('<b>x</b>'), bad: h.bad, seenBad, nodes, pre: h.pre, label: step(h, 'xss').label };
  });

  const old = await runAndWatch('jold');
  await gate('j13_an_old_style_plugin_shows_plain_lines_and_no_step_list', () => {
    const o = old.after;
    const pre = o.pre || '';
    return { ok: old.ended && o.journal && o.frames === 0 && o.steps.length === 0 && (o.list === null || o.list.hidden === true) && /^Échec \(code 1\)/.test(o.title || '')
      && pre.indexOf('ligne un') >= 0 && pre.indexOf('ligne un') < pre.indexOf('ligne deux') && pre.indexOf('ligne deux') < pre.indexOf('ligne trois'),
    steps: o.steps.length, list: o.list, title: o.title, pre };
  });

  await gate('j14_no_plugins_read_log_call_after_the_final_view_nor_while_the_panel_is_closed', async () => {
    const c0 = B.readLogCalls;
    await sleep(3200);
    const idleAfterFinal = B.readLogCalls === c0;
    const before = B.readLogCalls;
    await openDetail('jok');
    await headRun();
    const polled = await waitFor(() => B.readLogCalls > before, 6000); // the spy sees the live poll
    await rend("document.getElementById('plg-close').click(); return true;");
    await sleep(500);
    const c1 = B.readLogCalls;
    await sleep(2600);
    const closedQuiet = B.readLogCalls === c1;
    // the closed panel keeps no list: ask the host itself whether the run is over
    const over = await waitFor(async () => rend("const r = (await window.api.pluginsList()).find((x) => x.id === 'jok'); return !!r && r.running !== true;"), 15000);
    await sleep(1200);
    return { ok: c0 > 0 && idleAfterFinal && polled && closedQuiet && over && B.readLogCalls === c1, c0, idleAfterFinal, polled, c1, closedQuiet, over, end: B.readLogCalls };
  });

  // The plugin holds its log open while it runs; removing the file stands for a run whose log the host does not list (hasLog false).
  const rowState = (id) => rend(`const r = window.plg.rows.find((x) => x.id === ${JSON.stringify(id)}); const b = document.querySelector('#plg-view .plg-jfull');
    return { running: !!r && r.running === true, exit: r && r.latest ? r.latest.exit : undefined, hasLog: r && r.latest ? r.latest.hasLog : undefined, stem: r && r.latest ? r.latest.stem : null,
      disabled: b ? b.disabled : null, pressed: b ? b.getAttribute('aria-pressed') : null, full: window.plg.full, key: window.plg.viewKey };`);
  const liveDir = path.join(dirs.ud, 'plugin-data', 'jlive', 'reports');

  await gate('j17_journal_complet_is_enabled_while_a_run_is_live_with_no_log_listed', async () => {
    if (!(await rend('return window.plg.open === true;'))) await rend("document.getElementById('plugin-toggle').click(); return true;");
    await waitFor(async () => (await rend("return document.querySelectorAll('#plg-list .plg-row').length;")) === Object.keys(SCRIPTS).length, 10000);
    await openDetail('jlive');
    await headRun();
    const started = await waitFor(async () => { const s = await rowState('jlive'); return s.running && typeof s.stem === 'string'; }, 8000);
    const logged = await waitFor(async () => fs.existsSync(liveDir) && fs.readdirSync(liveDir).some((n) => n.endsWith('.log')), 3000);
    if (logged) for (const n of fs.readdirSync(liveDir)) if (n.endsWith('.log')) fs.unlinkSync(path.join(liveDir, n));
    await rend('await window.plgLoadList(); return true;');
    const before = await rowState('jlive');
    const c0 = B.readLogCalls;
    await rend(`document.querySelector('#plg-view .plg-jfull').click(); return true;`);
    const polled = await waitFor(async () => B.readLogCalls >= c0 + 2, 4000); // the view reads the log, then polls it
    const after = await rowState('jlive');
    return { ok: started && logged && before.running && before.exit === null && before.hasLog === false && before.disabled === false
      && !!after.full && after.full.id === 'jlive' && after.full.stem === before.stem && after.pressed === 'true' && /journal:full$/.test(after.key || '') && polled,
    started, logged, before, after, polls: B.readLogCalls - c0 };
  });

  await gate('j18_a_finished_entry_with_no_log_listed_keeps_journal_complet_disabled', async () => {
    const over = await waitFor(async () => { await rend('await window.plgLoadList(); return true;'); const s = await rowState('jlive'); return !s.running && Number.isInteger(s.exit); }, 15000);
    await sleep(300);
    const end = await rowState('jlive');
    const c0 = B.readLogCalls;
    await sleep(1800);
    return { ok: over && end.exit === 0 && end.hasLog === false && end.disabled === true && end.pressed === 'false' && !/journal:full$/.test(end.key || '') && B.readLogCalls === c0,
      over, end, quiet: B.readLogCalls === c0 };
  });

  await gate('j15_static_no_innerhtml_and_the_served_variable_is_gone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'plugin-panel.js'), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
    const hits = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\bserved\b/].filter((re) => re.test(src)).map(String);
    return { ok: src.length > 0 && hits.length === 0 && /pluginsReadLog/.test(src) && /parseJournal/.test(src), hits };
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-journal-probe-'));
  fs.copyFileSync(SRC, path.join(dir, 'plugin-journal.mjs'));
  const mod = await import(pathToFileURL(path.join(dir, 'plugin-journal.mjs')).href);
  if (typeof mod.parseJournal !== 'function') throw new Error('parseJournal is not exported');
  await app.whenReady();
  await partA(mod.parseJournal);
  await partB();

  const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
  const n = Object.keys(results).length;
  console.log(failed.length === 0 ? `plugin-journal-probe: ALL GREEN (${n}/${n})` : `plugin-journal-probe: FAILED ${failed.join(', ')} (${n - failed.length}/${n})`);
  app.exit(failed.length === 0 ? 0 : 1);
}

const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 170s'); app.exit(2); }, 170000);
watchdog.unref();
bootApp();
main().catch((e) => { console.log(`FAIL probe crashed: ${e && e.stack}`); app.exit(2); });
