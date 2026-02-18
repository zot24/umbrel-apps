# OpenClaw Skill

Expert assistant for OpenClaw (formerly Clawdbot) - the AI assistant framework that connects Claude and other LLMs to messaging platforms.

## What is OpenClaw?

OpenClaw is an AI assistant framework that:
- Connects LLMs (Claude, OpenAI, etc.) to messaging platforms
- Supports WhatsApp, Telegram, Discord, Slack, Signal, iMessage, MS Teams, Google Chat, Matrix, BlueBubbles, Zalo
- Uses a gateway architecture with WebSocket protocol
- Provides workspace management with memory and session persistence
- Supports skills/plugins via AgentSkills-compatible system
- Runs on macOS, iOS, Android, Windows (WSL2), Linux
- Backward-compatible with `clawdbot` and `moltbot` CLI commands

**Documentation**: https://docs.openclaw.ai/

## Installation

```bash
# Add marketplace
/plugin marketplace add zot24/skills

# Install skill
/plugin install openclaw@zot24-skills
```

### Project-Level Installation

Add to your project's `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "openclaw@zot24-skills": true
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/openclaw setup` | Guide through installation and setup |
| `/openclaw install` | Installation methods (Docker, npm, source) |
| `/openclaw cli` | CLI command reference |
| `/openclaw concepts` | Core architecture concepts |
| `/openclaw gateway` | Gateway configuration and troubleshooting |
| `/openclaw channels` | All messaging channel configurations |
| `/openclaw channel <name>` | Configure specific channel |
| `/openclaw providers` | LLM provider setup |
| `/openclaw tools` | Tools and skills system |
| `/openclaw automation` | Webhooks, cron, polling |
| `/openclaw web` | Web interfaces (webchat, dashboard, TUI) |
| `/openclaw nodes` | Mobile/desktop nodes, media capabilities |
| `/openclaw platforms` | Platform-specific guides |
| `/openclaw diagnose` | Troubleshoot issues |
| `/openclaw sync` | Update docs from upstream |
| `/openclaw help` | Show available commands |

### `/openclaw setup`
Guide through installation and initial configuration:
- Check prerequisites (Node.js 22+)
- Install via `npm install -g openclaw@latest`
- Configure `openclaw onboard --install-daemon`
- Set up authentication (API keys or OAuth)

### `/openclaw channel <name>`
Configure a specific messaging channel:

| Channel | Setup |
|---------|-------|
| `whatsapp` | QR code login, DM policies, self-chat mode |
| `telegram` | @BotFather token, group settings, streaming |
| `discord` | Bot creation, intents, permissions, invite |
| `slack` | App creation, Socket Mode, tokens and scopes |
| `signal` | signal-cli setup |
| `imessage` | macOS Full Disk Access permission |
| `msteams` | App registration, appId/appPassword |
| `googlechat` | Google Workspace setup |
| `matrix` | Homeserver configuration |
| `bluebubbles` | BlueBubbles server setup |
| `zalo` | Zalo OA configuration |

### `/openclaw diagnose`
Troubleshoot common issues:
1. Run `openclaw doctor --verbose`
2. Check gateway status
3. Verify channel connections
4. Review log files at `/tmp/openclaw/`
5. Provide specific fixes

### `/openclaw gateway`
Help with gateway configuration:
- Starting: `openclaw gateway --port 18789`
- Health check: `openclaw gateway health`
- Remote access via SSH/Tailscale
- Hot reload configuration

### `/openclaw skills`
Guide on creating and managing OpenClaw skills:
- SKILL.md structure and frontmatter
- Skill locations and precedence
- ClawdHub installation: `clawdhub install <skill>`
- Configuration in `openclaw.json`

### `/openclaw memory`
Configure the memory system:
- Daily files: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
- Memory search with embeddings
- Provider configuration (OpenAI/local)

### `/openclaw sync`
Update documentation from upstream https://docs.openclaw.ai/

### `/openclaw diff`
Check for documentation changes without modifying.

### `/openclaw help`
Show available commands.

## Natural Language

The skill auto-activates when you mention OpenClaw topics:
- "How do I set up WhatsApp with OpenClaw?"
- "My Telegram bot isn't receiving messages"
- "Configure Discord for OpenClaw"
- "OpenClaw gateway won't start"
- "Create an OpenClaw skill"
- "Set up memory search"

## Quick Start

### Install OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### Configure Authentication

```bash
# Option 1: API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Option 2: Reuse Claude Code credentials
claude setup-token
```

### Start Gateway

```bash
openclaw gateway
```

### Set Up WhatsApp

```bash
openclaw channels login
# Scan QR code with your phone
```

### Configuration File

Location: `~/.openclaw/openclaw.json` (also reads `~/.clawdbot/` for backward compat)

```json
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789
  },
  "channels": {
    "whatsapp": { "enabled": true },
    "telegram": { "enabled": true, "botToken": "123:abc" },
    "discord": { "enabled": true, "botToken": "..." },
    "slack": { "enabled": true, "appToken": "xapp-...", "botToken": "xoxb-..." }
  },
  "agents": {
    "defaults": {
      "workspace": "~/openclaw",
      "timeoutSeconds": 600
    }
  }
}
```

## Coverage

The skill covers all major OpenClaw documentation:

| Section | Topics |
|---------|--------|
| **Installation** | Quick install, prerequisites, post-install setup, authentication |
| **Architecture** | Gateway, control-plane clients, nodes, WebChat, wire protocol |
| **Gateway** | Starting, commands, configuration, hot reload |
| **WhatsApp** | Setup, DM policies, self-chat mode, troubleshooting |
| **Telegram** | Bot setup, group settings, forum topics, streaming |
| **Discord** | Bot creation, intents, permissions, features |
| **Slack** | App creation, Socket Mode, tokens, scopes, threading |
| **Signal** | signal-cli setup |
| **iMessage** | macOS only, Full Disk Access |
| **MS Teams** | App registration |
| **Google Chat** | Google Workspace integration |
| **Matrix** | Homeserver configuration |
| **BlueBubbles** | iMessage replacement via BlueBubbles server |
| **Zalo** | Zalo OA configuration |
| **CLI** | Message sending, agent commands, pairing, diagnostics |
| **Agent Loop** | Execution flow, timeouts, event streams |
| **Memory** | Daily files, long-term, search, providers |
| **System Prompt** | Bootstrap files, time handling |
| **Skills** | Creation, locations, ClawdHub |
| **Providers** | Anthropic, OpenAI, others |
| **Troubleshooting** | Common issues, diagnostic commands, logs |
| **Platforms** | macOS, iOS/Android, Linux, Windows WSL2, VPS |
| **Remote Access** | SSH tunneling, Tailscale, Bonjour |
| **Automation** | Webhooks, cron jobs, Gmail integration |

## Common Issues

### Gateway Won't Start

```bash
# Check port availability
lsof -i :18789

