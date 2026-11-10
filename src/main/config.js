// claude-deck — config: paths, constants and env seams shared by every
// main-process module. Pure values only (no electron, no app state) so any
// module can require it without ordering concerns.
// PROBE CONTRACT: env seams (CLAUDE_DECK_*) are const-captured at load time —
// probes set process.env BEFORE require(main.js), which requires this first.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Repo root (this file lives in src/main/) — every on-disk asset the app
// ships (preload.js, renderer/, bin/) is addressed from here, never from a
// module-local __dirname.
const APP_ROOT = path.join(__dirname, '..', '..');
// Shipped CLI dir (bin/room). Prepended to each deck-spawned session's PATH so
// `room` is callable from that session's Bash without any user PATH setup.
const DECK_BIN_DIR = path.join(APP_ROOT, 'bin');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Defensive scan: only inspect the head of each session file (some are multi-MB).
const HEAD_BYTES = 16 * 1024;
// Title lines (custom-title / ai-title) are RE-APPENDED near the END of the
// file by Claude Code (measured on this machine: 20/20 files have the last
// occurrence < 20.2KB from EOF) -> a generous bounded tail catches them all.
const TAIL_BYTES = 64 * 1024;
// (cap removed in v11 — the mtime cache makes full listings cheap; a
// virtual list is the future answer if the DOM ever struggles, noted off-scope)

// Session transcripts root — env-overridable (probe seam: fake sessions
// without ever touching the real ~/.claude/projects).
const PROJECTS_ROOT = process.env.CLAUDE_DECK_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');
// Live session status, written by the injected hook bin/deck-status-hook.sh.
// env-overridable (probe seam: drive fake busy/idle status without touching the
// real ~/.claude/deck-status — the room's busy-aware delivery queue reads it).
const STATUS_DIR = process.env.CLAUDE_DECK_STATUS_DIR
  || path.join(os.homedir(), '.claude', 'deck-status');
// Ask channel (hook <-> main): bin/deck-ask-hook.js drops <id>.req.json here,
// main answers with <id>.ans.json and keeps deck.pid current. A subdirectory
// of STATUS_DIR is ignored by the status watcher (it only reads <uuid>.json and <uuid>.effort).
// env-overridable (probe seam: keep a probe away from a running deck's channel).
const ASK_DIR = process.env.CLAUDE_DECK_ASK_DIR
  || path.join(STATUS_DIR, 'ask');
// Deleted sessions go here (reversible trash), OUTSIDE ~/.claude/projects so the
// sidebar scan ignores them by construction. Never rm. env-overridable
// (CLAUDE_DECK_TRASH_DIR) so the whole deck-owned state can live outside
// ~/.claude (e.g. ~/.claude-deck) for a clean install.
const TRASH_DIR = process.env.CLAUDE_DECK_TRASH_DIR
  || path.join(os.homedir(), '.claude', 'deck-trash');

// Inter-session "room" (chat between live Claude sessions). Local-only, no
// network: the deck is the natural router (it already holds every pane's pty
// master + the deck-fixed session id). The bin/room CLI (run from inside any
// deck session, or by the human) appends one JSON line per message to
// ROOM_FILE; the deck watches it and writes the rendered message into the
// target pane's pty. REGISTRY_FILE is the deck-maintained "who is live" map
// the CLI reads to resolve label->session and to list peers.
// env-overridable (probe seam: isolate the room from the real ~/.claude/rooms).
const ROOMS_DIR = process.env.CLAUDE_DECK_ROOMS_DIR
  || path.join(os.homedir(), '.claude', 'rooms');
