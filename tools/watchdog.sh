#!/usr/bin/env bash
#
# Is the daemon actually serving? If not, restart it.
#
# `systemctl Restart=` covers a process that EXITS. It does nothing for a
# process that is alive but wedged — the socket open, the port bound, and
# nothing answering. That failure mode has already happened here: the daemon
# died on an unhandled spawn error twice in 45 seconds, and separately kept
# running while serving a stale bundle.
#
# So this checks the thing that matters — a real HTTP response — rather than
# the thing that is easy to check.
#
# Installed by packaging/systemd/install-watchdog.sh as a user timer.
set -u

PORT="${GROKRC_PORT:-4319}"
URL="http://127.0.0.1:${PORT}/api/health"
UNIT="grokrc"
LOG_TAG="grokrc-watchdog"

log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null || echo "$LOG_TAG: $*"; }

body=$(curl -fsS --max-time 10 "$URL" 2>/dev/null)
rc=$?

if [ $rc -eq 0 ] && printf '%s' "$body" | grep -q '"ok":true'; then
  # Healthy. Say so at low volume so the timer leaves a trail worth reading.
  log "ok $(printf '%s' "$body" | tr -d '\n')"
  exit 0
fi

active=$(systemctl --user is-active "$UNIT" 2>/dev/null || echo unknown)
log "UNHEALTHY: curl rc=$rc unit=$active body=$(printf '%s' "$body" | head -c 120)"

# A wedged process reports active but answers nothing, so restart rather than
# start — restart is correct in both cases and start is correct in only one.
if systemctl --user restart "$UNIT" 2>/dev/null; then
  sleep 5
  if curl -fsS --max-time 10 "$URL" 2>/dev/null | grep -q '"ok":true'; then
    log "RECOVERED after restart"
    exit 0
  fi
  log "STILL UNHEALTHY after restart — needs a human"
  exit 1
fi

log "restart command failed — unit=$active"
exit 1
