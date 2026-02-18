# Umbrel App Skill for Claude Code

A comprehensive Claude Code skill for developing, packaging, testing, and submitting apps for umbrelOS.

## Features

### App Development
- **Scaffold** - Generate complete app structure with all required files
- **Validate** - Check apps against 20+ requirements and best practices
- **Convert** - Transform existing Docker Compose apps to Umbrel format
- **PR Generation** - Create submission-ready pull request content

### System Operations
- **CLI Reference** - Complete `umbrel` and `umbreld client` command documentation
- **Debug** - Troubleshoot installation and runtime issues
- **Community Stores** - Add, browse, and install from community app stores

### AI Agent Support
- **Debug Workflows** - Step-by-step error diagnosis patterns
- **App Management** - Install, uninstall, start, stop, restart operations
- **Health Checks** - System and container monitoring commands
- **Deployment Troubleshooting** - Validate configs, check dependencies, verify ports

### Maintenance
- **Sync** - Keep skill updated with upstream Umbrel documentation
- **Diff** - Check for documentation changes without modifying skill

## Installation

### Option 1: Local Testing

```bash
claude --plugin-dir /path/to/umbrel-app
```

### Option 2: Install from GitHub

```bash
# Add the marketplace
/plugin marketplace add zot24/skills

# Install the skill
/plugin install umbrel-app@zot24-skills
```

### Option 3: Project-Level Installation

Add to your project's `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "umbrel-app@zot24-skills": true
  }
}
```

## Usage

### Slash Command

```
/umbrel-app:umbrel scaffold my-cool-app
/umbrel-app:umbrel validate ./my-app
/umbrel-app:umbrel convert ./existing-docker-app
/umbrel-app:umbrel pr ./my-app
/umbrel-app:umbrel debug ./my-app
/umbrel-app:umbrel sync
/umbrel-app:umbrel diff
/umbrel-app:umbrel help
```

### Natural Language

The skill also triggers automatically when you mention:
- "Create an Umbrel app"
- "Package this for umbrelOS"
- "Validate my Umbrel app"
- "Submit to Umbrel app store"
- "Debug my Umbrel system"
- "Install app from community store"

## CLI Reference

The skill includes comprehensive documentation for Umbrel CLI commands.

### System Commands

```bash
umbrel start              # Start Umbrel
umbrel stop               # Stop Umbrel
umbrel restart            # Restart Umbrel
umbrel status             # Check status
umbrel app list           # List installed apps
umbrel app install <id>   # Install app
umbrel app uninstall <id> # Uninstall app
```

### umbreld Client Commands

```bash
umbreld client apps.logs --appId <app-id>
umbreld client apps.restart.mutate --appId <app-id>
umbreld client apps.stop.mutate --appId <app-id>
umbreld client apps.start.mutate --appId <app-id>
```

## AI Agent Use Cases

The skill provides workflows optimized for AI agent operations:

### Debug System Errors

```
"Debug why my-app is showing Bad Gateway"
→ SSH → check logs → identify issue → suggest fix
```

### Manage Apps

```
"Install btc-rpc-explorer and verify it's running"
→ Install → wait → check status → report
```

### Community Store Apps

```
"Add Alby community store and list available apps"
→ Provide store URL → list apps → explain installation
```

## What is an Umbrel App?

Umbrel apps are Docker-based applications packaged for [umbrelOS](https://umbrel.com), a personal server OS. Each app requires:

```
my-app/
├── docker-compose.yml    # Container orchestration
├── umbrel-app.yml        # App manifest/metadata
├── exports.sh            # Environment exports
├── icon.svg              # 256x256 app icon
└── gallery/              # 3-5 screenshots (1440x900)
```

## Key Requirements

### Docker Images Must Use SHA256 Digests

```yaml
# Correct
image: getumbrel/btc-rpc-explorer:v3.4.0@sha256:abc123...

# Wrong
image: getumbrel/btc-rpc-explorer:latest
```

### App Proxy is Required

Every app needs the `app_proxy` service for routing and authentication:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: myapp_web_1
      APP_PORT: 8080
```

### Persistent Data Uses APP_DATA_DIR

```yaml
volumes:
  - ${APP_DATA_DIR}/data:/app/data
```

## Environment Variables

Apps have access to Umbrel environment variables:

| Variable | Description |
|----------|-------------|
| `$APP_DATA_DIR` | Persistent storage path |
| `$APP_PASSWORD` | Auto-generated password |
| `$APP_SEED` | Deterministic seed |
| `$APP_HIDDEN_SERVICE` | Tor .onion address |
| `$APP_BITCOIN_NODE_IP` | Bitcoin Core IP |
| `$APP_BITCOIN_RPC_*` | Bitcoin RPC credentials |
| `$APP_LIGHTNING_NODE_IP` | LND IP address |
| `$TOR_PROXY_IP/PORT` | Tor SOCKS proxy |

## Testing Your App

### Development Environment

```bash
# Start umbrel-dev
git clone https://github.com/getumbrel/umbrel.git
cd umbrel && npm run dev

# Deploy your app
rsync -av ./my-app/ umbrel@umbrel-dev.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/my-app/

# Install
npm run dev client -- apps.install.mutate -- --appId my-app
```

### Physical Device

```bash
rsync -av ./my-app/ umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/my-app/
ssh umbrel@umbrel.local umbreld client apps.install.mutate --appId my-app
```

## Submitting Your App

1. Fork [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps)
2. Add your app directory
3. Include 256x256 SVG icon (no rounded corners)
4. Include 3-5 gallery images (1440x900 PNG)
5. Open a pull request

Use `/umbrel-app:umbrel pr ./my-app` to generate the PR template.

## Keeping the Skill Updated

The skill includes commands to stay synchronized with the official Umbrel documentation.

### Check for Changes

```bash
/umbrel-app:umbrel diff
```

Compares the current skill against the upstream documentation and reports any differences without making changes.

### Sync with Upstream

```bash
/umbrel-app:umbrel sync
```

Fetches the latest documentation from GitHub and updates the skill with any new requirements, fields, or procedures.

### Upstream Source

The authoritative documentation is at:
- **GitHub**: https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- **Raw**: https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/README.md

### What Gets Monitored

| Section | Changes Tracked |
|---------|-----------------|
| Dockerfile | Best practices, multi-arch requirements |
| docker-compose.yml | app_proxy config, version, services |
| umbrel-app.yml | Manifest fields, manifestVersion |
| Environment Variables | New/deprecated variables |
| Testing | Commands, dev environment setup |
| Submission | PR requirements, asset specs |

## Skill Structure

```
umbrel-app/
├── .claude-plugin/
│   └── plugin.json       # Skill manifest
├── commands/
│   └── umbrel.md         # Slash command definition
├── skills/
│   └── umbrel-app/
│       └── SKILL.md      # Skill instructions
└── README.md
```

## License

MIT

## Resources

- [Umbrel App Documentation](https://github.com/getumbrel/umbrel-apps)
- [Umbrel Core](https://github.com/getumbrel/umbrel)
- [Community App Store Template](https://github.com/getumbrel/umbrel-community-app-store)
- [Official App Store](https://apps.umbrel.com/)
- [Community Forum](https://community.umbrel.com/)
- [umbrelOS](https://umbrel.com)
- [Claude Code](https://claude.ai/claude-code)