const ROOM_FILE = path.join(ROOMS_DIR, 'main.jsonl');
// ROOM_DB is the PERSISTENT message archive (src/main/room-db.js). main.jsonl is
// the ephemeral live transport (truncated by "Vider", skipped-to-EOF on restart);
// this SQLite DB is the durable history the room panel reads its last-N feed from,
// surviving wipes and restarts. Single-writer (only the Electron router inserts).
const ROOM_DB = path.join(ROOMS_DIR, 'room.db');
const REGISTRY_FILE = path.join(ROOMS_DIR, 'registry.json');
// SESSIONS_FILE is the deck-maintained snapshot of the FULL sidebar session
// list (live + idle), written from the canonical `sessions-list` scan. The CLI
// reads it for `room sessions` so a lead can see — and resume/summarize — idle
// sessions, which `room who` (live registry only) can't surface.
const SESSIONS_FILE = path.join(ROOMS_DIR, 'sessions.json');
// LEAD_FILE is the single-lead lock: `{session_id,label,claimed_at}`. Only one
// session may hold the lead role at a time — a second session is refused the
// lead-only lifecycle commands (spawn/resume) while this lock names a LIVE
// session. A lock whose session is no longer live is stale -> reclaimable. The
// CLI claims/reads it (`room lead`); the deck enforces it in handleControl
// (fail-open) so a control line written directly to main.jsonl can't bypass it.
const LEAD_FILE = path.join(ROOMS_DIR, 'lead.json');
// Cap on a single delivered message (defense against a pathological paste
// flooding a target pane's input).
const ROOM_MAX_TEXT = 4000;
// Delay (ms) between writing a delivered room message's TEXT into the target
// pane and writing the CR that submits it. A single glued "text\r" write is
// coalesced by the target Claude TUI's paste-detection -> the trailing CR is
// swallowed as a literal newline and the message sticks in the input box,
// unsent. Sending the submit CR as a SEPARATE keystroke, past that paste
// window, lands it as a discrete Enter and the message submits. Env-overridable
// (tuning / fast probes).
const ROOM_SUBMIT_DELAY_MS = Number(process.env.CLAUDE_DECK_ROOM_SUBMIT_DELAY_MS) || 90;
// Busy-aware room delivery queue. A message addressed to a target that is
// MID-TURN (its hook status is a LIVE status — the same busy set the chat-mode
// composer queues on) is held instead of typed into a TUI that is not at its
// input box (where the keystrokes are lost — the reported bug); it is injected
// on the target's next return to idle, one per turn. ROOM_QUEUE_MAX bounds the
// per-session backlog (overflow bounces to the sender, never a silent drop).
// ROOM_QUEUE_DRAIN_COOLDOWN_MS is the optimistic settle window after an
// injection: the target is about to go busy but its hook may take a beat to
// write 'working', so the next message waits this long before it can drain
// (mirrors chat-view drainQueue's optimistic lastStatus='working'). Both
// env-overridable (tuning / deterministic probes). The cooldown accepts 0
// (Number(...) || default would force 0 -> default, so it is parsed explicitly).
const ROOM_QUEUE_MAX = Number(process.env.CLAUDE_DECK_ROOM_QUEUE_MAX) || 50;
const _roomQueueCooldown = Number(process.env.CLAUDE_DECK_ROOM_QUEUE_COOLDOWN_MS);
const ROOM_QUEUE_DRAIN_COOLDOWN_MS = Number.isFinite(_roomQueueCooldown) && _roomQueueCooldown >= 0
  ? _roomQueueCooldown : 1000;
