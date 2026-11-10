'use strict';
// commands-feed-probe — B24 lot K-a (deck-verre-layout Amendment 20, K1-K3): src/main/commands-bundled.js +
// src/main/commands-feed.js against a LOCAL fake HTTP server (127.0.0.1, ephemeral port). Hermetic:
// CLAUDE_DECK_COMMANDS_URL points at the fake server (or at the closed port 127.0.0.1:1), userData lives in a
// mkdtemp dir, every case loads a FRESH module graph (require.cache purged), nothing under ~/.claude, no real network.
//   env -u OPENAI_API_KEY ... xvfb-run -a node_modules/.bin/electron test/commands-feed-probe.js
// COMMANDS_FEED_SRC=<dir> points the probe at another copy of src/main (mutation proofs); default: this tree.
//
// Gates: g0 parser forms + the URL seam default   g1 bundled list served with no stored feed; hidden list applied
//   g2 valid feed applied and stored (g2b: exactly 60 rows is enough)   g3 HTML body (g3b: HTTP 500)
//   g4 oversize body (g4a declared length, g4b streamed past the cap)   g5 timeout (REAL 10 s deadline each)
//   g6 < 60 rows (Removed rows do not count) / a bad name / an empty purpose -> each keeps the list applied before,
//      the stored file untouched, ONE fixed-reason log line, no body in the log
//   g7 stored list < 30 d not re-fetched, > 30 d re-fetched   g8 stored list reloaded at start, network dead
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { app } = require('electron');

const SRC = process.env.COMMANDS_FEED_SRC ? path.resolve(process.env.COMMANDS_FEED_SRC) : path.join(__dirname, '..', 'src', 'main');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-commands-feed-probe-'));
process.env.CLAUDE_DECK_ASK_DIR = process.env.CLAUDE_DECK_ASK_DIR || path.join(TMP, 'ask');
process.env.CLAUDE_DECK_STATUS_DIR = process.env.CLAUDE_DECK_STATUS_DIR || path.join(TMP, 'status');

const DAY = 86400e3;
const MAX_BODY = 1024 * 1024;
const DEAD_URL = 'http://127.0.0.1:1';
const PAGE_URL = 'https://code.claude.com/docs/en/commands.md';
const NAME_RE = /^\/[a-z][a-z0-9-]*$/;
const realNow = Date.now;
const origLog = console.log.bind(console);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---- page fixtures: the official table shape, rebuilt from entries --------------------------------------------
const esc = (s) => s.replace(/\|/g, '\\|');
const row = (e) => `| \`${esc(e.args ? `${e.name} ${e.args}` : e.name)}\` | ${esc(e.desc)} |`;
const page = (entries, extra = []) => [
  '> ## Documentation Index', '', '# Commands', '', 'Prose with a | pipe that is not a table row.', '',
  '| Command | Purpose |', '|:--|:--|', ...entries.map(row), ...extra, '', '## Next section', '', 'Closing prose.',
].join('\n');
// Raw rows in the forms the official page uses (links, the two skill prefixes, escaped pipes, several commands in one row).
const RAW = [
  '| `/zz-skill <what>` | **[Skill](https://example.test/skills.md#bundled-skills).** Do the [skill thing](https://example.test/a.md) with `code`. |',
  '| `/zz-skill2` | **[Skill](https://example.test/s.md)**. Other prefix form. |',
  '| `/zz-flow` | **[Workflow](https://example.test/w.md).** Run a flow. |',
  '| `/zz-pipe [a\\|b\\|c]` | Pick `a\\|b`. |',
  '| `/zz-two one`, `/zz-two two` | Two commands in one row. |',
  '| `/zz-gone` | Removed in v9.9.9. Use something else. |',
  `| \`/zz-long\` | ${'word '.repeat(80)}|`,
];
const RAW_WANT = [
  { name: '/zz-skill', args: '<what>', desc: 'Do the skill thing with code.' },
  { name: '/zz-skill2', args: '', desc: 'Other prefix form.' },
  { name: '/zz-flow', args: '', desc: 'Run a flow.' },
  { name: '/zz-pipe', args: '[a|b|c]', desc: 'Pick a|b.' },
  { name: '/zz-two', args: 'one', desc: 'Two commands in one row.' },
  { name: '/zz-two', args: 'two', desc: 'Two commands in one row.' },
];

// ---- fake server -----------------------------------------------------------------------------------------------
const hits = [];
let serve = (req, res) => { res.writeHead(404); res.end(); };
const server = http.createServer((req, res) => {
  hits.push({ method: req.method, url: req.url });
  req.socket.on('error', () => {});
  res.on('error', () => {});
  serve(req, res);
});
let URL_OK = '';
const textServe = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(body); };

