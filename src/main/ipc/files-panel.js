// claude-deck — ipc/files-panel (P1-08): read-only file browsing of the ACTIVE
// SESSION's folder for the « Fichiers » tab. The root comes from main (pane
// registry, else the session's own .jsonl), never from the renderer; every
// path is realpath'd and must stay inside the root's realpath. Async fs only.
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ptys } = require('../state');
const { findSessionFile } = require('../transcripts');
const { readSessionMeta } = require('../session-meta');
const { effectiveSessionId } = require('../session-activity');
const { fileKeyOf } = require('../file-key');

const LIST_MAX_ENTRIES = 2000;
const READ_MAX_BYTES = 1024 * 1024; // same cap as plans-panel PLAN_MAX_BYTES
const BINARY_SNIFF_BYTES = 8 * 1024;
const SEARCH_MAX_VISITED = 20000;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules']); // browsable, not searched
const QUERY_MAX_LEN = 200;
const PATH_MAX_LEN = 4096;
const STAT_CHUNK = 128;

// Fixed failure shapes: a stable `code` to branch on, a fixed UI `reason`.
const REASONS = {
  'no-target': 'session introuvable',
  'bad-args': 'requête invalide',
  outside: 'hors du dossier de la session',
  'not-found': 'introuvable',
  'not-dir': 'pas un dossier',
  'not-file': 'pas un fichier',
  io: 'lecture impossible',
};
const fail = (code) => ({ ok: false, code, reason: REASONS[code] });

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/');

async function mapChunks(items, fn) {
  for (let i = 0; i < items.length; i += STAT_CHUNK) {
    await Promise.all(items.slice(i, i + STAT_CHUNK).map(fn));
  }
}

// { root: realpath of the session folder, lexical: its unresolved form } | null
async function sessionRoot(target) {
  const entry = ptys.get(String(target.paneId || ''));
  let cwd = entry && entry.cwd ? entry.cwd : null;
  if (!cwd) {
    const sessionId = effectiveSessionId(target);
    const file = sessionId ? findSessionFile(sessionId) : null;
    if (file) {
      try {
        const meta = await readSessionMeta(file, (await fsp.stat(file)).size);
        if (meta && meta.cwd) cwd = meta.cwd;
      } catch (_) { /* -> null */ }
    }
  }
  if (!cwd) return null;
  try {
    const real = await fsp.realpath(cwd);
    return (await fsp.stat(real)).isDirectory() ? { root: real, lexical: path.resolve(cwd) } : null;
  } catch (_) {
    return null;
  }
}

// rel or absolute input -> realpath inside the root, or { err }. A missing path
// outside the root answers `outside` too, so existence is no oracle for it.
async function resolveInside(ctx, input) {
  if (typeof input !== 'string' || input.length > PATH_MAX_LEN || input.includes('\0')) {
    return { err: fail('bad-args') };
  }
  const lexical = path.resolve(ctx.root, input);
  let real;
  try {
    real = await fsp.realpath(lexical);
  } catch (_) {
    const near = isInside(ctx.root, lexical) || isInside(ctx.lexical, lexical);
    return { err: fail(near ? 'not-found' : 'outside') };
  }
  return isInside(ctx.root, real) ? { real } : { err: fail('outside') };
}

async function listDir(ctx, rel) {
  const r = await resolveInside(ctx, rel == null ? '' : rel);
  if (r.err) return r.err;
  let dirents;
  try {
    dirents = await fsp.readdir(r.real, { withFileTypes: true });
  } catch (e) {
    return fail(e && e.code === 'ENOTDIR' ? 'not-dir' : 'io');
  }
  const items = dirents.map((d) => ({ name: d.name, dir: d.isDirectory(), link: d.isSymbolicLink(), size: 0 }));
  await mapChunks(items.filter((i) => i.link), async (i) => {
    try { i.dir = (await fsp.stat(path.join(r.real, i.name))).isDirectory(); } catch (_) { /* broken link = file */ }
  });
  items.sort((a, b) => (a.dir === b.dir ? byName(a, b) : (a.dir ? -1 : 1)));
  const truncated = items.length > LIST_MAX_ENTRIES;
  const page = truncated ? items.slice(0, LIST_MAX_ENTRIES) : items;
  await mapChunks(page.filter((i) => !i.dir), async (i) => {
    try { i.size = (await fsp.stat(path.join(r.real, i.name))).size; } catch (_) { /* stays 0 */ }
  });
  return {
    ok: true,
    rel: relOf(ctx.root, r.real),
    entries: page.map((i) => ({ name: i.name, dir: i.dir, size: i.size })),
    truncated,
  };
}

