# Tor — GNOME Shell Extension

Control the Tor anonymity network from the GNOME Quick Settings panel: one-click toggle, exit-country picker, live bootstrap progress, New Identity, pluggable-transport bridges (obfs4 / snowflake / webtunnel / meek_lite), circuit viewer, and optional transparent-proxy mode that routes **all** system TCP traffic through Tor.

Target: **GNOME Shell 50+**, `tor` available via the distro package manager.

## Features

- **One-click toggle** from Quick Settings. Default mode is zero-sudo (`systemd --user`); transparent-proxy mode is an opt-in one-time privileged setup, after which the tile stays passwordless.
- **Exit country** — pick from ~30 jurisdictions; applied as `ExitNodes {xx} StrictNodes=1` without restarting tor.
- **New Identity** — `SIGNAL NEWNYM` + `SIGNAL CLEARDNSCACHE` to rebuild circuits on demand.
- **Live bootstrap %** — the tile subtitle tracks `STATUS_CLIENT BOOTSTRAP` events (`Connecting… 42%` → `On · Exit: DE`).
- **Circuit viewer** — shows the current primary circuit as `Guard → Middle → Exit` with country codes.
- **Bridges** — obfs4, meek_lite, scramblesuit (all via `obfs4proxy`), snowflake, and webtunnel. Transport is detected from the first token of each `Bridge` line; `ClientTransportPlugin` is set up per-transport automatically.
- **Fetch public bridges** — one-button pull of Tor Project's Moat default bridges via our daily-refreshed [`bridges/latest.json`](bridges/).
- **Transparent proxy** — opt-in mode routes the whole machine through Tor via `tun2socks` + policy routing. IPv4 on Tor, DNS on Tor DNSPort, IPv6 temporarily disabled for leak prevention.
- **SOCKS5 tap-to-copy** — tile menu exposes `socks5://127.0.0.1:9150` for manual per-app configuration (Firefox, curl, ssh, etc.).
- **Top-bar indicator** — small onion icon visible only while Tor is running.

## Install

Two paths, pick one.

### Path 1 — Default (zero sudo)

```bash
git clone https://github.com/vipinus/gnome-shell-extension-tor tor-ext
cd tor-ext
make install                        # copies to ~/.local/share/gnome-shell/extensions/
bash scripts/install-user-tor.sh    # per-user tor unit + torrc in $HOME, no sudo
# Log out / log back in (Wayland), then:
gnome-extensions enable tor-ext@fabric.soul7.gmail.com
```

Per-user tor listens on **9150 / 9151** (Tor Browser Bundle convention) so it coexists with any system tor on 9050/9051. Everything lives under `$HOME`:

- `~/.config/tor-ext/torrc`
- `~/.local/share/tor-ext/` (DataDirectory + cookie)
- `~/.config/systemd/user/tor-ext.service`

No polkit rule, no group membership, no `/etc/tor/torrc` edits.

Apps that want to go through Tor need to be pointed at `socks5://127.0.0.1:9150` manually (browsers, curl, etc.).

### Path 2 — Transparent proxy (one-time sudo, runtime passwordless)

Route **every** TCP connection through Tor without configuring apps one by one:

```bash
git clone https://github.com/vipinus/gnome-shell-extension-tor tor-ext
cd tor-ext
make install
sudo bash scripts/install-tor-tun2socks.sh     # one-time sudo
# Log out / log back in (picks up _tor-ext group membership)
gnome-extensions enable tor-ext@fabric.soul7.gmail.com
gsettings --schemadir ~/.local/share/gnome-shell/extensions/tor-ext@fabric.soul7.gmail.com/schemas \
  set org.gnome.shell.extensions.tor-ext use-tun2socks true
# Or flip it in prefs: Tor tile → Preferences… → Transparent proxy
```

What the installer does (idempotent, self-escalates with `sudo`):

- Installs `tor`, `obfs4proxy`, `snowflake-client`, `webtunnel-client` via the distro package manager (apt / dnf / pacman / zypper).
- Creates the `_tor-ext` system user + group and adds the invoking user to it (so the tor control cookie is readable).
- Writes `/etc/tor-ext/torrc` with `DataDirectoryGroupReadable 1 CookieAuthFileGroupReadable 1 DNSPort 127.0.0.1:5353 AutomapHostsOnResolve 1`.
- Downloads xjasonlyu/tun2socks to `/usr/local/bin/tun2socks` when not already present.
- Installs system units:
  - `tor-ext.service` — system-scope tor running as `_tor-ext`.
  - `tor-ext-tun2socks.service` — tun2socks running as `_tor-ext` with `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW`.
