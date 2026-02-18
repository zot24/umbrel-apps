<!-- Source: https://getopenclaw.ai/docs/configuration, https://getopenclaw.ai/docs/gateway, https://getopenclaw.ai/docs/channels, https://getopenclaw.ai/docs/skills, https://getopenclaw.ai/docs/troubleshooting, https://github.com/openclaw/openclaw README -->

# OpenClaw CLI

Complete reference for OpenClaw command-line interface.

## Message Commands

```bash
# Send message
openclaw message send --channel whatsapp --to +1234567890 --message "Hello"
openclaw message send --channel telegram --to @user --message "Photo" --media ./photo.jpg
openclaw message send --channel discord --to channel:123456789 --message "Hello"
openclaw message send --channel slack --to #general --message "Hello"

# Send poll
openclaw message poll --channel discord --to channel:123 \
  --poll-question "Lunch?" --poll-option Pizza --poll-option Sushi

# React
openclaw message react --channel slack --message-id 123 --emoji thumbsup

# Broadcast
openclaw message send --broadcast all-social --message "Announcement!"
```

---

## Gateway Commands

```bash
openclaw gateway start              # Start as background daemon
openclaw gateway start --daemon     # Explicit daemon mode
openclaw gateway run                # Start in foreground (debugging)
openclaw gateway --port 18789       # Custom port (default: 18789)
openclaw gateway --bind loopback    # Bind address (loopback or all)
openclaw gateway --dev              # Development mode
openclaw gateway --allow-unconfigured  # Allow without full config
openclaw gateway --force            # Kill existing gateway first
openclaw gateway --verbose          # Verbose output
openclaw gateway status             # Check status
openclaw gateway health             # Health check
openclaw gateway stop               # Stop daemon
openclaw gateway restart            # Restart daemon
openclaw gateway discover           # Find gateways on network
openclaw gateway --tailscale serve  # Serve via Tailscale (tailnet-only HTTPS)
openclaw gateway --tailscale funnel # Public HTTPS via Tailscale (requires password auth)
openclaw gateway logs               # View gateway logs
```

### System Service (macOS)

```bash
openclaw service install            # Install as launchd service (auto-start on boot)
openclaw service start              # Start system service
```

### PM2 Deployment

```bash
npm install -g pm2
pm2 start openclaw -- gateway start
pm2 save
pm2 startup
```

### Tailscale Configuration

```json
{
  "gateway": {
    "tailscale": {
      "mode": "off|serve|funnel",
      "resetOnExit": true
    },
    "bind": "loopback",
    "auth": {
      "mode": "password",
      "allowTailscale": false
    }
  }
}
```

Modes: `off` (default, no automation), `serve` (tailnet-only HTTPS), `funnel` (public HTTPS, requires password auth).

### Gateway Health Output

`openclaw status` displays: gateway state (running/stopped), connected channels, active sessions, and memory usage.

---

## Agent Commands

```bash
openclaw agent "What's the weather?"              # Simple query
openclaw agent --message "Ship checklist"          # Named arg
openclaw agent --model anthropic/claude-opus-4-6 "Complex task"  # Specific model
openclaw agent --workspace ~/myproject "Review"    # With workspace
openclaw agent --stream "Generate a story"         # Stream output
openclaw agent --thinking high "Deep analysis"     # Thinking level (off|minimal|low|medium|high|xhigh)
```

---

## Channel Commands

```bash
openclaw channels login                  # WhatsApp QR scan / device link
openclaw channels login --channel telegram
openclaw channels status                 # Show connected channels
openclaw pairing list                    # Pending DM pairing requests
openclaw pairing approve <channel> <code>  # Approve unknown DM sender
openclaw pairing deny <channel> <code>     # Deny unknown DM sender
```

### DM Security

Default: `dmPolicy="pairing"` -- unknown senders receive a pairing code and the bot does not process their message until approved.

Open DM access (requires explicit opt-in):

```json
{
  "dmPolicy": "open",
  "allowFrom": ["*"]
}
```

