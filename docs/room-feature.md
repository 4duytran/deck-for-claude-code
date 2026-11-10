# Inter-session Room

A local-only chat between the live Claude Code sessions running in the deck (and
the human). Sessions can see who is online, ask/delegate precise tasks to each
other, and every recipient knows whether a message came from **you** (the human)
or from a **specific other session**.

> **This file is the developer/architecture doc.** For how a session *uses* the
> room (the reply contract + commands) see [`room-usage.md`](room-usage.md); for
> driving worker sessions as a coordinator see the `room-mirror:room-lead` skill,
> bundled with the `room-mirror` plugin (`mods/room-mirror/skills/room-lead/SKILL.md`).

The deck is the natural router: it already owns every pane's pty master
(`state.ptys`) and fixes each session's id at spawn. A room message reaches a
session by one of two paths:

- **Pane path.** A `fs.watch` on the room file plus `pty.write()` injects the
  message into a precise session, waking even an idle one sitting at its prompt
  (the diagram below). It carries everything the human sends (the panel, the
  `room` CLI run outside a session), every `*` broadcast, `room send` from a
  session, and every session that cannot take native messages (sessions
  without a native inbox).
- **Native path.** Claude sessions in ordinary panes message each other with
  Claude Code's own cross-session `SendMessage` tool; the deck injects
  `crossSessionInbound: "accept"` into ordinary panes only, so the receiver takes
  them. The deck mod `mods/room-mirror/`, loaded with `--plugin-dir` on those
  panes, mirrors each message into `~/.claude/rooms/main.jsonl`, so the panel,
  `room inbox` and `room tail` still show it. The router treats a mirror record
  as feed-only: archived and displayed, never delivered, so nothing is injected
  twice.

```
session A (CC)        ~/.claude/rooms/main.jsonl        deck (router)        session B (CC)
   │ room send --to B "x"        │                          │                      │
   │────────────────────────────► append 1 JSONL line       │                      │
   │                             │ fs.watch ────────────────►│ resolve B → ptyB     │
   │                             │                           │ ptyB.write("[room A] x\r")─►│ (pane path: arrives as input)
```

## Components

| File | Role |
|------|------|
| `src/main/rooms.js` | Router: `fs.watch(main.jsonl)`, cursor at EOF (no backlog replay), resolve `to` → live ptys, render+inject (pane path), echo-guard, bounce. Records with `mirror:true` (written by `mods/room-mirror/` for a native `SendMessage`) are feed-only: archived and shown, never delivered. Builds `registry.json`. Injects room identity into each spawn env. |
| `bin/room` | CLI (`send`/`inbox`/`tail`/`who`/`whoami`), dependency-free. The deck prepends `bin/` to each session's PATH, so `room` just works inside a session's Bash. |
| `src/main/ipc/room.js` | Deck panel surface: `room-recent`, `room-who`, `room-send` (human post), live `room-append` push. |
| `renderer/js/room-panel.js` | The chat panel UI (self-initializing — not wired through `boot.js`). |
| `src/main/ipc/pty.js` | At spawn: clones the env and adds `ROOM_SESSION_ID` / `ROOM_LABEL` + PATH; (de)registers the session in the registry. |

All state lives under `~/.claude/rooms/` (`main.jsonl` + `registry.json`). No
network.

## Message shape (one JSON line per message)

```json
{"id":"<uuid>","ts":"<ISO8601>","from":"<session_id|user|router>","from_label":"backend","to":"tnr","text":"build cassé sur develop"}
```

`to` accepts a **session_id**, a **label**, or **`*`** (broadcast).

## Usage — CLI (inside any deck session)

```sh
room whoami                      # my session id + label
room who                         # live sessions (from the registry)
room send --to tnr "build cassé" # message the session labelled "tnr"
room send --to '*' "heads up"    # broadcast (never echoes back to you)
room inbox                       # messages addressed to me
room tail -n 20                  # recent room activity
```

