<!-- Source: https://github.com/openclaw/openclaw (README + docs/install/ + docs/start/) -->
<!-- Last synced: 2026-02-17 -->

# OpenClaw Installation

Complete guide to installing OpenClaw using various methods. OpenClaw is a personal AI assistant
you run on your own devices, supporting WhatsApp, Telegram, Slack, Discord, Google Chat, Signal,
iMessage, Microsoft Teams, WebChat, BlueBubbles, Matrix, Zalo, and more.

---

## Prerequisites

- **Node.js >=22** (22.12.0+ recommended)
- **macOS**: Xcode CLI tools (`xcode-select --install`)
- **Windows**: WSL2 with Ubuntu (native Windows via PowerShell installer also supported)
- **Linux**: Build essentials (`build-essential` on Debian/Ubuntu)
- **Package manager**: pnpm >=10.23.0 (for source builds)

Verify Node version:

```bash
node -v   # Should show v22.x.x or higher
```

### Node.js Installation

**macOS**: `brew install node` or download from nodejs.org

**Linux (Ubuntu/Debian)**:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Linux (Fedora/RHEL)**: `sudo dnf install nodejs`

**Windows**: `winget install OpenJS.NodeJS.LTS`, Chocolatey, or nodejs.org installer

**Version managers**: fnm, nvm, mise, and asdf all work. With fnm:
```bash
fnm install 22
fnm use 22
```

### PATH Troubleshooting

If you get `openclaw: command not found` after install, npm's global bin directory is not on your PATH:

```bash
# Find your global prefix
npm prefix -g

# Add to shell startup (~/.zshrc or ~/.bashrc)
export PATH="$(npm prefix -g)/bin:$PATH"
```

**Linux permission fix** (if npm install fails with EACCES):
```bash
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

---

## Installer Script (Recommended)

The simplest path from zero to running. Downloads the CLI, installs globally via npm, and
launches the onboarding wizard.

**macOS / Linux / WSL**:
```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

**Windows PowerShell**:
```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

**Skip onboarding** (for automation):
```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

### Installer Variants

| Script | Platform | Description |
|--------|----------|-------------|
| `install.sh` | macOS/Linux/WSL | Standard interactive installer |
| `install-cli.sh` | macOS/Linux/WSL | Isolated install under local prefix, no root needed |
| `install.ps1` | Windows PowerShell | Windows equivalent with PATH integration |

### Installer Flags (CI/Automation)

| Flag | Environment Variable | Description |
|------|---------------------|-------------|
| `--no-prompt` | `OPENCLAW_NO_PROMPT` | Disable interactive prompts |
| `--no-onboard` | `OPENCLAW_NO_ONBOARD` | Skip onboarding wizard |
| `--dry-run` | `OPENCLAW_DRY_RUN` | Preview without modifying |
| `--json` | - | JSON output for scripts |
| `--install-method npm\|git` | `OPENCLAW_INSTALL_METHOD` | Choose npm or git-based install |
| - | `OPENCLAW_VERSION` | Pin specific version |

Both scripts support npm-based (default: global package install) or git-based (clone repo, build
with pnpm, create wrapper scripts) installation methods.

The installer sets `SHARP_IGNORE_GLOBAL_LIBVIPS=1` by default to avoid libvips build issues.

---

## npm / pnpm Global Install

If you already have Node 22+:

```bash
# npm
npm install -g openclaw@latest
openclaw onboard --install-daemon

# pnpm (requires approving build scripts)
pnpm approve-builds -g
pnpm add -g openclaw@latest
openclaw onboard --install-daemon
```

The onboard wizard guides through: AI provider setup, messaging channel connection,
agent personality creation, and daemon installation.

---

## Docker Installation

Docker is optional. Use it when you want an isolated, temporary gateway environment or are running
on systems without local Node installations. Skip Docker if developing locally and prioritizing
rapid iteration.

### Automated Docker Setup

The project includes a setup script that automates image building, onboarding, config generation,
and gateway startup:

```bash
./docker-setup.sh
```

This script:
- Validates Docker and Docker Compose availability
- Creates config dirs at `~/.openclaw` and `~/.openclaw/workspace`
- Generates a security token via OpenSSL
- Builds the image from the Dockerfile
- Runs interactive onboarding
- Starts the gateway in detached mode

