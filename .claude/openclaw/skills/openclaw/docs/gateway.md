<!-- Source: https://getopenclaw.ai/docs/gateway, https://github.com/openclaw/openclaw README -->

# OpenClaw Gateway

Complete guide to the OpenClaw gateway daemon -- the core service that keeps your assistant running 24/7.

## Overview

The Gateway is the central hub that:
- Listens to connected channels (Telegram, WhatsApp, Discord, Slack, iMessage, etc.)
- Routes messages to the AI agent (Pi runtime)
- Handles scheduled tasks (heartbeats, cron jobs, reminders)
- Manages tool execution and responses
- Serves the WebChat UI and Control Panel
- Coordinates device nodes via Node Bridge

Architecture: messaging platforms connect to the Gateway WebSocket (`ws://127.0.0.1:18789`), which coordinates with the agent runtime, CLI tools, WebChat UI, and device nodes.

## Starting the Gateway

```bash
openclaw gateway                              # Basic start (foreground)
openclaw gateway start                        # Start as daemon
openclaw gateway stop                         # Stop the daemon
openclaw gateway restart                      # Restart the daemon
openclaw gateway status                       # Check current state
openclaw gateway logs                         # View activity logs
openclaw gateway --port 18789 --bind loopback # With explicit options
openclaw gateway --dev --allow-unconfigured   # Development mode
openclaw gateway --force                      # Force restart
```

### Service Management (Unified CLI)

```bash
openclaw gateway install          # Install as system service (launchd/systemd)
openclaw gateway install --force  # Reinstall service
openclaw gateway uninstall        # Remove system service
openclaw gateway status --deep    # Deep system scan
openclaw gateway probe            # Connectivity testing
```

---

## Protocol

### Wire Format (WebSocket Protocol v3)

```json
{"type": "req", "id": "uuid", "method": "agent.run", "params": {...}}
{"type": "res", "id": "uuid", "ok": true, "payload": {...}}
{"type": "event", "event": "agent.delta", "payload": {...}}
```

### Connection Handshake

1. Client connects to `ws://127.0.0.1:18789`
2. Client sends `connect` frame with `clientId` and `clientType` (operator, node, etc.)
3. Gateway responds with channels and health snapshot

### Client Types

- **operator**: CLI, Control UI, remote management
- **node**: Device nodes (iOS/Android/macOS) with `role: "node"`
- **channel**: Messaging platform adapters

---

## Bridge Protocol

For mobile nodes (iOS/Android) via TCP with JSONL format on port 18790 (Gateway port + 1):

```json
{"type":"bridge.hello","nodeId":"iphone-xyz","capabilities":["camera","location","audio"]}
```

### Discovery

- iOS: Bonjour service discovery
- Android: mDNS discovery
- Service advertised as `_openclaw._tcp`
- Nodes send capability manifests upon connection

### Commands via node.invoke

`canvas.*`, `camera.snap`, `camera.clip`, `screen.record`, `location.get`

---

## Configuration

```json
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789,
    "maxConnections": 100
  }
}
```

Configuration file location: `~/.openclaw/openclaw.json`

### Bind Options

| Value | Address | Auth Required | Use Case |
|-------|---------|---------------|----------|
| `loopback` | `127.0.0.1` | No | Local-only (default, most secure) |
| `lan` | `0.0.0.0` | **Yes** | Docker, LAN access |
| `tailnet` | Tailscale IP | **Yes** | Mesh network access |
| `auto` | Varies | Varies | Defaults to loopback, switches to tailnet if configured |

**Docker**: Use `bind: "lan"` with authentication. Port mapping: `0.0.0.0:18789:18789`.

### Mode Options

- `local`: Standard local deployment
- `cloud`: Cloud/VPS deployment

---

## Port Reference

| Port | Protocol | Service |
|------|----------|---------|
| 18789 | HTTP + WebSocket | Gateway + WebChat at `/chat` + Control UI |
| 18790 | TCP (JSONL) | Bridge (mobile nodes) = Gateway port + 1 |
| 18793 | HTTP | Canvas file serving |

---

## Authentication

### Token Auth (Recommended)

```json
{
  "gateway": {
    "auth": {
      "token": "your-secure-token"
    }
  }
}
```

Or via environment variable: `OPENCLAW_GATEWAY_TOKEN` (legacy: `CLAWDBOT_GATEWAY_TOKEN`).

Alternatively set via: `gateway.auth.password` for password-based auth.

### Insecure Auth Mode

For trusted networks only (significantly reduces security):

```json
{
  "gateway": {
    "allowInsecureAuth": true
  }
}
```

### WebCrypto Requirements

Browsers require HTTPS for remote access due to WebCrypto security constraints. Non-localhost HTTP connections are blocked. Use Tailscale Serve or SSH tunnels for remote access.

---

## Pairing

Default security: DM pairing mode. Unknown senders receive short pairing codes; the assistant does not process their messages until approved.

```bash
openclaw pairing list
openclaw pairing approve <code>
openclaw pairing deny <code>
```

```json
{
  "pairing": { "enabled": true, "codeExpiry": 300, "maxPending": 10 }
}
```

### Device Pairing (Remote UI)