Identity is taken from `ROOM_SESSION_ID` / `ROOM_LABEL` (exported by the deck at
spawn). Run outside a deck session, the CLI self-identifies as the human
(`from=user`, label `you`); override with `--from` / `--label`.

A session's **label** is its creation name (the name you give a new session), or
a `<cwd-basename>-<shortid>` fallback. Name your sessions meaningfully
(`backend`, `tnr`, `orchestrator`) to address them easily.

## Usage — deck panel

Click **💬 Room** in the header. The panel shows the live feed, a "who is
online" count, and a composer: pick a target (or `★ broadcast`) and type. Your
messages go out as **you**. A badge on the toggle shows unread messages while
the panel is closed.

## Behaviour rules (v1)

- **Idle vs busy, pane path**: injecting into an idle session wakes it immediately. If the
  target is mid-turn, Claude Code queues the input and processes it next turn.
- **Idle vs busy, native path** (measured on Claude Code 2.1.319): a native message to a
  busy session is queued and read between its tool calls; it is never typed into an
  open `AskUserQuestion` prompt; an idle session starts a new turn.
- **No delivery ack on the native path**: Claude Code returns no per-message
  acknowledgement (none exists), so neither the sender nor the deck learns whether
  or when the receiver read a message. Its mirror record in the feed means
  "sent", not "read". The deck neither retries nor re-injects a native message
  into the pane: the path follows the recipient (native inbox or not), never a
  delivery outcome.
- **Order**: the two paths are independent, so a pane-path message and a native one
  to the same target carry no ordering guarantee between them; a mirror record sits
  in the feed where the mod appended it.
- **Mirror records**: written with `mirror:true` and the usual
  `{id, ts, from, from_label, to, text}` fields, and only when the target is in the
  room registry (matched first by the registry `native_name` -- the
  `name` Claude Code gives the session in `~/.claude/sessions/<pid>.json`, the only
  name a native `SendMessage` is delivered to -- or the `uds:` address of its pid,
  then by session id or label, so a label never takes a message from the session
  that owns that native name; the text is capped at 4000 characters, as on the pane path);
  a native message to a name outside it is not mirrored and never reaches the feed.
- **Echo-guard**: a `*` broadcast is never delivered back to its sender.
- **Bounce, recorded** (pane path): a directed message to an unknown/dead target produces a
  `router` reply addressed back to the sender. That reply is ALWAYS written to
  `main.jsonl` (the audit trail — visible via `room tail` and the deck panel);
  it is *injected into the sender's pty* only if the sender is still live. There
  is no durable inbox / redelivery in v1 — if the sender has already exited, its
  bounce stays in the file but is never re-injected. Likewise a directed message
  whose TARGET is offline is not queued for a not-yet-spawned target — the router
  only routes to currently-live ptys; the file keeps the record either way.
- **Single submit**: a delivered message validates the target's input box
  exactly once; embedded newlines are flattened to a `⏎` glyph (a stray CR would
  submit early).
- **No backlog replay**: the router starts at the file's current EOF, so a deck
  restart never re-injects old messages.

## Discoverability (how sessions learn the room exists)

Without being told, a session sees `[Room - …]` input as a plain user message
and never uses `room send`. So the deck appends a compact room briefing to every
spawned session's **system prompt** via `claude --append-system-prompt`
(`ROOM_BRIEFING` in `config.js`, pushed in `ipc/pty.js`). This touches **no
hooks**, so it can NEVER disturb the user's global hook set (an earlier
SessionStart-hook approach was dropped precisely because `--settings` hook
merge-vs-override semantics were unverified). The briefing covers: list/send/
inbox, the provenance tags, and the reply-in-room convention. Takes effect for
sessions spawned AFTER a deck restart.

### Provenance tags

A delivered message is prefixed so the receiver knows the origin AND that it
came via the room (→ must reply with `room send`, not a normal answer):
- `[Room - <human>]` — the human (label = `CLAUDE_DECK_ROOM_HUMAN`, else the OS
  username, else `human`).