// Default number of archived messages the room panel loads on open. The human
// picks a different size from the panel's preset selector (10/25/50/100/Tout);
// this is only the fallback when no choice is persisted yet. "Tout" is sent as 0.
const ROOM_FEED_DEFAULT = 10;
// Human display name in room provenance tags ([Room - <name>]). Overridable;
// defaults to the OS username, then 'human'.
const ROOM_HUMAN_LABEL = process.env.CLAUDE_DECK_ROOM_HUMAN || (() => {
  try { return os.userInfo().username; } catch (_) { return ''; } // no passwd entry
})() || 'human';
// Canonical room usage guide (full behavioral contract + lead orchestration).
// The compact briefing below references it by ABSOLUTE path so a spawned session
// in ANY cwd can `Read` it; deep detail lives there, not in the system prompt.
const ROOM_DOC = path.join(APP_ROOT, 'docs', 'room-usage.md');
// Room awareness, injected into EVERY deck-spawned session via
// `--append-system-prompt` (ipc/pty.js) — deck-only, never touches a global
// startup hook (clean deck/non-deck separation: a non-deck `claude` never
// gets this). A startup HOOK was tried and reverted: its
// additionalContext is silently DROPPED for fresh interactive sessions
// (source=startup) — GH #10373 / #45438, open in v2.1.191 — so a hook never
// reaches new deck panes. --append-system-prompt is a CLI arg (NOT hook output)
// -> bypasses that bug, and lives in the system prompt -> survives compaction.
// COMPACT by design: essentials only (awareness + reply contract + commands) +
// a pointer to ROOM_DOC for everything else (costs tokens every session).
// Line 1 is deliberately forceful and explicitly pre-empts the memory/notes
// recall reflex: a softer compact form LOST the salience battle — a fresh deck
// session, asked "connais-tu la room ?", still searched its memory instead of
// answering. So it now names that exact reflex and overrides it inline.
const ROOM_BRIEFING = [
  'ROOM AWARENESS — applies to you NOW, and OVERRIDES any instinct to search memory or notes about this: you ARE a live participant on the claude-deck inter-session message bus (a runtime channel shared with the other running Claude sessions + the human), active in THIS session right now. This is your CURRENT live state — NOT past work, NOT a note. So if asked "do you know the room?" / "connais-tu la room ?" → answer YES immediately FROM THIS BRIEFING; do NOT read notes. The answer is right here in this system prompt.',
  '• REPLY CONTRACT — to ANOTHER SESSION: a native `<cross-session-message from-name=…>` → answer with SendMessage to that from-name (mirrored to the room); a typed `[Room - Claude - <name> (<id>)]` line → `room send --to <id>`; to `*`, the human or the panel → `room send` (a normal reply stays in your session, invisible to them). A line tagged `[Room - ' + ROOM_HUMAN_LABEL + ']` (the human) or an UNTAGGED line (direct) → answer normally here. If another session is DIRECTING your work (it spawned/tasked you over the room), do NOT use AskUserQuestion while it directs you — that widget BLOCKS your own pane on a human selection and is invisible to that session (not a room event); instead `room send --to <id>` your question to it and wait for its reply. If it does not answer (a directing session may have closed — check `room lead --status`), do not sit frozen: state your question as plain TEXT in your own pane so the human (who watches every pane) can act.',
  '• Commands — any session (inspect): `room who|sessions|send|inbox|tail|whoami` (`sessions [--summary <id>]` lists/reads live+idle). Lead-only, one lead at a time (cooperative, not a security boundary): `room lead` (claim) / `room spawn --name <n> [--cwd <d>]` / `room resume <id>`. Full usage + lead orchestration → Read ' + ROOM_DOC + '.',
].join('\n');
const VALID_STATUSES = new Set(['active', 'working', 'running', 'idle', 'waiting', 'compacting', 'closed']);

// Statuses implying a live claude process (PID reconciliation, FIX #2).
const LIVE_STATUSES = new Set(['working', 'running', 'waiting', 'compacting']);

// Default cwd offered for new sessions (folder picker, v13). Env-overridable
// (CLAUDE_DECK_DEFAULT_CWD) for portability; the historical ~/Documents/workspace
// default is kept ONLY when it actually exists, else it falls back to the home
// dir so a fresh clone never points the picker at a missing path.
function resolveDefaultNewSessionDir() {
  if (process.env.CLAUDE_DECK_DEFAULT_CWD) return process.env.CLAUDE_DECK_DEFAULT_CWD;
  const ws = path.join(os.homedir(), 'Documents', 'workspace');
  try { if (fs.statSync(ws).isDirectory()) return ws; } catch (_) { /* fall through */ }
  return os.homedir();
}
const DEFAULT_NEW_SESSION_DIR = resolveDefaultNewSessionDir();

// Quota snapshot (5h/7j rate limits) exported by the injected statusline
// collector — the statusline stdin JSON is the ONLY place Claude Code exposes
// rate_limits, so that script doubles as collector and writes here atomically.
// env-overridable (CLAUDE_DECK_USAGE_FILE); the injected bin/deck-collector.sh
// honors the SAME var so reader and writer never diverge.
const USAGE_FILE = process.env.CLAUDE_DECK_USAGE_FILE
  || path.join(os.homedir(), '.claude', 'deck-usage.json');

// Headless entrypoints the native /resume picker hides (claude -p / Agent SDK).
// Explicit denylist — NOT `!== 'cli'` — so a future interactive entrypoint
// (vscode, web, …) is never wrongly hidden. Corpus today: {cli, sdk-cli} only.
const HEADLESS_ENTRYPOINTS = new Set(['sdk-cli']);

