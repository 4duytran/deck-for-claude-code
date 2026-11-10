// claude-deck — ipc/usage: quotas (5h/7j) — read ~/.claude/deck-usage.json,
// watch for updates, merge with the transcript estimator.
//
// v35 hybrid quotas — source A (official, deck-usage.json) + source B (the
// transcript estimator) merged per window, with the source exposed so the UI
// labels what it shows:
//   official   A fresh (no local activity after its updated_at)
//   anchored   A + tokens-since-updated_at scaled by the P90 limit (5h only)
//   stale      A's figure kept, local activity happened since (7d — no
//              defensible local scale exists for the weekly window)
//   estimated  no usable A -> Usage-Monitor-style block reconstruction (5h)
//   (null)     nothing defensible -> the gauge renders "—"
//   {none:true} 5h only: plan 'ultra' and no current official window (no 5-hour limit)
// The estimated/anchored scale is the user's OWN P90, not the real server
// limit. Measured drift on this rig: a continuous-use UM block sat at 94%
// while the server window said 0% — block boundaries don't track server
// window anchoring (which is NOT hour-aligned: observed resets_at 16:50Z).
// Hence the strict precedence: A wins whenever it speaks for the present.
'use strict';

const { app, ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PROJECTS_ROOT, USAGE_FILE } = require('../config');
const { send } = require('../window');
const { UsageEstimator } = require('../usage-estimator');
const { buildReport } = require('../usage-report');
const { priceInfo } = require('../usage-prices');

// Defensive shape check: absent/malformed file or fields -> null, never throw.
function sanitizeUsageWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  const rst = Number(w.resets_at);
  if (!Number.isFinite(pct)) return null;
  // Known Claude Code bug (gh#52326): used_percentage can briefly be an epoch
  // timestamp at session start. Clamping that to 100% would show a false red
  // alert — treat wildly out-of-range values as no-data instead.
  if (pct < 0 || pct > 150) return null;
  return {
    used_percentage: Math.min(100, Math.max(0, pct)),
    resets_at: Number.isFinite(rst) ? rst : null, // epoch seconds (verified format)
  };
}

async function readUsage() {
  try {
    const parsed = JSON.parse(await fsp.readFile(USAGE_FILE, 'utf8'));
    const fiveHour = sanitizeUsageWindow(parsed.five_hour);
    const sevenDay = sanitizeUsageWindow(parsed.seven_day);
    if (!fiveHour && !sevenDay) return null;
    const upd = Number(parsed.updated_at);
    return {
      five_hour: fiveHour,
      seven_day: sevenDay,
      updated_at: Number.isFinite(upd) ? upd : null,
    };
  } catch (_) {
    return null; // absent or malformed -> header renders "—", never crashes
  }
}

const { SYNC_BUDGET_BYTES } = require('../usage-estimator');
// Main-thread guard (keys pass through main): a sync scan() consumes at most SYNC_BUDGET_BYTES of
// unread transcript, so a newly seen big file (a `claude --resume` fork copying a 190 MB history)
// is ingested in 1 MB async slices instead of one ~250 ms stall. Until it settles the previous
// estimate is served; onDrain then pushes the new payload at once (no wait for the 60 s tick).
const estimator = new UsageEstimator(PROJECTS_ROOT, {
  syncBudgetBytes: SYNC_BUDGET_BYTES,
  onDrain: () => { pushUsage().catch(() => { /* gauges keep the last payload */ }); },
});
const USAGE_EPSILON_MS = 120 * 1000; // statusline export latency tolerance
let estimatorReady = false; // cold-boot pass done (startEstimatorColdPass below)
let lastUsagePayloadJson = null;

const PLAN_IDS = ['pro', 'max', 'ultra'];
let planCache; // undefined until the first read: probes set userData after require time
const planFile = () => path.join(app.getPath('userData'), 'deck-usage-plan');

function currentPlan() {
  if (planCache === undefined) {
    try {
      const id = fs.readFileSync(planFile(), 'utf8').trim();
      planCache = PLAN_IDS.includes(id) ? id : null;
    } catch (_) {
      planCache = null;
    }
  }
  return planCache;
}

