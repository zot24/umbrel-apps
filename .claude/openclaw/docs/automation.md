<!-- Source: https://getopenclaw.ai/docs/configuration, https://openclaw.dog/docs/automation/webhook/, https://zenvanriel.nl/ai-engineer-blog/openclaw-cron-jobs-proactive-ai-guide/ -->

# OpenClaw Automation

Complete guide to automation features in OpenClaw: webhooks, Gmail Pub/Sub, cron jobs, heartbeats, and the event system.

## Webhooks

The Gateway exposes HTTP webhook endpoints when enabled. Webhooks trigger agent actions from external services (GitHub, CI/CD, monitoring, etc.).

### Configuration

```json
{
  "hooks": {
    "enabled": true,
    "token": "shared-secret",
    "path": "/hooks"
  }
}
```

The `token` is mandatory when webhooks are active. The `path` defaults to `/hooks`.

### Authentication

All requests must include the hook token via one of three approaches:

| Method | Example | Status |
|--------|---------|--------|
| `Authorization` header | `Authorization: Bearer <token>` | **Recommended** |
| Custom header | `x-openclaw-token: <token>` | Alternative |
| Query parameter | `?token=<token>` | **Deprecated** (generates warnings) |

### Core Endpoints

#### `/hooks/wake` (POST)

Enqueues system events for the main session:

```bash
curl -X POST http://localhost:18789/hooks/wake \
  -H "Authorization: Bearer shared-secret" \
  -H "Content-Type: application/json" \
  -d '{"text": "New email received", "mode": "now"}'
```

Parameters:
- `text` (required): Event description
- `mode` (optional): `"now"` for immediate heartbeat (default) or `"next-heartbeat"` to queue

#### `/hooks/agent` (POST)

Runs isolated agent turns with full parameter control:

```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer shared-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Summarize the deployment status",
    "name": "deploy-check",
    "channel": "slack",
    "to": "#deployments",
    "deliver": true
  }'
```

Parameters:
- `message` (required): The agent prompt
- `name`: Human-readable identifier for session summaries
- `sessionKey`: Conversation identifier (defaults to random UUID)
- `wakeMode`: `"now"` (default) or `"next-heartbeat"`
- `deliver`: Send responses to messaging channels (default: `true`)
- `channel`: Target platform -- `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost`, `signal`, `imessage`, `msteams`
- `to`: Recipient identifier (phone number, chat ID, channel ID)
- `model`: Override model selection
- `thinking`: Thinking level (`low`, `medium`, `high`)
- `timeoutSeconds`: Maximum execution duration
- `agentId`: Route to specific agent

#### Custom Mapped Hooks

Additional endpoints via `hooks.mappings` configuration. Supports Gmail presets and custom transforms via JavaScript or TypeScript modules.

### Response Codes

| Code | Meaning |
|------|---------|
| 200 | `/hooks/wake` success |
| 202 | `/hooks/agent` success (async) |
| 401 | Authentication failure |
| 400 | Invalid payload |
| 413 | Oversized payload |

### Security Best Practices

- Keep endpoints behind loopback, private networks, or trusted proxies
- Use dedicated hook tokens separate from gateway credentials
- External payloads include safety boundaries by default
- Disable only via `allowUnsafeExternalContent: true` for trusted internal sources

---

## Gmail Integration (Pub/Sub)

Real-time email automation using Google Pub/Sub push notifications instead of polling.

### Architecture

```
Gmail Watch API -> Google Pub/Sub -> gog gmail watch serve -> OpenClaw webhook (/hooks/wake)
```

### Prerequisites

- `gcloud` CLI installed and logged in
- `gogcli` (gog) installed and authorized for the Gmail account
- Tailscale Funnel for public push endpoint (recommended)
- OpenClaw with hooks enabled

### Installation

```bash
# Install gogcli
brew install gog        # macOS
npm install -g gog-cli  # All platforms
```

### Setup

#### Wizard (Recommended)

```bash
openclaw hooks gmail setup
```

The wizard:
1. Uses Tailscale Funnel for the public push endpoint
2. Writes `hooks.gmail` config for `openclaw webhooks gmail run`
3. Enables the Gmail hook preset

#### Manual Setup

```bash
# Authorize Gmail
gogcli auth login --scopes gmail.readonly,gmail.send,gmail.compose,gmail.modify

# Set up Tailscale endpoint
tailscale funnel 8080

# Configure and start
openclaw hooks gmail setup
openclaw hooks gmail status
```

### OAuth Permission Scopes

| Scope | Access |
|-------|--------|
| `gmail.readonly` | Read emails |
| `gmail.send` | Send/compose |
| `gmail.modify` | Labels, archive |
| `gmail.compose` | Create drafts |

### Auto-Renewal

Gmail watches expire after 7 days. When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts `gog gmail watch serve` on boot and auto-renews the watch automatically.

### Tailscale Integration

When `tailscale.mode` is enabled, OpenClaw automatically:
- Sets `hooks.gmail.serve.path` to `/`
- Keeps public path at `hooks.gmail.tailscale.path` (default `/gmail-pubsub`)

### Capabilities

