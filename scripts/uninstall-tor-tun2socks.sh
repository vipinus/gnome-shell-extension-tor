#!/usr/bin/env bash
# uninstall-tor-tun2socks.sh — undo everything install-tor-tun2socks.sh did.
#
# Symmetric counterpart to the installer. Removes:
#   1. tor-ext-tun2socks.service (stop + disable + remove unit file)
#   2. /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules
#   3. /usr/local/libexec/tor-ext/tor-ext-routing
#   4. /usr/lib/systemd/system-sleep/tor-ext
#   5. /usr/local/bin/tun2socks (only if installer downloaded it; skip when
#      packaged via $TUN2SOCKS env override)
#   6. torrc patches: restore from /etc/tor/torrc.tor-ext.bak if present
#   7. Local user-side EXT_DIR ($HOME/.local/share/gnome-shell/extensions/...)
#
# What it deliberately does NOT touch:
#   - distro tor.service / tor@default.service themselves
#   - the tor distro package
#   - the user's membership in the tor group (re-auth on next login is the
#     only side-effect of staying in the group; removing requires another
#     logout cycle)
#   - obfs4proxy package (might be in use by other tor configs)
#
# Usage:
#   sudo bash scripts/uninstall-tor-tun2socks.sh
# or:
#   bash scripts/uninstall-tor-tun2socks.sh         (auto-escalates)
#
# After this, optionally manually:
#   sudo gpasswd -d $USER debian-tor   # remove tor group membership
#   sudo apt remove tor obfs4proxy      # nuke distro tor too
set -euo pipefail

UUID=tor-ext@fabric.soul7.gmail.com
EXT_DIR_USER=${HOME}/.local/share/gnome-shell/extensions/${UUID}
TORRC=${TORRC:-/etc/tor/torrc}
TORRC_BACKUP=${TORRC}.tor-ext.bak
TUN2SOCKS_BIN=${TUN2SOCKS:-/usr/local/bin/tun2socks}

# ─── privilege check ────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo ">> escalating: sudo $0 $*"
    exec sudo -E bash "$0" "$@"
fi

INVOKING_USER=${SUDO_USER:-}
[[ -z $INVOKING_USER && -n ${PKEXEC_UID:-} ]] && \
    INVOKING_USER=$(getent passwd "$PKEXEC_UID" | cut -d: -f1 || true)

echo ">> tor-ext uninstaller (v0.6.x)"

# ─── 1. systemd unit ────────────────────────────────────────────────
if systemctl list-unit-files tor-ext-tun2socks.service >/dev/null 2>&1; then
    echo "── stop + disable tor-ext-tun2socks.service"
    systemctl stop    tor-ext-tun2socks.service 2>/dev/null || true
    systemctl disable tor-ext-tun2socks.service 2>/dev/null || true
    rm -f /etc/systemd/system/tor-ext-tun2socks.service
    systemctl daemon-reload
fi

# ─── 2. polkit rule ─────────────────────────────────────────────────
if [[ -f /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules ]]; then
    echo "── remove polkit rule 51-tor-ext-tun2socks.rules"
    rm -f /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules
    systemctl reload polkit 2>/dev/null || systemctl restart polkit 2>/dev/null || true
fi

# Also clean up the legacy 50- rule if a < 0.6.2 install left it behind.
if [[ -f /etc/polkit-1/rules.d/50-tor-ext.rules ]]; then
    echo "── remove legacy polkit rule 50-tor-ext.rules"
    rm -f /etc/polkit-1/rules.d/50-tor-ext.rules
    systemctl reload polkit 2>/dev/null || true
fi

# ─── 3. routing helper + sleep hook ─────────────────────────────────
[[ -f /usr/local/libexec/tor-ext/tor-ext-routing ]] && {
    echo "── remove /usr/local/libexec/tor-ext/tor-ext-routing"
    rm -f /usr/local/libexec/tor-ext/tor-ext-routing
}
rmdir /usr/local/libexec/tor-ext 2>/dev/null || true

[[ -f /usr/lib/systemd/system-sleep/tor-ext ]] && {
    echo "── remove /usr/lib/systemd/system-sleep/tor-ext"
    rm -f /usr/lib/systemd/system-sleep/tor-ext
}

# ─── 4. tun2socks binary ────────────────────────────────────────────
if [[ -x $TUN2SOCKS_BIN ]]; then
    # Only if it's the xjasonlyu/tun2socks the installer dropped at the
    # default path. Don't delete a custom path the user explicitly set.
    if [[ $TUN2SOCKS_BIN == /usr/local/bin/tun2socks ]]; then
        echo "── remove $TUN2SOCKS_BIN"
        rm -f "$TUN2SOCKS_BIN"
    else
        echo "── keep $TUN2SOCKS_BIN (custom path, not installer default)"
    fi
fi

# ─── 5. torrc revert ────────────────────────────────────────────────
if [[ -f $TORRC_BACKUP ]]; then
    echo "── restore $TORRC from $TORRC_BACKUP"
    cp -a "$TORRC_BACKUP" "$TORRC"
    rm -f "$TORRC_BACKUP"
    # Restart distro tor so the un-patched torrc takes effect.
    for unit in tor@default.service tor.service; do
        if systemctl is-active --quiet "$unit"; then
            systemctl restart "$unit" 2>/dev/null || true
            break
        fi
    done
else
    echo "── no torrc backup found at $TORRC_BACKUP — leaving $TORRC alone"
    echo "   (manually remove ControlPort / CookieAuth / DNSPort / Automap"
    echo "    / VirtualAddrNetworkIPv4 lines if you want a pristine torrc)"
fi

# ─── 6. user-side extension dir ─────────────────────────────────────
if [[ -n $INVOKING_USER ]]; then
    USER_EXT=$(eval echo "~$INVOKING_USER")/.local/share/gnome-shell/extensions/${UUID}
else
    USER_EXT=$EXT_DIR_USER
fi
if [[ -d $USER_EXT ]]; then
    echo "── remove user EXT_DIR $USER_EXT"
    rm -rf "$USER_EXT"
fi

# ─── 7. /run/tor-ext leftover (created by tun2socks unit's RuntimeDirectory) ──
[[ -d /run/tor-ext ]] && rm -rf /run/tor-ext

cat <<EOM

>> done. tor-ext fully uninstalled.

Manual cleanup you may still want:
  - Remove your user from the tor group (logout/login required after):
      sudo gpasswd -d ${INVOKING_USER:-\$USER} debian-tor
  - Uninstall the distro tor + obfs4proxy packages if you don't need them:
      sudo apt remove tor obfs4proxy
  - GS Wayland: logout/login so gnome-shell forgets the extension cleanly.
EOM
