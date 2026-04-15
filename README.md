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

- Enable obfs4 bridges
- `obfs4proxy` binary path (default `/usr/bin/obfs4proxy`; `sudo apt install obfs4proxy`)
- Bridge lines (one per line, format: `obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0`)

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
