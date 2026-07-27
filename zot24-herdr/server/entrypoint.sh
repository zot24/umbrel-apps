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
SSH_PORT="${SSH_PORT:-7682}"
SSH_RUN_DIR=/run/herdr

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
# finishes setup (agent integrations etc.) from the web terminal.
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
export PATH=/data/.npm-global/bin:$PATH
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

# ---------------------------------------------------------------------------
# SSH: an sshd inside this container, so a phone (Moshi) or a laptop
# (`herdr --remote`) attaches straight to the app. The alternative — SSH to the
# Umbrel host and `docker exec` in — needs a host-side wrapper and puts the
# umbrel user in the docker group, which is root-equivalent on the box. This
# keeps the blast radius inside the container.
#
# Key-only, no passwords, and sshd runs as the unprivileged runtime user on an
# unprivileged port, so no root daemon survives startup. It only starts if an
# authorized key exists — an SSH daemon nobody can log into is just surface.
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
    echo "ssh: no authorized keys — sshd not started."
    echo "ssh: add one to <app-data>/data/.ssh/authorized_keys, or set"
    echo "ssh: SSH_AUTHORIZED_KEYS in <app-data>/data/.env, then restart the app."
    exit 0
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
PermitEmptyPasswords no
PermitRootLogin no
AllowUsers node
UsePAM no

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

# -e logs to stderr so `docker logs` / the Umbrel app log shows auth failures.
/usr/sbin/sshd -f "$run_dir/sshd_config" -D -e &
echo "ssh: listening on ${ssh_port} (key auth only, user 'node')"
EOF

# Start the headless herdr server (default session) so agents keep running
# even when no client is attached, and so `herdr session list` works for SSH
# clients (e.g. Moshi's herdr picker) before anyone opens the web UI. If it
# exits early (e.g. a stale socket after an unclean shutdown), the first
# client attach via ttyd will spawn a fresh server instead.
gosu "$RUN_USER" herdr server &

# Web UI: ttyd attaches each browser session to the herdr TUI as a plain
# client. Closing the tab only detaches that client; the server (and every
# agent in it) keeps running. ttyd is reachable only through Umbrel's app
# proxy, which enforces Umbrel authentication — there is deliberately no
# second credential here and no published port.
exec gosu "$RUN_USER" ttyd \
    --port 7681 \
    --interface 0.0.0.0 \
    herdr
