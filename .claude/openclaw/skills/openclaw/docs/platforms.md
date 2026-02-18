<!-- Source: https://deepwiki.com/openclaw/openclaw/13-deployment, https://getopenclaw.ai/help/installation-guide-all-platforms, https://github.com/openclaw/openclaw README -->

# OpenClaw Platforms

Platform-specific installation, configuration, and deployment guide.

## Requirements

- **Node.js >= 22** (mandatory)
- Compatible OS: macOS, Linux, Windows (WSL2 only)
- API credentials: Anthropic (recommended -- Opus 4.6 strongly suggested) or OpenAI

---

## macOS

Full support including native menu bar app with voice overlay.

### Installation

```bash
# npm (recommended)
npm install -g openclaw@latest

# Homebrew
brew install openclaw

# From source
git clone https://github.com/openclaw/openclaw.git
cd openclaw && pnpm install && pnpm build
```

### Service (launchd)

OpenClaw installs a per-user LaunchAgent:

- Service label: `bot.molt.gateway`
- Plist location: `~/Library/LaunchAgents/bot.molt.gateway.plist`
- `KeepAlive: true` (auto-restart on crash)
- `RunAtLoad: true` (starts at login)
- Logs: `~/.openclaw/logs/gateway.log` (structured JSONL)

```bash
openclaw service install    # Install LaunchAgent
openclaw service start      # Start service
openclaw gateway status     # Verify running
```

Or use the onboarding wizard:

```bash
openclaw onboard --install-daemon
```

### Permissions Required

| Permission | Purpose |
|------------|---------|
| Full Disk Access | iMessage integration |
| Camera | Photo capture via nodes |
| Microphone | Voice input / Talk Mode |
| Screen Recording | Screen capture tools |

Grant in System Preferences > Privacy & Security.

### macOS Menu Bar App

Optional companion app with voice overlay for hands-free Voice Wake and Talk Mode.

---

## iOS

Download from App Store: "OpenClaw"

Features: Chat interface, photo/video capture, location sharing, voice input, push notifications, Shortcuts integration, Canvas/A2UI, Voice Wake.

Configure gateway URL in app settings: `ws://your-gateway:18789`

Bundle ID: `ai.openclaw.ios` (legacy: `bot.molt.*`)
Minimum iOS: 15.0+

---

## Android

Download from Google Play or APK from https://openclaw.ai/download/android

Features: Chat interface, camera, voice, push notifications, Tasker integration, Canvas/A2UI, screen recording.

Package name: `ai.openclaw.android`

---

## Windows (WSL2)

OpenClaw does NOT support native Windows. WSL2 is the only supported path.

### Why WSL2

The CLI + Gateway run inside Linux, keeping the runtime consistent (Node/Bun/pnpm, Linux binaries, skills are far more compatible).

### Setup

```powershell
# Install WSL2
wsl --install
wsl --install -d Ubuntu
```

```bash
# Inside WSL2 terminal
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### Service (systemd in WSL2)

OpenClaw installs a systemd user service. Requires lingering to survive logout:

```bash
loginctl enable-linger $USER
```

### Auto-Start

Use Windows Task Scheduler to trigger WSL startup commands at login.

### Limitations

- No native Windows GUI
- No iMessage integration
- WSL2 networking requires port forwarding for LAN access

---

## Linux

Primary server platform. Full Gateway support.

### Installation

```bash
# npm
npm install -g openclaw@latest

# One-line installer (auto-detects platform, installs Node 22+)
curl -fsSL openclaw.ai/install.sh | bash

# From source
git clone https://github.com/openclaw/openclaw.git
cd openclaw && pnpm install && pnpm build
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_BETA=1` | Install beta release |
| `OPENCLAW_NO_ONBOARD=1` | Skip onboarding wizard |

### Systemd User Service (Default)

Installed by default on Linux and WSL2. Runs as your user:

```bash
openclaw onboard --install-daemon
```

Service location: `~/.config/systemd/user/openclaw-gateway.service`

```bash
systemctl --user status openclaw-gateway
systemctl --user restart openclaw-gateway
journalctl --user -u openclaw-gateway -f
```

Requires lingering to survive logout:

```bash
loginctl enable-linger $USER
```

### Systemd System Service (Always-On Servers)

For VPS/dedicated servers, use a system-level unit:

```ini
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=openclaw
ExecStart=/usr/bin/openclaw gateway
Restart=always
Environment=HOME=/home/openclaw

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable openclaw-gateway
sudo systemctl start openclaw-gateway
sudo journalctl -u openclaw-gateway -f
```

---

## VPS Deployment

### Recommended Providers

| Provider | Price | RAM | Notes |
|----------|-------|-----|-------|
| Oracle Cloud | Free | 1GB | Always-free tier, complex setup |
| Hetzner | $3/mo | 2GB | CX11, cheapest reliable, EU only |
| DigitalOcean | $4/mo | 1GB | Most beginner-friendly, promo code OPENCLAW for $200 credit |
| Vultr | $5/mo | 1GB | 25+ locations worldwide |
| Linode | $5/mo | 1GB | Reliable, owned by Akamai |

### Setup Process

1. Create server with **Ubuntu 22.04+**
2. SSH into server
3. Run installer:

```bash
curl -fsSL openclaw.ai/install.sh | bash
```

4. Complete onboarding with non-loopback binding:

```bash
openclaw onboard --install-daemon
```

5. Create system-level systemd unit (see Linux section above)

### VPS Binding

Use non-loopback binding for VPS:

```json
{
  "gateway": {
    "bind": "lan",
    "auth": { "token": "strong-random-token" }
  }
}
```

---

## Mac Mini (Always-On Home Server)

Recommended: Base model M2/M4, 8GB RAM, 256GB storage ($599).

### Setup

1. Use Ethernet (most reliable) or WiFi
2. System Settings > Energy:
   - Prevent automatic sleeping
   - Disable "Put hard disks to sleep"
   - Enable "Start up automatically after power failure"
3. System Settings > General > Sharing > Remote Login (ON)
4. Install OpenClaw and run onboarding
5. Power: ~6 watts idle (~$5/year electricity)
6. Once configured, manage headlessly via messaging app or SSH

---

## Docker

### Standalone

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
docker build -t openclaw .
docker run -d \
  -p 18789:18789 \
  -v openclaw-data:/home/node/.openclaw \
  --name openclaw-gateway \
  openclaw
```