Policies: `open`, `pairing` (default), `allowlist`.

---

## Chat Commands (In-Channel)

Available in WhatsApp, Telegram, Slack, Discord, Google Chat, MS Teams, WebChat:

| Command | Description |
|---------|-------------|
| `/status` | Compact session status (model, tokens, cost) |
| `/mesh <goal>` | Auto-plan + run multi-step workflow (`/mesh plan\|run\|status\|retry`) |
| `/new` or `/reset` | Reset session / clear context |
| `/compact` | Compact context into summary |
| `/think <level>` | Set thinking: `off\|minimal\|low\|medium\|high\|xhigh` |
| `/verbose on\|off` | Toggle verbose output |
| `/usage off\|tokens\|full` | Control per-response usage footer |
| `/activation mention\|always` | Group activation mode toggle (groups only) |
| `/elevated on\|off` | Toggle elevated bash access per-session (requires allowlist) |
| `/restart` | Restart gateway (owner-only in groups) |
| `/agent <name>` | Switch to a named agent (e.g., `/agent work`, `/agent code`) |

---

## Model Commands

```bash
openclaw models list                        # View available models
openclaw models list --provider anthropic   # Filter by provider
openclaw models set anthropic/claude-opus-4-6  # Set primary model
openclaw models status --probe              # Test connectivity and auth
```

### Supported Providers

- **Anthropic**: `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-20250514`, `anthropic/claude-3-5-haiku-20241022`
- **OpenAI**: `openai/gpt-4o`
- **Google**: `google/gemini-2.0-flash`
- **MiniMax**: `minimax/MiniMax-M2.1`

