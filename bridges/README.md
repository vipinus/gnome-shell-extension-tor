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

## Mirror to a public gist (when the main repo goes private)

`raw.githubusercontent.com` returns 404 for private repos, so once you flip the
visibility the extension's **Fetch public bridges** button breaks. Workaround:
mirror `bridges/latest.json` to a public gist and point clients there via the
`public-bridges-url` gsettings key.

One-time owner setup:

1. Create a public gist at <https://gist.github.com/> with **any** placeholder
   JSON in a file called `latest.json`. Copy the gist ID from the URL
   (`https://gist.github.com/<user>/<GIST-ID>`).
2. Create a fine-grained PAT at <https://github.com/settings/tokens?type=beta>
   with **only** the `gist: write` scope. Do NOT give it any repo permissions.
3. In the private repo → Settings → Secrets and variables → Actions, add:
   - `BRIDGES_GIST_ID`     = the gist ID
   - `BRIDGES_GIST_TOKEN`  = the PAT
4. Run the workflow once (`gh workflow run bridges-refresh.yml`) to populate
   the gist with real data.
5. Flip the extension's default pointer — either change the default in
   `schemas/org.gnome.shell.extensions.tor-ext.gschema.xml` and ship a new
   zip, or have users run:
   ```bash
   gsettings --schemadir ~/.local/share/gnome-shell/extensions/tor-ext@fabric.soul7.gmail.com/schemas \
     set org.gnome.shell.extensions.tor-ext public-bridges-url \
     'https://gist.githubusercontent.com/<user>/<GIST-ID>/raw/latest.json'
   ```
6. Now the main repo can go private — the gist remains public.

If either secret is missing the workflow's mirror step is skipped automatically,
so the same workflow works identically in public-main-repo mode.

## Why only "public/builtin" bridges, not BridgeDB's private pool

BridgeDB's per-user HTTPS/email distribution is deliberately rate-limited so
that an adversary can't harvest the whole private pool and null-route every
bridge at once. Republishing private bridges in a public repo defeats that —
so this workflow only pulls the `builtin` + `defaults` lists that Tor Browser
already ships inside every installer.

If the builtin pool gets blocked in your region, go to
[bridges.torproject.org](https://bridges.torproject.org/) directly and get a
bespoke private bridge through the CAPTCHA.
