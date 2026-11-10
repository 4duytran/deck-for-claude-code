#!/bin/bash
# Fake "user's interactive shell" for plugin-access-probe. FAKE secrets only.
# Exports them, then becomes a real bash with --norc (the real rc files are never read).
# The probe links this file under other basenames; the basename picks a variant.
export DECK_FAKE_API_TOKEN=FAKE-SECRET-DECK_FAKE_API_TOKEN-7q2x91
export SLACK_USER_TOKEN=FAKE-SECRET-SLACK_USER_TOKEN-7q2x91
export SLACK_APP_TOKEN=FAKE-SECRET-SLACK_APP_TOKEN-7q2x91
export CLAUDE_HARNESS_API_KEY=FAKE-SECRET-CLAUDE_HARNESS_API_KEY-7q2x91
export AIKIDO_API_KEY=FAKE-SECRET-AIKIDO_API_KEY-7q2x91
export ANTHROPIC_API_KEY=FAKE-SECRET-ANTHROPIC_API_KEY-7q2x91
export CLAUDE_DECK_BIN=FAKE-SECRET-CLAUDE_DECK_BIN-7q2x91

case "${0##*/}" in
  # an rc that prints a secret on stdout and stderr (gate a2)
  fake-shell-rc.sh)
    echo "rc says $DECK_FAKE_API_TOKEN $SLACK_USER_TOKEN"
    echo "rc says $DECK_FAKE_API_TOKEN $SLACK_USER_TOKEN" >&2 ;;
  # an rc or exec failure: the shell exits before running the command, so no marker reaches fd 3
  fake-shell-nomarker.sh) exit 0 ;;
  # a shell whose `compgen` lists nothing: marker present, zero names
  fake-shell-empty.sh) exec /bin/bash --rcfile <(echo 'compgen() { :; }') "$@" ;;
  # a shell that hangs (unique sleep duration, so the probe can look for survivors)
  fake-shell-hang.sh) sleep 31.7 ;;
  # asserts the spawn stdio shape: fds 0/1/2 on /dev/null, fd 3 a pipe/socket; otherwise it fails
  fake-shell-fds.sh)
    [ "$(readlink /proc/$$/fd/0)" = /dev/null ] && [ "$(readlink /proc/$$/fd/1)" = /dev/null ] \
      && [ "$(readlink /proc/$$/fd/2)" = /dev/null ] || exit 3
    case "$(readlink /proc/$$/fd/3)" in pipe:*|socket:*) ;; *) exit 3 ;; esac ;;
  # requires the login flag form; runs the command as -ic
  fake-shell-flags.sh)
    [ "$1" = -lic ] || exit 4
    shift
    set -- -ic "$@" ;;
esac
exec /bin/bash --norc "$@"
