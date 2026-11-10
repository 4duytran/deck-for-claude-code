// test/plans-panel-probe.js — E2E probe: v40 plans panel.
// Fake session transcripts under a seamed projects root (the real ~/.claude
// is never read). Plans = */plans/*.md touched by the session + inline
// ExitPlanMode. Gates:
//   p0  markdown-it UMD loaded (CSP allows ../node_modules)
//   p1  ctx menu = copy-ID / rename / delete (no "Plans"); the side-panel Plans tab opens the panel
//   p2  list: 7 plans, sorted ts DESC (inline, gamma, beta, alpha, delta, deleted, big)
//   p3  badges: écrit / consulté / plan mode / supprimé (+ pp-missing style)
//   p4  exclusions: plans/notes.txt (non-md) and src/x.js (non-plans) absent
//   p5  LAZY: no content fetched before any click (placeholder shown)
//   p6  click alpha -> markdown rendered (h1 + table + code block)
//   p7  XSS: raw <script> in the plan arrives ESCAPED (no live element)
//   p8  links are inert: click <a> -> no navigation
//   p9  deleted file -> graceful "fichier introuvable"
//   p10 inline ExitPlanMode plan renders (title + body)
//   p11 no-plans session -> "aucun plan touché par cette session"
//   p12 keyboard: j/k moves selection, Escape closes
//   p13 mutual exclusion: openGitPanel closes the plans panel (and back)
//   p14 oversize plan (>1MB) -> "trop volumineux", never rendered
//   p15 MultiEdit-written plan visible (attack #1: WRITE_TOOLS gap)
//   p16 javascript: link never gets a live href (attack #4: validateLink)
//   p17 nav guards: window.open denied + location.assign blocked (attack #2)
//   p18 identity guard: planGet with wrong expectName -> stale, not wrong plan (attack #3)
//   p19 layout integrity: opening the panel must NOT scroll the document
//       (v40.1 regression: focus() on the off-screen panel dragged html
//       sideways — sidebar gone, panes shifted) + focus still lands
//   p20 same layout integrity for the GIT panel open path
//   p21 an .html plan the session wrote is listed (own fixture session, so p2/p4 stay exact)
//   p22 opening it mounts a closed frame: `#pp-view iframe` sandbox is exactly
//       "allow-scripts", the page script ran (marker read through WebFrameMain), and the
//       served page still holds the Google Fonts <link>. Fonts hosts are cancelled by the
//       probe (no real network).
//   p23 an INLINE (ExitPlanMode) plan whose first line ends in `.html` stays markdown: `#pp-view`
//       holds an `h1` from markdown-it and no iframe (own fixture session, p2/p4 stay exact)
// Run: cd claude-deck && npx electron test/plans-panel-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plans-probe-'));
const proj = path.join(base, 'proj');
const plansDir = path.join(proj, 'docs', 'plans');
fs.mkdirSync(plansDir, { recursive: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });

const ALPHA = path.join(plansDir, 'alpha.plan.md');
const BETA = path.join(plansDir, 'beta.contract.md');
const GAMMA = path.join(plansDir, 'gamma.plan.md');
const DELTA = path.join(plansDir, 'delta.plan.md'); // MultiEdit-only (attack #1)
const DELETED = path.join(plansDir, 'deleted.plan.md'); // transcript yes, disk no
const BIG = path.join(plansDir, 'big.plan.md');
const GAMMA_HTML = path.join(plansDir, 'gamma.html'); // p21/p22: own session, never in UUID_PLANS
const NOTES = path.join(plansDir, 'notes.txt'); // non-md -> excluded
const SRC = path.join(proj, 'src', 'x.js');     // non-plans -> excluded

