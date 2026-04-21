// prefs.js — full preferences window (phase 12 polish).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup';
// GS48+ moved the prefs resource bundle to a new path.
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COUNTRIES} from './lib/countries.js';

// Public bridges JSON refreshed daily by our own GH Action (see
// .github/workflows/bridges-refresh.yml + bridges/README.md).
const PUBLIC_BRIDGES_URL =
    'https://raw.githubusercontent.com/vipinus/gnome-shell-extension-tor/main/bridges/latest.json';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export default class TorExtPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);

        // ─── General ───────────────────────────────────────────────
        const general = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(general);

        const portGroup = new Adw.PreferencesGroup({title: 'Tor ports'});
        general.add(portGroup);
        portGroup.add(this._spinRow(settings, 'control-port', 'ControlPort', 1, 65535));
        portGroup.add(this._spinRow(settings, 'socks-port',   'SocksPort',   1, 65535));

        const authGroup = new Adw.PreferencesGroup({
            title: 'Authentication',
            description: 'Cookie auth is used by default. Leave password empty unless your torrc uses HashedControlPassword.',
        });
        general.add(authGroup);
        authGroup.add(this._entryRow(settings, 'cookie-path', 'Cookie path'));
        authGroup.add(this._passwordRow(settings, 'control-password', 'Control password'));

        const tunGroup = new Adw.PreferencesGroup({
            title: 'Transparent proxy (tun2socks)',
            description: 'Route ALL TCP traffic through Tor. Requires one-time setup: sudo bash scripts/install-tor-tun2socks.sh.',
        });
        general.add(tunGroup);
        tunGroup.add(this._switchRow(settings, 'use-tun2socks',
            'Route all traffic through Tor',
            'Toggle Tor off and on for this to take effect.'));

        const exitGroup = new Adw.PreferencesGroup({
            title: 'Default exit country',
            description: 'Applied to ExitNodes with StrictNodes=1 when Tor starts.',
        });
        general.add(exitGroup);
        exitGroup.add(this._countryRow(settings));

        // ─── Bridges ───────────────────────────────────────────────
        const bridges = new Adw.PreferencesPage({
            title: 'Bridges',
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(bridges);

        const toggleGroup = new Adw.PreferencesGroup({
            title: 'Pluggable-transport bridges',
            description: 'Use when your network blocks direct Tor access. Supported transports: obfs4, meek_lite, scramblesuit (all via obfs4proxy), and snowflake.',
        });
        bridges.add(toggleGroup);
        toggleGroup.add(this._switchRow(settings, 'use-bridges',
            'Enable bridges',
            'Routes your Tor connection through a bridge relay. Requires at least one bridge line below.'));
        toggleGroup.add(this._entryRow(settings, 'obfs4-binary',     'obfs4proxy binary (obfs4 / meek_lite / scramblesuit)'));
        toggleGroup.add(this._entryRow(settings, 'snowflake-binary', 'snowflake-client binary'));
        toggleGroup.add(this._entryRow(settings, 'webtunnel-binary', 'webtunnel-client binary'));

        const linesGroup = new Adw.PreferencesGroup({
            title: 'Bridge lines',
            description: 'One per line. First token = transport (obfs4 / snowflake / webtunnel / meek_lite / scramblesuit).',
        });
        bridges.add(linesGroup);
        linesGroup.add(this._bridgesTextRow(settings));
    }

    // ─── helpers ───────────────────────────────────────────────────

    _spinRow(settings, key, title, min, max) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 100}),
        });
        settings.bind(key, row, 'value', 0);
        return row;
    }

    _switchRow(settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', 0);
        return row;
    }

    _entryRow(settings, key, title) {
        const row = new Adw.EntryRow({title});
        settings.bind(key, row, 'text', 0);
        return row;
    }

    _passwordRow(settings, key, title) {
        const row = new Adw.PasswordEntryRow({title});
        settings.bind(key, row, 'text', 0);
        return row;
    }

    _countryRow(settings) {
        const model = new Gtk.StringList();
        for (const c of COUNTRIES) model.append(c.name);

        const row = new Adw.ComboRow({
            title: 'Exit country',
            model,
        });

        const setFromSetting = () => {
            const code = (settings.get_string('default-exit-country') || '').toLowerCase();
            const idx = COUNTRIES.findIndex(c => c.code === code);
            row.selected = idx >= 0 ? idx : 0;
        };
        setFromSetting();

        row.connect('notify::selected', () => {
            const c = COUNTRIES[row.selected];
            if (c) settings.set_string('default-exit-country', c.code);
        });
        settings.connect('changed::default-exit-country', setFromSetting);

        return row;
    }

    _bridgesTextRow(settings) {
        // Multi-line text backed by the 'as' gsettings key. Flushes on focus-out.
        const row = new Adw.PreferencesRow({activatable: false});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
            spacing: 6,
        });
        const scrolled = new Gtk.ScrolledWindow({
            min_content_height: 180,
            has_frame: true,
            hexpand: true, vexpand: true,
        });
        const view = new Gtk.TextView({
            monospace: true,
            top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6,
            wrap_mode: Gtk.WrapMode.NONE,
        });
        scrolled.set_child(view);
        box.append(scrolled);

        // Status line sits left, buttons right.
        const btnRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 6,
        });
        const statusLabel = new Gtk.Label({
            xalign: 0, hexpand: true, wrap: true,
            label: '',
        });
        statusLabel.add_css_class('dim-label');
        btnRow.append(statusLabel);

        const fetchBtn = new Gtk.Button({label: 'Fetch public bridges'});
        fetchBtn.set_tooltip_text(
            'Download the latest obfs4 / snowflake / webtunnel bridges from ' +
            'the Tor Project Moat API mirror (see bridges/README.md for source).');
        btnRow.append(fetchBtn);

        const saveBtn = new Gtk.Button({label: 'Save bridges'});
        saveBtn.add_css_class('suggested-action');
        btnRow.append(saveBtn);
        box.append(btnRow);

        row.set_child(box);

        const loadIntoBuffer = () => {
            const lines = settings.get_strv('bridge-lines');
            view.buffer.text = lines.join('\n');
        };
        loadIntoBuffer();

        saveBtn.connect('clicked', () => {
            const buf = view.buffer;
            const text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), false);
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            settings.set_strv('bridge-lines', lines);
            statusLabel.label = `Saved ${lines.length} bridge line(s).`;
        });

        fetchBtn.connect('clicked', () => {
            this._runFetch(settings, view, statusLabel, fetchBtn);
        });

        settings.connect('changed::bridge-lines', loadIntoBuffer);
        return row;
    }

    async _runFetch(settings, view, statusLabel, fetchBtn) {
        fetchBtn.sensitive = false;
        statusLabel.label = 'Fetching…';
        try {
            const doc = await this._fetchPublicBridges();
            const buckets = doc.bridges || {};
            // Prefer TCP-friendly transports first, snowflake as fallback
            // (WebRTC is chatty and startup-slow but works where the rest
            // are blocked).
            const ordered = ['obfs4', 'webtunnel', 'snowflake'];
            const seen = new Set(ordered);
            for (const k of Object.keys(buckets)) if (!seen.has(k)) ordered.push(k);

            const lines = [];
            const counts = [];
            for (const t of ordered) {
                const arr = buckets[t] || [];
                if (!arr.length) continue;
                for (const l of arr) lines.push(l);
                counts.push(`${arr.length} ${t}`);
            }
            if (!lines.length) throw new Error('upstream returned zero bridges');

            settings.set_strv('bridge-lines', lines);
            view.buffer.text = lines.join('\n');
            statusLabel.label = `Fetched ${counts.join(', ')} · ${doc.fetched_at || 'unknown time'}`;
        } catch (e) {
            statusLabel.label = `Fetch failed: ${e.message}`;
            console.warn(`[tor-ext/prefs] fetch public bridges failed: ${e.message}`);
        } finally {
            fetchBtn.sensitive = true;
        }
    }

    async _fetchPublicBridges() {
        const session = new Soup.Session({
            user_agent: 'tor-ext-prefs/1.0 (+https://github.com/vipinus/gnome-shell-extension-tor)',
            timeout: 30,
        });
        const msg = Soup.Message.new('GET', PUBLIC_BRIDGES_URL);
        const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        const status = msg.get_status();
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status} from ${PUBLIC_BRIDGES_URL}`);
        const text = new TextDecoder().decode(bytes.get_data());
        const doc = JSON.parse(text);
        if (!doc || typeof doc !== 'object' || !doc.bridges)
            throw new Error('payload missing .bridges');
        return doc;
    }
}
