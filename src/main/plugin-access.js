// claude-deck — main/plugin-access: the names-only access layer of the plugin host (AMD-3, D20, D23).
// A plugin slot is mapped to the NAME of one of the user's shell variables. This leaf module lists the
// exported names, finds candidates (« Détecter »), and judges a mapping. It never holds a value:
// the listing asks the shell for names, and every result carries names and statuses only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_MAX = 64;
// Prefixes no candidate may carry (the manifest refuses them for slot names too). `npm_` is not one.
const REFUSED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_DECK_', 'ELECTRON_', 'DECK_PLUGIN_'];
const STATUS = Object.freeze({
  PRESENT: 'présente', ABSENT: 'absente', INVALID: 'nom invalide', MANY: 'plusieurs trouvées', NONE: 'introuvable',
});
const LIST_ERROR = 'Lecture du shell impossible';
const UNSUPPORTED_NOTE = 'shell non pris en charge, lecture via bash';
const LIST_TIMEOUT_MS = 4000; // as shell-env.js
const MAX_OUTPUT = 1024 * 1024;
const EXIT_GRACE_MS = 150;
const BASH = '/bin/bash';
const OUTER_PATH = '/usr/local/bin:/usr/bin:/bin';
const HOMEBREW_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin'; // darwin only, see outerPath()
const MARKER = '__CLAUDE_DECK_NAMES_BEGIN__';
const END = '__CLAUDE_DECK_NAMES_END__';
// fd 3 only: the shell's own fds 0-2 are ignored, so rc output (a secret an rc echoes) can never reach a result.
// `|| exit 1`: a shell without the `compgen` builtin ends before the end marker, a failed listing, never an empty one.
const LIST_CMD = `printf '%s\\n' ${MARKER} >&3; compgen -e >&3 || exit 1; printf '%s\\n' ${END} >&3`;

// zsh has no `compgen`: its `parameters` map holds every parameter's type, the (R) subscript keeps the exported ones, (k) their names.
const ZSH_LIST_CMD = `print -r -- ${MARKER} >&3; print -rl -- \${(k)parameters[(R)*export*]} >&3; print -r -- ${END} >&3`;

function validName(n) {
  return typeof n === 'string' && n.length <= NAME_MAX && NAME_RE.test(n);
}

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
}

// Allowlist: bash carries `compgen -e`; zsh, the default shell of macOS, has its own listing and is accepted on darwin only
// (and only when the binary is there). Every other shell (fish, sh, dash, ksh, ... and zsh elsewhere) is read through bash.
function listingShell(shellPath) {
  if (typeof shellPath !== 'string' || !shellPath) return { shell: BASH, note: null };
  const name = path.basename(shellPath);
  if (name === 'bash') return { shell: shellPath, note: null };
  if (name === 'zsh' && process.platform === 'darwin' && isExecutableFile(shellPath)) return { shell: shellPath, note: null };
  return { shell: BASH, note: UNSUPPORTED_NOTE };
}

const listCmdOf = (shell) => (path.basename(shell) === 'zsh' ? ZSH_LIST_CMD : LIST_CMD);

// Read at call time: darwin puts Homebrew first (an Apple-silicon install lives in /opt/homebrew), Linux keeps OUTER_PATH.
const outerPath = () => (process.platform === 'darwin' ? `${HOMEBREW_PATH}:${OUTER_PATH}` : OUTER_PATH);

function outerEnv(shell) {
  let u = {};
  try { u = os.userInfo(); } catch (_) { /* no passwd entry: USER stays empty, no env fallback */ }
  const user = u.username || '';
  return { HOME: u.homedir || '', USER: user, LOGNAME: user, SHELL: shell, PATH: outerPath() };
}

// Lines between the two markers, or null while either is missing. Lines before the marker (rc noise) are dropped.
function parseListing(buf) {
  const lines = buf.split('\n').map((l) => l.replace(/\r$/, ''));
  const b = lines.indexOf(MARKER);
  if (b < 0) return { seen: false, names: null };
  const e = lines.indexOf(END, b + 1);
  if (e < 0) return { seen: true, names: null };
  return { seen: true, names: [...new Set(lines.slice(b + 1, e).filter(validName))].sort() };
}

const fail = (reason) => ({ ok: false, error: LIST_ERROR, reason });