### Model Configuration

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": [
          "anthropic/claude-sonnet-4-20250514",
          "minimax/MiniMax-M2.1",
          "openai/gpt-4o"
        ]
      },
      "models": {
        "anthropic/claude-opus-4-6": {
          "alias": "opus",
          "params": {
            "cacheControlTtl": "1h",
            "cacheRetention": "short",
            "temperature": 0.7,
            "maxTokens": 8192
          }
        }
      }
    }
  }
}
```

Model params: `alias` (short name), `temperature` (0-2), `maxTokens`, `cacheControlTtl` (e.g., '1h'), `cacheRetention` ('short', 'medium', 'long').

---

## Plugin Commands

```bash
openclaw plugins list                        # List installed plugins
openclaw plugins add <plugin-name>           # Install from npm (e.g., @getfoundry/unbrowse-openclaw)
openclaw plugins enable <plugin>             # Enable plugin
openclaw plugins disable <plugin>            # Disable plugin
openclaw plugins update                      # Update all plugins
```

### Plugin Configuration

```json
{
  "plugins": {
    "entries": {
      "telegram": { "enabled": true },
      "unbrowse-openclaw": {
        "enabled": true,
        "credentialSource": "auto"
      }
    },
    "installs": {
      "unbrowse-openclaw": {
        "source": "npm",
        "spec": "@getfoundry/unbrowse-openclaw",
        "version": "0.5.2"
      }
    }
  }
}
```

---

## Skills Commands

```bash
openclaw skills list                              # List available/installed skills
openclaw skills install <skill-slug>              # Install skill
openclaw skills config <skill> set <key> <value>  # Configure a skill
openclaw skills run <skill> <command>             # Run skill command
openclaw skills update --all                      # Update all skills
openclaw skills remove <skill-name>               # Remove a skill
```

ClawHub marketplace: `clawdhub install <skill-name>` (e.g., `clawdhub install gog`, `clawdhub install github`, `clawdhub install notion`, `clawdhub install weather`)

### Skills Configuration

```json
{
  "skills": {
    "install": { "nodeManager": "bun" },
    "entries": {
      "nano-banana-pro": { "apiKey": "${NANO_BANANA_KEY}" },
      "sag": { "apiKey": "${SAG_API_KEY}" }
    }
  }
}
```

### Built-in Skills (No Installation Required)

- Web Search (Brave Search)
- Web Fetch (read web pages)
- Browser automation (Chrome/Chromium with CDP)
- File System (read/write)
- Shell (execute commands)

---

## Update Commands

```bash
openclaw update check                        # Check for available updates
openclaw update run                          # Apply update
openclaw update rollback                     # Rollback to previous version
openclaw update --channel stable             # Switch to stable release channel
openclaw update --channel beta               # Switch to beta release channel
openclaw update --channel dev                # Switch to dev release channel
```

### Release Channels

| Channel | Tags | npm dist-tag | Description |
|---------|------|--------------|-------------|
| `stable` | `vYYYY.M.D` | `latest` | Tagged releases |
| `beta` | `vYYYY.M.D-beta.N` | `beta` | Prerelease tags |
| `dev` | main branch HEAD | `dev` | Latest development |

### Update Configuration

```json
{
  "update": {
    "checkOnStart": true,
    "autoUpdate": false,
    "channel": "stable"
  }
}
```

---

## Configuration Commands

```bash
openclaw onboard                             # Run setup wizard
openclaw onboard --install-daemon            # With daemon setup
openclaw onboard --anthropic-api-key "key"   # Non-interactive
openclaw config show                         # View current config
openclaw config get gateway.port             # Get specific value
openclaw config set gateway.port 18790       # Set specific value
openclaw config set agents.defaults.model.primary "anthropic/claude-sonnet-4-20250514"
openclaw config set channels.telegram.botToken "YOUR_BOT_TOKEN"
openclaw config wizard                       # Generate config interactively
openclaw config validate                     # Validate config for errors
openclaw config reset                        # Reset to defaults
```

### Config File Locations

| Location | Type | Description |
|----------|------|-------------|
| `~/.openclaw/openclaw.json` | JSON | Main configuration file |
| `~/.openclaw/.env` | dotenv | Environment variables (API keys, secrets) |
| `~/.openclaw/agents/` | Directory | Per-agent config overrides |
| `~/.openclaw/agents/{id}/SOUL.md` | Markdown | Per-agent personality/identity |
| `~/.openclaw/skills/` | Directory | Installed skills and configs |
| `~/.openclaw/plugins/` | Directory | Installed plugins |
| `~/.openclaw/memory/` | Directory | Conversation memory and context |
| `~/.openclaw/credentials/` | Directory | Channel credentials (e.g., WhatsApp) |
| `~/clawd/` | Directory | Default workspace for file operations |

### Workspace Prompt Files

- `AGENTS.md` -- agent instructions
- `SOUL.md` -- agent personality
- `TOOLS.md` -- tool instructions

### Agent Configuration

```json
{
  "agents": {
    "defaults": {
      "workspace": "/Users/you/clawd",
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "1h",
        "maxTokens": 150000
      },
      "compaction": { "mode": "safeguard" },
      "heartbeat": { "every": "30m" },
      "maxConcurrent": 4,
      "subagents": { "maxConcurrent": 8 }
    }
  }
}
```

Settings: `contextPruning.mode` ('cache-ttl', 'sliding', 'none'), `compaction.mode` ('safeguard', 'aggressive', 'none').

### Secrets (Environment File)

`~/.openclaw/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
TELEGRAM_BOT_TOKEN=123456:ABC...
DISCORD_BOT_TOKEN=MTIz...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
GATEWAY_TOKEN=your-secret-token
BRAVE_SEARCH_KEY=BSA...
```

Reference in config using `${VAR_NAME}` syntax (e.g., `"botToken": "${TELEGRAM_BOT_TOKEN}"`).

---

## Diagnostic Commands

```bash
openclaw doctor              # Health check, surface config issues & risky DM policies
openclaw doctor --verbose    # Detailed diagnostics
openclaw doctor --fix        # Auto-fix issues
openclaw status              # Overall status (gateway, channels, sessions, memory)
openclaw status --json       # JSON output
openclaw logs                # View logs
openclaw logs -f             # Follow logs (tail)
openclaw logs --level error  # Filter by level
openclaw logs --channel whatsapp  # Filter by channel
openclaw gateway logs        # View gateway-specific logs
openclaw config validate     # Validate configuration for errors
```

### Troubleshooting Checklist

- Verify logs: `openclaw gateway logs`
- Validate config: `openclaw config validate`
- Check port conflicts: default port is 18789 (docs site says 3737 on older versions)
- Run diagnostics: `openclaw doctor`
- Check channel status: `openclaw channels status`

---

## Sandbox Commands

```bash
openclaw sandbox exec "npm install"                             # Execute command in sandbox
openclaw sandbox exec --network "curl https://api.example.com"  # With network access
openclaw sandbox shell                                          # Interactive sandbox shell
```

Sandbox runs non-main sessions in per-session Docker containers for security.

**Tool allowlist:** bash, process, read, write, edit, sessions_list, sessions_history, sessions_send, sessions_spawn

**Tool denylist:** browser, canvas, nodes, cron, discord, gateway

Configuration:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main"
      }
    }
  }
}
```

