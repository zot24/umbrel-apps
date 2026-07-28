#!/usr/bin/env bash
# One command to build and run the prototype locally.
#
#   ./run.sh          build + start, wait for health, print the URL
#   ./run.sh reset    wipe the scratch data dir first (back to the wizard)
#   ./run.sh stop     stop and remove the container
#   ./run.sh logs     follow container logs
#   ./run.sh shell    a shell in the running container (debugging the prototype)
#   ./run.sh test     drive the wizard headlessly + run the WebSocket auth probes

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SCRATCH="./scratch-data"
URL="http://127.0.0.1:7681"

case "${1:-up}" in
  stop)
    docker compose down --remove-orphans
    exit 0
    ;;
  logs)
    exec docker compose logs -f
    ;;
  shell)
    exec docker compose exec proto bash
    ;;
  test)
    docker compose cp tests/driver.js proto:/tmp/driver.js
    docker compose cp tests/probe.js proto:/tmp/probe.js
    echo "== WebSocket auth probes =="
    docker compose exec -T proto node /tmp/probe.js
    echo
    echo "== Driving the wizard with fake placeholders =="
    docker compose exec -T proto node /tmp/driver.js | tail -30
    exit 0
    ;;
  reset)
    docker compose down --remove-orphans >/dev/null 2>&1 || true
    if [ -d "$SCRATCH" ]; then
      echo "Wiping $SCRATCH …"
      # Written inside the container as uid 1000; on Docker Desktop for Mac the
      # bind mount is owned by you, so a plain rm is enough.
      rm -rf "${SCRATCH:?}"/{.env,.ssh,.config,.npm-global,.profile,workspaces} 2>/dev/null || true
    fi
    ;;
  up) ;;
  *)
    echo "usage: $0 [up|reset|stop|logs|shell]" >&2
    exit 2
    ;;
esac

mkdir -p "$SCRATCH"

echo "Building (first run pulls node:22-bookworm-slim and compiles node-pty — a few minutes)…"
docker compose build

echo "Starting…"
docker compose up -d

printf 'Waiting for the server'
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$URL/health" 2>/dev/null; then
    echo
    echo
    echo "  Open:  $URL"
    echo
    state=$(curl -fsS "$URL/health" 2>/dev/null || echo '{}')
    case "$state" in
      *'"configured":true'*)
        echo "  This scratch dir is already configured — you land on the status page."
        echo "  The wizard is always at $URL/setup, and './run.sh reset' takes you"
        echo "  back to first-run."
        ;;
      *)
        echo "  Not configured yet — you land on the wizard. Use OBVIOUSLY FAKE"
        echo "  placeholder values, e.g. sk-ant-FAKE-do-not-use."
        ;;
    esac
    echo
    echo "  Logs:  ./run.sh logs     Stop: ./run.sh stop     Reset: ./run.sh reset"
    exit 0
  fi
  printf '.'
  sleep 1
done

echo
echo "Server did not come up. Last 40 log lines:" >&2
docker compose logs --tail 40 >&2
exit 1
