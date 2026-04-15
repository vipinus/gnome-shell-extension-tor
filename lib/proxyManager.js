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
            this._ext.set_boolean('saved-use-same-proxy', this._proxy.get_boolean('use-same-proxy'));
            this._ext.set_boolean('saved-use-same-proxy-set', true);
        }
        this._socks.set_string('host', '127.0.0.1');
        this._socks.set_int('port', this._ext.get_int('socks-port'));
        // `use-same-proxy=true` tells GNOME clients to force the HTTP proxy
        // for all protocols. When HTTP is empty, clients like Chrome fall
        // back to direct — effectively ignoring our SOCKS. Disable so each
        // protocol is looked up independently, and SOCKS is used as fallback.
        this._proxy.set_boolean('use-same-proxy', false);
        this._proxy.set_string('mode', 'manual');
    }

    revert() {
        const savedMode = this._ext.get_string('saved-proxy-mode');
        const savedHost = this._ext.get_string('saved-socks-host');
        const savedPort = this._ext.get_int('saved-socks-port');
        const savedUseSameSet = this._ext.get_boolean('saved-use-same-proxy-set');
        const savedUseSame = this._ext.get_boolean('saved-use-same-proxy');

        if (savedHost) this._socks.set_string('host', savedHost);
        if (savedPort) this._socks.set_int('port', savedPort);

        if (savedUseSameSet) this._proxy.set_boolean('use-same-proxy', savedUseSame);

        if (savedMode) {
            this._proxy.set_string('mode', savedMode);
        } else {
            this._proxy.set_string('mode', 'none');
        }

        this._ext.set_string('saved-proxy-mode', '');
        this._ext.set_string('saved-socks-host', '');
        this._ext.set_int('saved-socks-port', 0);
        this._ext.set_boolean('saved-use-same-proxy-set', false);
    }
});
