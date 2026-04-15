// proxyManager.js — flip GNOME's system SOCKS proxy between Tor and the
// user's prior setting.
//
// All writes go through Gio.Settings on org.gnome.system.proxy schemas, so
// they respect any existing mandatory overrides and propagate to apps that
// honour the desktop proxy (GLib's networking, most Electron apps, curl with
// `--proxy-env`, etc.).

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {PacServer} from './pacServer.js';

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
        this._pac = new PacServer();
    }

    get isTorMode() {
        const mode = this._proxy.get_string('mode');
        const url = this._proxy.get_string('autoconfig-url');
        return mode === 'auto' && url.startsWith('http://127.0.0.1:');
    }

    enableSocks() {
        const socksPort = this._ext.get_int('socks-port');
        const pacPort   = this._ext.get_int('pac-port');

        // Persist prior state once (don't overwrite with our own config).
        if (!this.isTorMode) {
            this._ext.set_string('saved-proxy-mode',   this._proxy.get_string('mode'));
            this._ext.set_string('saved-autoconfig-url', this._proxy.get_string('autoconfig-url'));
        }

        // Start the PAC server first — if bind fails we don't want to have
        // already rewritten gsettings.
        this._pac.start(pacPort, '127.0.0.1', socksPort);

        // Flip GNOME proxy into auto mode with our PAC URL. Chrome honors
        // this even though it ignores a direct `mode=manual + socks=...`.
        this._proxy.set_string('autoconfig-url', this._pac.pacUrl);
        this._proxy.set_string('mode', 'auto');
    }

    revert() {
        const savedMode = this._ext.get_string('saved-proxy-mode');
        const savedUrl  = this._ext.get_string('saved-autoconfig-url');

        this._proxy.set_string('autoconfig-url', savedUrl);
        this._proxy.set_string('mode', savedMode || 'none');

        this._ext.set_string('saved-proxy-mode', '');
        this._ext.set_string('saved-autoconfig-url', '');

        this._pac.stop();
    }

    destroy() {
        try { this._pac.stop(); } catch (_) {}
    }
});
