# Installing a session for the Playwright Renderer

The renderer ships with two modes:

- **Anonymous (default).** Every request gets a fresh, signed-out browser context. Fine for public, non-bot-walled sites.
- **Session (opt-in).** Clients that pass `"useSession": true` get a context bootstrapped from a `storageState.json` file you scp onto the Umbrel volume. This is how you scrape sites that require login (Instagram, LinkedIn, Patreon, etc.) without giving the renderer your password.

This doc is the operator runbook for installing and refreshing the session file. It applies whether you're targeting Instagram, X/Twitter, or any other site that needs cookies.

## Threat model in one paragraph

`storageState.json` is the credential. Anyone with the file can act as you on the target site until the session expires (or you log out from there). The renderer stores it at `/data/storageState.json` with mode `600`, owned by `pwuser` inside the container — same ACL as the auto-generated `/data/.env` bearer token. Compromise of the Umbrel host means compromise of every session you've installed. Treat each session as if you'd dropped your phone — you can recover by logging out from the site's "active sessions" UI, which invalidates the file you installed.

## One-time install (~5 minutes)

### Step 1 — export cookies from a logged-in browser

On a machine where you're already logged in to the target site (your laptop), install a `cookies.txt` exporter — the two we've tested work fine:

- **Get cookies.txt LOCALLY** (Chrome/Edge): https://chromewebstore.google.com/detail/get-cookiestxt-locally
- **EditThisCookie** with the "Export → Netscape" option

Visit the target site, hit "Export". You get a `cookies.txt`. Tab-separated, headed by `# Netscape HTTP Cookie File`. **Keep it on disk only — don't paste it anywhere.**

### Step 2 — convert to Playwright's storageState format

Cookies.txt isn't directly readable by Playwright. Run the bundled converter — pure-stdlib Node script, runs on your laptop, no network:

```bash
cd /path/to/zot24-playwright-renderer
node tools/cookies-to-storage-state.mjs \
    ~/Downloads/instagram_cookies.txt \
    ./storageState.json \
    --require sessionid,ds_user_id
```

The `--require` flag is optional but recommended — it bails out if the cookie file is from a logged-out session (no `sessionid`), which would otherwise silently produce an "anonymous" session you'd debug for an hour. For other sites, swap the required-cookies list (Twitter: `auth_token,ct0`; LinkedIn: `li_at,JSESSIONID`).

Output is mode `600` (owner-only readable). Output filename can be anything — we'll rename on copy.

### Step 3 — copy to the Umbrel volume

```bash
scp ./storageState.json umbrel@umbrel.local:/tmp/storageState.json
ssh umbrel@umbrel.local '
  set -e
  sudo cp /tmp/storageState.json ~/umbrel/app-data/zot24-playwright-renderer/data/storageState.json
  sudo chown 1000:1000 ~/umbrel/app-data/zot24-playwright-renderer/data/storageState.json
  sudo chmod 600 ~/umbrel/app-data/zot24-playwright-renderer/data/storageState.json
  rm /tmp/storageState.json
'
```

UID/GID `1000:1000` matches the `pwuser` the renderer runs as (set by the `gosu` drop in `entrypoint.sh`). The renderer reads the file on every request, so **no restart needed** — the next `useSession: true` request will pick it up.

### Step 4 — delete the local copies

```bash
rm ./storageState.json ~/Downloads/instagram_cookies.txt
```

Belt and suspenders. The source `cookies.txt` is the dangerous one; the converted JSON is the same credential in a different format.

### Step 5 — verify

From your laptop:

```bash
TOKEN=$(ssh umbrel@umbrel.local 'cat ~/umbrel/app-data/zot24-playwright-renderer/data/.env' | sed -n 's/RENDERER_TOKEN=//p')
curl -sf -X POST 'https://playwright.<your-domain>/render' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://www.instagram.com/<your-test-handle>/",
    "useSession": true,
    "gotoOptions": {"waitUntil":"domcontentloaded","timeout":20000},
    "waitForSelector": "a[href^=\"/p/\"]"
  }' | jq '.success, (.result // "" | length)'
```

Expected: `true` and an HTML payload `> ~1MB`. If you also pipe `| grep -o '/p/[A-Za-z0-9_-]\+' | sort -u | wc -l`, you should see >0 post links — that's the proof a logged-in session worked. If you get `useSession requested but /data/storageState.json is missing` you skipped step 3; if you get 0 `/p/` matches, the session expired or the cookies are for a different IG account.

## When to refresh

Sessions persist as long as the source site lets them. Typical lifetimes:

- Instagram: weeks to months
- Twitter/X: weeks
- LinkedIn: days to weeks (it logs you out aggressively)

You'll know it's time to refresh when:

- The render call returns HTML with zero items (e.g., zero `/p/` links for IG) where there used to be many
- Worker logs show `"session expired"` or unusually low extraction counts
- A health-check script you set up returns a failure

Refresh is the same as install: re-export cookies, re-run the converter, re-scp. Total ~3 minutes.

## What this does NOT do

- **Auto-login.** The renderer doesn't have your password or TOTP secret. Session refresh is a manual step — see GH issue (tracked in [zot24/onlyinparaguay](https://github.com/zot24/onlyinparaguay/issues), label `area:renderer`) for the auto-login design proposal.
- **Multi-session.** One `storageState.json` covers all sites at once (cookies are domain-scoped). Multiple accounts on the same site would need separate renderer instances — out of scope for v1.
- **Persistence across renderer image upgrades.** The file lives on the Docker volume, which survives image upgrades. It does NOT survive an Umbrel app *reinstall* (volume wipe), only updates.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503 useSession requested but /data/storageState.json is missing` | Step 3 skipped or file is at the wrong path | Re-run step 3, verify with `ssh umbrel@umbrel.local 'ls -la ~/umbrel/app-data/zot24-playwright-renderer/data/storageState.json'` |
| HTML returned but zero items extracted | Session expired or cookies are anonymous | Re-export cookies (step 1) while logged in, re-install |
| `403` or `429` from the target site | Rate-limited or shadow-banned account | Back off your scrape cadence; consider using a dedicated scraping account |
| Renderer logs show JSON parse errors | `storageState.json` is malformed | Re-run the converter; check the input `cookies.txt` is tab-separated and starts with `# Netscape HTTP Cookie File` |
| Render takes much longer with `useSession: true` | The site loads more content when logged in (e.g., IG hydrates the full grid). Working as intended. | Increase `timeout` in `gotoOptions` if hitting the 30s ceiling |
