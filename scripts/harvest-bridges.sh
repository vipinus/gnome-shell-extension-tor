#!/usr/bin/env bash
# harvest-bridges.sh — fetch public Tor bridges from Tor Project's Moat API
# and normalise them into a single JSON file for downstream consumers.
#
# Only fetches PUBLIC bridge lists (`builtin` + `bridgedb` defaults) — the
# same ones Tor Browser's "Select a built-in bridge" dialog offers. Private
# BridgeDB bridges are deliberately NOT scraped: exposing them in a
# public repo defeats BridgeDB's per-user rate-limiting by letting censors
# null-route the whole batch at once.
#
# Output: single JSON on stdout with shape:
#   {
#     "fetched_at": "2026-04-21T04:15:02Z",
#     "source":     "https://bridges.torproject.org/moat/circumvention/defaults",
#     "counts":     {"obfs4": 9, "snowflake": 2, "webtunnel": 2},
#     "bridges":    {
#        "obfs4":     [ "obfs4 ...", ... ],
#        "snowflake": [ "snowflake ...", ... ],
#        "webtunnel": [ "webtunnel ...", ... ]
#     }
#   }
set -euo pipefail

SOURCE_URL='https://bridges.torproject.org/moat/circumvention/defaults'

raw=$(curl --fail --max-time 30 -sSL "$SOURCE_URL" \
        -H 'Accept: application/vnd.api+json')

python3 - <<PY
import json, datetime, os, sys

data = json.loads(r"""$raw""")
settings = data.get("settings", [])

bridges = {}
for s in settings:
    b = s.get("bridges", {})
    t = b.get("type")
    strings = b.get("bridge_strings", []) or []
    if not t or not strings: continue
    bridges.setdefault(t, []).extend(strings)

# De-dup, preserve order.
for t in bridges:
    seen, out = set(), []
    for line in bridges[t]:
        if line not in seen:
            seen.add(line); out.append(line)
    bridges[t] = out

doc = {
    "fetched_at": datetime.datetime.now(datetime.timezone.utc)
                   .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source": "$SOURCE_URL",
    "counts": {t: len(v) for t, v in sorted(bridges.items())},
    "bridges": dict(sorted(bridges.items())),
}
print(json.dumps(doc, indent=2, ensure_ascii=False))
PY