function savePlan(plan) {
  const file = planFile();
  if (plan === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(`${file}.tmp`, plan);
  fs.renameSync(`${file}.tmp`, file);
}

function mergeUsage(official, est, nowMs, plan = null) {
  const nowSec = nowMs / 1000;
  const upd = official && official.updated_at ? official.updated_at : null;
  const activitySince = upd !== null && est.lastActivityMs !== null
    && est.lastActivityMs > upd * 1000 + USAGE_EPSILON_MS;
  const ageS = upd !== null ? Math.max(0, Math.round(nowSec - upd)) : null;

  // --- five hour ---
  let fiveHour = null;
  const off5 = official && official.five_hour;
  if (off5 && (!off5.resets_at || nowSec < off5.resets_at)) {
    if (!activitySince) {
      fiveHour = Object.assign({}, off5, { source: 'official' });
    } else if (est.p90) {
      const deltaPct = (est.tokensSince(upd * 1000) / est.p90) * 100;
      fiveHour = {
        used_percentage: Math.min(100, off5.used_percentage + deltaPct),
        resets_at: off5.resets_at,
        source: 'anchored',
        official_age_s: ageS,
      };
    } else {
      // local activity but no scale to project it -> keep the official
      // figure and flag the staleness instead of inventing a delta
      fiveHour = Object.assign({}, off5, { source: 'stale', official_age_s: ageS });
    }
  } else if (plan === 'ultra') {
    fiveHour = { none: true };
  } else if (est.p90) {
    // no current official window -> Usage-Monitor-style reconstruction
    fiveHour = est.active
      ? {
          used_percentage: Math.min(100, (est.active.tokens / est.p90) * 100),
          resets_at: Math.floor(est.active.endMs / 1000),
          source: 'estimated',
        }
      : { used_percentage: 0, resets_at: null, source: 'estimated' };
  }

  // --- seven day --- (official or nothing — see header comment)
  let sevenDay = null;
  const off7 = official && official.seven_day;
  if (off7 && (!off7.resets_at || nowSec < off7.resets_at)) {
    sevenDay = activitySince
      ? Object.assign({}, off7, { source: 'stale', official_age_s: ageS })
      : Object.assign({}, off7, { source: 'official' });
  }

  const merged = { five_hour: fiveHour, seven_day: sevenDay, updated_at: upd };
  if (plan) merged.plan = plan; // last key, absent for « Non défini »: that payload stays byte-identical
  return merged;
}

async function buildUsagePayload() {
  // estimator joins only after its chunked cold pass — before that the
  // payload is A-only (the UI upgrades when B lands, never blocks on it)
  let est = { p90: null, active: null, lastActivityMs: null, tokensSince: () => 0 };
  if (estimatorReady) {
    try {
      estimator.scan(); // incremental: stats only unless a file moved
      est = estimator.compute();
    } catch (_) { /* estimator must never break the gauges */ }
  }
  return mergeUsage(await readUsage(), est, Date.now(), currentPlan());
}

async function pushUsage() {
  const payload = await buildUsagePayload();
  global.__deckUsageLast = payload; // probe seam
  const json = JSON.stringify(payload);
  if (json === lastUsagePayloadJson) return; // renderer churn guard
  lastUsagePayloadJson = json;
  send('usage-update', payload);
}

let usageTimer = null;
function startUsageWatcher() {
  try {
    // Watch the PARENT dir, not the file: the statusline replaces the file via
    // tmp+mv (atomic rename). Per Node docs, fs.watch on the file "continues
    // to monitor the original inode, not the new one" — i.e. it goes silent
    // for updates at that path after the first swap. A non-recursive dir watch
    // only sees direct children of ~/.claude, filtered down to our one basename.
    fs.watch(path.dirname(USAGE_FILE), (_event, filename) => {
      if (filename !== path.basename(USAGE_FILE)) return;
      clearTimeout(usageTimer); // statusline refreshes burst; coalesce
      usageTimer = setTimeout(() => { pushUsage(); }, 100);
    });
  } catch (err) {
    // Watcher is an enhancement: the header still shows the initial read.
    console.error('deck-usage watcher unavailable:', err.message);
  }
}

// The 60s tick is the only clock in the hybrid design: it catches quota
// burned by sessions OUTSIDE the deck (no collector there) via the
// estimator's incremental re-scan. Steady state cost: stats only (~1ms).
let usageTickTimer = null;
function startUsageTick() {
  usageTickTimer = setInterval(() => { pushUsage(); }, 60 * 1000);
}

// estimator cold pass: chunked (40+ MB of transcripts on a busy rig), the
// UI shows source A meanwhile and upgrades when B lands.
function startEstimatorColdPass() {
  estimator.scanAsync()
    .then(() => { estimatorReady = true; return pushUsage(); })
    .catch(() => { /* gauges stay A-only */ });
}

// usage page report. The keys are the accepted periods; the value is how far back the first bucket
// can start (partial first day + DST margin), so events() slices instead of handing over all 90 d.
const REPORT_LOOKBACK_MS = { '24h': 26 * 3600e3, '7d': 9 * 86400e3, '30d': 32 * 86400e3, '90d': 92 * 86400e3 };
const reportCache = new Map(); // period -> { version, priceVersion, hour, report }

// Cached per (estimator version, price version, period, local hour): tab and period switches reuse the
// report until an ingest bumps the version, a new price feed is applied or the hour turns (the 24h
// buckets and the day windows then slide). The payload carries `prices` (version, date, source).
// The hour key is the UTC ms of the local hour start, so the repeated hour of a DST fall-back gets
// two keys. A bad period answers { error: 'period' }, a report asked before the estimator cold pass
// ends { error: 'warming' } (never cached); nothing from buildReport throws past this function.
function usageReport(period, nowMs = Date.now()) {
  if (typeof period !== 'string' || !Object.hasOwn(REPORT_LOOKBACK_MS, period)) return { error: 'period' };
  if (!estimatorReady) return { error: 'warming' };
  const version = estimator.version;
  const prices = priceInfo();
  const off = -new Date(nowMs).getTimezoneOffset() * 60000;
  const hour = Math.floor((nowMs + off) / 3600e3) * 3600e3 - off;
  const hit = reportCache.get(period);
  if (hit && hit.version === version && hit.priceVersion === prices.version && hit.hour === hour) return hit.report;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const events = estimator.events({ fromMs: nowMs - REPORT_LOOKBACK_MS[period] }, nowMs);
    const report = { ...buildReport(events, period, nowMs, tz), prices };
    reportCache.set(period, { version, priceVersion: prices.version, hour, report });
    return report;
  } catch (err) {
    if (err instanceof RangeError) return { error: 'period' };
    throw err;
  }
}

function registerUsageIpc() {
  ipcMain.handle('usage-get', () => buildUsagePayload());
  ipcMain.handle('usage-set-plan', async (_event, plan) => {
    if (plan !== null && !PLAN_IDS.includes(plan)) return { error: 'plan' };
    try {
      savePlan(plan);
    } catch (_) {
      return { error: 'write' };
    }
    planCache = plan;
    await pushUsage();
    return { plan };
  });
  ipcMain.handle('usage-report', (_event, period) => usageReport(period));
}

module.exports = {
  registerUsageIpc,
  startUsageWatcher,
  startUsageTick,
  startEstimatorColdPass,
};
