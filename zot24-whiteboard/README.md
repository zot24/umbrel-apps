# Whiteboard

An infinite canvas that you and a small team of AI agents work on at the same time, built
first for game-character design: concept art, lore, pixel-art sprites and animations,
character sheets and mechanics. Agents propose and you keep, send back or discard. Edit
something an agent is working on and it re-reads your change and continues from it.

- **App ID**: `zot24-whiteboard`
- **Port**: 7787 (Whiteboard's own login; the Umbrel proxy login is off)
- **Image**: `ghcr.io/zot24/whiteboard`, built and published by the private repo
  `zot24/whiteboard` (`.github/workflows/publish-image.yml`). This store only pins it.

## One-time setup

1. **Publish the image.** In `zot24/whiteboard`, push the tag `v0.1.0` (it must match
   `version` in `package.json`), or run Actions → **Publish image**. It runs the tests, then
   pushes `ghcr.io/zot24/whiteboard:<version>` for amd64 and arm64.
2. **Pull access.** The package is private, like the repository. It uses the same
   `read:packages` token as nworth: the Umbrel's one-time `docker login ghcr.io -u zot24`,
   and this repository's `GHCR_READ_TOKEN` secret. If nworth already installs, nothing more
   is needed. (Making the package public removes both, but exposes the built code.)
3. **Pin it.** Here: Actions → **Pin whiteboard image** → Run workflow. It pins
   `docker-compose.yml` to the digest and sets the app version. Umbrel refuses to install
   the app before this pin.

## Updates

Set a new `version` in `zot24/whiteboard`'s `package.json`, merge, and push the tag
`vX.Y.Z`. **Pin whiteboard image** runs daily (or by hand), pins the newest semver tag and
bumps the version here, so the Umbrel offers the update.

## First run

1. Open the tile and log in with the password Umbrel showed on it. Whiteboard has no user
   name. Each browser logs in once.
2. The board "Character: Moth Knight" is already there. Press **Wake Pixel**, then
   double-click the dash sprite and paint while Pixel works: Pixel says it saw your edit,
   re-reads it and builds on it.
3. On a phone, open `http://umbrel.local:7787` (or the Umbrel's IP or Tailscale name). The
   narrow layout is the Remote: questions, approvals, notes, and pause or steer an agent.

## Settings

All optional. Put them in `<app-data>/data/.env` (KEY=VALUE) and restart the app:

```sh
ANTHROPIC_API_KEY=sk-ant-...   # agents use Claude; without it they run on the offline Studio Sim
AGENT_MODEL=claude-opus-5-5    # default model
AGENT_EFFORT=medium            # low | medium | high | xhigh | max
SIM_DELAY_MS=600               # pacing of the Studio Sim
ALLOWED_ORIGINS=               # another address you open it under, e.g. https://studio.example.com
ALLOW_PRIVATE_URLS=0           # 1 lets URL import fetch addresses on your LAN
SEED_DEMO=1                    # 0: no demo board on a fresh install
```

`STUDIO_PASSWORD`, `PUBLIC_URL`, `DATA_DIR` and `EXPORT_ROOTS` are set by the compose file and
cannot be changed there. `<app-data>` is `~/umbrel/app-data/zot24-whiteboard` on the Umbrel.

## Data

Everything is under `<app-data>/data/whiteboard`: `studio.db` (SQLite), uploaded images, and
`exports/`, where the folder-export connector writes character bundles (PNG sheets, sprite
JSON, lore and mechanics Markdown). Uninstalling the app deletes it.

## Your own agents and other apps

Create an API token in Settings → API tokens. It works on the Umbrel port
(`http://umbrel.local:7787`) and, for another app on the Umbrel, on the Docker network at
`http://zot24-whiteboard_web_1:8787`. Inbound webhooks (`/hooks/in/...`) need only their key.
Examples are in the README of `zot24/whiteboard` (Bring your own agent).

## Limits

- Do not put the port on the public internet as it is. If you publish it with the
  [Cloudflare Tunnel](../zot24-cloudflared/README.md) app, put Cloudflare Access in front, and
  add the public address to `ALLOWED_ORIGINS`.
- Logins are rate limited per client address (5 wrong passwords a minute, 20 an hour).
  Behind the Umbrel proxy every browser shares the proxy's address, so the limit locks out
  every browser at once.
- The Anthropic provider has been tested against a stand-in for the API only.

## Try it without an Umbrel

After `docker login ghcr.io`:

```sh
cd zot24-whiteboard
STUDIO_PASSWORD=pick-one docker compose -f docker-compose.local.yml up
```

Then open http://127.0.0.1:7787. To build from source, see `zot24/whiteboard`.