---

## Voice Commands

```bash
openclaw talk                # Start voice conversation mode
```

Voice Wake and Talk Mode supported on macOS, iOS, and Android companion apps.

Configuration:

```json
{
  "talk": {
    "apiKey": "${TTS_API_KEY}"
  },
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [
          {
            "type": "cli",
            "command": "whisper",
            "args": ["--model", "base", "{{MediaPath}}"],
            "timeoutSeconds": 60
          }
        ]
      }
    }
  }
}
```

---

## Nodes Commands

```bash
openclaw nodes                # Control connected devices (iOS/Android/macOS)
```

Node actions are routed via `node.invoke`:

| Action | Description |
|--------|-------------|
| `system.run` | Execute local command on node, returns stdout/stderr/exit code |
| `system.notify` | Post user notification on device |
| `canvas.*` | Canvas operations on device |
| `camera.*` | Camera snap/clip (follows TCC permissions) |
| `screen.record` | Screen recording on device |
| `location.get` | Get device location |

---

## Agent-to-Agent Session Tools

Cross-session communication without chat switching:

| Tool | Description |
|------|-------------|
| `sessions_list` | Discover active sessions and agents |
| `sessions_history` | Fetch session transcripts |
| `sessions_send` | Message another session with optional reply-back |
| `sessions_spawn` | Spawn a new agent session |

---

## Hooks Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "boot-md": { "enabled": true },
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": true }
      }
    }
  }
}
```

Built-in hooks: `boot-md` (load BOOT.md on startup), `command-logger` (log executed commands), `session-memory` (persist conversation memory).

---

## Message Settings

```json
{
  "messages": {
    "ackReactionScope": "group-mentions",
    "maxMessageLength": 4096,
    "splitLongMessages": true
  }
}
```

---

## Command Settings

```json
{
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "prefix": "/"
  }
}
```

---

## Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help |
| `--version` | Show version |
| `--verbose` | Verbose output |
| `--json` | JSON output format |
| `--config <path>` | Custom config file |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_CONFIG` | Path to config file |
| `OPENCLAW_WORKSPACE` | Default workspace |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token |
| `OPENCLAW_GATEWAY_PASSWORD` | Gateway password (alternative) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_API_KEY` | Google Gemini API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack app-level token |
| `GATEWAY_TOKEN` | Gateway authentication token |
| `BRAVE_SEARCH_KEY` | Brave Search API key |
| `DEBUG` | Enable debug logging |

Legacy `CLAWDBOT_CONFIG` and `CLAWDBOT_WORKSPACE` variables are still supported for backward compatibility.

---

## Upstream Sources

- https://getopenclaw.ai/docs/configuration
- https://getopenclaw.ai/docs/gateway
- https://getopenclaw.ai/docs/channels
- https://getopenclaw.ai/docs/skills
- https://getopenclaw.ai/docs/troubleshooting
- https://github.com/openclaw/openclaw (README)
