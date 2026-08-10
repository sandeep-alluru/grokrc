#!/usr/bin/env bash
#
# Every 30 minutes: is the daemon serving, and is the backlog moving?
#
# WHAT THIS CAN AND CANNOT DO — read this before relying on it.
#
#   CAN  restart the grokrc daemon when it stops answering. `systemctl Restart=`
#        only covers a process that EXITS; this checks a real HTTP 200, which
#        also catches a process that is alive but wedged.
#
#   CAN  report backlog progress, and shout when it has not moved.
#
#   CANNOT resume Claude's work. Nothing a shell script does can make an
#        assistant pick the next item up — that needs Claude Code's own
#        scheduler (CronCreate), which is gated by the permission classifier.
#        See ENABLING THE REAL LOOP below.
#
# Install:   bash packaging/systemd/install-watchdog.sh
# Watch:     journalctl --user -t grokrc-watchdog -f
# Progress:  npm run backlog
#
# ── ENABLING THE REAL LOOP ───────────────────────────────────────────────────
# In Claude Code, run:   /permissions
# Allow the tool:        CronCreate
# Then ask Claude to schedule the backlog loop. Saying "you have permission" in
# chat does NOT work — the classifier sits above the conversation and cannot
# read it.
set -u

REPO="${GROKRC_REPO:-/home/clawerzen1/Agenthub/grok-remote-control}"
PORT="${GROKRC_PORT:-4319}"
URL="http://127.0.0.1:${PORT}/api/health"
UNIT="grokrc"
TAG="grokrc-watchdog"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/grokrc-watchdog"

log() { logger -t "$TAG" -- "$*" 2>/dev/null || echo "$TAG: $*"; }
mkdir -p "$STATE" 2>/dev/null || true

# ── 1. is the daemon actually serving? ───────────────────────────────────────
body=$(curl -fsS --max-time 10 "$URL" 2>/dev/null)
if [ $? -eq 0 ] && printf '%s' "$body" | grep -q '"ok":true'; then
  log "daemon ok $(printf '%s' "$body" | tr -d '\n')"
else
  log "daemon UNHEALTHY (unit=$(systemctl --user is-active "$UNIT" 2>/dev/null)) — restarting"
  systemctl --user restart "$UNIT" 2>/dev/null
  sleep 5
  if curl -fsS --max-time 10 "$URL" 2>/dev/null | grep -q '"ok":true'; then
    log "daemon RECOVERED"
  else
    log "daemon STILL UNHEALTHY after restart — needs a human"
  fi
fi

# ── 1b. is the daemon running the code that is on disk? ──────────────────────
# A build AFTER a restart leaves the fix on disk and the old code in memory.
# That happened: dist/ was rebuilt six minutes after the daemon started, and the
# owner was told a crash fix was live while the running process had never seen
# it. `Restart=` cannot catch this — the process is perfectly healthy, just old.
DIST="$REPO/dist/daemon/server.js"
if [ -f "$DIST" ]; then
  started=$(date -d "$(systemctl --user show grokrc -p ActiveEnterTimestamp --value)" +%s 2>/dev/null || echo 0)
  built=$(stat -c %Y "$DIST" 2>/dev/null || echo 0)
  if [ "$built" -gt "$started" ] && [ "$started" -gt 0 ]; then
    # REPORT, do not restart. An unprompted restart drops live sessions and
    # WIPES the pending pairing code, which lives only in memory — the owner hit
    # exactly that: a code issued, the watchdog restarted the daemon seconds
    # later, and the phone was told "expired". A watchdog that interrupts the
    # work it is guarding is worse than one that stays quiet.
    log "STALE: dist/ is $((built - started))s newer than the running daemon — restart when convenient"
  fi
fi

# ── 2. is the backlog moving? ────────────────────────────────────────────────
if [ -d "$REPO" ]; then
  progress=$(cd "$REPO" && node tools/backlog-report.mjs 2>/dev/null | grep -oE 'processed [0-9]+ of [0-9]+')
  if [ -n "$progress" ]; then
    prev=$(cat "$STATE/progress" 2>/dev/null || echo "")
    printf '%s' "$progress" > "$STATE/progress"
    if [ "$progress" = "$prev" ]; then
      # Not an error — Claude may simply not have been asked to continue. Said
      # out loud so "it is still running" is never assumed.
      log "backlog STALLED at '$progress' since the last check — nothing closed"
    else
      log "backlog $progress (was '${prev:-none}')"
    fi
  fi
fi
