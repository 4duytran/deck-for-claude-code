// plugin-reports probe — daily-brief S1c (AMD-2, D15-D17, fold v4.2 #1 / #5, v4.3 #7 / #17).
// Hermetic gates of src/main/plugin-reports.js on a fake clock: one entry per run, `-2` on collision, a failed run
// with its log, sidecar pid, local-calendar-day filters, retention that deletes older entries only, tail-capped log.
// Everything lives under one mkdtemp dir; the only delete is the removal of that dir at the end.
//
// Run: xvfb-run -a node_modules/.bin/electron test/plugin-reports-probe.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-reports-probe-'));
const DATA = path.join(ROOT, 'plugin-data');
const OUT = path.join(ROOT, 'outside');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(OUT, 'old'), { recursive: true });

const results = [];
let failed = 0;
function gate(name, ok, detail) {
  if (!ok) failed++;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}
const T = (y, m, d, hh, mi) => new Date(y, m - 1, d, hh, mi).getTime(); // local time
const J = (v) => JSON.stringify(v);
const REAL_DATA = fs.realpathSync(DATA);
const dirOf = (id) => path.join(REAL_DATA, id, 'reports');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

let clock = T(2026, 11, 2, 9, 0);
let R;

// One run at a fake instant: log / report written as the runner / plugin would, exit recorded when given.
function mk(id, at, o = {}) {
  clock = at;
  const e = R.newEntry(id, o.trigger || 'manual');
  if (o.log !== undefined) fs.writeFileSync(e.logPath, o.log);
  if (o.html !== undefined) fs.writeFileSync(e.reportPath, o.html);
  if ('exit' in o) R.finishEntry(id, e.stem, { exit: o.exit });
  return e;
}
const stems = (list) => list.map((e) => e.stem);

function seedRet(id) { // retention fixture: now = 2026-11-02 12:00, window 7 days -> cutoff 2026-10-26 12:00
  const f = { html: '<p>r</p>', log: 'log', exit: 0 };
  const E = {
    A: mk(id, T(2026, 10, 26, 11, 59), f),                       // 1 min older than the window
    B: mk(id, T(2026, 10, 26, 12, 1), f),                        // 1 min inside the window
    C: mk(id, T(2026, 10, 20, 8, 0), { html: '<p>c</p>', log: 'log' }), // old, still running (exit null)
    D: mk(id, T(2026, 10, 10, 8, 0), f),
    E: mk(id, T(2026, 11, 2, 11, 0), f),
  };
  clock = T(2026, 11, 2, 12, 0);
  return E;
}
const triple = (id, stem) => ['html', 'log', 'json'].map((x) => exists(path.join(dirOf(id), `${stem}.${x}`)));

