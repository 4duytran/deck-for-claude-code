'use strict';
// Per-run history of a plugin: <dataRoot>/<id>/reports/<stem>.{html,log,json} (report, child output, host sidecar).
// Leaf module (node:fs + node:path only), synchronous on purpose: a handful of small files, plain return values.
// Every name that reaches the disk matches ID_RE / STEM_RE, and prune() deletes only regular files of that shape
// whose real parent is the plugin's own reports dir.

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STEM_RE = /^\d{4}-\d{2}-\d{2}T\d{4}(?:-\d+)?$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{4}(?:-\d+)?)\.(html|log|json)$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXTS = ['html', 'log', 'json'];
const TRIGGERS = ['auto', 'manual'];
const MAX_BYTES = 1024 * 1024; // page-scheme.js MAX_BYTES (that module needs electron, a leaf cannot require it)
const SIDECAR_MAX = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { // local calendar day, YYYY-MM-DD (price-feed.js dayOf)
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stemOf = (ms) => {
  const d = new Date(ms);
  return `${dayOf(ms)}T${pad(d.getHours())}${pad(d.getMinutes())}`;
};
const stemStart = (stem) => { // the local start a stem encodes, to the minute
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})/.exec(stem);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
};
const validDay = (s) => {
  const m = typeof s === 'string' ? DAY_RE.exec(s) : null;
  return !!m && dayOf(new Date(+m[1], +m[2] - 1, +m[3]).getTime()) === s;
};
const regularStat = (file) => {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st : null;
  } catch { return null; }
};
const taken = (file) => {
  try { fs.lstatSync(file); return true; } catch { return false; }
};
const goodStem = (stem) => typeof stem === 'string' && STEM_RE.test(stem);

