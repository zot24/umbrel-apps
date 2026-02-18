---
name: openclaw
description: OpenClaw AI assistant framework - connects Claude/LLMs to messaging platforms (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Teams, Google Chat, Matrix, BlueBubbles, Zalo, Mattermost, Twitch). Use for setup, configuration, channels, providers, tools, automation, troubleshooting. Formerly known as Clawdbot.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, WebFetch
---

# OpenClaw Expert

You are an expert on OpenClaw (formerly Clawdbot), the AI assistant framework connecting LLMs to messaging platforms.

## Overview

- Connects Claude, OpenAI, and other LLMs to messaging channels
- Supports WhatsApp, Telegram, Discord, Slack, Signal, iMessage, MS Teams, Google Chat, Matrix, BlueBubbles, Zalo, Mattermost, Twitch
- Gateway architecture with WebSocket protocol
- Workspace management with memory and session persistence
- Skills system via AgentSkills-compatible format
- MCP server support via MCPorter integration
- Runs on macOS, iOS, Android, Windows (WSL2), Linux
- Backward-compatible with `clawdbot` and `moltbot` CLI commands

## Quick Start

```bash
# Install
npm install -g openclaw@latest

# Setup
openclaw onboard --install-daemon

# Configure API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Start gateway
openclaw gateway

# Connect channel
openclaw channels login  # Scan WhatsApp QR
```

## Core Concepts

**Gateway**: Central hub coordinating channels and agent execution (`ws://127.0.0.1:18789`)

**Channels**: Messaging platform integrations (WhatsApp, Telegram, Discord, Google Chat, Matrix, etc.)

**Workspace**: Directory with memory, skills, config (default: `~/openclaw`)

## Documentation

Reference detailed docs for specific topics:

- **[Installation](docs/install.md)** - Docker, npm, source, Ansible, Nix
- **[CLI Commands](docs/cli.md)** - Message sending, gateway control, updates
- **[Core Concepts](docs/concepts.md)** - Architecture, memory, sessions, streaming
- **[Gateway](docs/gateway.md)** - Protocol, config, auth, health, troubleshooting
- **[Channels](docs/channels.md)** - 13+ channels: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Teams, Google Chat, Matrix, BlueBubbles, Zalo, Mattermost, Twitch
- **[Providers](docs/providers.md)** - 20+ providers: Anthropic, OpenAI, Google, OpenRouter, Ollama, Bedrock, and more
- **[Tools & Skills](docs/tools.md)** - Exec, browser, slash commands, MCP servers, ClawdHub
- **[Automation](docs/automation.md)** - Webhooks, Gmail, cron jobs, polling
- **[Web Interfaces](docs/web.md)** - Control panel, dashboard, webchat, TUI
- **[Nodes & Media](docs/nodes.md)** - Camera, images, audio, location, voice
- **[Platforms](docs/platforms.md)** - macOS, iOS, Android, Windows, Linux, VPS

## Common Commands

```bash
openclaw gateway              # Start gateway
openclaw status               # Check status
openclaw doctor               # Health check
openclaw message send --channel whatsapp --to +1234567890 --message "Hello"
openclaw agent "What's the weather?"
```

## Configuration

Main config: `~/.openclaw/openclaw.json` (also reads `~/.clawdbot/` for backward compat)

```json
{
  "gateway": { "port": 18789, "bind": "loopback" },
  "channels": { "whatsapp": { "enabled": true } },
  "agents": { "defaults": { "model": "claude-sonnet-4-20250514" } }
}
```

## Upstream Sources

- **Documentation**: https://docs.openclaw.ai/
- **Repository**: https://github.com/openclaw/openclaw
- **Website**: https://openclaw.ai

## Sync & Update

When user runs `sync`: fetch latest from https://docs.openclaw.ai/ and update docs/ files.
When user runs `diff`: compare current docs/ vs upstream without modifying.
