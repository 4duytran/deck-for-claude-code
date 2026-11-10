// claude-deck usage estimator (v35, source "B") — reconstructs quota usage
// from the transcripts ~/.claude/projects/**/*.jsonl: the same data source
// Claude-Code-Usage-Monitor reads, with its block rules (verified against
// its analyzer.py):
//   block start = first entry's timestamp floored to the UTC hour;
//   block end   = start + 5h;
//   a new block starts when an entry lands past end OR after a >=5h gap.
// The estimated "limit" is the P90 of completed block totals over the last
// 8 days — a calibration on the user's OWN history, NOT the real server
// limit (which is opaque). Below 3 completed blocks the estimate is
// withheld (p90 = null) rather than wildly wrong.
// Pure Node on purpose (no Electron require): probes run it standalone.
//
// Transcripts are append-only, so a file is read ONCE and then only its new
// bytes: each cache entry keeps the byte offset consumed so far and the
// unterminated tail (`carry`), and a scan after an append reads just
// [offset, size). A 66-160 MB transcript used to be re-read whole after every
// append (100-460 ms of blocked main process on the sync path).
//
// BOUNDED SYNC WORK. A file seen for the first time can be huge (a `claude --resume` fork copies a
// whole 70-190 MB history: ~1.5 ms/MB of blocked main process, and every key passes through main).
// With `syncBudgetBytes` set (the deck passes SYNC_BUDGET_BYTES = 1 MB) one sync scan() consumes at
// most that many UNREAD bytes across ALL files (plus a <= 4 KB anchor probe per grown file); a file
// whose backlog does not fit is queued and ingested through the chunked async path (READ_CHUNK slices,
// the event loop runs between slices, one file at a time). Without the option scan() reads
// everything synchronously, as before (standalone use, probes' "fresh full scan" oracle).
// Freshness: a queued file is ingested into a detached entry and swapped in whole when it settles, so
// compute() keeps returning the previous estimate for it until then; appends that land meanwhile are
// picked up by the same job (it loops until the file's stat stops moving), never read twice. When the
// queue empties, `onDrain` fires once (ipc/usage.js pushes the new payload at once instead of waiting
// for the next 60 s tick); drained() resolves at the same moment. Drain bound: ceil(backlog /
// READ_CHUNK) slices of ~2-3 ms each, i.e. about 1.5-2 ms per MB of wall time, never in one stall.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SESSION_MS = 5 * 3600 * 1000; // one rate-limit window
// Events kept for the usage page (events()) and the mtime skip of the scan. 92 d, not 90: the 90d report
// is local calendar days, so after a DST fall-back its first bucket starts up to an hour before now - 90 d;
// this must cover ipc/usage.js REPORT_LOOKBACK_MS['90d'].
const SCAN_WINDOW_MS = 92 * 24 * 3600 * 1000;
const ESTIMATE_WINDOW_MS = 8 * 24 * 3600 * 1000; // history behind blocks / P90 (Usage Monitor: 192h)
// A file idle this long is settled: its merge `keys` Map is released and its store trimmed; a later append
// rebuilds the keys from the store. Real corpus (90 d, 10187 files, 151655 in-file event gaps): a gap >= 2 d
// is 13 gaps (0.009%) in 4 files, >= 3 d 4 gaps in 3 files, >= 1 d 21 gaps in 5 files.
const SETTLE_MS = 2 * 24 * 3600 * 1000;
const MIN_BLOCKS_FOR_P90 = 3;
const SCAN_CHUNK = 20; // files parsed between event-loop yields (boot scan)
const READ_CHUNK = 1024 * 1024; // bytes per read: bounds memory and each parse slice (~2-3 ms)
const SYNC_BUDGET_BYTES = READ_CHUNK; // unread bytes one budgeted sync scan() may consume in total
// Last consumed bytes, re-read on the next scan to detect an in-place rewrite. 64 B is NOT enough:
// the last bytes of two different usage lines are the same fixed JSON suffix, so a grown-and-rewritten
// file passed as an append (measured by .scratch/usage-incremental-probe.js r3); 4 KB spans several lines.
const ANCHOR_BYTES = 4096;
const NO_BYTES = Buffer.alloc(0);
const REF = 4294967296; // a view ref packs (file index, event index) as file * REF + event