// Resolves {ok: true, names, note} or {ok: false, error, reason}; never rejects. `reason` is a fixed word.
// A zsh whose listing fails is read again through bash, with the unsupported note.
async function listNames(shellPath, timeoutMs = LIST_TIMEOUT_MS) {
  const { shell, note } = listingShell(shellPath);
  const res = await listWith(shell, note, timeoutMs);
  if (res.ok || path.basename(shell) !== 'zsh') return res;
  return listWith(BASH, UNSUPPORTED_NOTE, timeoutMs);
}

// The marker on fd 3 is how an rc or exec failure (no marker) is told apart from an empty listing.
function listWith(shell, note, timeoutMs) {
  return new Promise((resolve) => {
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LIST_TIMEOUT_MS;
    let done = false;
    let buf = '';
    let child = null;
    let timer = null;
    let grace = null;
    const finish = (res, kill) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child) {
        try { child.stdio[3].destroy(); } catch (_) { /* already closed */ }
        const alive = child.exitCode === null && child.signalCode === null;
        if (child.pid && (kill || alive)) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* group gone */ } }
      }
      resolve(res);
    };
    try {
      child = spawn(shell, ['-ic', listCmdOf(shell)], {
        env: outerEnv(shell), stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: true,
      });
    } catch (_) {
      return resolve(fail('spawn'));
    }
    child.on('error', () => finish(fail('spawn')));
    timer = setTimeout(() => finish(fail('timeout'), true), limit);
    const out = child.stdio[3];
    out.setEncoding('utf8');
    out.on('error', () => {});
    out.on('data', (chunk) => {
      if (done) return;
      buf += chunk;
      if (buf.length > MAX_OUTPUT) return finish(fail('overflow'), true);
      if (!buf.includes(END)) return;
      const { names } = parseListing(buf);
      if (names) finish({ ok: true, names, note });
    });
    // A daemon started by an rc can keep fd 3 open: the end marker, not the pipe closing, completes the read.
    child.on('exit', () => {
      grace = setTimeout(() => finish(fail(parseListing(buf).seen ? 'incomplete' : 'no-marker')), EXIT_GRACE_MS);
    });
  });
}

function candidatesOf(slot, names) {
  const hints = slot && slot.hints;
  if (!Array.isArray(hints) || !hints.length || !hints.every((h) => typeof h === 'string' && h)) return [];
  const out = new Set();
  for (const n of Array.isArray(names) ? names : []) {
    if (!validName(n) || REFUSED_PREFIXES.some((p) => n.startsWith(p))) continue;
    if (hints.every((h) => n.includes(h))) out.add(n);
  }
  return [...out].sort();
}

function row(slot, mapped, status, candidates) {
  return {
    name: slot.name, label: slot.label, required: slot.required === true,
    hints: Array.isArray(slot.hints) ? slot.hints.slice() : [], mapped, status, candidates,
  };
}

// Détecter: one candidate fills the slot, several are offered, none is « introuvable ». Nothing is persisted.
function detect(envSlots, names) {
  return (Array.isArray(envSlots) ? envSlots : []).map((slot) => {
    const c = candidatesOf(slot, names);
    if (c.length === 1) return row(slot, c[0], STATUS.PRESENT, c);
    return row(slot, null, c.length ? STATUS.MANY : STATUS.NONE, c);
  });
}

// Stored mapping: « présente » / « absente » / « nom invalide ». A slot with no mapping is never ready:
// « plusieurs trouvées » when several candidates exist, else « introuvable » (a lone candidate is listed
// in `candidates` for Détecter to fill, it is not applied here).
function status(envSlots, envMap, names) {
  const map = envMap && typeof envMap === 'object' ? envMap : {};
  const have = new Set(Array.isArray(names) ? names : []);
  return (Array.isArray(envSlots) ? envSlots : []).map((slot) => {
    const v = Object.prototype.hasOwnProperty.call(map, slot.name) ? map[slot.name] : null;
    if (v === null || v === undefined || v === '') {
      const c = candidatesOf(slot, names);
      return row(slot, null, c.length > 1 ? STATUS.MANY : STATUS.NONE, c);
    }
    const shown = typeof v === 'string' ? v.slice(0, NAME_MAX) : null;
    if (!validName(v)) return row(slot, shown, STATUS.INVALID, []);
    return row(slot, v, have.has(v) ? STATUS.PRESENT : STATUS.ABSENT, []);
  });
}

module.exports = { listNames, listingShell, detect, status, validName, NAME_RE, REFUSED_PREFIXES, STATUS, LIST_ERROR };