async function readFile(ctx, input) {
  const r = await resolveInside(ctx, input);
  if (r.err) return r.err;
  const rel = relOf(ctx.root, r.real);
  const fileKey = fileKeyOf(r.real); // the opaque identity of the file for the ask threads (same helper as plans-get)
  let fh;
  try {
    fh = await fsp.open(r.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = await fh.stat(); // fstat on the open handle: no stat/open race
    if (!st.isFile()) return fail('not-file');
    if (st.size === 0) return { ok: true, rel, size: 0, text: '', fileKey };
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
    const head = (await fh.read(sniff, 0, sniff.length, 0)).bytesRead;
    if (sniff.subarray(0, head).includes(0)) return { ok: true, rel, size: st.size, binary: true, fileKey };
    if (st.size > READ_MAX_BYTES) return { ok: true, rel, size: st.size, tooLarge: true, fileKey };
    const buf = Buffer.alloc(st.size);
    const n = (await fh.read(buf, 0, st.size, 0)).bytesRead;
    return { ok: true, rel, size: st.size, text: buf.subarray(0, n).toString('utf8'), fileKey };
  } catch (_) {
    return fail('io');
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Breadth-first over names; symlinks are never followed (no loop, no escape).
async function searchNames(ctx, query) {
  if (typeof query !== 'string') return fail('bad-args');
  const q = query.trim().toLowerCase();
  if (q.length > QUERY_MAX_LEN) return fail('bad-args');
  const results = [];
  if (!q) return { ok: true, results, truncated: false };
  const queue = [{ abs: ctx.root, rel: '' }];
  let visited = 0;
  let truncated = false;
  for (let qi = 0; qi < queue.length && !truncated; qi++) {
    let dirents;
    try {
      dirents = await fsp.readdir(queue[qi].abs, { withFileTypes: true });
    } catch (_) {
      continue; // unreadable folder: skipped
    }
    dirents.sort(byName);
    for (const d of dirents) {
      if (++visited > SEARCH_MAX_VISITED) { truncated = true; break; }
      const rel = queue[qi].rel ? `${queue[qi].rel}/${d.name}` : d.name;
      const dir = d.isDirectory();
      if (rel.toLowerCase().includes(q)) {
        if (results.length >= SEARCH_MAX_RESULTS) { truncated = true; break; }
        results.push({ rel, dir });
      }
      if (dir && !SEARCH_SKIP_DIRS.has(d.name)) queue.push({ abs: path.join(queue[qi].abs, d.name), rel });
    }
  }
  return { ok: true, results, truncated };
}

// args = { paneId?, sessionId?, ...extra }; any throw collapses to the fixed io shape.
function handle(channel, run) {
  ipcMain.handle(channel, async (_e, args) => {
    try {
      const a = args && typeof args === 'object' ? args : {};
      const ctx = await sessionRoot(a);
      return ctx ? await run(ctx, a) : fail('no-target');
    } catch (_) {
      return fail('io');
    }
  });
}

function registerFilesPanelIpc() {
  handle('files-list', (ctx, a) => listDir(ctx, a.rel));
  handle('files-read', (ctx, a) => readFile(ctx, a.abs || a.rel));
  handle('files-search', (ctx, a) => searchNames(ctx, a.query));
}

module.exports = { registerFilesPanelIpc, sessionRoot };
