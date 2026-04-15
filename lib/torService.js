// torService.js — manage tor.service / tor@default.service via systemd1 DBus.
//
// Uses the system bus. Privileged verbs (Start/Stop/Reload) are gated by
// polkit; our /etc/polkit-1/rules.d/50-tor-ext.rules grants AUTH_ADMIN_KEEP
// to active local users for these units, so the password is cached per session.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BUS_NAME = 'org.freedesktop.systemd1';
const MGR_PATH = '/org/freedesktop/systemd1';
const MGR_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

// User-level service managed by systemd --user — no sudo, no polkit.
// Installed by scripts/install-user-tor.sh.
const DEFAULT_UNIT = 'tor-ext.service';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

export const TorService = GObject.registerClass({
    Signals: {
        'active-changed': {param_types: [GObject.TYPE_STRING]},   // "active" | "inactive" | "activating" | ...
    },
}, class TorService extends GObject.Object {
    _init(params = {}) {
        super._init();
        this._unit = params.unit ?? DEFAULT_UNIT;
        this._bus = Gio.DBus.system;
        this._cancellable = new Gio.Cancellable();

        // Subscribe to PropertiesChanged of the unit once we know its object path.
        this._unitPath = null;
        this._propsSubId = 0;
    }

    get unit() { return this._unit; }

    async _call(obj, iface, method, params, sig, flags = Gio.DBusCallFlags.NONE) {
        return await this._bus.call(
            BUS_NAME, obj, iface, method, params, sig,
            flags, -1, this._cancellable);
    }

    async _getUnitPath() {
        if (this._unitPath) return this._unitPath;
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [this._unit]),
            new GLib.VariantType('(o)'));
        const [path] = ret.deep_unpack();
        this._unitPath = path;
        this._subscribeProps();
        return path;
    }

    _subscribeProps() {
        if (this._propsSubId || !this._unitPath) return;
        this._propsSubId = this._bus.signal_subscribe(
            BUS_NAME, PROPS_IFACE, 'PropertiesChanged',
            this._unitPath, UNIT_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _sig, params) => {
                const [ , changed ] = params.deep_unpack();
                if (changed && 'ActiveState' in changed) {
                    const state = changed['ActiveState'].deep_unpack();
                    this.emit('active-changed', state);
                }
            });
    }

    async getActiveState() {
        const path = await this._getUnitPath();
        const ret = await this._call(
            path, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [UNIT_IFACE, 'ActiveState']),
            new GLib.VariantType('(v)'));
        const [variant] = ret.deep_unpack();
        return variant.deep_unpack();
    }

    async isActive() {
        try {
            return (await this.getActiveState()) === 'active';
        } catch (_) {
            return false;
        }
    }

    async start()   { return this._jobCall('StartUnit'); }
    async stop()    { return this._jobCall('StopUnit'); }
    async reload()  { return this._jobCall('ReloadUnit'); }
    async restart() { return this._jobCall('RestartUnit'); }

    async _jobCall(method) {
        // Manager methods expect (ss) → unit name + mode; return (o) job path.
        // User-level units don't require polkit authorization.
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, method,
            new GLib.Variant('(ss)', [this._unit, 'replace']),
            new GLib.VariantType('(o)'));
        const [jobPath] = ret.deep_unpack();
        return jobPath;
    }

    /**
     * Poll getActiveState() until it matches `want` or timeoutMs elapses.
     * Resolves with the final state.
     */
    async waitForState(want, timeoutMs = 15000) {
        const deadline = GLib.get_monotonic_time() / 1000 + timeoutMs;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const s = await this.getActiveState();
            if (s === want) return s;
            if (GLib.get_monotonic_time() / 1000 > deadline)
                throw new Error(`timeout waiting for ${this._unit} to become ${want} (last: ${s})`);
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { r(); return GLib.SOURCE_REMOVE; }));
        }
    }

    destroy() {
        try { this._cancellable.cancel(); } catch (_) {}
        if (this._propsSubId) {
            try { this._bus.signal_unsubscribe(this._propsSubId); } catch (_) {}
            this._propsSubId = 0;
        }
    }
});
