#!/bin/bash
set -euo pipefail

# Prototype entrypoint. Trimmed copy of zot24-herdr/server/entrypoint.sh:
# same /data ownership handoff and first-run seeding, no sshd (nothing to
# attach to locally), and the status server is the foreground process instead
# of `herdr server`.

DATA_DIR=/data
RUN_USER=node

chown "$RUN_USER:$RUN_USER" "$DATA_DIR" 2>/dev/null || true

gosu "$RUN_USER" bash -s <<'EOF'
set -euo pipefail
mkdir -p /data/.config/herdr /data/workspaces /data/.npm-global

if [ ! -f /data/.config/herdr/config.toml ]; then
    printf 'onboarding = false\n' > /data/.config/herdr/config.toml
fi

# Same seeded login profile as the real app: an SSH login inherits none of the
# container's env, so /data/.profile restores PATH and sources /data/.env. The
# wizard's "takes effect immediately for new SSH logins" claim depends on this.
if [ ! -f /data/.profile ]; then
    cat > /data/.profile <<'PROFILE'
# Seeded by the Herdr Umbrel app on first run. Yours to edit.
export NPM_CONFIG_PREFIX=/data/.npm-global
export PATH=/data/.npm-global/bin:$PATH
export LANG=${LANG:-C.UTF-8}

if [ -r /data/.env ]; then
    set -a
    . /data/.env
    set +a
fi
PROFILE
fi
EOF

# A real herdr server, so the dashboard's session table reflects something true.
gosu "$RUN_USER" herdr server &

exec gosu "$RUN_USER" node /app/server.js
