// proxyManager.js — flip GNOME's system SOCKS proxy between Tor and the
// user's prior setting.
//
// All writes go through Gio.Settings on org.gnome.system.proxy schemas, so
// they respect any existing mandatory overrides and propagate to apps that
// honour the desktop proxy (GLib's networking, most Electron apps, curl with
// `--proxy-env`, etc.).

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const SCHEMA_PROXY = 'org.gnome.system.proxy';
const SCHEMA_SOCKS = 'org.gnome.system.proxy.socks';

export const ProxyManager = GObject.registerClass({
}, class ProxyManager extends GObject.Object {
    /**
     * @param {Gio.Settings} extSettings  Our extension's own settings (for saved-* keys)
     */
    _init(extSettings) {
        super._init();
        this._ext = extSettings;
        this._proxy = new Gio.Settings({schema_id: SCHEMA_PROXY});
        this._socks = new Gio.Settings({schema_id: SCHEMA_SOCKS});
    }

    get isTorMode() {
        return this._proxy.get_string('mode') === 'manual'
            && this._socks.get_string('host') === '127.0.0.1'
            && this._socks.get_int('port') === this._ext.get_int('socks-port');
    }

    enableSocks() {
        // Persist prior state only if we are not already in Tor mode — avoids
        // saving our own config on top of itself when called twice.
        if (!this.isTorMode) {
            this._ext.set_string('saved-proxy-mode', this._proxy.get_string('mode'));
            this._ext.set_string('saved-socks-host', this._socks.get_string('host'));
            this._ext.set_int('saved-socks-port', this._socks.get_int('port'));
        }
        this._socks.set_string('host', '127.0.0.1');
        this._socks.set_int('port', this._ext.get_int('socks-port'));
        this._proxy.set_string('mode', 'manual');
    }

    revert() {
        const savedMode = this._ext.get_string('saved-proxy-mode');
        const savedHost = this._ext.get_string('saved-socks-host');
        const savedPort = this._ext.get_int('saved-socks-port');

        // Restore socks host/port first so if mode=manual remains active the
        // user's prior socks target is already in place.
        if (savedHost) this._socks.set_string('host', savedHost);
        if (savedPort) this._socks.set_int('port', savedPort);

        if (savedMode) {
            this._proxy.set_string('mode', savedMode);
        } else {
            // First-ever run: default to none rather than leaving manual.
            this._proxy.set_string('mode', 'none');
        }

        // Clear the saved slots so a subsequent enable() re-captures fresh state.
        this._ext.set_string('saved-proxy-mode', '');
        this._ext.set_string('saved-socks-host', '');
        this._ext.set_int('saved-socks-port', 0);
    }
});
