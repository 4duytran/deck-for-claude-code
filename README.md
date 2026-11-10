# claude-deck

A desktop app for running several live **Claude Code** sessions side by side.
Each session is a real `claude` process in its own terminal pane; a sidebar lets
you resume, inspect and manage every past session, with git diffs, plans, live
status and quota estimates next to the conversation. It never modifies your
global Claude Code configuration: everything the deck adds is injected per
spawned session.

> claude-deck is an independent project. Claude and Claude Code are products of
> Anthropic; this repository is not affiliated with or endorsed by Anthropic.

The interface is in French (labels such as « Fichiers », « Coût », « Plein
écran »); this README quotes those strings as they appear.

## Features

- **Terminal grid** — multiple live `claude` panes (node-pty + xterm.js), with
  smart copy/paste: system CLIPBOARD on Ctrl+C/V and X11 PRIMARY copy-on-select
  with middle-click paste.
- **New session anywhere** — a "new session" menu with a native folder picker or
  a quick-typed path. The deck fixes `--session-id` at spawn, so the pane adopts
  the session immediately and the chat view works before the first message.
  Folders are tagged in the menu (the default tag reads « défaut »).
- **Session sidebar** — every past session grouped by its real project folder;
  resume in a pane, rename (writes `custom-title` + `agent-name`, deferred while
  the session is busy), delete (moved to a reversible trash, never `rm`), search
  and status filters. Refreshes on status transitions with no polling.