// ---- fresh module graph per case --------------------------------------------------------------------------------
let seq = 0;
let current = null;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.startsWith('[commands-feed]')) { if (current) current.logs.push(s); } else origLog(...a);
};
const feedFile = (dir) => path.join(dir, 'commands-feed.json');
function seed(dir, { ageMs, commands }) {
  fs.writeFileSync(feedFile(dir), JSON.stringify({ v: 1, fetchedAt: new Date(realNow() - ageMs).toISOString(), source: 'code.claude.com', commands }));
}
function boot({ url = URL_OK, dir, stored } = {}) {
  const ud = dir || path.join(TMP, `userdata-${++seq}`);
  fs.mkdirSync(ud, { recursive: true });
  app.setPath('userData', ud);
  if (stored) seed(ud, stored);
  process.env.CLAUDE_DECK_COMMANDS_URL = url;
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k];
  const config = require(path.join(SRC, 'config'));
  if (config.COMMANDS_URL !== url || !/^http:\/\/127\.0\.0\.1:\d+/.test(config.COMMANDS_URL)) throw new Error(`COMMANDS_URL seam not honoured: ${config.COMMANDS_URL}`);
  const cf = require(path.join(SRC, 'commands-feed'));
  const inst = { dir: ud, cf, logs: [], tickFn: null };
  current = inst;
  inst.start = () => { // capture the 24 h tick callback so a case can run a later refresh without waiting 24 h
    const si = global.setInterval;
    global.setInterval = (fn, ms, ...rest) => { if (ms === 24 * 3600e3) inst.tickFn = fn; return si(fn, ms, ...rest); };
    try { cf.startCommandsFeed(); } finally { global.setInterval = si; }
  };
  inst.tick = () => { if (!inst.tickFn) throw new Error('24 h tick not captured'); return inst.tickFn(); };
  inst.names = () => new Set(cf.commandsList().map((e) => e.name));
  return inst;
}

let ctx = null;
function prep() { // fixtures derived from the bundled list of the module under test
  if (ctx) return ctx;
  const inst = boot({ url: DEAD_URL });
  const bundled = inst.cf.commandsList();
  const keep = new Set(['/compact', '/clear', '/goal', '/model', '/design']);
  const drop = bundled.find((e) => !inst.cf.HIDDEN_COMMANDS.has(e.name) && !keep.has(e.name)).name;
  const NEW = { name: '/zz-new', args: '[x|y]', desc: 'A command the feed brings.' };
  const NEWER = { name: '/zz-newer', args: '', desc: 'A command only the later feed brings.' };
  ctx = {
    parse: inst.cf._internals.parse, bundled, drop, NEW, NEWER,
    feedA: page(bundled.filter((e) => e.name !== drop).concat(NEW), RAW),
    feedB: page(bundled.concat(NEWER)),
  };
  return ctx;
}

// A list that must be refused: apply a good feed, jump 31 days ahead, serve `bad`, run the refresh.
async function keptCase(reason, bad, timing) {
  const { feedA, NEW } = prep();
  const inst = boot();
  serve = textServe(feedA);
  inst.start();
  await until(() => inst.names().has(NEW.name), 5000, 'first feed applied');
  await until(() => fs.existsSync(feedFile(inst.dir)), 2000, 'stored file');
  await sleep(50);
  const before = { list: inst.cf.commandsList(), file: fs.readFileSync(feedFile(inst.dir)) };
  const h0 = hits.length;
  inst.logs.length = 0;
  serve = bad;
  shiftClock(31 * DAY);
  const t0 = performance.now();
  await inst.tick();
  const dt = performance.now() - t0;
  restoreClock();
  assert.strictEqual(hits.length - h0, 1, `${hits.length - h0} requests, want exactly 1 (the refresh must have been attempted)`);
  assert.deepStrictEqual(inst.logs, [`[commands-feed] refresh failed: ${reason}`], 'one fixed-reason log line, no body');
  assert.deepStrictEqual(inst.cf.commandsList(), before.list, 'the list applied before is kept');
  assert.ok(fs.readFileSync(feedFile(inst.dir)).equals(before.file), 'stored feed file untouched');
  if (timing) assert.ok(dt >= 9000 && dt < 25000, `refresh took ${Math.round(dt)} ms, want the 10 s deadline`);
}

