# CLAUDE.md — claude-deck

Instructions for developing this project with Claude Code. `README.md` explains
*what* the app is and how to use it; this file is the *how to work on it* contract.

## What this is

claude-deck is an Electron desktop app that manages several Claude Code sessions
side by side: a terminal grid, a session sidebar, a chat view, a side panel
(files / git / plans / terminal), rooms, plugins and a usage page. Electron main +
preload + renderer; the main process is Node CommonJS, the renderer is native ES
modules; `node-pty` is the one native addon.

There is one manual CI workflow, `.github/workflows/macos.yml`, that runs `npm ci` and the
probe sweep on GitHub macOS runners; no unit-test framework, no TypeScript, no linter. Quality
is enforced by the E2E probes in `test/` (run them with `npm test`) and by the
non-negotiable rules below. The app is French-language: product strings shown to the
user are French; identifiers, comments, commit messages and docs stay English.

## Non-negotiable rules

1. **No framework, no bundler, no new dependencies** unless explicitly asked.
   Vanilla JS everywhere; vendor libs are UMD builds loaded via `<script>`.
   The dependency budget is deliberate: seven runtime dependencies (`@xterm/xterm`,
   `@xterm/addon-fit`, `@xterm/addon-webgl`, `diff2html`, `markdown-it`, `node-pty`,
   `simple-git`) and two dev dependencies (`electron`, `@electron/rebuild`).
2. **Renderer security**: transcript/user data reaches the DOM via
   `textContent` ONLY — never `innerHTML` with external data (transcripts can
   contain hostile markup; probes assert XSS gates). TWO sanctioned exceptions:
   (a) `markdown-it` instantiated with `html: false` (plans panel v40, chat view
   v42) — its renderer escapes raw HTML, and main blocks `will-navigate` +
   `window.open` so rendered links can never hijack the window; (b) the HTML page
   frames, three kinds. A Files « Format riche » page with no `script` element and no
   `on*` attribute (D24): an `<iframe sandbox="allow-same-origin">` filled through
   `srcdoc` after a DOMParser pass removing `meta[http-equiv]`, `base`, `link`. No
   `allow-scripts`, so no script runs; `allow-same-origin` only so the parent reads
   the selection and attaches capture listeners that block link / area clicks, Enter
   on links and form submits; the frame inherits the app CSP (no external fetch);
   the page HTML never enters the app's own DOM.
   A Files page WITH a `script` element or an `on*` attribute (`pageHasScript`), and
   every `.html` FILE plan of the Plans tab (an inline plan stays markdown), runs in a CLOSED frame (`mountClosedFrame`):
   an `<iframe sandbox="allow-scripts">`, EXACTLY that and never `allow-same-origin`
   (opaque origin: no reach into the Deck document, no `window.api`), whose `src` is
   a `deckpage://` URL served by main (`src/main/page-scheme.js`): a Files or Plans
   page from its text with ONE inline selection-relay `<script>` injected (`withSelectRelay`,
   the `files` and `plans` slots, `RELAY_SLOTS`; never `plugin`), under its own page CSP (inline script
   and style, Google Fonts stylesheet and font, `data:` images; no connect, no frame, no form). The app CSP keeps
   `script-src 'self'` and `frame-src deckpage: http: https: slack:`; the
   `will-frame-navigate` guard of `window.js` cancels every sub-frame navigation the
   Deck's main frame did not start toward `deckpage://` (a link or a script
   `location` leaves the page where it is; a `data:` / `blob:` target ends on a
   blocked page). Permissions (default session, request + check handlers of
   `page-scheme.js`): sub-frame checks and frame-less checks (fileSystem, workers)
   are denied; checks carrying the Deck main frame keep Electron's default; a
   sub-frame request is denied. Selection ask: on a Files or Plans closed frame the relay
   posts `{type:'deck-page-select', text, rect}` to the parent (text capped at 20 KiB of
   UTF-8, empty text = the selection is gone), which accepts it only from that frame's
   `contentWindow` and shows ONE « Demander à Claude » chip (`frame-ask.js`): the ask opens on
   the chip click, never on the selection itself. A press inside the page (a capture-phase
   `pointerdown` of the relay) posts `{type:'deck-page-pointerdown'}`, with no payload, and
   the parent closes the popup that chip opened, since a click in the frame never reaches the
   Deck document. The sandbox stays `allow-scripts`, and the `plugin` slot gets no relay.
   A plugin report (the `plugin` slot, shown by the Plugins panel in its own `<iframe sandbox="allow-scripts">`,
   again EXACTLY that and never `allow-same-origin`) is the third kind and is served more strictly: main
   passes it through `withTheme(neutralizeMeta(html), 'dark')`, so every `<meta` opener becomes the inert
   `<link data-deck-meta` (no refresh or CSP meta survives) and `data-deck-theme="dark"` (a constant: the Deck
   stores no theme and no path serves `light`; reports stored before the dark-only report and plugin copies not
   yet re-imported key their dark palette on it, a current report ignores it) lands on `<html>`, and answers it
   under `PLUGIN_PAGE_CSP`, the page
   CSP with `script-src 'none'`, as a `content-security-policy` RESPONSE HEADER (the report runs no script).
   Links: the `will-frame-navigate` guard still cancels the navigation, and `openPluginLink` of `window.js`
   acts only when `slotOfUrl(e.frame.url)` is `plugin`, on two schemes: an `https:` target goes to
   `shell.openExternal` (every other link stays « Navigateur seulement »), and a `slack:` target only when the
   whole href matches the channel deep link `slack://channel?team=T…&id=C…` (`SLACK_LINK_RE`, upper-case ids,
   a `G` or `D` id also passes), any other `slack:` shape being dropped. A Slack link never falls back to the
   browser. On Linux EVERY click first asks `xdg-mime query default x-scheme-handler/slack` (no cache, bounded by
   `SLACK_HANDLER_WAIT_MS` = 2000): no answer or an error is no handler, and the dialog « Impossible d’ouvrir Slack »
   says so; a handler found → `execFile('xdg-open', [href])` bounded by `SLACK_OPEN_WAIT_MS` = 3000 (still running
   at the deadline counts as opened), a non-zero exit → the dialog « Slack n’a pas pu ouvrir ce lien. » (other
   platforms: `shell.openExternal(href)`, the same dialog on a refusal). At most one opening per second, shared by
   both schemes (`OPEN_MIN_INTERVAL_MS` = 1000, a dropped one leaves one `console.warn`); `setWindowOpenHandler`
   stays `deny`, the sandbox stays `allow-scripts`, and a Files or Plans frame never reaches `openExternal` or the
   Slack route.
   The report frame may fill the Deck window (« Plein écran » of the Plugins panel, `plugin-full.js`), and so may the
   closed frame of an HTML plan of the Plans tab (« Plein écran » of its view, `plans-full.js`), and so may an HTML page
   of the Files tab viewer, script-free or closed (`files-full.js`; the three wire the shared `view-full.js`): only the
   layout of the panel changes, the frame, its sandbox, its CSP, its link route and, for a plan or a file page, its
   selection relay and ask stay as above. A plan's or file page's Escape steps back one level per press: an open popup
   first (its owner closes it), then the full screen, then the maximized side panel, then the panel (the Files viewer
   before the panel). An Escape typed inside a closed frame reaches the Deck through main (`plugin-view-escape`, the
   same push for the three), never through the frame; the script-free Files frame is same-origin and hands its own
   Escape to the document.
   Gates: `html-page-probe`, `html-view-probe`, `plugin-page-serve-probe`,
   `plugin-link-open-probe` (15 gates), `plugin-journal-probe` (the `::deck-step::` lines of a plugin log:
   parser and panel run view), `plugin-view-full-probe` (the full-screen control, its Escape order and the
   Escape typed inside the report frame), `plans-view-full-probe` (the same control on the HTML plan view of the
   Plans tab, 16 gates: the button only over an HTML plan, the fill with no re-mount, the OS window never in full
   screen, every exit resets, the Escape order popup (a dialog of the hidden workspace included), full screen,
   maximized panel, panel, the Escape typed inside the plan frame, the ask chip hidden by a toggle, the ask chip,
   popup and answers dock above the view, and the view above a live session pane), `files-view-full-probe` (the same
   control on the HTML page of the Files viewer, 16 gates, both frame kinds, plus the viewer Escape step and an Escape
   typed in the script-free frame that steps back once, never twice).
   `contextIsolation: true`, `nodeIntegration: false`, preload
   `contextBridge` is the only surface.
