# Tor — GNOME Shell Extension

Control the Tor anonymity network from the GNOME Quick Settings panel: one-click toggle, exit-country picker, live bootstrap progress, New Identity, obfs4 bridges, and a circuit viewer.

Target: **GNOME Shell 50+**, system `tor` package managed by systemd.

## Features

- **Toggle** `tor@default.service` on/off from Quick Settings (password cached per session via polkit)
- **Exit country** — pick from ~30 common jurisdictions; set with `ExitNodes + StrictNodes=1`, no tor restart
- **System SOCKS proxy** — automatically set `org.gnome.system.proxy` to `socks://127.0.0.1:9050` when Tor is on; revert when off
- **New Identity** — `SIGNAL NEWNYM` + `SIGNAL CLEARDNSCACHE` to rebuild circuits on demand
- **Live bootstrap %** — subscribes to `STATUS_CLIENT BOOTSTRAP` events; subtitle shows `Connecting… 42%`
- **Circuit viewer** — displays the current primary circuit as `Guard → Middle → Exit` with country codes
- **obfs4 bridges** — paste bridge lines in preferences, enable `UseBridges` with `ClientTransportPlugin`
- **Top-bar indicator** — small onion icon in the panel, visible only while Tor is running

## Install

### From source — zero sudo

```bash
git clone https://github.com/vipinus/gnome-shell-extension-tor tor-ext
cd tor-ext
make install                        # copies to ~/.local/share/gnome-shell/extensions/
bash scripts/install-user-tor.sh    # per-user tor unit + torrc in $HOME, no sudo
# Log out and log back in (Wayland), then:
gnome-extensions enable tor-ext@fabric.soul7.gmail.com
```

### Architecture: per-user Tor, no privilege

The extension runs its own tor instance via `systemd --user` (`~/.config/systemd/user/tor-ext.service`) with config and data dir under `$HOME`. Default ports are **9150/9151** (Tor Browser Bundle convention) so it coexists with any system tor on 9050/9051.

- No `sudo` anywhere — unit management goes through the user's own systemd on the session bus.
- No `/etc/polkit-1` rule — users may freely manage their own units.
- No group membership — the auth cookie is owned by the user.
- No `/etc/tor/torrc` edits — config lives at `~/.config/tor-ext/torrc`.

If you already have the system `tor.service` package installed and running, this extension does not interact with it and does not conflict (different ports).

### Optional: transparent proxy via tun2socks

If you want **every** TCP connection on the machine (not just apps you've configured with a SOCKS5 endpoint) routed through Tor, enable transparent-proxy mode:

```bash
sudo bash scripts/install-tor-tun2socks.sh   # one-time only, asks for sudo once
gsettings set org.gnome.shell.extensions.tor-ext use-tun2socks true
# or toggle it in the prefs window: Tor tile → Preferences… → Transparent proxy
```

What the installer does:

- Installs the `tor` package via apt/dnf/pacman/zypper if not already present.
- Creates a `_tor-ext` system user and adds you to the `_tor-ext` group (so you can read the tor control cookie).
- Installs `/etc/systemd/system/tor-ext.service` (system-scope tor running as `_tor-ext`) and `/etc/systemd/system/tor-ext-tun2socks.service` (tun2socks running as `_tor-ext` with `CAP_NET_ADMIN` + `CAP_NET_RAW`).
- Downloads xjasonlyu/tun2socks to `/usr/local/bin/tun2socks` if not already present.
- Installs a polkit rule that gives active local users **passwordless** start/stop on those two units — so after this one-time setup, the tile click is instant.

How it routes:

- Policy rule: `ip rule add uidrange $_tor-ext_UID` looks up `main` — so tor's + tun2socks's own outbound traffic uses the real default route.
- Everything else looks up table `100`, whose default route is `dev tun-tor`.
- tun2socks grabs TCP from the TUN, forwards to `127.0.0.1:9150` (tor SOCKS5).
- DNS (UDP/TCP 53) hitting the TUN is NAT-redirected to tor's DNSPort on `127.0.0.1:5353`.
- IPv6 default route is temporarily torn down while the tunnel is up (no IPv6 Tor exits → leak prevention).

Log out and back in after the installer runs so the `_tor-ext` group membership takes effect on your login session.

## Preferences

Right-click the Tor tile → **Preferences…** — or:

```bash
gnome-extensions prefs tor-ext@fabric.soul7.gmail.com
```

### General

- ControlPort (default 9051) and SocksPort (9050)
- Cookie auth path (default `/run/tor/control.authcookie`) / password fallback
- Manage GNOME system SOCKS proxy (default on)
- Default exit country

### Bridges

Supported pluggable transports: **obfs4**, **meek_lite**, **scramblesuit** (all via obfs4proxy), and **snowflake**. The first whitespace-separated token on each `Bridge` line is the transport name — tor-ext detects it and sets up the matching `ClientTransportPlugin` automatically.

- Enable bridges (master switch)
- `obfs4proxy` binary (default `/usr/bin/obfs4proxy`; `sudo apt install obfs4proxy`) — also serves meek_lite / scramblesuit
- `snowflake-client` binary (default `/usr/bin/snowflake-client`; `sudo apt install snowflake-client`)
- Bridge lines (one per line). Examples:
  - `obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0`
  - `snowflake 192.0.2.3:1 2B280B2311569931620F2D73A1E27E2F1F47BD72`

## Architecture

```
extension.js           entry — Main.panel.statusArea.quickSettings.addExternalIndicator()
prefs.js               Adw.PreferencesWindow (General + Bridges tabs)
lib/torController.js   async ControlPort client — SETCONF, SIGNAL, GETINFO, event stream
lib/torService.js      systemd1 DBus wrapper with ALLOW_INTERACTIVE_AUTHORIZATION
lib/proxyManager.js    GSettings SOCKS save/restore
lib/circuitParser.js   parses `GETINFO circuit-status` + CIRC events
lib/countries.js       static ~30-country ISO alpha-2 list
ui/quickToggle.js      QuickMenuToggle + SystemIndicator
```

## Verification

```bash
# after install + setup + relogin:
curl -s --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip
# → {"IsTor":true,"IP":"185.220.101.178"}

gjs -m scripts/test-controller.js     # smoke-test ControlPort client
gjs -m scripts/test-service.js        # smoke-test systemd DBus wrapper
gjs -m scripts/test-circuits.js       # parse live circuits + ip-to-country
```

## License

MIT (see `LICENSE`).
