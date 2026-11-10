#!/bin/sh
# claude-deck statusline collector — SHIPPED WITH THE DECK and injected per
# deck-spawned session via `claude --settings` (the user's global settings
# are NEVER modified). The statusline stdin JSON is the ONLY place Claude
# Code exposes rate_limits, so this proxy does two jobs:
#   1. export rate_limits -> ~/.claude/deck-usage.json (atomic tmp+mv)
#   2. delegate the DISPLAY to the user's own statusLine command (read from
#      their settings.json at runtime) so nothing changes visually — or
#      print a minimal default line when none is configured.
# HARD RULES: the display must never break — every failure falls back
# silently to the next option; this script never writes to stderr.

input=$(cat)

# --- 1. quota export (fail-silent, never blocks the display) ----------------
{
  if command -v jq >/dev/null 2>&1; then
    RL=$(printf '%s' "$input" | jq -c \
      'select(.rate_limits != null) |
       {five_hour: (.rate_limits.five_hour // null),
        seven_day: (.rate_limits.seven_day // null),
        updated_at: (now|floor)}' 2>/dev/null)
    if [ -n "$RL" ]; then
      # Honor the deck's env override (CLAUDE_DECK_USAGE_FILE) so an isolated
      # data dir stays consistent between the deck (reader) and this injected
      # writer; default matches config.js. The tmp file must sit in the SAME
      # dir as the target for the mv to be an atomic rename.
      usage_file="${CLAUDE_DECK_USAGE_FILE:-$HOME/.claude/deck-usage.json}"
      usage_dir=$(dirname "$usage_file")
      mkdir -p "$usage_dir" \
        && tmp=$(mktemp "$usage_dir/.deck-usage.XXXXXX") \
        && printf '%s\n' "$RL" >"$tmp" \
        && mv -f "$tmp" "$usage_file" \
        || { [ -n "${tmp:-}" ] && rm -f "$tmp"; }
    fi
  fi
} >/dev/null 2>&1

# --- 1b. effort level export (fail-silent, never blocks the display) --------
# effort.level lasts in the statusline stdin (the TUI footer row lives 10 s).
# One file per session, tmp + rename in the same dir, written only when the
# content changes; an absent level empties it. Needs jq and a UUID session id.
{
  if command -v jq >/dev/null 2>&1; then
    eline=$(printf '%s' "$input" | jq -r '
      select(((.session_id // "") | type) == "string"
             and (.session_id | length) == 36
             and (.session_id | test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")))
      | .session_id + " "
        + ((.effort.level // "") | if type == "string" then .[0:32] | gsub("[^ -~]"; "") else "" end)' 2>/dev/null)
    if [ -n "$eline" ]; then
      esid=${eline%% *}
      elvl=${eline#* }
      edir="${CLAUDE_DECK_STATUS_DIR:-$HOME/.claude/deck-status}"
      efile="$edir/$esid.effort"
      ecur=$(cat "$efile" 2>/dev/null)
      if [ "$ecur" != "$elvl" ]; then
        mkdir -p "$edir" \
          && etmp=$(mktemp "$edir/.deck-effort.XXXXXX") \
          && printf '%s' "$elvl" >"$etmp" \
          && mv -f "$etmp" "$efile" \
          || { [ -n "${etmp:-}" ] && rm -f "$etmp"; }
      fi
    fi
  fi
} >/dev/null 2>&1

# --- 2. display: transparent delegation to the user's own statusline --------
USER_CMD=""
if command -v jq >/dev/null 2>&1; then
  USER_CMD=$(jq -r '.statusLine.command // empty' \
    "$HOME/.claude/settings.json" 2>/dev/null)
fi
case "$USER_CMD" in
  *deck-collector*) USER_CMD="" ;;  # recursion guard (collector set globally)
esac
# depth guard: kills INDIRECT recursion too — a user wrapper that re-invokes
# this collector inherits the env mark and gets the default line instead of
# an unbounded fork loop. Plain env inheritance, no state on disk.
if [ "${DECK_COLLECTOR_ACTIVE:-}" = "1" ]; then USER_CMD=""; fi
export DECK_COLLECTOR_ACTIVE=1
if [ -n "$USER_CMD" ]; then
  out=$(printf '%s' "$input" | sh -c "$USER_CMD" 2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 0
  fi
fi

# --- 3. default line (no user statusline, it failed, or no jq) --------------
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$input" | jq -r '
    [(.model.display_name // "Claude"),
     ((.workspace.current_dir // .cwd // "") | split("/") | last // empty),
     ("ctx " + ((.context_window.used_percentage // 0) | floor | tostring) + "%")]
    | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null \
    && exit 0
fi
printf 'Claude\n'
exit 0
