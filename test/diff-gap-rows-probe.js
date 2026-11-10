// test/diff-gap-rows-probe.js — Step S3 probe (deck-diff-expand): mountGapRows / gapNotice of renderer/js/diff-view.js.
// Gates: harness_import · g1_info_rows_eq_hunks · g2_controls_per_gap · g3_tail_row_in_every_tbody · g4_no_tail_when_below_null ·
// g5_click_payload · g6_click_does_not_bubble · g7_idempotent · g8_notice_is_text (attack class, permanent) · g9_split_rows_aligned
// A fixture diff of FOUR hunks is rendered with the global Diff2Html.html in both formats inside the real app page, then the module
// mounts its controls from a hand-set `above` / `below` (the module does no line arithmetic: those numbers come from diff-expand.js).
// Expected labels, payloads and counts are written here from the plan's control set (R7 / C2), never read back from the DOM under test.
// Run (checkout root): the plan's xvfb probe prefix, then `node_modules/.bin/electron test/diff-gap-rows-probe.js`
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFakeGlab } = require('./_fake-glab.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gaprows-probe-'));
fs.mkdirSync(path.join(base, 'glab'));
const fake = writeFakeGlab(path.join(base, 'glab'), []);

const STARTS = [31, 80, 115, 140];
const DIFF = [
  'diff --git a/f.js b/f.js',
  '--- a/f.js',
  '+++ b/f.js',
  ...STARTS.flatMap((s) => [`@@ -${s},3 +${s},3 @@`, ` c${s}a`, `-o${s}`, `+n${s}`, ` c${s}b`]),
  '',
].join('\n');
const HUNKS = DIFF.split('\n').filter((l) => l.startsWith('@@')).length;

const UP = '↑ 20 lignes';
const DOWN = '↓ 20 lignes';
const ALL = 'Tout afficher';

// Labels per info row of the FIRST table for an `above` array (R7): >20 → ↑ ↓ all (no ↓ above the first hunk), 1-20 → all alone, 0 → none.
const expectedLabels = (above) => above.map((n, k) => (n > 20 ? (k === 0 ? [UP, ALL] : [UP, DOWN, ALL]) : n > 0 ? [ALL] : []));
// Click payloads in document order for the same arrays, then the tail. `all` above a hunk carries the gap size; the tail's « Tout afficher »
// is C1's `{hunk: H-1, dir: 'down', n: Infinity}` (sent here as the string 'Infinity', JSON has no Infinity).
const expectedPicks = (above, below) => {
  const out = [];
  above.forEach((n, k) => {
    if (n > 20) out.push({ hunk: k, dir: 'up', n: 20 });
    if (n > 20 && k > 0) out.push({ hunk: k - 1, dir: 'down', n: 20 });
    if (n > 0) out.push({ hunk: k, dir: 'all', n });
  });
  if (below > 20) out.push({ hunk: above.length - 1, dir: 'down', n: 20 });
  if (below > 0) out.push({ hunk: above.length - 1, dir: 'down', n: 'Infinity' });
  return out;
};
const expectedTail = (below) => (below > 20 ? [DOWN, ALL] : below > 0 ? [ALL] : null);

process.env.CLAUDE_DECK_BIN = '/bin/bash';
process.env.CLAUDE_DECK_GLAB_BIN = fake.bin;
process.env.CLAUDE_DECK_NO_OPEN = '1';
process.env.CLAUDE_DECK_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gaprows-projects-'));
process.env.CLAUDE_DECK_ASK_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gaprows-ask-'));
process.env.CLAUDE_DECK_STATUS_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'deck-gaprows-status-'));
require(path.join(__dirname, '..', 'main.js'));
require('electron').app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require('electron');