3. **Renderer does zero IO at render time.** All fs/parse/child-process work
   lives in the main process (`src/main/`); the renderer renders IPC payloads,
   period.
4. **One transcript parser per ACCESS PATTERN.** Derived AGGREGATES (repos,
   plans, flags) extend the single `sessionActivity()` pass (stamp cache,
   cheap substring pre-filters before `JSON.parse`) — never a second
   aggregate scan, never polling for aggregates. The v42 chat-view feed
   (`src/main/ipc/transcript.js`) is the one sanctioned STREAMING reader:
   per-pane subscription, bounded tail read once, then incremental appends
   only (fs.watch + a stat-only safety poll — it never re-parses old bytes).
   The GLOBAL-usage reader (token usage of every transcript: the gauge estimate
   and the usage page) is `src/main/usage-estimator.js`: pure Node, incremental per
   file (offset + carry, bounded sync budget, chunked queue). The usage page
   extends it (`events()` → `usage-report.js`), never a transcript scan of its own.
   Don't add another reader; extend one of these three.
5. **Never modify the user's global Claude Code config.** Hooks/statusline are
   injected per spawned session via `claude --settings`; check for an existing
   equivalent global hook before injecting (settings hooks run cumulatively —
   a duplicate doubles every write).
6. **Never decode `~/.claude/projects` folder names** (lossy encoding) — read
   the real cwd from inside the session's `.jsonl`.
7. **No false positives in the UI.** Unknown/indeterminate state renders as
   nothing (e.g. icon flags `null` → empty slot), never as a guess.
8. **Layout stability**: reserve fixed space for async-filled UI (icons slot is
   always in the DOM); side panels (`#git-panel`, `#plans-panel`) are mutually
   exclusive, close on Escape (guarded so xterm keeps its keys), and focus with
   `focus({ preventScroll: true })`.

## Module architecture (post-refactor contract)

The historical monoliths (`main.js` 1.8k lines, `renderer.js` 1.8k lines) were
split by domain. Keep it that way:

- **`main.js` stays the entrypoint** — a thin composition root. Every probe
  does `require('../main.js')` after setting env seams; `package.json` `main`
  points at it. NEVER move or rename it; never put logic back into it. New
  module → require it from `main.js` (register* / start* call there).
- **Main-process graph is acyclic**: `config` ← `state` ← `window` ←
  `transcripts` ← `session-*` ← `ipc/*` ← `main.js`. `src/main/state.js` is
  DATA ONLY (Maps, no logic, no requires) — that is the cycle-breaker. Pushes
  to the renderer go through `window.js` `send()`, never a raw `win` ref.
  `page-scheme.js` is a leaf beside `config`: it requires only `electron` +
  `node:crypto` (never `window`), and is required by `window.js` (the
  `PAGE_URL_PREFIX` guard and `slotOfUrl` for plugin links), `ipc/page.js` and `ipc/plugins.js` (the store); `main.js` calls
  `registerPageScheme()` at require time and `startPageProtocol()` in `whenReady`.
