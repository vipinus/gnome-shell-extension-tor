#!/usr/bin/env bash
# install-tor-tun2socks.sh — one-shot privileged installer for tor-ext's
# transparent-proxy mode.
#
# What it does (root only — self-escalates with sudo if run as user):
#   1. Installs the `tor` distro package via apt/dnf/pacman/zypper if missing.
#   2. Creates system user/group `_tor-ext` (no login shell, no home mount).
#   3. Adds the invoking user to the _tor-ext group so the control cookie is
#      readable without copy-around tricks.
#   4. Creates /etc/tor-ext/torrc and /var/lib/tor-ext/ (DataDirectory).
#   5. Downloads xjasonlyu/tun2socks release binary to /usr/local/bin/tun2socks
#      if not already present (skipped when $TUN2SOCKS is pre-set).
#   6. Installs system units:
#        /etc/systemd/system/tor-ext.service            (tor as _tor-ext)
#        /etc/systemd/system/tor-ext-tun2socks.service  (tun2socks as _tor-ext)
#   7. Installs /usr/local/libexec/tor-ext/tor-ext-routing helper.
#   8. Installs polkit rule 51-tor-ext-tun2socks.rules (active local users get
#      passwordless start/stop on the two units).
#   9. daemon-reload + polkit reload.
#
# RUNTIME after setup: zero password. Tile click starts both units via DBus.
# The per-user `~/.config/systemd/user/tor-ext.service` is left untouched —
# the extension simply talks to the system unit when `use-tun2socks=true`.
set -euo pipefail

TUN2SOCKS_VERSION=${TUN2SOCKS_VERSION:-v2.5.2}
TUN2SOCKS_BIN=${TUN2SOCKS:-/usr/local/bin/tun2socks}
TUN_DEV=${TUN_DEV:-tun-tor}
TUN_ADDR=${TUN_ADDR:-10.66.66.1/24}
SOCKS_PORT=${SOCKS_PORT:-9150}
CONTROL_PORT=${CONTROL_PORT:-9151}
DNS_PORT=${DNS_PORT:-5353}

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# ─── privilege check ────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo ">> escalating: sudo $0 $*"
    exec sudo -E TUN2SOCKS_VERSION="$TUN2SOCKS_VERSION" \
                 TUN2SOCKS="$TUN2SOCKS_BIN" \
                 TUN_DEV="$TUN_DEV" TUN_ADDR="$TUN_ADDR" \
                 SOCKS_PORT="$SOCKS_PORT" CONTROL_PORT="$CONTROL_PORT" \
                 DNS_PORT="$DNS_PORT" \
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

# ─── tor binary (auto-install via distro package manager) ──────────
TOR_BIN=$(command -v tor || true)
if [[ -z $TOR_BIN ]]; then
    echo ">> 'tor' not installed — bringing it in via the distro package manager"
    if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        ID_LIKE=${ID_LIKE:-}
    else
        ID=unknown ID_LIKE=
    fi
    case "$ID:$ID_LIKE" in
        debian:*|ubuntu:*|*:*debian*|*:*ubuntu*)
            DEBIAN_FRONTEND=noninteractive apt-get update -qq
            DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tor ;;
        fedora:*|rhel:*|centos:*|*:*fedora*|*:*rhel*)
            dnf install -y tor ;;
        arch:*|manjaro:*|*:*arch*)
            pacman -Sy --noconfirm tor ;;
        opensuse*:*|suse:*|*:*suse*)
            zypper --non-interactive install tor ;;
        *)
            echo "!! unknown distro ($ID / $ID_LIKE) — install 'tor' manually and re-run:" >&2
            echo "   Debian/Ubuntu : apt install tor" >&2
            echo "   Fedora/RHEL   : dnf install tor" >&2
            echo "   Arch/Manjaro  : pacman -S tor" >&2
            echo "   openSUSE      : zypper install tor" >&2
            exit 1 ;;
    esac
    TOR_BIN=$(command -v tor || true)
    if [[ -z $TOR_BIN ]]; then
        echo "!! package manager reported success but tor still not on PATH" >&2
        exit 1
    fi
    echo "   installed $TOR_BIN"
fi
echo ">> tor binary:      $TOR_BIN"

# Disable the distro's tor@default.service if it autostarts — it'll fight us
# for 127.0.0.1:9150/9151. Users who want system tor on different ports can
# re-enable it after editing /etc/tor/torrc.
if systemctl is-enabled tor@default.service >/dev/null 2>&1; then
    systemctl disable --now tor@default.service 2>/dev/null || true
    echo "   disabled tor@default.service (would conflict on our ports)"
fi

IP_BIN=$(command -v ip)
echo ">> ip binary:       $IP_BIN"

# ─── _tor-ext system user ───────────────────────────────────────────
if ! getent group _tor-ext >/dev/null; then
    groupadd --system _tor-ext
    echo "   created group _tor-ext"
