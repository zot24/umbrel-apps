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
SSH_PORT="${HERDR_SSH_PORT:-7683}"
SSH_RUN_DIR=/run/herdr-sshd

chown "$RUN_USER:$RUN_USER" "$DATA_DIR" 2>/dev/null || true

# Scratch dir for the generated sshd config. Deliberately NOT on /data: it is
# regenerated on every start, so config fixes ship with app updates instead of
# being shadowed by a stale copy on the volume.
mkdir -p "$SSH_RUN_DIR"
chown "$RUN_USER:$RUN_USER" "$SSH_RUN_DIR"
chmod 700 "$SSH_RUN_DIR"

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

# An SSH login is not a container process, so it inherits none of the image's
# ENV and none of the secrets compose loads from .env. Seed a login profile
# that restores both: agent CLIs on PATH, and the user's own .env sourced so
# ANTHROPIC_API_KEY etc. are present in an SSH shell exactly as they are in
# the web terminal. Only written once — it is yours to edit afterwards.
if [ ! -f /data/.profile ]; then
    cat > /data/.profile <<'PROFILE'
# Seeded by the Herdr Umbrel app on first run. Yours to edit.
export NPM_CONFIG_PREFIX=/data/.npm-global
export PATH=/usr/local/bin:/data/.npm-global/bin:/data/.grok/bin:/data/.local/bin:/data/.kimi/bin:/data/.kimi-code/bin:$PATH
export LANG=${LANG:-C.UTF-8}

# Secrets + git identity from the app's .env, so an SSH session has the same
# environment as the web terminal. Same file compose reads at container start.
if [ -r /data/.env ]; then
    set -a
    . /data/.env
    set +a
fi
PROFILE
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

# ---------------------------------------------------------------------------
# SSH: an sshd inside this container, so a phone (Moshi) or a laptop
# (`herdr --remote`) attaches straight to the app. The alternative — SSH to the
# Umbrel host and `docker exec` in — needs a host-side wrapper script and puts
# the umbrel user in the docker group, which is root-equivalent on the box.
# This keeps the blast radius inside the container.
#
# Port 7683, NOT 7682: 7682 is the agent-bridge above. Key-only, no passwords,
# and sshd runs as the unprivileged runtime user on an unprivileged port, so no
# root daemon survives startup. Always start sshd: Easy Pair writes the first
# key after the QR is scanned, and sshd re-reads authorized_keys per
# connection. Empty keys + no passwords = nobody can log in until a key lands.
# ---------------------------------------------------------------------------
gosu "$RUN_USER" bash -s "$SSH_PORT" "$SSH_RUN_DIR" <<'EOF'
set -euo pipefail
ssh_port="$1"
run_dir="$2"
ssh_dir=/data/.ssh

mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"

# Host keys live on the volume: baking them into the image would ship the same
# key to every installation, and regenerating per start would make every client
# scream MITM after each app update.
if [ ! -f "$ssh_dir/ssh_host_ed25519_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C 'zot24-herdr' -f "$ssh_dir/ssh_host_ed25519_key"
fi
chmod 600 "$ssh_dir/ssh_host_ed25519_key"

# Two ways to authorise a key, because first-time setup has a chicken-and-egg
# problem: you cannot SSH in to add your first key. Either drop it in
# <app-data>/data/.ssh/authorized_keys, or set SSH_AUTHORIZED_KEYS in
# <app-data>/data/.env (';'-separated for more than one) and restart the app.
touch "$ssh_dir/authorized_keys"
chmod 600 "$ssh_dir/authorized_keys"
if [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
    printf '%s\n' "$SSH_AUTHORIZED_KEYS" | tr ';' '\n' | while IFS= read -r key; do
        key="$(printf '%s' "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -n "$key" ] || continue
        grep -qxF "$key" "$ssh_dir/authorized_keys" || printf '%s\n' "$key" >> "$ssh_dir/authorized_keys"
    done
fi

if [ ! -s "$ssh_dir/authorized_keys" ]; then
    echo "ssh: no authorized keys yet — sshd up for Easy Pair (key-only, no passwords)."
fi

cat > "$run_dir/sshd_config" <<CONF
Port ${ssh_port}
ListenAddress 0.0.0.0
HostKey ${ssh_dir}/ssh_host_ed25519_key
AuthorizedKeysFile ${ssh_dir}/authorized_keys
PidFile ${run_dir}/sshd.pid

# Keys only. There is no password on this account and there must never be one:
# the port is published on the Umbrel host, so it is reachable from the LAN.
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
AllowUsers node
UsePAM no

# Land in the Herdr TUI, exactly like \`docker exec -it … herdr\`. The shim
# passes an explicit remote command through instead, so Moshi's picker
# (\`herdr session list --json\`) and \`herdr --remote\` keep working.
ForceCommand /usr/local/lib/herdr-umbrel/ssh-login.sh

# Attach to a terminal multiplexer; nothing here needs to be a network relay.
AllowTcpForwarding no
GatewayPorts no
X11Forwarding no
PermitTunnel no
# Agent forwarding stays on: it is how you push to git from an agent pane
# without copying a private key onto the box.
AllowAgentForwarding yes

PrintMotd no
AcceptEnv LANG LC_*
ClientAliveInterval 30
ClientAliveCountMax 10
CONF
chmod 600 "$run_dir/sshd_config"

# -e logs to stderr so \`docker logs\` / the Umbrel app log shows auth failures.
/usr/sbin/sshd -f "$run_dir/sshd_config" -D -e &
echo "ssh: listening on ${ssh_port} (key auth only, user 'node')"
EOF

# moshi-hook daemon: agent approvals / inbox after Easy Pair. Linux defaults
# to file-backed secrets on /data (no Keychain). Skip install.sh's /dev/tty
# first-run prompt. Logs go to docker logs — serve never prints Easy Pair URLs.
gosu "$RUN_USER" env \
    HOME=/data \
    MOSHI_HOOK_SKIP_FIRST_RUN=1 \
    MOSHI_HERDR_PATH=/usr/local/bin/herdr \
    moshi-hook serve &

# Web UI:
#   7681  web-gate (loading + tile password + key setup) — app_proxy target
#   7684  ttyd, localhost only, --writable (without it the TUI paints and
#         ignores the keyboard). Each attach sources /data/.env so keys
#         saved in the setup page apply without a full container restart.
#
# Umbrel login is gate 1. APP_PASSWORD (tile password) is gate 2.
TTYD_PORT="${HERDR_TTYD_PORT:-7684}"
gosu "$RUN_USER" ttyd \
    --port "$TTYD_PORT" \
    --interface 127.0.0.1 \
    --writable \
    --base-path /t \
    bash -lc 'set -a; [ -r /data/.env ] && . /data/.env; set +a; exec herdr' &

exec gosu "$RUN_USER" node /usr/local/lib/herdr-umbrel/web-gate.mjs
