#!/bin/sh
# claude-deck status hook — SHIPPED WITH THE DECK and injected per deck-spawned
# session via `claude --settings` (the user's global settings are never
# modified). Maps Claude Code lifecycle events to per-session status files
# consumed by the deck (fs.watch on the dir). Functionally identical to the
# optional global ~/.claude/hooks/deck-status.sh — when that one is already
# wired, the deck skips injecting this copy (hooks from all settings sources
# run CUMULATIVELY; injecting a duplicate would double every write).
# SUBAGENT ACTIVITY IS NOT MAIN STATE: a tool call made inside a subagent
# (background or not) fires PreToolUse/PostToolUse with the PARENT's session_id
# plus a non-empty agent_id. Mapped by session_id alone, it flips a main session
# that already Stopped (idle) back to running/working for as long as the
# subagent lives — the deck then shows « Claude réfléchit » and blocks the
# composer although the main agent is at rest. Those two events are therefore
# skipped when agent_id is set. Every other event keeps its mapping (a
# subagent's permission Notification still means the user must act → waiting).
# The skip is CONTENT-only: the file is still `touch`ed (mtime refresh, existing
# file only, content untouched). While the main agent waits on a FOREGROUND
# Agent call, the subagent's tool events are the only sign of life; the deck's
# 5-minute stale-busy guard reads max(ts, mtime), so without the touch a
# foreground subagent running > 5 min would flip a mid-turn session to idle.
# WAITING OWNER — the one exception to the skip: `waiting` is on file only while
# a menu is pending. When that menu was raised by a SUBAGENT's tool, the answer
# produces no main-agent event (the main agent sits on its Agent call) and the
# subagent's tool events are skipped, so `waiting` would outlive the menu for as
# long as the subagent runs (measured: 14 min 49 s). The hook therefore records
# WHO raised the menu and WHAT the status was before it:
#  • every PreToolUse maintains the side file `.<sid>.pre`, the OWNER NOTE. A
#    permission menu follows the PreToolUse of the tool it gates, so the note names
#    the menu's owner — when that owner is certain. The note is THREE-VALUED:
#      "" (empty)  the main agent's PreToolUse always writes it, whatever was there;
#      <agent_id>  a subagent's PreToolUse writes its own id when the note is empty
#                  (or absent) or already holds that same id — one subagent alone
#                  since the main agent's last PreToolUse, so a certain owner;
#      *           a subagent's PreToolUse finds ANOTHER subagent's id or `*` there:
#                  two subagents are live, the last PreToolUse no longer tells whose
#                  tool a menu gates. `*` is sticky (only a main-agent PreToolUse
#                  resets it) and can never be an agent_id (ids are sanitised to
#                  [0-9A-Za-z_-] or `?`), so it matches no subagent.
#    Builtins only (`read`, `case`, `printf`: no extra process on this hot path).
#    Only SessionEnd removes it: a Stop must keep it, because a background
#    subagent's menu can be raised after the main agent Stopped (idle). A dot-file
#    not ending in .json: the deck's watcher and readers ignore it. A subagent
#    PreToolUse touches it only when the status file exists (a subagent event never
#    creates anything for a session without one).
#  • the last PreToolUse can be a background subagent's that slipped in after the
#    MAIN agent's own gated tool. To tell the two apart, the main agent's own
#    PreToolUse on the Agent/Task tool writes `running` with the literal marker
#    "sub":1 (tool_name is read in the same jq call as agent_id; nothing from the
#    payload is interpolated): the main agent is then parked on a subagent call,
#    so a menu raised meanwhile is the subagent's. Any other main PreToolUse
#    writes a plain `running`: that tool is the main agent's own, and a menu
#    raised while it is on file belongs to the main agent whatever the note says.
#  • a permission Notification writes `waiting` plus fields the deck never reads:
#    "prev" (working|running|idle|active — the status just before, else working),
#    "owner" (the owner note's value: an agent_id, "" = main agent, or `*` =
#    ambiguous; taken from the note ONLY when the status on file is not `running`,
#    or is `running` with the marker — a plain `running` means the main agent's own
#    tool is pending, so owner = "") and the marker again when it was on file. A
#    second Notification while `waiting` keeps the recorded prev/owner/marker,
#    whoever raised it. The owner is sanitised before it is written: `*` alone
#    passes, anything else outside [0-9A-Za-z_-] becomes `?`.
#  • a subagent PostToolUse while the file reads `waiting` AND its "owner" equals
#    that agent_id restores "prev" (normal atomic write, no prev/owner; the marker
#    is kept, so a SECOND menu of the same foreground run restores too). An owner
#    `*` equals no agent_id, so NO subagent event restores such a record. Any other
#    subagent event stays touch-only: a main-agent menu (or another subagent's)
#    must survive a background subagent's tool ending. Main-agent events overwrite
#    the file, so prev/owner/marker disappear with it.
# PARALLEL SUBAGENTS — no subagent may clear a menu it might not own. With one
# subagent alone the owner is certain and its PostToolUse restores "prev". Once a
# second subagent has run since the main agent's last PreToolUse the note is `*`:
# the menu's owner is unknown, so the record's owner is `*` and no subagent's
# PostToolUse touches it (an open menu is never cleared by the wrong agent). Cost:
# such an AMBIGUOUS menu keeps `waiting` after it is answered until the deck clears
# it (the deck sees the menu leave the terminal) or the main agent's next event
# overwrites it — a menu answered outside the deck, with the main agent silent
# (parked on an Agent call), stays `waiting` until then.
# Fail-open: no jq / unreadable file / missing field → same as the hook without
# this rule. Known limits: the banner leaves when the owner's gated tool ENDS
# (Claude Code gives no event at answer time); a Notification racing another
# agent's PreToolUse gets the wrong owner — when that owner is the main agent it
# clears on the main agent's next event, as before; two subagent hooks racing on
# the note (read then write, not atomic) can leave a single id where `*` was due,
# the same window as that race; a denied or failed tool has no PostToolUse (the
# owner's next completed tool clears it); two parallel tools of one subagent clear
# on the first one to end.
# HARD RULES: never block, never write to stdout/stderr, ALWAYS exit 0.
{
  # Honor the deck's env override (CLAUDE_DECK_STATUS_DIR) so an isolated data
  # dir stays consistent between the deck (reader) and this injected writer;
  # default matches config.js.
  dir="${CLAUDE_DECK_STATUS_DIR:-$HOME/.claude/deck-status}"
  mkdir -p "$dir" || exit 0

  payload=$(cat) || exit 0
  sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
  ev=$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)

  [ -n "$sid" ] || exit 0
  case "$sid" in *[!0-9a-fA-F-]*) exit 0 ;; esac  # uuid charset only (path safety)

  # Atomic status write (tmp + rename in the same dir, so the deck's watcher
  # never reads a half-written file). $1 status, $2 event, $3 extra JSON fields
  # (empty, or `,"k":v…` — built by this script from fixed text and sanitised values).
  write_status() {
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    tmp="$dir/.$sid.$$.tmp"
    printf '{"status":"%s","event":"%s","ts":"%s"%s}\n' "$1" "$2" "$ts" "$3" >"$tmp" \
      && mv -f "$tmp" "$dir/$sid.json"
  }

  extra=""  # extra JSON fields: "sub" on a main Agent/Task PreToolUse; "prev"/"owner"(/"sub") on a Notification → waiting
  case "$ev" in
    SessionStart)     st="active" ;;
    UserPromptSubmit) st="working" ;;
    PreToolUse|PostToolUse)
      # One jq call: first char = "S" when the tool is Agent/Task (fixed compare,
      # the payload text is never kept), else "-"; the rest = agent_id.
      line=$(printf '%s' "$payload" | jq -r '(if .tool_name == "Agent" or .tool_name == "Task" then "S" else "-" end) + (.agent_id // "" | tostring)' 2>/dev/null)
      aid=${line#?}
      case "$aid" in *[!0-9A-Za-z_-]*) aid="?" ;; esac  # JSON-safe id (written into the file)
      # Owner note (WAITING OWNER above), three-valued: "" after a main-agent
      # PreToolUse; a subagent's own id while it is alone; `*` once another subagent
      # (or `*`) is on file. Builtins only.
      if [ "$ev" = PreToolUse ]; then
        if [ -z "$aid" ]; then
          printf '' >"$dir/.$sid.pre"
        elif [ -f "$dir/$sid.json" ]; then
          note=""
          [ -f "$dir/.$sid.pre" ] && IFS= read -r note <"$dir/.$sid.pre"
          case "$note" in "" | "$aid") note="$aid" ;; *) note="*" ;; esac
          printf '%s' "$note" >"$dir/.$sid.pre"
        fi
      fi
      # A subagent's PostToolUse ends the menu it raised: restore the status held
      # before the menu. Cheap gate first — only a `waiting` file needs a closer
      # look (the file is one line; `read` is a builtin, no process).
      if [ -n "$aid" ] && [ "$ev" = PostToolUse ]; then
        cur=""
        [ -f "$dir/$sid.json" ] && IFS= read -r cur <"$dir/$sid.json"
        case "$cur" in
          '{"status":"waiting"'*)
            owner=$(printf '%s' "$cur" | jq -r '.owner // empty' 2>/dev/null)
            if [ "$owner" = "$aid" ]; then
              prev=$(printf '%s' "$cur" | jq -r '.prev // empty' 2>/dev/null)
              case "$prev" in working|running|idle|active) ;; *) prev="working" ;; esac
              mark=""
              case "$cur" in *',"sub":1}') mark=',"sub":1' ;; esac  # keep the marker through waiting and back
              write_status "$prev" "$ev" "$mark"
              exit 0
            fi ;;
        esac
      fi
      # Subagent tool call (parent session_id + non-empty agent_id) → not the
      # main agent's state: the content stays as is, only the mtime is refreshed
      # (`touch -c` never creates the file). Fail-open: no jq / no agent_id
      # reads as empty → treated as the main agent, as before.
      if [ -n "$aid" ]; then
        touch -c "$dir/$sid.json"
        exit 0
      fi
      if [ "$ev" = PreToolUse ]; then
        st="running"
        # The main agent is parked on a subagent call (marker, see WAITING OWNER).
        case "$line" in S*) extra=',"sub":1' ;; esac
      else
        st="working"
      fi ;;
    Stop)
      # The owner note stays: a background subagent's menu can follow this Stop.
      st="idle" ;;
    PreCompact)       st="compacting" ;;
    Notification)
      # Claude Code fires Notification for TWO unrelated things: a permission
      # prompt (user action required → waiting) and an idle-60s nudge after a
      # finished turn ("Claude is waiting for your input" → the turn is OVER,
      # that is idle — NOT a permanent "answer me" banner).
      msg=$(printf '%s' "$payload" | jq -r '.message // empty' 2>/dev/null)
      case "$msg" in
        *waiting*input*) st="idle" ;;
        *)
          st="waiting"
          # Who raised this menu, and what was the status before it? (see WAITING
          # OWNER above). Sanitised: both values are written into the JSON.
          cur=""
          [ -f "$dir/$sid.json" ] && IFS= read -r cur <"$dir/$sid.json"
          prev=""
          owner=""
          mark=""
          case "$cur" in
            '{"status":"waiting"'*)
              # Already waiting: keep what the first Notification recorded.
              prev=$(printf '%s' "$cur" | jq -r '.prev // empty' 2>/dev/null)
              owner=$(printf '%s' "$cur" | jq -r '.owner // empty' 2>/dev/null)
              case "$cur" in *',"sub":1}') mark=1 ;; esac ;;
            *)
              case "$cur" in
                '{"status":"running"'*)
                  prev="running"
                  case "$cur" in *',"sub":1}') mark=1 ;; esac ;;
                '{"status":"idle"'*)    prev="idle" ;;
                '{"status":"active"'*)  prev="active" ;;
              esac
              # A plain `running` = the main agent's own tool is pending → owner
              # stays "" (main agent), whichever subagent PreToolUse came after it.
              if [ "$prev" != running ] || [ -n "$mark" ]; then
                [ -f "$dir/.$sid.pre" ] && IFS= read -r owner <"$dir/.$sid.pre"
              fi ;;
          esac
          case "$prev" in working|running|idle|active) ;; *) prev="working" ;; esac
          case "$owner" in '*') ;; *[!0-9A-Za-z_?-]*) owner="?" ;; esac  # `*` = ambiguous, passes alone
          extra=",\"prev\":\"$prev\",\"owner\":\"$owner\""
          if [ -n "$mark" ]; then extra="$extra"',"sub":1'; fi ;;
      esac ;;
    SessionEnd)
      st="closed"
      rm -f "$dir/.$sid.pre" ;;
    *)                exit 0 ;;
  esac

  write_status "$st" "$ev" "$extra"
} >/dev/null 2>&1
exit 0
