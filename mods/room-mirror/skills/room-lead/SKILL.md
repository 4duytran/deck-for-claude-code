---
name: room-lead
description: "Orchestrate other claude-deck sessions as the room lead: spawn named workers, assign and track tasks, collect results, resume sessions. Use when the human designates you lead of parallel Claude sessions."
---

# Room Lead — orchestrate worker sessions

The lead is the Claude session the human told to coordinate the other deck sessions over the room (the local inter-session message bus); workers are ordinary deck sessions. This skill is the mechanics (claim, spawn, send, inbox, resume, the one-lead lock); the judgment layer (decompose a goal, score risk, assign by fit, wire dependencies, verify a worker's "done", decide what the lead calls vs what it escalates to the human) is `docs/room-lead-playbook.md`, the full room reference `docs/room-usage.md`, both in the Deck's install folder (the room briefing gives the absolute path of room-usage.md).

## Claim the lead first (one lead at a time)
`room lead` → `you are now the lead` → proceed; `a lead is already active: <name> (<id>)` → STOP, no spawn or resume, tell the human who holds the lead and ask how to proceed (a dead lead's lock is reclaimable once that session closes). `room spawn` / `room resume` auto-claim when the role is free and are refused (exit 3) when a rival lead is live; the deck rejects a rival's spawn/resume even past the CLI. `room lead --status` shows the holder; `room lead --release` steps down (the lock also frees when the session closes). Cooperative enforcement through the app's control path: it prevents an accidental double lead, not a malicious same-uid peer; coordination, not a security boundary (`docs/room-usage.md` § 5).

## The loop
1. Decompose the goal into worker-sized tasks (one repo / one concern each).
2. Spawn a named worker per task: `room spawn --name "<role>" --cwd <abs repo path>`; names by role (`api-fix`, `dep-bump`) show in `room who` and in every tag.
3. Discover ids: `room who` → each worker's full session id. Targets: full id, a unique short-id prefix, the name, or `*` (broadcast).
4. Assign: `room send --to <id> "task… report back here when done"`, one clear directive per message, always with the reply contract below.
5. Collect: worker replies arrive as a typed `[Room - Claude - <name> (<id>)]` line or a native `<cross-session-message from-name=…>` (mirrored to the room); `room inbox` / `room tail` review what arrived; reconcile against the task list.
6. Iterate / resume: `room send --to <id>` for follow-ups; `room resume <full-id>` reopens a closed worker; more spawns as needed.

## The reply contract (in every task message)
- A worker answering "normally" answers into its own pane, invisible to the lead: every task message says **"reply with `room send --to <lead-id>`"** (`room whoami` → the lead's id, given up front). A `[Room - Claude - … (<id>)]` line received → reply with `room send --to <id>`; a native `<cross-session-message from-name=…>` → SendMessage to that from-name.
- Workers never use `AskUserQuestion`: it opens an interactive prompt in the worker's own pane, blocked on a human selection the lead cannot see (not a room event; a native message waits until it is answered, a `room send` lands as raw keystrokes in the widget). Every task message also states: *"do not use AskUserQuestion — `room send --to <lead-id>` any decision you can't make, and wait for my reply; if I go silent, state your question as plain text in your own pane so the human can see it — don't sit frozen."* A question that reaches the lead is decided within its envelope or escalated to the human, then sent back with `room send`. A blocked worker's open question is cleared or handed off before `room lead --release` or close.

## Commands
| Command | Use |
|---|---|
| `room whoami` | the lead's id (handed to workers so they can reply) |
| `room who` | live fleet: name + full id |
| `room lead [--status\|--release]` | claim / show / release the exclusive lead role |
| `room spawn --name <n> [--cwd <d>]` | new named worker (a relative `--cwd` resolves against the lead's cwd) |
| `room resume <session_id>` | reopen an existing session (full id from `room who`) |
| `room send --to <id\|name\|*> "msg"` | assign / follow up / broadcast |
| `room inbox` / `room tail` | gather replies / audit traffic |

## Rules
- The deck must be running for spawn/resume/send to take effect: a control line written while the deck is off is dropped on restart (no replay).
- One pane per session: `room resume` of a live worker focuses it, never forks a second pane.
- Spawn needs a name; resume needs a full canonical session id; an unknown or mistyped id is rejected at the CLI (no silent no-op); an ambiguous prefix bounces rather than hitting the wrong worker.
- Targeted over broadcast: `--to <id>` for a worker, `*` for "everyone, status?" sweeps; `room who` before spawning a role that may already be live.
- The human is not a `--to` target: they watch the deck's room panel; the lead speaks to them in its own session, or broadcasts for visibility.