- Email summarization and prioritized briefings
- Draft reply generation matching communication style
- Smart categorization via Gmail labels
- Natural language email search
- Batch operations (archive, mark read)
- Scheduled daily email briefings
- Model overrides per email type for cost optimization

### Privacy

OAuth tokens stay on your machine. Email content is sent to the AI only when explicitly requested. Nothing stored in the cloud.

### Troubleshooting

```bash
gogcli auth status        # Check authorization
gogcli auth whoami        # Verify account
gogcli auth --reset       # Clear and re-authenticate
gogcli gmail list --limit 5  # Test access
openclaw hooks gmail status  # Check webhook status
openclaw logs --tail 100 | grep -i "gmail\|draft\|gog"
```

For Google Workspace accounts, verify third-party app access is enabled.

---

## Cron Jobs

Persistent scheduled task execution. Unlike heartbeats (which run the same check periodically), cron jobs run specific tasks at specific times.

### Three Schedule Types

| Type | Syntax | Behavior |
|------|--------|----------|
| **At** | ISO datetime | One-time, disappears after running |
| **Every** | Interval string | Repeats ("every 30m", "every 6h") |
| **Cron** | 5-field expression | Unix-style (`0 9 * * 1` = 9 AM every Monday) |

### CLI Commands

```bash
# Add a cron job
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"

# Management
openclaw cron list               # List all jobs
openclaw cron remove <name>      # Delete a job
openclaw cron pause <name>       # Pause without removing
openclaw cron resume <name>      # Resume paused job
openclaw cron run <name>         # Manually trigger a job
```

### Common Schedules

| Schedule | Description |
|----------|-------------|
| `0 9 * * *` | Daily at 9 AM |
| `0 9 * * 1-5` | Weekdays at 9 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 1 * *` | First of month |
| `0 9 * * 1` | Every Monday at 9 AM |

### Storage & Persistence

Jobs persist under `~/.openclaw/cron/` directory, surviving system restarts and reboots.

### Session Execution Modes

**Isolated execution** (recommended for most cron jobs):
- Fresh start without conversation history
- Prevents accidental private information leakage
- Enables task-specific model optimization
- Keeps main session history clean

**Main session integration:**
- Scheduled tasks leverage accumulated context from ongoing conversations
- Useful for context-aware reminders

### Heartbeat vs Cron

| Feature | Heartbeat | Cron |
|---------|-----------|------|
| Timing | Every N minutes | Precise schedule |
| Context | Main session | Isolated or main |
| Batching | Multiple checks per turn | Single task |
| Use case | Monitoring, reactive | Scheduled, predictable |
| Model | Uses main model | Can override model |

### Configuration (Heartbeat)

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "30m",
        "prompt": "Check pending items, inbox, and calendar"
      }
    }
  }
}
```

---

## Polling

Periodic checks against external APIs:

```json
{
  "automation": {
    "polling": {
      "enabled": true,
      "jobs": {
        "github-issues": {
          "url": "https://api.github.com/repos/owner/repo/issues",
          "interval": 300000,
          "headers": { "Authorization": "token ${GITHUB_TOKEN}" },
          "handler": "github-issues-handler"
        }
      }
    }
  }
}
```

---

## Auth Monitoring

```json
{
  "automation": {
    "authMonitoring": {
      "enabled": true,
      "checkInterval": 60000,
      "alertChannel": "slack",
      "alertTo": "#alerts",
      "providers": ["anthropic", "openai"]
    }
  }
}
```

Events: `auth.expired`, `auth.revoked`, `auth.refreshed`, `auth.failed`

---

## Event System

```json
{
  "automation": {
    "events": {
      "subscriptions": {
        "message.received": "message-handler",
        "agent.completed": "completion-handler",
        "channel.connected": "connection-handler"
      }
    }
  }
}
```

### Available Events

`message.received`, `message.sent`, `agent.started`, `agent.completed`, `agent.error`, `channel.connected`, `channel.disconnected`

---

## Automation CLI

```bash
openclaw automation list
openclaw automation status
openclaw automation run <job-name>
openclaw automation logs --job <job-name>
openclaw automation pause --all
openclaw automation resume --all
```

---

## Best Practices

### Rate Limiting

```json
{
  "automation": {
    "rateLimit": { "enabled": true, "maxPerMinute": 60, "maxPerHour": 1000 }
  }
}
```

### Sending Custom Data

**Webhook method:**
```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Process this data", "channel": "telegram"}'
```

**File-based ingestion:**
```bash
echo '{"message": "Process this"}' > ~/.openclaw/inbox/email-001.json
```

**Custom channel plugin:** Create custom channels in `~/.openclaw/channels/`

---

## Upstream Sources

- https://openclaw.dog/docs/automation/webhook/
- https://zenvanriel.nl/ai-engineer-blog/openclaw-cron-jobs-proactive-ai-guide/
- https://zenvanriel.nl/ai-engineer-blog/openclaw-gmail-pubsub-automation-guide/
- https://getopenclaw.ai/how-to/gmail-integration
- https://getopenclaw.ai/help/email-gmail-integration
- https://getopenclaw.ai/docs/configuration
