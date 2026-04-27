// torService.js — manage the distro tor unit via systemd1 DBus.
//
// v0.6.0 design: there is exactly ONE tor process on the box — the distro's
// own tor.service (or tor@default.service on Debian's multi-instance template).
// We detect which name exists at first call, then drive it via the SYSTEM bus.
// The bundled polkit rule (50-tor-ext.rules) turns start/stop/reload into
// passwordless YES for active local users, so the UX stays one-click.
//
// We no longer ship a per-user tor-ext.service or a system tor-ext.service:
// running a second tor wastes a circuit, two guards, and a directory cache for
// no benefit, and made the codebase carry two parallel auth/cookie paths.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BUS_NAME = 'org.freedesktop.systemd1';
const MGR_PATH = '/org/freedesktop/systemd1';
const MGR_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

// Distro convention varies. Probe in order; first hit wins. Extension reads
// `/run/tor/control.authcookie` regardless — both unit names share that path.
const CANDIDATE_UNITS = ['tor@default.service', 'tor.service'];

Gio._promisify(Gio.DBusConnection.prototype, 'call');

export const TorService = GObject.registerClass({
    Signals: {
        'active-changed': {param_types: [GObject.TYPE_STRING]},   // "active" | "inactive" | "activating" | ...
    },
}, class TorService extends GObject.Object {
    _init(params = {}) {
        super._init();
        this._unit = params.unit ?? null;     // resolved on first DBus call
        this._bus = Gio.DBus.system;
        this._callFlags = Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION;
        this._cancellable = new Gio.Cancellable();

        this._unitPath = null;
        this._propsSubId = 0;
    }

    get unit() { return this._unit ?? CANDIDATE_UNITS[0]; }

    async _call(obj, iface, method, params, sig, flags = this._callFlags) {
        return await this._bus.call(
            BUS_NAME, obj, iface, method, params, sig,
            flags, -1, this._cancellable);
    }

    /**
     * Probe each candidate unit name; return the first one that loads. Falls
     * back to CANDIDATE_UNITS[0] so callers always get *some* unit to operate
     * on, even if both probes failed (e.g. tor not installed yet).
     */
    async _resolveUnit() {
        if (this._unit) return this._unit;
        for (const name of CANDIDATE_UNITS) {
            try {
                const ret = await this._call(
                    MGR_PATH, MGR_IFACE, 'GetUnitFileState',
                    new GLib.Variant('(s)', [name]),
                    new GLib.VariantType('(s)'));
                const [state] = ret.deep_unpack();
                if (state && state !== 'not-found') {
                    this._unit = name;
                    return name;
                }
            } catch (_) { /* try next */ }
        }
        this._unit = CANDIDATE_UNITS[0];
        return this._unit;
    }

    async _getUnitPath() {
        if (this._unitPath) return this._unitPath;
        const unit = await this._resolveUnit();
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [unit]),
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
        const unit = await this._resolveUnit();
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, method,
            new GLib.Variant('(ss)', [unit, 'replace']),
            new GLib.VariantType('(o)'));
        const [jobPath] = ret.deep_unpack();
        return jobPath;
    }

    /**
     * Poll getActiveState() until it matches `want` or timeoutMs elapses.
     */
    async waitForState(want, timeoutMs = 15000) {
        const deadline = GLib.get_monotonic_time() / 1000 + timeoutMs;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const s = await this.getActiveState();
            if (s === want) return s;
            if (GLib.get_monotonic_time() / 1000 > deadline)
                throw new Error(`timeout waiting for ${this.unit} to become ${want} (last: ${s})`);
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
