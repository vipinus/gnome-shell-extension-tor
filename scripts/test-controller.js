#!/usr/bin/env -S gjs -m
// End-to-end smoke test for torController.js against the live tor ControlPort.
// Run:  gjs -m scripts/test-controller.js
// Exits non-zero on any failure so CI-style use is possible.

import GLib from 'gi://GLib';
import {TorController} from '../lib/torController.js';

const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

function log(...a)   { console.log('[test]', ...a); }
function fail(msg, e) {
    console.error('[test] FAIL:', msg, e?.message ?? e ?? '');
    exitCode = 1;
}

async function run() {
    const ctrl = new TorController({port: 9051});

    ctrl.connect('state-changed', (_o, s) => log('state:', s));
    ctrl.connect('bootstrap', (_o, p, t, s) => log(`bootstrap: ${p}% tag=${t}`));
    ctrl.connect('circuit-event', (_o, e) => log('circ:', e.slice(0, 120)));
    ctrl.connect('disconnected', () => log('disconnected'));

    try {
        await ctrl.connectAndAuth();
        log('auth ok. state =', ctrl.state);
    } catch (e) {
        fail('connectAndAuth', e);
        return;
    }

    try {
        const r = await ctrl.getInfo('version');
        log('version:', r.body);
    } catch (e) { fail('GETINFO version', e); }

    try {
        const r = await ctrl.getInfo('status/bootstrap-phase');
        log('bootstrap-phase:', r.body);
    } catch (e) { fail('GETINFO bootstrap-phase', e); }

    try {
        const r = await ctrl.getInfo('circuit-status');
        const circs = r.body.split('\n').filter(l => l);
        log(`circuits: ${circs.length}`);
        for (const c of circs.slice(0, 3)) log('  ', c.slice(0, 160));
    } catch (e) { fail('GETINFO circuit-status', e); }

    try {
        await ctrl.setEvents(['STATUS_CLIENT', 'CIRC']);
        log('SETEVENTS ok');
    } catch (e) { fail('SETEVENTS', e); }

    // Let events flow for a second
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { r(); return GLib.SOURCE_REMOVE; }));

    try {
        await ctrl.signal('NEWNYM');
        log('NEWNYM signal sent');
    } catch (e) { fail('SIGNAL NEWNYM', e); }

    try {
        await ctrl.quit();
        log('QUIT ok');
    } catch (e) { fail('QUIT', e); }
}

run().catch(e => fail('unhandled', e)).finally(() => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
});

loop.run();
imports.system.exit(exitCode);