function tokensOf(usage) {
  return (usage.input_tokens || 0) + (usage.output_tokens || 0) +
         (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
}

// Interned strings: one copy per distinct model / session id / project name instead of one per event
// (hundreds of thousands over 90 days). Bounded: a pool that reaches INTERN_MAX restarts empty.
const INTERN_MAX = 20000;
const pool = new Map();
const projByCwd = new Map(); // line-level cwd -> interned basename
function intern(s) {
  if (typeof s !== 'string' || !s) return null;
  const hit = pool.get(s);
  if (hit !== undefined) return hit;
  if (pool.size >= INTERN_MAX) pool.clear();
  pool.set(s, s);
  return s;
}
// Project = basename of the line's own cwd. Never decode the projects/ folder name (lossy encoding).
function projOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let p = projByCwd.get(cwd);
  if (p === undefined) {
    if (projByCwd.size >= INTERN_MAX) projByCwd.clear();
    p = intern(path.basename(cwd));
    projByCwd.set(cwd, p);
  }
  return p;
}

// One file's events, columnar. ONE Float64Array holds, per event, ts tok inp cc5 cc1h cr out and four
// indexes into the file's own `names` table (model sid proj speed; 0 = null): a typed array per column
// costs ~200 B of heap per file and a real history has 10k files. The hash strings stay a plain array:
// the views dedup on them. An event object is only built by at(): events(range), the `events` getter.
const COLS = 11;
class EventStore {
  constructor() { this.n = 0; this.f = new Float64Array(COLS * 4); this.hash = []; this.names = [null]; }

  _name(s) {
    let i = this.names.indexOf(s);
    if (i < 0) { i = this.names.length; this.names.push(s); }
    return i;
  }

  add(ts, tok, hash, model, sid, proj, speed, inp, cc5, cc1h, cr, out) {
    const o = this.n * COLS;
    if (o + COLS > this.f.length) { const g = new Float64Array(Math.max(COLS * 4, this.f.length * 2)); g.set(this.f); this.f = g; }
    const f = this.f;
    f[o] = ts; f[o + 1] = tok;
    this.hash.push(hash);
    this.n++;
    this.setWidened(this.n - 1, model, sid, proj, speed, inp, cc5, cc1h, cr, out);
  }

  setWidened(i, model, sid, proj, speed, inp, cc5, cc1h, cr, out) {
    const f = this.f, o = i * COLS;
    f[o + 2] = inp; f[o + 3] = cc5; f[o + 4] = cc1h; f[o + 5] = cr; f[o + 6] = out;
    f[o + 7] = this._name(model); f[o + 8] = this._name(sid); f[o + 9] = this._name(proj); f[o + 10] = this._name(speed);
  }

  // The event as callers have always seen it: same fields, same order, a fresh object.
  at(i) {
    const f = this.f, o = i * COLS, nm = this.names;
    return { ts: f[o], tok: f[o + 1], hash: this.hash[i], model: nm[f[o + 7]], sid: nm[f[o + 8]], proj: nm[f[o + 9]], speed: nm[f[o + 10]],
             inp: f[o + 2], cc5: f[o + 3], cc1h: f[o + 4], cr: f[o + 5], out: f[o + 6] };
  }

  toArray() {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.at(i);
    return out;
  }

  clone() {
    const c = new EventStore();
    c.n = this.n; c.f = this.f.slice(); c.hash = this.hash.slice(); c.names = this.names.slice();
    return c;
  }

  // Exact-size copies: growth slack is dead weight on a file that no longer grows.
  trim() {
    if (this.f.length > this.n * COLS) this.f = this.f.slice(0, this.n * COLS);
    this.hash = this.hash.slice();
  }
}

