// claude-deck — usage prices: bundled official Claude API price table, the monthly feed overlay
// (applyFeed), model-id matcher and per-event cost for the usage report. Pure values and functions
// (no electron, no fs, no app state). The result is an ESTIMATE at API list prices, never a bill.
// Bundled source: platform.claude.com pricing page, 2026-10-27. Feed source: the LiteLLM list that
// price-feed.js fetches and validates.
'use strict';

const BUNDLED_DATE = '2026-10-27';

// USD per 1M tokens. Keys mirror the estimator event fields (inp/cc5/cc1h/cr/out).
const rates = (inp, cc5, cc1h, cr, out) => Object.freeze({ inp, cc5, cc1h, cr, out });

const PRICES = new Map();
const add = (names, r) => { for (const n of names) PRICES.set(n, r); };

add(['claude-fable-5-1', 'claude-mythos-5-1'], rates(10, 12.5, 20, 0.25, 50));
add(['claude-fable-5', 'claude-mythos-5'], rates(10, 12.5, 20, 1, 50));
add(['claude-opus-5-5'], rates(4, 5, 8, 0.2, 20));
add(['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
  rates(5, 6.25, 10, 0.5, 25));
add(['claude-opus-4-1', 'claude-opus-4'], rates(15, 18.75, 30, 1.5, 75));
add(['claude-sonnet-5-5'], rates(2, 2.5, 4, 0.1, 10));
add(['claude-sonnet-5'], rates(2, 2.5, 4, 0.2, 10));
add(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], rates(3, 3.75, 6, 0.3, 15));
add(['claude-haiku-5-5'], rates(0.1, 0.125, 0.2, 0.01, 0.5));
add(['claude-haiku-4-5'], rates(1, 1.25, 2, 0.1, 5));
add(['claude-3-5-haiku'], rates(0.8, 1, 1.6, 0.08, 4));

// Long-prompt tier: a model listed here is priced per request by prompt length (input + cache write
// + cache read). Haiku 5.5 is the one bundled; the feed may add or replace tiers.
const LONG_ABOVE = 100000;
const LONG = new Map([['claude-haiku-5-5', rates(0.5, 0.625, 1, 0.05, 2.5)]]);

// Fast mode (usage.speed === 'fast'): documented for these models only. Cache
// rates are derived (caching multipliers stack on the fast base price).
// Fast on any other model is undocumented -> standard rates. Never fed: no source.
const FAST = new Map([
  ['claude-opus-5-5', rates(8, 10, 16, 0.4, 40)],
  ['claude-opus-5', rates(10, 12.5, 20, 1, 50)],
  ['claude-opus-4-8', rates(10, 12.5, 20, 1, 50)],
]);

// The bundled maps are the base; applyFeed swaps these two for new maps built from it.
let table = PRICES;
let longTier = LONG;
let info = { version: 0, date: BUNDLED_DATE, source: 'bundled' };

// Overlay validated feed rates `{name: {inp,cc5,cc1h,cr,out, long?}}` on the bundled base: models the
// feed carries take its rates (a long tier only when the feed has one), the others keep the bundled
// ones. Rebuilt from the base on every call, so a later feed never inherits an earlier one.
function applyFeed(feedRates, dateIso) {
  const nextTable = new Map(PRICES);
  const nextLong = new Map(LONG);
  for (const [name, r] of Object.entries(feedRates || {})) {
    nextTable.set(name, rates(r.inp, r.cc5, r.cc1h, r.cr, r.out));
    if (r.long) nextLong.set(name, rates(r.long.inp, r.long.cc5, r.long.cc1h, r.long.cr, r.long.out));
  }
  table = nextTable;
  longTier = nextLong;
  info = { version: info.version + 1, date: dateIso, source: 'litellm' };
}

// Provenance of the active table; `version` bumps on every applyFeed (the report cache key).
function priceInfo() {
  return { ...info };
}

// Table key of a transcript model id: lowercase, minus a "[1m]" suffix, a
// Bedrock "[region.]anthropic." prefix and "-v1:0" suffix, a Vertex "@date"
// and a trailing "-YYYYMMDD". Exact lookup afterwards (no prefix matching).
function baseModel(model) {
  if (typeof model !== 'string') return null;
  return model.trim().toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@[^@]*$/, '')
    .replace(/-\d{8}$/, '');
}

// Rates object for a model, or null when unpriced ('<synthetic>', unknown id).
function priceOf(model, speed, promptLen) {
  const name = baseModel(model);
  const standard = name ? table.get(name) : undefined;
  if (!standard) return null;
  const long = longTier.get(name);
  if (long) return promptLen > LONG_ABOVE ? long : standard;
  if (speed === 'fast') return FAST.get(name) || standard;
  return standard;
}

// USD for one estimator event, or null when its model is unpriced. An unsplit
// cache_creation total arrives in cc5, so it is priced at the 5 m rate.
function costOf(ev) {
  if (!ev) return null;
  const inp = ev.inp || 0;
  const cc5 = ev.cc5 || 0;
  const cc1h = ev.cc1h || 0;
  const cr = ev.cr || 0;
  const out = ev.out || 0;
  const r = priceOf(ev.model, ev.speed, inp + cc5 + cc1h + cr);
  if (!r) return null;
  return (inp * r.inp + cc5 * r.cc5 + cc1h * r.cc1h + cr * r.cr + out * r.out) / 1e6;
}

module.exports = { priceOf, costOf, baseModel, applyFeed, priceInfo };