- **Live status badges** — working / waiting / done per session, driven by a
  small hook shipped in `bin/` (see [Claude Code integration](#claude-code-integration)).
- **Chat view** — a per-pane toggle that renders the session transcript as a
  conversation: user and Claude turns, Claude's markdown, tool cards folded by
  default (an error result unfolds itself), sub-agent dispatches with a live feed
  of their tool calls, and an activity strip naming what runs (the running tool,
  or « Claude réfléchit » between tools) with an elapsed timer. A composer at the
  bottom sends through the PTY (bracketed paste + CR, the same path as typing);
  sends issued while Claude is busy wait in a visible, editable queue and leave
  in order, one per return to idle.
- **Answer Claude Code's prompts from the chat** — blocking menus (tool
  permissions, `AskUserQuestion`, plan approval, trust dialog) are parsed from
  the xterm buffer and mirrored as an answer panel above the composer; a click
  types the option number into the PTY. A permission-mode dropdown (normal /
  auto-accept / plan / auto) and a send button that turns into STOP (Esc) while
  Claude works sit on the input card. Interrupts can leave no transcript trace,
  so the chat fuses the status file with two hook-free signals (the spinner line
  on screen and the PTY output flow) to reconcile a stale "busy" status.
- **Side panel** — tabs docked beside the session:
  - **Git** — per-session touched repos (including linked worktrees),
    working-tree status and diffs (diff2html) with context expansion, commit
    history graph with branches and tags (read-only: no checkout, push or
    fetch), and a GitLab merge-request review view (list, diff, threads,
    drafts) that goes through the `glab` CLI when you use it.
  - **Plans** — plans the session wrote (`plans/*.md` and `.html` write calls,
    plus native `ExitPlanMode` plans), markdown rendered with markdown-it,
    HTML plans in a sandboxed frame.
  - **Fichiers** — a lazy file tree of the session's folder, search, and a viewer
    (HTML pages open in a sandboxed frame). Selecting text offers « Demander à
    Claude » to ask about it in the session.
  - **Terminal** — a real shell per live pane, started in the session's folder.
- **Presence icons** — per-card GIT / PLAN icons plus the top-touched repo name,
  computed in one cached pass over the transcripts.
- **Usage** — gauges in the header and a full page (« Coût », « Tokens »,
  « Limites »): 5-hour quota blocks reconstructed from the transcripts, cost and
  token reports from a bundled API price table (an estimate, never a bill), and
  the real `rate_limits` when the statusline collector can export them.
- **Room** — a local message bus between live sessions and you, with a panel
  and a CLI. See [The room](#the-room).
- **Plugins** — a plugin host that runs a plugin folder (one holding a
  `deck-plugin.json` manifest) through your own shell and shows its HTML report
  in a Plugins panel. See `src/main/plugins.js`.
- **Modes** — `code` (the grid) and `ai` (an embedded claude.ai
  `WebContentsView`, loaded lazily).
- **Shell-env resolution** — a GUI-launched Electron app inherits a minimal
  environment, so a directly spawned `claude` would miss secrets you export from
  `~/.bashrc` (MCP tokens, for example) and its MCP servers would fail to
  authenticate. `src/main/shell-env.js` resolves your interactive-shell
  environment once (`$SHELL -i -c "env -0"`, memoized with a TTL, falling back to
  `process.env`) and uses it as the PTY spawn environment, so the deck behaves
  like a terminal however it was launched. It drops non-identifier names
  (`BASH_FUNC_*`) and logs only counts and causes, never values.

## Requirements

- **Linux with an X11 session** (developed and tested on Ubuntu).
- **Claude Code CLI** (`claude`) installed, on your `PATH` and logged in.
- **Node.js 22.12 or newer**, with npm (the minimum of Electron 42).
- **`jq`**, used by the shipped `bin/` status and quota scripts.
- A C/C++ toolchain (on Ubuntu: `build-essential` and `python3`), because
  `npm install` rebuilds `node-pty` against Electron's ABI.
- Optional: `glab` for the GitLab merge-request view, and `xvfb` (`xvfb-run`) to
  run the tests on an invisible display.

The deck runs a boot **preflight** that warns, on the console and with a one-shot
dialog, when `claude` or `jq` is missing, instead of letting the dependent
feature fail silently.

> **Ubuntu 24.04+ sandbox**: AppArmor restricts unprivileged user namespaces, so
> Electron's `chrome-sandbox` helper must be `root:root 4755`:
>
> ```bash
> sudo chown root:root node_modules/electron/dist/chrome-sandbox
> sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
> ```
>
> Run it after the Electron binary is installed (see [Install](#install)), and
> redo it after every Electron reinstall or `npm install` that replaces it.
> Without it Electron dies with
> `FATAL setuid_sandbox_host` before any window opens. As a fallback you can
> start the app with `ELECTRON_DISABLE_SANDBOX=1`: the deck only loads local
> content, with `contextIsolation` on and a restrictive CSP.

## Install

```bash
git clone https://github.com/4duytran/claude-deck
cd claude-deck
npm install   # the postinstall step rebuilds node-pty for Electron (mandatory)
npx install-electron --no   # downloads the Electron binary (about 100 MB, cached in ~/.cache/electron)
npm start
```

Since Electron 42, `npm install` no longer downloads the Electron binary. Run
`npx install-electron --no` once after `npm install`, or skip it: the first
`npm start` downloads the binary by itself. On Ubuntu 24.04+, apply the
`chrome-sandbox` fix from [Requirements](#requirements) once the binary is
installed.

## Claude Code integration

The deck talks to Claude Code through four small files in `bin/`. All of them
reach a session through `claude --settings <generated file>` or the session's
`PATH`; your own `~/.claude/settings.json` is only ever read, never written.

| File | Role |
|---|---|
| `bin/deck-status-hook.sh` | The bundled status hook: maps Claude Code lifecycle events to one status file per session. It never blocks, never writes to stdout or stderr, and always exits 0. |
| `bin/deck-collector.sh` | Statusline proxy: exports `rate_limits` to a usage file, then delegates the display to your own `statusLine` command, so the visible statusline does not change. |
| `bin/deck-ask-hook.js` | `PreToolUse` hook for `AskUserQuestion`: hands the question to the deck's answer drawer. Fail-open: anything but an explicit answer leaves Claude Code's native menu. |
| `bin/room` | The room CLI. The deck adds `bin/` to the end of every session's `PATH`, so `room` works in a session with no setup. |

**The status hook is injected for you.** For each deck-spawned session,
`src/main/settings-injection.js` builds the `--settings` payload and adds
`deck-status-hook.sh` on every lifecycle event it tracks. Hooks from all settings
sources run cumulatively, so the deck avoids duplicating yours: **the injection is
skipped when your user settings already wire a hook whose command contains
`deck-status`** (and likewise for `deck-ask-hook`). The statusline is always
replaced by the collector, which re-runs your own command for display.

By default the status files live in `~/.claude/deck-status/`. Set
`CLAUDE_DECK_STATUS_DIR` to keep them elsewhere (for example under
`~/.claude-deck`); the deck and its injected scripts then agree on the new
location. If you wired `deck-status-hook.sh` globally yourself, your copy must
honor the same variable, otherwise it keeps writing to the old directory and the
badges silently stay empty.

Status badges therefore work for deck-spawned sessions (and for sessions of a
globally hooked setup); a `claude` you start in another terminal is not tracked
unless you wire the hook yourself.

## The room

The room is a **local message bus** between the live sessions of the deck and
you. A session sends a message with the `room` CLI (`room send --to <name|id|*>
"..."`, plus `room inbox`, `room tail`, `room who`, `room whoami`,
`room sessions`); the deck, which owns every pane's PTY, writes the rendered
message into the target pane and submits it, which wakes even an idle session
sitting at its prompt. A broadcast (`*`) never returns to its sender, and an
undeliverable directed message bounces back to its sender with a visible reply.
Native Claude Code cross-session messages are mirrored into the same feed. The
deck's Room panel shows the feed and lets you post as the human.

- Messages are tagged by provenance: `[Room - <name>]` is you, and
  `[Room - Claude - <name> (<id>)]` is another session. Your display name comes
  from `CLAUDE_DECK_ROOM_HUMAN`, then your OS username, then `human`.
- Everything is local (`~/.claude/rooms/`, or `CLAUDE_DECK_ROOMS_DIR`): a live
  JSONL transport and a persistent SQLite archive that the panel reads. No
  network.
- A compact room briefing is appended to each deck-spawned session's system
  prompt (`--append-system-prompt`), pointing at `docs/room-usage.md`. Sessions
  you start outside the deck have no room.
- **Trust model:** the room is a trusted, single-user channel. A message is
  submitted as a prompt to the target session, so cross-session prompt injection
  is by design, and the coordination it offers is not a security boundary. Read
  the trust section of `docs/room-feature.md` before relying on it.

### The bundled skill `room-mirror:room-lead`

`mods/room-mirror` is a small Claude Code plugin that the deck loads into each
deck-spawned session with `--plugin-dir` (not when `CLAUDE_DECK_BIN` points at a
wrapper binary). It carries two things:

- a hook that copies a model's native `SendMessage` to a room member into the
  room feed, feed-only: the send itself is never blocked, rewritten or failed;
- the skill **`room-mirror:room-lead`** (`mods/room-mirror/skills/room-lead/SKILL.md`),
  which turns one session into the **lead** of the others: claim the single lead
  role (`room lead`), spawn named workers (`room spawn --name <role> --cwd <dir>`),
  assign and follow up with `room send`, collect replies with `room inbox`, and
  reopen a closed worker with `room resume`. Only one lead is live at a time;
  the deck refuses a rival's spawn or resume.

Ask a session to act as lead with that skill. The judgment layer (decomposing a
goal, assigning by fit, verifying a worker's "done") is in
`docs/room-lead-playbook.md`; the full reference is `docs/room-usage.md`.

## Architecture

| Layer | Choice |
|---|---|
| Shell | Electron 42 (`contextIsolation: true`, `nodeIntegration: false`), global `fetch` in main |
| Terminal | node-pty (one PTY per pane) + xterm.js 5 (fit and webgl addons) |
| Rendering | Vanilla JS / HTML / CSS: no framework, no bundler. xterm, diff2html and markdown-it load as UMD builds through `<script>`; the deck's own code is native ES modules |
| Diffs | simple-git (read-only) + diff2html |
| Markdown | markdown-it with `html: false` |

```
┌──────────────── main.js (composition root) + src/main/ (Electron main) ──────────┐
│ PTY lifecycle (claude per pane) · transcript scanner + caches · git/plans readers │
│ status-dir fs.watch · usage estimator · rooms router · plugin host · claude.ai view │
└──────────────────────────────┬────────────────────────────────────────────────────┘
                               │ IPC (invoke/handle + push events)
                        preload.js — contextBridge `window.api`
                               │ (the ONLY renderer↔main surface)
┌──────────────────────────────┴─── renderer/js/ (native ES modules, DOM-only) ─────┐
│ xterm grid · sidebar · side panel (git, plans, files, terminal) · chat view · room │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Hard rule:** all filesystem access, parsing and child processes live in the
main process (`src/main/`). The renderer only renders what IPC gives it, with
zero IO at render time, and transcript or user data reaches the DOM through
`textContent` only.

Main modules (not exhaustive):

```
main.js                    # composition root, THE entrypoint (probes require it)
preload.js                 # the ONLY renderer↔main bridge (contextBridge)
src/main/
  config.js                # paths, constants, env seams (loaded first)
  state.js                 # shared mutable registries (data only, no logic)
  window.js                # BrowserWindow + send() push helper
  settings-injection.js    # per-spawn `claude --settings` payload
  shell-env.js             # interactive-shell env for PTY spawns
  preflight.js             # boot check for `claude` and `jq`
  transcripts.js           # low-level session .jsonl access
  session-meta.js          # sidebar head+tail meta scan (mtime-cached)
  session-status.js        # live status, watcher, busy-guard, PID reconcile
  session-titles.js        # close-time name/rename injection
  session-activity.js      # THE one-pass transcript parse (repos, plans, flags)
  usage-estimator.js       # pure-Node quota block reconstruction
  rooms.js  room-db.js     # room router + persistent archive
  plugins.js  plugin-*.js  # plugin host
  ipc/                     # one file per IPC handler family
renderer/js/               # native ES modules; boot.js wires IPC and init order
mods/room-mirror/          # bundled Claude Code plugin (hook + room-lead skill)
bin/                       # status hook, statusline collector, ask hook, room CLI
```

The main-process dependency graph is acyclic: `config` ← `state` ← `window` ←
`transcripts` ← `session-*` ← `ipc/*` ← `main.js`. `state.js` holds data only and
never requires another module, which keeps it cycle-free.

### Data sources

All local, and read-only except the deck's own files.

| Source | Used for |
|---|---|
| `~/.claude/projects/*/<uuid>.jsonl` (+ `<uuid>/subagents/*.jsonl`) | session list, project folder, git and plan activity, presence icons, usage |
| `~/.claude/deck-status/<sessionId>` (written by the bundled hook) | live status badges |
| `~/.claude/deck-usage.json` (written by the statusline collector) | rate-limit display |
| `~/.claude/deck-trash/` | sessions deleted from the sidebar (reversible) |
| `~/.claude/rooms/` | room transport, registry and archive |
| local git repositories (via simple-git, read-only) | git panel status and diffs |

The project folder is read **from inside each session's `.jsonl`**; the
`~/.claude/projects` folder-name encoding is lossy and is never decoded.

Network: everything the deck displays comes from local files. The deck itself
reaches the network for the embedded claude.ai view (AI mode) and to refresh two
public lists when the stored copy is missing or older than 30 days (the LiteLLM
model-price list from GitHub, and the Claude Code command list from
code.claude.com). `glab` talks to your GitLab only when you open the merge-request
view.

### The one-pass activity scan

`sessionActivity(sessionId)` in `src/main/session-activity.js` walks a session's
transcripts once and derives everything activity-related (touched git repos,
written plans). It is stamp-cached (mtime + size of every transcript file, so any
append invalidates and nothing polls), pre-filtered (cheap substring checks
before any `JSON.parse`), and the only aggregate parser: features that derive
aggregates extend this pass instead of adding a second scan. Sidebar presence
icons use the same pass through a background queue: a cache miss renders nothing
(never a false positive) and a `session-flags` push fills the row once computed.

## Configuration

Every variable is optional.

| Variable | Effect |
|---|---|
| `CLAUDE_DECK_STATUS_DIR` | live-status files (default `~/.claude/deck-status`) |
| `CLAUDE_DECK_USAGE_FILE` | quota snapshot (default `~/.claude/deck-usage.json`) |
| `CLAUDE_DECK_TRASH_DIR` | trash of deleted sessions (default `~/.claude/deck-trash`) |
| `CLAUDE_DECK_ROOMS_DIR` | room transport, registry and archive (default `~/.claude/rooms`) |
| `CLAUDE_DECK_ROOM_HUMAN` | your name in room tags (default: OS username, then `human`) |
| `CLAUDE_DECK_PROJECTS_DIR` | session transcripts root (default `~/.claude/projects`) |
| `CLAUDE_DECK_DEFAULT_CWD` | default folder of the new-session picker (otherwise `~/Documents/workspace` when it exists, else `$HOME`) |
| `CLAUDE_DECK_ZOOM` | UI zoom (also Ctrl +, Ctrl -, Ctrl 0, persisted) |
| `CLAUDE_DECK_CONTEXT_WINDOW` | context-strip window size (default 1000000) |
| `CLAUDE_DECK_NO_SHELL_ENV` | `1` skips the interactive-shell env resolution |
| `CLAUDE_DECK_SHELL_ENV_TTL_MS` | shell-env re-resolve interval (default 60000) |
| `CLAUDE_DECK_AI_URL` | URL of the embedded claude.ai view |
| `CLAUDE_DECK_PRICES_URL`, `CLAUDE_DECK_COMMANDS_URL` | where the two public lists are fetched from |
| `CLAUDE_DECK_BIN` | the binary spawned in a pane instead of `claude` (a wrapper binary gets no settings or plugin injection) |
| `CLAUDE_DECK_FORCE_INJECT` | force the settings injection even for a custom binary |
| `CLAUDE_DECK_NO_OPEN` | suppress `shell.open*` calls |
| `CLAUDE_DECK_PLUGINS_DIR` | replaces `<userData>/plugins` |
| `CLAUDE_DECK_GLAB_BIN` | the `glab` binary used by the merge-request view |

The first five let you keep all deck-owned state out of `~/.claude` (for example
under `~/.claude-deck`). The injected `bin/` scripts read `CLAUDE_DECK_STATUS_DIR`
and `CLAUDE_DECK_USAGE_FILE` themselves, so the writer and the reader stay
consistent end to end. `src/main/config.js` lists every other seam.

## Tests

The project has no unit-test framework. It is verified by **E2E probes**:
standalone Electron scripts in `test/` that boot the real app against throwaway
fixtures and assert on the real DOM, IPC and filesystem.

```bash
npm test                          # every probe, on a private invisible Xvfb
bash test/run.sh zoom-probe       # one probe (or several, space-separated)
TEST_VISIBLE=1 bash test/run.sh   # same, on your real display
```

`npm test` runs `test/run.sh`, which re-executes itself under `xvfb-run` so no
window appears on your desktop (without `xvfb-run` the probe windows open on
your display, with a notice). It also keeps the run contained: loopback URLs for
the two price and command feeds, a throwaway plugins folder, and a pinned UI
zoom. Each probe writes its output to `test/<name>.out`; the last line is
`===== SWEEP: N ok / M bad =====` and the exit code is 1 when any probe is bad.
Run `npm install` first: the runner needs `node_modules/.bin/electron`.

Quick syntax gates while you work:

```bash
for f in main.js src/main/*.js src/main/ipc/*.js; do node --check "$f"; done
# renderer ES modules: copy to .mjs (node --check parses bare .js as CommonJS)
for f in renderer/js/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs; done
```

Probes drive the renderer through `executeJavaScript` against the **probe seam**:
`renderer/js/boot.js` assigns the shared state objects and UI functions (`panes`,
`setMode`, `openPane`, ...) onto `window` by name.

## Known limitations

- **Bash-blindness**: activity detection reads `tool_use` entries, so files
  written through shell heredocs are invisible to git and plan detection.
- Plans outside a `plans/` directory are not detected.
- Status badges need deck-spawned (or globally hooked) sessions.
- The usage figures are an estimate calibrated on local history, not the
  server-side limit.
- Linux and X11 only; the interface text is French.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow, the rules the code follows and how to write a probe.

## License

MIT, see [LICENSE](LICENSE).
