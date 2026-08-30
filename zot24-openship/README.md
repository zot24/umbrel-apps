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

Open the tile. First visit creates the admin. Invite-only after that.

## 403 ORIGIN_REJECTED

The API only trusts `http://umbrel.local:3001` unless you override it.

```
# on the Umbrel host
printf 'OPENSHIP_PUBLIC_URL=http://YOUR-HOST:3001\n' \
  > /home/umbrel/umbrel/app-data/zot24-openship/data/.env
```

Restart the app. Do not put that file in git. Do not paste secrets in Telegram.

## Upgrade

Bump `version` in `umbrel-app.yml` and the two `ghcr.io/oblien/openship-*` image pins to a new **index** digest (`amd64` + `arm64`).
