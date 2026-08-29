#!/bin/bash
# Operator console attached to ttyd (Umbrel app UI).
# This is a shell, not the Bridge process — the daemon keeps IMAP/SMTP up
# while you are just looking. `login-cli` pauses mail briefly (one Bridge
# process at a time).

set -euo pipefail
# shellcheck source=/dev/null
source /usr/local/lib/bridge-daemon.sh

cat <<'EOF'
============================================================
  zot24 Proton Mail Bridge
============================================================
  IMAP  zot24-proton-bridge_bridge_1:143
  SMTP  zot24-proton-bridge_bridge_1:25
  STARTTLS, username = full Proton address
  Password = Bridge mailbox password (NOT your Proton password)

  Paid Proton plan required. Free accounts are refused.

  Commands
    login-cli   add/manage account (2FA ok). Pauses mail until you `exit`.
    info-hint   how to print IMAP credentials from the CLI
    status      daemon up/down
    restart     restart daemon after a login

  After login-cli:
    login          (email, Proton password, 2FA)
    info           copy mailbox password into 1Password
    exit           daemon comes back

  Never paste Proton passwords into Telegram.
============================================================
EOF

status_bridge
echo
export HOME=/root
export PATH="/usr/local/bin:${PATH}"
export PS1='bridge> '
exec bash --noprofile --norc -i