// ---- gates -------------------------------------------------------------------------------------------------------
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
  URL_OK = `http://127.0.0.1:${server.address().port}/commands.md`;

  await gate('g0', 'parser: links reduced to text, Skill/Workflow prefixes dropped, escaped pipes, one entry per command of a row, Removed rows dropped, 160-char cap; URL seam default is the page', async () => {
    const { parse, bundled } = prep();
    const got = parse(page([], RAW));
    assert.deepStrictEqual(got.slice(0, RAW_WANT.length), RAW_WANT);
    assert.deepStrictEqual(got.map((e) => e.name).slice(RAW_WANT.length), ['/zz-long'], 'the Removed row is dropped, nothing else is added');
    const long = got[got.length - 1].desc;
    assert.ok(long.length <= 160 && long.endsWith('…'), `long purpose ${long.length} chars`);
    assert.deepStrictEqual(parse(page(bundled)), bundled, 'the bundled list survives a render -> parse round trip');
    assert.deepStrictEqual(parse('| Command | Purpose |\n|:--|:--|\n| plain | cell |\n'), [], 'rows that name no command are ignored');
    delete process.env.CLAUDE_DECK_COMMANDS_URL;
    for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k];
    assert.strictEqual(require(path.join(SRC, 'config')).COMMANDS_URL, PAGE_URL, 'default seam value');
  });

  await gate('g1', 'bundled list served with no stored feed (>= 100, /compact, /design split, no /vim); hidden commands absent from the visible list', async () => {
    const inst = boot({ url: DEAD_URL });
    const { cf } = inst;
    const all = cf.commandsList();
    const names = inst.names();
    assert.ok(all.length >= 100, `${all.length} bundled entries, want >= 100`);
    for (const n of ['/compact', '/clear', '/goal', '/model', '/config', '/resume']) assert.ok(names.has(n), `bundled lacks ${n}`);
    for (const n of ['/vim', '/pr-comments', '/ultraplan']) assert.ok(!names.has(n), `${n} is Removed on the page: must be absent`);
    assert.deepStrictEqual(all.filter((e) => e.name === '/design').map((e) => e.args).sort(), ['[brief]', 'consent', 'revoke'], '/design, /design consent and /design revoke are three entries');
    for (const e of all) {
      assert.ok(NAME_RE.test(e.name), `bad name ${JSON.stringify(e.name)}`);
      assert.ok(typeof e.args === 'string' && e.args.length <= 240, `args of ${e.name}`);
      assert.ok(e.desc.length > 0 && e.desc.length <= 160, `desc of ${e.name}: ${e.desc.length} chars`);
      assert.ok(!/[`]|\*\*|\]\(|^Removed/.test(e.desc), `markup left in the desc of ${e.name}`);
      assert.ok(!/^\*?\*?\[?(Skill|Workflow)\]/.test(e.desc), `prefix left in the desc of ${e.name}`);
    }
    assert.ok(all.some((e) => e.name === '/model' && e.args.length > 0), '/model keeps its args hint');
    assert.ok(all.some((e) => e.args.includes('|')), 'escaped pipes unescaped in args');
    const vis = cf.visibleCommands();
    const visNames = new Set(vis.map((e) => e.name));
    for (const h of cf.HIDDEN_COMMANDS) assert.ok(!visNames.has(h), `${h} is hidden: absent from the visible list`);
    for (const n of ['/config', '/mcp', '/sandbox', '/resume', '/voice', '/passes']) assert.ok(cf.HIDDEN_COMMANDS.has(n), `HIDDEN_COMMANDS lacks ${n}`);
    for (const n of ['/compact', '/clear', '/goal', '/model']) assert.ok(visNames.has(n), `visible list lacks ${n}`);
    assert.ok(vis.length < all.length && vis.every((e) => names.has(e.name)), 'visible is the applied list minus the hidden commands');
    vis[0].name = '/mutated';
    all[0].desc = 'mutated';
    assert.ok(!cf.commandsList().some((e) => e.name === '/mutated' || e.desc === 'mutated'), 'callers get copies');
    inst.start();
    assert.deepStrictEqual(cf.commandsList().length, all.length, 'start without a stored feed keeps the bundled list');
    await until(() => inst.logs.length === 1, 5000, 'refresh outcome');
    assert.deepStrictEqual(inst.logs, ['[commands-feed] refresh failed: network']);
    assert.strictEqual(cf.commandsList().length, all.length, 'still bundled after the failed refresh');
  });

  await gate('g2', 'valid feed applied and stored: a new command appears (shown by default), a dropped one and a Removed one disappear, hidden stays hidden', async () => {
    const { feedA, drop, NEW, bundled } = prep();
    assert.ok(bundled.filter((e) => e.name === drop).length === 1, `precondition: ${drop} is bundled once`);
    const inst = boot();
    serve = textServe(feedA);
    const h0 = hits.length;
    assert.ok(inst.names().has(drop) && !inst.names().has(NEW.name), 'before: bundled');
    inst.start();
    await until(() => inst.names().has(NEW.name), 5000, 'feed applied');
    assert.deepStrictEqual(hits.slice(h0).map((h) => `${h.method} ${h.url}`), ['GET /commands.md'], 'one GET of the configured URL');
    const names = inst.names();
    assert.ok(!names.has(drop), `${drop} dropped by the feed`);
    assert.ok(!names.has('/zz-gone'), 'Removed row not applied');
    for (const n of ['/zz-skill', '/zz-flow', '/zz-pipe', '/zz-two', '/zz-long', '/compact']) assert.ok(names.has(n), `${n} applied`);
    assert.deepStrictEqual(inst.cf.commandsList().find((e) => e.name === NEW.name), NEW);
    const vis = inst.cf.visibleCommands().map((e) => e.name);
    assert.ok(vis.includes(NEW.name), 'a command new on the page is shown by default');
    assert.ok(names.has('/config') && !vis.includes('/config'), '/config applied but hidden');
    await until(() => fs.existsSync(feedFile(inst.dir)), 2000, 'stored file');
    const file = JSON.parse(fs.readFileSync(feedFile(inst.dir), 'utf8'));
    assert.strictEqual(file.v, 1);
    assert.strictEqual(file.source, 'code.claude.com');
    assert.ok(Math.abs(Date.parse(file.fetchedAt) - realNow()) < 60000, `fetchedAt ${file.fetchedAt}`);
    assert.deepStrictEqual(file.commands, inst.cf.commandsList(), 'the stored list is the applied list');
    assert.deepStrictEqual(inst.logs, [], 'success logs nothing');
  });
  await gate('g2b', 'exactly 60 rows is a valid feed', async () => {
    const { bundled } = prep();
    assert.ok(bundled.length > 60, 'precondition');
    const inst = boot();
    serve = textServe(page(bundled.slice(0, 60)));
    inst.start();
    await until(() => inst.cf.commandsList().length === 60, 5000, '60-row feed applied');
    assert.deepStrictEqual(inst.logs, []);
  });

  await gate('g3', 'an HTML body (200) keeps the previous list (reason parse)', () => keptCase('parse', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>Moved</h1><table><tr><td>| `/compact` | x |</td></tr></table></body></html>');
  }));
  await gate('g3b', 'HTTP 500 keeps the previous list (reason http)', () => keptCase('http', (req, res) => { res.writeHead(500); res.end('x'); }));

  await gate('g4a', 'a body declared over 1 MB by Content-Length keeps the previous list (reason size)', () => keptCase('size', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/markdown', 'content-length': String(MAX_BODY + 1) });
    res.write('|');
    setTimeout(() => res.destroy(), 500);
  }));
  await gate('g4b', 'a valid page streamed past 1 MB (no Content-Length) keeps the previous list (reason size)', () => keptCase('size', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/markdown' });
    res.write(prep().feedB);
    const chunk = 'x'.repeat(MAX_BODY);
    let i = 0;
    const pump = () => {
      while (i < 3) { i++; if (!res.write(chunk)) { res.once('drain', pump); return; } }
      res.end('\n');
    };
    pump();
  }));

  await gate('g5a', 'a server that never answers hits the 10 s deadline and keeps the previous list (reason timeout)', () => keptCase('timeout', () => {}, true));
  await gate('g5b', 'a server that stalls after the headers hits the same deadline (reason timeout)', () => keptCase('timeout', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/markdown' });
    res.write('| `/compact` | Free up context. |\n');
  }, true));

  await gate('g6a', 'fewer than 60 rows (59) keeps the previous list (reason invalid)', () => keptCase('invalid', textServe(page(prep().bundled.slice(0, 59)))));
  await gate('g6b', 'Removed rows do not count: 59 good rows + 5 Removed rows keep the previous list (reason invalid)', () => keptCase('invalid', textServe(page(
    prep().bundled.slice(0, 59), Array.from({ length: 5 }, (_, i) => `| \`/zz-old${i}\` | Removed in v1.${i}. Gone. |`)))));
  await gate('g6c', 'one bad name among valid rows (/Bad_Name) keeps the previous list (reason invalid)', () => keptCase('invalid', textServe(page(
    prep().bundled.concat(prep().NEWER), ['| `/Bad_Name` | Looks like a command. |']))));
  await gate('g6d', 'one empty purpose among valid rows keeps the previous list (reason invalid)', () => keptCase('invalid', textServe(page(
    prep().bundled.concat(prep().NEWER), ['| `/zz-empty` |  |']))));

  await gate('g7', 'stored list 29 d old is not re-fetched; 31 d old is re-fetched, applied and re-stored', async () => {
    const { parse, feedA, feedB, NEW, NEWER } = prep();
    const commands = parse(feedA);
    const young = boot({ stored: { ageMs: 29 * DAY, commands } });
    serve = textServe(feedB);
    const h0 = hits.length;
    young.start();
    await young.tick();
    await sleep(250);
    assert.strictEqual(hits.length - h0, 0, `${hits.length - h0} requests for a 29-day-old stored list, want 0`);
    assert.ok(young.names().has(NEW.name) && !young.names().has(NEWER.name), 'the stored list itself is applied');
    const old = boot({ stored: { ageMs: 31 * DAY, commands } });
    old.start();
    await until(() => hits.length - h0 === 1 && old.names().has(NEWER.name), 5000, 'stale list re-fetched');
    assert.ok(!old.names().has(NEW.name), 'the re-fetched list replaces the stored one');
    await until(() => Math.abs(Date.parse(JSON.parse(fs.readFileSync(feedFile(old.dir), 'utf8')).fetchedAt) - realNow()) < 60000, 3000, 're-stored fetchedAt');
  });

  await gate('g8', 'a stored commands-feed.json is reloaded at start by a FRESH instance with the network dead (zero requests); a missing, unreadable or short file -> bundled', async () => {
    const { parse, feedA, bundled, NEW } = prep();
    const writer = boot();
    serve = textServe(feedA);
    writer.start();
    await until(() => writer.names().has(NEW.name), 5000, 'feed fetched');
    await until(() => fs.existsSync(feedFile(writer.dir)), 2000, 'stored file');
    const h0 = hits.length;
    const reader = boot({ url: DEAD_URL, dir: writer.dir });
    assert.notStrictEqual(reader.cf, writer.cf, 'a fresh commands-feed instance');
    assert.ok(!reader.names().has(NEW.name), 'before start: bundled');
    reader.start();
    assert.ok(reader.names().has(NEW.name), 'applied by the reload, synchronously');
    assert.deepStrictEqual(reader.cf.commandsList(), writer.cf.commandsList());
    await reader.tick();
    await sleep(250);
    assert.strictEqual(hits.length, h0, 'no request reached the fake server');
    assert.deepStrictEqual(reader.logs, [], 'a fresh stored list: no refresh attempted, nothing logged');
    fs.unlinkSync(feedFile(writer.dir));
    const control = boot({ url: DEAD_URL, dir: writer.dir });
    control.start();
    assert.strictEqual(control.cf.commandsList().length, bundled.length, 'control: file deleted -> bundled');
    await until(() => control.logs.length === 1, 5000, 'control refresh outcome');
    assert.deepStrictEqual(control.logs, ['[commands-feed] refresh failed: network']);
    const garbage = boot({ url: DEAD_URL, dir: path.join(TMP, 'garbage') });
    fs.writeFileSync(feedFile(garbage.dir), '{"v":1,');
    garbage.start();
    await until(() => garbage.logs.length === 2, 5000, 'garbage outcome');
    assert.deepStrictEqual(garbage.logs, ['[commands-feed] stored feed unreadable', '[commands-feed] refresh failed: network']);
    assert.strictEqual(garbage.cf.commandsList().length, bundled.length, 'unreadable file -> bundled');
    const short = boot({ url: DEAD_URL, dir: path.join(TMP, 'short'), stored: { ageMs: DAY, commands: parse(feedA).slice(0, 10) } });
    short.start();
    await until(() => short.logs.length === 2, 5000, 'short outcome');
    assert.deepStrictEqual(short.logs, ['[commands-feed] stored feed invalid', '[commands-feed] refresh failed: network']);
    assert.strictEqual(short.cf.commandsList().length, bundled.length, 'short stored list -> bundled');
  });
  await gate('g8b', 'a stored list older than 30 d with the network dead: refresh fails (reason network), the stored list stays applied', async () => {
    const { parse, feedA, NEW } = prep();
    const inst = boot({ url: DEAD_URL, stored: { ageMs: 40 * DAY, commands: parse(feedA) } });
    inst.start();
    await until(() => inst.logs.length === 1, 5000, 'refresh outcome');
    assert.deepStrictEqual(inst.logs, ['[commands-feed] refresh failed: network']);
    assert.ok(inst.names().has(NEW.name));
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