async function run() {
  const { create, MAX_BYTES } = require(path.join(__dirname, '..', 'src', 'main', 'plugin-reports.js'));
  R = create(DATA, () => clock);

  // g1 — N runs -> N entries, newest first, stem = local start minute, one sidecar each (D15)
  const e1 = mk('runs', T(2026, 11, 2, 9, 0), { html: '<p>1</p>', log: 'l1', exit: 0, trigger: 'auto' });
  const e2 = mk('runs', T(2026, 11, 2, 9, 1), { html: '<p>22</p>', log: 'l2', exit: 0 });
  const e3 = mk('runs', T(2026, 11, 2, 9, 2), { log: 'boom', exit: 3 });
  const l1 = R.list('runs');
  gate('g1 N runs -> N entries (D15)',
    l1.length === 3 && J(stems(l1)) === J([e3.stem, e2.stem, e1.stem]) && e1.stem === '2026-11-02T0900'
      && [e1, e2, e3].every((e) => exists(path.join(dirOf('runs'), `${e.stem}.json`))),
    `n=${l1.length} stems=${J(stems(l1))} e1=${e1.stem}`);

  // g2 — same minute -> -2, -3
  clock = T(2026, 11, 2, 9, 5);
  const c = [R.newEntry('coll', 'manual'), R.newEntry('coll', 'manual'), R.newEntry('coll', 'auto')];
  gate('g2 collision -> -2, -3',
    J(c.map((x) => x.stem)) === J(['2026-11-02T0905', '2026-11-02T0905-2', '2026-11-02T0905-3'])
      && R.list('coll').length === 3 && new Set(c.map((x) => x.reportPath)).size === 3,
    `stems=${J(c.map((x) => x.stem))} listed=${R.list('coll').length}`);

  // g3 — failed run is an entry with its log; a good run carries its report size
  const f3 = l1.find((e) => e.stem === e3.stem);
  const ok1 = l1.find((e) => e.stem === e1.stem);
  gate('g3 failed entry has its log (D15)',
    f3.exit === 3 && f3.hasLog && !f3.hasReport && f3.size === null && R.readLog('runs', e3.stem).text === 'boom'
      && ok1.exit === 0 && ok1.hasReport && ok1.size === Buffer.byteLength('<p>1</p>') && ok1.trigger === 'auto',
    `failed=${J(f3)} ok=${J(ok1)}`);

  // g4 — sidecar pid (v4.2 #5 / v4.3 #17)
  const p = mk('pid', T(2026, 11, 2, 8, 0), { log: 'x' });
  const p0 = R.list('pid')[0];
  const setOk = R.setPid('pid', p.stem, 4242);
  const bad = [R.setPid('pid', p.stem, -1), R.setPid('pid', p.stem, 1.5), R.setPid('pid', p.stem, '7')];
  const p1 = R.list('pid')[0];
  const side = JSON.parse(fs.readFileSync(path.join(dirOf('pid'), `${p.stem}.json`), 'utf8'));
  R.finishEntry('pid', p.stem, { exit: 0 });
  const p2 = R.latest('pid');
  gate('g4 pid in sidecar and entries',
    p0.pid === null && p0.exit === null && setOk === true && bad.every((x) => x === false) && p1.pid === 4242
      && side.pid === 4242 && p2.pid === 4242 && p2.exit === 0
      && J(Object.keys(side).sort()) === J(['exit', 'pid', 'size', 'start', 'trigger']),
    `p0.pid=${p0.pid} set=${setOk} bad=${J(bad)} p1.pid=${p1.pid} p2=${J(p2)} keys=${J(Object.keys(side))}`);

  // g5 — filters = local calendar days (D16, v4.2 #1): clock 00:01
  const a = mk('filt', T(2026, 11, 2, 0, 1), { log: 'a', exit: 0 });
  const b = mk('filt', T(2026, 11, 1, 23, 59), { log: 'b', exit: 0 });
  const c7 = mk('filt', T(2026, 10, 27, 0, 0), { log: 'c', exit: 0 }); // today - 6 days
  const d = mk('filt', T(2026, 10, 26, 23, 59), { log: 'd', exit: 0 }); // today - 7: out of 7 j (a rolling window keeps it)
  const e = mk('filt', T(2026, 10, 4, 0, 0), { log: 'e', exit: 0 });   // today - 29
  const f = mk('filt', T(2026, 10, 3, 23, 59), { log: 'f', exit: 0 }); // today - 30: out of 30 j
  clock = T(2026, 11, 2, 0, 1);
  const got = (flt) => J(stems(R.list('filt', flt)));
  const want = (...xs) => J(xs.map((x) => x.stem));
  gate('g5a 1 j = today only: 23:59 yesterday out, 00:01 today in',
    got({ days: 1 }) === want(a), `1j=${got({ days: 1 })} want=${want(a)}`);
  gate('g5b 7 j = today - 6 days', got({ days: 7 }) === want(a, b, c7), `7j=${got({ days: 7 })}`);
  gate('g5c 30 j = today - 29 days', got({ days: 30 }) === want(a, b, c7, d, e), `30j=${got({ days: 30 })}`);
  gate('g5d exact date + no filter + invalid filters',
    got({ date: '2026-11-01' }) === want(b) && got({ date: '2026-11-02' }) === want(a) && got({ date: '2026-10-26' }) === want(d)
      && got() === want(a, b, c7, d, e, f) && got({ date: '2026-02-30' }) === '[]' && got({ days: 0 }) === '[]' && got({ x: 1 }) === '[]',
    `11-01=${got({ date: '2026-11-01' })} all=${R.list('filt').length} bad=${got({ date: '2026-02-30' })},${got({ days: 0 })}`);

  // g6 — retention (D17): older entries only, keepStems survives, outside files and outward symlinks untouched
  const E = seedRet('ret');
  seedRet('ret2');
  const r3 = seedRet('ret3');
  fs.writeFileSync(path.join(OUT, 'target.txt'), 'outside-target');
  fs.writeFileSync(path.join(OUT, 'target2.html'), 'outside-target2');
  fs.writeFileSync(path.join(OUT, 'old', '2026-01-01T0900.log'), 'outside-old');
  fs.writeFileSync(path.join(dirOf('ret'), 'notes.txt'), 'user note');
  fs.writeFileSync(path.join(REAL_DATA, 'ret', 'state.db'), 'plugin data');
  fs.symlinkSync(path.join(OUT, 'target.txt'), path.join(dirOf('ret'), '2026-10-01T0900.log'));
  fs.symlinkSync(path.join(OUT, 'target2.html'), path.join(dirOf('ret'), '2026-10-01T0900.html'));
  fs.mkdirSync(path.join(dirOf('ret'), '2026-10-02T0900.json'));
  const removed = R.prune('ret', 7, [E.C.stem]);
  gate('g6a prune removes older entries only (all 3 files)',
    J([...removed].sort()) === J([E.A.stem, E.D.stem].sort())
      && [E.A, E.D].every((x) => J(triple('ret', x.stem)) === J([false, false, false]))
      && [E.B, E.C, E.E].every((x) => J(triple('ret', x.stem)) === J([true, true, true])),
    `removed=${J(removed)} A=${J(triple('ret', E.A.stem))} D=${J(triple('ret', E.D.stem))} B=${J(triple('ret', E.B.stem))}`);
  const removed2 = R.prune('ret2', 7);
  gate('g6b keepStems keeps a stem older than the window (v4.3 #7), and is not vacuous',
    J(triple('ret', E.C.stem)) === J([true, true, true]) && removed2.includes(E.C.stem) && removed2.length === 3,
    `kept(ret)=${J(triple('ret', E.C.stem))} removed(ret2)=${J(removed2)}`);
  gate('g6c outside file, outward symlinks, odd names untouched',
    fs.readFileSync(path.join(OUT, 'target.txt'), 'utf8') === 'outside-target'
      && fs.readFileSync(path.join(OUT, 'target2.html'), 'utf8') === 'outside-target2'
      && fs.lstatSync(path.join(dirOf('ret'), '2026-10-01T0900.log')).isSymbolicLink()
      && fs.lstatSync(path.join(dirOf('ret'), '2026-10-01T0900.html')).isSymbolicLink()
      && fs.lstatSync(path.join(dirOf('ret'), '2026-10-02T0900.json')).isDirectory()
      && exists(path.join(dirOf('ret'), 'notes.txt')) && exists(path.join(REAL_DATA, 'ret', 'state.db')),
    `target=${fs.readFileSync(path.join(OUT, 'target.txt'), 'utf8')} symlinks and dir kept`);
  const before = fs.readdirSync(dirOf('ret3')).length;
  const nope = [R.prune('ret3', 0), R.prune('ret3', 366), R.prune('ret3', '7'), R.prune('ret3', NaN), R.prune('ret3', 1.5)];
  gate('g6d invalid days delete nothing',
    nope.every((x) => x.length === 0) && fs.readdirSync(dirOf('ret3')).length === before && r3.A && before === 15,
    `files=${fs.readdirSync(dirOf('ret3')).length}/${before}`);

  // g7 — a reports dir that is a symlink leaving the plugin folder: nothing listed, pruned or created through it
  fs.mkdirSync(path.join(REAL_DATA, 'evil'));
  fs.symlinkSync(path.join(OUT, 'old'), path.join(REAL_DATA, 'evil', 'reports'));
  let threw = false;
  try { R.newEntry('evil', 'manual'); } catch { threw = true; }
  gate('g7 reports dir symlinked outside -> refused',
    J(R.prune('evil', 1)) === '[]' && J(R.list('evil')) === '[]' && threw
      && J(fs.readdirSync(path.join(OUT, 'old'))) === J(['2026-01-01T0900.log'])
      && fs.readFileSync(path.join(OUT, 'old', '2026-01-01T0900.log'), 'utf8') === 'outside-old',
    `outside=${J(fs.readdirSync(path.join(OUT, 'old')))} threw=${threw}`);

  // g8 — hostile ids / stems never reach a path
  let t1 = false, t2 = false;
  try { R.newEntry('../x', 'manual'); } catch { t1 = true; }
  try { R.newEntry('runs', 'weird'); } catch { t2 = true; }
  const hostile = ['../runs', 'Runs', '', 'a/b', null];
  gate('g8 hostile id / stem / trigger refused',
    hostile.every((id) => J(R.list(id)) === '[]' && J(R.prune(id, 7)) === '[]' && R.readLog(id, e1.stem) === null)
      && t1 && t2 && R.readLog('runs', '../../outside/target') === null && R.reportPath('runs', '../x') === null
      && R.setPid('runs', '../x', 5) === false && R.finishEntry('runs', '2026-11-02T0900/../x', { exit: 0 }) === false
      && R.latest('nobody') === null && J(R.stats('nobody')) === J({ count: 0, bytes: 0 }),
    `newEntry(../x) threw=${t1} bad trigger threw=${t2}`);

  // g9 — log view: tail <= MAX_BYTES + truncated, cut on a character boundary
  const big = Buffer.alloc(1536 * 1024, 'a');
  big.write('HEAD', 0); big.write('TAIL', big.length - 4);
  const L1 = mk('logs', T(2026, 11, 2, 7, 0), { log: big, exit: 0 });
  const r1 = R.readLog('logs', L1.stem);
  const L2 = mk('logs', T(2026, 11, 2, 7, 1), { log: 'x' + 'é'.repeat(786431) + '\n', exit: 0 }); // cut lands mid-character
  const r2 = R.readLog('logs', L2.stem);
  const L3 = mk('logs', T(2026, 11, 2, 7, 2), { log: 'short log\n', exit: 0 });
  const r3s = R.readLog('logs', L3.stem);
  gate('g9a 1.5 MB log -> tail <= 1 MB + truncated',
    MAX_BYTES === 1024 * 1024 && r1.truncated === true && Buffer.byteLength(r1.text) === MAX_BYTES
      && r1.text.endsWith('TAIL') && !r1.text.includes('HEAD'),
    `bytes=${Buffer.byteLength(r1.text)} truncated=${r1.truncated} tail=${r1.text.slice(-4)}`);
  gate('g9b cut inside a multibyte char -> no replacement char, still <= 1 MB',
    r2.truncated && Buffer.byteLength(r2.text) <= MAX_BYTES && !r2.text.includes('�') && r2.text.endsWith('é\n'),
    `bytes=${Buffer.byteLength(r2.text)} fffd=${r2.text.includes('�')}`);
  gate('g9c small log whole, not truncated; missing log null',
    r3s.text === 'short log\n' && r3s.truncated === false && R.readLog('logs', '2026-01-01T0000') === null,
    `small=${J(r3s)}`);

  // g10 — reportPath only for a real report file; stats from disk
  const st = R.stats('ret');
  let sum = 0;
  for (const n of fs.readdirSync(dirOf('ret'))) {
    const s = fs.lstatSync(path.join(dirOf('ret'), n));
    if (/^\d{4}-\d{2}-\d{2}T\d{4}(-\d+)?\.(html|log|json)$/.test(n) && s.isFile()) sum += s.size;
  }
  gate('g10a reportPath: real file only (absent and symlink -> null)',
    R.reportPath('runs', e1.stem) === path.join(dirOf('runs'), `${e1.stem}.html`)
      && R.reportPath('runs', e3.stem) === null && R.reportPath('ret', '2026-10-01T0900') === null,
    `real=${R.reportPath('runs', e1.stem)} absent=${R.reportPath('runs', e3.stem)}`);
  gate('g10b stats = listed entries + regular bytes',
    st.count === 3 && st.bytes === sum && sum > 0 && J(R.stats('nobody')) === J({ count: 0, bytes: 0 }),
    `stats=${J(st)} oracle=${sum}`);

  // g11 — default clock
  const R2 = create(DATA);
  const dflt = R2.newEntry('dflt', 'auto');
  gate('g11 default clock -> stem of the local minute', /^\d{4}-\d{2}-\d{2}T\d{4}$/.test(dflt.stem) && R2.list('dflt', { days: 1 }).length === 1,
    `stem=${dflt.stem}`);

  // g12 — finishEntry takes the runner's { exit, signal } only
  const fa = mk('fin', T(2026, 11, 2, 10, 0), { html: '<p>a</p>' });
  const fb = mk('fin', T(2026, 11, 2, 10, 1), { html: '<p>b</p>' });
  const fc = mk('fin', T(2026, 11, 2, 10, 2), { html: '<p>c</p>' });
  R.finishEntry('fin', fa.stem, { exit: 3, signal: null });
  R.finishEntry('fin', fb.stem, { exit: null, signal: 'SIGKILL' });
  R.finishEntry('fin', fc.stem, 3);
  const fin = Object.fromEntries(R.list('fin').map((e) => [e.stem, e.exit]));
  gate('g12 finishEntry takes { exit, signal } only: a bare integer records no exit',
    fin[fa.stem] === 3 && fin[fb.stem] === null && fin[fc.stem] === null, `exits=${J(fin)}`);

  // r-a..r-e — stopped marker (K2): markStopped merges `stopped: true` into the sidecar, entries expose it
  const attempt = (fn) => { try { return { v: fn() }; } catch (err) { return { err: String(err && err.message || err) }; } };
  const sideOf = (id, stem) => JSON.parse(fs.readFileSync(path.join(dirOf(id), `${stem}.json`), 'utf8'));
  const sa = mk('stp', T(2026, 11, 2, 13, 0), { log: 'a' });
  const sb = mk('stp', T(2026, 11, 2, 13, 1), { log: 'b' });
  const ma = attempt(() => R.markStopped('stp', sa.stem));
  const entA = () => R.list('stp').find((x) => x.stem === sa.stem);
  const entB = () => R.list('stp').find((x) => x.stem === sb.stem);
  const afterA = attempt(() => ({ a: entA(), b: entB(), latest: R.latest('stp'), side: sideOf('stp', sa.stem) }));
  const mb = attempt(() => R.markStopped('stp', sb.stem));
  const again = attempt(() => R.markStopped('stp', sb.stem));
  const afterB = attempt(() => R.latest('stp'));
  gate('r-a markStopped sets stopped true; list() / latest() show it; marking twice is fine',
    ma.v === true && afterA.v && afterA.v.a.stopped === true && afterA.v.b.stopped === false
      && afterA.v.latest.stem === sb.stem && afterA.v.latest.stopped === false && afterA.v.side.stopped === true
      && afterA.v.a.exit === null && afterA.v.a.trigger === 'manual' && afterA.v.a.start === T(2026, 11, 2, 13, 0)
      && mb.v === true && again.v === true && afterB.v && afterB.v.stopped === true,
    `mark=${J(ma)} after=${J(afterA.v || afterA)} second=${J(mb)}/${J(again)} latest=${J(afterB.v || afterB)}`);

  const idle = mk('stp2', T(2026, 11, 2, 13, 10), { log: 'i' });
  const piped = mk('stp2', T(2026, 11, 2, 13, 11), { log: 'p' });
  R.setPid('stp2', piped.stem, 4242);
  R.finishEntry('stp2', piped.stem, { exit: 0 });
  const unmarked = R.list('stp2');
  const rawIdle = sideOf('stp2', idle.stem);
  const rawPiped = sideOf('stp2', piped.stem);
  gate('r-b an unmarked entry reads stopped false, and no sidecar stores the key',
    unmarked.length === 2 && unmarked.every((x) => x.stopped === false)
      && !('stopped' in rawIdle) && !('stopped' in rawPiped),
    `entries=${J(unmarked.map((x) => x.stopped))} idle=${J(Object.keys(rawIdle))} piped=${J(Object.keys(rawPiped))}`);

  const fx = mk('stp3', T(2026, 11, 2, 13, 20), { log: 'f' });
  R.setPid('stp3', fx.stem, 777);
  const mc = attempt(() => R.markStopped('stp3', fx.stem));
  const fin1 = R.finishEntry('stp3', fx.stem, { exit: null, signal: 'SIGTERM' });
  const afterFin = R.latest('stp3');
  const sideFin = sideOf('stp3', fx.stem);
  const fy = mk('stp3', T(2026, 11, 2, 13, 21), { html: '<p>y</p>', log: 'y', exit: 0 });
  const mc2 = attempt(() => R.markStopped('stp3', fy.stem));
  const afterLate = R.list('stp3').find((x) => x.stem === fy.stem);
  gate('r-c finishEntry after markStopped keeps stopped true (pid kept); marking a finished entry keeps its exit',
    mc.v === true && fin1 === true && afterFin.stopped === true && afterFin.exit === null && afterFin.pid === 777
      && sideFin.stopped === true && sideFin.pid === 777
      && mc2.v === true && afterLate.stopped === true && afterLate.exit === 0 && afterLate.hasReport === true
      && afterLate.size === Buffer.byteLength('<p>y</p>'),
    `fin=${J(afterFin)} side=${J(sideFin)} late=${J(afterLate)}`);

  const dirBefore = fs.readdirSync(dirOf('stp')).sort();
  const hostile2 = ['../x', '2026-11-02T1300/../x', '2026-11-02', '', null, undefined, 42, '2026-11-02T1300.json'];
  const refused = hostile2.map((s) => attempt(() => R.markStopped('stp', s)));
  const refusedIds = ['nobody', '../stp', 'Stp', '', null, 'a/b'].map((i) => attempt(() => R.markStopped(i, sa.stem)));
  const noSide = attempt(() => R.markStopped('stp', '2026-11-02T0001')); // well-formed stem, no sidecar
  const noReports = attempt(() => R.markStopped('runs', '2026-11-02T0000-9'));
  const dirAfter = fs.readdirSync(dirOf('stp')).sort();
  gate('r-d bad stem / unknown id / missing sidecar -> false, nothing written',
    refused.every((x) => x.v === false) && refusedIds.every((x) => x.v === false) && noSide.v === false
      && noReports.v === false && J(dirAfter) === J(dirBefore) && !exists(path.join(REAL_DATA, 'nobody'))
      && !exists(path.join(dirOf('stp'), '2026-11-02T0001.json')),
    `stems=${J(refused.map((x) => x.v))} ids=${J(refusedIds.map((x) => x.v))} noSide=${J(noSide)} files=${dirAfter.length}/${dirBefore.length}`);

  const odd = mk('stp4', T(2026, 11, 2, 13, 30), { log: 'o' });
  const oddFile = path.join(dirOf('stp4'), `${odd.stem}.json`);
  const base = sideOf('stp4', odd.stem);
  const oddReads = ['yes', 'true', 1, 0, null, {}, ['true']].map((v) => {
    fs.writeFileSync(oddFile, J({ ...base, stopped: v }));
    const e = R.latest('stp4');
    return e ? e.stopped : 'no-entry';
  });
  fs.writeFileSync(oddFile, J({ ...base, stopped: true }));
  const exact = R.latest('stp4');
  gate('r-e a sidecar whose stopped is not the boolean true reads false; the boolean true reads true',
    oddReads.every((x) => x === false) && exact && exact.stopped === true,
    `odd=${J(oddReads)} exact=${J(exact && exact.stopped)}`);
}

function finish(code) {
  for (const r of results) console.log(r);
  const n = results.length;
  console.log(failed ? `VERDICT: RED (${n - failed}/${n} pass)` : `VERDICT: ALL GREEN (${n}/${n})`);
  if (ROOT.startsWith(os.tmpdir()) && path.basename(ROOT).startsWith('deck-reports-probe-')) {
    fs.rmSync(ROOT, { recursive: true, force: true }); // symlinks inside are removed, never followed
  }
  app.exit(code);
}

run().then(() => finish(failed ? 1 : 0), (err) => {
  results.push(`FAIL probe-crash — ${err && err.stack ? err.stack : err}`);
  failed++;
  finish(1);
});