### Quick Start (docker run)

```bash
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -p 18790:18790 \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw/workspace:/home/node/.openclaw/workspace \
  -e OPENCLAW_GATEWAY_TOKEN="your-token" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  ghcr.io/openclaw/openclaw:latest
```

### Docker Compose

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE:-openclaw:local}
    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"
      - "${OPENCLAW_BRIDGE_PORT:-18790}:18790"
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    environment:
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - CLAUDE_AI_SESSION_KEY=${CLAUDE_AI_SESSION_KEY}
      - CLAUDE_WEB_SESSION_KEY=${CLAUDE_WEB_SESSION_KEY}
      - CLAUDE_WEB_COOKIE=${CLAUDE_WEB_COOKIE}
      - HOME=/home/node
      - TERM=xterm-256color
    command: ["node", "openclaw.mjs", "gateway", "--bind", "lan", "--port", "18789"]
    restart: unless-stopped

  openclaw-cli:
    image: ${OPENCLAW_IMAGE:-openclaw:local}
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    environment:
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - HOME=/home/node
      - TERM=xterm-256color
    stdin_open: true
    tty: true
    entrypoint: ["node"]
```

### Docker Build Notes

- **Base image**: `node:22-bookworm` with corepack enabled for pnpm
- **Bun**: Also installed in the container (available alongside Node)
- **Optional**: Chromium + Xvfb for browser automation (`~300MB` additional; avoids 60-90s startup delay)
- **Build arg**: `OPENCLAW_DOCKER_APT_PACKAGES` to install extra system packages at build time
- **Security**: Runs as `node` user (non-root), file ownership transferred
- **ARM support**: `OPENCLAW_PREFER_PNPM=1` forces pnpm for UI builds on ARM architectures
- **Default CMD**: `node openclaw.mjs gateway --allow-unconfigured` (binds to 127.0.0.1 by default)

### Docker Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | Authentication token (required when binding beyond localhost) |
| `OPENCLAW_GATEWAY_PASSWORD` | Alternative authentication method |
| `OPENCLAW_DOCKER_APT_PACKAGES` | Extra system packages to install during build |
| `OPENCLAW_EXTRA_MOUNTS` | Additional host directory bindings (comma-separated) |
| `OPENCLAW_HOME_VOLUME` | Persist `/home/node` across container recreation |

### Docker Port Reference

| Port | Protocol | Service | Description |
|------|----------|---------|-------------|
| 18789 | HTTP + WebSocket | Gateway | Main gateway, WebChat UI, Control UI, health endpoint |
| 18790 | TCP (JSONL) | Bridge | Mobile node connections - **NOT HTTP!** |
| 18793 | HTTP | Canvas | File serving for node WebViews |

**Important**: Port 18790 is NOT webchat. WebChat is at `http://host:18789/chat`.
Control UI is at `http://127.0.0.1:18789/`.

### Docker Network Configuration

For Docker, use `bind: "lan"` (requires authentication):

```json
{
  "gateway": {
    "bind": "lan",
    "auth": { "mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}" }
  }
}
```

### Agent Sandboxing (Docker)

Tools can execute inside per-session Docker containers while the gateway runs on the host. Three
isolation scopes: per-session, per-agent, or shared (not recommended). Supports:
- Tool allowlists and denylists (deny takes precedence)
- Resource limits (memory, CPU, process counts)
- Network isolation (disabled by default)
- Read-only filesystem, capability dropping, seccomp

### ClawDock Helper

Optional shell integration provides shortcuts: `clawdock-start`, `clawdock-stop`,
`clawdock-dashboard`.

---

## Podman Installation

Rootless Podman deployment using the same container image as Docker.

### Setup

```bash
./setup-podman.sh              # Basic setup
./setup-podman.sh --quadlet    # With systemd Quadlet service
```

The script creates a dedicated `openclaw` system user (nologin shell), builds the image, generates
a config at `~openclaw/.openclaw/openclaw.json` with `gateway.mode="local"`, and stores the auth
token in `~openclaw/.openclaw/.env`.

### Running

```bash
# Manual launch
./scripts/run-openclaw-podman.sh launch

# With onboarding wizard
./scripts/run-openclaw-podman.sh launch setup
```