fs.writeFileSync(ALPHA, [
  '# Alpha Plan',
  '',
  'Raw HTML must arrive escaped: <script>window.__xss__ = 1;</script>',
  '',
  '| col1 | col2 |',
  '|------|------|',
  '| a    | b    |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '[external link](https://example.com/should-not-navigate)',
  '',
  '[bad link](javascript:alert(1))', // must never get a live href
].join('\n'));
fs.writeFileSync(DELTA, '# Delta Plan\n\nwritten only via MultiEdit\n');
fs.writeFileSync(BETA, '# Beta Contract\n\n- [ ] item one\n');
fs.writeFileSync(GAMMA, '# Gamma Plan\n\nwritten by a SUBAGENT\n');
fs.writeFileSync(BIG, '# Big\n' + 'x'.repeat(1100 * 1024)); // > 1MB cap
// The marker never appears whole in the source: only the script's effect can put it in #m.
fs.writeFileSync(GAMMA_HTML, [
  '<!doctype html><html><head><meta charset="utf-8"><title>Gamma HTML Plan</title>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
  '</head><body><h1>Gamma HTML Plan</h1><div id="m">waiting</div>',
  '<script>document.getElementById("m").textContent = "PLAN-" + "RAN";</script>',
  '</body></html>',
].join('\n'));
fs.writeFileSync(NOTES, 'not a markdown plan\n');
fs.writeFileSync(SRC, '// not a plan\n');

// Fake transcripts. ts ASC: big(t0) deleted(t1) delta(t2) alpha(t3) beta(t4)
// gamma(t5) inline(t6) -> expected DESC: inline, gamma, beta, alpha, delta,
// deleted, big.
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
const UUID_PLANS = '33333333-3333-4333-8333-333333333333';
const UUID_EMPTY = '44444444-4444-4444-8444-444444444444';
const UUID_HTML = '55555555-5555-4555-8555-555555555555';
const UUID_INLINE_HTML = '66666666-6666-4666-8666-666666666666'; // p23: inline plan titled « … index.html »
const ts = (i) => `2026-06-05T10:0${i}:00.000Z`;
const toolLine = (name, input, t) => JSON.stringify({
  type: 'assistant', timestamp: t,
  message: { content: [{ type: 'tool_use', name, input }] },
}) + '\n';
fs.mkdirSync(path.join(projDir, UUID_PLANS, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(projDir, `${UUID_PLANS}.jsonl`),
  JSON.stringify({ type: 'summary', cwd: proj }) + '\n'
  + toolLine('Write', { file_path: BIG }, ts(0))
  + toolLine('Write', { file_path: DELETED }, ts(1))
  + toolLine('MultiEdit', { file_path: DELTA }, ts(2)) // MultiEdit counts as write
  + toolLine('Write', { file_path: ALPHA }, ts(3))
  + toolLine('Edit', { file_path: ALPHA }, ts(3)) // dedup: same file, 2 events
  // beta: READ-only, via the paths-array tool -> badge "consulté"
  + toolLine('mcp__filesystem__read_multiple_files', { paths: [BETA, SRC] }, ts(4))
  + toolLine('Write', { file_path: NOTES }, ts(4)) // non-md -> excluded
  + toolLine('Write', { file_path: SRC }, ts(4))   // non-plans -> excluded
  + toolLine('ExitPlanMode', { plan: '# Inline Plan Title\n\nnative plan-mode body\n' }, ts(6)));
fs.writeFileSync(path.join(projDir, UUID_PLANS, 'subagents', 'agent-1.jsonl'),
  toolLine('mcp__filesystem__write_file', { path: GAMMA }, ts(5))); // subagents walk
fs.writeFileSync(path.join(projDir, `${UUID_EMPTY}.jsonl`),
  toolLine('Write', { file_path: SRC }, ts(0))); // touched files, zero plans
fs.writeFileSync(path.join(projDir, `${UUID_HTML}.jsonl`),
  JSON.stringify({ type: 'summary', cwd: proj }) + '\n'
  + toolLine('Write', { file_path: GAMMA_HTML }, ts(7))); // the one .html plan
fs.writeFileSync(path.join(projDir, `${UUID_INLINE_HTML}.jsonl`),
  JSON.stringify({ type: 'summary', cwd: proj }) + '\n'
  + toolLine('ExitPlanMode', { plan: '# Refonte de index.html\n\ninline markdown body\n' }, ts(8)));

process.env.CLAUDE_DECK_BIN = '/bin/bash'; // real shell, never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // real ~/.claude untouched
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-'))); // never share a live profile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { app, BrowserWindow, net, session } = require('electron');
// Rejects after `ms`; the timer is cleared so it never outlives the call.
const withTimeout = (p, ms, label) => {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};
// Polls `fn` until it returns a truthy value or `ms` elapses (then null); a throw counts as "not yet".
const waitFor = async (fn, ms, step = 100) => {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(step);
  }
};
app.whenReady().then(async () => {
  const results = {};
  try {
    // p22 mounts a page holding the Google Fonts <link>: cancel those hosts BEFORE any window
    // content loads, so the probe never touches the real network. Counted for the diagnostics.
    let fontsCancelled = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] },
      (_d, cb) => { fontsCancelled++; cb({ cancel: true }); });
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const j = (code) => win.webContents.executeJavaScript(code, true);

    // p0 — markdown-it UMD present under CSP default-src 'self'.
    results.p0_markdownit_loaded = await j(`typeof markdownit === 'function' && !!ppMd`);

    // p1 — entry points (B22 + B2): the right-click session menu no longer carries
    // « Plans » (copy-ID / rename / delete only); the Plans tab of the docked side
    // panel opens the plans panel (real tab clicks: Git first so the panel holds a
    // target, then Plans). A detached row is enough for the menu.
    results.p1_ctx_menu_entry = await j(`(() => {
      const row = document.createElement('div');
      row.dataset.sessionId = '${UUID_PLANS}';
      openCtxMenu(10, 10, row);
      const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.dataset.action);
      closeCtxMenu();
      const plansTab = document.querySelector('.sp-tab[data-tab="plans"]');
      const gitTab = document.querySelector('.sp-tab[data-tab="git"]');
      if (!plansTab || !gitTab) return { items, tab: false };
      openGitPanel({ sessionId: '${UUID_PLANS}' }); // gives the side panel a target
      plansTab.click();
      const r = { items, tab: true, label: plansTab.textContent.trim(), selected: plansTab.getAttribute('aria-selected'),
        open: pp.open, shown: !document.getElementById('plans-panel').hidden, gitClosed: !gp.open };
      closeSidePanel();
      return r;
    })()`);
    results.diag_p1 = results.p1_ctx_menu_entry;
    results.p1_ctx_menu_entry = JSON.stringify(results.diag_p1.items) === JSON.stringify(['copyid', 'rename', 'delete'])
      && results.diag_p1.tab === true && results.diag_p1.selected === 'true'
      && results.diag_p1.open === true && results.diag_p1.shown === true && results.diag_p1.gitClosed === true;

    // Open the panel exactly like the menu handler does.
    const wx0 = await j(`document.getElementById('workspace').getBoundingClientRect().x`);
    await j(`openPlansPanel({ sessionId: '${UUID_PLANS}' })`);
    await sleep(700); // list round-trip

    // p19 — the document did NOT scroll (v40.1 class) and focus landed.
    results.p19_layout_integrity = await j(`(() => ({
      wx: document.getElementById('workspace').getBoundingClientRect().x,
      sl: document.documentElement.scrollLeft,
      focused: document.activeElement && document.activeElement.id,
    }))()`).then((r) => r.wx === wx0 && r.sl === 0 && r.focused === 'pp-list');
    const list = await j(`({
      open: document.getElementById('plans-panel').classList.contains('open'),
      count: document.getElementById('pp-count').textContent,
      rows: [...document.querySelectorAll('.pp-row')].map((r) => ({
        name: r.querySelector('.gp-path').textContent,
        badges: [...r.querySelectorAll('.gp-pills i')].map((b) => b.textContent),
        missing: r.classList.contains('pp-missing'),
      })),
      view: document.getElementById('pp-view').textContent.trim(),
    })`);
    results.diag_list = list;
    const names = list.rows.map((r) => r.name);
    results.p2_list_order = list.open && list.count === '7 plans'
      && JSON.stringify(names) === JSON.stringify(['Inline Plan Title',
        'gamma.plan.md', 'beta.contract.md', 'alpha.plan.md',
        'delta.plan.md', 'deleted.plan.md', 'big.plan.md']);
    const byName = (n) => list.rows.find((r) => r.name === n);
    results.p3_badges = byName('alpha.plan.md').badges.includes('écrit')
      && byName('beta.contract.md').badges.includes('consulté')
      && byName('gamma.plan.md').badges.includes('écrit')
      && byName('Inline Plan Title').badges.includes('plan mode')
      && byName('deleted.plan.md').badges.includes('supprimé')
      && byName('deleted.plan.md').missing === true;
    results.p4_exclusions = !names.includes('notes.txt') && !names.includes('x.js');
    results.p5_lazy = list.view.includes('Sélectionne un plan');

    // p15 — MultiEdit-only plan is visible with the write badge (attack #1).
    results.p15_multiedit_write = (() => {
      const d = byName('delta.plan.md');
      return !!d && d.badges.includes('écrit') && !d.missing;
    })();

    // p6/p7/p8 — render alpha (index 3 in the DESC list).
    await j(`ppLoadPlan(3)`);
    await sleep(400);
    const alpha = await j(`({
      h1: (document.querySelector('#pp-view h1') || {}).textContent || '',
      hasTable: !!document.querySelector('#pp-view table td'),
      hasCode: !!document.querySelector('#pp-view pre code'),
      liveScript: !!document.querySelector('#pp-view script'),
      xssRan: typeof window.__xss__ !== 'undefined',
      textHasTag: document.getElementById('pp-view').textContent.includes('<script>'),
      href: location.href,
    })`);
    results.diag_alpha = alpha;
    results.p6_markdown_rendered = alpha.h1 === 'Alpha Plan' && alpha.hasTable && alpha.hasCode;
    results.p7_xss_escaped = !alpha.liveScript && !alpha.xssRan && alpha.textHasTag;
    const before = alpha.href;
    await j(`(() => { const a = document.querySelector('#pp-view a'); if (a) a.click(); })()`);
    await sleep(300);
    results.p8_links_inert = (await j(`location.href`)) === before;

    // p16 — javascript: href never reaches the DOM live (markdown-it
    // validateLink); the visible text may remain, the protocol must not.
    results.p16_jslink_blocked = await j(`[...document.querySelectorAll('#pp-view a')]
      .every((a) => !(a.getAttribute('href') || '').toLowerCase().startsWith('javascript:'))`);

    // p17 — main-side nav guards (attack #2): window.open denied,
    // programmatic navigation swallowed by will-navigate.
    const openDenied = await j(`window.open('https://example.com/nope') === null`);
    await j(`location.assign('https://example.com/nav-attempt')`);
    await sleep(500);
    const stillHome = (await j(`location.href`)) === before;
    const oneWindow = BrowserWindow.getAllWindows().length === 1;
    results.p17_nav_guards = openDenied && stillHome && oneWindow;

    // p18 — identity guard (attack #3): wrong expectName -> stale refusal,
    // never the wrong plan's content.
    results.p18_stale_guard = await j(`window.api.planGet(pp.target, 0, 'WRONG.md')
      .then((r) => r.ok === false && r.stale === true)`);

    // p9 — deleted file (index 5) -> graceful error, no crash.
    await j(`ppLoadPlan(5)`);
    await sleep(400);
    results.p9_deleted_graceful = await j(
      `document.getElementById('pp-view').textContent.includes('introuvable')`);

    // p10 — inline plan (index 0) renders title + body.
    await j(`ppLoadPlan(0)`);
    await sleep(400);
    results.p10_inline_plan = await j(`(() => {
      const v = document.getElementById('pp-view');
      const h1 = v.querySelector('h1');
      return !!h1 && h1.textContent === 'Inline Plan Title'
        && v.textContent.includes('native plan-mode body');
    })()`);

    // p14 — oversize plan (index 6) -> capped, never rendered.
    await j(`ppLoadPlan(6)`);
    await sleep(500);
    results.p14_oversize_capped = await j(`(() => {
      const t = document.getElementById('pp-view').textContent;
      return t.includes('volumineux') && t.length < 500;
    })()`);

    const key = (k) => j(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true }))`);

    // no_jk_nav — j / k are not file keys: on the panel they move nothing and are not swallowed; the arrows still move.
    await j(`ppLoadPlan(1)`);
    await sleep(300);
    const jkNav = [];
    for (const k of ['j', 'k']) {
      const prevented = await j(`(() => { const e = new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })()`);
      await sleep(300);
      jkNav.push({ k, prevented, sel: await j(`pp.selected`) });
    }
    await key('ArrowDown'); await sleep(300);
    const navDown = await j(`pp.selected`);
    await key('ArrowUp'); await sleep(300);
    const navUp = await j(`pp.selected`);
    results.diag_no_jk_nav = { jkNav, navDown, navUp };
    results.no_jk_nav = jkNav.every((r) => r.prevented === false && r.sel === 1) && navDown === 2 && navUp === 1;

    // plans_composer_letters — a j / k typed in a chat composer while the panel is open is a letter, never a move.
    // Real input events (keyDown + char + keyUp) into a focused contenteditable shaped like the pane's composer.
    const selBeforeLetters = await j(`pp.selected`);
    win.webContents.focus();
    await j(`(() => {
      const host = document.createElement('div');
      host.id = 'probe-composer-host';
      host.className = 'pane';
      const c = document.createElement('div');
      c.className = 'chat-input';
      c.setAttribute('contenteditable', 'true');
      c.setAttribute('role', 'textbox');
      host.appendChild(c);
      document.body.appendChild(host);
      c.focus();
    })()`);
    for (const k of ['j', 'k']) {
      for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: k });
      await sleep(300);
    }
    const letters = await j(`({
      text: document.querySelector('#probe-composer-host .chat-input').textContent,
      focused: document.activeElement === document.querySelector('#probe-composer-host .chat-input'),
      sel: pp.selected, open: pp.open,
    })`);
    await j(`document.getElementById('probe-composer-host').remove()`);
    results.diag_composer_letters = { selBeforeLetters, letters };
    results.plans_composer_letters = letters.open === true && letters.focused === true
      && letters.text.endsWith('jk') && letters.sel === selBeforeLetters;

    // plans_composer_keys — ArrowDown / ArrowUp / Enter / Escape typed in a chat composer while the panel is open
    // belong to the composer: no plan move, no focus theft, no panel close. Same stand-in composer, real key events.
    const selBeforeKeys = await j(`pp.selected`);
    win.webContents.focus();
    await j(`(() => {
      const host = document.createElement('div');
      host.id = 'probe-composer-host';
      host.className = 'pane';
      const c = document.createElement('div');
      c.className = 'chat-input';
      c.setAttribute('contenteditable', 'true');
      c.setAttribute('role', 'textbox');
      host.appendChild(c);
      document.body.appendChild(host);
      c.focus();
    })()`);
    const composerKeys = [];
    for (const [name, keyCode] of [['ArrowDown', 'Down'], ['ArrowUp', 'Up'], ['Enter', 'Enter'], ['Escape', 'Escape']]) {
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
      await sleep(400);
      composerKeys.push({ name, ...(await j(`({
        sel: pp.selected, open: pp.open,
        focused: document.activeElement === document.querySelector('#probe-composer-host .chat-input'),
      })`)) });
    }
    await j(`document.getElementById('probe-composer-host').remove()`);
    results.diag_composer_keys = { selBeforeKeys, composerKeys };
    results.plans_composer_keys = selBeforeKeys >= 0
      && composerKeys.every((r) => r.sel === selBeforeKeys && r.focused === true && r.open === true);
    // Put the panel back as it was so the gates below stay independent of this one.
    if (!(await j(`pp.open`))) {
      await j(`openPlansPanel({ sessionId: '${UUID_PLANS}' })`);
      await sleep(400);
    }
    await j(`ppLoadPlan(${Math.max(selBeforeKeys, 0)})`);
    await sleep(300);

    // p12 — keyboard: select 0, ArrowDown -> 1, ArrowUp -> 0, Escape closes.
    await j(`ppLoadPlan(0)`);
    await sleep(300);
    await key('ArrowDown'); await sleep(300);
    const selAfterJ = await j(`pp.selected`);
    await key('ArrowUp'); await sleep(300);
    const selAfterK = await j(`pp.selected`);
    await key('Escape'); await sleep(400);
    const openAfterEsc = await j(`pp.open`);
    results.p12_keyboard = selAfterJ === 1 && selAfterK === 0 && openAfterEsc === false;

    // p13 — mutual exclusion, both directions.
    await j(`openPlansPanel({ sessionId: '${UUID_PLANS}' })`);
    await sleep(300);
    await j(`openGitPanel({ sessionId: '${UUID_PLANS}' })`);
    await sleep(400);
    const ppClosedByGit = await j(`pp.open === false && gp.open === true`);
    // p20 — same layout-integrity class on the git panel open path.
    results.p20_git_layout_integrity = await j(`(() => ({
      wx: document.getElementById('workspace').getBoundingClientRect().x,
      sl: document.documentElement.scrollLeft,
    }))()`).then((r) => r.wx === wx0 && r.sl === 0);
    await j(`openPlansPanel({ sessionId: '${UUID_PLANS}' })`);
    await sleep(400);
    const gpClosedByPlans = await j(`gp.open === false && pp.open === true`);
    results.p13_mutual_exclusion = ppClosedByGit && gpClosedByPlans;

    // p11 — session with zero plans -> dedicated empty state.
    await j(`openPlansPanel({ sessionId: '${UUID_EMPTY}' })`);
    await sleep(500);
    results.p11_empty_state = await j(
      `document.getElementById('pp-list').textContent.includes('aucun plan touché')`);

    // p21 / p22 — an .html plan (own session UUID_HTML: p2/p4 pin the exact list of UUID_PLANS).
    // Both gates exist and are false until proven; the whole block is bounded by one timeout.
    results.p21_html_plan_listed = false;
    results.p22_html_plan_runs_closed = false;
    const dh = { fontsCancelled: 0 };
    results.diag_html = dh;
    try {
      await withTimeout((async () => {
        await j(`openPlansPanel({ sessionId: '${UUID_HTML}' })`);
        const hl = await waitFor(() => j(`(() => {
          const el = document.getElementById('pp-list');
          const rows = [...el.querySelectorAll('.pp-row')];
          const empty = el.textContent.includes('aucun plan touché');
          if (!rows.length && !empty) return null; // list not painted yet
          return { empty, rows: rows.map((r) => ({
            name: r.querySelector('.gp-path').textContent,
            badges: [...r.querySelectorAll('.gp-pills i')].map((b) => b.textContent),
            missing: r.classList.contains('pp-missing'),
          })) };
        })()`), 4000);
        dh.list = hl;
        results.p21_html_plan_listed = !!hl && hl.rows.length === 1
          && hl.rows[0].name === 'gamma.html' && hl.rows[0].badges.includes('écrit')
          && hl.rows[0].missing === false;

        const idx = hl ? hl.rows.findIndex((r) => r.name === 'gamma.html') : -1;
        if (idx < 0) { dh.reason = 'gamma.html not listed'; return; }
        await j(`ppLoadPlan(${idx})`);
        const fr = await waitFor(() => j(`(() => {
          const f = document.querySelector('#pp-view iframe');
          return f ? { sandbox: f.getAttribute('sandbox'), src: f.src } : null;
        })()`), 4000);
        dh.iframe = fr;
        if (!fr) { dh.reason = 'no iframe in #pp-view'; return; }

        const mainFrame = win.webContents.mainFrame;
        dh.frames = mainFrame.framesInSubtree.map((f) => f.url);
        const marker = await waitFor(async () => {
          const f = mainFrame.framesInSubtree.find((x) => x !== mainFrame && x.url === fr.src);
          if (!f) return null;
          const v = await f.executeJavaScript(`(document.getElementById('m') || {}).textContent`);
          return v === 'PLAN-RAN' ? v : null;
        }, 5000);
        dh.marker = marker;

        // The served page must still hold the fonts <link> (the frame gets the RAW html).
        let served = '';
        try { served = await (await net.fetch(fr.src)).text(); } catch (e) { dh.fetchError = String(e); }
        const fontsLink = (served.match(/<link\b[^>]*>/gi) || []).some((t) =>
          /\brel=["']stylesheet["']/i.test(t)
          && /\bhref=["']https:\/\/fonts\.googleapis\.com\//i.test(t));
        dh.fontsLink = fontsLink;
        results.p22_html_plan_runs_closed = fr.sandbox === 'allow-scripts'
          && marker === 'PLAN-RAN' && fontsLink;
      })(), 20000, 'p21/p22 html plan');
    } catch (e) { dh.error = String(e); }
    dh.fontsCancelled = fontsCancelled;

    // p23 — an inline plan titled « … index.html » is markdown, not a page: its name is its first
    // line, so only the plan kind (file vs inline) may route to the closed frame.
    results.p23_inline_html_title_stays_markdown = false;
    const di = {};
    results.diag_inline_html = di;
    try {
      await withTimeout((async () => {
        await j(`openPlansPanel({ sessionId: '${UUID_INLINE_HTML}' })`);
        const rowsOf = () => j(`[...document.querySelectorAll('#pp-list .pp-row')].map((r) => ({
          name: r.querySelector('.gp-path').textContent,
          badges: [...r.querySelectorAll('.gp-pills i')].map((b) => b.textContent),
        }))`);
        // The previous session's rows stay painted until the new list lands: wait for OUR row.
        const il = await waitFor(async () => {
          const rows = await rowsOf();
          return rows.some((r) => r.name === 'Refonte de index.html') ? rows : null;
        }, 4000);
        di.list = il || await rowsOf();
        if (!il || il.length !== 1 || !il[0].badges.includes('plan mode')) {
          di.reason = 'inline plan not listed'; return;
        }
        await j(`ppLoadPlan(0)`);
        const view = await waitFor(() => j(`(() => {
          const v = document.getElementById('pp-view');
          const h1 = v.querySelector('h1');
          const frame = !!v.querySelector('iframe');
          return h1 || frame ? { h1: h1 ? h1.textContent : null, frame,
            body: v.textContent.includes('inline markdown body') } : null;
        })()`), 4000);
        di.view = view;
        results.p23_inline_html_title_stays_markdown = !!view && view.frame === false
          && view.h1 === 'Refonte de index.html' && view.body === true;
      })(), 20000, 'p23 inline html title');
    } catch (e) { di.error = String(e); }
  } catch (err) {
    results.error = String(err && err.stack || err);
  }

  // Dynamic verdict — NEVER hardcode the gate count (lesson learned).
  const gates = Object.keys(results).filter((k) => /^(p\d+_|plans_composer_letters$|plans_composer_keys$|no_jk_nav$)/.test(k));
  const failed = gates.filter((k) => results[k] !== true);
  console.log(JSON.stringify({
    pass: !results.error && gates.length > 0 && failed.length === 0,
    gates: gates.length, failed, results,
  }, null, 2));
  fs.rmSync(base, { recursive: true, force: true });
  app.exit(failed.length || results.error ? 1 : 0);
});