- **New IPC handler** → the matching `src/main/ipc/<family>.js` (or a new
  family file), registered inside its `register<Family>Ipc()`; mirror the
  call in `preload.js`. Watchers/intervals expose `start*()` called from
  `main.js` `whenReady`.
- **Renderer is native ES modules** (`renderer/js/`, no bundler; UMD vendors
  stay classic `<script>` tags — module scripts are deferred, so they always
  run after them). Cross-module mutable state lives in `renderer/js/state.js`
  as exported container objects (`modeState.mode`, not a bare `let`).
  `boot.js` is the only entry: it owns the deck channels' `window.api.on*` subscriptions
  (one listener per channel — modules expose `notify*()` hooks instead of
  subscribing) and the init order.
- **PROBE SEAM (`boot.js`, bottom)**: probes reach renderer internals by name
  via `executeJavaScript` — every state object/function they use is assigned
  onto `window` there (`panes`, `gp`, `pp`, `ppMd`, `setMode`, `openPane`,
  `openCtxMenu`…). A probe failing with "Script failed to execute" usually
  means an identifier is missing from the seam: export it and add it to the
  `Object.assign(window, …)` block. Never prune entries casually.
- No import cycle between the side-panel tabs: `git-panel.js` and
  `plans-panel.js` each import `side-panel.js` (which imports `state.js` and the leaf `motion.js`)
  and register themselves with `registerSideTab`, never each other. Showing one
  tab closes the previous through `side-panel.js`; do not add new cycles.

## Definition of done

A feature/fix is DONE only when all of these hold, with the evidence shown verbatim
(the commands and their output lines, never a paraphrase):

1. **Syntax gates** pass: `node --check main.js` and `node --check <file>` on every
   touched file under `src/main/` (plus `preload.js` or `bin/` scripts if touched).
   A renderer ES module does not parse as CommonJS (a bare `.js` is read as CommonJS),
   so check a copy: `cp renderer/js/<file>.js /tmp/c.mjs && node --check /tmp/c.mjs`.
   There is no `tsc`, no `tsconfig.json`, no eslint: `node --check` is the whole static gate.
2. **The feature probe is GREEN**: `bash test/run.sh <feature>-probe` (invisible Xvfb,
   containment env, see below). A feature with no probe gets one in `test/`, next to the
   others; an existing probe that covers the change is extended instead.
3. **No regression**: `npm test` ends with `===== SWEEP: N ok / 0 bad =====`
   (N = the number of probes listed in `test/run.sh`; every one must be ok).

Commits only when explicitly requested. Message style: `fix:|feat:|chore:|docs: <subject>`
— never add `Co-Authored-By`.

## The probe harness (how this project is tested)

Probes are standalone Electron scripts in `test/`, named `<feature>-probe.js`. They
boot the REAL app (`require('../main.js')`) against throwaway fixtures and assert on
real DOM/IPC/fs state. Shared pieces: `test/run.sh` (the runner behind `npm test`),
`test/_fake-glab.js` (a test double for the `glab` CLI), `test/_git-log-fixture.js` and
`test/_wt-fixture.js` (throwaway git repos, built under `mkdtemp`, with no user or
system git config), and `test/fixtures/` (static inputs).

Running them:

- `npm test` (= `bash test/run.sh`) runs every probe listed in the `PROBES` string of
  `test/run.sh`; `bash test/run.sh zoom-probe ...` runs only the named ones. Each probe's
  output lands in `test/<name>.out` (git-ignored). A probe is ok when its exit code is 0
  and it prints no `FAIL ` line; the last line is `===== SWEEP: N ok / M bad =====`, and
  the exit code is 1 when any probe is bad. A name with no file counts as bad.
- **Invisible by default**: the runner re-executes itself under a private `xvfb-run`
  server (3840x2160, so a probe that captures a 1920x1080 window fits) and forces X11
  (`env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11`), because Electron picks
  Wayland from `XDG_SESSION_TYPE` and would open the probe windows on your desktop even
  under Xvfb. No `xvfb-run` installed → a notice and the windows open on your display
  (install `xvfb`); `TEST_VISIBLE=1 bash test/run.sh <name>-probe` chooses the real
  display on purpose. Never run `node_modules/.bin/electron test/<name>.js` bare on a
  desktop session: it skips the containment env below and flashes windows on your screen.
- The `MESA-LOADER` stderr line is noise — ignore it.

Writing a probe (copy a neighbour as a starting point), then add its name to `PROBES`
in `test/run.sh` so `npm test` covers it:

```js
// 1. build fixtures in fs.mkdtempSync(os.tmpdir()/...) BEFORE app boot
// 2. point seams at them via env (set BEFORE require('../main.js')):
//    CLAUDE_DECK_PROJECTS_DIR=<fake projects dir>  CLAUDE_DECK_BIN=/bin/bash
//    CLAUDE_DECK_NO_OPEN=1   + app.setPath('userData', mkdtemp(...))
//    CLAUDE_DECK_ASK_DIR=<mktemp -d>  (EVERY probe that boots main.js: never the running deck's ask channel)
// 3. drive the UI from the main process via win.webContents.executeJavaScript
// 4. results.<gate_name> = <boolean derived from observed state>  — verdicts
//    are DYNAMIC (computed), never hardcoded expected strings
// 5. print PASS/FAIL per gate + final "VERDICT: ALL GREEN (n/n)"
```

Conventions that matter:

- **Attack-class gates are permanent**: when a bug class is found (IPC races,
  XSS via labels, spoofed tool payloads, stale cache served, scroll-jump on
  focus), its gate stays in the probe forever.
- Mock external services inside the probe (e.g. `http.createServer` for a fake
  endpoint) and assert on the REQUEST the app sends, not only the response
  handling. For GitLab, point `CLAUDE_DECK_GLAB_BIN` at the double written by
  `test/_fake-glab.js`: no probe ever runs the real `glab`.
