'use strict';
// price-feed-probe — usage-price-feed Phase 3 DoD (docs/plans/usage-price-feed.spec.md; deck-verre-layout
// Amendment 18 C2): src/main/price-feed.js + src/main/usage-prices.js (+ the report cache of ipc/usage.js)
// against a LOCAL fake HTTP server (127.0.0.1, ephemeral port). Hermetic: CLAUDE_DECK_PRICES_URL points at
// the fake server (or at the closed port 127.0.0.1:1), userData / projects dirs live in a mkdtemp dir, every
// case loads a FRESH module graph (require.cache purged), nothing under ~/.claude, no real network.
//   env -u OPENAI_API_KEY ... xvfb-run -a node_modules/.bin/electron test/price-feed-probe.js
// PRICE_FEED_SRC=<dir> points the probe at another copy of src/main (mutation proofs); default: this tree.
//
// Gates: g1 valid feed applied, a changed rate changes costOf, stored as {v:1,...}, provider filter
//   g2 version bump -> the usage report recomputes (cache key carries the price version), cached otherwise
//   g3 invalid JSON (g3b: HTTP 500)   g4 oversize body (g4a declared length, g4b streamed past the cap)
//   g5 timeout (g5a never answers, g5b stalls after the headers; REAL 10 s deadline each)
//   g6 fewer than 5 valid anthropic models   -> each keeps the prices applied before, the stored file
//      untouched, ONE fixed-reason log line, no value or body in the log
//   g7 stored feed < 30 d not re-fetched, > 30 d re-fetched   g8 stored feed reloaded at start, network dead
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { app, ipcMain } = require('electron');

const SRC = process.env.PRICE_FEED_SRC ? path.resolve(process.env.PRICE_FEED_SRC) : path.join(__dirname, '..', 'src', 'main');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-price-feed-probe-'));
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.CLAUDE_DECK_PROJECTS_DIR = PROJECTS;
process.env.CLAUDE_DECK_USAGE_FILE = path.join(TMP, 'deck-usage.json'); // absent: no official quota source
process.env.CLAUDE_DECK_ASK_DIR = process.env.CLAUDE_DECK_ASK_DIR || path.join(TMP, 'ask');
process.env.CLAUDE_DECK_STATUS_DIR = process.env.CLAUDE_DECK_STATUS_DIR || path.join(TMP, 'status');

const DAY = 86400e3;
const MAX_BODY = 10 * 1024 * 1024;
const DEAD_URL = 'http://127.0.0.1:1';
const realNow = Date.now;
const origLog = console.log.bind(console);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const dayOf = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
async function until(fn, ms, what) {
  const end = performance.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
const shiftClock = (ms) => { Date.now = () => realNow() + ms; };
const restoreClock = () => { Date.now = realNow; };

// ---- feed fixtures (USD per 1M tokens: [inp, cc5, cc1h, cr, out]) -------------------------------------------
const BASE = {
  'claude-opus-5': [5, 6.25, 10, 0.5, 25], 'claude-sonnet-5': [2, 2.5, 4, 0.2, 10], 'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25], 'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
};
const OPUS_A = [6, 7.5, 12, 0.6, 30]; // the rate a good feed brings (bundled opus-5 is BASE's)
const OPUS_B = [9, 11, 18, 0.9, 45]; // a later feed: must never be applied in the failure cases
const EV_ALL = { model: 'claude-opus-5', inp: 1e6, cc5: 1e6, cc1h: 1e6, cr: 1e6, out: 1e6 }; // cost = sum of the 5 rates
const withOpus = (a) => ({ ...BASE, 'claude-opus-5': a });
const rates = (a) => ({ inp: a[0], cc5: a[1], cc1h: a[2], cr: a[3], out: a[4] });
const entry = (a, provider = 'anthropic') => ({
  litellm_provider: provider, input_cost_per_token: a[0] / 1e6, cache_creation_input_token_cost: a[1] / 1e6,
  cache_creation_input_token_cost_above_1hr: a[2] / 1e6, cache_read_input_token_cost: a[3] / 1e6, output_cost_per_token: a[4] / 1e6,
});
function litellm(models) {
  const f = { sample_spec: { litellm_provider: 'n/a', mode: 'chat' } };
  for (const [n, a] of Object.entries(models)) f[n] = entry(a);
  f['claude-decoy-9'] = entry([0.01, 0.01, 0.01, 0.01, 0.01], 'bedrock'); // wrong provider: never applied
  f['gpt-4o'] = entry([2.5, 2.5, 2.5, 1.25, 10], 'openai');
  return f;
}
const feedFile = (dir) => path.join(dir, 'price-feed.json');
function seed(dir, { ageMs, models }) {
  const stored = {};
  for (const [n, a] of Object.entries(models)) stored[n] = rates(a);
  fs.writeFileSync(feedFile(dir), JSON.stringify({ v: 1, fetchedAt: new Date(realNow() - ageMs).toISOString(), source: 'litellm', rates: stored }));
}

// ---- fake server -----------------------------------------------------------------------------------------
const hits = [];
let serve = (req, res) => { res.writeHead(404); res.end(); };
const server = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url });
  req.socket.on('error', () => {});
  res.on('error', () => {});
  serve(req, res);
});
let URL_OK = '';
const goodServe = (opus) => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(litellm(withOpus(opus)))); };

