#!/bin/bash
# Probe runner behind `npm test`.
#   bash test/run.sh                  run every probe listed in PROBES
#   bash test/run.sh zoom-probe ...   run only the named probes
#   TEST_VISIBLE=1 bash test/run.sh   run on the real display instead of a private Xvfb
# Each probe writes its output to test/<name>.out (git-ignored). The last line is
# "===== SWEEP: N ok / M bad =====" and the exit code is 1 when any probe is bad. A
# "SKIPPED: <probe>:<gate-id> ..." line before it lists the gates skipped on this machine.

# Resolve the repository root from this script, so the run never depends on the caller's cwd.
# A POSIX symlink loop replaces the GNU-only canonicalizing readlink (absent on macOS); SELF stays absolute for the re-exec.
p=$0
while [ -L "$p" ]; do
  t=$(readlink "$p")
  case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
done
SELF_DIR=$(cd -P "$(dirname "$p")" && pwd -P) || { echo "FATAL: cannot resolve the repository root from $0" >&2; exit 1; }
SELF=$SELF_DIR/$(basename "$p")
cd -P "$SELF_DIR/.." || { echo "FATAL: cannot resolve the repository root from $0" >&2; exit 1; }

# Invisible by default: the script re-executes itself on a private virtual X server, 3840x2160 so a
# probe that captures a 1920x1080 window fits. The X11-forcing env is needed because Electron picks
# Wayland from XDG_SESSION_TYPE, which would open the probe windows on the desktop despite xvfb-run.
if [ -z "$TEST_VISIBLE" ] && [ -z "$TEST_IN_XVFB" ]; then
  if command -v xvfb-run >/dev/null; then
    export TEST_IN_XVFB=1
    exec env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 xvfb-run -a -s "-screen 0 3840x2160x24 -nolisten tcp" bash "$SELF" "$@"
  fi
  echo "test: xvfb-run not found, the probe windows will open on your display (install xvfb, or set TEST_VISIBLE=1 to silence this notice)" >&2
fi
[ -n "$TEST_IN_XVFB" ] && echo "test: private Xvfb server, DISPLAY=$DISPLAY (TEST_VISIBLE=1 for the real display)"

[ -x node_modules/.bin/electron ] || { echo "FATAL: node_modules/.bin/electron is missing, run npm install first" >&2; exit 1; }

# Containment: no probe may reach the network or a real plugins folder.
# Pin the historical 1.0 scale (the app defaults to 1.2); pixel and layout probes assert at 1.0.
# zoom-probe overrides it in-process.
export CLAUDE_DECK_ZOOM=1.0
# Closed loopback port: price-feed.js and commands-feed.js fetch at start when no fresh stored list
# exists, so a dead URL keeps every probe off the live LiteLLM price list and the Claude Code command page.
# price-feed-probe and commands-feed-probe point these at their own loopback server in-process.
export CLAUDE_DECK_PRICES_URL=http://127.0.0.1:1
export CLAUDE_DECK_COMMANDS_URL=http://127.0.0.1:1
# Every probe that boots main.js runs startPlugins(), which reads <userData>/plugins by default.
# Point the seam at a throwaway folder, removed on exit; plugin probes override it in-process.
export CLAUDE_DECK_PLUGINS_DIR=$(mktemp -d)
trap 'rm -rf "$CLAUDE_DECK_PLUGINS_DIR"' EXIT

