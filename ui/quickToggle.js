// quickToggle.js — Quick Settings tile for tor-ext.
//
// Phases 5–8:
//   - on/off toggle with polkit-gated systemctl start/stop (phase 5)
//   - exit-country picker via SETCONF ExitNodes (phase 6)
//   - live bootstrap % subtitle via STATUS_CLIENT events (phase 7)
//   - New Identity button via SIGNAL NEWNYM + CLEARDNSCACHE (phase 8)

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TorController, ControllerState} from '../lib/torController.js';
import {TorService} from '../lib/torService.js';
import {Tun2SocksService} from '../lib/tun2socksService.js';
import {COUNTRIES, countryName} from '../lib/countries.js';
import {pickPrimaryCircuit} from '../lib/circuitParser.js';

// Custom tor-symbolic.svg lives in icons/. We load it as a Gio.FileIcon at
// runtime (extension.path is only known at enable()) so the tile and the
// top-bar indicator both show the project's onion glyph instead of a
// generic VPN icon. The same icon is used for on/off — GS's QuickMenuToggle
// already dims the unchecked state via .unchecked CSS, no separate svg needed.
function _loadTorIcon(extPath) {
    const file = Gio.File.new_for_path(
        GLib.build_filenamev([extPath, 'icons', 'tor-symbolic.svg']));
    return new Gio.FileIcon({file});
}

