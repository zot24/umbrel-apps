# nworth — Umbrel app

Self-hosted personal net-worth & portfolio tracker (web UI + JSON/REST API),
running on your own Umbrel. Source: the private repo `zot24/nworth`.

- **App ID**: `zot24-nworth`
- **Port**: 8080
- **Image**: `ghcr.io/zot24/nworth` — **built + published by the nworth repo
  itself** (`zot24/nworth` → `.github/workflows/publish-image.yml`, using its
  own `GITHUB_TOKEN`). This store only *pins* the published image; it never
  needs the private source or a PAT.
- **Auth**: nworth's own password gate (Umbrel proxy auth disabled, see below)

## One-time setup (publish the image)

The image is built where the source lives. Before the app can install:

1. **Build + push the image.** In `zot24/nworth`: Actions → **Publish image** →
   *Run workflow* (set `version` = `0.3.0`), or push a `vX.Y.Z` release tag. It
   builds linux/amd64 + arm64 and pushes `ghcr.io/zot24/nworth:<version>`.
   > arm64 builds under QEMU emulation — the first run is slow (Rust compile);
   > later runs reuse the GitHub Actions cache. Drop to amd64-only via the
   > workflow's `platforms` input if your Umbrel is x86 (Umbrel Home).

2. **Keep the package PRIVATE + authenticate pulls.** The image embeds
   business-entity names (migration/template comments), so it stays private.
   Create ONE classic PAT scoped to **`read:packages` only** (it can pull
   images — never see code, issues, or history), then use it twice:
   - **Umbrel box (one time, SSH):**
     `docker login ghcr.io -u zot24` → paste the PAT as the password.
   - **This repo:** add it as Actions secret **`GHCR_READ_TOKEN`** so the pin
     workflow can read the private package's tags/digests.

   (Alternative: make the package public — no PAT anywhere — but review the
   embedded comments first.)

3. **Pin it.** In this repo: Actions → **Pin nworth image** → *Run workflow*.
   It resolves the published digest and pins `docker-compose.yml` (+ bumps the
   app version). Then install/refresh the app on Umbrel.

## Automatic updates

[`.github/workflows/pin-nworth.yml`](../.github/workflows/pin-nworth.yml) polls
`ghcr.io/zot24/nworth` daily (auth via `GHCR_READ_TOKEN`; anonymous fallback if
the package is public), pins the highest semver tag by digest, and bumps the
app `version` so Umbrel surfaces the update. So the release cycle is: **tag
`zot24/nworth` `vX.Y.Z` → nworth publishes the image → this store pins it
within a day** (or trigger *Actions → Pin nworth image → Run workflow*
immediately).

## Install

App Store → **Community App Stores** → add `https://github.com/zot24/umbrel-apps`,
then install **nworth**. (Already added the store for the other apps? It's the
same one.)

## Authentication

Umbrel's built-in proxy login is **disabled** for this app
(`PROXY_AUTH_ADD: "false"`) so the API stays usable from scripts. Protection
comes from **nworth's own single-password gate**, keyed to the deterministic
password Umbrel manages:

- **Password**: shown on the app's tile in the Umbrel dashboard
  (`deterministicPassword: true`).
- **Web UI**: open the app → sign in with that password.
- **API / CLI**: send it as a bearer token —
  ```bash
  curl -H "Authorization: Bearer <password>" http://umbrel.local:8080/api/net-worth
  ```
  (`/healthz` is open; everything else needs the password.)

## Optional secrets & settings

Drop a `KEY=VALUE` file at `<app-data>/data/.env` over SSH
(`~/umbrel/app-data/zot24-nworth/data/.env`) to enable extras — none are
required:

| Key | Purpose |
|-----|---------|
| `COINGECKO_API_KEY` | Higher-rate crypto pricing in the feed |
| `HELIUS_RPC_URL` | Solana on-chain holdings (connector) |
| `DIGEST_WEBHOOK_URL` | Feed POSTs a change-detected regime/drift digest (sends real figures — keep it private) |
| `AUTH_COOKIE_SECURE` | `1` when you front the app with HTTPS (Tailscale/Cloudflare) so the session cookie is marked Secure |

`AUTH_PASSWORD` / `SESSION_SECRET` are set by Umbrel in the compose file and
**override** anything in `.env`, so the gate stays Umbrel-managed.

## Bringing your existing data

The app starts with an empty database (it creates + migrates `portfolio.db` on
first boot). To move your current DB in:

1. Install + start the app once (creates `~/umbrel/app-data/zot24-nworth/data/`),
   then stop it from the dashboard.
2. Copy your DB to `~/umbrel/app-data/zot24-nworth/data/portfolio.db`.
   ⚠️ SQLite WAL: copy a checkpointed DB, or copy all three files
   (`portfolio.db`, `-wal`, `-shm`) together — a lone `.db` with a stale `-wal`
   loses recent writes.
3. Start the app. Migrations run automatically on boot.

## Backups

Umbrel backs up the app's data dir (`${APP_DATA_DIR}`) as part of its own backup
system, so `portfolio.db` is covered — no separate Litestream sidecar here
(unlike the standalone nworth `docker-compose.yml`).

## Local development

Build straight from a sibling `nworth` checkout and run the same two-service
layout on plain HTTP (no app_proxy):

```bash
# expects ~/Desktop/code/nworth next to ~/Desktop/code/umbrel-apps
docker compose -f docker-compose.local.yml up --build
# then sign in / call the API with AUTH_PASSWORD (default: dev-change-me)
```

## Assets (icon + gallery)

Per this store's convention, icon/gallery live in the separate
[`zot24/umbrel-apps-gallery`](https://github.com/zot24/umbrel-apps-gallery) repo
and are referenced by full URL in `umbrel-app.yml`. Add
`zot24-nworth/icon.svg` (256×256) and a few `N.jpg` gallery images there, then
list them under `gallery:` in the manifest.