- Installs `/usr/local/libexec/tor-ext/tor-ext-routing` helper (invoked by the tun2socks unit on up/down).
- Installs `/etc/polkit-1/rules.d/51-tor-ext-tun2socks.rules` that grants active local users passwordless `start`/`stop`/`restart` on the two tor-ext units via polkit.

How it routes (when transparent proxy is on):

- `ip rule` at priority 100: traffic from uid `_tor-ext` looks up table `main` — tor and tun2socks reach the real internet directly.
- `ip rule` at priority 200: everything else looks up table `100` whose default route is `dev tun-tor`.
- tun2socks grabs packets off the TUN and forwards to `127.0.0.1:9150` (tor SOCKS5).
- nftables DNAT redirects UDP/TCP `:53` on the TUN to `127.0.0.1:5353` (tor DNSPort).
- IPv6 is disabled per-interface (`net.ipv6.conf.*.disable_ipv6=1`) while the tunnel is up because Tor is IPv4-only — on-link `/64` and RA-replenished default routes would otherwise leak. Original values are snapshotted to `/run/tor-ext/` and restored on teardown.

Uninstall (keeps tor binary, user, data dir — remove those manually if desired):

```bash
make tun2socks-uninstall
```

## Preferences

Right-click the Tor tile → **Preferences…**, or:

```bash
gnome-extensions prefs tor-ext@fabric.soul7.gmail.com
```

### General

- **ControlPort** (default `9151`), **SocksPort** (default `9150`)
- **Cookie path** (default `~/.local/share/tor-ext/control_auth_cookie` in user mode, `/var/lib/tor-ext/control_auth_cookie` in system mode)
- **Control password** fallback (leave empty to use cookie auth)
- **Transparent proxy switch** — flips tor to the system-scope unit + enables tun2socks
- **Default exit country** (ISO alpha-2; empty = any)

### Bridges

Pluggable-transport binaries (defaults point at the distro package layout):

- `obfs4-binary` → `/usr/bin/obfs4proxy` (obfs4, meek_lite, scramblesuit)
- `snowflake-binary` → `/usr/bin/snowflake-client`
- `webtunnel-binary` → `/usr/bin/webtunnel-client`

Bridge lines (one per line) — first token is the transport. Examples:

```
obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0
snowflake 192.0.2.3:1 2B280B2311569931620F2D73A1E27E2F1F47BD72
webtunnel [2001:db8:...]:443 FINGERPRINT url=https://example.com/path ver=0.0.4
```

The **Fetch public bridges** button downloads Tor Project's default bridge list from this repo's daily-refreshed [`bridges/latest.json`](bridges/) and populates the text field automatically.

## Bridges auto-refresh (CI)

`.github/workflows/bridges-refresh.yml` runs daily at 03:17 UTC against the Moat circumvention-defaults endpoint, normalises the payload, and commits `bridges/latest.json` back to `main` when the list changed. `scripts/harvest-bridges.sh` is the harvester; both it and `bridges/README.md` document the public-only ethic (we deliberately don't aggregate BridgeDB's private pool).

## Architecture

```
extension.js                 entry — Main.panel.statusArea.quickSettings.addExternalIndicator()
prefs.js                     Adw.PreferencesWindow (General + Bridges) + Fetch button
lib/torController.js         async ControlPort client — SETCONF, SIGNAL, GETINFO, event stream
lib/torService.js            systemd1 DBus wrapper — dual-mode (session vs system bus)
lib/tun2socksService.js      tor-ext-tun2socks.service wrapper (system bus)
lib/circuitParser.js         parses GETINFO circuit-status + CIRC events
lib/countries.js             static ~30-country ISO alpha-2 list
ui/quickToggle.js            QuickMenuToggle + SystemIndicator
schemas/                     gsettings schema
icons/                       onion SVG
polkit/                      one-time install assets (NOT in the EGO zip)
systemd/                     unit templates rendered by install-tor-tun2socks.sh
scripts/                     installers + routing helper + bridge harvester
.github/workflows/           bridges-refresh CI
bridges/                     daily-refreshed public bridge JSON
```

## Verification

```bash
# Default mode (Path 1): per-user tor, SOCKS5 only
systemctl --user is-active tor-ext.service
curl -s --socks5-hostname 127.0.0.1:9150 https://check.torproject.org/api/ip
# → {"IsTor":true,"IP":"185.220.101.178"}

# Transparent-proxy mode (Path 2): whole host through Tor
systemctl is-active tor-ext.service tor-ext-tun2socks.service
curl -s https://check.torproject.org/api/ip        # IsTor:true without --socks5-hostname
curl -s -6 https://ifconfig.me                     # fails — IPv6 disabled while tunnel up

# Smoke tests against a live tor (optional)
gjs -m scripts/test-controller.js
gjs -m scripts/test-service.js
gjs -m scripts/test-circuits.js
```

## License

MIT (see `LICENSE`).
