<!-- Source: https://docs.openclaw.ai/channels/whatsapp -->

# OpenClaw Channels

Complete guide to configuring messaging channels. OpenClaw supports 13+ platforms simultaneously.

## WhatsApp

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "pairing",
      "allowFrom": ["+1234567890"]
    }
  }
}
```

### Setup

1. Configure in `~/.openclaw/openclaw.json`
2. Scan QR: `openclaw channels login`
3. Start gateway

### DM Policies

| Policy | Description |
|--------|-------------|
| `pairing` | Unknown senders get approval code (default) |
| `allowlist` | Only specified numbers |
| `open` | Anyone (requires `allowFrom: ["*"]`) |

### Self-Chat Mode

```json
{ "channels": { "whatsapp": { "selfChatMode": true } } }
```

### Troubleshooting

- Use Node.js (not Bun)
- Re-scan QR if disconnected
- Delete `~/.openclaw/whatsapp-session` and re-scan

---

## Telegram (Easiest)

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "pairing",
      "groupPolicy": "open",
      "allowFrom": [123456789],
      "groups": {
        "-1001234567890": { "enabled": true, "agent": "work" }
      },
      "streamMode": "partial",
      "actions": { "reactions": true, "sendMessage": true }
    }
  }
}
```

### Setup

1. Create bot via @BotFather → `/newbot`
2. Copy token
3. Get user ID from @userinfobot
4. Configure and start gateway

### Policies

- `dmPolicy`: `open`, `pairing`, `allowlist`
- `groupPolicy`: `open`, `mention`, `disabled`
- `streamMode`: `partial` (live preview), `block`, `off`

Telegram is the **only** channel with live preview streaming.

---

## Discord

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "botToken": "${DISCORD_BOT_TOKEN}",
      "applicationId": "${DISCORD_APP_ID}",
      "dmPolicy": "pairing",
      "allowedGuilds": ["123456789"],
      "allowedChannels": ["general", "ai-chat"]
    }
  }
}
```

### Setup

1. Create app at Discord Developer Portal
2. Go to Bot → Add Bot
3. Copy token, enable "Message Content Intent"
4. Invite with permissions integer: `274877910016`

### Required Intents

`GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT`, `DIRECT_MESSAGES`

---

## Slack

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "appToken": "${SLACK_APP_TOKEN}",
      "botToken": "${SLACK_BOT_TOKEN}",
      "signingSecret": "${SLACK_SIGNING_SECRET}"
    }
  }
}
```

### Setup

1. Create app at api.slack.com/apps
2. Enable Socket Mode
3. Generate App Token with `connections:write`
4. Add bot token scopes, install to workspace

### Required Scopes

`chat:write`, `im:write`, `channels:history`, `groups:history`, `users:read`, `reactions:read`, `reactions:write`, `files:write`

---

## Signal

```json
{
  "channels": {
    "signal": {
      "enabled": true,
      "number": "+1234567890"
    }
  }
}
```

Requires signal-cli installed and configured.

---

## iMessage

macOS only. Requires Full Disk Access permission.

```json
{
  "channels": { "imessage": { "enabled": true } }
}
```

Grant in System Preferences > Privacy & Security > Full Disk Access.

---

## Microsoft Teams

```json
{
  "channels": {
    "msteams": {
      "enabled": true,
      "appId": "...",
      "appPassword": "..."
    }
  }
}
```

Requires Azure AD app registration and bot channel.

---

## Google Chat

```json
{
  "channels": {
    "googlechat": {
      "enabled": true,
      "serviceAccountKey": "~/.openclaw/credentials/google-chat.json"
    }
  }
}
```

Requires Google Workspace with Chat API enabled and a service account.

---

## Matrix

```json
{
  "channels": {
    "matrix": {
      "enabled": true,
      "homeserver": "https://matrix.org",
      "userId": "@bot:matrix.org",
      "accessToken": "..."
    }
  }
}
```

---

## BlueBubbles

iMessage alternative that works on any platform via a BlueBubbles server running on macOS.

```json
{
  "channels": {
    "bluebubbles": {
      "enabled": true,
      "serverUrl": "http://your-bluebubbles-server:1234",
      "password": "..."
    }
  }
}
```

---

## Zalo

```json
{
  "channels": {
    "zalo": {
      "enabled": true,
      "oaId": "...",
      "oaSecret": "${ZALO_OA_SECRET}"
    }
  }
}
```

Requires Zalo Official Account (OA) credentials.

---

## Mattermost

```json
{
  "channels": {
    "mattermost": {
      "enabled": true,
      "botToken": "${MATTERMOST_BOT_TOKEN}",
      "serverUrl": "https://your-mattermost.com"
    }
  }
}
```

---

## Twitch

```json
{
  "channels": {
    "twitch": {
      "enabled": true,
      "botToken": "${TWITCH_BOT_TOKEN}"
    }
  }
}
```

---

## Broadcast Groups

```json
{
  "channels": {
    "broadcast": {
      "groups": {
        "all-social": {
          "channels": ["discord", "slack", "telegram"],
          "targets": {
            "discord": "channel:123",
            "slack": "#announcements",
            "telegram": "@channel"
          }
        }
      }
    }
  }
}
```

```bash
openclaw message send --broadcast all-social --message "Announcement!"
```

---

## Multiple Channels

OpenClaw supports all channels simultaneously. Add each to your config:

```json
{
  "channels": {
    "telegram": { "enabled": true, "botToken": "..." },
    "discord": { "enabled": true, "botToken": "..." },
    "slack": { "enabled": true, "botToken": "...", "appToken": "..." },
    "whatsapp": { "enabled": true }
  }
}
```

---

## Troubleshooting

**Channel not connecting:**
- Verify credentials/tokens
- `openclaw doctor`
- `openclaw logs --channel <name>`

**Messages not received:**
- Check DM policy settings
- Verify pairing approvals: `openclaw pairing list`

---

## Upstream Sources

- https://docs.openclaw.ai/channels/whatsapp
- https://docs.openclaw.ai/channels/telegram
- https://docs.openclaw.ai/channels/discord
- https://docs.openclaw.ai/channels/slack
- https://docs.openclaw.ai/channels/signal
- https://docs.openclaw.ai/channels/imessage
- https://docs.openclaw.ai/channels/msteams
- https://docs.openclaw.ai/channels/googlechat
- https://docs.openclaw.ai/channels/matrix
- https://docs.openclaw.ai/channels/bluebubbles
- https://docs.openclaw.ai/channels/zalo
- https://github.com/openclaw/openclaw
