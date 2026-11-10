// test/sidebar-style-probe.js — E2E probe: v48 sidebar visual refresh.
// Asserts the modern/clean pass WITHOUT regressing the structural invariants
// the card-icons probe owns (equal card height = c7). Full HOME isolation
// (incident rule 2026-06-04): HOME faked BEFORE main.js, userData on mkdtemp,
// statuses driven by REAL ~/.claude/deck-status files (no seam additions).
// Gates:
//   g1  every .session-row mirrors its badge status onto the row (rail key)
//   g2  project heading carries a .pg-count == number of rows in the group
//   g3  a working row paints the status rail (inset box-shadow, not 'none')
//   g4  a closed row paints NO rail (box-shadow 'none') — closed recedes
//   g5  project heading is position:sticky
//   g6  working dot breathes (::before animation `breathe`, no ::after) — unless reduced-motion
//   g14 compacting row breathes like a working one; g15 no « Légende des statuts » block
//   g7  the chunky status pill is gone (badge background transparent)
//   g8  INVARIANT c7: all rows keep an identical height across statuses
// Run: cd claude-deck && npx electron test/sidebar-style-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sbstyle-home-'));
process.env.HOME = FAKE_HOME;
const WS = path.join(FAKE_HOME, 'Documents', 'workspace');
fs.mkdirSync(WS, { recursive: true });
const PROJ_DIR = path.join(FAKE_HOME, '.claude', 'projects', WS.replace(/\//g, '-'));
fs.mkdirSync(PROJ_DIR, { recursive: true });
const STATUS_DIR = path.join(FAKE_HOME, '.claude', 'deck-status');
fs.mkdirSync(STATUS_DIR, { recursive: true });

process.env.CLAUDE_DECK_BIN = '/bin/bash';      // never the real claude
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_AI_URL = 'about:blank';

// Three sessions, SAME cwd -> one project group (so .pg-count must read 3).
const S_WORK = '11111111-1111-4111-8111-111111111111';
const S_IDLE = '22222222-2222-4222-8222-222222222222';
const S_CLOSED = '33333333-3333-4333-8333-333333333333';
const S_COMPACT = '44444444-4444-4444-8444-444444444444';
const mkSession = (sid) => fs.writeFileSync(path.join(PROJ_DIR, `${sid}.jsonl`),
  JSON.stringify({ type: 'user', cwd: WS, gitBranch: '',
    message: { role: 'user', content: `probe ${sid}` } }) + '\n');
const setStatus = (sid, status) => fs.writeFileSync(path.join(STATUS_DIR, `${sid}.json`),
  JSON.stringify({ status, event: 'probe', ts: '2026-06-05T00:00:00Z' }) + '\n');

mkSession(S_WORK); setStatus(S_WORK, 'working');
mkSession(S_IDLE); setStatus(S_IDLE, 'idle');
mkSession(S_CLOSED); // NO status file -> renders 'closed'
mkSession(S_COMPACT); setStatus(S_COMPACT, 'compacting'); // v58: native compaction — must NOT fall back to the 'closed' badge

require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sbstyle-ud-')));

const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const results = {};
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const j = (code) => win.webContents.executeJavaScript(code, true);

    const snapshot = `(() => {
      const rows = {};
      for (const row of document.querySelectorAll('.session-row')) {
        const badge = row.querySelector('.status-badge');
        const emoji = row.querySelector('.status-emoji');
        const cs = getComputedStyle(row);
        rows[row.dataset.sessionId] = {
          rowStatus: row.dataset.status,
          badgeStatus: badge ? badge.dataset.status : null,
          boxShadow: cs.boxShadow,
          height: Math.round(row.getBoundingClientRect().height),
          emojiAnim: emoji ? getComputedStyle(emoji).animationName : null,
          emojiBg: emoji ? getComputedStyle(emoji).backgroundColor : null,
          ringAnim: emoji ? getComputedStyle(emoji, '::after').animationName : null,
          ringContent: emoji ? getComputedStyle(emoji, '::after').content : null,
          beforeAnim: emoji ? getComputedStyle(emoji, '::before').animationName : null,
          beforeContent: emoji ? getComputedStyle(emoji, '::before').content : null,
          coreBg: emoji ? getComputedStyle(emoji, '::after').backgroundColor : null,
          badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
        };
      }
      const h3 = document.querySelector('.project-group h3');
      const list = document.getElementById('session-list');
      let hoverRowZ = null;
      for (const ss of document.styleSheets) {
        let rs; try { rs = ss.cssRules; } catch (_) { continue; }
        for (const r of rs) {
          if (r.selectorText && r.selectorText.includes('.session-row:hover')) {
            hoverRowZ = r.style.zIndex; break;
          }
        }
        if (hoverRowZ !== null) break;
      }
      return {
        rows,
        rowCount: document.querySelectorAll('.session-row').length,
        pgCount: h3 ? (h3.querySelector('.pg-count') || {}).textContent : null,
        h3Pos: h3 ? getComputedStyle(h3).position : null,
        h3ZIndex: h3 ? getComputedStyle(h3).zIndex : null,
        hoverRowZ,
        listScrollbarWidth: list ? getComputedStyle(list).getPropertyValue('scrollbar-width') : null,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    })()`;

    // Poll: statuses are seeded pre-boot, but the watcher/scan settles async.
    let snap = {};
    for (let i = 0; i < 30; i++) {
      snap = await j(snapshot);
      const w = snap.rows[S_WORK];
      if (snap.rowCount === 3 && w && w.rowStatus === 'working') break;
      await sleep(200);
    }
    results.diag = snap;

    const g = (id) => snap.rows[id] || {};
    const work = g(S_WORK), idle = g(S_IDLE), closed = g(S_CLOSED);

    results.g1_row_mirrors_badge = [S_WORK, S_IDLE, S_CLOSED, S_COMPACT].every((id) => {
      const r = g(id);
      return r.rowStatus && r.rowStatus === r.badgeStatus;
    });
    results.g2_pg_count = snap.pgCount === '4';
    // g3 (Halo indicator): a working row is a lit sage pearl (--s-run fills the dot itself) whose glow is the ::before,
    // with no ::after ring (that is the waiting ripple); an idle row is the still slate pearl (--s-idle) with neither pseudo.
    results.g3_working_rail = work.emojiBg === 'rgb(134, 181, 162)' && work.beforeContent === '""' && work.ringContent !== '""'
      && idle.emojiBg === 'rgb(127, 152, 181)' && idle.ringContent !== '""' && idle.beforeContent !== '""';
    results.g4_closed_no_rail = closed.boxShadow === 'none';
    results.g5_heading_sticky = snap.h3Pos === 'sticky';
    // g6 — the working glow (dot ::before) animates breathe and there is no ::after ring; or both are correctly
    // suppressed under reduced-motion.
    results.g6_working_pulse = snap.reduced
      ? work.beforeAnim === 'none' && work.ringAnim === 'none'
      : work.beforeAnim === 'breathe' && work.ringAnim === 'none';
    // ...and a static state must NEVER breathe, pulse or ring, reduced-motion or not.
    results.g6b_static_no_pulse = (idle.emojiAnim === 'none')
      && (closed.emojiAnim === 'none')
      && (idle.ringAnim === 'none') && (closed.ringAnim === 'none')
      && (idle.beforeAnim === 'none') && (closed.beforeAnim === 'none');
    // g14 — a compacting row shows the same halo as a working one (data-status mapping, rule 7: no false state).
    const compact = g(S_COMPACT);
    results.g14_compacting_orbit = snap.reduced
      ? compact.beforeAnim === 'none'
      : compact.beforeAnim === 'breathe' && compact.emojiBg === 'rgb(134, 181, 162)';
    // g15 — the « Légende des statuts » block is gone (no successor).
    results.g15_no_legend = await j(`!document.getElementById('status-legend') && !document.querySelector('#sidebar .lg-dot')`);
    results.g7_no_pill = work.badgeBg === 'rgba(0, 0, 0, 0)'
      && idle.badgeBg === 'rgba(0, 0, 0, 0)';
    const heights = [work.height, idle.height, closed.height];
    results.g8_equal_height = heights.every((h) => h > 0 && h === heights[0]);
    results.diag_heights = heights;
    // g10 — menu/header layering (attack #4): the sticky header sits at z:2 and
    // a hovered row lifts to z:3 (a CSS contract, as before). B20: the row has no
    // « ⋮ » button any more, so the menu is reached by a real `contextmenu` event on
    // a row: it must open with its four items, and no `.row-menu` may exist.
    const ctxMenu = await j(`(() => {
      const row = document.querySelector('.session-row');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      const menu = document.getElementById('ctx-menu');
      const items = menu ? [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim()) : [];
      if (menu) menu.remove();
      return { open: !!menu, items, rowMenus: document.querySelectorAll('.row-menu').length };
    })()`);
    results.diag_ctx = ctxMenu;
    results.g10_menu_layering = snap.h3ZIndex === '2' && snap.hoverRowZ === '3'
      && ctxMenu.open && ctxMenu.rowMenus === 0
      && JSON.stringify(ctxMenu.items) === JSON.stringify(["Copier l'ID de session", 'Renommer', 'Supprimer']);
    // g11 — the thin auto-hiding scrollbar is driven by the STANDARD property
    // that actually renders in modern Chromium (Electron 42 = Chrome 148) (attack #2: the ::-webkit-* block
    // would be dead code, now removed). scrollbar-width:thin must be in effect.
    results.g11_native_scrollbar = snap.listScrollbarWidth === 'thin';
    // v58: a native (Claude-decided) 'compacting' status must render its OWN badge,
    // not fall back to 'closed' (dead). Regression introduced by widening VALID_STATUSES.
    results.g12_compacting_badge = !!snap.rows[S_COMPACT]
      && snap.rows[S_COMPACT].badgeStatus === 'compacting'
      && snap.rows[S_COMPACT].rowStatus === 'compacting';

    // g13 — Amendment 23: the idle session's status word reads « au repos » (was « à toi »).
    const idleLabel = await j(`(() => {
      const row = document.querySelector('.session-row[data-session-id="${S_IDLE}"]');
      const el = row && row.querySelector('.status-label');
      return { status: row ? row.dataset.status : null, text: el ? el.textContent : null };
    })()`);
    results.diag_idle_label = idleLabel;
    results.g13_idle_label_au_repos = idleLabel.status === 'idle' && idleLabel.text === 'au repos';

    // g9 — in-place delete keeps the .pg-count chip in sync (review nit fix):
    // drive the REAL delete flow (ctx menu -> delete -> confirm modal), then
    // assert the surviving group's count drops to 2 without a full rebuild.
    await j(`(() => {
      const row = document.querySelector('.session-row[data-session-id="${S_CLOSED}"]');
      openCtxMenu(10, 10, row);
      document.querySelector('#ctx-menu [data-action="delete"]').click();
      return true;
    })()`);
    await sleep(120);
    await j(`document.querySelector('#modal-overlay .modal-confirm').click(); true`);
    let after = {};
    for (let i = 0; i < 25; i++) {
      after = await j(`(() => {
        const h3 = document.querySelector('.project-group h3');
        return {
          gone: !document.querySelector('.session-row[data-session-id="${S_CLOSED}"]'),
          rowCount: document.querySelectorAll('.session-row').length,
          pgCount: h3 ? (h3.querySelector('.pg-count') || {}).textContent : null,
        };
      })()`);
      if (after.gone && after.rowCount === 3) break; // v58: 4 sessions now -> 3 after delete
      await sleep(120);
    }
    results.diag_after_delete = after;
    results.g9_count_synced_after_delete = after.gone === true
      && after.rowCount === 3 && after.pgCount === '3'; // v58: 4 sessions -> 3 after delete
  } catch (e) {
    results.fatal = String((e && e.stack) || e);
  }
  const gates = Object.entries(results).filter(([k]) => /^g\d/.test(k));
  const failed = gates.filter(([, v]) => v !== true);
  console.log('\n=== sidebar-style-probe ===');
  for (const [k, v] of gates) console.log(`${v === true ? 'PASS' : 'FAIL'}  ${k}`);
  if (failed.length || results.fatal) {
    console.log('\n--- diagnostics ---');
    console.log(JSON.stringify(results, null, 2));
  }
  console.log(`VERDICT: ${failed.length === 0 && !results.fatal ? 'ALL GREEN' : 'RED'} (${gates.length - failed.length}/${gates.length})`);
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length === 0 && !results.fatal ? 0 : 1);
});
