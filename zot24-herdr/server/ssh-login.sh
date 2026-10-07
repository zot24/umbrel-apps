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
export PATH="/usr/local/bin:/data/.npm-global/bin:/data/.grok/bin:/data/.local/bin:/data/.kimi/bin:/data/.kimi-code/bin:${PATH:-/usr/bin:/bin}"

# Login shells source /data/.profile; `bash -lc` here gives remote commands the
# same PATH (agent CLIs under /data/.npm-global/bin) and the same /data/.env
# secrets an interactive session gets. moshi-hook / herdr / mosh-server must
# resolve in non-interactive SSH (Moshi preflight) even if .profile is old.
#
# The login profile runs first and may push volume dirs ahead of /usr/local/bin
# (installs seeded before 0.9.6 do), so put the image's binaries back in front:
# `herdr --remote` and Moshi must reach the pinned herdr, not a stale copy.
#
# The image ships only the C.UTF-8 locale, but AcceptEnv lets the client push
# its own (e.g. LANG=en_US.UTF-8). mosh-server refuses to start on a
# locale it cannot load, so the Moshi connection dies right after SSH. Pin the
# one that exists; LC_ALL wins over whatever LANG the client or .profile sets.
export LANG=C.UTF-8 LC_ALL=C.UTF-8

# Sibling-app values (Playwright Renderer URL + token) that the entrypoint
# copied out of the container env; see entrypoint.sh.
if [ -r /data/.config/herdr-umbrel/siblings.env ]; then
    set -a
    . /data/.config/herdr-umbrel/siblings.env
    set +a
fi

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    exec bash -lc "PATH=/usr/local/bin:\$PATH; $SSH_ORIGINAL_COMMAND"
fi

exec herdr
