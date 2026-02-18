<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md -->

# Testing

Complete guide to testing Umbrel apps locally and on devices.

## Local Docker Testing (Do This First)

**Always test Docker images locally before deploying to Umbrel.** This catches issues like missing UI builds, wrong ports, or configuration errors before wasting time on device reinstalls.

```bash
# 1. Pull the image
docker pull <image>@sha256:<digest>

# 2. Run locally with minimal config
docker run -d --name test-app \
  -p <port>:<port> \
  -e REQUIRED_ENV_VAR=test \
  <image>@sha256:<digest>

# 3. Wait for startup, check logs
sleep 5
docker logs test-app

# 4. Test HTTP endpoints
curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/
curl -s http://localhost:<port>/ | head -20  # Check content

# 5. Clean up
docker stop test-app && docker rm test-app
```

### What to Verify Locally

- [ ] Container starts without errors
- [ ] HTTP endpoints return 200
- [ ] UI assets load (check HTML for JS/CSS references)
- [ ] No "file not found" or build errors in logs
- [ ] Correct port binding

### Common Issues Caught by Local Testing

| Issue | Symptom | Fix |
|-------|---------|-----|
| Missing build step | Empty page, 404 for assets | Add build step to Dockerfile (e.g., `pnpm ui:build`) |
| Wrong port | Connection refused | Match PORT env var with EXPOSE in Dockerfile |
| Missing env vars | App crashes on startup | Check required environment variables |
| Container crash loop | Exits immediately | Check logs: `docker logs test-app` |
| HTTP vs WebSocket | Upgrade errors | Configure app_proxy accordingly |

---

## Development Environment (umbrel-dev)

The recommended way to test on a full umbrelOS instance using your local machine.

### Prerequisites

umbrel-dev requires a Docker environment that exposes container IPs to the host:
- **macOS**: Install [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
- **Windows**: Use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) with Docker Desktop
- **Linux**: Native Docker works out of the box

### Setup

```bash
# Clone umbrelOS
git clone https://github.com/getumbrel/umbrel.git
cd umbrel

# View available commands
npm run dev help

# Start the development environment
npm run dev
```

The first run may take a while to build the OS image. Once ready, umbrelOS is accessible at `http://umbrel-dev.local`.

### Deploy Your App

```bash
# Copy app to umbrel-dev (exclude .gitkeep files)
rsync -av --exclude=".gitkeep" \
  <path-to-app>/my-app \
  umbrel@umbrel-dev.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/

# Install the app via CLI
npm run dev client -- apps.install.mutate -- --appId my-app

# Access at http://umbrel-dev.local:<port>
```

### Manage on umbrel-dev

```bash
# Install
npm run dev client -- apps.install.mutate -- --appId my-app

# Uninstall
npm run dev client -- apps.uninstall.mutate -- --appId my-app

# Or use the web UI at http://umbrel-dev.local
```

---

## Physical Device Testing

### Supported Devices

1. [Raspberry Pi 5](https://github.com/getumbrel/umbrel/wiki/Install-umbrelOS-on-a-Raspberry-Pi-5)
2. [Any x86 system](https://github.com/getumbrel/umbrel/wiki/Install-umbrelOS-on-x86-Systems)
3. [Linux VM](https://github.com/getumbrel/umbrel/wiki/Install-umbrelOS-on-a-Linux-VM)
4. [Umbrel Home](https://umbrel.com/umbrel-home) / [Umbrel Pro](https://umbrel.com/umbrel-pro)

### Deploy to Physical Device

```bash
# Copy app to device
rsync -av --exclude=".gitkeep" \
  <path-to-app>/my-app \
  umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/

# SSH in and install
ssh umbrel@umbrel.local
umbreld client apps.install.mutate --appId my-app

# Or install via the App Store UI at http://umbrel.local
```

The SSH password is the same as your Umbrel dashboard password.

---

## Persistence Testing

**Critical**: Verify that app state persists correctly.

### Test Restart Persistence

```bash
# 1. Use the app and create some data
# 2. Restart the app
umbreld client apps.restart.mutate --appId my-app
# 3. Verify data is still there
```

When stopping/starting: data in volumes is persisted, everything else is discarded.

### Test Reinstall Behavior

```bash
# 1. Uninstall (removes ALL data including volumes)
umbreld client apps.uninstall.mutate --appId my-app

# 2. Reinstall
umbreld client apps.install.mutate --appId my-app

# 3. Verify app starts fresh (all data should be gone)
```

When uninstalling/installing: even persistent data is discarded. This is expected behavior.

### Common Persistence Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Data lost on restart | Volume not mapped | Add `${APP_DATA_DIR}/data:/data` volume |
| Data lost on reinstall | Using named volumes | Switch to `${APP_DATA_DIR}` paths |
| Stale config after update | Config baked into image | Mount config as volume |

---

## Debugging During Testing

```bash
# View app logs
umbreld client apps.logs --appId my-app
docker logs <container-name>

# Check container status
docker ps --filter name=my-app

# Shell into container
docker exec -it <container-name> /bin/sh

# Check app state
umbreld client apps.state --appId my-app

# View app data
ls -la ~/umbrel/app-data/my-app/
```

---

## Multi-Architecture Verification

Test on both ARM64 and x86_64 to ensure multi-arch images work:

```bash
# Check image architectures
docker buildx imagetools inspect <image>:<tag>

# Or check the manifest
docker manifest inspect <image>:<tag>
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- https://github.com/getumbrel/umbrel
