# nworth — Umbrel app

Self-hosted personal net-worth & portfolio tracker (web UI + JSON/REST API),
running on your own Umbrel. Source: the private repo `zot24/nworth`.

- **App ID**: `zot24-nworth`
- **Port**: 8080
- **Image**: `ghcr.io/zot24/nworth` (built + pinned by
  [`.github/workflows/build-nworth.yml`](../.github/workflows/build-nworth.yml))
- **Auth**: nworth's own password gate (Umbrel proxy auth disabled, see below)

## One-time setup (publish the image)

nworth is a **private** repo, and Umbrel installs **pre-built, digest-pinned**
images. So before the app can install, the image has to be built and published
once via CI:

1. **Add the source-access secret.** Create a fine-grained GitHub PAT with
   **Contents: read** on `zot24/nworth`, then add it to this repo
   (`zot24/umbrel-apps`) as an Actions secret named **`NWORTH_REPO_TOKEN`**
   (Settings → Secrets and variables → Actions → New repository secret).

2. **Run the build.** Actions → **Build: nworth** → *Run workflow* (or just push
   a change to `zot24-nworth/umbrel-app.yml`). It builds linux/amd64 + arm64,
   pushes `ghcr.io/zot24/nworth:<version>`, and commits the pinned
   `@sha256:...` digest back into `docker-compose.yml`.
   > arm64 builds under QEMU emulation — the first run is slow (Rust compile);
   > later runs reuse the GitHub Actions cache.

3. **Make the package public.** On GitHub → your **Packages** → `nworth` →
   *Package settings* → set **visibility: Public** (and optionally link it to a
   repo). This lets the Umbrel box pull anonymously. The *source* stays private;
   only the built image is public. (Prefer to keep it private? Then run
   `docker login ghcr.io` on the Umbrel box once instead of this step.)

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