Access at `http://127.0.0.1:18789/` with the token from `~openclaw/.openclaw/.env`.

### Systemd Quadlet Management

```bash
sudo systemctl --machine openclaw@ --user start openclaw.service
sudo systemctl --machine openclaw@ --user stop openclaw.service
sudo systemctl --machine openclaw@ --user status openclaw.service
sudo journalctl --machine openclaw@ --user -u openclaw.service -f
```

Config at `~openclaw/.config/containers/systemd/openclaw.container`.

### Single-User Mode

Skip dedicated user creation by running podman directly with `--userns=keep-id` and appropriate
home directory mounts.

---

## Source Installation

For contributors and development workflows.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build
pnpm build
pnpm openclaw onboard --install-daemon
pnpm gateway:watch  # development mode with file watching
```

**Build requirements**:
- pnpm >=10.23.0 (package manager)
- Node.js >=22.12.0
- TypeScript, Zod validation, Rollup/tsdown bundling

**Link globally** (to use `openclaw` CLI from anywhere):
```bash
pnpm link --global
```

**Build verification** (before submitting PRs):
```bash
pnpm build && pnpm check && pnpm test
```

**Control UI**: Uses Lit with legacy decorator syntax (`experimentalDecorators: true`,
`useDefineForClassFields: false`).

---

## Ansible Installation

Production-hardened automated deployment using `openclaw-ansible`.

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

### Requirements

- Debian 11+ or Ubuntu 20.04+
- Root or sudo access
- Active internet connection
- Ansible 2.14+ (auto-installed by the quick-start script)

### What the Playbook Configures

1. **Tailscale VPN** for encrypted remote connectivity
2. **UFW firewall** restricting public exposure to SSH and Tailscale ports
3. **Docker CE + Compose V2** for sandboxed agent execution
4. **Node.js 22.x + pnpm** package manager
5. **OpenClaw** application running directly on the host (gateway on host, agents in Docker)
6. **Systemd service** with automatic startup and security hardening

### Security Layers

| Layer | Protection |
|-------|------------|
| Firewall (UFW) | Only SSH (22) and Tailscale (41641/udp) open externally |
| Network | Gateway accessible only via VPN mesh |
| Container | Docker isolation via iptables chains |
| Process | Systemd hardening restricts privilege escalation |

Port scans should reveal only SSH access after proper configuration.

### Systemd Service (Manual)

```ini
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=openclaw
ExecStart=/usr/bin/openclaw gateway
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## Nix Installation

Uses `nix-openclaw`, a batteries-included Home Manager module.

**Repository**: `github.com/openclaw/nix-openclaw`

### Benefits

- Gateway + macOS app + tools (whisper, spotify, cameras) all pinned
- launchd service survives reboots
- Instant rollback: `home-manager switch --rollback`

### Quick Start

1. Verify Determinate Nix installation
2. Create a local flake at `~/code/openclaw-local` using provided templates
3. Set up channel credentials (e.g., Telegram bot)
4. Configure secrets at `~/.secrets/`
5. Execute `home-manager switch`
6. Validate the launchd service

### Nix Mode

