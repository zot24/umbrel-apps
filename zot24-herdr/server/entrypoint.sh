#!/bin/bash
set -euo pipefail

# Umbrel mounts ${APP_DATA_DIR}/data into the container as root-owned, but the
# app runs as the unprivileged `node` user (UID 1000, from the base image).
# Start as root, hand /data over, then drop privileges via gosu — same pattern
# as zot24-playwright-renderer.
#
# Only the top level is chowned (no -R): workspaces under /data can grow to
# gigabytes and a recursive chown would make every container start crawl.
# Subdirectories we seed below are created as the runtime user directly.

DATA_DIR=/data
RUN_USER=node

chown "$RUN_USER:$RUN_USER" "$DATA_DIR" 2>/dev/null || true

# First-run seeding, as the runtime user.
gosu "$RUN_USER" bash -s <<'EOF'
set -euo pipefail
mkdir -p /data/.config/herdr /data/workspaces /data/.npm-global

# Skip the interactive first-run onboarding flow on a headless box; the user
# finishes setup (agent integrations etc.) from the web terminal or via the
# internal agent-bridge API used by sibling apps (Hermes).
if [ ! -f /data/.config/herdr/config.toml ]; then
    printf 'onboarding = false\n' > /data/.config/herdr/config.toml
fi
EOF

# Optional agent/platform CLI bootstrap onto the persistent volume.
# Set HERDR_BOOTSTRAP_AGENTS=1 in /data/.env to install Claude, Grok, Kimi,
# Vercel, Supabase (see bootstrap-agents.sh / HERDR_BOOTSTRAP_TOOLS).
if [ "${HERDR_BOOTSTRAP_AGENTS:-0}" = "1" ]; then
    gosu "$RUN_USER" bash /usr/local/lib/herdr-umbrel/bootstrap-agents.sh || \
        echo "[entrypoint] bootstrap-agents failed (non-fatal)" >&2
fi

# Start the headless herdr server (default session) so agents keep running
# even when no client is attached, and so `herdr session list` works for SSH
# clients (e.g. Moshi's herdr picker) before anyone opens the web UI. If it
# exits early (e.g. a stale socket after an unclean shutdown), the first
# client attach via ttyd will spawn a fresh server instead.
gosu "$RUN_USER" herdr server &

# Internal machine API for sibling Umbrel apps (Hermes, etc.).
# NOT published through app_proxy. Auth: HERDR_AGENT_TOKEN in /data/.env.
# Port default 7682 — see exports.sh APP_ZOT24_HERDR_AGENT_PORT.
gosu "$RUN_USER" node /usr/local/lib/herdr-umbrel/agent-bridge.mjs &

# Web UI: ttyd attaches each browser session to the herdr TUI as a plain
# client. Closing the tab only detaches that client; the server (and every
# agent in it) keeps running. ttyd is reachable only through Umbrel's app
# proxy, which enforces Umbrel authentication — there is deliberately no
# second credential here and no published port.
exec gosu "$RUN_USER" ttyd \
    --port 7681 \
    --interface 0.0.0.0 \
    herdr
