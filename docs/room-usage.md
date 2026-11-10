# Room — usage guide (for every Claude session)

You are running inside **claude-deck**. The deck connects all its live Claude
sessions (and the human) on a **local message bus** — the "room". You can see who
is online, receive tasks, and answer another session — by a native cross-session
message or a typed `room send` line. No network; local under `~/.claude/rooms/`.

A compact awareness briefing is injected into your system prompt at spawn; THIS
file is the full reference it points to. Read it when you need the details.

> This applies **only to deck-spawned sessions**. A `claude` you launch yourself
> outside the deck has no room and never sees this.

---

## 1. Provenance — how to read an incoming line

A peer arrives as a native `<cross-session-message from-name=…>` or as a typed
line; every typed line carries a tag telling you **who sent it**:

| Tag you see | Sender | How you reply |
|---|---|---|
| `[Room - <human>]` | the **human** (posted from the deck panel) | answer **normally** in your session (the human is watching it; the human is *not* a `--to` target) |
| `[Room - Claude - <name> (<id>)]` | **another session** (e.g. the lead) | answer via **`room send --to <id>`** — see §2 |
| *(no `[Room - …]` prefix)* | a **direct** message (you, in the terminal/chat) | answer **normally** in your session |

`<id>` in the tag parentheses is the sender's short session id — use it as the
`--to` target. `<human>` is the human's display label: `CLAUDE_DECK_ROOM_HUMAN`
if set, otherwise the OS username, otherwise `human`.

---

## 2. The reply contract (the one rule that matters)

> **A peer CANNOT see your session: a normal answer never reaches it. MUST reply:
> native `<cross-session-message from-name=…>` → `SendMessage` to that from-name
> (mirrored to the room); typed `[Room - Claude - … (<id>)]` → `room send --to <id>`.**

- **From another session** → as above (typed: `room send --to <id> "your answer"`).
- **From the human** (`[Room - <human>]`) → answer normally (the human reads your session).
- **No tag** (direct) → answer normally in your session.

> **If another session is directing your work, don't use `AskUserQuestion` —
> ask *it*.** When a session spawned or tasked you over the room, any decision
> you can't make goes back to that session via `room send --to <id>`, **not** to
> an `AskUserQuestion` prompt. That widget opens in your own pane and blocks it
> on a human selection the directing session cannot see (it is not a room event),
> so your work silently stalls: a native message is held until you answer, a
> `room send` lands as raw keystrokes in the widget. Send the question, await its reply —
> it decides, or escalates for you.
>
> **If it doesn't answer** (a directing session can close — check `room lead
> --status` / `room who`), don't sit frozen: state your question as **plain
> text in your own pane**, where the human (who watches every pane, §1) can see
> it. The ban is on the blocking `AskUserQuestion` *widget*, not on making your
> need visible — plain text is non-blocking and human-readable, so it is your
> fallback when the directing session is unreachable.

The `--to` handle is the short id shown in the tag parentheses `(<id>)`. If you
don't have it, run `room who` for the full ids. (`room inbox` lists sender
**names**, which also work as `--to` targets but can collide — prefer the id.)

---

## 3. Commands

Run these from your session's shell (the deck puts `room` on your `PATH`):

| Command | Does |
|---|---|
| `room who` | list **live** sessions only (name + full id) — for idle ones use `room sessions` |
| `room sessions` | list **ALL** sessions — live **and** idle/closed (name + full id + live\|idle + last-active + cwd). A **visibility aid**: any session may run it (not lead-gated) |
| `room sessions --summary <id>` | summarize one session — its last assistant message. **Read-only**, any session (it just tail-reads that `.jsonl`) |
| `room whoami` | your own session id + label |
| `room send --to <id\|name\|*> "msg"` | send a message (`*` = broadcast to all other sessions) |
| `room inbox` | messages addressed to you |
| `room tail` | recent room traffic (audit) |
| `room lead [--status\|--release]` | **(lead)** claim / show / release the **exclusive** lead role — only one at a time |
| `room spawn --name <name> [--cwd <dir>]` | **(lead-only)** open a new named session |
| `room resume <session_id>` | **(lead-only)** reopen an existing session (full id from `room who`) |

Targeting rules for `--to`:
- a **full UUID** or a **unique short-id prefix** → that exact session;
- a **label/name** → the session with that name;
- `*` → every other live session (broadcast).
- An **ambiguous** prefix or an **unknown** target → the message bounces back to
  you (it is never delivered to the wrong session). The human is **not**
  targetable — they read everything in the deck panel.

---

## 4. Worked example (lead ↔ worker)

```
# lead session
room spawn --name "api-fix" --cwd ~/projects/my-app
room who                                   # -> api-fix  9f3c1a2b-...-...
room send --to 9f3c1a2b "Investigate the failing API test. Report back here."

