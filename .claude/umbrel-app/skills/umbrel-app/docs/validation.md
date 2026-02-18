<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md, umbreld schema.ts -->

# Validation Checklist

Comprehensive checklist for validating Umbrel apps before submission.

## File Structure

- [ ] `docker-compose.yml` exists
- [ ] `umbrel-app.yml` exists
- [ ] `exports.sh` exists (can be empty)
- [ ] App directory name matches `id` in `umbrel-app.yml`
- [ ] If using hooks: `hooks/` directory with executable scripts

---

## docker-compose.yml Checks

### Required
- [ ] Version is `"3.7"`
- [ ] `app_proxy` service is present with `APP_HOST` and `APP_PORT`
- [ ] `APP_HOST` format: `<app-id>_<service-name>_1` (the `_1` suffix is required)
- [ ] `APP_PORT` matches the port the app listens on inside the container
- [ ] All Docker images use SHA256 digests (`@sha256:...`)
- [ ] SHA256 digest is the **multi-architecture** digest (not platform-specific)
- [ ] `restart: on-failure` is set on app services
- [ ] `stop_grace_period` is set (e.g., `1m`)

### Data Persistence
- [ ] Persistent data volumes use `${APP_DATA_DIR}` prefix
- [ ] No hardcoded paths for app data
- [ ] Bitcoin data mounted as read-only: `${APP_BITCOIN_DATA_DIR}:/bitcoin:ro`
- [ ] Lightning data mounted as read-only: `${APP_LIGHTNING_NODE_DATA_DIR}:/lnd:ro`

### Security
- [ ] No hardcoded secrets or passwords
- [ ] No hardcoded IP addresses
- [ ] Services don't run as root (use `user: "1000:1000"` or `USER 1000` in Dockerfile)
- [ ] Sensitive paths mounted read-only where possible

### Networking
- [ ] No unnecessary port exposures (app_proxy handles routing)
- [ ] Port doesn't conflict with known Umbrel ports or other apps
- [ ] No `network_mode: host`

---

## umbrel-app.yml Checks

### Required Fields
- [ ] `manifestVersion` is `1` or `1.1` (valid semver after normalization)
- [ ] `id` is lowercase alphanumeric with dashes only
- [ ] `id` matches directory name exactly
- [ ] `name` is human-readable
- [ ] `tagline` is a concise one-liner
- [ ] `category` is one of: `files`, `finance`, `media`, `networking`, `social`, `automation`, `developer`, `gaming`
- [ ] `version` follows semver format
- [ ] `port` is a valid integer matching docker-compose
- [ ] `description` is detailed and informative
- [ ] `website` is a valid URL
- [ ] `support` URL is present

### Gallery & Assets
- [ ] `gallery` has 3-5 images
- [ ] Gallery images are 1440x900px PNG
- [ ] Icon is 256x256 SVG (no rounded corners — CSS rounds dynamically)
- [ ] For community stores: `icon` field has full URL

### Optional Fields
- [ ] `dependencies` lists only valid app IDs
- [ ] `submitter` is present
- [ ] `releaseNotes` describes the latest changes
- [ ] `repo` is a valid URL (or empty string)

### For New Submissions
- [ ] `gallery: []` (images added during review)
- [ ] `releaseNotes: ""` (empty for initial submission)

---

## Critical Issues (Automatic Rejection)

| Issue | Why It Fails |
|-------|-------------|
| Image without SHA256 digest | Not deterministic — image could change |
| Missing `app_proxy` service | App won't be routable |
| Wrong `APP_HOST` format | Bad Gateway error |
| Port mismatch between manifest and compose | App unreachable |
| Hardcoded secrets | Security vulnerability |
| Platform-specific digest (not multi-arch) | Fails on ARM or x86 |
| Running as root without justification | Security risk |
| `id` doesn't match directory name | App won't install |

---

## Warnings (May Delay Review)

| Issue | Recommendation |
|-------|---------------|
| No `stop_grace_period` | Add `stop_grace_period: 1m` |
| No `restart` policy | Add `restart: on-failure` |
| Missing `description` | Add detailed app description |
| Missing `dependencies` | Verify no Bitcoin/Lightning deps needed |
| Volumes not using `APP_DATA_DIR` | Data may be lost on reinstall |
| Extra exposed ports | Remove unless needed for non-HTTP protocols |

---

## Automated Validation Script

```bash
#!/bin/bash
# Quick validation for an Umbrel app directory
APP_DIR="${1:-.}"

echo "=== Validating $APP_DIR ==="

# File existence
for f in docker-compose.yml umbrel-app.yml exports.sh; do
  [ -f "$APP_DIR/$f" ] && echo "✓ $f exists" || echo "✗ $f MISSING"
done

# Check app_proxy
grep -q "app_proxy" "$APP_DIR/docker-compose.yml" && echo "✓ app_proxy present" || echo "✗ app_proxy MISSING"

# Check SHA256 digests
if grep -q "image:" "$APP_DIR/docker-compose.yml"; then
  grep "image:" "$APP_DIR/docker-compose.yml" | while read -r line; do
    echo "$line" | grep -q "@sha256:" && echo "✓ SHA256: $line" || echo "✗ No digest: $line"
  done
fi

# Check manifest
if [ -f "$APP_DIR/umbrel-app.yml" ]; then
  for field in id name category version port; do
    grep -q "^${field}:" "$APP_DIR/umbrel-app.yml" && echo "✓ $field present" || echo "✗ $field MISSING"
  done
fi

# Check ID matches directory
DIR_NAME=$(basename "$APP_DIR")
MANIFEST_ID=$(grep "^id:" "$APP_DIR/umbrel-app.yml" 2>/dev/null | awk '{print $2}')
[ "$DIR_NAME" = "$MANIFEST_ID" ] && echo "✓ ID matches directory" || echo "✗ ID mismatch: dir=$DIR_NAME manifest=$MANIFEST_ID"
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- https://github.com/getumbrel/umbrel/blob/master/packages/umbreld/source/modules/apps/schema.ts
