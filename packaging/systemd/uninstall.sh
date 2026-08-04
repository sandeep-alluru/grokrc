#!/usr/bin/env bash
#
# Remove the grokrc user service. Leaves ~/.grokrc (device pairings, VAPID keys)
# alone — uninstalling a service should not silently unpair your phone.
#
#   packaging/systemd/uninstall.sh
#
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/grokrc/grokrc.env"

systemctl --user disable --now grokrc.service 2>/dev/null || true
rm -f "$UNIT_DIR/grokrc.service" "$ENV_FILE"
systemctl --user daemon-reload

echo "grokrc service removed."
echo "  device pairings and push keys kept in ~/.grokrc"
echo "  to drop those too:  rm -rf ~/.grokrc"
echo "  linger left enabled; disable with: loginctl disable-linger $USER"
