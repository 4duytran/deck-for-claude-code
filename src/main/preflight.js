// claude-deck — boot preflight: warn (never block) when a HOST prerequisite
// the deck cannot ship is missing, instead of letting the dependent feature
// no-op silently. Two externals the deck relies on but does not bundle:
//   claude  — the CLI every pane spawns (no claude => panes fail to start);
//   jq      — used by the injected bin/ status hook + quota collector; absent
//             => live status + quota gauges silently no-op (features degrade,
//             the app still runs).
// Plus the tools the deck's OWN .tool-versions pins: mise resolves that file
// from the deck's cwd, so those binaries reach the panes only while the deck
// runs from this directory. Measured 2026-09-12: the deck moved out of the
// workspace tree and every pane lost the pinned go with no error at all.
// LIMIT: which() asserts PRESENCE — a pin that also has a system copy (e.g.
// /usr/local/bin/helm) still resolves, at that copy's version, and stays silent.
// Surfaced BOTH to the console (CLI/dev launch) AND a non-blocking Electron
// dialog (a desktop launch inherits no terminal), once at boot, and only when
// something is actually missing. checkPrerequisites() is pure + electron-free
// so a headless probe can assert it; runPreflight() adds the boot side effects.
//
// PATH ORACLE (critical): panes spawn `claude` with the INTERACTIVE-SHELL env
// (resolveShellEnv() -> $SHELL -i sources ~/.bashrc -> full PATH), NOT Electron's
// minimal GUI PATH. So the check MUST resolve claude/jq against that same shell
// PATH — otherwise a claude installed via a version manager (nvm/fnm/mise/asdf,
// whose bin dir is in neither the GUI PATH nor the 3 fallback dirs) would spawn
// panes fine yet trigger a false FATAL dialog on every desktop launch.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// mise tool name -> the binary it puts on PATH (1:1 unless listed here).
const TOOL_BIN_ALIAS = { golang: 'go' };
const APP_ROOT = path.join(__dirname, '..', '..');

// Binaries pinned by the deck's own .tool-versions. No file, or an unreadable
// one => nothing declared => nothing to warn about (an OSS clone pins nothing).
function declaredToolBins(appRoot) {
  try {
    return fs.readFileSync(path.join(appRoot, '.tool-versions'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0])
      .map((tool) => TOOL_BIN_ALIAS[tool] || tool);
  } catch (_) {
    return [];
  }
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// First executable named `cmd` on `pathEnv` (+ the same fallback install dirs
// resolveClaudeBin probes). `pathEnv` defaults to process.env.PATH; callers that
// know the pane-spawn PATH (the interactive shell's) pass it explicitly.
function which(cmd, pathEnv) {
  const raw = pathEnv != null ? pathEnv : process.env.PATH;
  const dirs = (raw || '').split(path.delimiter).concat([
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]);
  for (const dir of dirs) {
    if (!dir) continue;
    if (isExecutableFile(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
}

// Pure check — returns the list of missing prerequisites (empty = all present).
// Each entry: { cmd, severity: 'fatal'|'degraded', impact }. opts.pathEnv is the
// PATH to resolve against (see the PATH ORACLE note above); omit it in probes to
// fall back to process.env.PATH. opts.appRoot is the directory whose
// .tool-versions is read (default APP_ROOT); probes point it at a fixture.
function checkPrerequisites(opts) {
  const pathEnv = opts && opts.pathEnv != null ? opts.pathEnv : process.env.PATH;
  const missing = [];
  // An absolute CLAUDE_DECK_BIN (the desktop launcher exports the resolved
  // claude path; probes set a stub) is authoritative; else resolve `claude`
  // against the pane-spawn PATH.
  const explicit = process.env.CLAUDE_DECK_BIN;
  const claudeOk = (explicit && path.isAbsolute(explicit) && isExecutableFile(explicit))
    || !!which('claude', pathEnv);
  if (!claudeOk) {
    missing.push({
      cmd: 'claude',
      severity: 'fatal',
      impact: 'every pane spawns `claude` — without it, sessions fail to start.',
    });
  }
  if (!which('jq', pathEnv)) {
    missing.push({
      cmd: 'jq',
      severity: 'degraded',
      impact: 'live session status and quota gauges silently no-op.',
    });
  }
  const appRoot = opts && opts.appRoot != null ? opts.appRoot : APP_ROOT;
  for (const cmd of declaredToolBins(appRoot)) {
    if (which(cmd, pathEnv)) continue;
    missing.push({
      cmd,
      severity: 'degraded',
      impact: 'pinned in the deck .tool-versions but absent from the pane PATH — every pane loses this CLI.',
    });
  }
  return missing;
}

// Boot side effect: resolve the interactive-shell env (memoized, the SAME env
// panes spawn with) so the check uses the PATH panes actually get, then log +
// (electron) dialog. Lazy-requires so this file stays require-safe outside an
// electron context (the probe path). Never throws, never blocks (callers
// fire-and-forget). Returns the missing list for callers/probes.
async function runPreflight() {
  let pathEnv = process.env.PATH;
  try {
    const { resolveShellEnv } = require('./shell-env');
    const env = await resolveShellEnv();
    if (env && typeof env.PATH === 'string') pathEnv = env.PATH;
  } catch (_) {
    /* shell-env trouble -> fall back to the GUI PATH; a warning beats a crash */
  }
  const missing = checkPrerequisites({ pathEnv });
  if (!missing.length) return missing;
  const detail = missing
    .map((m) => `${m.cmd} (${m.severity}) — ${m.impact}`)
    .join('\n');
  console.warn(`[deck] missing host prerequisite(s):\n${detail}`);
  try {
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'warning',
      title: 'claude-deck — missing prerequisites',
      message: 'Some host prerequisites are missing',
      detail: `${detail}\n\nInstall them and restart. See the README (Quick start).`,
      buttons: ['OK'],
      noLink: true,
    }).catch(() => { /* dialog is best-effort; the console warning already fired */ });
  } catch (_) {
    /* no electron (headless probe) -> the console warning is the surface */
  }
  return missing;
}

module.exports = { runPreflight, checkPrerequisites };
