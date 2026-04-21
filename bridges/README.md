# Public Tor bridges

Auto-refreshed daily by `.github/workflows/bridges-refresh.yml` (03:17 UTC).

Source: [Tor Project Moat API — `circumvention/defaults`](https://bridges.torproject.org/moat/circumvention/defaults)
— the same endpoint Tor Browser hits for its "Select a built-in bridge" dialog.

## What's in `latest.json`

```json
{
  "fetched_at": "2026-04-21T04:17:02Z",
  "source": "https://bridges.torproject.org/moat/circumvention/defaults",
  "counts": {"obfs4": 9, "snowflake": 2, "webtunnel": 2},
  "bridges": {
    "obfs4":     [ "obfs4 IP:port FP cert=... iat-mode=0", ... ],
    "snowflake": [ "snowflake ...", ... ],
    "webtunnel": [ "webtunnel ...", ... ]
  }
}
```

## How a user consumes it

```bash
# 1. pull fresh list
curl -sL https://raw.githubusercontent.com/vipinus/gnome-shell-extension-tor/main/bridges/latest.json \
  | jq -r '.bridges.obfs4[], .bridges.snowflake[]' > /tmp/bridges.txt

# 2. paste lines into tor-ext prefs → Bridges → Bridge lines
#    (or set gsettings directly:)
mapfile -t lines < /tmp/bridges.txt
gsettings --schemadir ~/.local/share/gnome-shell/extensions/tor-ext@fabric.soul7.gmail.com/schemas \
  set org.gnome.shell.extensions.tor-ext bridge-lines "$(printf '%s\n' "${lines[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
gsettings --schemadir ... set org.gnome.shell.extensions.tor-ext use-bridges true
```

## Why only "public/builtin" bridges, not BridgeDB's private pool

BridgeDB's per-user HTTPS/email distribution is deliberately rate-limited so
that an adversary can't harvest the whole private pool and null-route every
bridge at once. Republishing private bridges in a public repo defeats that —
so this workflow only pulls the `builtin` + `defaults` lists that Tor Browser
already ships inside every installer.

If the builtin pool gets blocked in your region, go to
[bridges.torproject.org](https://bridges.torproject.org/) directly and get a
bespoke private bridge through the CAPTCHA.
