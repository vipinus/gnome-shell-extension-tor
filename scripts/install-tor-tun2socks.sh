#!/usr/bin/env bash
# install-tor-tun2socks.sh — one-shot privileged installer for tor-ext's
# transparent-proxy mode (v0.6.0).
#
# What it does (root only — self-escalates with sudo if run as user):
#   1. Installs the `tor` distro package via apt/dnf/pacman/zypper if missing.
#   2. Adds the invoking user to the distro's tor group (debian-tor / tor /
#      _tor) so the ControlPort cookie is readable.
#   3. Idempotently appends ControlPort + CookieAuth + DNSPort + Automap
#      directives to /etc/tor/torrc.
#   4. Downloads xjasonlyu/tun2socks release binary to /usr/local/bin/tun2socks
#      if not already present (skipped when $TUN2SOCKS is pre-set).
#   5. Installs system unit /etc/systemd/system/tor-ext-tun2socks.service
#      (runs as root — needs nft NAT + ip rule which CAP_NET_ADMIN can't grant).
#   6. Installs /usr/local/libexec/tor-ext/tor-ext-routing helper.
#   7. Installs polkit rule 51-tor-ext-tun2socks.rules (active local users get
#      passwordless start/stop on the distro tor unit + the tun2socks unit).
#   8. Installs systemd sleep hook to re-apply routing after resume.
#   9. Migration: detects + cleans up the old _tor-ext system user, /etc/tor-ext,
#      /var/lib/tor-ext, and the legacy tor-ext.service from versions < 0.6.0.
#  10. daemon-reload + polkit reload + tor restart.
#
# RUNTIME after setup: zero password. Tile click starts/stops both
# tor.service (or tor@default.service) and tor-ext-tun2socks.service via
# DBus, polkit allows it without prompting.
set -euo pipefail

TUN2SOCKS_VERSION=${TUN2SOCKS_VERSION:-v2.5.2}
TUN2SOCKS_BIN=${TUN2SOCKS:-/usr/local/bin/tun2socks}
TUN_DEV=${TUN_DEV:-tun-tor}
TUN_ADDR=${TUN_ADDR:-10.66.66.1/24}
SOCKS_PORT=${SOCKS_PORT:-9050}
CONTROL_PORT=${CONTROL_PORT:-9051}
DNS_PORT=${DNS_PORT:-5353}
TORRC=${TORRC:-/etc/tor/torrc}

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# ─── privilege check ────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo ">> escalating: sudo $0 $*"
    exec sudo -E TUN2SOCKS_VERSION="$TUN2SOCKS_VERSION" \
                 TUN2SOCKS="$TUN2SOCKS_BIN" \
                 TUN_DEV="$TUN_DEV" TUN_ADDR="$TUN_ADDR" \
                 SOCKS_PORT="$SOCKS_PORT" CONTROL_PORT="$CONTROL_PORT" \
                 DNS_PORT="$DNS_PORT" TORRC="$TORRC" \
                 bash "$0" "$@"
fi

INVOKING_USER=${SUDO_USER:-}
if [[ -z $INVOKING_USER && -n ${PKEXEC_UID:-} ]]; then
    INVOKING_USER=$(getent passwd "$PKEXEC_UID" | cut -d: -f1 || true)
fi
if [[ -z $INVOKING_USER || $INVOKING_USER == root ]]; then
    echo "!! cannot detect invoking user (SUDO_USER / PKEXEC_UID both unset)." >&2
    echo "   re-run as: sudo -E bash $0   OR   pkexec bash $0" >&2
    exit 1
fi

echo ">> repo:            $REPO_DIR"
echo ">> invoking user:   $INVOKING_USER"
echo ">> tun2socks:       $TUN2SOCKS_BIN (version $TUN2SOCKS_VERSION if download needed)"
echo ">> TUN:             $TUN_DEV / $TUN_ADDR"
echo ">> tor SOCKS/Ctrl:  $SOCKS_PORT / $CONTROL_PORT   DNSPort: $DNS_PORT"
echo ">> torrc:           $TORRC"

