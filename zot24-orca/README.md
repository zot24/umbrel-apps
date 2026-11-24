# Orca for Umbrel

A headless [Orca](https://orca.dev/docs/remote-servers) remote server. The Umbrel holds the projects, terminals, and agent sessions. You use them from the Orca desktop app or the Orca phone app over Tailscale.

This packages the official Linux server tarball (`orca-ide`), not the desktop app. It is pinned to Orca **1.4.272**.

## What you need

- Tailscale on the Umbrel (the official Tailscale app is fine) and on the laptop or phone
- Both signed in to the same tailnet
- The Orca desktop app, close to version 1.4.272

## Set up

1. Install the app and open the tile. Sign in to Umbrel, then enter the password Umbrel shows on the tile.
2. On the Umbrel, find its Tailscale address. In the Tailscale app that is the `100.` address, or run `tailscale ip -4` on the host. A MagicDNS name works too.
3. Paste that address on the tile and save. Leave the port off. Clients use **6768**.
4. When the status says Ready, copy the pairing link. In the desktop app: **Settings → Remote Orca Servers → Add Server**, paste the link, and connect.
5. Open the shell on the tile and sign the agents in on this machine:

```bash
npm install -g @anthropic-ai/claude-code
orca-ide account add --agent claude
orca-ide account add --agent codex
orca-ide account list
orca-ide auth login
```

Clone repos under `/data/workspaces`. That directory, Orca's state (`/data/orca`), and npm global installs (`/data/npm-global`) are on the app data volume.

The pairing link is a credential. Sending a new one replaces the previous unused link. Clients that already paired keep their grant until you revoke it.

## What this build does not do

The server-only tarball has no browser panes, dictation, or paired web client. Per-terminal memory caps need a systemd user manager, which this container does not run. Paired clients cannot update the server. Bump the pin in `server/Dockerfile` and ship an app update.

Port 6768 is published on every interface of the Umbrel, because that is how Tailscale on the host reaches the container. The process is started with `--refuse-public`, so a client from a public address is refused. Do not forward 6768 on your router.

## Local

```bash
cd zot24-orca
docker compose -f docker-compose.local.yml up --build
```

The tile is at http://127.0.0.1:6770 with no tile password. Port 6768 is bound to loopback. On an Umbrel it is published on every interface.

## Image

`Build: Orca` (`.github/workflows/build-orca.yml`) builds `ghcr.io/zot24/orca-umbrel` for amd64 and arm64 and pins the digest into `docker-compose.yml`. Until that pin lands, Umbrel will not install the app.

The icon at `icon.svg` has to be copied to [umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery) `zot24-orca/icon.svg` before the store shows it.
