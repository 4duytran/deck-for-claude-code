// claude-deck — price-feed: monthly refresh of the usage page's price table from the LiteLLM list.
// Main process only (the renderer does no IO and its CSP forbids external fetches). On start it
// applies the stored feed (no network), then every 24 h it fetches a new list when the stored one is
// absent or older than 30 days. Only the validated `anthropic` rates are stored and applied; any
// failure keeps what is applied and logs ONE line with a fixed reason, never a body or a value.
// Requires config and usage-prices only, so the main-process graph stays acyclic.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { PRICES_URL } = require('./config');
const { baseModel, applyFeed } = require('./usage-prices');

const FEED_FILE = 'price-feed.json';
const MAX_AGE_MS = 30 * 86400e3;
const TICK_MS = 24 * 3600e3;
const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MIN_MODELS = 5;
const RATE_MAX = 1000; // USD per 1M tokens: above this a rate is a unit error, not a price
const NAME_RE = /^claude-[a-z0-9][a-z0-9.-]{0,63}$/;
const RATE_KEYS = ['inp', 'cc5', 'cc1h', 'cr', 'out'];
// LiteLLM per-token field of each rate: [standard, above 100k prompt tokens].
const FIELDS = {
  inp: ['input_cost_per_token', 'input_cost_per_token_above_100k_tokens'],
  cc5: ['cache_creation_input_token_cost', 'cache_creation_input_token_cost_above_100k_tokens'],
  cc1h: ['cache_creation_input_token_cost_above_1hr', 'cache_creation_input_token_cost_above_1hr_above_100k_tokens'],
  cr: ['cache_read_input_token_cost', 'cache_read_input_token_cost_above_100k_tokens'],
  out: ['output_cost_per_token', 'output_cost_per_token_above_100k_tokens'],
};

let timer = null;
let running = false;
let fetchedAtMs = 0; // fetch time of the applied feed, 0 when none

const log = (msg) => console.log(`[price-feed] ${msg}`);
const fail = (reason) => Object.assign(new Error(reason), { reason });
const feedPath = () => path.join(app.getPath('userData'), FEED_FILE);

function dayOf(ms) { // local calendar day, YYYY-MM-DD
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Valid per-1M rates (a copy) or null: five finite numbers in (0, RATE_MAX), output not below input.
function cleanRates(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of RATE_KEYS) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= RATE_MAX) return null;
    out[k] = v;
  }
  return out.out >= out.inp ? out : null;
}

// A model entry: valid standard rates, plus a valid `long` tier when present (an invalid tier drops the model).
function cleanModel(r) {
  const std = cleanRates(r);
  if (!std) return null;
  if (r.long === undefined) return std;
  const long = cleanRates(r.long);
  return long ? { ...std, long } : null;
}

const perMillion = (v) => (typeof v === 'number' ? Number((v * 1e6).toPrecision(10)) : NaN);
const fromEntry = (e, tier) => Object.fromEntries(RATE_KEYS.map((k) => [k, perMillion(e[FIELDS[k][tier]])]));

// `{name: rates}` from the parsed list: `anthropic` entries only, keyed through baseModel (a dated key
// collapses onto the bare name, a bare key wins, else the later date), per-token -> per-1M. An entry
// that does not validate is skipped: that model keeps its bundled rates.
function extract(feed) {
  const picked = new Map();
  if (!feed || typeof feed !== 'object') return {};
  for (const [key, e] of Object.entries(feed)) {
    if (!e || typeof e !== 'object' || e.litellm_provider !== 'anthropic') continue;
    const name = baseModel(key);
    if (!name || !NAME_RE.test(name)) continue;
    const std = fromEntry(e, 0);
    const model = cleanModel(e[FIELDS.inp[1]] === undefined ? std : { ...std, long: fromEntry(e, 1) });
    if (!model) continue;
    const bare = key === name;
    const prev = picked.get(name);
    if (prev && (prev.bare || (!bare && key < prev.key))) continue;
    picked.set(name, { key, bare, model });
  }
  return Object.fromEntries([...picked].map(([name, p]) => [name, p.model]));
}

// GET the list: one 10 s deadline over headers and body, body capped at MAX_BODY_BYTES.
async function download() {
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(PRICES_URL, { signal: ctl.signal }); } catch (_) {
      throw fail(ctl.signal.aborted ? 'timeout' : 'network');
    }
    if (!res.ok) throw fail('http');
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) throw fail('size');
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) { ctl.abort(); throw fail('size'); }
        chunks.push(chunk);
      }
    } catch (err) {
      throw err.reason ? err : fail(ctl.signal.aborted ? 'timeout' : 'network');
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(deadline);
  }
}

async function save(fetchedAt, rates) {
  const file = feedPath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, fetchedAt, source: 'litellm', rates }));
  await fsp.rename(tmp, file);
}

async function refresh() {
  let feed;
  try { feed = JSON.parse(await download()); } catch (err) {
    throw err.reason ? err : fail('parse');
  }
  const rates = extract(feed);
  if (Object.keys(rates).length < MIN_MODELS) throw fail('invalid');
  const now = Date.now();
  try { await save(new Date(now).toISOString(), rates); } catch (_) { log('store failed'); }
  applyFeed(rates, dayOf(now));
  fetchedAtMs = now;
}

// Apply the stored feed, whatever its age (a failed refresh keeps it); a bad file is ignored.
function loadStored() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(feedPath(), 'utf8')); } catch (err) {
    if (!err || err.code !== 'ENOENT') log('stored feed unreadable');
    return;
  }
  const at = Date.parse(raw && raw.fetchedAt);
  const rates = {};
  if (raw && raw.v === 1 && raw.rates && typeof raw.rates === 'object') {
    for (const [name, r] of Object.entries(raw.rates)) {
      const model = NAME_RE.test(name) ? cleanModel(r) : null;
      if (model) rates[name] = model;
    }
  }
  if (!Number.isFinite(at) || Object.keys(rates).length < MIN_MODELS) { log('stored feed invalid'); return; }
  applyFeed(rates, dayOf(at));
  fetchedAtMs = at;
}

async function tick() {
  const age = Date.now() - fetchedAtMs;
  if (running || (age >= 0 && age < MAX_AGE_MS)) return;
  running = true;
  try { await refresh(); } catch (err) { log(`refresh failed: ${(err && err.reason) || 'internal'}`); } finally { running = false; }
}

function startPriceFeed() {
  if (timer) return;
  loadStored();
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

module.exports = { startPriceFeed, _internals: { extract, cleanModel } };
