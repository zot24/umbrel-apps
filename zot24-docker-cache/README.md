# Docker Hub Cache (zot24-docker-cache)

A Docker Hub pull-through cache for an Umbrel, using the official
CNCF Distribution `registry` image in proxy mode, with a read-only
web UI on the Umbrel tile.

- App id: `zot24-docker-cache`
- App version: 3.1.3
- Host port (registry, no login): 25750
- Registry image: `registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c`
- UI image: `joxit/docker-registry-ui:2.6.0@sha256:bb5956a6b378706f1c3a92c947d0a0c606e280460cd9e37c0198caf46399c839`
- Remote: `https://registry-1.docker.io`
- Cache TTL: 7 days, with storage deletes enabled on the registry

The first pull of an image goes to Docker Hub and is stored under
the app data directory. Later pulls of the same image are served
from that copy.

This mirror only covers Docker Hub images. Pulls from ghcr.io,
quay.io, and other registries do not go through it.

## The Umbrel tile (web UI)

The tile opens a read-only page of cached repositories and tags,
behind the Umbrel dashboard login. The UI talks to the registry
over the app's internal network (`http://registry:5000`). It does
not use host port 25750, and it cannot delete images.

Port 25750 is a direct publish of the registry. Docker clients use
that port, and the Umbrel login does not apply to it. Changing the
tile's login setting does not change access to 25750.

## Point Docker at the cache

Replace `<umbrel-host>` with the Umbrel's LAN or Tailscale address.
Do not use the Umbrel tile URL. It is behind the dashboard login.

Because the cache speaks HTTP, Docker needs it listed as an
insecure registry as well as a mirror. Localhost is an exception
and does not need the insecure entry.

### Docker Desktop on a Mac

Open Docker Desktop, then Settings, Docker Engine, and merge this
into the JSON. Then click Apply & Restart.

```json
{
  "registry-mirrors": ["http://<umbrel-host>:25750"],
  "insecure-registries": ["<umbrel-host>:25750"]
}
```

The same file on disk is `~/.docker/daemon.json` for Docker Desktop.

### Linux (including CI runners)

Edit `/etc/docker/daemon.json` (create it if it is missing):

```json
{
  "registry-mirrors": ["http://<umbrel-host>:25750"],
  "insecure-registries": ["<umbrel-host>:25750"]
}
```

Then run `sudo systemctl restart docker`.

### Sibling containers on the Umbrel

Use `http://docker-cache:5000` as the mirror. That alias stays on
the Umbrel app network and does not need the host port.

## If the Umbrel is down

Docker falls back to Docker Hub on its own. Pulls still work. They
just go to Docker Hub and are slower. You do not have to change the
daemon.json for that.

To stop using the cache on purpose, remove the `registry-mirrors`
and `insecure-registries` entries and restart Docker.

## What this is not

- Not a cache for any registry other than Docker Hub.
- Not published to the public internet. Do not add a Cloudflare
  Tunnel hostname for it. Anyone who can reach the port can pull
  through your cache.
