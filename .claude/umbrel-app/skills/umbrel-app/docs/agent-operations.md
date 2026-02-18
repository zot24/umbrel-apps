<!-- Source: https://github.com/getumbrel/umbrel, https://github.com/getumbrel/umbrel-apps -->

# AI Agent Operations

Workflows optimized for AI agents managing Umbrel systems.

## Debug Error on System

Step-by-step workflow for diagnosing issues:

```bash
# 1. Connect to the device
ssh umbrel@umbrel.local

# 2. Check overall system status
umbrel status

# 3. Check disk space (common root cause)
df -h

# 4. Check memory
free -h

# 5. List running containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 6. Check specific app logs
umbreld client apps.logs --appId <app-id>

# 7. View detailed container logs
docker logs --tail 100 <container-name>

# 8. Check container health
docker inspect <container-name> | grep -A 10 "Health"

# 9. Run system debug script
sudo ~/umbrel/scripts/debug

# 10. Remediation
umbreld client apps.restart.mutate --appId <app-id>   # Restart
# Or full reinstall:
umbreld client apps.uninstall.mutate --appId <app-id>
umbreld client apps.install.mutate --appId <app-id>
```

---

## App Lifecycle Management

```bash
# Check installed apps
umbrel app list

# Check specific app state
umbreld client apps.state --appId <app-id>

# Full reinstall cycle
umbreld client apps.stop.mutate --appId <app-id>
umbreld client apps.uninstall.mutate --appId <app-id>
sleep 5
umbreld client apps.install.mutate --appId <app-id>

# Verify app is running
docker ps --filter name=<app-id>
umbreld client apps.state --appId <app-id>
```

---

## Health Check Workflow

Quick assessment of system health:

```bash
ssh umbrel@umbrel.local << 'EOF'
echo "=== System Status ==="
umbrel status

echo "=== Disk Usage ==="
df -h | grep -E "^/dev|Filesystem"

echo "=== Memory ==="
free -h

echo "=== CPU Load ==="
uptime

echo "=== Running Containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}"

echo "=== Container Resource Usage ==="
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

echo "=== Recent Errors ==="
docker ps -q | head -10 | xargs -I {} sh -c 'name=$(docker inspect --format "{{.Name}}" {}); echo "--- $name ---"; docker logs {} 2>&1 | grep -i "error\|fatal\|panic" | tail -3' 2>/dev/null
EOF
```

---

## Batch Operations

```bash
# Restart all apps (use sparingly)
for app in $(umbrel app list | awk '{print $1}'); do
  echo "Restarting $app..."
  umbreld client apps.restart.mutate --appId $app
  sleep 2
done

# Check all container statuses
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Get logs from all containers for specific app
docker ps --filter name=<app-id> -q | xargs -I {} docker logs --tail 20 {}

# Find containers using most memory
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" | sort -k2 -h -r | head -10

# Find stopped/crashed containers
docker ps -a --filter status=exited --format "table {{.Names}}\t{{.Status}}"
```

---

## App Scaffolding Workflow

For creating a new Umbrel app from scratch:

```bash
# 1. Create directory
mkdir <app-id> && cd <app-id>

# 2. Create required files (agent generates content)
# - docker-compose.yml  (with app_proxy, image@sha256 digests)
# - umbrel-app.yml      (manifest with all required fields)
# - exports.sh          (environment exports, can be empty)

# 3. Get image digest
docker pull <image>:<tag>
docker inspect --format='{{index .RepoDigests 0}}' <image>:<tag>

# 4. Validate locally
docker compose up -d
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/
docker compose down

# 5. Deploy to device for testing
rsync -av ./ umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/<app-id>/
ssh umbrel@umbrel.local "umbreld client apps.install.mutate --appId <app-id>"
```

---

## App Update Workflow

When updating an existing app:

```bash
# 1. Build and push new Docker image
docker buildx build --platform linux/arm64,linux/amd64 \
  --tag yourname/app:v2.0.0 --output "type=registry" .

# 2. Get new digest
docker pull yourname/app:v2.0.0
docker inspect --format='{{index .RepoDigests 0}}' yourname/app:v2.0.0

# 3. Update docker-compose.yml with new image + digest
# 4. Update version and releaseNotes in umbrel-app.yml
# 5. Deploy and test
rsync -av ./ umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/<app-id>/
ssh umbrel@umbrel.local "umbreld client apps.restart.mutate --appId <app-id>"
```

---

## Diagnostic Decision Tree

```
App not working?
├── Can't install?
│   ├── Check YAML syntax
│   ├── Check image digest exists for ARM64 + x86_64
│   └── Check dependencies are installed
├── Bad Gateway?
│   ├── Verify APP_HOST format (<app-id>_<service>_1)
│   ├── Verify APP_PORT matches container port
│   └── Check if container is actually running
├── Data lost after restart?
│   ├── Check volumes use ${APP_DATA_DIR}
│   └── Don't use named volumes
├── Slow/unresponsive?
│   ├── Check memory: free -h
│   ├── Check disk: df -h
│   └── Check container stats: docker stats
└── Crashes/restart loop?
    ├── Check logs: docker logs <container>
    ├── Check OOM: docker inspect | grep OOM
    └── Check permissions on mounted volumes
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel
- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