# Verify config
openclaw doctor

# Check logs
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# Force restart
openclaw gateway --force
```

### WhatsApp Not Connecting

```bash
# Re-scan QR code
openclaw channels login

# Check status
openclaw gateway status

# Note: Use Node.js, not Bun (Bun unreliable for WhatsApp)
```

### Messages Not Received

1. Check DM policy settings in `openclaw.json`
2. Verify pairing approvals: `openclaw pairing list`
3. Check allowlist configuration

### Agent Errors

1. Verify API key: `echo $ANTHROPIC_API_KEY`
2. Check OAuth: `~/.openclaw/credentials/oauth.json`
3. Review timeout settings

## Keeping Updated

### Check for Changes

```bash
/openclaw diff
```

### Sync with Upstream

```bash
/openclaw sync
```

### Upstream Sources

| Section | URL |
|---------|-----|
| Getting Started | https://docs.openclaw.ai/start/getting-started |
| Architecture | https://docs.openclaw.ai/concepts/agent |
| Gateway | https://docs.openclaw.ai/gateway |
| WhatsApp | https://docs.openclaw.ai/channels/whatsapp |
| Telegram | https://docs.openclaw.ai/channels/telegram |
| Discord | https://docs.openclaw.ai/channels/discord |
| Slack | https://docs.openclaw.ai/channels/slack |
| Memory | https://docs.openclaw.ai/concepts/memory |
| Skills | https://docs.openclaw.ai/tools/skills |
| CLI Reference | https://docs.openclaw.ai/tools/agent-send |

## Skill Structure

```
openclaw/
├── .claude-plugin/
│   └── plugin.json       # Skill manifest
├── commands/
│   └── openclaw.md       # Slash command router
├── skills/
│   └── openclaw/
│       ├── SKILL.md      # Overview (~100 lines)
│       └── docs/         # Detailed documentation
│           ├── install.md
│           ├── cli.md
│           ├── concepts.md
│           ├── gateway.md
│           ├── channels.md
│           ├── providers.md
│           ├── tools.md
│           ├── automation.md
│           ├── web.md
│           ├── nodes.md
│           └── platforms.md
├── sync.json             # Sync configuration for CI
├── .gitignore
└── README.md
```

## Resources

- [OpenClaw Documentation](https://docs.openclaw.ai/)
- [ClawdHub Skills Registry](https://clawdhub.com)
- [AgentSkills Specification](https://agentskills.io)

## License

MIT