# ─── distro detection (used by pkg_install) ─────────────────────────
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    ID_LIKE=${ID_LIKE:-}
else
    ID=unknown ID_LIKE=
fi

# pkg_install <binary> <required|optional> <debian-pkg> <fedora-pkg> <arch-pkg> <suse-pkg>
# Skips if <binary> is already on PATH. "optional" means failure → warning, not abort.
pkg_install() {
    local bin=$1 mode=$2 deb=$3 fed=$4 arc=$5 sus=$6
    if command -v "$bin" >/dev/null 2>&1; then
        echo "   = $bin already on PATH ($(command -v "$bin"))"
        return 0
    fi
    echo ">> '$bin' not installed — bringing it in via the distro package manager"
    local rc=0
    case "$ID:$ID_LIKE" in
        debian:*|ubuntu:*|*:*debian*|*:*ubuntu*)
            [[ -z $deb ]] && rc=2 || {
                DEBIAN_FRONTEND=noninteractive apt-get update -qq
                DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$deb" || rc=$?
            } ;;
        fedora:*|rhel:*|centos:*|*:*fedora*|*:*rhel*)
            [[ -z $fed ]] && rc=2 || dnf install -y "$fed" || rc=$? ;;
        arch:*|manjaro:*|*:*arch*)
            [[ -z $arc ]] && rc=2 || pacman -Sy --noconfirm "$arc" || rc=$? ;;
        opensuse*:*|suse:*|*:*suse*)
            [[ -z $sus ]] && rc=2 || zypper --non-interactive install "$sus" || rc=$? ;;
        *)
            rc=2 ;;
    esac
    if ! command -v "$bin" >/dev/null 2>&1; then
        if [[ $mode == optional ]]; then
            echo "   ~ could not install $bin (rc=$rc). Bridges that need it will fail until you install it manually." >&2
            return 0
        fi
        echo "!! failed to install required '$bin' (rc=$rc). Install manually and re-run." >&2
        exit 1
    fi
    echo "   installed $(command -v "$bin")"
}

# ─── migration from < 0.6.0 (cleanup of _tor-ext install) ───────────
echo ">> migration check (legacy _tor-ext / tor-ext.service)"
LEGACY_FOUND=0
if systemctl list-unit-files tor-ext.service >/dev/null 2>&1 && \
   systemctl cat tor-ext.service >/dev/null 2>&1; then
    echo "   stopping + disabling legacy tor-ext.service"
    systemctl stop    tor-ext.service 2>/dev/null || true
    systemctl disable tor-ext.service 2>/dev/null || true
    rm -f /etc/systemd/system/tor-ext.service
    LEGACY_FOUND=1
fi
if systemctl list-unit-files tor-ext-tun2socks.service >/dev/null 2>&1 && \
   systemctl is-active --quiet tor-ext-tun2socks.service; then
    # Stop the old tun2socks unit before rewriting it (later in this script).
    systemctl stop tor-ext-tun2socks.service 2>/dev/null || true
fi
if getent passwd _tor-ext >/dev/null 2>&1; then
    echo "   removing legacy _tor-ext system user"
    userdel _tor-ext 2>/dev/null || true
    LEGACY_FOUND=1
fi
if getent group _tor-ext >/dev/null 2>&1; then
    groupdel _tor-ext 2>/dev/null || true
fi
if [[ -d /etc/tor-ext ]]; then
    echo "   removing legacy /etc/tor-ext"
    rm -rf /etc/tor-ext
    LEGACY_FOUND=1
fi
if [[ -d /var/lib/tor-ext ]]; then
    echo "   removing legacy /var/lib/tor-ext"
    rm -rf /var/lib/tor-ext
    LEGACY_FOUND=1
fi
[[ $LEGACY_FOUND == 1 ]] && systemctl daemon-reload || true

# ─── tor (required) ─────────────────────────────────────────────────
pkg_install tor required tor tor tor tor
TOR_BIN=$(command -v tor)
echo ">> tor binary:      $TOR_BIN"

# Detect distro tor group (debian-tor on Debian/Ubuntu, tor on Arch/Fedora,
# _tor on some BSD-leaning ports). First match wins.
TOR_GROUP=
for g in debian-tor tor _tor; do
    if getent group "$g" >/dev/null 2>&1; then TOR_GROUP=$g; break; fi
