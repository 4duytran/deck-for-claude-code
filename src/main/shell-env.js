// claude-deck — main/shell-env: resolve the user's INTERACTIVE shell
// environment, so a PTY-spawned `claude` (and the MCP servers it spawns) sees
// the exact same env it would in a real terminal.
//
// WHY THIS EXISTS — the GUI-launch env gap:
//   A terminal emulator on Linux opens an *interactive non-login* shell, which
//   sources ~/.bashrc. Anything exported there (e.g. an API token) lands in
//   that shell's env, so a `claude` started from the terminal — and the MCP
//   servers it forks — inherits the token and authenticates.
//   But the deck is launched from a desktop entry (~/.local/share/applications/
//   claude-deck.desktop -> ~/.local/bin/claude-deck -> `exec npm start`): that
//   launcher restores PATH via mise but NEVER sources ~/.bashrc, so Electron's
//   `process.env` lacks the secrets. `pty.spawn(claude, { env: process.env })`
//   then hands `claude` a token-less env -> an MCP server falls back to
//   anonymous -> a 401 "Client must be authenticated...".
//
// THE FIX (VS Code / `shell-env` approach): run the user's shell as an
// interactive shell that prints its environment, snapshot it, and use it as the
// base env for every PTY spawn. Strictly additive: any failure falls back to
// process.env (today's behavior), so a missing/exotic shell never breaks spawns.
'use strict';

const { execFile } = require('child_process');

// -i (interactive, NON-login) deliberately, NOT -l: a Linux terminal emulator
// opens interactive non-login shells, which read ~/.bashrc — exactly where the
// user keeps their `export` lines. An interactive LOGIN shell (-l) would
// read ~/.bash_profile instead and MISS ~/.bashrc unless it chains the two, so
// -i alone is the faithful mirror of "what works in my terminal" on Linux.
// (A macOS port, where Terminal.app opens login shells, would add -l.)
const BEGIN = '__CLAUDE_DECK_ENV_BEGIN__';
const END = '__CLAUDE_DECK_ENV_END__';
// `env -0` NUL-delimits entries (coreutils) so a value containing a newline
// can't desync the parse; the BEGIN/END fence discards any banner/MOTD an rc
// file prints to stdout around it.
const SNAPSHOT_CMD = `printf %s '${BEGIN}'; env -0; printf %s '${END}'`;
// env -0 separator, built from a char code so this source file stays pure ASCII
// (a raw NUL byte in the source makes grep/git treat the file as binary).
const NUL = String.fromCharCode(0);
// Only plain POSIX env names survive the parse. bash ALSO exports shell
// FUNCTIONS through `env -0` as `BASH_FUNC_name%%=() {...}` entries (the
// Shellshock CVE-2014-6271 vector); their names aren't valid identifiers, so
// this guard drops them — and any other malformed name — before they could be
// re-imported into the children `claude` forks.
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Bounded staleness: re-resolve at most this often, so a mid-session secret
// rotation (token re-sourced in the user's terminal) is picked up by the NEXT
// new pane without an app restart — yet we don't pay a shell hop on every
// spawn. Overridable (probes drive it to 0 to assert re-resolution); a literal
// 0 must survive, so use isFinite — `Number('0') || 60000` would swallow it.
const _ttlRaw = Number(process.env.CLAUDE_DECK_SHELL_ENV_TTL_MS);
const TTL_MS = Number.isFinite(_ttlRaw) ? _ttlRaw : 60000;

let cachedPromise = null;
let cachedAt = -Infinity;

// Returns Promise<envObject>. Memoized within TTL_MS; pre-warmed at startup and
// awaited by every pty-open, so it is ~free after the first resolution.
function resolveShellEnv() {
  const now = Date.now();
  if (cachedPromise && (now - cachedAt) < TTL_MS) return cachedPromise;
  cachedAt = now;
  cachedPromise = doResolve();
  return cachedPromise;
}

function doResolve() {
  // Escape hatch for probes / unusual setups: skip the shell hop entirely and
  // keep the legacy behavior (and determinism).
  if (process.env.CLAUDE_DECK_NO_SHELL_ENV === '1') {
    return Promise.resolve({ ...process.env });
  }
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve) => {
    let settled = false;
    // The fallback state IS the original bug (process.env lacks the secret), so
    // a SILENT fallback is indistinguishable from "fix never applied". Emit a
    // single warn (journal-visible) naming the cause — NEVER an env value — so
    // a recurring 401 can be traced to a shell-resolve failure, not guessed at.
    const fallback = (why) => {
      if (settled) return;
      settled = true;
      console.warn(`[shell-env] FALLBACK to bare process.env (${why}); ` +
        'MCP secrets from ~/.bashrc may be MISSING -> spawned tools can 401');
      resolve({ ...process.env });
    };
    let child;
    try {
      child = execFile(
        shell,
        ['-i', '-c', SNAPSHOT_CMD],
        {
          // stdin from /dev/null so an interactive shell can't block on a read;
          // stderr CAPTURED (not ignored) so a fallback can report the cause.
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 4000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'buffer',
        },
        (err, stdout, stderr) => {
          if (err && (!stdout || !stdout.length)) {
            const tail = stderr && stderr.length ? ` stderr=${truncate(stderr)}` : '';
            return fallback(`${shell}: ${err.code || err.message}${tail}`);
          }
          const parsed = parseSnapshot(stdout);
          if (!parsed) return fallback('unparseable env snapshot');
          if (settled) return;
          settled = true;
          const merged = mergeKeepingSeams(parsed);
          // Count only — never the names/values of secrets.
          console.log(`[shell-env] resolved ${Object.keys(merged).length} vars from ${shell} -i`);
          resolve(merged);
        },
      );
    } catch (e) {
      return fallback(e && e.message ? e.message : 'spawn threw');
    }
    if (child) child.on('error', (e) => fallback(e && e.message ? e.message : 'child error'));
  });
}

function truncate(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  return s.length > 200 ? s.slice(0, 200) + '[...]' : s;
}

function parseSnapshot(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const i = s.indexOf(BEGIN);
  const j = s.lastIndexOf(END);
  if (i === -1 || j === -1 || j < i + BEGIN.length) return null;
  const body = s.slice(i + BEGIN.length, j);
  const env = {};
  for (const entry of body.split(NUL)) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue; // skip nameless / malformed entries
    const name = entry.slice(0, eq);
    if (!VALID_NAME.test(name)) continue; // drop BASH_FUNC_* and exotic names
    env[name] = entry.slice(eq + 1);
  }
  return Object.keys(env).length ? env : null;
}

// The resolved snapshot already INHERITED process.env (the resolver shell is
// spawned with it) and layered ~/.bashrc on top — so PATH is the full shell
// PATH (uvx/npx/mise findable) and the secrets are present, a faithful copy of
// the user's terminal. We only RE-ASSERT the deck's own seams in case an rc
// file ever clobbered one; everything else (incl. PATH) intentionally comes
// from the shell, NOT from Electron's narrower GUI env.
function mergeKeepingSeams(resolved) {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLAUDE_DECK_')) resolved[k] = process.env[k];
  }
  return resolved;
}

module.exports = { resolveShellEnv };
