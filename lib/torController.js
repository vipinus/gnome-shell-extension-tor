// torController.js — async ControlPort client for tor.
//
// Protocol reference: https://spec.torproject.org/control-spec/
//
// Single in-flight command model. Async events (6xx codes) arrive at any time
// and are routed to GObject signals regardless of command queue state.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {parseCircuitLine} from './circuitParser.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const LOG_PREFIX = '[tor-ext/controller]';

export const ControllerState = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    AUTHENTICATING: 'authenticating',
    READY:        'ready',
    ERROR:        'error',
});

export const TorController = GObject.registerClass({
    Signals: {
        'state-changed':  {param_types: [GObject.TYPE_STRING]},
        'bootstrap':      {param_types: [GObject.TYPE_INT, GObject.TYPE_STRING, GObject.TYPE_STRING]}, // progress, tag, summary
        'status-event':   {param_types: [GObject.TYPE_STRING]},   // raw STATUS_CLIENT payload
        'circuit-event':  {param_types: [GObject.TYPE_STRING]},   // raw CIRC payload
        'disconnected':   {},
    },
}, class TorController extends GObject.Object {
    _init(params = {}) {
        super._init();
        this._host = params.host ?? '127.0.0.1';
        this._port = params.port ?? 9051;
        this._cookiePath = params.cookiePath ?? '/run/tor/control.authcookie';
        this._password = params.password ?? '';

        this._conn = null;
        this._input = null;
        this._output = null;
        this._cancellable = null;

        this._queue = [];          // [{cmd, resolve, reject, lines}]
        this._current = null;
        this._writing = false;
        this._inDataBlock = false;
        this._state = ControllerState.DISCONNECTED;
    }

    get state() { return this._state; }
    get isReady() { return this._state === ControllerState.READY; }

    _setState(s) {
        if (s === this._state) return;
        this._state = s;
        this.emit('state-changed', s);
    }

    async connectAndAuth() {
        if (this._state === ControllerState.READY) return;
        if (this._state === ControllerState.CONNECTING ||
            this._state === ControllerState.AUTHENTICATING) {
            throw new Error('already connecting');
        }

        this._setState(ControllerState.CONNECTING);
        this._cancellable = new Gio.Cancellable();

        const client = new Gio.SocketClient();
        try {
            this._conn = await client.connect_to_host_async(
                `${this._host}:${this._port}`, this._port, this._cancellable);
        } catch (e) {
            this._setState(ControllerState.ERROR);
            throw new Error(`connect failed: ${e.message}`);
        }

        this._input = new Gio.DataInputStream({
            base_stream: this._conn.get_input_stream(),
            newline_type: Gio.DataStreamNewlineType.CR_LF,
        });
        this._output = this._conn.get_output_stream();

        this._setState(ControllerState.AUTHENTICATING);
        this._readLoop();

        try {
            await this._authenticate();
        } catch (e) {
            this._setState(ControllerState.ERROR);
            this._close();
            throw e;
        }

        this._setState(ControllerState.READY);
    }

    async _authenticate() {
        // Try cookie first
        if (this._cookiePath) {
            const hex = this._readCookieHex();
            if (hex) {
                try {
                    await this._send(`AUTHENTICATE ${hex}`);
                    return;
                } catch (e) {
                    console.warn(`${LOG_PREFIX} cookie auth rejected: ${e.message}`);
                }
            }
        }
        // Fallback: password
        if (this._password) {
            await this._send(`AUTHENTICATE "${this._escapeString(this._password)}"`);
            return;
        }
        // Fallback: null auth (works only if CookieAuth=0 and no password)
        await this._send('AUTHENTICATE');
    }

    _readCookieHex() {
        try {
            let path = this._cookiePath;
            if (path.startsWith('~/')) path = GLib.get_home_dir() + path.slice(1);
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);
            if (!ok || !contents || contents.length !== 32) {
                console.warn(`${LOG_PREFIX} cookie missing or wrong size at ${this._cookiePath}`);
                return null;
            }
            let hex = '';
            for (const b of contents) hex += b.toString(16).padStart(2, '0');
            return hex;
        } catch (e) {
            console.warn(`${LOG_PREFIX} cannot read cookie: ${e.message}`);
            return null;
        }
    }

    // ---------- public command API ----------

    async setConf(kv) {
        const parts = [];
        for (const [k, v] of Object.entries(kv)) {
            if (Array.isArray(v)) {
                if (v.length === 0) parts.push(k);
                else for (const item of v) parts.push(`${k}=${this._quote(item)}`);
            } else if (v === null || v === undefined || v === '') {
                parts.push(k);
            } else {
                parts.push(`${k}=${this._quote(v)}`);
            }
        }
        return this._send(`SETCONF ${parts.join(' ')}`);
    }

    async resetConf(keys) {
        return this._send(`RESETCONF ${keys.join(' ')}`);
    }

    async getInfo(key) {
        return this._send(`GETINFO ${key}`);
    }

    async getConf(key) {
        return this._send(`GETCONF ${key}`);
    }

    async signal(sig) {
        return this._send(`SIGNAL ${sig}`);
    }

    async setEvents(events) {
        return this._send(`SETEVENTS ${events.join(' ')}`);
    }

    // ---------- circuit helpers ----------

    /** Parse all circuits from GETINFO circuit-status. */
    async getCircuits() {
        const r = await this.getInfo('circuit-status');
        // body: "circuit-status=\n<line1>\n<line2>..." (or just "circuit-status=" if none)
        return r.body.split('\n')
            .filter(l => l && !l.startsWith('circuit-status=') && l !== 'OK')
            .map(parseCircuitLine)
            .filter(Boolean);
    }

    /** Return the IPv4 address of the relay identified by `fp` (40-hex fingerprint). */
    async getRelayIP(fp) {
        const clean = fp.replace(/^\$/, '').toUpperCase();
        try {
            const r = await this.getInfo(`ns/id/${clean}`);
            for (const l of r.body.split('\n')) {
                if (l.startsWith('r ')) {
                    const parts = l.split(' ');
                    return parts[6] || null;
                }
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    /** Map an IPv4 to a two-letter country code via tor's local GeoIP. */
    async getIPCountry(ip) {
        if (!ip) return '';
        try {
            const r = await this.getInfo(`ip-to-country/${ip}`);
            const m = r.body.match(/ip-to-country\/[\d.]+=([a-z]{2})/i);
            return m ? m[1].toUpperCase() : '';
        } catch (_) { return ''; }
    }

    async quit() {
        try { await this._send('QUIT'); } catch { /* connection drops */ }
        this._close();
    }

    close() { this._close(); }

    // ---------- internals ----------

    _send(cmd) {
        if (!this._output) return Promise.reject(new Error('not connected'));
        return new Promise((resolve, reject) => {
            this._queue.push({cmd, resolve, reject, lines: []});
            this._pump();
        });
    }

    _pump() {
        if (this._writing || this._current || !this._output) return;
        const next = this._queue.shift();
        if (!next) return;
        this._current = next;
        this._writing = true;

        const payload = new TextEncoder().encode(next.cmd + '\r\n');
        const bytes = GLib.Bytes.new(payload);
        this._output.write_bytes_async(
            bytes, GLib.PRIORITY_DEFAULT, this._cancellable)
            .then(() => { this._writing = false; })
            .catch(e => {
                this._writing = false;
                if (this._current) {
                    this._current.reject(new Error(`write failed: ${e.message}`));
                    this._current = null;
                }
                this._onDisconnect();
            });
    }

    _readLoop() {
        if (!this._input) return;
        this._input.read_line_async(
            GLib.PRIORITY_DEFAULT, this._cancellable,
            (src, res) => {
                let line = null;
                try {
                    [line] = src.read_line_finish_utf8(res);
                } catch (e) {
                    if (!(e instanceof GLib.Error &&
                          e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))) {
                        console.warn(`${LOG_PREFIX} read error: ${e.message}`);
                    }
                    this._onDisconnect();
                    return;
                }
                if (line === null) {   // EOF
                    this._onDisconnect();
                    return;
                }
                try {
                    this._handleLine(line);
                } catch (e) {
                    console.warn(`${LOG_PREFIX} handleLine threw: ${e.message}`);
                }
                if (this._input) this._readLoop();
            });
    }

    _handleLine(line) {
        // Inside a 250+ data block, raw lines accumulate onto the previous
        // 250+ line's `.data` field until we see a lone `.` terminator.
        if (this._inDataBlock) {
            if (line === '.') { this._inDataBlock = false; return; }
            if (this._current) {
                const last = this._current.lines[this._current.lines.length - 1];
                if (last) last.data = last.data ? `${last.data}\n${line}` : line;
            }
            return;
        }

        // <NNN><SEP><text>  SEP ∈ { ' ', '-', '+' }
        //   ' ' → terminal line of a reply
        //   '-' → mid-reply continuation
        //   '+' → start of dot-terminated data block
        if (line.length < 4) return;
        const code = parseInt(line.slice(0, 3), 10);
        const sep = line[3];
        const text = line.slice(4);

        if (code >= 600 && code < 700) {
            this._dispatchEvent(text);
            return;
        }

        if (!this._current) return;   // stray reply — drop
        this._current.lines.push({code, sep, text});

        if (sep === '+') {
            this._inDataBlock = true;
            return;
        }
        if (sep === ' ') {
            const cur = this._current;
            this._current = null;
            const resp = {
                code,
                text,
                lines: cur.lines,
                body: cur.lines.map(l => l.data ? `${l.text}\n${l.data}` : l.text).join('\n'),
            };
            if (code >= 200 && code < 300) cur.resolve(resp);
            else cur.reject(Object.assign(new Error(`${code} ${text}`), {response: resp}));
            this._pump();
        }
    }

    _dispatchEvent(text) {
        const spaceIdx = text.indexOf(' ');
        const tag = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
        const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1);

        if (tag === 'STATUS_CLIENT') {
            this.emit('status-event', rest);
            // e.g. "NOTICE BOOTSTRAP PROGRESS=42 TAG=loading_status SUMMARY=\"...\""
            const parts = this._tokenize(rest);
            const bsIdx = parts.indexOf('BOOTSTRAP');
            if (bsIdx !== -1) {
                let progress = 0, btag = '', summary = '';
                for (const p of parts) {
                    if (p.startsWith('PROGRESS=')) progress = parseInt(p.slice(9), 10) || 0;
                    else if (p.startsWith('TAG=')) btag = this._unquote(p.slice(4));
                    else if (p.startsWith('SUMMARY=')) summary = this._unquote(p.slice(8));
                }
                this.emit('bootstrap', progress, btag, summary);
            }
        } else if (tag === 'CIRC') {
            this.emit('circuit-event', rest);
        }
    }

    _onDisconnect() {
        if (this._state === ControllerState.DISCONNECTED) return;
        this._setState(ControllerState.DISCONNECTED);
        if (this._current) {
            this._current.reject(new Error('disconnected'));
            this._current = null;
        }
        for (const q of this._queue) q.reject(new Error('disconnected'));
        this._queue = [];
        this._close();
        this.emit('disconnected');
    }

    _close() {
        try { this._cancellable?.cancel(); } catch (_) {}
        try { this._conn?.close(null); } catch (_) {}
        this._conn = null;
        this._input = null;
        this._output = null;
        this._cancellable = null;
    }

    // ---------- helpers ----------

    _quote(v) {
        const s = String(v);
        if (/^[A-Za-z0-9{},_.=:/*-]+$/.test(s)) return s;
        return `"${this._escapeString(s)}"`;
    }
    _escapeString(s) {
        return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
    _unquote(s) {
        if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
            return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        return s;
    }
    _tokenize(s) {
        // Split on whitespace respecting double-quoted segments.
        const out = [];
        let i = 0, cur = '', inQ = false;
        while (i < s.length) {
            const c = s[i];
            if (inQ) {
                if (c === '\\' && i + 1 < s.length) { cur += c + s[i+1]; i += 2; continue; }
                if (c === '"') { cur += c; inQ = false; i++; continue; }
                cur += c; i++; continue;
            }
            if (c === '"') { inQ = true; cur += c; i++; continue; }
            if (c === ' ' || c === '\t') {
                if (cur) { out.push(cur); cur = ''; }
                i++; continue;
            }
            cur += c; i++;
        }
        if (cur) out.push(cur);
        return out;
    }
});