### Docker Compose

```yaml
services:
  openclaw-gateway:
    build: .
    ports:
      - "0.0.0.0:18789:18789"
    volumes:
      - openclaw-data:/home/node/.openclaw
    environment:
      - OPENCLAW_GATEWAY_TOKEN=your-token
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
    restart: unless-stopped

volumes:
  openclaw-data:
```

### Common Docker Issues

| Issue | Solution |
|-------|----------|
| Permission errors (EACCES) | Specify `user: "1000:1000"` or fix host folder ownership |
| 1008 pairing errors | Approve remote device: `docker compose run --rm openclaw-cli devices list` |
| Token mismatch | Ensure `gateway.auth.token` matches `gateway.remote.token` |
| Port binding | Use `0.0.0.0:18789:18789` (not `127.0.0.1`) |
| Skills unavailable | Pass `GOG_KEYRING_PASSWORD` env var, set keyring backend |

### Tailscale in Docker

Set `network_mode: host` and disable built-in Tailscale configuration.

---

## Cloud Platforms

### Fly.io

Persistent storage via volumes. Global edge deployment. SSH access to running machines.

### Railway

Auto-detects Node.js. Persistent volume mounting for config.

### Render

Persistent disks at `/data`. Set `OPENCLAW_STATE_DIR=/data/openclaw`. Auto-deploy from Git.

---

## Remote Access

### Tailscale (Recommended)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
openclaw gateway --tailscale serve
```

- Access via MagicDNS URL: `https://machine-name.tailnet/`
- Automatic HTTPS and identity-based auth
- Tailscale Funnel for public access (requires password auth)

### SSH Tunnel

```bash
ssh -L 18789:localhost:18789 user@server
# Access locally at http://localhost:18789
```

Purpose: health checks, web chat, control-plane calls from local machine to remote Gateway.

### Cloudflare Tunnel

```bash
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw openclaw.yourdomain.com
cloudflared tunnel run openclaw
```

Zero-trust public internet exposure through Cloudflare infrastructure.

---

## Release Channels

| Channel | Description | npm tag |
|---------|-------------|---------|
| `stable` | Tagged releases (vYYYY.M.D format) | `latest` |
| `beta` | Prerelease versions | `beta` |
| `dev` | Moving head of main branch | `dev` |

```bash
openclaw update --channel stable    # Switch to stable
openclaw update --channel beta      # Switch to beta
openclaw update --channel dev       # Switch to dev (bleeding edge)
```

---

## Installation Methods Summary

| Method | Command | Notes |
|--------|---------|-------|
| npm global | `npm install -g openclaw@latest` | Most common |
| Homebrew | `brew install openclaw` | macOS only |
| One-line installer | `curl -fsSL openclaw.ai/install.sh \| bash` | Auto-detects platform |
| From source | `git clone ... && pnpm install && pnpm build` | Development |
| Docker | `docker compose up -d` | Containerized |

---

## Post-Install

```bash
openclaw onboard                     # Interactive setup wizard
openclaw onboard --install-daemon    # Setup + install background service
openclaw config validate             # Verify configuration
openclaw doctor --verbose            # Check for issues
openclaw status --all                # Comprehensive system check
```

---

## Upstream Sources

- https://deepwiki.com/openclaw/openclaw/13-deployment
- https://github.com/openclaw/openclaw (README)
- https://getopenclaw.ai/docs/getting-started
- https://getopenclaw.ai/help/installation-guide-all-platforms
- https://getopenclaw.ai/help/docker-setup-guide
- https://getopenclaw.ai/how-to/cheapest-openclaw-hosting
- https://getopenclaw.ai/how-to/openclaw-mac-mini
- https://getopenclaw.ai/how-to/run-openclaw-24-7