// True when event i of `sa` and event j of `sb` agree on every widened field (all but ts / tok / hash).
function widenedEqual(sa, i, sb, j) {
  const a = sa.f, b = sb.f, p = i * COLS, q = j * COLS;
  return a[p + 2] === b[q + 2] && a[p + 3] === b[q + 3] && a[p + 4] === b[q + 4] && a[p + 5] === b[q + 5] && a[p + 6] === b[q + 6] &&
         sa.names[a[p + 7]] === sb.names[b[q + 7]] && sa.names[a[p + 8]] === sb.names[b[q + 8]] &&
         sa.names[a[p + 9]] === sb.names[b[q + 9]] && sa.names[a[p + 10]] === sb.names[b[q + 10]];
}

// Parse transcript text: one event {ts, tok, hash, model, sid, proj, speed, inp, cc5, cc1h, cr, out}
// per message.id:requestId key (per line when a line lacks an id) carrying real usage, added to `store`.
// Malformed lines are skipped, never fatal. The indexOf pre-filter skips the (majority of) lines without a
// usage block cheaply. B-U1, merged HERE so one key is one event in this file however its lines arrive:
// ts / tok / hash from the FIRST line (the P90 gauge's), the widened fields from the LAST (streaming grows
// them). `keys` (hash -> index in `store`) is the entry's merge state across calls; keys spanning two
// files are left to the views. `tok` is the all-types sum the P90 gauge uses.
function parseLines(text, store, keys) {
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    const msg = entry.message;
    if (!msg || !msg.usage || !entry.timestamp) continue;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    const u = msg.usage;
    const tok = tokensOf(u);
    if (tok <= 0) continue;
    // dedup key: the same API turn can appear in several files (resume forks).
    // Without both ids the entry stays un-deduplicatable -> hash null.
    const mid = msg.id || null;
    const rid = entry.requestId || entry.request_id || null;
    // cache writes: a split object prices its 1h part apart; whatever it leaves out of the
    // total, and an unsplit total, stays at the 5m rate
    const ccAll = u.cache_creation_input_tokens || 0;
    const cc = u.cache_creation;
    let cc5 = ccAll, cc1h = 0;
    if (cc && typeof cc === 'object') {
      cc1h = cc.ephemeral_1h_input_tokens || 0;
      cc5 = Math.max(cc.ephemeral_5m_input_tokens || 0, ccAll - cc1h);
    }
    // join() builds a flat string; a template literal would keep a cons-string pinning both ids
    const hash = mid && rid ? [mid, rid].join(':') : null;
    const model = intern(msg.model), sid = intern(entry.sessionId), proj = projOf(entry.cwd), speed = intern(u.speed);
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, out = u.output_tokens || 0;
    if (hash) {
      const i = keys.get(hash);
      if (i !== undefined) { store.setWidened(i, model, sid, proj, speed, inp, cc5, cc1h, cr, out); continue; }
      keys.set(hash, store.n);
    }
    store.add(ts, tok, hash, model, sid, proj, speed, inp, cc5, cc1h, cr, out);
  }
}

