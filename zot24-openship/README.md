# Openship (Umbrel)

Control plane only. Upstream: https://github.com/oblien/openship

## What this is

Postgres + Redis + API + dashboard, Umbrel tile on **port 3001**.

## What this is not

- Not Openship's OpenResty edge on host `:80`/`:443` (Umbrel owns those).
- Not a PaaS on this box. No Docker socket, so it will not build/run apps here.
- Add remote servers from the UI if you want deploys.

## Install

Community store → Openship. Hermes cannot install Umbrel apps.

Open the tile. First visit creates the admin (`OPENSHIP_AUTH_MODE=local`).
Invite-only after that. The tile is not localhost, so zero-auth is off.

## 403 ORIGIN_REJECTED

The API only trusts `http://umbrel.local:3001` unless you override it.
`data/.env` is root-owned after install — put `OPENSHIP_PUBLIC_URL` in
`docker-compose.yml` instead, then restart the app.

## Upgrade

Bump `version` in `umbrel-app.yml` and the two `ghcr.io/oblien/openship-*` image pins to a new **index** digest (`amd64` + `arm64`).
