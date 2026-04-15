#!/usr/bin/env -S gjs -m
// Smoke test for circuit parser + ip-to-country pipeline.

import GLib from 'gi://GLib';
import {TorController} from '../lib/torController.js';
import {pickPrimaryCircuit} from '../lib/circuitParser.js';

const loop = GLib.MainLoop.new(null, false);

async function run() {
    const c = new TorController({port: 9051});
    await c.connectAndAuth();
    const circs = await c.getCircuits();
    console.log(`[test] parsed ${circs.length} circuits`);
    const p = pickPrimaryCircuit(circs);
    if (!p) {
        console.log('[test] no BUILT GENERAL circuit — may need to run traffic first');
    } else {
        console.log(`[test] primary id=${p.id} status=${p.status} purpose=${p.meta.PURPOSE} hops=${p.hops.length}`);
        for (const h of p.hops) {
            const ip = await c.getRelayIP(h.fp);
            const cc = await c.getIPCountry(ip);
            console.log(`  [hop] ${cc.padEnd(2)}  ${(ip ?? '?').padEnd(15)}  ${h.name || h.fp.slice(0, 8)}`);
        }
    }
    await c.quit();
}

run().catch(e => console.log('[fail]', e.message))
     .finally(() => {
         GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
     });
loop.run();