// First index of `ts` (sorted ascending) whose value is >= t.
function lowerBound(ts, t) {
  let lo = 0, hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// One-shot parse of a whole file (the estimator itself no longer uses it: it
// goes through feed()). A last line without its newline is parsed too.
function parseTranscript(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const store = new EventStore();
  parseLines(raw, store, new Map());
  return store.toArray();
}

// ---- incremental cache entry ----------------------------------------------
// { mtimeMs, size }  the stat the entry was settled on (the scan gate)
// { offset }         bytes of the file consumed so far (events + carry)
// { carry }          bytes after the last '\n' consumed: a line still being written
// { anchor }         the last <=ANCHOR_BYTES consumed bytes
// { store }          the parsed events of every complete line, one per message.id:requestId key
// { keys }           hash -> index in `store`: the in-file merge state; null once the file is settled
// { events }         getter: the store as an array of event objects (probes and tests read it)
class FileEntry {
  constructor() {
    this.mtimeMs = -1; this.size = 0; this.offset = 0; this.carry = NO_BYTES; this.anchor = NO_BYTES;
    this.store = new EventStore(); this.keys = new Map();
  }
  get events() { return this.store.toArray(); }
  clone() {
    const c = Object.assign(new FileEntry(), this);
    c.store = this.store.clone();
    c.keys = this.keys ? new Map(this.keys) : null;
    return c;
  }
}

function newEntry() { return new FileEntry(); }

// The merge state of a settled file is rebuilt from its store when an append arrives.
function ensureKeys(entry) {
  if (entry.keys) return;
  entry.keys = new Map();
  const h = entry.store.hash;
  for (let i = 0; i < entry.store.n; i++) if (h[i]) entry.keys.set(h[i], i);
}

function releaseIfSettled(entry, nowMs) {
  if (!entry.keys || entry.mtimeMs < 0 || entry.mtimeMs >= nowMs - SETTLE_MS) return;
  entry.keys = null;
  entry.store.trim();
}

function tailBytes(prev, buf) {
  if (buf.length >= ANCHOR_BYTES) return Buffer.from(buf.subarray(buf.length - ANCHOR_BYTES));
  const all = Buffer.concat([prev, buf]);
  return all.length > ANCHOR_BYTES ? all.subarray(all.length - ANCHOR_BYTES) : all;
}

// Consume freshly read bytes: every complete line becomes events, the
// unterminated tail stays in `carry` until its newline arrives. The cut is on
// the 0x0a BYTE, which never occurs inside a multi-byte UTF-8 sequence, so a
// character split across two reads is decoded whole (never U+FFFD).
function feed(entry, buf) {
  const data = entry.carry.length ? Buffer.concat([entry.carry, buf]) : buf;
  const cut = data.lastIndexOf(0x0a);
  if (cut === -1) {
    entry.carry = data === buf ? Buffer.from(buf) : data;
  } else {
    ensureKeys(entry); // a settled entry (or one swept during a drain) has no merge state yet
    parseLines(data.toString('utf8', 0, cut), entry.store, entry.keys);
    entry.carry = Buffer.from(data.subarray(cut + 1)); // copy: do not pin the read buffer
  }
  entry.offset += buf.length;
  entry.anchor = tailBytes(entry.anchor, buf);
}

// Bring `entry` up to `size` bytes by reading [entry.offset, size) in
// READ_CHUNK slices. Returns false when the bytes already consumed are no
// longer the file's (rewritten in place): the caller re-parses from byte 0.
// A short read (file shrank under us) just stops; _settle() then marks the
// entry for a re-check on the next scan.
function ingestSync(fp, entry, size) {
  const fd = fs.openSync(fp, 'r');
  try {
    if (entry.offset > 0) {
      const probe = Buffer.alloc(entry.anchor.length);
      const got = fs.readSync(fd, probe, 0, probe.length, entry.offset - probe.length);
      if (got !== probe.length || !probe.equals(entry.anchor)) return false;
    }
    // one read buffer for the whole call: feed() copies whatever it keeps
    const buf = Buffer.allocUnsafe(Math.max(0, Math.min(READ_CHUNK, size - entry.offset)));
    while (entry.offset < size) {
      const want = Math.min(buf.length, size - entry.offset);
      const got = fs.readSync(fd, buf, 0, want, entry.offset);
      if (got <= 0) break;
      feed(entry, got === buf.length ? buf : buf.subarray(0, got));
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// Same as ingestSync on the threadpool: awaiting between slices keeps the
// event loop free during a cold full parse of a big transcript.
async function ingestAsync(fp, entry, size) {
  const fh = await fsp.open(fp, 'r');
  try {
    if (entry.offset > 0) {
      const probe = Buffer.alloc(entry.anchor.length);
      const { bytesRead } = await fh.read(probe, 0, probe.length, entry.offset - probe.length);
      if (bytesRead !== probe.length || !probe.equals(entry.anchor)) return false;
    }
    const buf = Buffer.allocUnsafe(Math.max(0, Math.min(READ_CHUNK, size - entry.offset)));
    while (entry.offset < size) {
      const want = Math.min(buf.length, size - entry.offset);
      const { bytesRead } = await fh.read(buf, 0, want, entry.offset);
      if (bytesRead <= 0) break;
      feed(entry, bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    return true;
  } finally {
    await fh.close();
  }
}

class UsageEstimator {
  // opts.syncBudgetBytes: cap on the unread bytes one sync scan() consumes (default Infinity = no cap)
  // opts.onDrain: called (no argument) each time the queued backlog has been fully ingested
  constructor(projectsDir, opts = {}) {
    this.projectsDir = projectsDir;
    this.files = new Map(); // path -> incremental entry (see FileEntry)
    this.syncBudgetBytes = opts.syncBudgetBytes === undefined ? Infinity : opts.syncBudgetBytes;
    this.onDrain = opts.onDrain || null;
    this.pending = new Map(); // path -> queued job { latest: {mtimeMs,size}, cancelled }
    this._queue = []; // paths in arrival order
    this._draining = false;
    this._waiters = []; // drained() resolvers
    this._version = 0; // bumped on every change of a file's events (the sorted-view cache key)
    this._nowMs = Date.now(); // the clock of the latest scan: a file idle for SETTLE_MS before it is settled
    this._view = null; // cached { version, cutoff, ts, tok, blocks, lastActivityMs }: the 8 d estimate view
    this._full = null; // cached { version, cutoff, stores, ts, first, wide }: the 92 d (SCAN_WINDOW_MS) deduped events, built by events()
  }

  // List candidate transcripts with their stats. RECURSIVE walk: subagent
  // transcripts live in <dir>/<sessionId>/subagents/agent-*.jsonl and burn
  // quota too (measured: ~2/3 of the recent files on a dispatch-heavy rig).
  // Files older than the scan window cannot contain in-window entries.
  _candidates(nowMs) {
    const cutoff = nowMs - SCAN_WINDOW_MS;
    const out = [];
    const stack = [this.projectsDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of entries) {
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(fp); continue; }
        if (!ent.name.endsWith('.jsonl')) continue;
        let st;
        try { st = fs.statSync(fp); } catch (_) { continue; }
        if (st.mtimeMs < cutoff) continue;
        out.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    return out;
  }

  // Incremental scan: read only the bytes appended to files whose (mtime,size)
  // moved (a full parse for a file seen for the first time, truncated, or
  // rewritten), drop the aged-out ones. Returns true when anything changed.
  // Synchronous — cheap in steady state (stats + the appended bytes); with
  // syncBudgetBytes set it never reads more than that many unread bytes (the rest is
  // queued for the async drain, see the header). Use scanAsync() for the cold boot
  // pass. Do not run the two concurrently.
  scan(nowMs = Date.now()) {
    this._nowMs = nowMs;
    return this._applyScan(this._candidates(nowMs), null);
  }

  // Cold-boot variant: same result, but reads through the threadpool in 1 MB
  // slices and yields to the event loop every SCAN_CHUNK files, so a 40+ MB
  // first pass never freezes Electron.
  async scanAsync(nowMs = Date.now()) {
    this._nowMs = nowMs;
    return this._applyScan(this._candidates(nowMs), () =>
      new Promise((resolve) => setImmediate(resolve)));
  }

  // The entry to fill for a file now `size` bytes long: the cached one when
  // the file only GREW (read just the new bytes), else a blank one (first
  // sight, shrunk, or same size under a new mtime = rewritten: full parse).
  _entryFor(fp, size) {
    const cached = this.files.get(fp);
    return cached && size > cached.size ? cached : newEntry();
  }

  // Stamp the entry with the stat it was filled from. An entry that did not
  // reach `size` (unreadable file, short read) gets an impossible mtime so the
  // next scan looks at it again instead of trusting a partial parse.
  _settle(fp, entry, mtimeMs, size) {
    entry.size = size;
    entry.mtimeMs = entry.offset === size ? mtimeMs : -1;
    releaseIfSettled(entry, this._nowMs);
    this.files.set(fp, entry);
    this._version++;
  }

  // Sync refresh within `budget` unread bytes. A backlog that does not fit (first sight of a big
  // file, a big append, or a rewrite that needs a full re-parse) is queued for the async drain
  // instead; nothing is read for it here. Returns the unread bytes consumed.
  _refreshSync(fp, mtimeMs, size, budget) {
    let entry = this._entryFor(fp, size);
    let base = entry.offset;
    if (size - base > budget) { this._enqueue(fp, mtimeMs, size); return 0; }
    try {
      ensureKeys(entry);
      if (!ingestSync(fp, entry, size)) { // rewritten in place: only a full re-parse is right
        if (size > budget) { this._enqueue(fp, mtimeMs, size); return 0; }
        entry = newEntry(); base = 0;
        ingestSync(fp, entry, size);
      }
    } catch (_) { /* unreadable or vanished: settle on what was consumed */ }
    this._settle(fp, entry, mtimeMs, size);
    return entry.offset - base;
  }

  _enqueue(fp, mtimeMs, size) {
    this.pending.set(fp, { latest: { mtimeMs, size }, cancelled: false });
    this._queue.push(fp);
    if (!this._draining) this._drain();
  }

  // Sequential drain of the queued files through _refreshAsync (detached entries, 1 MB slices, the
  // event loop free between slices and between files). A job re-runs while the file keeps moving:
  // each pass reads [entry.offset, stat size), so appends arriving during the drain are consumed
  // exactly once and in order. Never rejects.
  async _drain() {
    this._draining = true;
    try {
      while (this._queue.length) {
        const fp = this._queue.shift();
        const job = this.pending.get(fp);
        if (!job) continue; // cancelled and not re-queued
        let done = job.latest;
        for (;;) {
          await this._refreshAsync(fp, done.mtimeMs, done.size, job);
          if (job.cancelled) break;
          const l = job.latest;
          if (l.mtimeMs === done.mtimeMs && l.size === done.size) break;
          done = l;
        }
        if (this.pending.get(fp) === job) this.pending.delete(fp);
        if (this._queue.length) await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (_) { /* a failed job must not wedge the queue */ }
    this._draining = false;
    if (this.pending.size === 0) {
      const waiters = this._waiters; this._waiters = [];
      for (const w of waiters) w();
      if (this.onDrain) { try { this.onDrain(); } catch (_) { /* a listener must not break the estimator */ } }
    }
  }

  // Resolves when no queued file is left (immediately when none is).
  drained() {
    if (this.pending.size === 0 && !this._draining) return Promise.resolve();
    return new Promise((resolve) => { this._waiters.push(resolve); });
  }

  async _refreshAsync(fp, mtimeMs, size, job = null) {
    let entry = this._entryFor(fp, size);
    // a detached copy: nothing half-built is visible while a read is awaited
    if (entry.offset > 0) { entry = entry.clone(); ensureKeys(entry); }
    try {
      if (!(await ingestAsync(fp, entry, size))) { entry = newEntry(); await ingestAsync(fp, entry, size); }
    } catch (_) { /* unreadable or vanished: settle on what was consumed */ }
    if (job && job.cancelled) return; // the file aged out while it was being read
    this._settle(fp, entry, mtimeMs, size);
  }

  _applyScan(candidates, yieldFn) {
    const seen = new Set();
    const work = [];
    let changed = false;
    for (const { fp, mtimeMs, size } of candidates) {
      seen.add(fp);
      const pend = this.pending.get(fp);
      if (pend) { pend.latest = { mtimeMs, size }; continue; } // queued: its drain follows the file
      const cached = this.files.get(fp);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;
      work.push({ fp, mtimeMs, size });
    }
    for (const fp of this.files.keys()) {
      if (!seen.has(fp)) { this.files.delete(fp); this._version++; changed = true; }
    }
    for (const [fp, job] of this.pending) {
      if (!seen.has(fp)) { job.cancelled = true; this.pending.delete(fp); changed = true; }
    }
    if (!yieldFn) {
      let budget = this.syncBudgetBytes;
      for (const { fp, mtimeMs, size } of work) budget -= this._refreshSync(fp, mtimeMs, size, budget);
      this._releaseSettled();
      return changed || work.length > 0;
    }
    return (async () => {
      let parsed = 0;
      for (const { fp, mtimeMs, size } of work) {
        await this._refreshAsync(fp, mtimeMs, size);
        if (++parsed % SCAN_CHUNK === 0) await yieldFn();
      }
      this._releaseSettled();
      return changed || work.length > 0;
    })();
  }

  // Files nobody touched aged into "settled" with the clock: release them too, not only the ones just read.
  _releaseSettled() {
    for (const entry of this.files.values()) releaseIfSettled(entry, this._nowMs);
  }

  // The window-filtered, de-duplicated, time-sorted events and the 5h blocks built from them: the
  // O(n log n) part of compute() (4-7 ms on a real 85k-event history), which a statusline export with
  // nothing new used to repeat. Cached under the ingest version; the clock only enters through the
  // window cutoff (nowMs - ESTIMATE_WINDOW_MS), so the cache serves a later cutoff as long as no cached
  // event fell out of the window (ts[0] >= cutoff: the event set and the dedup winners are then
  // exactly what a fresh build at that cutoff gives) and rebuilds for an earlier one. The block
  // list does not depend on nowMs; which block is "active" and the P90 do, and stay in compute().
  // First-wins dedup inside the 8 d window, as before the 90 d scan window existed. Only ts / tok are
  // kept (sorted Float64Arrays): that is all the gauges read.
  _sortedView(nowMs) {
    const cutoff = nowMs - ESTIMATE_WINDOW_MS;
    const v = this._view;
    if (v && v.version === this._version && cutoff >= v.cutoff && (v.ts.length === 0 || v.ts[0] >= cutoff)) return v;
    const tsA = [], tokA = [];
    const seen = new Set();
    for (const { store, mtimeMs } of this.files.values()) {
      // the 90 d scan keeps files the 8 d window never read: a settled file untouched since before it holds nothing in it
      if (mtimeMs >= 0 && mtimeMs < cutoff) continue;
      const f = store.f, h = store.hash;
      for (let i = 0; i < store.n; i++) {
        const t = f[i * COLS];
        if (t < cutoff) continue;
        if (h[i]) {
          if (seen.has(h[i])) continue;
          seen.add(h[i]);
        }
        tsA.push(t); tokA.push(f[i * COLS + 1]);
      }
    }
    const order = Uint32Array.from(tsA.keys()).sort((a, b) => tsA[a] - tsA[b] || a - b);
    const ts = new Float64Array(order.length), tok = new Float64Array(order.length);
    for (let k = 0; k < order.length; k++) { ts[k] = tsA[order[k]]; tok[k] = tokA[order[k]]; }

    const blocks = [];
    let cur = null;
    for (let k = 0; k < ts.length; k++) {
      if (!cur || ts[k] >= cur.endMs || (ts[k] - cur.lastTs) >= SESSION_MS) {
        const start = new Date(ts[k]);
        start.setUTCMinutes(0, 0, 0); // Usage Monitor: floor to the UTC hour
        cur = { startMs: start.getTime(), endMs: start.getTime() + SESSION_MS, tokens: 0, lastTs: ts[k] };
        blocks.push(cur);
      }
      cur.tokens += tok[k];
      cur.lastTs = ts[k];
    }
    this._view = { version: this._version, cutoff, ts, tok, blocks, lastActivityMs: ts.length ? ts[ts.length - 1] : null };
    return this._view;
  }

  // Bumped on every change of the ingested events: the cache key of whoever aggregates events().
  get version() { return this._version; }

  // Read-only accessor for the usage page: de-duplicated events of the 90 d scan window, sorted by ts,
  // within [range.fromMs, range.toMs) (each bound optional). B-U1: ts / tok / hash come from the FIRST
  // line of a message.id:requestId key (P90 gauge unchanged), the widened fields from its LAST line (the
  // first streamed line is never the final one). A fresh array of fresh event objects, built for the range only.
  events(range = {}, nowMs = Date.now()) {
    const v = this._fullView(nowMs);
    const lo = range.fromMs === undefined ? 0 : lowerBound(v.ts, range.fromMs);
    const hi = range.toMs === undefined ? v.ts.length : lowerBound(v.ts, range.toMs);
    const out = [];
    for (let k = lo; k < hi; k++) {
      const a = v.first[k], w = v.wide[k];
      const sa = v.stores[Math.floor(a / REF)], ia = a % REF;
      const ev = sa.at(ia);
      if (w !== a) { // the widened fields of the latest differing copy
        const sw = v.stores[Math.floor(w / REF)], x = sw.at(w % REF);
        ev.model = x.model; ev.sid = x.sid; ev.proj = x.proj; ev.speed = x.speed;
        ev.inp = x.inp; ev.cc5 = x.cc5; ev.cc1h = x.cc1h; ev.cr = x.cr; ev.out = x.out;
      }
      out.push(ev);
    }
    return out;
  }

  // Lazy (the gauges never pay for it) and cached under the ingest version, same cutoff rule as _sortedView.
  // Compact: per deduped event its ts and the refs of the copy that wins ts / tok / hash and of the copy
  // whose widened fields win; no event object is retained.
  _fullView(nowMs) {
    const cutoff = nowMs - SCAN_WINDOW_MS;
    const v = this._full;
    if (v && v.version === this._version && cutoff >= v.cutoff && (v.ts.length === 0 || v.ts[0] >= cutoff)) return v;
    const stores = [];
    const tsA = [], firstA = [], wideA = [];
    const at = new Map(); // hash -> slot in the arrays above
    for (const { store } of this.files.values()) {
      const fi = stores.push(store) - 1;
      const f = store.f, h = store.hash;
      for (let i = 0; i < store.n; i++) {
        const t = f[i * COLS];
        if (t < cutoff) continue;
        const ref = fi * REF + i;
        if (h[i]) {
          const slot = at.get(h[i]);
          if (slot !== undefined) {
            // an identical copy (resume fork) changes nothing; a differing one becomes the widened source
            const w = wideA[slot];
            if (!widenedEqual(stores[Math.floor(w / REF)], w % REF, store, i)) wideA[slot] = ref;
            continue;
          }
          at.set(h[i], tsA.length);
        }
        tsA.push(t); firstA.push(ref); wideA.push(ref);
      }
    }
    const order = Uint32Array.from(tsA.keys()).sort((a, b) => tsA[a] - tsA[b] || a - b);
    const ts = new Float64Array(order.length), first = new Float64Array(order.length), wide = new Float64Array(order.length);
    for (let k = 0; k < order.length; k++) { ts[k] = tsA[order[k]]; first[k] = firstA[order[k]]; wide[k] = wideA[order[k]]; }
    this._full = { version: this._version, cutoff, stores, ts, first, wide };
    return this._full;
  }

  // Aggregate the cached events into 5h blocks + P90 + activity markers. The returned `blocks` /
  // `active` are shared with later calls while nothing was ingested: read them, never mutate them.
  compute(nowMs = Date.now()) {
    const { ts, tok, blocks, lastActivityMs } = this._sortedView(nowMs);
    const last = blocks[blocks.length - 1];
    const active = last && nowMs < last.endMs ? last : null;
    const completed = active ? blocks.slice(0, -1) : blocks;
    let p90 = null;
    if (completed.length >= MIN_BLOCKS_FOR_P90) {
      const totals = completed.map((b) => b.tokens).sort((a, b) => a - b);
      // linear-interpolated 90th percentile — the naive ceil-index formula
      // degenerates to max() for every n <= 10 (the common case on an 8-day
      // window), silently turning the scale into the user's single peak
      // burst and under-reporting estimated %. Interpolation keeps it a
      // real percentile even on small histories.
      const rank = 0.9 * (totals.length - 1);
      const lo = Math.floor(rank);
      p90 = lo + 1 < totals.length
        ? totals[lo] + (totals[lo + 1] - totals[lo]) * (rank - lo)
        : totals[lo];
    }
    return {
      blocks,
      active,
      p90,
      lastActivityMs,
      // tokens consumed strictly after a given instant (anchored-mode delta)
      tokensSince(sinceMs) {
        let t = 0;
        for (let k = 0; k < ts.length; k++) if (ts[k] > sinceMs) t += tok[k];
        return t;
      },
    };
  }
}

module.exports = { UsageEstimator, parseTranscript, tokensOf, SESSION_MS, SCAN_WINDOW_MS, ESTIMATE_WINDOW_MS, SYNC_BUDGET_BYTES };
