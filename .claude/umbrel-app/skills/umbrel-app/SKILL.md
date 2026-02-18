---
name: umbrel-app
description: Expert Umbrel app developer. Use when the user wants to create, package, validate, test, debug, or submit apps for umbrelOS. Triggers on mentions of Umbrel apps, umbrelOS, app packaging, or Docker-to-Umbrel conversion.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, WebFetch
---

# Umbrel App Development Skill

Expert at developing, packaging, testing, and submitting apps for umbrelOS.

## Overview

- **Scaffold** - Create new apps from scratch with proper structure
- **Validate** - Check apps for 20+ common issues
- **Convert** - Transform Docker Compose apps to Umbrel format
- **PR Generation** - Create submission-ready PR content
- **Debug** - Troubleshoot installation and runtime issues

## Quick Start

```
<app-id>/
├── docker-compose.yml    # Must include app_proxy service
├── umbrel-app.yml        # App manifest with metadata
└── exports.sh            # Environment exports (can be empty)
```

### Critical Requirements

- Image format: `image: repo/name:tag@sha256:digest`
- Categories: `files`, `finance`, `media`, `networking`, `social`, `automation`, `developer`, `gaming`
- Key variables: `${APP_DATA_DIR}`, `$APP_PASSWORD`, `$APP_BITCOIN_*`, `$APP_LIGHTNING_*`

## Documentation

For detailed information, see the reference documentation:

- **[Scaffolding](docs/scaffolding.md)** - Templates and directory structure
- **[Validation](docs/validation.md)** - 20+ item checklist
- **[Conversion](docs/conversion.md)** - Docker-to-Umbrel mapping
- **[Submission](docs/submission.md)** - PR template and assets
- **[Community Stores](docs/community-stores.md)** - Custom app stores
- **[Debugging](docs/debugging.md)** - Common issues and fixes
- **[Testing](docs/testing.md)** - Local and device testing
- **[CLI Reference](docs/cli-reference.md)** - Umbrel commands
- **[Agent Operations](docs/agent-operations.md)** - AI agent workflows
- **[Security](docs/security.md)** - Authentication and protection

## Common Workflows

### Create New App
1. Gather: name, ID, category, Docker image, port
2. Generate docker-compose.yml with app_proxy
3. Generate umbrel-app.yml manifest
4. Validate with checklist

### Debug App Issue
1. SSH to `umbrel@umbrel.local`
2. Check logs: `umbreld client apps.logs --appId <id>`
3. Verify containers: `docker ps`
4. Check common issues in [debugging.md](docs/debugging.md)

### Submit to Official Store
1. Create PR at https://github.com/getumbrel/umbrel-apps
2. Include 256x256 SVG icon
3. Include 3-5 gallery images (1440x900 PNG)
4. Follow template in [submission.md](docs/submission.md)

## Upstream Sources

- **Repository**: https://github.com/getumbrel/umbrel-apps
- **Documentation**: https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- **Community Store Template**: https://github.com/getumbrel/umbrel-community-app-store

## Sync & Update

When user runs `sync`: fetch latest from upstream, update docs/ files.
When user runs `diff`: compare current vs upstream, report changes.
