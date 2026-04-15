// circuitParser.js — parse tor ControlPort circuit lines.
//
// Line format (from circuit-status or CIRC events):
//   "<id> <status> <path> [BUILD_FLAGS=..] [PURPOSE=..] [TIME_CREATED=..] ..."
// path is comma-joined "$FP=Name" / "$FP~Name" / "$FP" entries.

const HOP_RE = /^\$([A-F0-9]{40})(?:[~=](.*))?$/;

export function parseCircuitLine(line) {
    if (!line || !line.trim()) return null;
    const parts = line.trim().split(' ');
    if (parts.length < 2) return null;
    const id = parts[0];
    const status = parts[1];
    let pathStr = '';
    let metaStart = 2;
    // Some statuses (LAUNCHED) may have no path yet — check if parts[2] has '='
    if (parts.length > 2 && !parts[2].includes('=')) {
        pathStr = parts[2];
        metaStart = 3;
    }
    const meta = {};
    for (let i = metaStart; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq > 0) meta[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
    }
    const hops = pathStr ? pathStr.split(',').map(parseHop).filter(Boolean) : [];
    return {id, status, hops, meta};
}

function parseHop(h) {
    const m = h.match(HOP_RE);
    if (m) return {fp: m[1], name: m[2] || ''};
    if (/^[A-F0-9]{40}$/.test(h)) return {fp: h, name: ''};
    return null;
}

/**
 * Pick the best-representative circuit for showing to the user:
 * most recently built GENERAL-purpose circuit with 3+ hops.
 */
export function pickPrimaryCircuit(circuits) {
    const eligible = circuits.filter(c =>
        c.status === 'BUILT'
        && (c.meta.PURPOSE === 'GENERAL' || !c.meta.PURPOSE)
        && c.hops.length >= 2);
    if (!eligible.length) return null;
    eligible.sort((a, b) =>
        (b.meta.TIME_CREATED || '').localeCompare(a.meta.TIME_CREATED || ''));
    return eligible[0];
}
