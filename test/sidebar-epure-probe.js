// test/sidebar-epure-probe.js — E2E probe: the top of the sidebar, variant A « Barre compacte »
// (spec docs/plans/deck-sidebar-epure.spec.md, mockup docs/plans/deck-sidebar-epure-maquette.html).
// Boots the REAL app against throwaway transcripts (9 sessions, 3 workspaces) and measures the real DOM:
// rects and computed styles only, never a class name. Gates a-e are the spec's DoD 2; f1-f2 pin the
// remaining variant-A details (title row, search field).
//
//   a   « + » (#new-session) in the title row, <= 32 px, title + aria-label « Nouvelle session »,
//       a click shows the start screen (#ns-home) fully inside the viewport and focuses its composer
//   b   #session-ws-filter inside #session-search; no accent at rest; 2 checked = count 2 + accent colour (no fill);
//       the popover opens inside the sidebar, below the search field; the old text is the accessible name
//   c   the four status filters are text tabs: no border, no fill; the pressed one differs by its text colour
//   d   the first group heading shares the search field's right edge and has a transparent background
//   e   #session-list starts >= 50 px higher than on main ce23f04
//   h   a REAL press on the « + » icon shows the start screen and focuses its composer (normal sidebar and folded rail)
//   i   a REAL press on the search field: the magnifier focuses the input; the popover padding keeps the popover open with
//       no input focus; the workspace pill toggles the popover with no input focus
//
// Run: cd claude-deck && xvfb-run -a node_modules/.bin/electron test/sidebar-epure-probe.js
//   (EPURE_BASE_LIST_TOP=<px> overrides BASE_LIST_TOP below)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// #session-list top (px) measured by this very probe on main ce23f04 (worktree HEAD, no edit), `xvfb-run -a`,
// CLAUDE_DECK_ZOOM=1.0, 1280x900 window (printed on the « env » line of every run): listTop=251.
const BASE_LIST_TOP = process.env.EPURE_BASE_LIST_TOP ? Number(process.env.EPURE_BASE_LIST_TOP) : 251;
const MIN_GAIN = 50;

process.env.CLAUDE_DECK_ZOOM = process.env.CLAUDE_DECK_ZOOM || '1.0';

// ---- throwaway fixtures (BEFORE app boot) ---------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sidebar-epure-'));
const fakeProjects = path.join(base, 'projects');
const projDir = path.join(fakeProjects, 'proj-test');
fs.mkdirSync(projDir, { recursive: true });
const cwdAlpha = path.join(base, 'one', 'alpha-app');
const cwdBeta = path.join(base, 'bêta-service');
const cwdGamma = path.join(base, 'gamma-lab');
for (const d of [cwdAlpha, cwdBeta, cwdGamma]) fs.mkdirSync(d, { recursive: true });

