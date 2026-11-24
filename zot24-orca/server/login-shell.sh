#!/bin/bash
# ttyd has no login environment of its own. Start the shell the same way an
# SSH login would, with the persistent home and the Orca CLI on PATH.
export HOME=/data/home
export ORCA_USER_DATA=/data/orca
export ORCA_USER_DATA_PATH=/data/orca
export NPM_CONFIG_PREFIX=/data/npm-global
export PATH="/opt/orca-server/bin:/data/npm-global/bin:/data/home/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
cd /data/workspaces 2>/dev/null || cd "$HOME"
exec bash --login
