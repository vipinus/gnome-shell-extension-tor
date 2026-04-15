// prefs.js — full preferences window (phase 12 polish).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
// GS48+ moved the prefs resource bundle to a new path.
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {COUNTRIES} from './lib/countries.js';

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

        const proxyGroup = new Adw.PreferencesGroup({title: 'Desktop proxy'});
        general.add(proxyGroup);
        proxyGroup.add(this._switchRow(settings, 'manage-system-proxy',
            'Manage GNOME system proxy',
            'Switch GSettings SOCKS proxy to 127.0.0.1 when Tor is on, revert when off.'));

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
            title: 'obfs4 bridges',
            description: 'Use when your network blocks direct Tor access. Install obfs4proxy (sudo apt install obfs4proxy).',
        });
        bridges.add(toggleGroup);
        toggleGroup.add(this._switchRow(settings, 'use-bridges',
            'Enable bridges',
            'Routes your Tor connection through a bridge relay. Requires at least one bridge line below.'));
        toggleGroup.add(this._entryRow(settings, 'obfs4-binary', 'obfs4proxy binary'));

        const linesGroup = new Adw.PreferencesGroup({
            title: 'Bridge lines',
            description: 'One per line, e.g.: obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0',
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

        const btnRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, halign: Gtk.Align.END,
        });
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
        });

        settings.connect('changed::bridge-lines', loadIntoBuffer);
        return row;
    }
}
