// v35 P5 — hybrid merge E2E probe: estimated -> official -> anchored (+stale 7d)
// driven through the REAL pipeline (deck-usage.json watcher + estimator),
// asserted on BOTH the main seam (__deckUsageLast) and the renderer DOM
// (dataset.source, badge, tooltip). Mode 'none': empty HOME -> both gauges "—".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = process.argv[2] || 'scenario';
const DECK = path.join(__dirname, '..');
const H = fs.mkdtempSync(path.join(os.tmpdir(), `deck-merge-${MODE}-`));
process.env.HOME = H;
process.env.CLAUDE_DECK_BIN = '/bin/bash'; // no real claude, no FORCE_INJECT
fs.mkdirSync(path.join(H, '.claude'), { recursive: true });

const NOW = Date.now();
const HOUR = 3600 * 1000;

if (MODE === 'scenario') {
  // transcripts: 3 completed blocks (p90 scale) + an active one (NOW-10/-5 min)
  const proj = path.join(H, '.claude', 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  const line = (tsMs, tok, n) => JSON.stringify({
    timestamp: new Date(tsMs).toISOString(), requestId: `r${n}`,
    message: { id: `m${n}`, usage: { input_tokens: tok, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + '\n';
  const A = NOW - 40 * HOUR;
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    line(A, 3000, 1) + line(A + 6 * HOUR, 4000, 2) + line(A + 12 * HOUR, 8000, 3)
    + line(NOW - 10 * 60000, 500, 4) + line(NOW - 5 * 60000, 100, 5));
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'deck-merge-ud-')));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ [${MODE}] ${m}`); };
const ko = (m) => { fail++; console.log(`  ✗ [${MODE}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require(path.join(DECK, 'main.js'));

async function gaugeState(win, id) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('${id}');
    return { source: el.dataset.source, pct: el.querySelector('.g-pct').textContent,
             badge: el.querySelector('.g-src') ? el.querySelector('.g-src').textContent : null,
             title: el.title };
  })()`, true);
}

app.whenReady().then(async () => {
  await sleep(1500); // window + estimator cold pass + initial push
  const win = BrowserWindow.getAllWindows()[0];
  const usageFile = path.join(H, '.claude', 'deck-usage.json');
  const nowSec = Math.floor(Date.now() / 1000);

  if (MODE === 'none') {
    const u = global.__deckUsageLast;
    (!u || (u.five_hour === null && u.seven_day === null)) ? ok('payload: both windows null') : ko(`payload: ${JSON.stringify(u)}`);
    const g5 = await gaugeState(win, 'gauge-5h');
    g5.source === 'none' && g5.pct === '—' && g5.badge === '' ? ok(`gauge-5h "—" source=none`) : ko(`gauge-5h: ${JSON.stringify(g5)}`);
    const g7 = await gaugeState(win, 'gauge-7d');
    g7.source === 'none' && g7.pct === '—' ? ok('gauge-7d "—" source=none') : ko(`gauge-7d: ${JSON.stringify(g7)}`);
  } else {
    // --- state c: no official -> estimated (5h), none (7d) ---
    let u = global.__deckUsageLast;
    u && u.five_hour && u.five_hour.source === 'estimated'
      ? ok(`state c: 5h estimated (${u.five_hour.used_percentage.toFixed(1)}% of p90)`) : ko(`state c 5h: ${JSON.stringify(u && u.five_hour)}`);
    u && u.seven_day === null ? ok('state c: 7d withheld (null)') : ko(`state c 7d: ${JSON.stringify(u && u.seven_day)}`);
    let g5 = await gaugeState(win, 'gauge-5h');
    g5.source === 'estimated' && g5.badge === '~' && g5.title.includes('estimation')
      ? ok(`state c UI: badge ~ tooltip estimation`) : ko(`state c UI: ${JSON.stringify(g5)}`);

    // --- state a: fresh official -> official x2 ---
    // (transcript activity is OLDER than updated_at -> no activitySince)
    fs.writeFileSync(usageFile, JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: nowSec + 3600 },
      seven_day: { used_percentage: 34, resets_at: nowSec + 200000 },
      updated_at: nowSec,
    }));
    await sleep(500); // watcher debounce 100ms + margin
    u = global.__deckUsageLast;
    u.five_hour.source === 'official' && u.five_hour.used_percentage === 42
      ? ok('state a: 5h official 42%') : ko(`state a 5h: ${JSON.stringify(u.five_hour)}`);
    u.seven_day.source === 'official' && u.seven_day.used_percentage === 34
      ? ok('state a: 7d official 34%') : ko(`state a 7d: ${JSON.stringify(u.seven_day)}`);
    g5 = await gaugeState(win, 'gauge-5h');
    g5.source === 'official' && g5.badge === '✓' && g5.pct === '42'
      ? ok('state a UI: ✓ 42') : ko(`state a UI: ${JSON.stringify(g5)}`);

    // --- state b: official 10min old + local activity after -> anchored/stale ---
    fs.writeFileSync(usageFile, JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: nowSec + 3600 },
      seven_day: { used_percentage: 34, resets_at: nowSec + 200000 },
      updated_at: nowSec - 600,
    }));
    await sleep(500);
    u = global.__deckUsageLast;
    // delta: events at NOW-10min(500tok)+NOW-5min(100tok) > updated_at(-10min)... -10min event NOT > -600s+120s epsilon
    // -> only the -5min event (100 tok) and any boundary effects; p90=8000 -> +1.25%..+7.5%
    u.five_hour.source === 'anchored' && u.five_hour.used_percentage > 42 && u.five_hour.used_percentage < 50.1
      ? ok(`state b: 5h anchored ${u.five_hour.used_percentage.toFixed(2)}% (> official 42)`) : ko(`state b 5h: ${JSON.stringify(u.five_hour)}`);
    u.seven_day.source === 'stale' ? ok('state b: 7d stale (figure kept, flagged)') : ko(`state b 7d: ${JSON.stringify(u.seven_day)}`);
    g5 = await gaugeState(win, 'gauge-5h');
    const g7 = await gaugeState(win, 'gauge-7d');
    g5.source === 'anchored' && g5.badge === '~' && g5.title.includes('officiel + activité locale')
      ? ok('state b UI 5h: ~ anchored tooltip') : ko(`state b UI 5h: ${JSON.stringify(g5)}`);
    g7.source === 'stale' && g7.badge === '~' && g7.title.includes('collecte')
      ? ok('state b UI 7d: ~ stale tooltip + age') : ko(`state b UI 7d: ${JSON.stringify(g7)}`);

    // --- state e: official window EXPIRED (reset crossing) -> the anchored
    // branch must NOT fire (guard nowSec < resets_at): falls to estimated.
    // Executed refutation of attack #2 (unbounded tokensSince on stale A).
    fs.writeFileSync(usageFile, JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: nowSec - 60 },
      seven_day: { used_percentage: 34, resets_at: nowSec - 60 },
      updated_at: nowSec - 600,
    }));
    await sleep(500);
    u = global.__deckUsageLast;
    u.five_hour.source === 'estimated'
      ? ok(`state e: reset crossing -> estimated (${u.five_hour.used_percentage.toFixed(1)}%), NOT anchored`) : ko(`state e 5h: ${JSON.stringify(u.five_hour)}`);
    u.seven_day === null ? ok('state e: expired 7d official withheld') : ko(`state e 7d: ${JSON.stringify(u.seven_day)}`);
  }

  console.log('---');
  console.log(`[${MODE}] PASS=${pass} FAIL=${fail}`);
  console.log(fail === 0 ? `P5[${MODE}] VERDICT: GREEN` : `P5[${MODE}] VERDICT: RED`);
  app.exit(fail === 0 ? 0 : 1);
});
