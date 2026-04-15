#!/usr/bin/env -S gjs -m
// Smoke test for torService.js — read-only, no polkit prompt.

import GLib from 'gi://GLib';
import {TorService} from '../lib/torService.js';

const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

async function run() {
    const svc = new TorService();
    console.log('[test] unit =', svc.unit);
    try {
        const state = await svc.getActiveState();
        console.log('[test] ActiveState =', state);
    } catch (e) {
        console.log('[test] getActiveState FAIL:', e.message);
        exitCode = 1;
    }
    try {
        const ok = await svc.isActive();
        console.log('[test] isActive =', ok);
    } catch (e) {
        console.log('[test] isActive FAIL:', e.message);
        exitCode = 1;
    }
    svc.destroy();
}

run().finally(() => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
});
loop.run();
imports.system.exit(exitCode);