// Page side. __render builds the host inside a bubble-counting wrapper, __shape reads plain data, __clickAll clicks every button in
// document order and returns the payloads the callback received.
const PAGE = `(async () => {
  window.__dv = await import('./js/diff-view.js');
  window.__render = (fmt) => {
    document.getElementById('gap-wrap')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'gap-wrap';
    wrap.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:700px;overflow:auto;z-index:99999;background:#111';
    wrap.addEventListener('click', () => { window.__bubbled += 1; });
    const host = document.createElement('div');
    host.className = 'mr-diff';
    wrap.append(host);
    document.body.append(wrap);
    host.innerHTML = Diff2Html.html(${JSON.stringify(DIFF)}, { drawFileList: false, matching: 'lines', outputFormat: fmt });
    window.__host = host;
    window.__picks = [];
    window.__bubbled = 0;
    window.__docBubbled = 0;
    return { tables: host.querySelectorAll('.d2h-diff-table').length, panes: host.querySelectorAll('.d2h-file-side-diff').length };
  };
  window.__mount = (above, below) => window.__dv.mountGapRows(window.__host, { above, below },
    (p) => window.__picks.push({ hunk: p.hunk, dir: p.dir, n: p.n === Infinity ? 'Infinity' : p.n }));
  const infoRows = (t) => [...t.querySelectorAll(':scope > tbody > tr')].filter((tr) => tr.querySelector('.d2h-info'));
  window.__shape = () => [...window.__host.querySelectorAll('.d2h-diff-table')].map((t) => {
    const bodies = [...t.querySelectorAll(':scope > tbody')];
    const info = infoRows(t);
    return {
      bodies: bodies.length,
      info: info.length,
      rows: bodies.map((b) => b.children.length),
      labels: info.map((tr) => [...tr.querySelectorAll('button')].map((b) => b.textContent)),
      gapBoxes: t.querySelectorAll('.dx-gap').length,
      types: [...t.querySelectorAll('button')].map((b) => b.type),
      tails: bodies.map((b) => [...b.children].filter((tr) => tr.classList.contains('dx-gap-tail')).length),
      tailLast: bodies.map((b) => !!b.lastElementChild && b.lastElementChild.classList.contains('dx-gap-tail')),
      tailLabels: bodies.map((b) => [...b.querySelectorAll('tr.dx-gap-tail button')].map((x) => x.textContent)),
      tailInfoClass: t.querySelectorAll('tr.dx-gap-tail .d2h-info').length,
    };
  });
  window.__clickAll = () => {
    window.__picks = [];
    window.__bubbled = 0;
    const buttons = [...window.__host.querySelectorAll('button')];
    for (const b of buttons) b.click();
    return { picks: window.__picks.slice(), buttons: buttons.length, bubbled: window.__bubbled };
  };
  return typeof window.__dv === 'object' && typeof Diff2Html === 'object';
})()`;