When `OPENCLAW_NIX_MODE=1` is set, auto-install flows are disabled and the system operates
deterministically. On macOS:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Environment Variable Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOME` | `$HOME` | Home directory for path resolution |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | State directory location |
| `OPENCLAW_CONFIG_PATH` | `$OPENCLAW_STATE_DIR/openclaw.json` | Config file path |
| `OPENCLAW_NIX_MODE` | unset | Deterministic mode, disables auto-install |

---

## Bun Installation (Experimental)

```bash
bun install -g openclaw
```

**Important caveats**:
- Bun is an optional local TypeScript runtime (`bun run`, `bun --watch`)
- **Not recommended for WhatsApp/Telegram gateway runtime** due to known bugs
- pnpm remains the default for builds and is fully supported
- Bun ignores `pnpm-lock.yaml` and creates its own lockfiles (gitignored)
- Some scripts hardcode pnpm (`docs:build`, `ui:*`, `protocol:check`) and must be run via pnpm
- Lifecycle scripts are blocked by default; trust with: `bun pm trust @whiskeysockets/baileys protobufjs`

```bash
# Build and test with Bun
bun install --no-save
bun run build
bun run vitest run
```

---

## Cloud / VPS Deployment

### Fly.io

Persistent deployment with automatic HTTPS.

```bash
fly apps create openclaw
fly volumes create openclaw_data --region iad --size 1
fly secrets set OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
fly secrets set ANTHROPIC_API_KEY="sk-ant-..."
fly deploy
```

Key `fly.toml` settings:
- Process: `node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan`
- VM: `shared-cpu-2x`, 2048MB memory (512MB is insufficient)
- State: `/data` volume mount
- `NODE_OPTIONS="--max-old-space-size=1536"`

Non-loopback binds require `OPENCLAW_GATEWAY_TOKEN`. Estimated cost: $10-15/month.

**Private deployment**: Use `fly.private.toml` with no public exposure, access via WireGuard VPN
or SSH only.

### Render

```yaml
# render.yaml
services:
  - type: web
    name: openclaw
    runtime: docker
    plan: starter
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: "8080"
      - key: OPENCLAW_STATE_DIR
        value: /data/.openclaw
      - key: OPENCLAW_GATEWAY_TOKEN
        generateValue: true
    disk:
      name: openclaw-data
      mountPath: /data
      sizeGB: 1
```

### Hetzner VPS

Production deployment with Docker on Hetzner. Key principle: **containers are ephemeral; all
long-lived state must live on the host**.

```bash
mkdir -p /root/.openclaw/workspace
chown -R 1000:1000 /root/.openclaw
```

State persistence via volume mounts:

| State | Host Path | Container Path |
|-------|-----------|----------------|
| Config & tokens | `/root/.openclaw/` | `/home/node/.openclaw/` |
| Workspace | `/root/.openclaw/workspace/` | `/home/node/.openclaw/workspace/` |
| Skills | `/root/.openclaw/skills/` | `/home/node/.openclaw/skills/` |

**Important**: Never install binaries inside a running container (lost on restart). Bake all
required binaries into the Dockerfile.

Access via SSH tunnel for security:
```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

### Remote Gateway (General)

Running the gateway on a small Linux instance is fully supported. Clients (macOS app, CLI, WebChat)
connect over Tailscale Serve/Funnel or SSH tunnels.

---

## Post-Install Setup

### Onboarding Wizard

```bash
openclaw onboard --install-daemon
```

The wizard provides two modes:

**QuickStart Mode** (sensible defaults):
- Local gateway on port 18789
- Token-based authentication
- Disabled Tailscale exposure
- Allowlist channel defaults for Telegram and WhatsApp

**Advanced Mode** (granular control):
- Mode selection, workspace location, gateway settings
- Channel choices, daemon installation, skill selection

The wizard configures:
- AI provider (Anthropic recommended with Claude Pro/Max, or OpenAI)
- Messaging channel (Telegram easiest for beginners)
- Agent personality
- Gateway daemon (launchd on macOS, systemd on Linux)

Re-running preserves existing configuration unless explicitly reset. Additional agents can be
created using `openclaw agents add <name>`.

### Verify Installation

```bash
openclaw doctor      # Run health checks and migrations
openclaw status      # Check gateway and channel status
openclaw dashboard   # Open Control UI in browser
```

The Control UI is also available at `http://127.0.0.1:18789/` without any channel setup.

### Environment Variables (.env Support)

Store secrets in `~/.openclaw/.env`:

```bash
# AI Provider Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...

# Channel Tokens
TELEGRAM_BOT_TOKEN=123456:ABC...
DISCORD_BOT_TOKEN=MTIz...
SLACK_BOT_TOKEN=xoxb-...

# Gateway Security
OPENCLAW_GATEWAY_TOKEN=your-secret-token
OPENCLAW_GATEWAY_PASSWORD=alternative-auth

# Voice & Search
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
BRAVE_SEARCH_KEY=BSA...
PERPLEXITY_API_KEY=...

# Path Overrides
OPENCLAW_HOME=/custom/home
OPENCLAW_STATE_DIR=/custom/state
OPENCLAW_CONFIG_PATH=/custom/config/openclaw.json
```

**Env-source precedence** (highest to lowest):
1. Process environment
2. `./.env` (current directory)
3. `~/.openclaw/.env`
4. `openclaw.json` `env` block

