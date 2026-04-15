#!/usr/bin/env bash
# install-user-tor.sh — set up a per-user tor instance managed by systemd --user.
# Zero sudo required. Lives entirely in the user's home directory.
#
# Produces:
#   ~/.config/tor-ext/torrc                         (config)
#   ~/.local/share/tor-ext/                          (DataDirectory)
#   ~/.config/systemd/user/tor-ext.service           (systemd --user unit)
#
# Default ports 9150/9151 (Tor Browser Bundle convention) so it coexists with
# any system tor running on 9050/9051.
set -euo pipefail

CONF_DIR="$HOME/.config/tor-ext"
DATA_DIR="$HOME/.local/share/tor-ext"
SYSTEMD_DIR="$HOME/.config/systemd/user"
TOR_BIN=${TOR_BIN:-$(command -v tor || true)}
SOCKS_PORT=${SOCKS_PORT:-9150}
CONTROL_PORT=${CONTROL_PORT:-9151}

if [[ -z $TOR_BIN ]]; then
    echo "!! tor binary not found in PATH. Install tor first:" >&2
    echo "   Debian/Ubuntu : sudo apt install tor" >&2
    echo "   Fedora/RHEL   : sudo dnf install tor" >&2
    echo "   Arch          : sudo pacman -S tor" >&2
    exit 1
fi

echo ">> tor binary: $TOR_BIN ($($TOR_BIN --version | head -1))"
echo ">> ports: SOCKS=$SOCKS_PORT, Control=$CONTROL_PORT"

mkdir -p "$CONF_DIR" "$DATA_DIR" "$SYSTEMD_DIR"
chmod 700 "$DATA_DIR"

if [[ ! -f $CONF_DIR/torrc ]]; then
    cat > "$CONF_DIR/torrc" <<EOF
# tor-ext per-user torrc. Extension manages ExitNodes, Bridge, UseBridges,
# ClientTransportPlugin at runtime via ControlPort — don't set them here.
DataDirectory $DATA_DIR
SocksPort 127.0.0.1:$SOCKS_PORT
ControlPort 127.0.0.1:$CONTROL_PORT
CookieAuthentication 1
Log notice syslog
EOF
    echo "   wrote $CONF_DIR/torrc"
else
    echo "   = $CONF_DIR/torrc already exists (keeping)"
fi

cat > "$SYSTEMD_DIR/tor-ext.service" <<EOF
[Unit]
Description=Per-user Tor (tor-ext GNOME extension)
After=network.target

[Service]
Type=simple
ExecStart=$TOR_BIN -f %h/.config/tor-ext/torrc
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
echo "   wrote $SYSTEMD_DIR/tor-ext.service"

systemctl --user daemon-reload

echo ">> validating tor config"
VERIFY_LOG=$(mktemp -t tor-ext-verify.XXXXXX.log)
trap 'rm -f "$VERIFY_LOG"' EXIT
if ! "$TOR_BIN" --verify-config -f "$CONF_DIR/torrc" >"$VERIFY_LOG" 2>&1; then
    echo "!! tor --verify-config failed:"; sed -n '1,30p' "$VERIFY_LOG"; exit 1
fi
echo "   ok"

echo ">> done. The extension will start/stop tor-ext.service as you click the tile."
echo "   No sudo, no polkit, no group membership needed."