app.whenReady().then(async () => {
  const results = {};
  const detail = {};
  const watchdog = setTimeout(() => { console.log('FAIL watchdog: probe stuck for 90s'); app.exit(2); }, 90000);
  try {
    await sleep(1500);
    const win = BrowserWindow.getAllWindows()[0];
    const j = (code) => win.webContents.executeJavaScript(code, true);
    const gate = async (name, fn) => {
      try { results[name] = !!(await fn()); } catch (e) { results[name] = false; detail[`${name}_err`] = String(e && e.message || e).slice(0, 300); }
    };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const FORMATS = ['line-by-line', 'side-by-side'];
    const render = async (fmt) => {
      const r = await j(`__render(${JSON.stringify(fmt)})`);
      return fmt === 'side-by-side' ? r.tables === 2 && r.panes === 2 : r.tables === 1 && r.panes === 0;
    };
    const mount = (above, below) => j(`__mount(${JSON.stringify(above)}, ${JSON.stringify(below)}), true`);
    const shape = () => j('__shape()');
    const A1 = [30, 25, 7, 0];
    const A2 = [20, 21, 1, 0];

    await gate('harness_import', async () => (await j(PAGE)) === true);
    detail.exports = await j('Object.keys(__dv).filter((k) => /gap/i.test(k))').catch(() => 'no-module');

    // H5: diff2html emits one .d2h-info row per hunk in every table, and the mount neither adds nor removes one.
    await gate('g1_info_rows_eq_hunks', async () => {
      for (const fmt of FORMATS) {
        if (!(await render(fmt))) return false;
        const before = await shape();
        detail[`g1_row_${fmt}`] = await j(`__host.querySelector('tr:has(.d2h-info)').outerHTML.slice(0, 400)`);
        if (!before.every((t) => t.info === HUNKS)) return false;
        await mount(A1, 50);
        const after = await shape();
        detail[`g1_${fmt}`] = after.map((t) => t.info);
        if (!after.every((t) => t.info === HUNKS && t.tailInfoClass === 0)) return false;
      }
      return true;
    });

    await gate('g2_controls_per_gap', async () => {
      for (const fmt of FORMATS) {
        for (const above of [A1, A2]) {
          if (!(await render(fmt))) return false;
          await mount(above, null);
          const s = await shape();
          const want = expectedLabels(above);
          detail[`g2_${fmt}_${above.join('-')}`] = s[0].labels;
          if (!eq(s[0].labels, want)) return false;
          if (s[0].gapBoxes !== want.filter((l) => l.length).length) return false;
          if (!s[0].types.every((t) => t === 'button')) return false;
          // split view: the controls live in the first table only
          for (const t of s.slice(1)) if (t.labels.some((l) => l.length) || t.gapBoxes !== 0) return false;
        }
      }
      return true;
    });

    await gate('g3_tail_row_in_every_tbody', async () => {
      for (const fmt of FORMATS) {
        for (const below of [50, 21, 20, 5]) {
          if (!(await render(fmt))) return false;
          const before = await shape();
          await mount(A1, below);
          const s = await shape();
          detail[`g3_${fmt}_${below}`] = s.map((t) => ({ tails: t.tails, labels: t.tailLabels }));
          for (let i = 0; i < s.length; i += 1) {
            if (!s[i].tails.every((n) => n === 1) || !s[i].tailLast.every(Boolean)) return false;
            if (!eq(s[i].rows, before[i].rows.map((n) => n + 1))) return false;
            // controls only in the FIRST tbody of the FIRST table
            const want = i === 0 ? [expectedTail(below), ...s[i].tailLabels.slice(1).map(() => null)] : s[i].tailLabels.map(() => null);
            const got = s[i].tailLabels.map((l) => (l.length ? l : null));
            if (!eq(got, want)) return false;
          }
        }
      }
      return true;
    });

    await gate('g4_no_tail_when_below_null', async () => {
      for (const fmt of FORMATS) {
        for (const below of [null, 0]) {
          if (!(await render(fmt))) return false;
          const before = await shape();
          await mount(A1, below);
          const s = await shape();
          if (!s.every((t, i) => t.tails.every((n) => n === 0) && eq(t.rows, before[i].rows))) return false;
        }
        // a tail mounted earlier goes when a later mount says `below` is unknown
        if (!(await render(fmt))) return false;
        await mount(A1, 50);
        await mount(A1, null);
        if (!(await shape()).every((t) => t.tails.every((n) => n === 0))) return false;
      }
      return true;
    });

    await gate('g5_click_payload', async () => {
      for (const fmt of FORMATS) {
        for (const [above, below] of [[A1, 50], [A2, 21], [A1, 7], [A1, null]]) {
          if (!(await render(fmt))) return false;
          await mount(above, below);
          const r = await j('__clickAll()');
          const want = expectedPicks(above, below);
          detail[`g5_${fmt}_${above.join('-')}_${below}`] = r.picks;
          if (r.buttons !== want.length || !eq(r.picks, want)) return false;
        }
      }
      return true;
    });

    await gate('g6_click_does_not_bubble', async () => {
      for (const fmt of FORMATS) {
        if (!(await render(fmt))) return false;
        await mount(A1, 50);
        const r = await j('__clickAll()');
        if (r.buttons < 5 || r.bubbled !== 0) return false;
        // the listener works: a click on a hunk header, outside any control, does reach the ancestor
        const header = await j(`(() => { window.__bubbled = 0; window.__host.querySelector('.d2h-info').click(); return window.__bubbled; })()`);
        if (header !== 1) return false;
      }
      return true;
    });

    await gate('g7_idempotent', async () => {
      for (const fmt of FORMATS) {
        if (!(await render(fmt))) return false;
        await mount(A1, 50);
        const once = await j('__host.innerHTML');
        await mount(A1, 50);
        await mount(A1, 50);
        if ((await j('__host.innerHTML')) !== once) return false;
        // a different mount replaces the first, never stacks on it
        await mount(A2, 5);
        const s = await shape();
        // 3 header strips (A2 has three non-empty gaps) + the strip of the tail row
        if (!eq(s[0].labels, expectedLabels(A2)) || s[0].gapBoxes !== 4 || !s.every((t) => t.tails.every((n) => n === 1))) return false;
        const picks = await j('__clickAll()');
        if (!eq(picks.picks, expectedPicks(A2, 5))) return false;
      }
      return true;
    });

    await gate('g8_notice_is_text', async () => {
      const hostile = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
      for (const fmt of FORMATS) {
        if (!(await render(fmt))) return false;
        await mount(A1, 50);
        await j(`window.__xss = undefined; __dv.gapNotice(__host, ${JSON.stringify(hostile)}), true`);
        await sleep(50);
        const r = await j(`(() => {
          const n = __host.querySelector('.dx-gap-notice');
          return { has: !!n, text: n ? n.textContent : null, kids: n ? n.children.length : -1, notices: __host.querySelectorAll('.dx-gap-notice').length,
            img: __host.querySelectorAll('img').length, script: __host.querySelectorAll('script').length, xss: window.__xss === undefined };
        })()`);
        detail[`g8_${fmt}`] = r;
        if (!r.has || r.text !== hostile || r.kids !== 0 || r.notices !== 1 || r.img !== 0 || r.script !== 0 || !r.xss) return false;
        // a second call replaces the text, an empty one removes the line
        await j(`__dv.gapNotice(__host, 'Fichier modifié depuis le diff'), true`);
        const second = await j(`[...__host.querySelectorAll('.dx-gap-notice')].map((n) => n.textContent)`);
        if (!eq(second, ['Fichier modifié depuis le diff'])) return false;
        await j(`__dv.gapNotice(__host, ''), true`);
        if ((await j(`__host.querySelectorAll('.dx-gap-notice').length`)) !== 0) return false;
      }
      return true;
    });

    await gate('g9_split_rows_aligned', async () => {
      if (!(await render('side-by-side'))) return false;
      await mount(A1, 50);
      await j('__dv.syncSplitRows(__host), true');
      const s = await shape();
      detail.g9_rows = s.map((t) => t.rows);
      if (s.length !== 2 || s[0].rows.length !== 1 || !eq(s[0].rows, s[1].rows)) return false;
      const heights = await j(`(() => {
        const [a, b] = [...__host.querySelectorAll('.d2h-diff-table')].map((t) => [...t.querySelectorAll(':scope > tbody > tr')]);
        return a.map((tr, i) => [tr.getBoundingClientRect().height, b[i].getBoundingClientRect().height]);
      })()`);
      detail.g9_heights = heights.length;
      return heights.length === s[0].rows[0] && heights.every(([x, y]) => Math.abs(x - y) < 0.5);
    });
    // Not a gate: GAP_SHOT=<path prefix> saves one screenshot per format for a visual check of the controls.
    if (process.env.GAP_SHOT) {
      for (const fmt of FORMATS) {
        await render(fmt);
        await mount(A1, 50);
        await sleep(200);
        const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 360 });
        fs.writeFileSync(`${process.env.GAP_SHOT}-${fmt}.png`, img.toPNG());
      }
    }
  } catch (e) {
    console.log('FAIL probe error: ' + (e && e.stack || e));
  }
  clearTimeout(watchdog);
  const names = ['harness_import', 'g1_info_rows_eq_hunks', 'g2_controls_per_gap', 'g3_tail_row_in_every_tbody', 'g4_no_tail_when_below_null',
    'g5_click_payload', 'g6_click_does_not_bubble', 'g7_idempotent', 'g8_notice_is_text', 'g9_split_rows_aligned'];
  for (const n of names) console.log(`${results[n] ? 'PASS' : 'FAIL'} ${n}`);
  console.log('DETAIL ' + JSON.stringify(detail));
  const ok = names.filter((n) => results[n]).length;
  console.log(ok === names.length ? `VERDICT: ALL GREEN (${ok}/${names.length})` : `VERDICT: NOT GREEN (${ok}/${names.length})`);
  app.exit(ok === names.length ? 0 : 1);
});
