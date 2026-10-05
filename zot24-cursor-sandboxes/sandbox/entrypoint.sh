#!/usr/bin/env bash
# Sandbox entrypoint. The manager creates the container with:
#   CURSOR_API_KEY   personal Cursor API key (My Machines worker auth)
#   CS_NAME          sandbox name = worker name (`worker=<name>` targets it)
#   CS_REPOS         JSON array of {"url": "...", "branch": "..."}
#   GH_TOKEN         optional GitHub token: clone/push over HTTPS, gh CLI
#   CS_GIT_NAME      optional commit identity
#   CS_GIT_EMAIL
#   CS_CONNECT_WORKSPACE=1  optional: pass --connect-workspace
#
# Runs as root only long enough to fix volume ownership and Docker socket
# access, then re-execs itself as `agent` to clone repos and start the worker.
set -euo pipefail

log() { printf '[sandbox] %s\n' "$*"; }
fail() {
  # Visible in the manager's log view. Sleep first so a bad config does not
  # spin the restart loop; Docker restarts the container after we exit.
  printf '[sandbox] ERROR: %s\n' "$*"
  sleep 60
  exit 1
}

if [ "$(id -u)" = 0 ]; then
  # A fresh volume is populated from the image (owned by agent). Re-own only
  # when the top level is wrong, e.g. a volume created by hand.
  if [ "$(stat -c %U /home/agent)" != agent ]; then
    log "fixing ownership of /home/agent"
    chown -R agent:agent /home/agent
  fi

  # Docker access (opt-in per sandbox): the manager bind-mounts the app's
  # private daemon socket. Give agent the socket's group so `docker` works
  # without sudo.
  if [ -S /var/run/docker.sock ]; then
    gid="$(stat -c %g /var/run/docker.sock)"
    group="$(getent group "$gid" | cut -d: -f1 || true)"
    if [ -z "$group" ]; then
      group=dockersock
      groupadd -g "$gid" "$group"
    fi
    usermod -aG "$group" agent
    log "docker access enabled (group $group)"
  fi

  exec setpriv --reuid=agent --regid=agent --init-groups \
    env HOME=/home/agent USER=agent LOGNAME=agent "$0" "$@"
fi

: "${CS_NAME:?CS_NAME is required}"
[ -n "${CURSOR_API_KEY:-}" ] || fail "no Cursor API key. Add one on the app's setup page."

cd "$HOME"

git config --global init.defaultBranch main
git config --global advice.detachedHead false
if [ -n "${CS_GIT_NAME:-}" ]; then git config --global user.name "$CS_GIT_NAME"; fi
if [ -n "${CS_GIT_EMAIL:-}" ]; then git config --global user.email "$CS_GIT_EMAIL"; fi

# GitHub over HTTPS with the token from the environment. The helper reads
# $GH_TOKEN when git asks, so the token is never written to ~/.gitconfig.
git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --add credential.https://github.com.helper ''
  git config --global --add credential.https://github.com.helper \
    '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
fi

# Clone each repo once. An existing checkout is never touched: it may hold
# an agent's uncommitted work.
mkdir -p "$HOME/work"
worker_dirs=()
while IFS=$'\t' read -r url branch; do
  [ -n "$url" ] || continue
  dir="$HOME/work/$(basename "$url" .git)"
  if [ ! -d "$dir/.git" ]; then
    log "cloning $url${branch:+ ($branch)}"
    rm -rf "$dir.partial"
    clone=(git clone --quiet)
    if [ -n "$branch" ]; then clone+=(--branch "$branch"); fi
    if ! GIT_TERMINAL_PROMPT=0 "${clone[@]}" -- "$url" "$dir.partial"; then
      rm -rf "$dir.partial"
      fail "could not clone $url. Private repo? Add a GitHub token on the setup page."
    fi
    mv "$dir.partial" "$dir"
  fi
  worker_dirs+=(--worker-dir "$dir")
done < <(jq -r '.[] | [.url, (.branch // "")] | @tsv' <<<"${CS_REPOS:-[]}")

[ "${#worker_dirs[@]}" -gt 0 ] || fail "no repositories configured for this sandbox."

args=(worker
  --name "$CS_NAME"
  --data-dir "$HOME/.cursor-worker"
  --management-addr 127.0.0.1:9090
)
if [ "${CS_CONNECT_WORKSPACE:-0}" = 1 ]; then args+=(--connect-workspace); fi
args+=("${worker_dirs[@]}")

log "starting worker '$CS_NAME' (cursor agent $(agent --version))"
exec agent "${args[@]}" start