- **Containment of the monthly feeds.** `main.js` starts `price-feed.js` and `commands-feed.js`, which
  fetch GitHub (LiteLLM) and code.claude.com as soon as their stored list is absent or older than 30 days.
  `test/run.sh` exports `CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1 CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1`
  for the whole run; the dead URL is the guaranteed layer. `test/price-feed-probe.js` and
  `test/commands-feed-probe.js` point their seam at their own loopback server instead.
- **Containment of the plugin host.** `main.js` runs `startPlugins()`, which scans `<userData>/plugins` and,
  with at least one enabled plugin, reads the user's shell and may start a run. Three env seams, read by
  `src/main/config.js` and consumed by PROBES ONLY (the app sets none): `CLAUDE_DECK_PLUGINS_DIR` (`PLUGINS_DIR`,
  replaces `<userData>/plugins`; every probe that boots `main.js` points `userData` at a `mkdtemp` with
  `app.setPath('userData', …)`, so `<userData>/plugins` is throwaway; `test/plugin-host-probe.js` and
  `test/plugin-stop-probe.js` also set this seam, and `test/run.sh` exports a `mktemp -d` one for the whole run, so
  no probe ever touches a real plugins folder), `CLAUDE_DECK_PLUGINS_NOW`
  (`PLUGINS_NOW`, freezes the host clock: epoch ms or an ISO date-time, else ignored) and
  `CLAUDE_DECK_PLUGINS_SHELL` (`PLUGINS_SHELL`, replaces `os.userInfo().shell`, so a probe lists and launches
  through a fake shell, never the user's rc files). With an empty plugins folder the host makes no shell call.
- **Zoom**: the app defaults to a 1.2 zoom; `test/run.sh` pins `CLAUDE_DECK_ZOOM=1.0`, the scale pixel and
  layout probes assert at (`test/zoom-probe.js` overrides it in-process).
- Reactivating or adding a probe may require extending the probe seam in `renderer/js/boot.js` first
  ("Script failed to execute" = missing seam identifier).

## Environment pitfalls

- **Shell cwd resets between commands** (Claude Code's Bash tool) — always `cd` explicitly in
  the same command line before `node_modules/.bin/electron`/`npm` (otherwise Electron re-downloads or
  can't find `main.js`).
- If your shell aliases `grep` to a wrapper, use `/usr/bin/grep` in any scripted/piped command.
- `node-pty` must match Electron's ABI: `npm install` runs `electron-rebuild`
  via postinstall; if PTYs fail after an Electron bump, re-run it. A bare
  `npm install -D electron@...` skips the root postinstall: run `npm install` again.
- Electron 42 does not download its binary during `npm install`: run
  `npx install-electron --no`, or let the first `npm start` download it. Redo the
  Ubuntu `chrome-sandbox` fix of the README after every Electron reinstall.
- Electron 42 main process has global `fetch` — no http lib needed for calls.
- Clipboard is DUAL on X11: `writePrimary` (PRIMARY, copy-on-select /
  middle-click) vs `clipboardWrite/Read` (system CLIPBOARD, Ctrl+C/V) — don't
  merge them when touching terminal copy/paste.
- Wayland sessions: probes need the X11 forcing that `test/run.sh` applies (see the probe harness).

## Code map (where to change what)

Probes named here are the ones shipped in `test/`; an area with none has no E2E coverage yet.

| Area | Location |
|---|---|
| Paths, constants, env seams | `src/main/config.js` |
| Shared main-process registries (ptys, pending names…) | `src/main/state.js` (data only) |
| PTY spawn/kill + clipboard bridges | `src/main/ipc/pty.js` |
| PTY spawn ENV (interactive-shell resolution → MCP secrets) | `src/main/shell-env.js` (memoized + TTL + fail-safe; `pty.js` awaits it; drops `BASH_FUNC_*`; logs counts/causes only); probe `test/shell-env-probe.js` |
| `claude --settings` injection (`buildInjectedSettings`: the 8 deck-status events; `crossSessionInbound: "accept"` for `{ask:true}` panes (native cross-session messages)) | `src/main/settings-injection.js`; probe `test/inject-probe.js` (pins the real argv of a spawned pane) |
| Room native mirror (a model SendMessage to a room member, matched by id, label, native_name or uds:<pid>, is appended to main.jsonl as a feed-only {mirror:true} record; loaded with --plugin-dir on ordinary panes only) | `mods/room-mirror/hooks/` + native_name in `src/main/rooms.js` writeRegistry; probes `test/room-mirror-probe.js`, `test/room-mirror-router-probe.js`, `test/room-mirror-flag-probe.js`, `test/room-native-name-probe.js`, `test/room-inbound-settings-probe.js` |
| Rooms (members, feed, `room` CLI, panel; the human label is `CLAUDE_DECK_ROOM_HUMAN`, else the OS username, else `human`; the lead skill ships with the mod; `bin/` is appended to the END of the session PATH (`src/main/rooms.js`), never prepended, so the `room` command never shadows the user's own tools) | `src/main/rooms.js` + `src/main/room-db.js` + `src/main/ipc/room.js` + `bin/room` + `renderer/js/room-panel.js` + `renderer/js/room-control.js` + `mods/room-mirror/skills/room-lead/SKILL.md`; docs `docs/room-feature.md`, `docs/room-lead-playbook.md`, `docs/room-usage.md` |
| Transcript scan, caches, activity/flags | `src/main/session-activity.js` (`sessionActivity()`; a file written in a linked git worktree counts for its MAIN repository — `repoRootOf`: `.git` file → `gitdir` → `commondir` → main working tree, a `.git` file that does not parse to a live one leaves its own folder the root); probes `test/session-activity-probe.js`, `test/plans-panel-probe.js` |
| Agent lifecycle, session liveness | `src/main/agent-lifecycle.js` + `src/main/session-status.js` + `renderer/js/agent-journal.js`; probes `test/agent-lifecycle-seed-probe.js`, `test/agent-lifecycle-core-probe.js`, `test/agent-closed-session-probe.js`, `test/agent-resume-probe.js`, `test/agent-three-consumer-probe.js`, `test/agent-k6-states-probe.js`, `test/agent-memo-session-probe.js`, `test/agent-meta-session-probe.js`, `test/agent-process-boundary-probe.js`, `test/agent-own-evidence-probe.js`, `test/agent-waiting-style-probe.js`, `test/agent-reopen-flash-probe.js`, `test/agent-journal-probe.js`, `test/feed-agent-state-probe.js`, `test/chat-agent-state-probe.js`, `test/feed-liveness-lazy-probe.js`, `test/session-liveness-probe.js` |
| Sidebar scan + rename/delete actions | `src/main/ipc/sessions.js` (+ `src/main/session-meta.js`, `src/main/session-status.js`, `src/main/session-titles.js`); probes `test/deferred-rename-probe.js`, `test/named-session-probe.js` |
| IPC surface | `src/main/ipc/<family>.js` + mirror in `preload.js` |
| Sidebar, cards, badges, icons (no status legend: the row's `.status-emoji` badge IS the « Halo » indicator, drawn by `style.css` from the row's `data-status`) | `renderer/js/sidebar.js` (`renderSessions`, `setSessionIcons`); probes `test/sidebar-style-probe.js`, `test/sidebar-agents-probe.js`, `test/sidebar-epure-probe.js`, `test/card-icons-probe.js`, `test/project-order-probe.js`, `test/auto-refresh-probe.js` |
| Sidebar — session search, status chips, workspace filter (`#session-search`, the `#session-filters` chips `all` / `open` / `busy` / `mine`, the workspace multi-select `#session-ws`) and the right-click menu of a session row (« Copier l'ID de session », « Renommer », « Supprimer »; `openCtxMenu(x, y, row)`) | `renderer/js/sidebar.js` + `renderer/index.html` |
| Model labels (`humanizeModel(id)`: « claude-fable-5-1 » becomes « Fable 5.1 », an id that does not match is shown verbatim — an observed model is a fact, never reshaped into a guess; `agentModelLabel` serves the sidebar sub-agent rows) | `renderer/js/model-label.js` |
| Panes / resize pipeline, single view (`#grid.single` shows exactly one pane; `.pane:not(.selected)` is `display: none` and keeps running hidden — the resync guard of `layout.js` depends on it; `selectPane(paneId)` sets `layoutState.selectedPaneId`) | `renderer/js/panes.js` + `renderer/js/layout.js` + `renderer/js/sidebar.js` (row click, `syncCurrentRow` on `deck:pane-selected`) + the `#grid.single` rules of `renderer/style.css`; probes `test/display-integrity-probe.js`, `test/scroll-heal-probe.js`, `test/reclick-noop-probe.js`, `test/hidden-output-probe.js` |
| Side panel (the docked, resizable right panel; tabs `files` / `git` / `plans` / `terminal` hosted by `#files-panel` / `#git-panel` / `#plans-panel` / `#terminal-panel`; one tab at a time, showing one closes the previous through `closeSidePanel()`) | `renderer/js/side-panel.js` + `#side-panel` / `#sp-tabs` / `#sp-max` in `renderer/index.html` |
| Panel terminal (the `terminal` tab: a real shell per LIVE PANE, keyed by the pane id) | `renderer/js/terminal-panel.js` (imports `side-panel.js` + `state.js` + `theme.js` + `term-keys.js`) + `renderer/js/term-keys.js` + `src/main/ipc/panel-term.js` + mirror in `preload.js` + `#terminal-panel` in `renderer/index.html` |
| Files tab of the side panel (a search field (debounced, `SEARCH_DEBOUNCE_MS` = 150), a lazy tree of the active session's folder (one « Tout déplier » loads at most `EXPAND_LEVEL_MAX` = 40 folders) and a file viewer) | `renderer/js/files-panel.js` (imports `side-panel.js` + `code-ask.js` + `page-frame.js` + `frame-ask.js` + `loading.js`) + `src/main/ipc/files-panel.js` + mirror in `preload.js`; probe `test/html-view-probe.js` |
| Session header (the pane header built in `panes.js`: `.ph-project`, `.ph-branch` + `.ph-branch-name`, the `.ph-model` chip (`humanizeModel`, same text as the chat model badge, hidden while the model is unknown), `.ph-ctx` context meter) | `renderer/js/panes.js` (header markup + the loop wiring the four tab buttons) + `renderer/js/chat-view.js` (`mountCtxMeter`, the model chip refresh) |
| Shared loading indicators (ONE module builds every wait marker; a leaf like `model-label.js`: no import, DOM built with `createElement` + `className`, never `innerHTML`, no text node, every element `aria-hidden="true"`; probes reach it through `window.loading`, the probe seam of `boot.js`) | `renderer/js/loading.js` (imports nothing; imported by the surfaces) |
| Mode switch code↔ai | `renderer/js/mode.js` + `src/main/ipc/ai-view.js`; probe `test/mode-switch-probe.js` |
| Header toolbar (priority+: no control of `#app-header` is ever cut off; `initHeaderTools()` (first init of `boot.js`) folds the bar by STEPS, cumulative `hs-*` classes on the header, until `#header-left` and `#header-right` each fit; the LOWEST `data-prio` first; a new tool = a button with a `data-prio` in `index.html`, no JS; gauges never leave the bar) | `renderer/js/header-tools.js` (imports `motion.js`) + the `#app-header` block and sprite of `renderer/index.html` + the `hs-*` / `#hdr-menu` rules of `renderer/style.css` + `headerTools` in `renderer/js/boot.js`; probes `test/header-toolbar-probe.js`, `test/config-surface-probe.js` |
| Git panel / plans panel (the `git` / `plans` tabs: each REGISTERS itself with `registerSideTab`, and `closeGitPanel` / `closePlansPanel` call `closeSidePanel()`; the git log view is READ-ONLY — no push, pull, fetch; linked worktrees are listed through `git-worktree-view.js`) | `renderer/js/git-panel.js` (imports `code-ask.js` + `diff-select.js` + `loading.js` + `git-graph.js` + `git-refs.js` + `git-commit.js` + `diff-view.js` + `diff-expand.js`) + `renderer/js/git-graph.js` + `renderer/js/git-refs.js` + `renderer/js/git-commit.js` + `renderer/js/plans-panel.js` + `src/main/ipc/git-panel.js` + `src/main/ipc/plans-panel.js` + `src/main/git-worktree-view.js` + `renderer/css/git-log.css`; probes `test/git-panel-probe.js`, `test/git-log-probe.js`, `test/plans-panel-probe.js`, `test/diff-expand-ipc-probe.js` |
| Closed frame for script pages (rule 2 exception (b): an HTML page that holds script runs in `<iframe class="fp-frame" sandbox="allow-scripts">`, never `allow-same-origin`; main side privileges the `deckpage:` scheme) | `src/main/page-scheme.js` + `src/main/ipc/page.js` + mirror in `preload.js` + `renderer/js/page-frame.js` + `renderer/js/frame-ask.js` + `frame-src` in `renderer/index.html` + guard in `src/main/window.js`; probes `test/html-page-probe.js`, `test/html-view-probe.js`, `test/plugin-page-serve-probe.js`, `test/plugin-link-open-probe.js` |
| Page-frame full screen (« Plein écran » / « Réduire » of a view that holds a closed page frame, written ONCE in `wireViewFull({panel, view, btn, park, cls, isOpen, frameSel, watch})` → `{isFull, exit, frameEscape}`; wired for the Plugins report, the HTML plan of `#pp-view` (`plans-full.js`, no button for a markdown plan) and the HTML page of the Files viewer `#fp-vbody` (`files-full.js`, script-free « Format riche » or closed)) | `renderer/js/view-full.js` (imports `motion.js` + `side-panel.js`) + `renderer/js/plugin-full.js` + `renderer/js/plans-full.js` + `renderer/js/files-full.js` + `#pp-full` / `#fp-full` in `renderer/index.html` + the `pp-fullscreen` / `fp-fullscreen` rules of `renderer/style.css` + `plansFull` / `notifyFilesFrameEscape` in `renderer/js/boot.js`; probes `test/plugin-view-full-probe.js`, `test/plans-view-full-probe.js`, `test/files-view-full-probe.js`, `test/plugin-motion-probe.js`, `test/plugin-flash-probe.js` |
| Plugin host (the user imports a plugin folder holding `deck-plugin.json`; the Deck runs it once a day or on demand through the user's own shell and shows its HTML report in the Plugins panel) | `src/main/plugins.js` + `src/main/plugin-manifest.js` + `src/main/plugin-access.js` + `src/main/plugin-runner.js` + `src/main/plugin-reports.js` + `src/main/plugin-install.js` + `src/main/ipc/plugins.js` + `composePlugins()` in `main.js` + seams `PLUGINS_DIR` / `PLUGINS_NOW` / `PLUGINS_SHELL` in `src/main/config.js` + mirror in `preload.js` + `renderer/js/plugin-panel.js` + `renderer/js/plugin-journal.js`; fixtures `test/fixtures/plugins`; probes `test/plugin-host-probe.js`, `test/plugin-manifest-probe.js`, `test/plugin-access-probe.js`, `test/plugin-runner-probe.js`, `test/plugin-reports-probe.js`, `test/plugin-install-probe.js`, `test/plugin-options-manifest-probe.js`, `test/plugin-options-state-probe.js`, `test/plugin-options-run-probe.js`, `test/plugin-options-ipc-probe.js`, `test/plugin-options-ui-probe.js`, `test/plugin-journal-probe.js`, `test/plugin-stop-probe.js`, `test/plugin-nav-probe.js` |
| GitLab MR review — main (repo identity from the git remotes, the one `glab` runner `execGlab(root, args, {stdin, timeoutMs, maxBuffer})`, the `registerGitlabIpc()` handlers called from `main.js`, the review-drafts store `<userData>/gitlab-drafts.json` keyed `host\|project\|iid`, written atomically; seams `CLAUDE_DECK_GLAB_BIN` → `config.GLAB_BIN` (null = `glab` on PATH) and `CLAUDE_DECK_GLAB_TIMEOUT_MS` → `config.GLAB_TIMEOUT_MS`, default 20000) | `src/main/ipc/gitlab-repo.js` + `src/main/ipc/gitlab.js` + `src/main/ipc/gitlab-drafts.js` + `src/main/config.js` + mirror in `preload.js`; test double `test/_fake-glab.js` |
| MR review UI (the git panel's « Merge requests » entry; `initMrReview()` runs from `boot.js` after the git panel; the views hold no IO: each renders what its caller hands in) | `renderer/js/mr-review.js` (the entry) + leaf modules `renderer/js/mr-list.js` (open-MR list), `renderer/js/mr-tree.js` (file tree), `renderer/js/mr-box.js` (ask / comment box), `renderer/js/mr-rail.js` (threads, drafts, submit), `renderer/js/mr-diff.js` (diff column), `renderer/js/mr-load.js` (part loader) + `renderer/css/mr-review.css` |
| Code ask (« Demander à Claude » on a selection in a code view and the answer bubble under the lines: Files source and rich view, the Files and Plans closed frames, git diff, the MR view) and diff selection (the lines a selection covers in a diff2html view, unified or side-by-side) | `renderer/js/code-ask.js` (imports `state.js`, `side-panel.js` + `loading.js`) + `renderer/js/diff-select.js` |
| Diff context expansion (the hidden lines between and after the hunks of ONE file's diff, shown on a click in the git panel and the MR diff column; `diff-expand.js` is the pure text layer, no DOM, no IO) | `renderer/js/diff-expand.js` + `renderer/js/diff-view.js` + `renderer/style.css`; probes `test/diff-expand-probe.js`, `test/diff-expand-ipc-probe.js`, `test/diff-gap-rows-probe.js` |
| Chat view (v42, per-pane transcript→cards; answer fold: the head of a Claude answer is a button whose `aria-expanded` is the one source of the fold state) and chat composer (`.chat-composer` > `.chat-input-wrap` holding the rich contenteditable `.chat-input`; the paperclip and a drop on the composer feed the `.cc-tray` attachment chips) | `renderer/js/chat-view.js` (imports `motion.js` + `loading.js`) + `renderer/js/file-drop.js` + the composer rules of `renderer/style.css`; probes `test/slash-send-probe.js`, `test/send-single-write-probe.js`, `test/send-trace-probe.js`, `test/send-stuck-retry-probe.js`, `test/paste-dedup-probe.js`, `test/compact-slash-probe.js`, `test/goal-button-probe.js`, `test/goal-footer-probe.js` |
| Chat activity strip icons (`.chat-activity`: `refreshActivity(chat)` / `activityLine(chat)` give `{icon, label, detail, dots}`; `.ca-ico` shows the vendored lucide symbol `lc-<icon>` through `lucideIcon`), per-response copy (`.cv-copy`, `copyResponse(btn)` writes the system CLIPBOARD) and chat clocks (a tool card's time is `time.ct-time` inside `.chat-tool-head`; ONE closing time per answer) | `renderer/js/chat-view.js` + `renderer/style.css` + `vendor/lucide` |
| TUI interaction (v46, menu mirror / mode badge / Esc / busy-hint reconcile) | `renderer/js/tui-prompt.js` (pure parsers incl. `detectTuiBusy`) + ask panel & control bar in `renderer/js/chat-view.js` + `status-reconcile-idle` IPC in `src/main/ipc/transcript.js` |
| Ask channel (an `AskUserQuestion` call is handed to the deck's question drawer through files in `ASK_DIR`): the hook drops `<id>.req.json` and polls `<id>.ans.json`; ONLY an explicit `answers` file yields stdout (an `allow` carrying the answers), every other path prints nothing and exits 0 so the CLI shows its native menu; injected as a `PreToolUse` `AskUserQuestion` entry after deck-status, skipped when the user's settings already carry `deck-ask-hook` | hook `bin/deck-ask-hook.js` (Node, builtins only) + injection `buildInjectedSettings({ ask })` in `src/main/settings-injection.js` + main side `src/main/ipc/ask.js` (`createChannel` factory, `registerAskIpc()`, `startAskWatcher()` in `whenReady`, fail-safe: any error is logged once and the deck runs without the channel; `validateRequest` v1, kind `ask`, 1 MB cap, at most 16 questions) + path seam `CLAUDE_DECK_ASK_DIR` → `ASK_DIR` in `src/main/config.js` (default `<STATUS_DIR>/ask`; EVERY probe that boots `main.js` sets it to a fresh `mktemp -d`) + renderer `renderer/js/ask-model.js` (pure state machine; the answer shape is the hook's `updatedInput.answers` keyed by question text, multi-select `"l1, l2"`, « Other » = the user's own text) + `renderer/js/ask-drawer.js` + `renderer/css/ask-drawer.css`; probe `test/inject-probe.js` |
| New-session picker | `renderer/js/new-session.js` + `preload.js` `pickFolder` / `dirExists` / `defaultSessionDir` + `src/main/ipc/dialogs.js`; spawn fixes `--session-id` |
| IPC event wiring + probe seam | `renderer/js/boot.js`; probe `test/boot-clean-probe.js` |
| Status hook / statusline collector (POSIX sh, never block, always exit 0; the collector also writes the statusline's `effort.level` to `<STATUS_DIR>/<session_id>.effort`: tmp + rename, only when the content changes, an absent level empties the file) | `bin/deck-status-hook.sh` + `bin/deck-collector.sh` + `src/main/session-status.js` + `src/main/ipc/transcript.js` |
| Quota estimation | `src/main/usage-estimator.js` (pure Node — probes run it standalone; the global-usage reader of rule 4, also the event store behind the usage page: `events()`, `version`, `SCAN_WINDOW_MS` = 92 d) + `src/main/ipc/usage.js` (hybrid merge); probes `test/estimator-probe.js`, `test/hybrid-merge-probe.js` |
| Usage page — data (the « Coût » / « Tokens » report: an ESTIMATE at API list prices, never a bill) | `src/main/usage-prices.js` (bundled list-price table, USD per 1M tokens, model-id matcher, per-event `costOf`; pure) + `src/main/usage-report.js` (`buildReport(events, period, nowMs, tz)`: pure, no IO) + `src/main/ipc/usage.js` |
| Usage page — renderer (full-window overlay `#usage-page`, built in JS, no markup in `index.html`; tabs « Coût » / « Tokens » read `window.api.getUsageReport`, « Limites » shows the 5 h / 7 d quota windows from `getUsage()` + `notifyUsageUpdate()`; `usageState` on the probe seam) | `renderer/js/usage-page.js` + `renderer/js/usage-chart.js` + `renderer/js/usage.js` + `renderer/css/usage-page.css` |
| Price feed (monthly refresh of the usage page's price table from the LiteLLM price list; main only — the renderer does no IO and its CSP forbids external fetches; `startPriceFeed()` is called from `main.js`; seam `CLAUDE_DECK_PRICES_URL`) | `src/main/price-feed.js`; probe `test/price-feed-probe.js` |
| Commands feed (the official Claude Code command list behind the composer « / » picker, stored in the app and refreshed monthly like the price feed; main only; `commands-bundled.js` is DATA ONLY, a copy of the command page; seam `CLAUDE_DECK_COMMANDS_URL`) | `src/main/commands-feed.js` + `src/main/commands-bundled.js`; probe `test/commands-feed-probe.js` |
| Commands list IPC (`commands-list`, `window.api.commandsList(paneId)` in `preload.js`, registered by `registerCommandsIpc()` from `main.js`) | `src/main/ipc/commands.js` + mirror in `preload.js`; probe `test/commands-list-probe.js` |
| Slash picker (« / » typed as the first character of the chat composer opens `.slash-pop`: role listbox, rows `.sp-item` role option + `aria-selected`, holding `.sp-name`, `.sp-args`, `.sp-desc`, all through `textContent`) | `renderer/js/chat-view.js` (`createPickerShell`, `createSlashPicker`, `slashAtCaret`) + the `.slash-pop` / `.sp-*` rules next to `.cc-mention` in `renderer/style.css`; probe `test/slash-picker-probe.js` |
| Verre tokens, motion, vendored assets (`tokens.css`: custom properties only, one `:root` block, linked BEFORE `style.css`, which aliases its legacy tokens onto them: surfaces, `--r-*` radii, `--glass-blur`, `--ease-out`, `--dur-*`; the `@font-face` of IBM Plex Sans (variable) and IBM Plex Mono (400 / 500), the UI and mono faces `--font-ui` / `--font-mono`) | `renderer/css/tokens.css` + `renderer/js/theme.js` (the xterm palette, kept in sync with `--c-page` / `--c-accent`) + `renderer/js/motion.js` (WAAPI helpers `expand` / `collapse` / `exitThen`, `flipFrom`) + `vendor/ibm-plex`, `vendor/inter`, `vendor/lucide`; probes `test/plugin-motion-probe.js`, `test/refresh-spin-probe.js` |
| UI text | French; code identifiers and comments in English |

## Performance budgets (measured, keep them)

- Real corpus (corpus check, 2026-10-27, read-only over `~/.claude/projects`,
  subagent transcripts included), measured: 10,072 files / 7.30 GiB (457 are
  subagent files). Last 90 days: 363,484 usage lines → 160,210 events after the
  `message.id:requestId` dedupe (203,274 duplicate lines, 55.92 % of raw); 8
  days: 100,687 → 45,696. The census script took 22.5 s and peaked at 290 MiB
  RSS. Design for GiB of transcripts, never for tens of MB.
- Cold scan must stay spread out, never one stall: `UsageEstimator` reads a file
  once, then only its appended bytes (offset + carry, a 4 KB anchor detects an
  in-place rewrite); one sync `scan()` consumes at most `SYNC_BUDGET_BYTES` =
  1 MB of unread bytes, a bigger backlog goes through the chunked queue (1 MB
  slices of about 2-3 ms, one file at a time).
- Duplicate lines (measured, same census): in the 29,164 groups whose output
  differs, the first-seen line held the max output in 0 and the last-seen in
  all 29,164; first-wins undercounts output tokens by 47.49 % and total tokens
  by 0.36 %. Decision: widened fields take the last-seen line per key. Unpriced
  share 0.00 % over 9 model ids; no `speed: fast` event in 90 days; 1 h cache
  writes are 10.41 % of the cache_creation tokens.
- Estimator memory (the usage page widens the event store). The governing
  metric is `heapUsed`, the limit 5× the narrow estimator's. The corpus spans
  about 65 of the 90 days (oldest transcript 2026-08-24, `cleanupPeriodDays`
  365), so every full-window figure is a projection.
  - First cut (measured): heap 4.12× (implementer) / 4.33× (reviewer re-run) of
    the narrow estimator, 83 MB; 1.47× per event; external memory 18.7-34.9 →
    80.7-114.2 MB (a 4 KB anchor buffer per file). Reviewer projection (not
    measured): about 5× within a week, about 6.6-8.2× (130-160 MB heap) once
    the 90-day window is full. Reported: the gauge estimate shows about 7 s
    later at boot, the delay growing with history (two-phase readiness not
    built, the report's default).
  - Step 1 (measured): heap 2.56× (50.0 MB vs 19.5 MB). Projected over the full
    window: 4.06-4.99× on the weeks 0-7 / 0-5 means (no headroom), 5.56× on the
    weeks 0-3 mean, about 8.2× (about 159 MB) at this week's rate alone (40.2k
    events).
  - Step 2 (measured): heapUsed 50.3 → 25.8 MB (1.33×). Projected: current
    week 8.42× → 4.32×, weeks 0-5 2.59×. A file idle for `SETTLE_MS` = 2 d
    releases its merge `keys` Map (a later append rebuilds it through
    `ensureKeys`); the anchor buffer stays.
  - Metric decision: `heapUsed` governs (the plan and the figures the user
    approved are heapUsed). Counting the event-store ArrayBuffers too, heap +
    external fell 108.2 → 102.3 MB (measured), the ratio is 2.29× (measured),
    the weeks 0-5 projection 4.48× and the current-week projection about
    7.46×. Narrower columns would reach an estimated 6.2×, still over 5× (the
    hash strings dominate), so the buffers stay out of the gate.
  - Cost: `events(90 d)` 0.4 → 21.9 ms (reported by the L11n review, main process; the report is
    cached per estimator version, period and local hour).
- Transcript parse ≈ 50 ms / 20 MB with pre-filters — keep the substring
  pre-filter pattern when extending the pass.
- Sidebar render is DOM-pure; metadata-only IO in IPC handlers is acceptable
  (~2-3 ms per `sessions-list` over 47 sessions).
