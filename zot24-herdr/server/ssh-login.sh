#!/bin/bash
# ForceCommand target for the container's sshd (see entrypoint.sh).
#
# Two jobs, and both matter:
#
#   1. A bare `ssh -p 7683 node@box` lands straight in the Herdr TUI — the same
#      thing `docker exec -it zot24-herdr_server_1 herdr` gives you today.
#   2. An explicit remote command still runs. Moshi's session picker shells out
#      to `herdr session list --json`, and `herdr --remote` invokes `herdr` over
#      SSH; a bare ForceCommand would swallow both and silently break them.
#
# sshd puts the client's requested command in SSH_ORIGINAL_COMMAND when
# ForceCommand is set, so branching on it preserves case 2.
set -euo pipefail

# Login shells source /data/.profile; `bash -lc` here gives remote commands the
# same PATH (agent CLIs under /data/.npm-global/bin) and the same /data/.env
# secrets an interactive session gets.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    exec bash -lc "$SSH_ORIGINAL_COMMAND"
fi

exec herdr