When accessing the Control UI remotely (via Tailscale, LAN IP, etc.), the browser needs device pairing approval. Local `127.0.0.1` connections auto-approve; remote connections need explicit approval.

```bash
openclaw devices list          # List pending pairing requests
openclaw devices approve <id>  # Approve a device
```

---

## Health & Doctor

```bash
openclaw gateway health
openclaw gateway status          # Gateway status, connected channels, active sessions, memory
openclaw status --all            # Comprehensive system check
openclaw doctor --verbose        # Validate API keys, channel configs, file permissions
openclaw doctor --fix            # Auto-fix common issues
openclaw config validate         # Validate configuration
```

### Health Check Endpoint

- RPC method: `gateway.health()`
- HTTP endpoint: `/health` (when control UI enabled)

### Monitoring Checklist

Verify: service runtime status, port listening, WebSocket reachability, auth config, channel connections, model auth, disk space, memory usage.

---

## Logging

```json
{
  "logging": {
    "level": "info",
    "format": "json",
    "file": "~/.openclaw/logs/gateway.log"
  }
}
```

```bash
openclaw logs -f --level error --channel whatsapp
openclaw gateway logs --tail 50    # Recent error history
```

Structured JSONL output for log aggregation.

---

## Security

### Sandbox Mode

```json
{
  "gateway": {
    "sandbox": {
      "mode": "non-main",
      "enabled": true,
      "allowNetwork": false,
      "allowFileSystem": "workspace"
    }
  }
}
```

- Tools run on the host with full access for the main session
- Non-main sessions (groups/channels) can run in per-session Docker sandboxes when `sandbox.mode: "non-main"`
- Treat inbound direct messages as untrusted input

### Secrets Management

Store API keys in `~/.openclaw/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Reference in config via `${ANTHROPIC_API_KEY}` syntax. Set file permissions with `chmod 600`. Never commit `.env` files to git.

---

## Remote Access

### SSH Tunnel (Recommended for VMs)

Keep Gateway on loopback, tunnel from host:

```bash
ssh -L 18789:127.0.0.1:18789 user@server
```

### Tailscale

```bash
openclaw gateway --tailscale serve   # Access via MagicDNS URL (https://machine-name.tailnet/)
openclaw gateway --tailscale funnel  # Public internet access (use with auth!)
```

Tailscale Serve provides automatic identity-based authentication for tailnet clients. Funnel mode requires password authentication.

### Cloudflare Tunnel

```bash
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
cloudflared tunnel run openclaw
```

### mDNS/Bonjour

```bash
openclaw gateway --mdns
openclaw gateway discover
```

---

## OpenAI-Compatible API

The Gateway itself does not expose an OpenAI-compatible endpoint natively. Use **ClawProxy** (community tool) to expose OpenClaw agents as OpenAI-compatible models:

```bash
# ClawProxy: github.com/AijooseFactory/clawproxy
npm install && npm start
# Exposes /v1/models and /v1/chat/completions
# Connects to Gateway via WebSocket (Protocol v3)
# Auto-reconnects and dynamically exposes agents as "Custom Models"
```

Configuration:

```json
{
  "httpPort": 8080,
  "httpHost": "127.0.0.1",
  "gatewayUrl": "ws://127.0.0.1:18789",
  "gatewayToken": "your-token"
}
```

Compatible with OpenWebUI, SillyTavern, LM Studio, and any OpenAI SDK client. Full SSE streaming support with anti-buffering headers.

### Claude Max API Proxy

`claude-max-api-proxy` exposes your Claude Max/Pro subscription as an OpenAI-compatible endpoint.

---

## Multiple Gateway Profiles

Run isolated instances using profiles, each with separate state directories, configs, workspaces, and ports:

```bash
openclaw gateway --profile work
openclaw gateway --profile personal
```

Ports derived from the base port number per profile.

---

## Emergency Recovery

Complete reset (preserves configuration):

```bash
openclaw gateway stop
rm -rf ~/.openclaw/gateway-state/
openclaw gateway start
```

---

## Troubleshooting

**Port in use:**
```bash
lsof -i :18789                    # macOS/Linux
Get-NetTCPConnection -LocalPort 18789  # Windows PowerShell
openclaw gateway --force
```

**Gateway won't start:**
```bash
openclaw gateway              # Run in foreground to see errors
openclaw gateway logs --tail 50
openclaw config validate
```

**Common error codes:**
- 1006 WebSocket: Abnormal closure -- gateway not running or crashed
- 1008 Token mismatch: `gateway.remote.token` must match `gateway.auth.token`
- ECONNREFUSED: Service not listening on port

**Channel disconnections:**
```bash
openclaw channels status
openclaw channels login
```

**Telegram 409 Conflict:** If webhook is set on bot token, long-polling cannot receive updates. Delete webhook: `curl https://api.telegram.org/bot<TOKEN>/deleteWebhook`

**WhatsApp session issues:** Sessions can expire on unfamiliar IP addresses (relevant for VPS migrations).

---

## Upstream Sources

- https://getopenclaw.ai/docs/gateway
- https://github.com/openclaw/openclaw (README)
- https://getopenclaw.ai/help/gateway-crashes-wont-start
- https://getopenclaw.ai/help/dashboard-web-ui-guide
- https://deepwiki.com/openclaw/openclaw/13-deployment
