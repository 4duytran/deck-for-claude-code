// claude-deck — v35 per-spawn settings injection. The deck must work for ANY
// user without touching ~/.claude/settings.json. The two scripts the deck
// used to expect in the user's global config (status hooks + statusline quota
// collector) are SHIPPED in bin/ and injected per deck-spawned session via
// `claude --settings` (CLI layer: overrides user settings for THIS process
// only — except hooks, which MERGE across sources and run cumulatively,
// hence the duplicate guard below).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { APP_ROOT, ASK_DIR } = require('./config');

const DECK_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'PreCompact'];

// The pieces below are exported so a settings variant built outside the deck (an optional module's own
// posture, via the spawn hook of ipc/pty.js) reuses them instead of copying them.

// The user's own settings, read-only. Absent/malformed -> {} (inject everything).
function readUserSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch (_) { return {}; }
}

// statusLine: swapped for the collector, which transparently re-runs the
// user's own command for the DISPLAY (read from settings.json at runtime)
// — cosmetic keys (padding…) are replicated. Always injected: harmless
// even when the user's statusline already exports deck-usage.json itself.
function statusLineSetting(user) {
  return Object.assign({}, user.statusLine || {}, {
    type: 'command',
    command: `sh "${path.join(APP_ROOT, 'bin', 'deck-collector.sh')}"`,
  });
}

// One deck-status element per DECK_HOOK_EVENTS event.
function statusHooks() {
  const cmd = `sh "${path.join(APP_ROOT, 'bin', 'deck-status-hook.sh')}"`;
  const hooks = {};
  for (const ev of DECK_HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: cmd }] }];
  }
  return hooks;
}

// `ask: false` builds the variant without the AskUserQuestion hook and without crossSessionInbound.
function buildInjectedSettings({ ask = true } = {}) {
  const user = readUserSettings();
  const injected = {};
  injected.statusLine = statusLineSetting(user);
  // hooks: injected ONLY when the user's config does not already wire the
  // deck status hook (sources merge -> a duplicate would double every write).
  // NB: the room briefing is NOT a hook — it is injected via
  // `--append-system-prompt` at spawn (ipc/pty.js), which touches no hooks and
  // so carries zero risk of disturbing the user's global hook set.
  const userHooks = JSON.stringify(user.hooks || {});
  if (!userHooks.includes('deck-status')) {
    injected.hooks = statusHooks();
  }
  // AskUserQuestion -> the deck's question drawer (bin/deck-ask-hook.js, fail-open:
  // any non-answer path leaves the CLI's native menu). Same dedup as above; it is
  // appended AFTER deck-status, and alone when the user already wires deck-status.
  if (ask && !userHooks.includes('deck-ask-hook')) {
    const askCmd = `node "${path.join(APP_ROOT, 'bin', 'deck-ask-hook.js')}" ask "${ASK_DIR}"`;
    injected.hooks = injected.hooks || {};
    injected.hooks.PreToolUse = injected.hooks.PreToolUse || [];
    // timeout 86400 s (24 h): the terminal's own menu never expires, so the hook waits for the user too.
    // Tied to TIMEOUT_S of bin/deck-ask-hook.js and STALE_MS of ipc/ask.js (the probes pin the three).
    injected.hooks.PreToolUse.push({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: askCmd, timeout: 86400 }] });
  }
  // Ordinary deck panes accept native cross-session messages (SendMessage); without it the CLI holds them undelivered.
  if (ask) injected.crossSessionInbound = 'accept';
  return JSON.stringify(injected);
}
// Built once at boot (settings edits while the deck runs are not chased).
// Inject whenever we actually spawn `claude` — i.e. CLAUDE_DECK_BIN unset
// (resolveClaudeBin found the real claude) OR set to a path that still BASENAMES
// to `claude`. The desktop launcher legitimately EXPORTS CLAUDE_DECK_BIN =
// resolved claude path (GUI Electron doesn't inherit the login-shell PATH), so
// gating on mere PRESENCE of the var (the old bug, fixed here) silently
// disabled BOTH --settings AND --append-system-prompt (the room briefing) on
// every desktop launch — sessions then had zero room awareness. Probes instead
// point CLAUDE_DECK_BIN at /bin/bash or a
// fake-claude.sh / claude-shim.sh stub (basename != claude) — a shell would
// choke on `--settings {...}` — so they stay un-injected unless a probe opts
// back in via CLAUDE_DECK_FORCE_INJECT to inspect the real argv end-to-end.
const INJECT_SETTINGS =
  !process.env.CLAUDE_DECK_BIN
  || path.basename(process.env.CLAUDE_DECK_BIN) === 'claude'
  || process.env.CLAUDE_DECK_FORCE_INJECT === '1';
const INJECTED_SETTINGS_JSON = buildInjectedSettings();

module.exports = {
  INJECT_SETTINGS, INJECTED_SETTINGS_JSON,
  buildInjectedSettings, DECK_HOOK_EVENTS, readUserSettings, statusLineSetting, statusHooks,
};