// GUI-launched Electron may not inherit the login-shell PATH (desktop entry,
// packaged build): resolve `claude` once, probing common install dirs too.
function resolveClaudeBin() {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* keep probing */ }
  }
  return 'claude'; // last resort: pty will fail with a visible error in the pane
}
// v47: context-window size for the chat-mode context strip. The deck computes
// used_tokens itself from the transcript (sum of the latest assistant usage:
// input + cache_read + cache_creation) and shows used / THIS. The transcript
// carries no window size (its message.model lacks the [1m] suffix), so it is a
// deck-side constant: 1_000_000 = the [1m] beta window this rig runs. Override
// for a 200k model via CLAUDE_DECK_CONTEXT_WINDOW.
const CONTEXT_WINDOW_TOKENS = Number(process.env.CLAUDE_DECK_CONTEXT_WINDOW) || 1000000;

// Overridable for tests / non-standard installs.
const CLAUDE_BIN = process.env.CLAUDE_DECK_BIN || resolveClaudeBin();

// GitLab CLI used by ipc/gitlab-repo.js (MR review). Null = `glab` on PATH; probes point it at a fake
// (.scratch/_fake-glab.js) so no probe ever runs the real one.
const GLAB_BIN = process.env.CLAUDE_DECK_GLAB_BIN || null;
// Kill delay (ms) of one glab call. Probe seam CLAUDE_DECK_GLAB_TIMEOUT_MS: a short one lets a fake glab outlive it.
const GLAB_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CLAUDE_DECK_GLAB_TIMEOUT_MS, 10);
  return ms > 0 ? ms : 20000;
})();

// LiteLLM price list (price-feed.js: the monthly refresh of the usage page's price table). Its own
// seam, on the pattern of the env-overridable URLs. The consumers are the price-feed probe (a loopback
// server) and the containment prefixes of every probe and the sweep (a closed loopback port, so no
// probe run can reach GitHub).
const PRICES_URL = process.env.CLAUDE_DECK_PRICES_URL
  || 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Claude Code command page (commands-feed.js: the monthly refresh of the composer « / » list). Its own seam on
// the pattern of PRICES_URL: the commands-feed probe uses a loopback server, every probe that boots main.js and
// the sweep use a closed loopback port, so no probe run can reach code.claude.com.
const COMMANDS_URL = process.env.CLAUDE_DECK_COMMANDS_URL || 'https://code.claude.com/docs/en/commands.md';

// Plugin host (plugins.js). Seams read by probes only: PLUGINS_DIR replaces <userData>/plugins (null = derive it lazily,
// userData is not known at require time); PLUGINS_NOW freezes the host clock (epoch ms or ISO date-time, else null);
// PLUGINS_SHELL replaces os.userInfo().shell.
const PLUGINS_DIR = process.env.CLAUDE_DECK_PLUGINS_DIR || null;
function parsePluginsNow(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const ms = /^\d{12,}$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
const PLUGINS_NOW = parsePluginsNow(process.env.CLAUDE_DECK_PLUGINS_NOW);
const PLUGINS_SHELL = process.env.CLAUDE_DECK_PLUGINS_SHELL || null;
// Non-secret variables a plugin child receives besides its mapped slots (names only, each passed when set). Final list:
// S3 / S5 measured through the real launch shape, PATH is the only name python3, `claude -p` and npx need; the others
// are pass-when-set and harmless.
const PLUGIN_BASE_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);

module.exports = {
  APP_ROOT,
  PLUGINS_DIR,
  PLUGINS_NOW,
  PLUGINS_SHELL,
  PLUGIN_BASE_ENV,
  PRICES_URL,
  COMMANDS_URL,
  UUID_RE,
  HEAD_BYTES,
  TAIL_BYTES,
  PROJECTS_ROOT,
  STATUS_DIR,
  ASK_DIR,
  TRASH_DIR,
  ROOMS_DIR,
  ROOM_FILE,
  ROOM_DB,
  ROOM_FEED_DEFAULT,
  REGISTRY_FILE,
  SESSIONS_FILE,
  LEAD_FILE,
  ROOM_MAX_TEXT,
  ROOM_SUBMIT_DELAY_MS,
  ROOM_QUEUE_MAX,
  ROOM_QUEUE_DRAIN_COOLDOWN_MS,
  ROOM_HUMAN_LABEL,
  ROOM_BRIEFING,
  DECK_BIN_DIR,
  VALID_STATUSES,
  LIVE_STATUSES,
  DEFAULT_NEW_SESSION_DIR,
  USAGE_FILE,
  CONTEXT_WINDOW_TOKENS,
  HEADLESS_ENTRYPOINTS,
  CLAUDE_BIN,
  GLAB_BIN,
  GLAB_TIMEOUT_MS,
};