- `[Room - Claude - <name>]` — another session (name = its deck sidebar name).
- `[Room - router]` — a delivery bounce.

No `[Room - …]` prefix = a direct chat/terminal message → answer normally. The
registry / `room who` / the panel selector all show the deck session **name**,
but routing always uses the precise **session id** (no wrong-target mistakes).

## Trust model & security (READ THIS)

The room is a **local, single-user, trusted** channel. A delivered message is
either handed over by Claude Code's own cross-session messaging (native path) or,
on the pane path, written into the target session's pty input **and auto-submitted** (a trailing
CR) so an idle peer wakes and answers — that is the whole point. Consequences to
be aware of:

- **Cross-session prompt-injection is by design.** Any process running inside any
  deck session (the agent, a hook, a sub-shell) can `room send --to <peer> "..."`
  and have that text submitted as a prompt to another live session, with no
  human in the loop; a Claude session can equally `SendMessage` a peer natively and
  have it read between that peer's tool calls. Treat every session in the deck as mutually trusted — this
  is NOT a sandbox boundary. Do not expose the room to untrusted input.
- The native path needs the peer to accept cross-session messages: the deck injects
  `crossSessionInbound: "accept"` into ordinary panes only, through its per-session
  injected settings (never the user's global Claude Code config), and loads
  `mods/room-mirror/` there with `--plugin-dir`. A pane spawned another way
  has neither and stays on the pane path.
- Provenance is always visible: a pane-delivered line is prefixed `[room <from>]` and a
  native message arrives wrapped in Claude Code's `<cross-session-message from=… from-name=…>` tag, so
  the receiving model/human can see it came from a peer (or `you`).
- `bin/` is **appended** to each session's PATH (not prepended), so the shipped
  CLI never shadows the user's real `git`/`node`/`claude` binaries.
- Everything is local (`~/.claude/rooms/`), no network egress.

If you want a stricter posture later (out of v1): drop the auto-submit CR
(require a human keypress to send the injected text), or gate delivery behind a
per-target allowlist/confirmation.

## Resumed sessions (identity note)

`claude --resume <id>` forks a NEW transcript id, but the room identifies a pane
by its **stable** id (the one the deck fixed / the sidebar row uses), and routes
by label or that stable id — so delivery to/from a resumed pane works. The
consequence is that a resumed session's `ROOM_SESSION_ID` (stable id) differs
from its forked transcript id; address resumed peers by **label** or by the id
`room who` shows. The resume path is not covered by the headless probes.

## Acceptance criteria (all validated headless — `.scratch/room-*-probe.js`)

1. `room send --to B "ping"` from the human, the panel or a pane-delivered session → B receives `[room A] ping` and the model answers. A native `SendMessage` A→B reaches B through Claude Code and appears once in the feed (`room tail`, `room inbox`, the panel) as a mirror record, never injected into B's pty (Claude Code's own delivery is measured live on 2.1.319, not by a headless probe).
2. `room send --to '*'` (pane path) reaches every session except the sender.
3. `room who` lists the live sessions with their labels.
4. Deck restart → no old message re-injected, mirror records included.
5. Dead/unknown target → visible bounce, never a silent drop.
6. Multi-line message delivered intact, validated once.

## Out of scope (v1) — easy to add later

Slash-command `/room-send`, an MCP tool, multi-machine, history/replay, auth.

## Removing the feature (rollback)

Phase 1 (backend) and Phase 2 (UI) are separate commits — `git revert` either.
The UI is fully isolated (a self-initializing module + an EOF CSS block + new IPC
files); it never touches `boot.js` or `chat-view.js`. Tag `pre-room-feature`
marks the pre-feature tree.

## Probe seam

Set `CLAUDE_DECK_ROOMS_DIR` to isolate the room from the real `~/.claude/rooms`
(used by the headless probes; production sets neither).