# worker session "api-fix" receives, typed into its prompt:
#   [Room - Claude - lead (4b8e...)] Investigate the failing API test ...
# it works, then MUST answer via the room (not a normal reply):
room send --to 4b8e "RCA: stale cache read in the config loader; fix = rebuild on change. Patch ready."

# lead sees the reply as [Room - Claude - api-fix (9f3c...)] or a native <cross-session-message>.
```

---

## 5. Lead orchestration

**Seeing idle sessions.** `room who` lists only **live** sessions (those with an
open pane). To see the ones sitting idle/closed in the deck sidebar — the ones
you may want to **resume** or **summarize** — use `room sessions`:

```
room sessions                       # all sessions, each marked live | idle
room sessions --summary 9c0d1e2f    # last assistant message of that session
room resume 9c0d1e2f-...-...         # reopen an idle one (full id)
```

`room sessions` reads the deck's sidebar snapshot, so it shows exactly what the
sidebar shows (it refreshes when the deck refreshes the sidebar). `live` vs
`idle` is whether the session currently has an open pane.

Two limitations worth knowing:
- It mirrors the sidebar's **lineage dedup**: sessions sharing an identical first
  prompt (re-run test harnesses, or the `--resume` forks of one session) collapse
  to a single newest row. So it can show fewer rows than there are `.jsonl` files
  — it is the sidebar's view, not a raw file count.
- `--summary` shows the last **prose** message. If the session's last action was
  a tool call, that prose may predate it — `room resume` to see the live tail.
- An **ambiguous** `--summary <id>` (a prefix/name matching ≥2 sessions) refuses
  and lists the candidates rather than guess — pass a longer prefix or the full id.

### One lead at a time (the lead lock)

Orchestration is **exclusive**: only one session may hold the lead role at once.

```
room lead             # claim the role (you become the lead)
room lead --status    # who is the lead right now (or none)
room lead --release   # step down (also frees automatically when you close)
```

- `room spawn` / `room resume` **auto-claim** the role when it is free, and are
  **refused (exit 3)** when a *different* live session already holds it — so a
  second session simply cannot orchestrate while a lead is active.
- Enforcement is **server-side too**: the deck honours a spawn/resume control
  record only when its `from` is the live lead — **any** other `from` is refused
  (an earlier version carved out a non-UUID `from` to "let the human through";
  that was a hole, since a rival could `env -u ROOM_SESSION_ID room spawn` to make
  its `from` non-UUID and slip past — now closed). The human's `+` button calls
  `openPane` directly (not a control record), so it is unaffected; the human's
  `room` CLI spawn/resume, by contrast, **is** gated like any session (it refuses
  while a lead is live — use the `+` button or `room lead --release` first). A
  blocked attempt gets a `refused: …` router notice.
- The lock is **liveness-aware**: it binds to the lead's session while that
  session is live; once the lead closes, its lock goes **stale** and any session
  may `room lead` to take over. Writes are atomic (`tmp`+`rename`), so a partial
  read never corrupts an honest concurrent claim.
- A same-instant claim race is resolved by the **deck**: the CLI claim is
  read-then-write (best-effort), but the deck honours only the lead it sees as
  live, so even if two CLIs both write the lock, only one session's spawn/resume
  is forwarded; the other gets a `refused` notice.

**Threat model — what this lock is and isn't.** It reliably prevents **accidental**
double-lead (two cooperating sessions both trying to orchestrate) and casual
bypass. It is **not** a security boundary against a *malicious* session: every
deck session runs as the same Unix user with full filesystem access, so a hostile
peer can forge `lead.json` to name itself, spoof `room spawn --from <leadId>`, or
— per the deck's own design — edit the deck's settings/hooks for arbitrary code
execution. Isolating same-user sessions from each other is out of scope for a
file lock; treat the lead role as **cooperative coordination**, not access
control against an adversary. (Likewise, `room sessions`/`--summary` are
ungated visibility — any session can already read every `~/.claude/projects`
transcript directly, so the lock does not try to gate reads.)

If you are the **lead** (the human told you to coordinate the others), use the
**`room-mirror:room-lead` skill** (bundled with the `room-mirror` plugin,
`mods/room-mirror/skills/room-lead/SKILL.md`) for the full orchestration
playbook — spawning a fleet, assigning and tracking tasks, collecting results,
and resuming workers. Invoke it with `/room-mirror:room-lead` (or ask for the
room-lead skill). It claims the lead lock for you at the start.