done
if [[ -z $TOR_GROUP ]]; then
    echo "!! could not find tor system group (tried debian-tor / tor / _tor)." >&2
    echo "   the tor package may not have created one — please report a bug." >&2
    exit 1
fi
echo ">> tor group:       $TOR_GROUP"

TOR_USER=
for u in debian-tor tor _tor; do
    if id -u "$u" >/dev/null 2>&1; then TOR_USER=$u; break; fi
done
if [[ -z $TOR_USER ]]; then
    echo "!! could not find tor system user (tried debian-tor / tor / _tor)." >&2
    exit 1
fi
echo ">> tor user:        $TOR_USER (uid $(id -u "$TOR_USER"))"

# ─── pluggable transports (optional — only needed for bridges) ──────
pkg_install obfs4proxy       optional obfs4proxy       obfs4     obfs4proxy       obfs4
pkg_install snowflake-client optional snowflake-client snowflake snowflake        ''
pkg_install webtunnel-client optional webtunnel        webtunnel webtunnel-client ''

IP_BIN=$(command -v ip)
echo ">> ip binary:       $IP_BIN"

# ─── add invoking user to tor group (cookie readability) ────────────
if id -nG "$INVOKING_USER" | tr ' ' '\n' | grep -qx "$TOR_GROUP"; then
    echo "   = $INVOKING_USER already in group $TOR_GROUP"
else
    usermod -aG "$TOR_GROUP" "$INVOKING_USER"
    REQUIRE_RELOGIN=1
    echo "   added $INVOKING_USER to group $TOR_GROUP (re-login required)"
fi

# ─── patch /etc/tor/torrc (idempotent append-if-missing) ────────────
if [[ ! -f $TORRC ]]; then
    echo "!! $TORRC not found. Is tor really installed?" >&2
    exit 1
fi

backup=${TORRC}.tor-ext.bak
if [[ ! -f $backup ]]; then
    cp -a "$TORRC" "$backup"
    echo "   backup -> $backup"
fi

torrc_changed=0
append_if_missing() {
    local key=$1 line=$2
    if ! grep -qE "^[[:space:]]*${key}([[:space:]]|\$)" "$TORRC"; then
        printf '\n# Added by tor-ext install-tor-tun2socks.sh\n%s\n' "$line" >> "$TORRC"
        echo "   + $line"
        torrc_changed=1
    else
        echo "   = $key already set"
    fi
}

echo ">> patching $TORRC"
append_if_missing 'ControlPort'                 "ControlPort ${CONTROL_PORT}"
append_if_missing 'SocksPort'                   "SocksPort ${SOCKS_PORT}"
append_if_missing 'CookieAuthentication'        'CookieAuthentication 1'
append_if_missing 'CookieAuthFileGroupReadable' 'CookieAuthFileGroupReadable 1'
append_if_missing 'DNSPort'                     "DNSPort ${DNS_PORT}"
append_if_missing 'AutomapHostsOnResolve'       'AutomapHostsOnResolve 1'
append_if_missing 'VirtualAddrNetworkIPv4'      'VirtualAddrNetworkIPv4 10.192.0.0/10'

if (( torrc_changed )); then
    echo ">> validating new torrc"
    if ! sudo -u "$TOR_USER" "$TOR_BIN" --verify-config -f "$TORRC" \
            >/tmp/tor-ext-verify.log 2>&1; then
        echo "!! tor --verify-config failed:"
        sed -n '1,30p' /tmp/tor-ext-verify.log
        echo "   reverting torrc from backup"
        cp -a "$backup" "$TORRC"
        exit 1
    fi
fi