const ROWS = [
  { id: 'ee861d36-0000-4000-8000-000000000001', title: 'Résumé du déploiement', cwd: cwdAlpha, status: 'working' },
  { id: 'a2a2a2a2-0000-4000-8000-000000000002', title: 'Migration base de données', cwd: cwdAlpha, status: 'idle' },
  { id: 'a3a3a3a3-0000-4000-8000-000000000003', title: 'Café renversé', cwd: cwdAlpha, status: 'closed' },
  { id: 'b1b1b1b1-0000-4000-8000-000000000004', title: 'Revue du plan', cwd: cwdBeta, status: 'waiting' },
  { id: 'b2b2b2b2-0000-4000-8000-000000000005', title: 'Nettoyage des logs', cwd: cwdBeta, status: 'running' },
  { id: 'b3b3b3b3-0000-4000-8000-000000000006', title: 'Session fraîche', cwd: cwdBeta, status: 'active' },
  { id: 'c1c1c1c1-0000-4000-8000-000000000007', title: 'Audit des dépendances', cwd: cwdGamma, status: 'idle' },
  { id: 'c2c2c2c2-0000-4000-8000-000000000008', title: 'Ancienne piste', cwd: cwdGamma, status: 'closed' },
  { id: 'c3c3c3c3-0000-4000-8000-000000000009', title: 'Piste récente', cwd: cwdGamma, status: 'idle' },
];
const statusDir = path.join(base, 'status');
fs.mkdirSync(statusDir, { recursive: true });
ROWS.forEach((r, i) => {
  const t = new Date(Date.now() - (ROWS.length - i) * 60000).toISOString();
  fs.writeFileSync(path.join(projDir, `${r.id}.jsonl`), [
    { type: 'summary', summary: r.title, cwd: r.cwd, gitBranch: 'main' },
    { type: 'user', cwd: r.cwd, timestamp: t, message: { role: 'user', content: `go ${r.id.slice(0, 8)}` } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (r.status !== 'closed') {
    fs.writeFileSync(path.join(statusDir, `${r.id}.json`),
      JSON.stringify({ status: r.status, event: 'probe', ts: new Date().toISOString() }));
  }
});

process.env.CLAUDE_DECK_BIN = '/bin/bash'; // real shell, never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fakeProjects; // real ~/.claude untouched
process.env.CLAUDE_DECK_STATUS_DIR = statusDir;
if (!process.env.CLAUDE_DECK_ASK_DIR) process.env.CLAUDE_DECK_ASK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sidebar-epure-ask-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sidebar-epure-ud-')));

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function gate(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  results.push({ id, ok });
}

const ACCENT = [94, 234, 212];
// « rgb(...) » / « rgba(...) » / « color(srgb r g b / a) » (what color-mix serialises to) -> {r,g,b,a} on 0-255.
function parseColor(s) {
  const str = String(s || '').trim();
  if (!str || str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = str.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) };
  m = str.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) };
  return null; // unknown serialisation: the gate fails rather than guesses
}
const isAccentRgb = (c) => !!c && c.a > 0 && ACCENT.every((v, i) => Math.abs([c.r, c.g, c.b][i] - v) <= 1.5);
const isFullAccent = (c) => isAccentRgb(c) && c.a > 0.95;
const isAccentTint = (c) => isAccentRgb(c) && c.a >= 0.05 && c.a <= 0.35;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// In-page helpers, installed once (the page keeps them on window.__ep).
const INSTALL = `(() => {
  const $ = (s) => document.querySelector(s);
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const cs = (el, pseudo) => getComputedStyle(el, pseudo || null);
  const sides = (el) => { const c = cs(el); return ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({ w: parseFloat(c['border' + s + 'Width']), c: c['border' + s + 'Color'], st: c['border' + s + 'Style'] })); };
  window.__ep = {
    ready() { return !!$('.project-group h3') && !!$('#session-ws-pop [role="menuitemcheckbox"]'); },
    snap() {
      const ws = $('#session-ws-filter'); const search = $('#session-search'); const h2 = $('#sidebar h2');
      const ns = $('#new-session'); const rs = $('#refresh-sessions'); const h3 = $('.project-group h3');
      const chips = [...document.querySelectorAll('#session-filters .aj-filter')];
      const sb = $('#sidebar'); const list = $('#session-list'); const pop = $('#session-ws-pop');
      const row = h2 ? h2.parentElement : null;
      return {
        vw: innerWidth, vh: innerHeight,
        sb: R(sb), list: R(list), search: R(search), h3: R(h3), h2: R(h2), row: R(row), ns: R(ns), rs: R(rs), ws: R(ws), pop: R(pop),
        sbCs: sb && cs(sb).display,
        h2Text: h2 && h2.textContent.trim(), h2Cs: h2 && { fs: cs(h2).fontSize, fw: cs(h2).fontWeight, tt: cs(h2).textTransform },
        rowHasNs: !!row && row.contains(ns), rowHasRs: !!row && row.contains(rs),
        ns_: ns && { title: ns.title, aria: ns.getAttribute('aria-label'), text: ns.textContent.trim(), bg: cs(ns).backgroundColor, color: cs(ns).color, borders: sides(ns) },
        rs_: rs && { borders: sides(rs) },
        search_: search && { bg: cs(search).backgroundColor, borders: sides(search), outline: cs(search).outlineStyle },
        wsInSearch: !!search && !!ws && search.contains(ws),
        ws_: ws && { text: ws.textContent.trim(), aria: ws.getAttribute('aria-label'), title: ws.title, bg: cs(ws).backgroundColor,
          color: cs(ws).color, borders: sides(ws), expanded: ws.getAttribute('aria-expanded') },
        pop_: pop && { hidden: pop.hidden, shown: pop.getClientRects().length > 0 },
        h3_: h3 && { bg: cs(h3).backgroundColor, pos: cs(h3).position },
        chips: chips.map((c) => ({ text: c.textContent.trim(), pressed: c.getAttribute('aria-pressed'), bg: cs(c).backgroundColor,
          color: cs(c).color, borders: sides(c), outline: cs(c).outlineStyle + ' ' + cs(c).outlineWidth, top: R(c).t, r: R(c) })),
        track: (() => { const t = $('#session-filters'); if (!t) return null; const c = cs(t); return { bg: c.backgroundColor, pad: [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft], r: R(t) }; })(),
      };
    },
    clickNs() { $('#new-session').click(); },
    iconPoint() {
      const r = $('#new-session svg').getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2); const y = Math.round(r.top + r.height / 2);
      const t = document.elementFromPoint(x, y);
      return { x, y, target: t ? t.tagName.toLowerCase() : null, inBtn: !!t && $('#new-session').contains(t) };
    },
    // the start screen is already up while no pane shows, so « shown » alone proves nothing: a click counts once
    // the screen is shown AND the click moved the focus into its composer
    homeOpen() {
      const e = $('#grid-empty'); const h = $('#ns-home'); const i = $('#ns-input');
      return !!e && !e.hidden && !!h && h.getClientRects().length > 0 && !!i && document.activeElement === i;
    },
    blurHome() { const i = $('#ns-input'); if (i) i.blur(); },
    fold() { $('#sidebar-fold').click(); },
    folded() { return document.body.classList.contains('sb-mini'); },
    home() {
      const m = $('#ns-home'); if (!m || m.getClientRects().length === 0) return null; return { r: R(m) };
    },
    focusInput() { const i = $('#session-search-input'); i.focus(); return document.activeElement === i; },
    blurInput() { $('#session-search-input').blur(); },
    searchBorders() { return sides($('#session-search')); },
    point(sel, dx, dy) {
      const el = $(sel); const r = el.getBoundingClientRect();
      const x = Math.round(dx === undefined ? r.left + r.width / 2 : r.left + dx); const y = Math.round(dy === undefined ? r.top + r.height / 2 : r.top + dy);
      const t = document.elementFromPoint(x, y);
      return { x, y, target: t ? (t.id ? '#' + t.id : t.tagName.toLowerCase()) : null, inSearch: !!t && $('#session-search').contains(t), inWs: !!t && $('#session-ws').contains(t),
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], hidden: el.hidden,
        stack: document.elementsFromPoint(x, y).slice(0, 4).map((e) => (e.id ? '#' + e.id : e.tagName.toLowerCase())) };
    },
    focusInfo() { const a = document.activeElement; return { input: a === $('#session-search-input'), tag: a ? (a.id || a.tagName.toLowerCase()) : null }; },
    popOpen() { const p = $('#session-ws-pop'); return !p.hidden && p.getClientRects().length > 0; },
    wsOpen(open) { const b = $('#session-ws-filter'); if ((b.getAttribute('aria-expanded') === 'true') !== open) b.click(); },
    wsToggle(cwd) { const it = [...document.querySelectorAll('#session-ws-pop [role="menuitemcheckbox"]')].find((i) => (cwd ? i.title === cwd : !i.dataset.cwd)); if (!it) return false; it.click(); return true; },
  };
  return true;
})()`;

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const j = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) { return { __jsError: String((e && e.message) || e) }; }
  };
  const visibleBorder = (b) => b.w > 0 && b.st !== 'none' && (parseColor(b.c) || { a: 1 }).a > 0;
  try {
    // Wait for the first full render (groups + workspace items).
    await sleep(800);
    await j(INSTALL);
    for (let i = 0; i < 40 && !(await j('window.__ep.ready()')); i++) await sleep(250);
    await sleep(400);
    const s0 = await j('window.__ep.snap()');
    if (s0.__jsError) throw new Error(s0.__jsError);
    console.log(`env window=${s0.vw}x${s0.vh} sidebar=${Math.round(s0.sb.w)}px listTop=${s0.list.t} (measured this run)`);

    // a1 — the « + » sits in the title row, small, named
    const nsOk = !!s0.ns && s0.rowHasNs && s0.h2Text === 'Sessions'
      && s0.ns.t >= s0.row.t - 0.5 && s0.ns.t < s0.row.b && s0.ns.b <= s0.row.b + 0.5
      && s0.ns.w <= 32 && s0.ns_.title === 'Nouvelle session' && s0.ns_.aria === 'Nouvelle session';
    gate('a1_new_session_in_title_row', nsOk,
      `inRow=${s0.rowHasNs} h2="${s0.h2Text}" ns=${Math.round(s0.ns.w)}x${Math.round(s0.ns.h)} top=${s0.ns.t.toFixed(1)} row=${s0.row.t.toFixed(1)}..${s0.row.b.toFixed(1)} title="${s0.ns_.title}" aria="${s0.ns_.aria}"`);

    // a2 — a click shows the start screen (#ns-home), fully inside the viewport, and focuses its composer
    await j('window.__ep.blurHome()');
    const homeBefore = await j('window.__ep.homeOpen()');
    await j('window.__ep.clickNs()');
    await sleep(500);
    const menu = await j('window.__ep.home()');
    const homeOn = await j('window.__ep.homeOpen()');
    const mOk = homeBefore === false && homeOn === true && !!menu && menu.r.l >= 0 && menu.r.t >= 0 && menu.r.r <= s0.vw && menu.r.b <= s0.vh;
    gate('a2_new_session_home_opens_inside_viewport', mOk,
      menu ? `home=${Math.round(menu.r.l)},${Math.round(menu.r.t)}..${Math.round(menu.r.r)},${Math.round(menu.r.b)} viewport=${s0.vw}x${s0.vh} composerFocused before=${homeBefore} after=${homeOn}` : 'no #ns-home shown');
    await j('window.__ep.blurHome()');
    await sleep(300);

    // b1 — the workspace filter lives in the search field and carries no accent at rest
    const w = s0.ws_;
    const noAccentAtRest = !!w && !isAccentRgb(parseColor(w.bg)) && !isAccentRgb(parseColor(w.color))
      && !w.borders.some((b) => visibleBorder(b) && isAccentRgb(parseColor(b.c)));
    gate('b1_ws_filter_in_search_no_accent_at_rest', s0.wsInSearch && noAccentAtRest,
      `inSearch=${s0.wsInSearch} bg=${w && w.bg} color=${w && w.color} border=${w && w.borders[0].w}px ${w && w.borders[0].c}`);

    // b2 — popover inside the sidebar, below the search field
    await j('window.__ep.wsOpen(true)'); await sleep(300);
    const sp = await j('window.__ep.snap()');
    const pp = sp.pop;
    const popOk = !!pp && sp.pop_.shown && pp.l >= sp.sb.l - 0.5 && pp.r <= sp.sb.r + 0.5 && pp.b <= sp.sb.b + 0.5 && pp.b <= sp.vh
      && pp.t >= sp.search.b - 0.5 && pp.t - sp.search.b <= 12;
    gate('b2_popover_inside_sidebar_below_search', popOk,
      pp ? `pop=${Math.round(pp.l)}..${Math.round(pp.r)} x ${Math.round(pp.t)}..${Math.round(pp.b)} sidebar=${Math.round(sp.sb.l)}..${Math.round(sp.sb.r)} x ..${Math.round(sp.sb.b)} searchBottom=${sp.search.b.toFixed(1)}` : 'no popover');

    // b3 — two workspaces checked: the count 2 and the accent colour as a word (L18e-a: no fill)
    await j(`window.__ep.wsToggle(${JSON.stringify(cwdAlpha)})`);
    await j(`window.__ep.wsToggle(${JSON.stringify(cwdBeta)})`);
    await j('window.__ep.wsOpen(false)'); await sleep(400);
    const s2 = await j('window.__ep.snap()');
    const f = s2.ws_;
    const filteredOk = !!f && /(^|\D)2(\D|$)/.test(f.text) && f.bg === 'rgba(0, 0, 0, 0)' && isFullAccent(parseColor(f.color));
    gate('b3_two_checked_count_and_accent_word', filteredOk,
      `text="${f && f.text}" bg=${f && f.bg} color=${f && f.color}`);

    // b4 — the old visible text stays as the accessible name (aria-label and title), at 0, 2 and 1 checked
    await j('window.__ep.wsOpen(true)'); await j('window.__ep.wsToggle(null)'); await sleep(200);
    const s0b = await j('window.__ep.snap()');
    await j(`window.__ep.wsToggle(${JSON.stringify(cwdBeta)})`); await sleep(200);
    const s1 = await j('window.__ep.snap()');
    await j('window.__ep.wsToggle(null)'); await j('window.__ep.wsOpen(false)'); await sleep(200);
    const has = (st, text) => !!st.ws_ && String(st.ws_.aria).includes(text) && String(st.ws_.title).includes(text);
    gate('b4_old_text_is_the_accessible_name',
      has(s0b, 'Tous les workspaces') && has(s2, '2 workspaces') && has(s1, 'bêta-service'),
      `none: aria="${s0b.ws_.aria}" title="${s0b.ws_.title}" | two: aria="${s2.ws_.aria}" title="${s2.ws_.title}" | one: aria="${s1.ws_.aria}" title="${s1.ws_.title}"`);

    // c1 — the four chips: no visible border, no outline; the pressed one differs by fill, not by border
    const ch = s0.chips;
    const unpressed = ch.filter((c) => c.pressed !== 'true');
    const pressed = ch.filter((c) => c.pressed === 'true');
    const noBorder = ch.length === 4 && ch.every((c) => !c.borders.some(visibleBorder) && /^none|0px$/.test(c.outline));
    // (text tabs, no fill at all: the pressed tab differs by its text colour only)
    const noFill = ch.length === 4 && ch.every((c) => (parseColor(c.bg) || { a: 0 }).a === 0);
    const colourDiffers = pressed.length === 1 && unpressed.length === 3 && unpressed.every((c) => c.color === unpressed[0].color)
      && pressed[0].color !== unpressed[0].color;
    const borderSame = pressed.length === 1 && JSON.stringify(pressed[0].borders) === JSON.stringify(unpressed[0] && unpressed[0].borders);
    gate('c1_chips_text_tabs_no_border_no_fill', noBorder && noFill && colourDiffers && borderSame,
      `chips=${ch.length} borders=${ch.map((c) => c.borders.map((b) => `${b.w}${b.st}`).join('/')).join(' ; ')} bg pressed=${pressed[0] && pressed[0].bg} others=${unpressed[0] && unpressed[0].bg} colour pressed=${pressed[0] && pressed[0].color} others=${unpressed[0] && unpressed[0].color} outline=${ch[0] && ch[0].outline}`);

    // c2 — one row of text tabs: the four chips on one row, the track carries no fill
    const tk = s0.track;
    const oneRow = ch.length === 4 && ch.every((c) => near(c.top, ch[0].top, 1));
    gate('c2_chips_one_row_text_tabs', oneRow && !!tk && (parseColor(tk.bg) || { a: 0 }).a === 0,
      `oneRow=${oneRow} tops=${ch.map((c) => c.top.toFixed(0)).join(',')} trackBg=${tk && tk.bg} pad=${tk && tk.pad.join('/')}`);

    // d — the first group heading aligns on the search field's right edge, no opaque band
    const h3bg = parseColor(s0.h3_.bg);
    gate('d_group_heading_aligned_transparent', near(s0.h3.r, s0.search.r, 1) && !!h3bg && h3bg.a === 0,
      `h3.right=${s0.h3.r.toFixed(1)} search.right=${s0.search.r.toFixed(1)} h3.bg=${s0.h3_.bg} position=${s0.h3_.pos}`);

    // e — the list starts higher than on main ce23f04
    const gain = BASE_LIST_TOP === null ? null : BASE_LIST_TOP - s0.list.t;
    gate('e_list_top_gain', gain !== null && gain >= MIN_GAIN,
      `listTop=${s0.list.t} base(ce23f04)=${BASE_LIST_TOP} delta=${gain} need>=${MIN_GAIN}`);

    // f1 — the title row: « Sessions » 13 px / 500 / sentence case, 28 px icon buttons, the « + » an ink glyph on no fill (L18e-a, mockup .ib.plus)
    const nsBg = parseColor(s0.ns_.bg);
    gate('f1_title_row_style',
      s0.h2Cs.fs === '13px' && s0.h2Cs.fw === '500' && s0.h2Cs.tt === 'none'
      && s0.rowHasRs && near(s0.rs.w, 28, 0.5) && near(s0.rs.h, 28, 0.5) && near(s0.ns.w, 28, 0.5) && near(s0.ns.h, 28, 0.5)
      && s0.ns_.bg === 'rgba(0, 0, 0, 0)' && s0.ns_.color === 'rgb(230, 233, 238)' && !s0.ns_.borders.some(visibleBorder) && !s0.rs_.borders.some(visibleBorder),
      `h2=${s0.h2Cs.fs}/${s0.h2Cs.fw}/${s0.h2Cs.tt} refresh=${Math.round(s0.rs.w)}x${Math.round(s0.rs.h)} inRow=${s0.rowHasRs} ns=${Math.round(s0.ns.w)}x${Math.round(s0.ns.h)} bg=${s0.ns_.bg} color=${s0.ns_.color}`);

    // f2 — the search field: 32 px, soft fill, no border at rest, accent on focus
    await j('window.__ep.focusInput()'); await sleep(300);
    const focusB = await j('window.__ep.searchBorders()');
    await j('window.__ep.blurInput()'); await sleep(300);
    // The field is a hairline underline (no box, no fill); focus only changes the hairline colour, never to the accent.
    const sFill = parseColor(s0.search_.bg);
    const restVis = s0.search_.borders.filter(visibleBorder);
    const focusVis = focusB.filter(visibleBorder);
    const focusMoves = restVis.length === 1 && focusVis.length === 1 && restVis[0].c !== focusVis[0].c && !isAccentRgb(parseColor(focusVis[0].c));
    gate('f2_search_field_style',
      near(s0.search.h, 32, 0.5) && !!sFill && sFill.a === 0 && restVis.length === 1 && restVis[0].w === 1 && focusMoves,
      `height=${s0.search.h.toFixed(1)} bg=${s0.search_.bg} restBorder=${s0.search_.borders.map((b) => `${b.w}${b.st}`).join('/')} rest=${restVis[0] && restVis[0].c} focus=${focusVis[0] && focusVis[0].c}`);

    // h1 / h2 — a REAL mouse press on the « + » icon (not el.click()) shows the start screen and focuses its composer, in
    // the normal sidebar and in the folded rail. The event target is the icon's <line>, not the button: the press must
    // still reach the button's handler (a handler that compared the target with the button by identity would miss it).
    win.webContents.focus();
    const realClickIcon = async () => {
      await j('window.__ep.blurHome()');
      const p = await j('window.__ep.iconPoint()');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(300);
      return { p, open: await j('window.__ep.homeOpen()') };
    };
    const hn = await realClickIcon();
    gate('h1_real_click_on_icon_opens_home', hn.open === true && hn.p.inBtn === true,
      `point=${hn.p.x},${hn.p.y} target=<${hn.p.target}> insideButton=${hn.p.inBtn} homeComposerFocused300ms=${hn.open}`);
    await j('window.__ep.blurHome()'); await sleep(150);
    await j('window.__ep.fold()'); await sleep(900);
    const railOn = await j('window.__ep.folded()');
    const hr = await realClickIcon();
    gate('h2_real_click_on_icon_opens_home_folded', railOn === true && hr.open === true && hr.p.inBtn === true,
      `folded=${railOn} point=${hr.p.x},${hr.p.y} target=<${hr.p.target}> insideButton=${hr.p.inBtn} homeComposerFocused300ms=${hr.open}`);
    await j('window.__ep.blurHome()'); await sleep(150);
    await j('window.__ep.fold()'); await sleep(600);

    // i1 - i3: the field is a div (not a label, so a click in the workspace popover does not reach the input), and a REAL press
    // anywhere on it but the workspace pill and its popover focuses the input: i1 the magnifier; i2 the popover padding keeps the
    // popover open and the input unfocused; i3 the pill toggles the popover and the input stays unfocused.
    const realClickAt = async (p) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(300);
    };
    await j('window.__ep.blurInput()'); await sleep(150);
    const mp = await j(`window.__ep.point('#session-search > svg')`);
    await realClickAt(mp);
    const mf = await j('window.__ep.focusInfo()');
    const mOpen = await j('window.__ep.popOpen()');
    gate('i1_real_click_on_magnifier_focuses_input', mp.inSearch === true && mp.inWs === false && mf.input === true && mOpen === false,
      `point=${mp.x},${mp.y} target=<${mp.target}> focused=${mf.tag} popoverOpen=${mOpen}`);

    await j('window.__ep.blurInput()'); await j('window.__ep.wsOpen(true)'); await sleep(200);
    // 100 px in, 2 px down: the 4 px padding above the first item (the corner at 2,2 is outside the rounded border)
    const padPt = await j(`window.__ep.point('#session-ws-pop', 100, 2)`);
    await realClickAt(padPt);
    const pf = await j('window.__ep.focusInfo()');
    const pOpen = await j('window.__ep.popOpen()');
    gate('i2_real_click_in_popover_padding_keeps_it_open_no_focus', padPt.target === '#session-ws-pop' && pOpen === true && pf.input === false,
      `point=${padPt.x},${padPt.y} target=<${padPt.target}> box=${padPt.box} hidden=${padPt.hidden} stack=${padPt.stack} popoverOpen=${pOpen} focused=${pf.tag}`);
    await j('window.__ep.wsOpen(false)'); await sleep(150);

    await j('window.__ep.blurInput()'); await sleep(100);
    const wp = await j(`window.__ep.point('#session-ws-filter')`);
    await realClickAt(wp);
    const wf = await j('window.__ep.focusInfo()');
    const wOpen = await j('window.__ep.popOpen()');
    gate('i3_real_click_on_pill_toggles_popover_no_input_focus', wp.inWs === true && wOpen === true && wf.input === false,
      `point=${wp.x},${wp.y} target=<${wp.target}> popoverOpen=${wOpen} focused=${wf.tag}`);
    await j('window.__ep.wsOpen(false)'); await sleep(150);

    // Not a gate: EPURE_SHOT=<dir> saves headless captures of the sidebar (two workspaces filtered, then the
    // list scrolled so a heading is stuck) and prints the stuck heading's backdrop colour.
    if (process.env.EPURE_SHOT) {
      await j('window.__ep.wsOpen(true)');
      await j(`window.__ep.wsToggle(${JSON.stringify(cwdAlpha)})`); await j(`window.__ep.wsToggle(${JSON.stringify(cwdBeta)})`);
      await j('window.__ep.wsOpen(false)'); await sleep(500);
      const shot = async (name) => {
        const img = await win.webContents.capturePage({ x: 0, y: 48, width: 280, height: 440 });
        fs.writeFileSync(path.join(process.env.EPURE_SHOT, name), img.toPNG());
      };
      await shot('sidebar-top.png');
      await j(`(() => { const l = document.getElementById('session-list'); l.style.maxHeight = '150px'; l.scrollTop = 70; })()`);
      await sleep(600);
      const bd = await j(`(() => { const h = [...document.querySelectorAll('.project-group h3')].find((e) => e.getBoundingClientRect().top <= document.getElementById('session-list').getBoundingClientRect().top + 1); return h ? getComputedStyle(h, '::before').backgroundColor : null; })()`);
      console.log(`info stuck heading backdrop=${bd}`);
      await shot('sidebar-stuck.png');
    }
  } catch (e) {
    gate('probe_crashed', false, String((e && e.stack) || e));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nVERDICT: ${failed.length === 0 && results.length === 17 ? 'ALL GREEN' : 'RED'} (${results.length - failed.length}/${results.length})`);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  app.exit(failed.length === 0 ? 0 : 1);
});
setTimeout(() => { console.log('VERDICT: RED (timeout)'); app.exit(2); }, 90000).unref();
