# Rustrak

Self-hosted error tracker for Sentry SDKs. The tile opens on Rustrak's login.
Events are stored in SQLite on the app data volume.

The server image is `rustrak/rustrak-server` (AGPL-3.0). Docs are at
https://rustrak.dev.

## Sign in

Username `admin@rustrak.local`. Password is the value Umbrel shows on the
tile (`deterministicPassword: true`).

Rustrak creates that user on the first start, and only when the database
has no users. A later change to the tile password does not change the
account. The dashboard has no password reset. Keep the tile password.

Umbrel's own proxy login is off. Sentry SDKs post to the same origin as
the dashboard, and they cannot complete an Umbrel login. The dashboard
still requires the Rustrak account.

## Send an error

1. Sign in and create a project.
2. Copy the DSN from the project's SDK settings.
3. Point a Sentry SDK at that DSN.

The DSN host is `http://<device>.local:8686`, where `<device>.local` is
this Umbrel's `DEVICE_DOMAIN_NAME` (usually `umbrel.local`). The SDK's
machine has to reach that address.

Sibling containers can also use `http://zot24-rustrak_web_1:8080` on the
Umbrel Docker network. A DSN copied from the dashboard uses the `.local`
host, not that internal name.

## Data

`/data` on the container is `${APP_DATA_DIR}/data` on the Umbrel.

- `rustrak.db` is the SQLite database.
- `sourcemaps/` holds uploaded source maps.
- `ingest/` holds events that have been accepted and not yet grouped.
  They are stored on the next start.

The server runs as uid 65532. `data-init` creates the directory and sets
that owner before the server starts. Running it again does not change
the result.

`SESSION_SECRET_KEY` is Umbrel's `APP_SEED` for this app. It stays the
same across restarts, so sessions survive an update. Replacing it signs
everyone out.

Anonymous telemetry is off (`RUSTRAK_TELEMETRY=off`).

## Limits

SQLite only. This package does not run Postgres, and it does not publish
the app through Cloudflare Tunnel.

Do not expose port 8686 to the internet. Anyone with a project DSN can
send events, and the login page is on that port.

There is no shell in the server image, so the compose file has no
healthcheck command. The process is the server binary `/app/rustrak`.

## Try it without Umbrel

From this directory, with Docker available:

```bash
export SESSION_SECRET_KEY="$(openssl rand -hex 32)"
export CREATE_SUPERUSER="admin@rustrak.local:$(openssl rand -hex 16)"
export PUBLIC_URL="http://127.0.0.1:8686"
docker compose -f docker-compose.local.yml up -d
```

Open `http://127.0.0.1:8686`. `scripts/verify-local.sh` does the same
steps, then sends one event with the Python Sentry SDK and checks that
an issue exists. It writes a redacted result and does not print the
password, the session key, or the DSN.

## Update the image

Change the image tag and digest in both compose files, and set the same
version in `umbrel-app.yml` and `VERSION`.