# ─── tun2socks binary ───────────────────────────────────────────────
if [[ ! -x $TUN2SOCKS_BIN ]]; then
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) T2S_ARCH=amd64 ;;
        aarch64) T2S_ARCH=arm64 ;;
        armv7l) T2S_ARCH=armv7 ;;
        *) echo "!! unsupported arch: $ARCH" >&2; exit 1 ;;
    esac
    URL="https://github.com/xjasonlyu/tun2socks/releases/download/${TUN2SOCKS_VERSION}/tun2socks-linux-${T2S_ARCH}.zip"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    echo ">> downloading $URL"
    if command -v curl >/dev/null; then
        curl -fSL "$URL" -o "$TMP/t2s.zip"
    elif command -v wget >/dev/null; then
        wget -O "$TMP/t2s.zip" "$URL"
    else
        echo "!! need curl or wget to download tun2socks" >&2
        exit 1
    fi
    (cd "$TMP" && unzip -q t2s.zip)
    BIN_SRC=$(find "$TMP" -maxdepth 2 -type f -name 'tun2socks*' ! -name '*.zip' | head -1)
    if [[ -z $BIN_SRC ]]; then
        echo "!! tun2socks binary not found inside downloaded zip" >&2
        exit 1
    fi
    install -m 0755 "$BIN_SRC" "$TUN2SOCKS_BIN"
    echo "   installed $TUN2SOCKS_BIN"
else
    echo "   = tun2socks binary already present at $TUN2SOCKS_BIN"
fi

# ─── routing helper ─────────────────────────────────────────────────
install -d -m 0755 /usr/local/libexec/tor-ext
install -m 0755 "$REPO_DIR/scripts/tor-ext-routing" \
    /usr/local/libexec/tor-ext/tor-ext-routing
echo "   installed /usr/local/libexec/tor-ext/tor-ext-routing"

# ─── systemd sleep hook (re-apply routing after resume) ─────────────
install -d -m 0755 /usr/lib/systemd/system-sleep
install -m 0755 "$REPO_DIR/scripts/tor-ext-sleep-hook" \
    /usr/lib/systemd/system-sleep/tor-ext
echo "   installed /usr/lib/systemd/system-sleep/tor-ext"

# ─── systemd unit (templated with real paths) ───────────────────────
render_unit() {
    local src=$1 dst=$2
    sed -e "s|@TOR_BIN@|$TOR_BIN|g" \
        -e "s|@IP_BIN@|$IP_BIN|g" \
        -e "s|@TUN_DEV@|$TUN_DEV|g" \
        -e "s|@TUN_ADDR@|$TUN_ADDR|g" \
        -e "s|@SOCKS_PORT@|$SOCKS_PORT|g" \
        -e "s|@DNS_PORT@|$DNS_PORT|g" \
        -e "s|@TUN2SOCKS@|$TUN2SOCKS_BIN|g" \
        "$src" > "$dst"
    chmod 0644 "$dst"
}
render_unit "$REPO_DIR/systemd/tor-ext-tun2socks.service.in" \
            /etc/systemd/system/tor-ext-tun2socks.service
echo "   installed /etc/systemd/system/tor-ext-tun2socks.service"

# ─── polkit rule ────────────────────────────────────────────────────
install -m 0644 "$REPO_DIR/polkit/51-tor-ext-tun2socks.rules" \
    /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules
echo "   installed polkit rule"

# ─── reload daemons + restart tor (pick up new torrc) ───────────────
systemctl daemon-reload
systemctl reload polkit 2>/dev/null || systemctl restart polkit 2>/dev/null || true

if (( torrc_changed )); then
    # Pick whichever distro tor unit exists; restart so the new ControlPort /
    # DNSPort take effect immediately.
    for unit in tor@default.service tor.service; do
        if systemctl list-unit-files "$unit" >/dev/null 2>&1 && \
           systemctl cat "$unit" >/dev/null 2>&1; then
            echo ">> restarting $unit to pick up new torrc"
            systemctl restart "$unit" 2>/dev/null || true
            break
        fi
    done
fi

cat <<EOM

>> done.

Enable transparent-proxy mode from the Tor tile, or:
    gsettings set org.gnome.shell.extensions.tor-ext use-tun2socks true

${REQUIRE_RELOGIN:+!! $INVOKING_USER was just added to group $TOR_GROUP.
!! Log out and back in (or reboot) so the new group takes effect —
!! otherwise reading the tor control cookie will fail.
}
EOM
