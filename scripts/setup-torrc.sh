#!/usr/bin/env bash
# setup-torrc.sh — idempotent tor control-port enabler for tor-ext extension.
# Requires root (re-execs via sudo/pkexec if not root).
# Safe to re-run; only appends lines that are missing.
set -euo pipefail

TORRC=/etc/tor/torrc
CONTROL_PORT=${CONTROL_PORT:-9051}
TARGET_USER=${SUDO_USER:-${PKEXEC_UID:+$(getent passwd "$PKEXEC_UID" | cut -d: -f1)}}
TARGET_USER=${TARGET_USER:-$USER}

if [[ $EUID -ne 0 ]]; then
    echo ">> need root, re-executing under sudo ..." >&2
    exec sudo --preserve-env=CONTROL_PORT "$0" "$@"
fi

if [[ ! -f $TORRC ]]; then
    echo "!! $TORRC not found. Is tor installed?" >&2
    exit 1
fi

# Detect tor group (debian-tor on Debian/Ubuntu, tor on Arch/Fedora)
TOR_GROUP=
for g in debian-tor tor _tor; do
    if getent group "$g" >/dev/null 2>&1; then TOR_GROUP=$g; break; fi
done
if [[ -z $TOR_GROUP ]]; then
    echo "!! Could not find tor system group (tried debian-tor, tor, _tor)." >&2
    exit 1
fi

backup=${TORRC}.tor-ext.bak
if [[ ! -f $backup ]]; then
    cp -a "$TORRC" "$backup"
    echo "   backup -> $backup"
fi

needs_reload=0
append_if_missing() {
    local key=$1 line=$2
    if ! grep -qE "^[[:space:]]*${key}([[:space:]]|\$)" "$TORRC"; then
        printf '\n# Added by tor-ext setup-torrc.sh\n%s\n' "$line" >> "$TORRC"
        echo "   + $line"
        needs_reload=1
    else
        echo "   = $key already set"
    fi
}

echo ">> patching $TORRC"
append_if_missing 'ControlPort'              "ControlPort ${CONTROL_PORT}"
append_if_missing 'CookieAuthentication'     'CookieAuthentication 1'
append_if_missing 'CookieAuthFileGroupReadable' 'CookieAuthFileGroupReadable 1'

echo ">> checking group membership for user '$TARGET_USER' in '$TOR_GROUP'"
if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx "$TOR_GROUP"; then
    echo "   = already member"
else
    usermod -aG "$TOR_GROUP" "$TARGET_USER"
    echo "   + added $TARGET_USER to $TOR_GROUP (logout/login required for group to take effect for new shells)"
fi

echo ">> validating torrc"
if command -v tor >/dev/null 2>&1; then
    tor --verify-config -f "$TORRC" >/tmp/tor-ext-verify.log 2>&1 || {
        echo "!! tor --verify-config failed:"; sed -n '1,20p' /tmp/tor-ext-verify.log; exit 1; }
    echo "   ok"
fi

if (( needs_reload )); then
    echo ">> reloading tor"
    if systemctl is-active --quiet tor@default; then
        systemctl reload tor@default || systemctl restart tor@default
    fi
    if systemctl is-active --quiet tor; then
        systemctl reload tor 2>/dev/null || true
    fi
    sleep 1
fi

echo ">> verification"
ss -tlnp 2>/dev/null | grep -E ":${CONTROL_PORT}\b" >/dev/null \
    && echo "   ControlPort listening on 127.0.0.1:${CONTROL_PORT}" \
    || echo "!! ControlPort not listening yet; check 'journalctl -u tor@default'"

cookie=/run/tor/control.authcookie
if [[ -f $cookie ]]; then
    mode=$(stat -c '%A %U:%G %s' "$cookie")
    echo "   cookie: $cookie ($mode)"
    if sudo -u "$TARGET_USER" test -r "$cookie"; then
        echo "   user '$TARGET_USER' can read cookie ✓"
    else
        echo "!! user '$TARGET_USER' cannot read cookie — re-login required to pick up new group membership"
    fi
else
    echo "!! cookie not found at $cookie"
fi

echo "done."