function create(dataRoot, nowFn = Date.now) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('plugin-reports: dataRoot must be an absolute path');
  }
  const now = () => Number(nowFn());

  // The real reports dir of a plugin, or null: bad id, absent, or a symlink leaving <dataRoot>/<id>/reports.
  function reportsDir(id, make) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const dir = path.join(dataRoot, id, 'reports');
    try {
      if (make) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const real = fs.realpathSync(dir);
      return real === path.join(fs.realpathSync(dataRoot), id, 'reports') ? real : null;
    } catch { return null; }
  }

  // Valid sidecar as a normalized object, else null (a corrupt or foreign file is never guessed at).
  function readSidecar(dir, stem) {
    const file = path.join(dir, `${stem}.json`);
    const st = regularStat(file);
    if (!st || st.size > SIDECAR_MAX) return null;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    if (!j || typeof j !== 'object' || !Number.isFinite(j.start) || !TRIGGERS.includes(j.trigger)) return null;
    return {
      start: j.start,
      trigger: j.trigger,
      exit: Number.isInteger(j.exit) ? j.exit : null,
      size: Number.isInteger(j.size) && j.size >= 0 ? j.size : null,
      pid: Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null,
      stopped: j.stopped === true,
    };
  }

  // `stopped` is stored only when true, so an unmarked sidecar keeps its {start, trigger, exit, size, pid} shape.
  function writeSidecar(dir, stem, side) {
    const file = path.join(dir, `${stem}.json`);
    const tmp = `${file}.tmp`;
    const { stopped, ...rest } = side;
    fs.writeFileSync(tmp, JSON.stringify(stopped === true ? { ...rest, stopped: true } : rest), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // One group per stem found in the dir; start = sidecar start, else the minute the stem encodes.
  function groups(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const stemSet = new Set();
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (m) stemSet.add(m[1]);
    }
    return [...stemSet].map((stem) => {
      const side = readSidecar(dir, stem);
      return { stem, side, start: side ? side.start : stemStart(stem) };
    });
  }

  // Start a run: claims a free stem (sidecar created exclusively) and tells where the report / log go.
  function newEntry(id, trigger) {
    if (!TRIGGERS.includes(trigger)) throw new TypeError('plugin-reports: trigger must be auto or manual');
    const dir = reportsDir(id, true);
    if (!dir) throw new Error('plugin-reports: reports directory unavailable');
    const start = now();
    const base = stemOf(start);
    for (let n = 1; n < 1000; n++) {
      const stem = n === 1 ? base : `${base}-${n}`;
      const html = path.join(dir, `${stem}.html`);
      const log = path.join(dir, `${stem}.log`);
      if (taken(html) || taken(log)) continue;
      let fd;
      try {
        fd = fs.openSync(path.join(dir, `${stem}.json`), 'wx', 0o600);
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      try {
        fs.writeSync(fd, JSON.stringify({ start, trigger, exit: null, size: null, pid: null }));
      } finally {
        fs.closeSync(fd);
      }
      return { stem, reportPath: html, logPath: log };
    }
    throw new Error('plugin-reports: no free stem');
  }

  function update(id, stem, change) {
    if (!goodStem(stem)) return false;
    const dir = reportsDir(id, false);
    const side = dir && readSidecar(dir, stem);
    if (!side) return false;
    try {
      writeSidecar(dir, stem, { ...side, ...change(dir) });
      return true;
    } catch { return false; }
  }

  function setPid(id, stem, pid) {
    if (pid !== null && !(Number.isInteger(pid) && pid > 0)) return false;
    return update(id, stem, () => ({ pid }));
  }

  // A user stop of the run: false (no write) on a bad id / stem or an entry without a valid sidecar.
  const markStopped = (id, stem) => update(id, stem, () => ({ stopped: true }));

  // The runner's `{ exit, signal }`: `exit` is an integer code, or null when a signal ended the run.
  function finishEntry(id, stem, { exit }) {
    return update(id, stem, (dir) => {
      const st = regularStat(path.join(dir, `${stem}.html`));
      return { exit: Number.isInteger(exit) ? exit : null, size: st ? st.size : null };
    });
  }

  // Predicate over the local day of an entry's start; null for a filter this module does not know.
  function dayFilter(filter) {
    if (filter === undefined || filter === null) return () => true;
    if (typeof filter !== 'object') return null;
    if (Number.isInteger(filter.days) && filter.days >= 1 && filter.days <= 3660) {
      const t = new Date(now());
      const from = dayOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (filter.days - 1)).getTime());
      return (day) => day >= from;
    }
    if (validDay(filter.date)) return (day) => day === filter.date;
    return null;
  }

  // Entries newest first; filter: undefined (all) | {days: N} (local days, 1 = today) | {date: 'YYYY-MM-DD'}.
  function list(id, filter) {
    const dir = reportsDir(id, false);
    const keep = dayFilter(filter);
    if (!dir || !keep) return [];
    return groups(dir)
      .filter((g) => g.side && keep(dayOf(g.side.start)))
      .map((g) => ({
        stem: g.stem,
        ...g.side,
        hasReport: !!regularStat(path.join(dir, `${g.stem}.html`)),
        hasLog: !!regularStat(path.join(dir, `${g.stem}.log`)),
      }))
      .sort((a, b) => b.start - a.start || (a.stem < b.stem ? 1 : -1));
  }

  const latest = (id) => list(id)[0] || null;

  // Real regular report file of an entry, else null.
  function reportPath(id, stem) {
    const dir = goodStem(stem) ? reportsDir(id, false) : null;
    const file = dir && path.join(dir, `${stem}.html`);
    return file && regularStat(file) ? file : null;
  }

  // {text, truncated}: the last MAX_BYTES of the log, cut on a character boundary; null when there is no log.
  function readLog(id, stem) {
    const dir = goodStem(stem) ? reportsDir(id, false) : null;
    const file = dir && path.join(dir, `${stem}.log`);
    const st = file && regularStat(file);
    if (!st) return null;
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, st.size - len);
      const truncated = st.size > MAX_BYTES;
      let from = 0;
      while (truncated && from < got && (buf[from] & 0xc0) === 0x80) from++; // skip a cut UTF-8 sequence
      return { text: buf.toString('utf8', from, got), truncated };
    } catch { return null; } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // The file to unlink, or null: stem-shaped name, lstat regular file, real parent = the reports dir.
  function removable(dir, name) {
    const file = path.join(dir, name);
    if (!FILE_RE.test(name) || !regularStat(file)) return null;
    try { return fs.realpathSync(path.dirname(file)) === dir ? file : null; } catch { return null; }
  }

  // Removes entries with start < now - days * 24 h (rolling), except keepStems; returns the stems it deleted from.
  function prune(id, days, keepStems = []) {
    const dir = reportsDir(id, false);
    if (!dir || !Number.isInteger(days) || days < 1 || days > 365) return [];
    const keep = new Set(Array.isArray(keepStems) ? keepStems.filter((s) => typeof s === 'string') : []);
    const cutoff = now() - days * DAY_MS;
    const removed = [];
    for (const g of groups(dir)) {
      if (keep.has(g.stem) || !(g.start < cutoff)) continue;
      let gone = 0;
      for (const ext of EXTS) {
        const file = removable(dir, `${g.stem}.${ext}`);
        if (!file) continue;
        try { fs.unlinkSync(file); gone++; } catch { /* a vanished file is already gone */ }
      }
      if (gone) removed.push(g.stem);
    }
    return removed;
  }

  // {count, bytes}: listed entries and the size of every stem-shaped regular file (the delete card).
  function stats(id) {
    const dir = reportsDir(id, false);
    const out = { count: 0, bytes: 0 };
    if (!dir) return out;
    out.count = list(id).length;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* absent dir: zero */ }
    for (const n of names) {
      const st = FILE_RE.test(n) ? regularStat(path.join(dir, n)) : null;
      if (st) out.bytes += st.size;
    }
    return out;
  }

  return { newEntry, setPid, markStopped, finishEntry, list, latest, reportPath, readLog, prune, stats };
}

module.exports = { create, MAX_BYTES };
