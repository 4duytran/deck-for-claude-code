// claude-deck — ipc/commands (B24 lot K-b): the list behind the composer « / » picker. The official
// commands (commands-feed.js, hidden ones already removed) merged with the user's skills and custom
// commands read from disk, READ-ONLY. The session folder comes from main (files-panel sessionRoot),
// never from the renderer. Precedence on one name: project > user > official. Async fs only.
'use strict';

const { ipcMain } = require('electron');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { sessionRoot } = require('./files-panel');
const { visibleCommands } = require('../commands-feed');

const READ_MAX_BYTES = 8 * 1024; // frontmatter is looked for in the first 8 KB only
const TEXT_MAX = 160; // description and argument hint
const DIR_MAX_ENTRIES = 500;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;

const oneLine = (s) => Array.from(String(s).replace(/\s+/g, ' ').trim()).slice(0, TEXT_MAX).join('');

function unquote(v) {
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v[v.length - 1] === q) {
    const inner = v.slice(1, -1);
    return q === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1');
  }
  return v.replace(/\s+#.*$/, '');
}

// Top-level `key: value` pairs of the frontmatter in `text` (a prefix of the file, maybe cut
// mid-line). Plain, quoted and `>` / `|` block scalars; a continuation line is any indented line.
function parseFrontmatter(text, cut) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (cut) lines.pop(); // the last line may be partial
  if (lines[0] === undefined || lines[0].trimEnd() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') break;
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    const rest = [];
    while (i + 1 < lines.length && /^([ \t]|$)/.test(lines[i + 1])) rest.push(lines[++i].trim());
    const head = m[2].trim();
    out[m[1]] = /^[>|][+\-0-9]*$/.test(head) ? rest.join(' ') : unquote([head, ...rest].join(' ').trim());
  }
  return out;
}

// { fm, name } of one regular file (a FIFO would block open()), or null when it cannot be read.
async function readFront(file) {
  let fh;
  try {
    if (!(await fsp.stat(file)).isFile()) return null;
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(READ_MAX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, READ_MAX_BYTES, 0);
    return parseFrontmatter(buf.toString('utf8', 0, bytesRead), bytesRead === READ_MAX_BYTES);
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function toEntry(fm, fallbackName, source) {
  const name = fm.name ? oneLine(fm.name) : fallbackName;
  if (!NAME_RE.test(name) || String(fm['user-invocable']).toLowerCase() === 'false') return null;
  return { name: `/${name}`, args: oneLine(fm['argument-hint'] || ''), desc: oneLine(fm.description || ''), source };
}

async function entriesOf(dir, source) {
  let names;
  try {
    names = (await fsp.readdir(path.join(dir, 'skills'))).sort().slice(0, DIR_MAX_ENTRIES);
  } catch (_) { names = []; }
  const skills = await Promise.all(names.map(async (n) => {
    const fm = await readFront(path.join(dir, 'skills', n, 'SKILL.md'));
    return fm && toEntry(fm, n, source);
  }));
  try {
    names = (await fsp.readdir(path.join(dir, 'commands'))).filter((n) => n.endsWith('.md')).sort().slice(0, DIR_MAX_ENTRIES);
  } catch (_) { names = []; }
  const commands = await Promise.all(names.map(async (n) => {
    const fm = await readFront(path.join(dir, 'commands', n));
    return fm && toEntry(fm, n.slice(0, -3), source);
  }));
  return [...skills, ...commands].filter(Boolean); // a skill beats a command of the same name
}

async function sameDir(a, b) {
  try { return (await fsp.realpath(a)) === (await fsp.realpath(b)); } catch (_) { return false; }
}

async function listCommands(target) {
  const home = path.join(os.homedir(), '.claude');
  const ctx = await sessionRoot(target).catch(() => null);
  const projectDir = ctx ? path.join(ctx.root, '.claude') : null;
  const [user, project] = await Promise.all([
    entriesOf(home, 'user'),
    projectDir && !(await sameDir(projectDir, home)) ? entriesOf(projectDir, 'project') : [],
  ]);
  const disk = new Map();
  for (const e of [...project, ...user]) if (!disk.has(e.name)) disk.set(e.name, e);
  const official = visibleCommands().filter((e) => !disk.has(e.name)).map((e) => ({ ...e, source: 'cli' }));
  return [...official, ...disk.values()].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function registerCommandsIpc() {
  ipcMain.handle('commands-list', async (_e, args) => {
    try {
      return await listCommands({ paneId: args && typeof args.paneId === 'string' ? args.paneId : '' });
    } catch (_) {
      return visibleCommands().map((e) => ({ ...e, source: 'cli' }));
    }
  });
}

module.exports = { registerCommandsIpc };