// ---- fresh module graph per case -------------------------------------------------------------------------------
let seq = 0;
let current = null;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.startsWith('[price-feed]')) { if (current) current.logs.push(s); } else origLog(...a);
};
function writeTranscript() { // one opus-5 event, 1M input tokens, 2 h ago: cost = the input rate
  const e = {
    type: 'assistant', timestamp: new Date(realNow() - 2 * 3600e3).toISOString(), sessionId: 's1', cwd: '/home/u/p', requestId: 'rq1',
    message: { id: 'm1', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  };
  const fp = path.join(PROJECTS, 'enc-p', 's1.jsonl');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(e)}\n`);
}
function boot({ url = URL_OK, dir, stored, report = false } = {}) {
  const ud = dir || path.join(TMP, `userdata-${++seq}`);
  fs.mkdirSync(ud, { recursive: true });
  app.setPath('userData', ud);
  if (stored) seed(ud, stored);
  process.env.CLAUDE_DECK_PRICES_URL = url;
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k];
  const config = require(path.join(SRC, 'config'));
  if (config.PRICES_URL !== url || !/^http:\/\/127\.0\.0\.1:\d+/.test(config.PRICES_URL)) throw new Error(`PRICES_URL seam not honoured: ${config.PRICES_URL}`);
  const up = require(path.join(SRC, 'usage-prices'));
  const pf = require(path.join(SRC, 'price-feed'));
  const inst = { dir: ud, up, pf, logs: [], tickFn: null };
  current = inst;
  inst.start = () => { // capture the 24 h tick callback so a case can run a later refresh without waiting 24 h
    const si = global.setInterval;
    global.setInterval = (fn, ms, ...rest) => { if (ms === 24 * 3600e3) inst.tickFn = fn; return si(fn, ms, ...rest); };
    try { pf.startPriceFeed(); } finally { global.setInterval = si; }
  };
  inst.tick = () => { if (!inst.tickFn) throw new Error('24 h tick not captured'); return inst.tickFn(); };
  if (report) {
    const usage = require(path.join(SRC, 'ipc', 'usage'));
    usage.startEstimatorColdPass();
    for (const ch of ['usage-report', 'usage-get']) ipcMain.removeHandler(ch);
    usage.registerUsageIpc();
    if (!ipcMain._invokeHandlers || typeof ipcMain._invokeHandlers.get !== 'function') throw new Error('ipcMain._invokeHandlers unavailable');
    inst.report = (period) => ipcMain._invokeHandlers.get('usage-report')({}, period);
  }
  return inst;
}

// A feed that must be refused: apply a good feed, jump 31 days ahead, serve `bad`, run the refresh.
async function keptCase(reason, bad, timing) {
  const inst = boot();
  serve = goodServe(OPUS_A);
  inst.start();
  await until(() => inst.up.priceInfo().version === 1, 5000, 'first feed applied');
  await sleep(50);
  const before = { info: inst.up.priceInfo(), file: fs.readFileSync(feedFile(inst.dir)) };
  assert.ok(near(inst.up.costOf(EV_ALL), sum(OPUS_A)), 'precondition: the fetched rates are applied');
  const h0 = hits.length;
  inst.logs.length = 0;
  serve = bad;
  shiftClock(31 * DAY);
  const t0 = performance.now();
  await inst.tick();
  const dt = performance.now() - t0;
  restoreClock();
  assert.strictEqual(hits.length - h0, 1, `${hits.length - h0} requests, want exactly 1 (the refresh must have been attempted)`);
  assert.deepStrictEqual(inst.logs, [`[price-feed] refresh failed: ${reason}`], 'one fixed-reason log line, no body or value');
  assert.deepStrictEqual(inst.up.priceInfo(), before.info, 'provenance (version/date/source) unchanged');
  assert.ok(near(inst.up.costOf(EV_ALL), sum(OPUS_A)), `costOf ${inst.up.costOf(EV_ALL)}, want the previous ${sum(OPUS_A)}`);
  assert.ok(fs.readFileSync(feedFile(inst.dir)).equals(before.file), 'stored feed file untouched');
  if (timing) assert.ok(dt >= 9000 && dt < 25000, `refresh took ${Math.round(dt)} ms, want the 10 s deadline`);
}

// ---- gates ----------------------------------------------------------------------------------------------------
const results = [];
async function gate(name, desc, fn) {
  let ok = true;
  let info = '';
  try { await fn(); } catch (e) { ok = false; info = String((e && e.message) || e).split('\n').slice(0, 3).join(' | '); } finally { restoreClock(); }
  results.push({ name, ok });
  origLog(`${ok ? 'PASS' : 'FAIL'} ${name} - ${desc}${info ? ` :: ${info}` : ''}`);
}

async function run() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  URL_OK = `http://127.0.0.1:${server.address().port}/litellm.json`;

  await gate('g1', 'valid feed applied: a changed rate changes costOf, stored as {v:1,fetchedAt,source,rates}, wrong-provider entries ignored', async () => {
    const inst = boot();
    serve = goodServe(OPUS_A);
    assert.strictEqual(inst.up.priceInfo().version, 0, 'fresh graph starts on the bundled table');
    assert.ok(near(inst.up.costOf(EV_ALL), sum(BASE['claude-opus-5'])), 'bundled cost is the BASE rates');
    inst.start();
    await until(() => inst.up.priceInfo().version === 1, 5000, 'feed applied');
    assert.deepStrictEqual(hits.map((h) => `${h.method} ${h.url}`), ['GET /litellm.json'], 'one GET of the configured URL');
    assert.ok(near(inst.up.costOf(EV_ALL), sum(OPUS_A)), `costOf ${inst.up.costOf(EV_ALL)}, want ${sum(OPUS_A)}`);
    assert.ok(near(inst.up.costOf({ model: 'claude-opus-5', inp: 1e6 }), OPUS_A[0]), 'input rate changed');
    assert.ok(near(inst.up.costOf({ model: 'claude-3-5-haiku', inp: 1e6 }), 0.8), 'a model the feed lacks keeps its bundled rate');
    assert.strictEqual(inst.up.costOf({ model: 'claude-decoy-9', inp: 1 }), null, 'bedrock-provider entry not applied');
    const info = inst.up.priceInfo();
    assert.strictEqual(info.source, 'litellm');
    assert.strictEqual(info.date, dayOf(realNow()));
    await until(() => fs.existsSync(feedFile(inst.dir)), 2000, 'stored file');
    const file = JSON.parse(fs.readFileSync(feedFile(inst.dir), 'utf8'));
    assert.strictEqual(file.v, 1);
    assert.strictEqual(file.source, 'litellm');
    assert.ok(Math.abs(Date.parse(file.fetchedAt) - realNow()) < 60000, `fetchedAt ${file.fetchedAt}`);
    assert.deepStrictEqual(Object.keys(file.rates).sort(), Object.keys(BASE).sort(), 'only the anthropic models are stored');
    assert.deepStrictEqual(file.rates['claude-opus-5'], rates(OPUS_A));
  });

  await gate('g2', 'a price version bump recomputes the usage report (cache key carries it); same version -> same cached report', async () => {
    writeTranscript();
    const inst = boot({ report: true });
    serve = goodServe(OPUS_A);
    let r0;
    await until(async () => { r0 = await inst.report('24h'); return !r0.error; }, 8000, 'estimator cold pass');
    const s0 = await inst.report('7d');
    assert.ok(near(r0.totals.cost, BASE['claude-opus-5'][0]), `bundled report cost ${r0.totals.cost}`);
    assert.strictEqual(r0.prices.version, 0);
    assert.strictEqual(r0.prices.source, 'bundled');
    assert.strictEqual(await inst.report('24h'), r0, 'control: same price version -> the cached report object');
    inst.start();
    await until(() => inst.up.priceInfo().version === 1, 5000, 'feed applied');
    const r1 = await inst.report('24h');
    assert.notStrictEqual(r1, r0, 'report recomputed after the price version bump');
    assert.ok(near(r1.totals.cost, OPUS_A[0]), `fed report cost ${r1.totals.cost}, want ${OPUS_A[0]}`);
    assert.strictEqual(r1.prices.version, 1);
    assert.strictEqual(r1.prices.source, 'litellm');
    assert.strictEqual(await inst.report('24h'), r1, 'cached again at the new version');
    const s1 = await inst.report('7d');
    assert.ok(s1 !== s0 && near(s1.totals.cost, OPUS_A[0]), 'every period recomputes, not only the one asked first');
  });

  await gate('g3', 'invalid JSON keeps the previous prices (reason parse)', () => keptCase('parse', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`{"claude-opus-5": {"litellm_provider": "anthropic", "input_cost_per_token": ${OPUS_B[0] / 1e6}, `);
  }));
  await gate('g3b', 'HTTP 500 keeps the previous prices (reason http)', () => keptCase('http', (req, res) => { res.writeHead(500); res.end('{}'); }));

  const validBody = (pad) => JSON.stringify(litellm(withOpus(OPUS_B))).slice(0, -1) + (pad ? ',"zz_pad":"' : '}');
  await gate('g4a', 'oversize body declared by Content-Length (> 10 MB) keeps the previous prices (reason size)', () => keptCase('size', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) });
    res.write('{');
    setTimeout(() => res.destroy(), 500);
  }));
  await gate('g4b', 'oversize body streamed past the cap (valid JSON, no Content-Length) keeps the previous prices (reason size)', () => keptCase('size', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(validBody(true));
    const chunk = 'x'.repeat(1024 * 1024);
    let i = 0;
    const pump = () => {
      while (i < 11) { i++; if (!res.write(chunk)) { res.once('drain', pump); return; } }
      res.end('"}');
    };
    pump();
  }));

  await gate('g5a', 'a server that never answers hits the 10 s deadline and keeps the previous prices (reason timeout)', () => keptCase('timeout', () => {}, true));
  await gate('g5b', 'a server that stalls after the headers hits the same 10 s deadline (reason timeout)', () => keptCase('timeout', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"claude-opus-5":');
  }, true));

  await gate('g6', 'fewer than 5 valid anthropic models (4 valid + 1 bad-rate + foreign-provider decoys) keeps the previous prices (reason invalid)', () => keptCase('invalid', (req, res) => {
    const four = { 'claude-opus-5': OPUS_B, 'claude-sonnet-5': BASE['claude-sonnet-5'], 'claude-haiku-4-5': BASE['claude-haiku-4-5'], 'claude-opus-4-8': BASE['claude-opus-4-8'] };
    const f = litellm(four);
    f['claude-sonnet-4-6'] = entry([3, 3.75, 6, 0.3, 2]); // output below input: skipped
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(f));
  }));

  await gate('g7', 'stored feed 29 d old is not re-fetched; stored feed 31 d old is re-fetched, applied and re-stored', async () => {
    const young = boot({ stored: { ageMs: 29 * DAY, models: withOpus(OPUS_A) } });
    serve = goodServe(OPUS_B);
    const h0 = hits.length;
    young.start();
    await young.tick();
    await sleep(250);
    assert.strictEqual(hits.length - h0, 0, `${hits.length - h0} requests for a 29-day-old stored feed, want 0`);
    assert.strictEqual(young.up.priceInfo().version, 1, 'the stored feed itself is applied');
    assert.ok(near(young.up.costOf(EV_ALL), sum(OPUS_A)), 'and stays applied');
    const old = boot({ stored: { ageMs: 31 * DAY, models: withOpus(OPUS_A) } });
    old.start();
    await until(() => hits.length - h0 === 1 && old.up.priceInfo().version === 2, 5000, 'stale feed re-fetched');
    assert.ok(near(old.up.costOf(EV_ALL), sum(OPUS_B)), 'the re-fetched rates replace the stored ones');
    await until(() => Math.abs(Date.parse(JSON.parse(fs.readFileSync(feedFile(old.dir), 'utf8')).fetchedAt) - realNow()) < 60000, 3000, 're-stored fetchedAt');
  });

  await gate('g8', 'a stored price-feed.json is reloaded and applied at start by a FRESH instance with the network dead; without the file, bundled', async () => {
    const writer = boot();
    serve = goodServe(OPUS_A);
    writer.start();
    await until(() => writer.up.priceInfo().version === 1, 5000, 'feed fetched and stored');
    await until(() => fs.existsSync(feedFile(writer.dir)), 2000, 'stored file');
    const fetchedAt = JSON.parse(fs.readFileSync(feedFile(writer.dir), 'utf8')).fetchedAt;
    const h0 = hits.length;
    const reader = boot({ url: DEAD_URL, dir: writer.dir });
    assert.notStrictEqual(reader.up, writer.up, 'a fresh usage-prices instance');
    assert.strictEqual(reader.up.priceInfo().version, 0, 'before start: bundled');
    assert.ok(near(reader.up.costOf(EV_ALL), sum(BASE['claude-opus-5'])));
    reader.start();
    const info = reader.up.priceInfo(); // loadStored is synchronous: nothing awaited since start
    assert.strictEqual(info.version, 1, 'applied by the reload');
    assert.strictEqual(info.source, 'litellm');
    assert.strictEqual(info.date, dayOf(Date.parse(fetchedAt)), 'date = day of the stored fetchedAt');
    assert.ok(near(reader.up.costOf(EV_ALL), sum(OPUS_A)), `reloaded costOf ${reader.up.costOf(EV_ALL)}, want ${sum(OPUS_A)}`);
    await reader.tick();
    await sleep(250);
    assert.strictEqual(hits.length, h0, 'no request reached the fake server');
    assert.deepStrictEqual(reader.logs, [], 'a fresh stored feed: no refresh attempted, nothing logged');
    fs.unlinkSync(feedFile(writer.dir));
    const control = boot({ url: DEAD_URL, dir: writer.dir });
    control.start();
    assert.strictEqual(control.up.priceInfo().version, 0, 'control: file deleted -> bundled');
    assert.ok(near(control.up.costOf(EV_ALL), sum(BASE['claude-opus-5'])));
    // no stored file: the control tried the dead network. Wait for its log so it cannot leak into the next case.
    await until(() => control.logs.length === 1, 5000, 'control refresh outcome');
    assert.deepStrictEqual(control.logs, ['[price-feed] refresh failed: network']);
  });
  await gate('g8b', 'a stored feed older than 30 d with the network dead: refresh fails (reason network), the stored prices stay applied', async () => {
    const inst = boot({ url: DEAD_URL, stored: { ageMs: 40 * DAY, models: withOpus(OPUS_A) } });
    inst.start();
    await until(() => inst.logs.length === 1, 5000, 'refresh outcome');
    assert.deepStrictEqual(inst.logs, ['[price-feed] refresh failed: network']);
    assert.strictEqual(inst.up.priceInfo().version, 1);
    assert.ok(near(inst.up.costOf(EV_ALL), sum(OPUS_A)));
  });

  const bad = results.filter((r) => !r.ok);
  origLog(bad.length ? `VERDICT: FAILED (${results.length - bad.length}/${results.length}) ${bad.map((r) => r.name).join(' ')}`
    : `VERDICT: ALL GREEN (${results.length}/${results.length})`);
  server.closeAllConnections();
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* tmp stays */ }
  app.exit(bad.length ? 1 : 0);
}

setTimeout(() => { origLog('FAIL watchdog - probe exceeded 80 s'); app.exit(3); }, 80000).unref();
run().catch((e) => { origLog(`FAIL harness - ${(e && e.stack) || e}`); app.exit(2); });
