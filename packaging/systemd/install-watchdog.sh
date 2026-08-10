#!/usr/bin/env bash
# Install the health watchdog as a user timer. No root required.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNITS"

sed "s#^ExecStart=.*#ExecStart=$REPO/tools/watchdog.sh#" \
  "$HERE/grokrc-watchdog.service" > "$UNITS/grokrc-watchdog.service"
cp "$HERE/grokrc-watchdog.timer" "$UNITS/grokrc-watchdog.timer"

systemctl --user daemon-reload
systemctl --user enable --now grokrc-watchdog.timer
echo "  installed. next run:"
systemctl --user list-timers grokrc-watchdog.timer --no-pager | sed -n '2p'
echo "  logs:  journalctl --user -t grokrc-watchdog -f"
