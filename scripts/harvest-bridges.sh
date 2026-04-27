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
# Only keep obfs4. Snowflake/webtunnel entries from the Moat defaults
# endpoint carry RFC 5737 / 3849 placeholder IPs (snowflake uses a
# broker, webtunnel uses url=, the IP field is never an actual dial
# target). When tor receives those Bridge lines, the matching PT
# client (snowflake-client / webtunnel-client) crashes in a tight
# restart loop on the unreachable IP and bootstrap stalls at 0% —
# Tor Browser sidesteps this by selecting one transport at a time,
# but this extension pushes ALL stored bridges, so we publish
# obfs4-only to keep the auto-fetch flow safe out of the box.
# Users who want snowflake / webtunnel can paste lines manually
# in the Preferences > Bridges page.
for s in settings:
    b = s.get("bridges", {})
    t = b.get("type")
    if t != "obfs4":
        continue
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
