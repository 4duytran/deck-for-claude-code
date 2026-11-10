// claude-deck — commands-feed: the Claude Code command list behind the composer « / » picker, refreshed monthly.
// Main process only (the renderer does no IO and its CSP forbids external fetches). Starts on the list bundled in
// commands-bundled.js, applies the stored commands-feed.json of userData at once (no network), then every 24 h fetches
// the official page when the stored list is absent or older than 30 days. Any failure keeps what is applied and logs
// ONE line with a fixed reason, never a body. Requires config and the bundled data only: the main graph stays acyclic.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');
const { COMMANDS_URL } = require('./config');
const BUNDLED = require('./commands-bundled');

const FEED_FILE = 'commands-feed.json';
const MAX_AGE_MS = 30 * 86400e3;
const TICK_MS = 24 * 3600e3;
const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 1024 * 1024;
const MIN_ROWS = 60;
const DESC_MAX = 160;
const ARGS_MAX = 240;
const NAME_RE = /^\/[a-z][a-z0-9-]*$/;
const SKILL_PREFIX_RE = /^\*\*\[(?:Skill|Workflow)\]\([^)]*\)\.?\*\*\.?\s*/;

// Commands that open an interactive terminal screen or act on the terminal itself: the chat face can neither render
// nor drive them. Hand-kept, classified from the page's purpose text (not measured in the CLI); a command new on the
// page is shown by default.
const HIDDEN_COMMANDS = new Set(`/config /resume /help /hooks /ide /permissions /memory /theme /status /stats /usage /cost
  /login /logout /export /bug /feedback /release-notes /privacy-settings /plugin /mcp /tasks /rewind /diff /chrome
  /terminal-setup /keybindings /scroll-speed /focus /tui /exit /desktop /mobile /teleport /remote-env /remote-control
  /usage-credits /upgrade /powerup /stickers /passes /skills /workflows /voice /btw /background /install-github-app
  /install-slack-app /web-setup /setup-bedrock /setup-vertex /sandbox`.split(/\s+/));

let timer = null;
let running = false;
let fetchedAtMs = 0; // fetch time of the applied feed, 0 when none
let applied = BUNDLED.COMMANDS;

const log = (msg) => console.log(`[commands-feed] ${msg}`);
const fail = (reason) => Object.assign(new Error(reason), { reason });
const feedPath = () => path.join(app.getPath('userData'), FEED_FILE);
const copy = (list) => list.map(({ name, args, desc }) => ({ name, args, desc }));
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// Plain text of a table cell: links reduced to their text, code and bold marks dropped, `\|` unescaped.
const plain = (md) => md.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/`|\*\*/g, '').replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();

// [first cell, rest of the row]: the cell separator is the first unescaped pipe, a later one stays in the purpose.
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const i = body.search(/(?<!\\)\|/);
  return i < 0 ? [body, ''] : [body.slice(0, i), body.slice(i + 1)];
}

// `[{name, args, desc}]` of the `| \`/name args\` | purpose |` rows of the page, in page order. A row naming several
// commands gives one entry each; a row whose purpose starts with « Removed » gives none. Validation is separate.
function parse(md) {
  const out = [];
  for (const line of String(md).split(/\r?\n/)) {
    if (!/^\s*\|\s*`\//.test(line)) continue;
    const [first, purpose] = splitRow(line);
    const desc = plain(purpose.trim().replace(SKILL_PREFIX_RE, ''));
    if (/^Removed\b/.test(desc)) continue;
    for (const m of first.matchAll(/`([^`]*)`/g)) {
      const span = m[1].replace(/\\\|/g, '|').trim();
      if (!span.startsWith('/')) continue;
      const sp = span.search(/\s/);
      out.push({
        name: sp < 0 ? span : span.slice(0, sp),
        args: sp < 0 ? '' : cut(span.slice(sp).trim(), ARGS_MAX),
        desc: cut(desc, DESC_MAX),
      });
    }
  }
  return out;
}

const wellFormed = (e) => !!e && typeof e === 'object' && typeof e.name === 'string' && NAME_RE.test(e.name)
  && typeof e.args === 'string' && e.args.length <= ARGS_MAX
  && typeof e.desc === 'string' && e.desc.length > 0 && e.desc.length <= DESC_MAX;
const isValid = (list) => Array.isArray(list) && list.length >= MIN_ROWS && list.every(wellFormed);

// GET the page: one 10 s deadline over headers and body, body capped at MAX_BODY_BYTES.
async function download() {
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(COMMANDS_URL, { signal: ctl.signal }); } catch (_) {
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

async function save(fetchedAt, commands) {
  const file = feedPath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, fetchedAt, source: 'code.claude.com', commands }));
  await fsp.rename(tmp, file);
}

async function refresh() {
  const text = await download();
  if (/^\s*</.test(text)) throw fail('parse'); // an HTML page, not the markdown source
  const list = parse(text);
  if (!isValid(list)) throw fail('invalid');
  const now = Date.now();
  try { await save(new Date(now).toISOString(), list); } catch (_) { log('store failed'); }
  applied = list;
  fetchedAtMs = now;
}

// Apply the stored list, whatever its age (a failed refresh keeps it); a bad file is ignored.
function loadStored() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(feedPath(), 'utf8')); } catch (err) {
    if (!err || err.code !== 'ENOENT') log('stored feed unreadable');
    return;
  }
  const at = Date.parse(raw && raw.fetchedAt);
  if (!raw || raw.v !== 1 || !Number.isFinite(at) || !isValid(raw.commands)) { log('stored feed invalid'); return; }
  applied = copy(raw.commands);
  fetchedAtMs = at;
}

async function tick() {
  const age = Date.now() - fetchedAtMs;
  if (running || (age >= 0 && age < MAX_AGE_MS)) return;
  running = true;
  try { await refresh(); } catch (err) { log(`refresh failed: ${(err && err.reason) || 'internal'}`); } finally { running = false; }
}

function startCommandsFeed() {
  if (timer) return;
  loadStored();
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

// Copies of the applied list: every command of the page, and the same minus HIDDEN_COMMANDS.
const commandsList = () => copy(applied);
const visibleCommands = () => copy(applied.filter((e) => !HIDDEN_COMMANDS.has(e.name)));

module.exports = { startCommandsFeed, commandsList, visibleCommands, HIDDEN_COMMANDS, _internals: { parse, isValid } };
