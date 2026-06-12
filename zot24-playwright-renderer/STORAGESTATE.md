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

## Session keep-alive (on by default)

After every successful `useSession: true` render that does **not** look like a login wall, the renderer writes the context's cookies back to `/data/storageState.json` (atomic write, mode `600`). Sites like Instagram use sliding session expiry, so rolling the cookies forward on every scrape keeps extending the session — in the happy case you may never need the manual refresh ritual again.

- It never writes back when the response carries login-wall markers, so an expired session can't clobber the file with logged-out cookies.
- Disable it (if you want the file to stay byte-identical to what you installed) by appending `SESSION_KEEPALIVE=false` to `/data/.env` and restarting the app.

## Auto-refresh (opt-in)

When the session *does* expire, the renderer can re-login to Instagram by itself using credentials you provision, save a fresh session, and retry the render — no operator intervention. This is **off by default**; you must opt in.

### The security tradeoff, read this first

Storing `IG_PASSWORD` (and especially `IG_TOTP_SECRET`) on the box is a strictly bigger commitment than the session file:

- A TOTP secret stored next to the password is, from the renderer's perspective, **equivalent to having no 2FA at all** — anyone who reads `/data/.env` can mint valid codes forever.
- Blast radius grows from "time-bounded session token" to "the whole account" (password reset → arbitrary action).
- **Use a dedicated, aged scraping account**, never your personal one. If the Umbrel host is compromised, you lose that account, not your identity.

If that tradeoff isn't acceptable, don't enable this — the manual refresh ritual above keeps working unchanged.

### Provisioning

Append the credentials and the opt-in flag to the same `/data/.env` that holds the bearer token (ssh in; don't paste secrets into shared shells/history you don't control — the leading space below keeps the line out of most shell histories):

```bash
ssh umbrel@umbrel.local
 sudo tee -a ~/umbrel/app-data/zot24-playwright-renderer/data/.env >/dev/null <<'EOF'
IG_USERNAME=your_scraping_account
IG_PASSWORD=its_password
IG_TOTP_SECRET=BASE32SECRETFROMAUTHENTICATORSETUP
STORAGE_STATE_AUTOREFRESH=true
EOF
 sudo chmod 600 ~/umbrel/app-data/zot24-playwright-renderer/data/.env
 sudo chown 1000:1000 ~/umbrel/app-data/zot24-playwright-renderer/data/.env
```

- `IG_TOTP_SECRET` is **optional** — omit it if the account has no 2FA. It's the base32 string the authenticator-app setup screen shows (spaces/lowercase are fine). If the account has 2FA but you omit the secret, every auto-login attempt fails with category `totp_required_but_no_secret`.
- **No restart needed.** The renderer re-reads `/data/.env` on every recovery attempt, so the next expired-session render picks the credentials up.
- Tuning knobs (also via `/data/.env`, both optional): `AUTOLOGIN_MIN_INTERVAL_HOURS` (default `6`), `AUTOLOGIN_MAX_CONSECUTIVE_FAILURES` (default `3`).

### How it behaves

When a `useSession: true` render comes back as an Instagram login wall (and the requested URL isn't itself the login page):

1. The renderer logs in at `/accounts/login/` with your credentials (+ a freshly computed TOTP code if prompted), clicks "Save info" to maximize session longevity, and verifies success by the presence of a `sessionid` cookie.
2. On success it atomically replaces `/data/storageState.json`, retries your original render once, and returns that result. You see nothing but a slower-than-usual response.
3. On failure it logs a loud alert (an error **category** only — credentials, TOTP codes, cookies, and page HTML never appear in logs at any level) and returns the wall HTML unchanged as a normal `success: true` response, so the scraper worker detects the expired session and backs off.

### Rate limiting and fail-stop

Every login is a security event on Instagram's side, so the renderer is deliberately conservative:

- At most one attempt per `AUTOLOGIN_MIN_INTERVAL_HOURS` (default 6h), tracked in `/data/autologin-state.json`. Wall hits inside the window just serve the wall.
- After `AUTOLOGIN_MAX_CONSECUTIVE_FAILURES` (default 3) consecutive failures the breaker opens: no further attempts, and every render that *would* have tried logs `auto-login disabled after N consecutive failures — refresh the session manually per STORAGESTATE.md`.
- A successful login resets the counter.

### Resetting after fail-stop

Fix the underlying problem first (typo'd password, IG checkpoint/challenge on the account — log in from a real browser once to clear it, etc.), refresh the session manually per the install steps above, then re-arm:

```bash
ssh umbrel@umbrel.local 'sudo rm ~/umbrel/app-data/zot24-playwright-renderer/data/autologin-state.json'
```

### Disabling

Set `STORAGE_STATE_AUTOREFRESH=false` (or delete the line) in `/data/.env` — picked up on the next attempt, no restart. Removing the `IG_*` lines as well removes the credentials from the box entirely.

## When to refresh (manually)

This section applies when auto-refresh is disabled (the default), targets a site other than Instagram, or has fail-stopped. Sessions persist as long as the source site lets them. Typical lifetimes:

- Instagram: weeks to months
- Twitter/X: weeks
- LinkedIn: days to weeks (it logs you out aggressively)

You'll know it's time to refresh when:

- The render call returns HTML with zero items (e.g., zero `/p/` links for IG) where there used to be many
- Worker logs show `"session expired"` or unusually low extraction counts
- A health-check script you set up returns a failure

Refresh is the same as install: re-export cookies, re-run the converter, re-scp. Total ~3 minutes.

## What this does NOT do

- **Auto-login for sites other than Instagram.** The opt-in auto-refresh path (above, from [zot24/onlyinparaguay#119](https://github.com/zot24/onlyinparaguay/issues/119)) is Instagram-only for now — every site's login flow is different, and per-site adapters get added as needed. By default the renderer still holds no password or TOTP secret; you only cross that line if you enable auto-refresh.
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
| Logs show `auto-login disabled after N consecutive failures` | The auto-refresh fail-stop tripped (bad credentials, IG checkpoint, network) | Fix the cause, refresh the session manually, then `rm /data/autologin-state.json` — see "Resetting after fail-stop" |
| Logs show category `totp_required_but_no_secret` | The account has 2FA but `IG_TOTP_SECRET` isn't in `/data/.env` | Add the base32 secret (or disable 2FA on the scraping account) |
