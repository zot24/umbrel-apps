#!/bin/bash
# Umbrel mounts the data volume as root. Orca refuses a data directory it
# does not own, or one other users can read, because account tokens live
# there. Hand the volume to the unprivileged node user, then drop root.
set -euo pipefail

DATA_DIR=/data
RUN_USER=node

mkdir -p \
  "$DATA_DIR/home/.local/bin" \
  "$DATA_DIR/orca" \
  "$DATA_DIR/workspaces" \
  "$DATA_DIR/npm-global"
# Only these directories. A recursive chown would walk every worktree on
# each start. They are created here, as root, then handed to the runtime user.
chown "$RUN_USER:$RUN_USER" \
  "$DATA_DIR" \
  "$DATA_DIR/home" \
  "$DATA_DIR/home/.local" \
  "$DATA_DIR/home/.local/bin" \
  "$DATA_DIR/orca" \
  "$DATA_DIR/workspaces" \
  "$DATA_DIR/npm-global"
chmod 700 "$DATA_DIR/home" "$DATA_DIR/orca"

gosu "$RUN_USER" bash -s <<'EOF'
set -euo pipefail
if [ ! -f /data/home/.profile ]; then
  cat > /data/home/.profile <<'PROFILE'
# Seeded by the Orca Umbrel app on first run. Yours to edit.
export NPM_CONFIG_PREFIX=/data/npm-global
export PATH=/opt/orca-server/bin:/data/npm-global/bin:/data/home/.local/bin:/usr/local/bin:$PATH
export ORCA_USER_DATA=/data/orca
export ORCA_USER_DATA_PATH=/data/orca
export LANG=C.UTF-8 LC_ALL=C.UTF-8
cd /data/workspaces 2>/dev/null || true
PROFILE
  chmod 600 /data/home/.profile
fi

# git over HTTPS to github.com authenticates through gh. Left alone if a
# github.com helper is already configured.
export HOME=/data/home
if ! git config --global --get-all credential.https://github.com.helper >/dev/null 2>&1; then
  git config --global credential.https://github.com.helper ''
  git config --global --add credential.https://github.com.helper '!/usr/bin/gh auth git-credential'
fi
EOF

export HOME=/data/home
exec gosu "$RUN_USER" node /usr/local/lib/orca-umbrel/gate.mjs