fi
if ! getent passwd _tor-ext >/dev/null; then
    useradd --system --gid _tor-ext \
            --home-dir /var/lib/tor-ext \
            --shell /usr/sbin/nologin \
            --comment "tor-ext system tor + tun2socks" \
            _tor-ext
    echo "   created user _tor-ext"
fi

# Add invoking user to _tor-ext group so it can read the control auth cookie.
if ! id -nG "$INVOKING_USER" | tr ' ' '\n' | grep -qx _tor-ext; then
    usermod -aG _tor-ext "$INVOKING_USER"
    REQUIRE_RELOGIN=1
    echo "   added $INVOKING_USER to group _tor-ext (re-login required)"
fi

# ─── /etc/tor-ext/torrc ─────────────────────────────────────────────
install -d -m 0755 /etc/tor-ext
# 0750 on the data dir lets _tor-ext group members TRAVERSE (x) into the dir
# to read the group-readable cookie file that tor creates inside it.
install -d -m 0750 -o _tor-ext -g _tor-ext /var/lib/tor-ext
install -d -m 0755 /usr/local/libexec/tor-ext

write_torrc() {
    cat >/etc/tor-ext/torrc <<EOF
# tor-ext system-mode torrc. Extension manages ExitNodes / Bridge /
# UseBridges / ClientTransportPlugin via ControlPort — don't set here.
DataDirectory /var/lib/tor-ext
# Tor forcibly chmod's DataDirectory on every start. Without the next line
# the dir would be 0700 and _tor-ext group members can't traverse it to
# read the cookie. With it tor sets 0750 and the group (which includes the
# invoking user) can enter.
DataDirectoryGroupReadable 1
SocksPort 127.0.0.1:${SOCKS_PORT}
ControlPort 127.0.0.1:${CONTROL_PORT}
CookieAuthentication 1
CookieAuthFile /var/lib/tor-ext/control_auth_cookie
CookieAuthFileGroupReadable 1
DNSPort 127.0.0.1:${DNS_PORT}
AutomapHostsOnResolve 1
VirtualAddrNetworkIPv4 10.192.0.0/10
Log notice syslog
EOF
    chown root:_tor-ext /etc/tor-ext/torrc
    chmod 0640 /etc/tor-ext/torrc
}

if [[ ! -f /etc/tor-ext/torrc ]]; then
    write_torrc
    echo "   wrote /etc/tor-ext/torrc"
elif ! grep -qE '^DataDirectoryGroupReadable\s+1' /etc/tor-ext/torrc; then
    # Old install missing the group-readable fix — rewrite (idempotent, same
    # ports/paths as before; user customisations via upstream patching aren't
    # supported anyway since this script is meant to own the file).
    write_torrc
    echo "   rewrote /etc/tor-ext/torrc (added DataDirectoryGroupReadable)"
else
    echo "   = /etc/tor-ext/torrc already exists + current (keeping)"
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
    # xjasonlyu's zip unpacks to tun2socks-linux-<arch> — detect whatever it's named.
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
install -m 0755 "$REPO_DIR/scripts/tor-ext-routing" \
    /usr/local/libexec/tor-ext/tor-ext-routing
echo "   installed /usr/local/libexec/tor-ext/tor-ext-routing"

# ─── systemd units (templated with real paths) ──────────────────────
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
render_unit "$REPO_DIR/systemd/tor-ext.service.in" \
            /etc/systemd/system/tor-ext.service
render_unit "$REPO_DIR/systemd/tor-ext-tun2socks.service.in" \
            /etc/systemd/system/tor-ext-tun2socks.service
echo "   installed system units"

# ─── polkit rule ────────────────────────────────────────────────────
install -m 0644 "$REPO_DIR/polkit/51-tor-ext-tun2socks.rules" \
    /etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules
echo "   installed polkit rule"

# ─── reload daemons ─────────────────────────────────────────────────
systemctl daemon-reload
systemctl reload polkit 2>/dev/null || systemctl restart polkit 2>/dev/null || true

# ─── verify tor config ──────────────────────────────────────────────
echo ">> validating /etc/tor-ext/torrc"
VERIFY_LOG=$(mktemp -t tor-ext-verify.XXXXXX.log)
trap 'rm -f "$VERIFY_LOG"' EXIT
if ! sudo -u _tor-ext "$TOR_BIN" --verify-config -f /etc/tor-ext/torrc \
        >"$VERIFY_LOG" 2>&1; then
    echo "!! tor --verify-config failed:" >&2
    sed -n '1,30p' "$VERIFY_LOG" >&2
    exit 1
fi
echo "   ok"

cat <<EOM

>> done.

Enable transparent-proxy mode from the Tor tile:
    gsettings set org.gnome.shell.extensions.tor-ext use-tun2socks true
(or toggle it in the extension's Preferences window.)

${REQUIRE_RELOGIN:+!! $INVOKING_USER was just added to group _tor-ext.
!! Log out and back in (or reboot) so the new group takes effect —
!! otherwise reading the tor control cookie will fail.
}
EOM
