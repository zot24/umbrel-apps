<!-- Source: https://github.com/getumbrel/umbrel -->

# Umbrel CLI Reference

Complete command reference for managing umbrelOS systems and apps.

## SSH Access

```bash
# Default access
ssh umbrel@umbrel.local
# Password: your Umbrel dashboard password

# Alternative hostnames
ssh umbrel@umbrel.local       # mDNS
ssh umbrel@<ip-address>       # Direct IP

# Web terminal (no SSH needed)
# Settings > Advanced Settings > Terminal > umbrelOS
```

---

## System Commands

```bash
# Service lifecycle
umbrel start                  # Start Umbrel
umbrel stop                   # Stop Umbrel
umbrel restart                # Restart Umbrel
umbrel start --debug          # Start in debug mode

# Status and updates
umbrel status                 # Check current status
umbrel update                 # Update umbrelOS
umbrel update check           # Check for available updates

# Backup and recovery
umbrel backup                 # Create manual backup
umbrel restore <file>         # Restore from backup file
umbrel reset                  # Factory reset (DESTRUCTIVE - erases all data)
```

---

## App Management

### High-Level Commands

```bash
umbrel app list               # List all installed apps
umbrel app install <app-id>   # Install an app
umbrel app uninstall <app-id> # Uninstall an app
```

### umbreld Client Commands

Direct API commands via the umbreld RPC client for fine-grained control:

```bash
# App lifecycle
umbreld client apps.install.mutate --appId <app-id>
umbreld client apps.uninstall.mutate --appId <app-id>
umbreld client apps.start.mutate --appId <app-id>
umbreld client apps.stop.mutate --appId <app-id>
umbreld client apps.restart.mutate --appId <app-id>

# Monitoring
umbreld client apps.logs --appId <app-id>
umbreld client apps.state --appId <app-id>
```

### umbrel-dev Commands (Development Environment)

```bash
# Start dev environment
npm run dev
npm run dev help              # Show available commands

# App management via dev scripts
npm run dev client -- apps.install.mutate -- --appId <app-id>
npm run dev client -- apps.uninstall.mutate -- --appId <app-id>
```

---

## Docker Commands

```bash
# Container status
docker ps                                   # List running containers
docker ps -a                                # Include stopped
docker ps --filter name=<app-id>            # Filter by app
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"  # Formatted

# Container logs
docker logs <container-name>                # View logs
docker logs -f <container-name>             # Follow in real-time
docker logs --tail 100 <container-name>     # Last N lines
docker logs --since 1h <container-name>     # Since time

# Container inspection
docker inspect <container-name>             # Full details
docker inspect <container-name> | grep -A 10 "Health"  # Health status
docker stats --no-stream                    # Resource usage

# Container interaction
docker exec -it <container-name> /bin/sh    # Shell access
docker exec -it <container-name> /bin/bash  # Bash (if available)

# Image management
docker pull <image>@sha256:<digest>         # Pull specific image
docker inspect --format='{{index .RepoDigests 0}}' <image>:<tag>  # Get digest
docker buildx imagetools inspect <image>:<tag>  # Check multi-arch
```

---

## App Store Management

```bash
# Community stores
sudo ~/umbrel/scripts/repo add <github-url>      # Add community store
sudo ~/umbrel/scripts/repo remove <github-url>    # Remove store
sudo ~/umbrel/scripts/repo update                 # Refresh stores
```

---

## File System Paths

| Path | Description |
|------|-------------|
| `~/umbrel/` | Main Umbrel directory |
| `~/umbrel/app-data/<app-id>/` | App persistent data |
| `~/umbrel/app-stores/` | App store repositories (cached) |
| `~/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/` | Official app store |
| `~/umbrel/scripts/` | System scripts |
| `~/umbrel/scripts/debug` | Debug information script |

---

## Deploying Apps for Testing

```bash
# Copy app to device (physical or dev)
rsync -av --exclude=".gitkeep" \
  <local-path>/<app-id> \
  umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/

# Copy to dev environment
rsync -av --exclude=".gitkeep" \
  <local-path>/<app-id> \
  umbrel@umbrel-dev.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/
```

---

## Debugging & Diagnostics

```bash
# Full system debug
sudo ~/umbrel/scripts/debug

# Check system resources
df -h                         # Disk space
free -h                       # Memory
uptime                        # System uptime

# Check service logs
journalctl -u umbreld --tail 50        # umbreld service logs
journalctl -u umbreld -f               # Follow live

# Network diagnostics
docker network ls                       # List Docker networks
docker network inspect <network-name>   # Network details
ss -tlnp                                # Listening ports
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel
- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
