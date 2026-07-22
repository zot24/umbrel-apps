# BUILD-REPORT — zot24-herdr (Herdr for Umbrel)

**Date:** 2026-07-21
**Upstream:** [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) v0.7.5 (AGPL-3.0)
**App ID:** `zot24-herdr` · **Port:** 7681 · **Conventions source:** `~/code/umbrel-apps` (zot24-nworth, zot24-playwright-renderer)

## What was built

An Umbrel community-store app that runs Herdr as a persistent, headless server
on an Umbrel box, with a browser attach as the app UI and documented
SSH/Tailscale paths for phone (Moshi) and laptop (`herdr --remote`).

```
server/Dockerfile           node:22-bookworm-slim + herdr 0.7.5 + ttyd 1.7.7 + mosh + openssh-client + git
server/entrypoint.sh        chown /data → seed config → herdr server (bg) → ttyd (fg, exec)
docker-compose.yml          app_proxy (Umbrel auth) + server service; ${APP_DATA_DIR}/data → /data
docker-compose.local.yml    local dev: build from source, named volume, publishes 7681
umbrel-app.yml              manifestVersion 1.1, category developer, port 7681
exports.sh                  APP_ZOT24_HERDR_IP / APP_ZOT24_HERDR_PORT
icon.svg                    placeholder (terminal glyph); real icon goes to zot24/umbrel-apps-gallery
.github/workflows/build.yml multi-arch build → ghcr.io → digest pin-back into docker-compose.yml
README.md                   attach paths, agent setup, persistence map, security
VERSION                     0.7.5
```

## Verified (locally, Docker Desktop 29.6.2)

- `docker buildx build` succeeds for **linux/arm64 and linux/amd64**; both
  images run `herdr 0.7.5` and `ttyd 1.7.7` (amd64 under qemu).
- Container boot: `herdr server` runs as UID 1000 with API socket at
  `/data/.config/herdr/herdr.sock`; `herdr session list` → `default running`.
- Socket API works end-to-end: `herdr workspace create` / `workspace list`.
- **Persistence:** after `docker compose restart`, the server comes back and
  the created workspace is restored (snapshot layout restore; shells are new —
  normal Herdr semantics).
- ttyd serves HTTP 200 on 7681 with `start command: herdr`.
- YAML/bash lint: prod compose parses, local compose `config --quiet` OK,
  manifest parses (23 keys), `bash -n` clean on entrypoint + exports.
- **Not tested locally:** an actual browser/xterm.js attach (needs a WebSocket
  TTY client), and anything on real Umbrel hardware.

## Key decisions (and why)

