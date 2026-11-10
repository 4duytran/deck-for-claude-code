// test/_fake-glab.js — test double for the glab CLI (deck-mr-review, lot L0).
// Probes point CLAUDE_DECK_GLAB_BIN at the file this writes, so no probe ever runs the real glab.
//   const { writeFakeGlab, readGlabLog } = require('./_fake-glab.js');
//   const { bin, log } = writeFakeGlab(dir, routes);
// routes = ordered list, first match wins; a call matching none exits 1 with a stderr line:
//   { includes: 'merge_requests?', ... } | { re: 'projects/.+/versions', flags: 'i', ... }   (tested on argv.join(' '))
//   stdout: raw stdout string          http: { status, headers, body, eol }  -> V1's `glab api -i` shape
//   code: exit code (0)   stderr: string   delayMs: wait before answering (timeout probes)
// Every call appends one JSONL line to `log`: { argv, cwd, stdin, envKeys }. stdin is read only when
// argv holds --input (as the real CLI does), else null.
'use strict';
const fs = require('fs');
const path = require('path');

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict' };

// V1 sample (glab-i-sample.txt): status line, headers, blank line, then the JSON body. LF by default.
function httpShape({ status = 200, headers = {}, body = '', eol = '\n' }) {
  const all = { 'Content-Type': 'application/json', ...headers };
  const head = Object.entries(all).map(([k, v]) => `${k}: ${v}`).join(eol);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return `HTTP/2.0 ${status} ${STATUS_TEXT[status] || ''}`.trimEnd() + eol + head + eol + eol + text;
}

function findNode() {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'node');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next dir */ }
  }
  throw new Error('_fake-glab: no node on PATH for the fake shebang');
}

function writeFakeGlab(dir, routes) {
  const compiled = routes.map((r) => ({
    includes: r.includes,
    re: r.re,
    flags: r.flags,
    stdout: r.http ? httpShape(r.http) : (r.stdout || ''),
    stderr: r.stderr || '',
    code: r.code || 0,
    delayMs: r.delayMs || 0,
  }));
  const log = path.join(dir, 'glab-log.jsonl');
  const routesFile = path.join(dir, 'glab-routes.json');
  const bin = path.join(dir, 'glab');
  fs.writeFileSync(routesFile, JSON.stringify(compiled));
  fs.writeFileSync(log, '');
  fs.writeFileSync(bin, `#!${findNode()}
'use strict';
const fs = require('fs');
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, 'utf8'));
const argv = process.argv.slice(2);
const finish = (stdin) => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), stdin, envKeys: Object.keys(process.env) }) + '\\n');
  const line = argv.join(' ');
  const route = routes.find((r) => (r.re ? new RegExp(r.re, r.flags || '').test(line) : line.includes(r.includes)));
  if (!route) { process.stderr.write('fake-glab: no route for ' + line + '\\n'); process.exit(1); }
  setTimeout(() => {
    if (route.stderr) process.stderr.write(route.stderr);
    process.stdout.write(route.stdout, () => process.exit(route.code));
  }, route.delayMs);
};
if (argv.includes('--input')) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
} else {
  finish(null);
}
`, { mode: 0o755 });
  return { bin, log };
}

function readGlabLog(log) {
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

module.exports = { writeFakeGlab, readGlabLog, httpShape };
