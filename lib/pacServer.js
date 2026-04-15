// pacServer.js — minimal HTTP server that serves a proxy.pac pointing at our
// Tor SOCKS endpoint. Lets us use `org.gnome.system.proxy.mode=auto` with an
// autoconfig URL, which Chrome honors (it does not reliably honor a direct
// socks gsettings entry).
//
// Listens on 127.0.0.1 only — not exposed beyond the host.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';

const LOG_PREFIX = '[tor-ext/pac]';

function renderPac(socksHost, socksPort) {
    return `function FindProxyForURL(url, host) {
    if (host === "localhost" || host === "127.0.0.1" ||
        shExpMatch(host, "*.local") ||
        isInNet(host, "127.0.0.0", "255.0.0.0") ||
        isInNet(host, "10.0.0.0",  "255.0.0.0") ||
        isInNet(host, "172.16.0.0", "255.240.0.0") ||
        isInNet(host, "192.168.0.0","255.255.0.0") ||
        isInNet(host, "169.254.0.0","255.255.0.0") ||
        isPlainHostName(host))
        return "DIRECT";
    return "SOCKS5 ${socksHost}:${socksPort}; SOCKS ${socksHost}:${socksPort}; DIRECT";
}
`;
}

export const PacServer = GObject.registerClass(
class PacServer extends GObject.Object {
    _init() {
        super._init();
        this._server = null;
        this._port = 0;
        this._socksHost = '127.0.0.1';
        this._socksPort = 9150;
    }

    get isRunning() { return this._server !== null; }
    get port() { return this._port; }
    get pacUrl() { return `http://127.0.0.1:${this._port}/proxy.pac`; }

    start(port, socksHost, socksPort) {
        if (this._server) return;
        this._port = port;
        this._socksHost = socksHost;
        this._socksPort = socksPort;

        const server = new Soup.Server({server_header: 'tor-ext-pac'});
        server.add_handler(null, (_srv, msg) => this._handle(msg));

        if (!server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY)) {
            throw new Error(`PAC server failed to bind 127.0.0.1:${port}`);
        }

        this._server = server;
        console.log(`${LOG_PREFIX} listening on http://127.0.0.1:${port}/proxy.pac → SOCKS5 ${socksHost}:${socksPort}`);
    }

    updateSocks(socksHost, socksPort) {
        this._socksHost = socksHost;
        this._socksPort = socksPort;
    }

    stop() {
        if (!this._server) return;
        try { this._server.disconnect(); } catch (_) {}
        this._server = null;
        console.log(`${LOG_PREFIX} stopped`);
    }

    _handle(msg) {
        const pac = renderPac(this._socksHost, this._socksPort);
        const bytes = new TextEncoder().encode(pac);
        msg.set_response('application/x-ns-proxy-autoconfig',
                         Soup.MemoryUse.COPY, bytes);
        const hdrs = msg.get_response_headers();
        hdrs.replace('Cache-Control', 'no-store');
        hdrs.replace('Access-Control-Allow-Origin', '*');
        msg.set_status(200, null);
    }
});
