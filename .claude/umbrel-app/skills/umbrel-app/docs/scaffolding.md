<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md -->

# App Scaffolding

Complete guide to creating a new Umbrel app from scratch.

## Required Information

When creating a new app, gather:
- **App name**: Human-readable (e.g., "BTC RPC Explorer")
- **App ID**: Lowercase alphanumeric with dashes only (e.g., `btc-rpc-explorer`)
- **Category**: One of: `files`, `finance`, `media`, `networking`, `social`, `automation`, `developer`, `gaming`
- **Docker image**: Repository, tag, and SHA256 digest
- **Port**: Web UI port number
- **Dependencies**: Required apps (e.g., `bitcoin`, `lightning`, `electrs`)

## Directory Structure

```
<app-id>/
├── docker-compose.yml    # Container orchestration (required)
├── umbrel-app.yml        # App manifest with metadata (required)
├── exports.sh            # Environment variable exports (required, can be empty)
├── icon.svg              # 256x256 SVG icon (no rounded corners)
├── hooks/                # Lifecycle hooks (optional, manifest v1.1)
│   ├── pre-start         # Runs before app starts
│   ├── post-start        # Runs after app starts
│   ├── pre-stop          # Runs before app stops
│   └── post-install      # Runs after app installs
└── gallery/              # 3-5 screenshots at 1440x900 PNG
    ├── 1.jpg
    ├── 2.jpg
    └── 3.jpg
```

---

## docker-compose.yml Template

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      # Format: <app-id>_<service-name>_1
      # The '_1' suffix is REQUIRED
      APP_HOST: <app-id>_web_1
      APP_PORT: <port>
      # PROXY_AUTH_ADD: "false"       # Disable Umbrel auth
      # PROXY_AUTH_WHITELIST: "/api/*" # Exempt paths from auth
      # PROXY_AUTH_BLACKLIST: "/admin/*" # Require auth for paths

  web:
    image: <image>:<tag>@sha256:<digest>
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data
      # - ${APP_LIGHTNING_NODE_DATA_DIR}:/lnd:ro
      # - ${APP_BITCOIN_DATA_DIR}:/bitcoin:ro
    environment:
      PORT: <port>
```

### app_proxy Service

Every app MUST include the `app_proxy` service. It:
- Routes HTTP/WebSocket traffic to the app container
- Provides Umbrel authentication (password + optional 2FA)
- Is automatically injected by umbrelOS — you only configure the environment variables

### APP_HOST Format

**Critical**: The `APP_HOST` value must follow the format `<app-id>_<service-name>_1`:
- `btc-rpc-explorer_web_1` (service named `web`)
- `my-app_server_1` (service named `server`)

The `_1` suffix is required and refers to the first container instance.

### Image Digest Requirement

Docker images MUST use SHA256 digests for deterministic builds:

```yaml
# Correct - pinned to exact image
image: getumbrel/btc-rpc-explorer:v2.0.2@sha256:f8ba8b97e550f65e5bc935d7516cce7172910e9009f3154a434c7baf55e82a2b

# Wrong - mutable tag
image: getumbrel/btc-rpc-explorer:latest
```

**Important**: Use the multi-architecture digest, not a platform-specific digest.

### Getting an Image Digest

```bash
docker pull <image>:<tag>
docker inspect --format='{{index .RepoDigests 0}}' <image>:<tag>
```

---

## umbrel-app.yml Template

### Manifest Version 1 (Standard)

```yaml
manifestVersion: 1
id: <app-id>
category: <category>
name: <App Name>
version: "1.0.0"
tagline: <Short one-line description>
description: >-
  <Detailed multi-line description of the app.
  Explain what it does and why users want it.>
releaseNotes: >-
  Initial release.
developer: <Developer Name>
website: <https://example.com>
dependencies: []
repo: <https://github.com/user/repo>
support: <https://github.com/user/repo/issues>
port: <port>
gallery:
  - 1.jpg
  - 2.jpg
  - 3.jpg
