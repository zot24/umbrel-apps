#!/bin/bash
set -euo pipefail

# Umbrel mounts ${APP_DATA_DIR}/data into the container as root-owned, but the
# Playwright base image runs the server as the unprivileged `pwuser` (UID 1000).
# Without intervention, ensureRendererToken() in server.js fails to persist
# the auto-generated RENDERER_TOKEN to /data/.env (EACCES) and falls back to
# an in-memory token that rotates on every restart.
#
# Fix: start the container as root, hand /data over to pwuser, then drop
# privileges via gosu before exec'ing the server. Mirrors zot24-hermes's
# entrypoint approach but uses gosu instead of NOPASSWD sudo since the
# renderer only needs the one-shot chown at startup.

chown -R pwuser:pwuser /data 2>/dev/null || true

exec gosu pwuser "$@"
