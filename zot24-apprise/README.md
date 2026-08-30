# Apprise for Umbrel

Notification gateway for sibling apps. Wraps the official
[Apprise API](https://github.com/caronc/apprise-api) image
(`caronc/apprise`) so Gitea Mirror, Gitea, and scripts can push to
Telegram (and 100+ other services) without each one speaking the backend.

- **App ID**: `zot24-apprise`
- **UI host port**: 8000 (Umbrel app_proxy)
- **Notify API**: container port 8000, **not** published on the host
- **Upstream**: `caronc/apprise:latest` (sha256-pinned)

## Why this exists

Gitea Mirror's generic **Webhook** pointed at `api.telegram.org/bot…/sendMessage`
does not work. Telegram wants `{chat_id, text}`. Gitea Mirror posts
`{title, message, type, timestamp}`. Wrong contract.

Gitea Mirror already has an **Apprise API** provider. This app is that API.

## How it's wired

```
  browser (Umbrel login)
        |
        v
  app_proxy :8000  ──►  Apprise UI :8000
                          /config volume: named keys → notify URLs

  Gitea Mirror     ──►  zot24-apprise_web_1:8000/notify/gitea-mirror
  (Docker network, bypasses the proxy)
```

## Installing on Umbrel

Community store is already:

```
https://github.com/zot24/umbrel-apps
```

Install **Apprise**. Image is pinned (`caronc/apprise:latest@sha256:…`).
No custom GHCR build required.

Hermes cannot click Install. You have to.

## Gitea Mirror → Telegram

1. Install this app. Open the tile (Umbrel login).
2. Create a configuration with key `gitea-mirror`.
3. Add a Telegram URL (`tgram://<bot-token>/<chat-id>`). Keep the token
   in 1Password, not chat.
4. In Gitea Mirror → Configuration → Notifications:
   - Enable
   - Provider: **Apprise API**
   - Server URL: `http://zot24-apprise_web_1:8000`
   - Token/path: `gitea-mirror`
   - Send Test Notification

If Docker DNS does not resolve from Gitea Mirror, use this app's `10.21.x.x`
address on the Umbrel network — still do not publish 8000 on the host.

## Local dev

```bash
cd zot24-apprise
docker compose -f docker-compose.local.yml up
# UI: http://127.0.0.1:8000
```

## Security

- Umbrel dashboard login on the tile. Do not port-forward 8000.
- Notify API has no extra key (Gitea Mirror cannot send one). LAN Docker
  only.
- Bot tokens live on this app's data volume.
