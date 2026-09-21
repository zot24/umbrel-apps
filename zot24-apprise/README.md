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

  Gitea Mirror     ──►  apprise:8000/notify/gitea-mirror
  (Docker network, bypasses the proxy)

  ntfy clients     ──►  apprise-ntfy:8080/<key>   (Komodo Ntfy, curl, Kuma, HA)
                        ingest formats {title, body}
                   ──►  apprise:8000/notify/<key>
```

`web` is a shared name on the Umbrel network. Use `apprise` for the API and `apprise-ntfy:8080` for ingest. Do not use `zot24-apprise_web_1`: Django rejects underscores in Host. Do not alias ingest as `ntfy`, so a real ntfy app can still be installed.

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
   - Server URL: `http://apprise:8000`
   - Token/path: `gitea-mirror`
   - Send Test Notification

If Docker DNS does not resolve from Gitea Mirror, use this app's `10.21.x.x`
address on the Umbrel network — still do not publish 8000 on the host.

## ntfy ingest (Komodo and anything else)

Komodo's **Ntfy** alerter speaks ntfy: POST to `/<topic>` with a `Title` header
and a text body. This sidecar is that ntfy door, not a Komodo-only adapter.
The topic is an Apprise config key, so other ntfy clients can share it.

1. Open the Apprise tile. Create a configuration key, e.g. `alerts`.
2. Add a Telegram URL (`tgram://<bot-token>/<chat-id>`).
3. Point the source at `http://apprise-ntfy:8080/alerts` (Docker network only).
   - Komodo: Alerter type **Ntfy**, URL `http://apprise-ntfy:8080/alerts`
   - curl from another container: `curl -H 'Title: backup' -d 'ok' http://apprise-ntfy:8080/alerts`
4. Test. Telegram should light up.

Same host, different keys (`/alerts`, `/uptime`, `/home`) if you want separate
Apprise configs. One key if everything should hit the same Telegram chat.

Do not publish port 8080. Do not use Komodo's Slack/Discord/Pushover types if
you want every alert to go through Apprise.

## Local dev

```bash
cd zot24-apprise
python3 ntfy_ingest_test.py
docker compose -f docker-compose.local.yml up
# UI: http://127.0.0.1:8000
# ntfy ingest: http://127.0.0.1:8080/<key>
```

## Security

- Umbrel dashboard login on the tile. Do not port-forward 8000.
- Notify API has no extra key (Gitea Mirror cannot send one). LAN Docker
  only.
- Bot tokens live on this app's data volume.
