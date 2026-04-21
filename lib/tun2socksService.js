// tun2socksService.js — start/stop tor-ext-tun2socks.service via systemd1.
//
// Always system bus — the unit has to run as _tor-ext with ambient caps to
// create the TUN + tweak routes, and that's only something a system-scope
// service can do. Our installed polkit rule turns the start/stop verbs into
// a passwordless YES for active local users.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BUS_NAME = 'org.freedesktop.systemd1';
const MGR_PATH = '/org/freedesktop/systemd1';
const MGR_IFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const UNIT = 'tor-ext-tun2socks.service';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

export const Tun2SocksService = GObject.registerClass({
    Signals: {
        'active-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class Tun2SocksService extends GObject.Object {
    _init() {
        super._init();
        this._bus = Gio.DBus.system;
        this._cancellable = new Gio.Cancellable();
        this._unitPath = null;
        this._propsSubId = 0;
    }

    get unit() { return UNIT; }

    async _call(obj, iface, method, params, sig,
                flags = Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION) {
        return await this._bus.call(
            BUS_NAME, obj, iface, method, params, sig,
            flags, -1, this._cancellable);
    }

    async _getUnitPath() {
        if (this._unitPath) return this._unitPath;
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, 'LoadUnit',
            new GLib.Variant('(s)', [UNIT]),
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
                    this.emit('active-changed', changed['ActiveState'].deep_unpack());
                }
            });
    }

    /** True iff the .service unit exists on this system (installer has run). */
    async isInstalled() {
        try {
            const ret = await this._call(
                MGR_PATH, MGR_IFACE, 'GetUnitFileState',
                new GLib.Variant('(s)', [UNIT]),
                new GLib.VariantType('(s)'));
            const [state] = ret.deep_unpack();
            return state && state !== 'not-found';
        } catch (_) {
            return false;
        }
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
        try { return (await this.getActiveState()) === 'active'; }
        catch (_) { return false; }
    }

    async start()   { return this._jobCall('StartUnit'); }
    async stop()    { return this._jobCall('StopUnit'); }
    async restart() { return this._jobCall('RestartUnit'); }

    async _jobCall(method) {
        const ret = await this._call(
            MGR_PATH, MGR_IFACE, method,
            new GLib.Variant('(ss)', [UNIT, 'replace']),
            new GLib.VariantType('(o)'));
        const [jobPath] = ret.deep_unpack();
        return jobPath;
    }

    async waitForState(want, timeoutMs = 15000) {
        const deadline = GLib.get_monotonic_time() / 1000 + timeoutMs;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const s = await this.getActiveState();
            if (s === want) return s;
            if (GLib.get_monotonic_time() / 1000 > deadline)
                throw new Error(`timeout waiting for ${UNIT} to become ${want} (last: ${s})`);
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300,
                () => { r(); return GLib.SOURCE_REMOVE; }));
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
