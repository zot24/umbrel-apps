# Cloudflare Tunnel

Umbrel app that runs a [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) so other apps on the box can be reached from the Internet without opening a router port.

- **App ID**: `zot24-cloudflared`
- **Port**: 4500 (UI, behind the Umbrel login)
- **License**: GPL-3.0. The UI and the connector started from [Radiokot/umbrel-cloudflared](https://github.com/Radiokot/umbrel-cloudflared) 1.1.0 and [Radiokot/umbrel-cloudflared-connector](https://github.com/Radiokot/umbrel-cloudflared-connector). `LICENSE` is that license. The images this app runs are built here.

The official Umbrel store already ships this as app id `cloudflared` on port 4499. This copy is a separate app, so installing it does not replace that one. `zot24-playwright-renderer` still depends on the official app id.

## Pieces

| Service | Source | Role |
| --- | --- | --- |
| `web` | `web/` | SvelteKit UI. Reads and writes the token file, then asks the connector to restart. |
| `connector` | `connector/` | `cloudflared` plus a small control loop on port 8018. That port is not published. |

Both services mount the app data directory. The token is `data/token`. Extra arguments are `data/extra_args`.

`exports.sh` sets `APP_ZOT24_CLOUDFLARED_METRICS_PORT=40901`. That port stays inside the connector container.

## Routing another app

Create a tunnel and a token in the Cloudflare dashboard, paste the token into this app, then add a public hostname whose service is the other app's container. Umbrel names containers `<app-id>_<service>_1`. Playwright Renderer is `http://zot24-playwright-renderer_playwright_1:3030`.

The setup walkthrough, with examples, is still the upstream wiki: [How to set up Cloudflare Tunnel on your Umbrel](https://github.com/Radiokot/umbrel-cloudflared/wiki/How-to-set-up-Cloudflare-Tunnel-on-your-Umbrel). The UI links there. Those URLs are baked in at image build from `web/.env`.

## Images

Both services are `ghcr.io/zot24/...`. Nothing is pulled from Radiokot's registry.

`connector/Dockerfile` copies `cloudflared` out of `cloudflare/cloudflared`. That line is pinned to a release tag and the multi-arch digest. It is currently 2026.10.6. Cloudflare's [eMudhra advisory](https://blog.cloudflare.com/emudhra-certificate-compromise/) says to run at least 2026.10.2 and to redeploy container images.

The running connector does not wait for an app update. `connector/update-bin.sh` asks GitHub for the latest `cloudflare/cloudflared` release before the tunnel connects, and again every 5 minutes. A newer release is downloaded, checked against the SHA256 in that release, stored on the data volume, and the tunnel is restarted onto it. A failed check leaves the current binary running. It never downgrades. `--no-autoupdate` stays set, because cloudflared's own updater is not checksum-checked and a new container would discard its copy.

`.github/workflows/update-cloudflared.yml` runs hourly. If the upstream image index contains linux/amd64 and linux/arm64, the job bumps the Dockerfile pin, bumps the app patch version, builds both images, and commits the compose digests in that same commit. That keeps a fresh install close to upstream. The box that is already running does not need that commit to pick up a cloudflared release.

A push to `main` that changes `web/`, `connector/`, or `umbrel-app.yml` runs `.github/workflows/build-cloudflared.yml`, which publishes:

- `ghcr.io/zot24/cloudflared:<version>`
- `ghcr.io/zot24/cloudflared-connector:<version>-cf.<cloudflared version>`

and writes the digests into `docker-compose.yml`. Until the first of those commits lands, the compose tags have no digest and Umbrel will refuse to install the app.

## Upstream changes

`.github/workflows/integrate-cloudflared-upstreams.yml` runs daily. It reads the three pins in `ci/upstreams.json`. A cloudflared image tag, or a manifest line that only says the daemon moved, is ignored and the pin advances in a commit on `main`. The hourly job already ships that binary. You do not get a pull request for it.

Anything else opens one pull request, branch `integrate/cloudflared-upstreams`. You merge it yourself. When that pull request opens and the repository secret `ANTHROPIC_API_KEY` is set, Claude Sonnet reads the report and ports the interesting remainder onto the same branch. A run stops at 12 turns or $2. It does not merge. The daily run uses Sonnet. A manual run can pick Haiku or Opus. Flex is not an Anthropic API discount, and fast mode costs more, so this trial stays on the standard tier where the API credit is.

| Pin | Upstream | What the job does with a product change |
| --- | --- | --- |
| `ui` | [Radiokot/umbrel-cloudflared](https://github.com/Radiokot/umbrel-cloudflared) | Applies it onto `web/`, except the forked route layout (`src/routes/+page.svelte`, `src/lib/components/TunnelRoute.svelte`). Those land in `ci/pending/ui-port.diff`. |
| `connector` | [Radiokot/umbrel-cloudflared-connector](https://github.com/Radiokot/umbrel-cloudflared-connector) | Applies scripts we did not fork. `Dockerfile`, `control-loop.sh`, `process.sh`, and `update-bin.sh` land in `ci/pending/connector-port.diff`. |
| `umbrel` | [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) `cloudflared/` | Saves the product diff under `ci/pending/umbrel.diff`. This copy's compose file and manifest stay as written for this store. The pin is the latest commit that touched `cloudflared/`. |

Port a forked diff before merging. Keep the cloudflared digest, `update-bin.sh`, the metrics port, and the three-column route layout, and drop image-tag edits that rode along in the same file. A conflict keeps the old pin, and the pull request contains the `.rej` file. While a pull request for those same target commits is open, the next daily run leaves it alone. Close it and the following run tries again. A newer upstream rebuilds the branch from `main`, so review commits on the old branch are replaced.

The other repository we maintain is [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery), for the icon and screenshots. This token cannot push there. When upstream `repository-assets/` changes, the pull request says to update the gallery by hand.

This is a GitHub Actions workflow. Neither repository has a Flux config. A new `cloudflare/cloudflared` release is still the hourly job, which commits the image pin itself. The daily job only records that it saw the matching upstream commit.

## Local run

```bash
docker compose -f docker-compose.local.yml up --build
```

The UI is at http://localhost:3000. It talks to the connector service by the compose DNS name `connector`.
