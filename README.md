# zot24's Umbrel Community App Store

Custom apps for [Umbrel](https://umbrel.com).

## Adding this App Store

On your Umbrel, go to **App Store** → **Community App Stores** → **Add** and enter:

```
https://github.com/zot24/umbrel-apps
```

## Available Apps

Each app folder has a README with its setup, its limits and how it works.

| App | App ID | Port | What it does |
|-----|--------|------|--------------|
| [nworth](zot24-nworth/README.md) | `zot24-nworth` | 8484 | Self-hosted personal net-worth and portfolio tracker. |
| [Playwright Renderer](zot24-playwright-renderer/README.md) | `zot24-playwright-renderer` | 3030 | Headless-browser renderer with residential-IP egress. |
| [Herdr](zot24-herdr/README.md) | `zot24-herdr` | 7681 | Terminal multiplexer for AI coding agents: a persistent server on your Umbrel, with a browser TUI, phone or laptop attach over Tailscale, and a machine for the Herdr desktop app. |
| [Proton Bridge](zot24-proton-bridge/README.md) | `zot24-proton-bridge` | 7685 | Proton Mail IMAP/SMTP bridge for sibling apps (Hermes, Himalaya). The console is behind the Umbrel login. IMAP 143 and SMTP 25 stay on the container network. |
| [Apprise](zot24-apprise/README.md) | `zot24-apprise` | 8000 | Notification gateway for Telegram, Discord and 100+ other services. The notify API stays on the container network. |
| [Cursor Sandboxes](zot24-cursor-sandboxes/README.md) | `zot24-cursor-sandboxes` | 7690 | Machines for Cursor Cloud Agents. Each sandbox is a Cursor "My Machines" worker in its own container, inside a Docker daemon private to the app. Workers connect out only. |
| [GitHub Runner](zot24-github-runner/README.md) | `zot24-github-runner` | 3500 | Self-hosted GitHub Actions runners for your private repositories. Jobs with `runs-on: [self-hosted, umbrel]` run on the Umbrel, one fresh container per job, inside a Docker daemon private to the app. GitHub does not bill self-hosted minutes. |
| [Cloudflare Tunnel](zot24-cloudflared/README.md) | `zot24-cloudflared` | 4500 | Cloudflare Tunnel for other Umbrel apps. Separate from the official `cloudflared` app on port 4499. The connector installs a new cloudflared by itself. |
| [Dockyard](zot24-dockyard/README.md) | `zot24-dockyard` | 8120 | An isolated Docker host on your Umbrel: a full Docker daemon in its own network namespace, apart from Umbrel's own Docker, to deploy and run your own containers. |
| [Openship](zot24-openship/README.md) | `zot24-openship` | 3001 | The Openship deploy control plane (dashboard and API). It manages remote servers over SSH, and does not build or run apps on the Umbrel. |

nworth and Openship have their own login. The other web UIs are behind the Umbrel login.

## How an update reaches your Umbrel

Your Umbrel offers an update for an app only when `version:` in that app's
`umbrel-app.yml` changes on `main`. A merge that changes code or an image pin,
but not the version, reaches new installs only. An installed app keeps its old
files and images until you update it.

How a change gets a new version depends on where the app's image comes from:

| Apps | Image | What happens after a merge to `main` |
|------|-------|--------------------------------------|
| GitHub Runner, Cursor Sandboxes, Herdr, Playwright Renderer, Cloudflare Tunnel | Built in this repository (`ghcr.io/zot24/…`) | `Build: <app>` builds the images for amd64 and arm64, tags them with the version in `umbrel-app.yml`, and the bot commits the new digests to `docker-compose.yml` (`chore: pin …` or `chore: update … image`). The build starts only for changes to the image sources. |
| nworth | Built in `zot24/nworth` | `Pin nworth image` runs every day. It pins the newest published image and changes the version itself, so no pull request is needed. |
| Apprise, Dockyard, Openship, Proton Bridge | Upstream images | Change the image in `docker-compose.yml` and the version in the same pull request. |

Two weekly workflows open their own pull requests with a new version:
`Update: GitHub Actions runner` (the `actions/runner` base of the runner image)
and `Update: Herdr deps` (herdr and ttyd). Merge the pull request, and the build
on `main` makes and pins the new image.

`Update: cloudflared` runs every hour. When `cloudflare/cloudflared` publishes
a newer multi-arch image, that job bumps the app version, builds both images,
and commits the digests in the same commit. A box that is already running
does not wait for that commit: the connector installs the new binary and
restarts the tunnel within a few minutes. `Integrate: cloudflared upstreams`
runs daily and opens a pull request only when Radiokot's UI or connector, or
the official Umbrel listing, changes something other than that cloudflared
release.

### Ship a change to an app that is built here

1. Merge the pull request with the change. For GitHub Runner, the pull
   request build first runs the tests and builds the images without pushing
   them. The other apps build on `main` only.
2. Wait for the bot commit that pins the new digests on `main`.
3. Change the version in `<app>/umbrel-app.yml` and in `<app>/VERSION`, and
   write `releaseNotes` for the people who update. Merge that pull request.
   It changes no image source, so it does not start a new build.
4. On the Umbrel, open the app in the App Store and select **Update**. The
   update restarts the app.

A pull request can also change the version and the code together (as in
[#132](https://github.com/zot24/umbrel-apps/pull/132)). Then the build on `main` tags the images with the new version, and the
update is offered as soon as the bot pin commit lands.

### Try an app on your own machine

Most apps have a `docker-compose.local.yml`: the same stack without Umbrel.
Start it from the app folder. Some files explain more options in a comment at
the top (GitHub Runner, for example, can run against a fake GitHub API):

```bash
cd zot24-github-runner
docker compose -f docker-compose.local.yml up -d
```

## Retired Apps

- **zot24-hermes** (Hermes Agent): removed 2026-07-20. The official
  [Hermes Agent app](https://github.com/getumbrel/umbrel-apps) in Umbrel's official store replaces it.
- **zot24-openclaw** (OpenClaw): removed. Its `openclaw-docker` image is no longer available.

## Icons and gallery images

This repository uses a **separate gallery repository** for icons and screenshots:
[zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery).

Umbrel community app stores have a limitation: icons and gallery images in the
app folder do not show. Umbrel fetches them from the official gallery endpoint
instead of the local store. The workaround is to host them in a separate
repository and use full URLs in `umbrel-app.yml`:

```yaml
icon: https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-nworth/icon.png
gallery:
  - https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-nworth/1.jpg
```

[Umbrel issue #1998](https://github.com/getumbrel/umbrel/issues/1998) documents this.

## Related Repositories

| Repository | Purpose |
|------------|---------|
| [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps) | This repo: app definitions |
| [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery) | Icons and gallery images |
| [zot24/nworth](https://github.com/zot24/nworth) | nworth source and image |