const TorToggle = GObject.registerClass(
class TorToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        const torIcon = _loadTorIcon(extension.path);
        super._init({
            title: 'Tor',
            gicon: torIcon,
            toggleMode: true,
        });
        this._torIcon = torIcon;
        this._ext = extension;
        this._settings = extension.getSettings();

        // v0.6.6: tun2socks is the only mode. tor itself is always the
        // distro's tor.service; tun2socks is started in lockstep so all
        // TCP traffic is transparently proxied. SOCKS-only mode was
        // dropped — apps had to be configured per-app, and the dual code
        // path bloated the toggle logic without buying anything users
        // actually used.
        this._service    = new TorService();
        this._tun2socks  = new Tun2SocksService();
        this._controller = null;
        this._busy       = false;
        this._bootstrapPct = 0;

        this.menu.setHeader(this._torIcon, 'Tor', this._statusSubtitle());

        this._buildMenu();

        this._clickedId = this.connect('clicked', () => this._onClicked());
        this._activeChangedId = this._service.connect('active-changed',
            (_s, state) => this._onServiceState(state));

        // Sync initial state
        this._service.getActiveState()
            .then(s => this._reflectInitialState(s))
            .catch(() => this._setSubtitle('Off'));
    }

    _buildMenu() {
        // Row 1 — New Identity
        this._newIdentityItem = new PopupMenu.PopupMenuItem('New Identity');
        this._newIdentityItem.connect('activate', () => this._onNewIdentity());
        this.menu.addMenuItem(this._newIdentityItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Row 2 — Exit country submenu
        this._exitItem = new PopupMenu.PopupSubMenuMenuItem('Exit country');
        // Cap the country list at ~6 rows with a scrollbar.
        //
        // Stock PopupSubMenu._needsScrollbar() reads max-height from the
        // *top* menu's theme node (gnome-shell ui/popupMenu.js line ~1168),
        // so a max-height on the submenu actor is ignored and
        // vscrollbar_policy stays at NEVER. Override the instance method to
        // read the submenu's own max-height + the inner box's natural
        // height — then open() flips the submenu's internal ScrollView to
        // AUTOMATIC and the content clips+scrolls as expected.
        this._exitItem.menu.actor.set_style('max-height: 14em;');
        this._exitItem.menu._needsScrollbar = function () {
            const [, natural] = this.box.get_preferred_height(-1);
            const maxH = this.actor.get_theme_node().get_max_height();
            return maxH >= 0 && natural >= maxH;
        };
        this.menu.addMenuItem(this._exitItem);
        this._countryItems = new Map();  // code → PopupMenuItem
        for (const c of COUNTRIES) {
            const item = new PopupMenu.PopupMenuItem(c.name);
            item.connect('activate', () => this._onCountrySelected(c.code));
            this._exitItem.menu.addMenuItem(item);
            this._countryItems.set(c.code, item);
        }
        this._refreshCountryChecks();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Row 3 — SOCKS connection info (tap to copy)
        this._socksItem = new PopupMenu.PopupMenuItem(this._socksLabelText());
        const copyIcon = new St.Icon({
            icon_name: 'edit-copy-symbolic',
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._socksItem.add_child(copyIcon);
        this._socksItem.connect('activate', () => this._copySocksAddress());
        this.menu.addMenuItem(this._socksItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Row 4 — Circuit viewer (populated lazily when submenu opens)
        this._circuitItem = new PopupMenu.PopupMenuItem('Circuit: —', {reactive: false});
        this._circuitItem.can_focus = false;
        this.menu.addMenuItem(this._circuitItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Row 4 — Settings
        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._menuOpenId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open && this.checked && this._controller?.isReady)
                this._refreshCircuitView();
        });
    }

    _refreshCountryChecks() {
        const current = (this._settings.get_string('default-exit-country') || '').toLowerCase();
        for (const [code, item] of this._countryItems) {
            item.setOrnament(code === current
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
        this._exitItem.label.text = `Exit: ${countryName(current)}`;
    }

    _statusSubtitle() {
        if (this._busy && this._bootstrapPct > 0 && this._bootstrapPct < 100)
            return `Connecting… ${this._bootstrapPct}%`;
        if (!this.checked) return 'Off';
        const country = this._settings.get_string('default-exit-country');
        return country ? `On · Exit: ${countryName(country)}` : 'On';
    }

    _setSubtitle(s) {
        this.subtitle = s;
        if (this.menu.setHeader) this.menu.setHeader(this._torIcon, 'Tor', s);
    }

    _reflectInitialState(state) {
        if (state === 'active') {
            this.checked = true;
            this.gicon = this._torIcon;
            this._setSubtitle(this._statusSubtitle());
            this._attachController()
                .then(() => this._applyCurrentCountry())
                .catch(() => { /* non-fatal */ });
        } else {
            this.checked = false;
            this.gicon = this._torIcon;
            this._setSubtitle('Off');
        }
    }

    async _onClicked() {
        if (this._busy) return;
        this._busy = true;
        try {
            if (this.checked) await this._turnOn();
            else              await this._turnOff();
        } catch (e) {
            console.warn(`[tor-ext] toggle failed: ${e.message}`);
            Main.notify('Tor', `Failed: ${e.message}`);
        } finally {
            // Reconcile UI with real unit state before releasing the busy
            // lock. Prevents the "tile says ON but tor is OFF" drift that
            // happens when the user double-clicks — QuickMenuToggle auto-
            // flips `checked` on every click before our handler runs, so
            // rapid taps can leave the property out of sync with reality.
            try {
                const active = await this._withTimeout(
                    this._service.isActive(), 3000, 'reconcile.isActive');
                if (this.checked !== active) {
                    this.checked = active;
                    this.gicon = this._torIcon;
                    this._setSubtitle(this._statusSubtitle());
                }
            } catch (_) { /* service unreachable → leave UI as-is */ }
            this._busy = false;
        }
    }

    async _turnOn() {
        this._bootstrapPct = 0;
        this._setSubtitle('Starting…');
        this.gicon = this._torIcon;

        // Pre-flight: tun2socks unit must exist (installer has run).
        const installed = await this._tun2socks.isInstalled();
        if (!installed) {
            throw new Error('tun2socks not installed — run scripts/install-tor-tun2socks.sh');
        }

        const active = await this._service.isActive();
        if (!active) {
            await this._service.start();
            await this._service.waitForState('active', 15000);
        }
        await this._attachController();
        await this._applyBridges();
        await this._applyCurrentCountry();

        // Wait for bootstrap ≥ 100% before flipping routes — otherwise
        // tun2socks will forward to a SOCKS that can't reach the network
        // yet and all the user sees is dead tabs.
        this._setSubtitle('Bootstrapping Tor…');
        await this._waitForBootstrap(60000);

        this._setSubtitle('Enabling transparent proxy…');
        await this._tun2socks.start();
        await this._tun2socks.waitForState('active', 15000);

        await this._notifyOnce();
        this._setSubtitle(this._statusSubtitle());
    }

    async _turnOff() {
        this._setSubtitle('Stopping…');

        // Order matters: pull the TUN routing down BEFORE tor, so apps don't
        // spin against a dead SOCKS endpoint in the brief window between.
        try {
            if (await this._withTimeout(this._tun2socks.isActive(), 3000, 't2s.isActive')) {
                await this._withTimeout(this._tun2socks.stop(), 5000, 't2s.stop');
                await this._withTimeout(this._tun2socks.waitForState('inactive', 8000),
                                        10000, 't2s.wait-inactive');
            }
        } catch (e) {
            console.warn(`[tor-ext] tun2socks stop step failed/timed out: ${e.message}`);
        }

        // controller.quit() writes QUIT to the ControlPort and awaits the 250
        // response. If tor has already shut the socket (or the link is wedged)
        // the await can hang forever — we want _turnOff to stay bounded.
        if (this._controller) {
            try {
                await this._withTimeout(this._controller.quit(), 3000, 'controller.quit');
            } catch (e) {
                console.warn(`[tor-ext] controller.quit timed out: ${e.message}`);
            }
            this._detachController();
        }

        try {
            await this._withTimeout(this._service.stop(), 5000, 'service.stop');
        } catch (e) {
            console.warn(`[tor-ext] service.stop timed out: ${e.message}`);
        }
        this.gicon = this._torIcon;
        this._setSubtitle('Off');
        Main.notify('Tor', 'Disconnected');
    }

    /** Race a promise against a timeout. Throws `Error(${tag} timed out)`. */
    _withTimeout(promise, ms, tag) {
        let cancel;
        const timer = new Promise((_, rej) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                rej(new Error(`${tag} timed out after ${ms}ms`));
                return GLib.SOURCE_REMOVE;
            });
            cancel = () => GLib.source_remove(id);
        });
        return Promise.race([
            promise.then(v => { cancel?.(); return v; },
                         e => { cancel?.(); throw e; }),
            timer,
        ]);
    }

    async _waitForBootstrap(timeoutMs) {
        if (this._bootstrapPct >= 100) return;
        const deadline = GLib.get_monotonic_time() / 1000 + timeoutMs;
        while (this._bootstrapPct < 100) {
            if (GLib.get_monotonic_time() / 1000 > deadline)
                throw new Error('Tor bootstrap timed out');
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300,
                () => { r(); return GLib.SOURCE_REMOVE; }));
        }
    }

    async _attachController() {
        if (this._controller && this._controller.isReady) return;
        const c = new TorController({
            port:       this._settings.get_int('control-port'),
            cookiePath: this._settings.get_string('cookie-path'),
            password:   this._settings.get_string('control-password'),
        });
        const start = GLib.get_monotonic_time();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try { await c.connectAndAuth(); break; }
            catch (e) {
                if ((GLib.get_monotonic_time() - start) / 1000 > 10000) {
                    // Typical root causes: ControlPort not configured in torrc,
                    // or user not in tor's unix group so the auth cookie can't
                    // be read. Surface an actionable hint.
                    throw new Error(`${e.message}. Run scripts/setup-torrc.sh (one-time setup) and log out/in.`);
                }
                await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { r(); return GLib.SOURCE_REMOVE; }));
            }
        }
        this._controller = c;

        // Subscribe to events for live bootstrap subtitle
        this._bootstrapSigId = c.connect('bootstrap', (_o, pct, _tag, _summary) => {
            this._bootstrapPct = pct;
            if (pct < 100 && this.checked)
                this._setSubtitle(`Connecting… ${pct}%`);
            else if (pct >= 100 && this.checked)
                this._setSubtitle(this._statusSubtitle());
        });
        this._disconnectedSigId = c.connect('disconnected', () => {
            this._detachController();
        });
        this._circuitSigId = c.connect('circuit-event', () => {
            if (this.menu.isOpen && this.checked)
                this._refreshCircuitView();
        });
        try {
            await c.setEvents(['STATUS_CLIENT', 'CIRC']);
        } catch (e) {
            console.warn(`[tor-ext] SETEVENTS failed: ${e.message}`);
        }
    }

    async _refreshCircuitView() {
        if (!this._controller?.isReady) {
            this._circuitItem.label.text = 'Circuit: —';
            return;
        }
        try {
            const circs = await this._controller.getCircuits();
            const c = pickPrimaryCircuit(circs);
            if (!c) {
                this._circuitItem.label.text = 'Circuit: (building…)';
                return;
            }
            const ccs = await Promise.all(c.hops.map(async h => {
                const ip = await this._controller.getRelayIP(h.fp);
                const cc = await this._controller.getIPCountry(ip);
                return cc || '??';
            }));
            this._circuitItem.label.text = `Circuit: ${ccs.join(' → ')}`;
        } catch (e) {
            this._circuitItem.label.text = `Circuit: (${e.message.slice(0, 40)})`;
        }
    }

    _detachController() {
        if (!this._controller) return;
        if (this._bootstrapSigId) {
            try { this._controller.disconnect(this._bootstrapSigId); } catch (_) {}
            this._bootstrapSigId = 0;
        }
        if (this._disconnectedSigId) {
            try { this._controller.disconnect(this._disconnectedSigId); } catch (_) {}
            this._disconnectedSigId = 0;
        }
        if (this._circuitSigId) {
            try { this._controller.disconnect(this._circuitSigId); } catch (_) {}
            this._circuitSigId = 0;
        }
        try { this._controller.close(); } catch (_) {}
        this._controller = null;
    }

    async _notifyOnce() {
        const exitCC = await this._resolveExitCountry();
        Main.notify('Tor',
            exitCC ? `Connected · Exit ${exitCC.toUpperCase()}` : 'Connected');
    }

    /**
     * Best-effort: ask tor for circuit-status, pick the primary GENERAL
     * circuit, resolve its last hop to a country code. Returns null if no
     * BUILT circuit yet, controller unready, or country lookup fails — the
     * caller treats null as "no exit info available".
     */
    async _resolveExitCountry() {
        if (!this._controller?.isReady) return null;
        try {
            const circs = await this._withTimeout(
                this._controller.getCircuits(), 3000, 'getCircuits');
            const c = pickPrimaryCircuit(circs);
            if (!c || !c.hops.length) return null;
            const exitFp = c.hops[c.hops.length - 1].fp;
            const ip = await this._withTimeout(
                this._controller.getRelayIP(exitFp), 2000, 'getRelayIP');
            return await this._withTimeout(
                this._controller.getIPCountry(ip), 2000, 'getIPCountry');
        } catch (_) {
            return null;
        }
    }

    _socksLabelText() {
        const port = this._settings.get_int('socks-port');
        return `SOCKS5  127.0.0.1:${port}`;
    }

    _copySocksAddress() {
        const port = this._settings.get_int('socks-port');
        const addr = `socks5://127.0.0.1:${port}`;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, addr);
        Main.notify('Tor', `Copied ${addr}`);
    }

    async _applyBridges() {
        if (!this._controller?.isReady) return;
        const useBridges = this._settings.get_boolean('use-bridges');
        if (!useBridges) {
            try {
                await this._controller.resetConf(['UseBridges', 'Bridge', 'ClientTransportPlugin']);
            } catch (_) {}
            return;
        }
        const lines = this._settings.get_strv('bridge-lines')
            .map(l => l.trim()).filter(Boolean);
        if (!lines.length) {
            Main.notify('Tor', 'Bridges enabled but no bridge lines configured — disable in preferences');
            throw new Error('no bridge lines');
        }

        // Collect the set of transports actually used by the configured
        // bridge lines. First whitespace-separated token of each `Bridge`
        // line is the transport name (obfs4, meek_lite, scramblesuit).
        const transports = new Set();
        for (const line of lines) {
            const first = line.split(/\s+/)[0];
            if (first && /^[a-z0-9_]+$/i.test(first)) transports.add(first.toLowerCase());
        }

        // Map transport → (binary, install-hint). obfs4proxy implements
        // obfs4, meek_lite and scramblesuit, so all three reuse its path.
        // snowflake / webtunnel were dropped: the Moat /circumvention/
        // defaults endpoint hands them out with placeholder IPs that crash
        // their PT clients in a tight loop.
        const obfs4Bin = this._settings.get_string('obfs4-binary');
        const PT = {
            obfs4:        {bin: obfs4Bin, hint: 'sudo apt install obfs4proxy'},
            meek_lite:    {bin: obfs4Bin, hint: 'sudo apt install obfs4proxy'},
            scramblesuit: {bin: obfs4Bin, hint: 'sudo apt install obfs4proxy'},
        };

        const ctp = [];
        for (const t of transports) {
            const entry = PT[t];
            if (!entry) {
                Main.notify('Tor', `Bridge transport '${t}' is not supported — drop those lines or add a ClientTransportPlugin for it`);
                throw new Error(`unsupported transport ${t}`);
            }
            if (!Gio.File.new_for_path(entry.bin).query_exists(null)) {
                Main.notify('Tor', `${t} helper not found at ${entry.bin} — install it (${entry.hint})`);
                throw new Error(`${t} binary missing at ${entry.bin}`);
            }
            ctp.push(`${t} exec ${entry.bin}`);
        }

        await this._controller.setConf({
            UseBridges: '1',
            ClientTransportPlugin: ctp,
            Bridge: lines,
        });
    }

    async _applyCurrentCountry() {
        if (!this._controller?.isReady) return;
        const code = (this._settings.get_string('default-exit-country') || '').toLowerCase();
        try {
            if (code)
                await this._controller.setConf({ExitNodes: `{${code}}`, StrictNodes: '1'});
            else
                await this._controller.resetConf(['ExitNodes', 'StrictNodes']);
        } catch (e) {
            console.warn(`[tor-ext] setConf ExitNodes failed: ${e.message}`);
            Main.notify('Tor', `Could not set exit country: ${e.message}`);
        }
    }

    async _onCountrySelected(code) {
        this._settings.set_string('default-exit-country', code || '');
        this._refreshCountryChecks();
        if (this.checked && this._controller?.isReady) {
            await this._applyCurrentCountry();
            // Force fresh circuit so subsequent traffic uses the new exit
            try { await this._controller.signal('NEWNYM'); } catch (_) {}
            this._setSubtitle(this._statusSubtitle());
            Main.notify('Tor', code
                ? `Exit set to ${countryName(code)}`
                : 'Exit country cleared');
        }
    }

    async _onNewIdentity() {
        if (!this._controller?.isReady) {
            Main.notify('Tor', 'Not connected');
            return;
        }
        try {
            await this._controller.signal('NEWNYM');
            await this._controller.signal('CLEARDNSCACHE');
            Main.notify('Tor', 'New identity — circuits rebuilt');
        } catch (e) {
            Main.notify('Tor', `New Identity failed: ${e.message}`);
        }
    }

    _onServiceState(state) {
        if (this._busy) return;
        if (state === 'inactive' && this.checked) {
            this.checked = false;
            this.gicon = this._torIcon;
            this._setSubtitle('Off');
            this._detachController();
        } else if (state === 'active' && !this.checked) {
            this.checked = true;
            this.gicon = this._torIcon;
            this._setSubtitle(this._statusSubtitle());
        }
    }

    destroy() {
        if (this._clickedId) { this.disconnect(this._clickedId); this._clickedId = 0; }
        if (this._activeChangedId) {
            this._service.disconnect(this._activeChangedId);
            this._activeChangedId = 0;
        }
        this._detachController();
        this._service?.destroy();
        this._tun2socks?.destroy();
        super.destroy();
    }
});

export const TorIndicator = GObject.registerClass(
class TorIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();
        this._topIcon = this._addIndicator();
        this._topIcon.gicon = _loadTorIcon(extension.path);
        this._topIcon.visible = false;

        this._toggle = new TorToggle(extension);
        this.quickSettingsItems.push(this._toggle);

        // Phase 11: top-bar icon tracks the toggle's checked state.
        this._syncIndicator();
        this._checkedSigId = this._toggle.connect('notify::checked',
            () => this._syncIndicator());
    }

    _syncIndicator() {
        this._topIcon.visible = this._toggle.checked;
    }

    destroy() {
        if (this._checkedSigId) {
            try { this._toggle.disconnect(this._checkedSigId); } catch (_) {}
            this._checkedSigId = 0;
        }
        this.quickSettingsItems.forEach(i => i.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
