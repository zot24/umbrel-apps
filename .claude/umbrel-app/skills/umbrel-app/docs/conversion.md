<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md -->

# Docker-to-Umbrel Conversion

Guide to converting existing Docker Compose applications to the Umbrel app format.

## Conversion Steps

### 1. Add app_proxy Service

Insert the `app_proxy` service that routes traffic and provides Umbrel authentication:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: <app-id>_<service-name>_1   # Note: _1 suffix required
      APP_PORT: <port>
```

### 2. Pin Docker Images to Digests

Replace mutable tags with SHA256 digests:

```bash
# Pull the image
docker pull myapp/server:v1.0

# Get the multi-architecture digest
docker inspect --format='{{index .RepoDigests 0}}' myapp/server:v1.0
# Output: myapp/server@sha256:abc123...

# For multi-arch builds, use the manifest digest:
docker buildx imagetools inspect myapp/server:v1.0
```

Before:
```yaml
image: myapp/server:v1.0
```

After:
```yaml
image: myapp/server:v1.0@sha256:abc123def456...
```

### 3. Map Volumes to APP_DATA_DIR

Replace hardcoded paths with Umbrel's persistent storage variable:

Before:
```yaml
volumes:
  - ./data:/app/data
  - myapp_db:/var/lib/postgresql
```

After:
```yaml
volumes:
  - ${APP_DATA_DIR}/data:/app/data
  - ${APP_DATA_DIR}/db:/var/lib/postgresql
```

**Important**: Named volumes (`myapp_db:`) will NOT persist across reinstalls. Always use `${APP_DATA_DIR}`.

### 4. Replace Environment Variables

Map your app's environment variables to Umbrel-provided ones:

Before:
```yaml
environment:
  BITCOIN_RPC_HOST: 192.168.1.100
  BITCOIN_RPC_USER: admin
  BITCOIN_RPC_PASS: password123
```

After:
```yaml
environment:
  BITCOIN_RPC_HOST: $APP_BITCOIN_NODE_IP
  BITCOIN_RPC_USER: $APP_BITCOIN_RPC_USER
  BITCOIN_RPC_PASS: $APP_BITCOIN_RPC_PASS
```

### 5. Set Docker Compose Version and Restart Policy

```yaml
version: "3.7"

services:
  web:
    image: ...
    restart: on-failure
    stop_grace_period: 1m
```

### 6. Remove Unnecessary Port Exposures

The `app_proxy` handles routing — you usually don't need to expose ports:

Before:
```yaml
ports:
  - "8080:8080"
```

After:
```yaml
# Remove ports section — app_proxy handles it via APP_HOST/APP_PORT
# Only keep ports for non-HTTP protocols (e.g., TCP/UDP services)
```

### 7. Remove Network Configuration

Umbrel manages networking. Remove custom networks:

Before:
```yaml
networks:
  mynetwork:
    driver: bridge
```

After: Remove the `networks` section entirely.

### 8. Create umbrel-app.yml and exports.sh

See [scaffolding.md](scaffolding.md) for templates.

---

## Environment Variable Reference

### System Variables

| Variable | Description |
|----------|-------------|
| `$DEVICE_HOSTNAME` | Umbrel device hostname (e.g., "umbrel") |
| `$DEVICE_DOMAIN_NAME` | Local domain (e.g., "umbrel.local") |

### App Variables

| Variable | Description |
|----------|-------------|
| `$APP_DATA_DIR` | Persistent storage path for this app |
| `$APP_PASSWORD` | Auto-generated unique password (shown in UI) |
| `$APP_SEED` | Deterministic 256-bit hex string derived from Umbrel seed + app ID |
| `$APP_HIDDEN_SERVICE` | Tor .onion address for this app |

### Tor Proxy

| Variable | Description |
|----------|-------------|
| `$TOR_PROXY_IP` | Local IP of Tor SOCKS proxy |
| `$TOR_PROXY_PORT` | Tor proxy port (typically 9050) |

### Bitcoin Core

| Variable | Description |
|----------|-------------|
| `$APP_BITCOIN_NODE_IP` | Bitcoin Core container IP |
| `$APP_BITCOIN_RPC_PORT` | RPC port |
| `$APP_BITCOIN_RPC_USER` | RPC username |
| `$APP_BITCOIN_RPC_PASS` | RPC password |
| `$APP_BITCOIN_DATA_DIR` | Bitcoin data directory (mount read-only) |
| `$APP_BITCOIN_NETWORK` | Network: mainnet, testnet, signet, regtest |
| `$APP_BITCOIN_RPC_HIDDEN_SERVICE` | Tor hidden service for RPC |
| `$APP_BITCOIN_P2P_HIDDEN_SERVICE` | Tor hidden service for P2P |

### Lightning (LND)

| Variable | Description |
|----------|-------------|
| `$APP_LIGHTNING_NODE_IP` | LND container IP |
| `$APP_LIGHTNING_NODE_GRPC_PORT` | gRPC port |
| `$APP_LIGHTNING_NODE_REST_PORT` | REST API port |
| `$APP_LIGHTNING_NODE_DATA_DIR` | LND data directory (mount read-only) |

### Electrs

| Variable | Description |
|----------|-------------|
| `$APP_ELECTRS_NODE_IP` | Electrs container IP |
| `$APP_ELECTRS_NODE_PORT` | Electrs port |

---

## Conversion Checklist

- [ ] Added `app_proxy` service with correct `APP_HOST` and `APP_PORT`
- [ ] All images pinned with `@sha256:` digests (multi-arch)
- [ ] Volumes use `${APP_DATA_DIR}` prefix
- [ ] Environment variables use Umbrel-provided `$APP_*` variables
- [ ] `version: "3.7"` set
- [ ] `restart: on-failure` on all services
- [ ] `stop_grace_period` set
- [ ] Unnecessary port exposures removed
- [ ] Custom networks removed
- [ ] `umbrel-app.yml` manifest created
- [ ] `exports.sh` created (even if empty)
- [ ] App ID is lowercase alphanumeric with dashes
- [ ] Tested locally with `docker compose up`

---

## Common Conversion Patterns

### Database + Web App

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: myapp/web:v1.0@sha256:abc...
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - db
    environment:
      DATABASE_URL: postgresql://myapp:myapp@my-app_db_1:5432/myapp

  db:
    image: postgres:15@sha256:def...
    restart: on-failure
    volumes:
      - ${APP_DATA_DIR}/db:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: myapp
      POSTGRES_DB: myapp
```

### Bitcoin-Dependent App

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-btc-app_web_1
      APP_PORT: 8080

  web:
    image: myapp/btc-tool:v1.0@sha256:abc...
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_BITCOIN_DATA_DIR}:/bitcoin:ro
    environment:
      BITCOIN_HOST: $APP_BITCOIN_NODE_IP
      BITCOIN_PORT: $APP_BITCOIN_RPC_PORT
      BITCOIN_USER: $APP_BITCOIN_RPC_USER
      BITCOIN_PASS: $APP_BITCOIN_RPC_PASS
```

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
- https://github.com/getumbrel/umbrel-apps/blob/master/bitcoin/exports.sh
- https://github.com/getumbrel/umbrel-apps/blob/master/lightning/exports.sh