path: ""
defaultUsername: ""
defaultPassword: ""
submitter: <Your Name>
submission: https://github.com/getumbrel/umbrel-apps/pull/XXX
```

**When submitting a new app**, leave these fields empty:
```yaml
gallery: []
releaseNotes: ""
```

### Manifest Version 1.1 (With Hooks)

Use manifest version `1.1` if your app needs lifecycle hooks:

```yaml
manifestVersion: 1.1
id: <app-id>
# ... same fields as v1 ...
```

### All Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `manifestVersion` | string | Yes | `"1"` or `"1.1"` (semver) |
| `id` | string | Yes | Lowercase alphanumeric + dashes, matches directory name |
| `name` | string | Yes | Human-readable app name |
| `tagline` | string | Yes | Short one-line description |
| `category` | string | Yes | One of the valid categories |
| `version` | string | Yes | App version (semver recommended) |
| `port` | integer | Yes | Web UI port number |
| `description` | string | Yes | Detailed multi-line description |
| `website` | string (URL) | Yes | Developer website |
| `support` | string | Yes | Support URL (issues page) |
| `gallery` | string[] | Yes | Gallery image filenames or URLs |
| `developer` | string | No | Developer name |
| `submitter` | string | No | Submitter name |
| `submission` | string (URL) | No | PR URL |
| `repo` | string (URL) | No | Source code repository |
| `releaseNotes` | string | No | Latest release notes |
| `dependencies` | string[] | No | Required app IDs |
| `permissions` | string[] | No | System permissions |
| `path` | string | No | Custom URL path |
| `defaultUsername` | string | No | Default login username |
| `defaultPassword` | string | No | Default login password |
| `deterministicPassword` | boolean | No | Use deterministic password |
| `disabled` | boolean | No | Hide app from store |
| `optimizedForUmbrelHome` | boolean | No | Badge for Umbrel Home |
| `torOnly` | boolean | No | Only accessible via Tor |
| `installSize` | integer | No | Size in bytes |
| `widgets` | array | No | Dashboard widget definitions |
| `defaultShell` | string | No | Default shell for terminal access |
| `implements` | string[] | No | Implemented interfaces |
| `backupIgnore` | string[] | No | Paths to exclude from backup |
| `icon` | string (URL) | No | External icon URL (required for community stores) |

---

## exports.sh Template

```bash
#!/bin/bash
# Export environment variables for other apps to consume
# These are available in dependent apps' docker-compose.yml files

# Example: share an API endpoint
# export APP_MY_APP_API_URL="http://my-app_web_1:8080/api"

# Example: share connection details
# export APP_MY_APP_HOST="my-app_web_1"
# export APP_MY_APP_PORT="8080"
```

The `exports.sh` file is sourced when other apps start, allowing them to access your app's connection details. Most apps can leave this file empty.

---

## Lifecycle Hooks (Manifest v1.1)

Hooks are executable scripts in a `hooks/` directory:

```
<app-id>/
└── hooks/
    ├── pre-start       # Before containers start
    ├── post-start      # After containers start
    ├── pre-stop        # Before containers stop
    └── post-install    # After first installation
```

Hook scripts must be executable (`chmod +x`). They run in the context of the Umbrel system with access to environment variables.

Example `hooks/pre-start`:
```bash
#!/bin/bash
# Generate config file before app starts
echo "Setting up configuration..."
# Your setup logic here
```

---

## Dockerfile Best Practices

When building Docker images for Umbrel apps:

- [x] Use a lightweight base image (Alpine, slim variants)
- [x] Use [multi-stage builds](https://docs.docker.com/develop/develop-images/multistage-build/) for smaller images
- [x] Exclude development files in the final image
- [x] One service per container
- [x] Don't run as root (`USER 1000`)
- [x] Verify remote assets against checksums
- [x] Build deterministic images

### Multi-Architecture Builds

Umbrel supports both ARM64 and x86_64. Use `docker buildx` for multi-arch images:

```bash
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --tag yourname/app:v1.0.0 \
  --output "type=registry" .
```

---

## Valid Categories

`files`, `finance`, `media`, `networking`, `social`, `automation`, `developer`, `gaming`

---

## Complete Example: BTC RPC Explorer

See the full step-by-step walkthrough in the [upstream README](https://github.com/getumbrel/umbrel-apps/blob/master/README.md) which covers:
1. Cloning and containerizing the app
2. Creating the docker-compose.yml with Bitcoin Core and Electrs connections
3. Writing the manifest
4. Testing and submitting

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/schema.ts