PROBES="auto-refresh-probe card-icons-probe sidebar-style-probe goal-button-probe goal-footer-probe compact-slash-probe deferred-rename-probe display-integrity-probe estimator-probe git-panel-probe hidden-output-probe hybrid-merge-probe inject-probe mode-switch-probe named-session-probe plans-panel-probe reclick-noop-probe scroll-heal-probe shell-env-probe zoom-probe sidebar-agents-probe agent-journal-probe project-order-probe session-activity-probe paste-dedup-probe send-single-write-probe send-trace-probe send-stuck-retry-probe price-feed-probe commands-feed-probe slash-picker-probe commands-list-probe slash-send-probe html-page-probe html-view-probe git-log-probe plugin-host-probe plugin-manifest-probe plugin-access-probe plugin-runner-probe plugin-reports-probe plugin-install-probe plugin-page-serve-probe plugin-link-open-probe plugin-options-manifest-probe plugin-options-state-probe plugin-options-run-probe plugin-options-ipc-probe plugin-options-ui-probe plugin-journal-probe plugin-view-full-probe plugin-stop-probe plugin-nav-probe plugin-motion-probe plugin-flash-probe diff-expand-probe diff-expand-ipc-probe diff-gap-rows-probe plans-view-full-probe sidebar-epure-probe header-toolbar-probe files-view-full-probe refresh-spin-probe config-surface-probe boot-clean-probe room-mirror-probe room-mirror-router-probe room-inbound-settings-probe room-mirror-flag-probe room-native-name-probe agent-lifecycle-seed-probe agent-closed-session-probe agent-resume-probe feed-agent-state-probe chat-agent-state-probe agent-waiting-style-probe agent-three-consumer-probe agent-k6-states-probe agent-memo-session-probe agent-meta-session-probe agent-process-boundary-probe session-liveness-probe agent-lifecycle-core-probe agent-own-evidence-probe feed-liveness-lazy-probe agent-reopen-flash-probe"
[ $# -gt 0 ] && PROBES="$*"

# A probe that never answers SIGTERM must not hang the sweep (on macOS an app-modal alert blocks the
# main process, so the signal is never served): TERM at PROBE_LIMIT seconds, KILL KILL_GRACE seconds later.
PROBE_LIMIT=180
KILL_GRACE=10

# pt_tree <pid>: the pid and all its descendants (pgrep -P exists on Linux and macOS).
pt_tree() {
  local c
  echo "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do pt_tree "$c"; done
}

# GNU `timeout` is absent on macOS: coreutils' gtimeout when installed, else a bash 3.2 watchdog.
# run_limited <seconds> <command...>; exit status 124 on expiry, like GNU timeout. On expiry the command
# gets TERM, then KILL after KILL_GRACE seconds, and the whole process tree dies: the electron CLI is a node
# parent of the Electron main, and `timeout -k` kills only its direct child (measured: a grandchild survives).
run_limited() {
  local secs=$1 pid wd rc t0 tool=
  shift
  if command -v timeout >/dev/null; then tool=timeout
  elif command -v gtimeout >/dev/null; then tool=gtimeout
  fi
  if [ -n "$tool" ]; then
    t0=$SECONDS
    "$tool" -k "$KILL_GRACE" "$secs" "$@" &
    pid=$!
    wait "$pid"; rc=$?
    # timeout answers 137 instead of 124 once its KILL was needed.
    [ "$rc" = 137 ] && [ $((SECONDS - t0)) -ge "$secs" ] && rc=124
    # timeout leads its own process group (pgid = its pid): KILL what its command left in it.
    [ "$rc" = 124 ] && kill -s KILL -- "-$pid" 2>/dev/null
    return $rc
  fi
  "$@" &
  pid=$!
  (
    fired=0
    sleep "$secs" >/dev/null 2>&1 &
    sp=$!
    # After expiry the watchdog finishes its kill sequence: a TERM from the main flow must not stop it.
    trap '[ "$fired" = 1 ] || { kill "$sp" 2>/dev/null; exit 0; }' TERM
    if wait "$sp"; then
      fired=1
      tree=$(pt_tree "$pid")
      kill -TERM "$pid" 2>/dev/null
      n=0
      while [ "$n" -lt "$KILL_GRACE" ] && kill -0 "$pid" 2>/dev/null; do sleep 1; n=$((n+1)); done
      for p in $tree $(pt_tree "$pid"); do kill -KILL "$p" 2>/dev/null; done
      exit 124
    fi
  ) &
  wd=$!
  wait "$pid"; rc=$?
  kill -TERM "$wd" 2>/dev/null
  wait "$wd"
  [ $? = 124 ] && rc=124
  return $rc
}

PASS=0; FAIL=0; FAILED=""; SKIPPED=""
for pr in $PROBES; do
  # A name with no file is a failure, never a silent skip (a typo must not turn `npm test` green).
  if [ ! -f "test/$pr.js" ]; then
    FAIL=$((FAIL+1)); FAILED="$FAILED $pr(missing)"; echo "BAD  $pr | no such probe: test/$pr.js"
    continue
  fi
  run_limited "$PROBE_LIMIT" node_modules/.bin/electron "test/$pr.js" > "test/$pr.out" 2>&1
  rc=$?
  if [ "$rc" = 124 ]; then
    # Also reap an Electron process that left the killed tree, then say why the probe ended.
    pkill -KILL -f "test/$pr\\.js" 2>/dev/null
    echo "TIMEOUT $pr after ${PROBE_LIMIT}s (killed)" >> "test/$pr.out"
  fi
  # Gates a probe skipped on this machine (`SKIP <gate-id> ...` lines of THIS run's output).
  for g in $(grep -E "^SKIP " "test/$pr.out" | cut -d' ' -f2); do SKIPPED="$SKIPPED $pr:$g"; done
  v=$(grep -cE "^FAIL " "test/$pr.out")
  verdict=$(grep -E "VERDICT|/[0-9]+ PASS" "test/$pr.out" | tail -1)
  if [ "$rc" = "0" ] && [ "$v" = "0" ]; then
    PASS=$((PASS+1)); echo "OK   $pr | $verdict"
  else
    FAIL=$((FAIL+1)); FAILED="$FAILED $pr(rc=$rc,fails=$v)"; echo "BAD  $pr | rc=$rc fails=$v | $verdict"
  fi
done
[ -n "$FAILED" ] && echo "FAILED:$FAILED"
[ -n "$SKIPPED" ] && echo "SKIPPED:$SKIPPED"
echo "===== SWEEP: $PASS ok / $FAIL bad ====="
exit $((FAIL>0))
