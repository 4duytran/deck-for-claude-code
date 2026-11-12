// ask-ancestry-probe — the ask hook (bin/deck-ask-hook.js) reports its ancestor pids on macOS (one `ps` snapshot) as on
// Linux (/proc); the deck matches them against its pane processes when a question arrives after /clear.
// Gates:
//   a1            the `ps` walker equals the /proc walker for this process (SKIP on darwin: no /proc).
//   a2            the hook run through a 3-level `sh -c` chain writes a request whose `pids` hold the three `sh` pids, parent
//                 first, then this probe's pid. Default reader: /proc on Linux, `ps` on darwin.
//   a2-forced-ps  the same, with the hook forced onto the `ps` reader (test-only seam CLAUDE_DECK_ASK_FORCE_PS=1) and a
//                 PATH shim that records the real `ps` was called (SKIP on darwin: the default reader is already `ps`).
//   a3            fail-open: with no `ps` on PATH the request carries `pids` = [parent] only (Linux: through the same seam).
// The hook needs a live deck pid in <ASK_DIR>/deck.pid before it writes a request: this probe writes its own pid there.
// No window, no main.js: the hook runs as a child of this process and is killed once its request has been read.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const DECK = path.join(__dirname, '..');
const HOOK = path.join(DECK, 'bin', 'deck-ask-hook.js');
const DARWIN = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `deck-ask-anc-${name}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote

const results = [];
const gate = (id, cond, detail) => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
};
const skip = (id, reason) => console.log(`SKIP ${id} — ${process.platform}: ${reason}`);

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

function which(bin) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return null;
}

// Runs the hook below `sh -c` x3 (L1 -> L2 -> L3 -> hook; each level appends its own pid to a file, and none execs the next
// command, so the three shells stay alive as ancestors). Resolves { req, chain: [l1, l2, l3] }, req null when no request
// showed up in time. The whole process group is killed once the request has been read.
async function runHook(extraEnv) {
  const askDir = tmp('ask');
  const work = tmp('work');
  fs.writeFileSync(path.join(askDir, 'deck.pid'), String(process.pid));
  const payload = path.join(work, 'payload.json');
  fs.writeFileSync(payload, JSON.stringify({
    tool_name: 'AskUserQuestion', session_id: 'probe-session', tool_use_id: `probe-${Date.now()}`, cwd: work,
    tool_input: { questions: [{ question: 'Which side?', header: 'Side', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }], multiSelect: false }] },
  }));
  const pidFile = (n) => path.join(work, `l${n}.pid`);
  const hookCmd = `${q(process.execPath)} ${q(HOOK)} ask ${q(askDir)} < ${q(payload)}`;
  const l3 = `echo $$ > ${q(pidFile(3))}; ${hookCmd}; rc=$?; exit $rc`;
  const l2 = `echo $$ > ${q(pidFile(2))}; /bin/sh -c ${q(l3)}; rc=$?; exit $rc`;
  const l1 = `echo $$ > ${q(pidFile(1))}; /bin/sh -c ${q(l2)}; rc=$?; exit $rc`;
  const child = spawn('/bin/sh', ['-c', l1], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_DECK_ASK_DIR: askDir, ...extraEnv },
  });
  const exited = new Promise((r) => child.once('exit', r));
  let req = null;
  for (let i = 0; i < 300 && !req; i++) {
    await sleep(50);
    const f = fs.readdirSync(askDir).find((n) => n.endsWith('.req.json'));
    if (f) { try { req = JSON.parse(fs.readFileSync(path.join(askDir, f), 'utf8')); } catch (_) { /* half-written: retry */ } }
  }
  const chain = [1, 2, 3].map((n) => { try { return Number(fs.readFileSync(pidFile(n), 'utf8').trim()); } catch (_) { return NaN; } });
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, sig); } catch (_) { /* group already gone */ }
    if (await Promise.race([exited.then(() => true), sleep(3000).then(() => false)])) break;
  }
  rm(askDir); rm(work);
  return { req, chain };
}

async function main() {
  const { ancestorPidsPs, ancestorPidsProc } = require(HOOK)._internals;

  // a1
  if (DARWIN) skip('a1', 'no /proc to compare against');
  else if (typeof ancestorPidsPs !== 'function' || typeof ancestorPidsProc !== 'function') gate('a1', false, 'the hook exports no ps / proc reader pair');
  else {
    const viaPs = ancestorPidsPs();
    const viaProc = ancestorPidsProc();
    gate('a1', viaProc.length > 1 && sameList(viaPs, viaProc), `ps walker [${viaPs}] vs /proc walker [${viaProc}]`);
  }

  // a2 (default reader of the platform)
  const expectChain = ({ req, chain }) => (req ? [chain[2], chain[1], chain[0], process.pid] : null);
  const describe = (r) => (r.req ? `pids [${r.req.pids}] vs expected [${expectChain(r)}]` : 'no request written');
  const a2 = await runHook({});
  gate('a2', !!a2.req && a2.chain.every(Number.isInteger) && sameList((a2.req.pids || []).slice(0, 4), expectChain(a2)),
    `${DARWIN ? 'ps' : '/proc'} reader through 3 sh levels: ${describe(a2)}`);

  // a2-forced-ps (Linux only)
  if (DARWIN) skip('a2-forced-ps', 'the default reader is already ps');
  else {
    const realPs = which('ps');
    const shim = tmp('shim');
    const marker = path.join(shim, 'ps.called');
    if (realPs) {
      fs.writeFileSync(path.join(shim, 'ps'), `#!/bin/sh\necho called >> ${q(marker)}\nexec ${q(realPs)} "$@"\n`, { mode: 0o755 });
    }
    const r = realPs ? await runHook({ CLAUDE_DECK_ASK_FORCE_PS: '1', PATH: `${shim}${path.delimiter}${process.env.PATH}` }) : { req: null, chain: [] };
    const called = fs.existsSync(marker);
    gate('a2-forced-ps', !!realPs && !!r.req && r.chain.every(Number.isInteger) && called && sameList((r.req.pids || []).slice(0, 4), expectChain(r)),
      realPs ? `ps invoked: ${called}; ${describe(r)}` : 'no ps binary on this PATH');
    rm(shim);
  }

  // a3 (no ps on PATH: the PATH is an empty folder; every command of the chain is an absolute path or a builtin)
  const empty = tmp('nopath');
  const a3 = await runHook({ PATH: empty, ...(DARWIN ? {} : { CLAUDE_DECK_ASK_FORCE_PS: '1' }) });
  gate('a3', !!a3.req && a3.chain.every(Number.isInteger) && sameList(a3.req.pids, [a3.chain[2]]),
    `no ps on PATH: ${a3.req ? `pids [${a3.req.pids}] vs expected [${a3.chain[2]}]` : 'no request written'}`);
  rm(empty);

  const ok = results.filter(Boolean).length;
  console.log('---');
  console.log(ok === results.length ? `VERDICT: ALL GREEN (${ok}/${results.length})` : `VERDICT: RED (${ok}/${results.length})`);
  return ok === results.length ? 0 : 1;
}

app.whenReady().then(main).catch((e) => { console.log(`FAIL probe — ${e && e.stack || e}`); return 1; }).then((code) => app.exit(code));