1. **Two processes, one container.** `herdr server` headless in the background
   (so agents run and `herdr session list` answers even with no client — this
   is what Moshi's herdr picker calls), plus `ttyd … herdr` in the foreground
   as the app UI. Each browser tab is just a Herdr client; closing it detaches
   (`init: true` + `stop_grace_period: 30s` in compose for clean shutdown).
2. **Web UI auth = Umbrel's app proxy.** ttyd has no credential of its own and
   no published port; `app_proxy` (default `PROXY_AUTH_ADD=true`) is the only
   path in. README/manifest repeatedly warn against publishing 7681 or
   funneling it — a web terminal is full shell access.
3. **HOME = /data (the app volume).** Herdr keeps config, socket, session
   state, and logs under `~/.config/herdr`; making the volume HOME persists
   all of it, plus `/data/workspaces` (user code) and `/data/.npm-global`
   (agent CLIs). **Gotcha found in testing:** `gosu` resets `HOME` from the
   passwd entry, clobbering `ENV HOME=/data` — fixed with `usermod --home
   /data node` so getpwuid and `$HOME` both resolve to the volume.
4. **Agent CLIs: user-installed, persisted.** Image ships Node 22 + npm with
   `NPM_CONFIG_PREFIX=/data/.npm-global` (on `PATH`), so
   `npm install -g @anthropic-ai/claude-code` survives image updates. Not
   preinstalled: they'd bloat the image and go stale. Setup steps are in the
   manifest description + README, including `herdr integration install <agent>`.
5. **Secrets via `env_file`.** Optional `${APP_DATA_DIR}/data/.env`
   (`required: false`, same pattern as zot24-nworth) carries
   `ANTHROPIC_API_KEY` etc. and git identity; editable over SSH, no rebuild.
6. **Pinned binaries, verified.** herdr releases publish **no checksums** —
   sha256 of the v0.7.5 linux x86_64/aarch64 assets was computed at build time
   and is hardcoded in the Dockerfile (bump with `HERDR_VERSION`):
   - x86_64 `3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253`
   - aarch64 `32e763a1499a6b694b1d708e4f062b743be1da9f34fcfa4d212d6db6fe09a8b9`
   ttyd isn't in Debian bookworm, so the upstream static binary (1.7.7) is
   pinned the same way (hashes cross-checked against its published SHA256SUMS).
   Both binaries are static ELF, so the slim base is sufficient.
7. **Phone path is host-level.** Umbrel apps shouldn't publish ports, so SSH/
   Mosh terminates on the **host** (over Tailscale, never router-forwarded);
   the README ships a `/usr/local/bin/herdr` wrapper that `docker exec`s into
   the container (with/without TTY), which makes plain `herdr`, Moshi's
   `herdr session list --json` picker, and laptop `herdr --remote` all work.
   Mosh is in the image for completeness but `mosh-server` belongs on the host.
8. **Local dev uses a named volume.** macOS Docker Desktop bind mounts
   (virtiofs) can't host Unix sockets — `herdr server` dies with EINVAL — and
   show misleading ownership. Real Umbrel (Linux) bind mounts are unaffected.

## Open questions / known gaps

- **Stale socket after unclean stop:** entrypoint starts `herdr server` and
  lets a ttyd attach respawn one if it died, but a stale `herdr.sock` after a
  hard kill hasn't been exercised on real hardware. If attach fails, remedy is
  `docker exec … herdr server stop` or deleting the socket; consider a
  defensive `herdr server stop || true` pre-start if this shows up.
- **First-boot UX:** config is seeded with `onboarding = false`; users finish
  setup (integrations) manually in the terminal. Could pre-seed more defaults
  (theme, `terminal.default_shell`) once real usage informs them.
- **`herdr update` inside the container is a no-op by design** (root-owned
  binary; updates ship as app updates). If Herdr's in-TUI update nag is
  noisy, suppress via config once confirmed.
- **Icon is a placeholder.** Real `icon.svg` + gallery shots (1440×900) must
  land in `zot24/umbrel-apps-gallery/zot24-herdr/` before the store listing
  looks right; `umbrel-app.yml` already points there.
- **Repo home:** the app lives in the
  [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps) store repo as
  `zot24-herdr/` (developed in a scratch repo at `~/code/herdr-umbrel`, then
  merged in via PR; the scratch repo can be archived). The CI workflow is
  `.github/workflows/build-herdr.yml` at the store repo root.
- **Digest pinning is CI-dependent:** install only works after the *Build:
  Herdr* workflow has run once and committed the `@sha256` pin.

## How to test on a real Umbrel box

1. Push this repo; run the *Build: Herdr* workflow (or push a `server/`
   change to `main`) so `docker-compose.yml` gets its pinned digest.
2. On the Umbrel: **App Store → Community App Stores → Add** →
   `https://github.com/zot24/umbrel-apps`, then install **Herdr**.
3. Open the app tile → Umbrel login → Herdr TUI in the browser. Split a pane,
   start a long-running command, close the tab, reopen — it's still there.
4. `ssh umbrel` → `docker exec -it zot24-herdr_server_1 herdr` → same session.
5. Add the README's `/usr/local/bin/herdr` wrapper on the host; from a laptop
   with Herdr: `herdr --remote umbrel`. From a phone: Moshi over Tailscale.
6. Persistence: note a workspace, then **Apps → Herdr → Restart**; the
   session layout should restore. `docker exec … herdr session list` → running.
7. Agents: in the web terminal,
   `npm install -g @anthropic-ai/claude-code && herdr integration install claude`,
   put `ANTHROPIC_API_KEY` in the app data `.env`, restart the app, launch
   claude in a pane, detach, reattach from the phone.
8. Update flow: bump `HERDR_VERSION` + both sha256 args in
   `server/Dockerfile`, bump `version` in `umbrel-app.yml` + `VERSION`, push;
   the workflow rebuilds and repins; Umbrel offers the update.
