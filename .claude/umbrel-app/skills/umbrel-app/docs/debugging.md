<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md, https://github.com/getumbrel/umbrel -->

# Debugging

Guide to troubleshooting Umbrel app issues.

## Quick Diagnosis

```bash
# 1. SSH into Umbrel
ssh umbrel@umbrel.local

# 2. Check overall system status
umbrel status

# 3. Check specific app
umbreld client apps.state --appId <app-id>
umbreld client apps.logs --appId <app-id>

# 4. Check containers
docker ps --filter name=<app-id>
docker logs <app-id>_web_1
```

---

## Common Issues

### App Won't Install

| Cause | Diagnosis | Fix |
|-------|-----------|-----|
| Invalid YAML syntax | `docker compose config` in app dir | Fix YAML formatting |
| Image not available for architecture | `docker pull <image>@sha256:<digest>` | Build multi-arch image |
| Missing dependencies | Check `dependencies` in manifest | Install required apps first |
| Port conflict | `docker ps --format "{{.Ports}}"` | Change port in compose + manifest |
| Disk full | `df -h` | Free space or expand storage |
| Invalid manifest | Check umbreld logs | Fix `umbrel-app.yml` fields |

### Bad Gateway (502)

Most common issue. The `app_proxy` can't reach the app container.

| Cause | Fix |
|-------|-----|
| Wrong `APP_HOST` | Must be `<app-id>_<service>_1` format |
| Wrong `APP_PORT` | Must match the port app listens on inside container |
| App not fully started | Wait longer, check logs for startup completion |
| App crashed during startup | Check `docker logs <container>` for errors |
| Health check failing | Verify HTTP endpoint responds at the configured port |

### Data Not Persisting

| Cause | Fix |
|-------|-----|
| No volume mounts | Add `- ${APP_DATA_DIR}/data:/data` |
| Using named volumes | Switch to `${APP_DATA_DIR}` paths |
| Wrong path inside container | Verify mount target matches where app writes |
| Permissions issue | Check file ownership in container |

### App Crashes / Restart Loop

```bash
# Check exit code and logs
docker ps -a --filter name=<app-id>
docker logs --tail 100 <app-id>_web_1

# Common causes:
# - Missing environment variables
# - Database connection failed (dependency not ready)
# - Permission denied on data directory
# - Out of memory
```

### Slow Performance

```bash
# Check memory usage
free -h
docker stats --no-stream

# Check disk I/O
iostat -x 1 3

# Check CPU
top -bn1 | head -20

# Common causes:
# - Too many apps running simultaneously
# - Insufficient RAM (4GB minimum recommended)
# - SD card bottleneck (use SSD)
# - Network saturation
```

---

## Debug Commands

### System Level

```bash
# SSH access
ssh umbrel@umbrel.local
# Password: your Umbrel dashboard password

# System status
umbrel status
df -h                    # Disk space
free -h                  # Memory
uptime                   # System uptime

# Run full debug script
sudo ~/umbrel/scripts/debug
```

### App Level

```bash
# View logs
docker logs <container-name>
docker logs -f <container-name>           # Follow live
docker logs --tail 100 <container-name>    # Last 100 lines
umbreld client apps.logs --appId <app-id>  # Via umbreld

# Container inspection
docker ps --filter name=<app-id>           # Running containers
docker ps -a --filter name=<app-id>        # All (including stopped)
docker inspect <container-name>            # Full details
docker inspect <container-name> | grep -A 10 "Health"  # Health status

# Enter container shell
docker exec -it <container-name> /bin/sh
docker exec -it <container-name> /bin/bash  # If bash available

# Check app data
ls -la ~/umbrel/app-data/<app-id>/

# Check app files in store
ls -la ~/umbrel/app-stores/*/<app-id>/
```

### App Lifecycle

```bash
# Restart
umbreld client apps.restart.mutate --appId <app-id>

# Stop and start
umbreld client apps.stop.mutate --appId <app-id>
umbreld client apps.start.mutate --appId <app-id>

# Full reinstall
umbreld client apps.uninstall.mutate --appId <app-id>
# Wait a few seconds
umbreld client apps.install.mutate --appId <app-id>
```

### YAML Validation

```bash
# Validate docker-compose syntax
cat ~/umbrel/app-stores/*/<app-id>/docker-compose.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" && echo "Valid" || echo "Invalid"

# Validate umbrel-app.yml
cat ~/umbrel/app-stores/*/<app-id>/umbrel-app.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)" && echo "Valid" || echo "Invalid"
```

---

## Common Error Patterns

| Symptom | Likely Cause | Debug Command | Fix |
|---------|--------------|---------------|-----|
| App "Not running" | Container crash | `docker logs <container>` | Check logs, fix config |
| "Bad Gateway" | Wrong APP_HOST/PORT | `docker ps` + check compose | Fix proxy config |
| "could not connect" | Dependency not running | `docker ps` | Start dependency first |
| "permission denied" | Wrong file permissions | `ls -la` in container | Fix ownership/permissions |
| "no space left on device" | Disk full | `df -h` | Clean up or expand |
| "OOMKilled" | Out of memory | `docker inspect <c> \| grep OOM` | Increase memory or reduce apps |
| Tor not working | Tor proxy down | Check tor container | Restart Umbrel |
| Can't reach app from LAN | Port not exposed | Check `docker ps` ports | Only needed for non-HTTP |

---

## Deployment Troubleshooting

```bash
# 1. Verify app files exist
ls -la ~/umbrel/app-stores/*/<app-id>/

# 2. Validate YAML syntax
cat ~/umbrel/app-stores/*/<app-id>/docker-compose.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"

# 3. Check image availability
docker pull <image>@sha256:<digest>

# 4. Verify port not in use
docker ps --format "{{.Names}}: {{.Ports}}" | grep <port>
ss -tlnp | grep <port>

# 5. Check dependencies are installed
umbreld client apps.state --appId <dependency-id>

# 6. Check umbrelOS logs for install errors
journalctl -u umbreld --tail 50
```

---

## Nuclear Options

When nothing else works:

```bash
# Force remove all containers for an app
docker ps -a --filter name=<app-id> -q | xargs docker rm -f

# Remove app data (DESTRUCTIVE)
rm -rf ~/umbrel/app-data/<app-id>/

# Reinstall from scratch
umbreld client apps.install.mutate --appId <app-id>
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- https://github.com/getumbrel/umbrel
- https://community.umbrel.com