Generate a secure token:
```bash
openssl rand -hex 32
```

### Minimal Configuration

`~/.openclaw/openclaw.json`:
```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

---

## Updates & Rollback

### Updating

**Installer script** (detects existing install, upgrades in place):
```bash
curl -fsSL https://openclaw.ai/install.sh | bash
# Add --no-onboard to skip wizard on subsequent runs
```

**Global npm/pnpm installs**:
```bash
npm i -g openclaw@latest
pnpm add -g openclaw@latest
```

**Source installs** (fetches + rebases against configured upstream):
```bash
openclaw update
```

### Post-Update Verification

```bash
openclaw doctor           # Run migrations and health checks
openclaw gateway restart  # Restart the gateway
openclaw health           # Verify health
```

### Rollback

**Global installs** (reinstall a known-good version):
```bash
npm i -g openclaw@<version>
```

**Source installs** (checkout by date):
```bash
git checkout "$(git rev-list -n 1 --before="YYYY-MM-DD" origin/main)"
pnpm install
pnpm build
openclaw gateway restart
```

### Release Channels

| Channel | Description | npm dist-tag | Install Command |
|---------|-------------|--------------|-----------------|
| `stable` | Tagged releases (vYYYY.M.D) | `latest` | `openclaw update --channel stable` |
| `beta` | Prerelease tags (vYYYY.M.D-beta.N) | `beta` | `openclaw update --channel beta` |
| `dev` | Moving head of main branch | `dev` | `openclaw update --channel dev` |

Dist-tags are the source of truth for npm installs. The `dev` channel ensures a git checkout.

**One-off version**:
```bash
openclaw update --tag <dist-tag|version>
```

**Plugin synchronization**: When switching channels, plugin sources automatically align. Git
checkouts prioritize bundled plugins; npm installations restore package-based plugins.

**macOS note**: Beta and dev releases may omit macOS app builds.

---

## Migration

When moving OpenClaw to a new machine, copy two directories:

1. **State directory** (`~/.openclaw/`) - config, auth, sessions, channel connectivity
2. **Workspace** (`~/.openclaw/workspace/`) - agent files, memory, prompts

```bash
# On old machine
openclaw gateway stop
tar czf openclaw-backup.tar.gz ~/.openclaw/

# On new machine (after installing OpenClaw)
tar xzf openclaw-backup.tar.gz -C ~/
openclaw doctor   # Apply migrations and validate
```

**Warnings**:
- Never copy only `openclaw.json` - credentials live elsewhere in the state directory
- Ensure the receiving user owns copied files (root-owned files cause access failures)
- Treat backups as production secrets (they contain credentials)
- If using `--profile <name>`, the state dir is `~/.openclaw-<profile>/`

---

## Uninstalling

```bash
# Easy path (CLI installed)
openclaw uninstall

# Manual steps
openclaw gateway stop
# macOS: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
# Linux: systemctl --user disable --now openclaw-gateway
# Windows: schtasks /Delete /TN "OpenClaw Gateway"
npm uninstall -g openclaw
rm -rf ~/.openclaw   # Remove state and config
```

---

## Backward Compatibility

The `clawdbot` and `moltbot` CLI commands still work as aliases. Config is also read from
`~/.clawdbot/` if `~/.openclaw/` doesn't exist.

---

## Upstream Sources

- https://github.com/openclaw/openclaw (README.md)
- https://github.com/openclaw/openclaw/tree/main/docs/install/ (docker, node, ansible, nix, bun, podman, fly, hetzner, updating, migrating, installer, uninstall, development-channels)
- https://github.com/openclaw/openclaw/tree/main/docs/start/ (getting-started, onboarding, wizard)
- https://github.com/openclaw/openclaw/blob/main/Dockerfile
- https://github.com/openclaw/openclaw/blob/main/docker-compose.yml
- https://github.com/openclaw/openclaw/blob/main/.env.example
- https://github.com/openclaw/openclaw/blob/main/docker-setup.sh
- https://github.com/openclaw/openclaw/blob/main/setup-podman.sh
- https://github.com/openclaw/openclaw/blob/main/fly.toml
- https://github.com/openclaw/openclaw/blob/main/render.yaml
- https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md
