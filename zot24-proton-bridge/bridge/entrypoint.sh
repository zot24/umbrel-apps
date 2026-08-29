#!/bin/bash
set -euo pipefail

# HOME is /root in the upstream image. Umbrel bind-mounts the app data
# volume there so pass/gpg + Bridge vault survive updates.
export HOME=/root
export PATH="/usr/local/bin:${PATH}"

# socat makes IMAP/SMTP look like they come from 127.0.0.1 (Bridge requires
# that) and lets us listen on the real 143/25 ports for sibling apps.
socat TCP-LISTEN:25,fork,reuseaddr TCP:127.0.0.1:1025 &
socat TCP-LISTEN:143,fork,reuseaddr TCP:127.0.0.1:1143 &

# shellcheck source=/dev/null
source /usr/local/lib/bridge-daemon.sh

# If the user has already logged in, bring IMAP up without opening the UI.
if [ -d /root/.password-store ]; then
    start_bridge_daemon || true
fi

# Web UI: ttyd is reachable only through Umbrel's app proxy (Umbrel login).
# Do not publish port 7681. Closing the tab does not stop the daemon.
exec ttyd \
    --port 7681 \
    --interface 0.0.0.0 \
    --writable \
    /usr/local/bin/bridge-console
