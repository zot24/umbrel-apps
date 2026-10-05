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

# Clone each configured repo, and keep an existing checkout in step with the
# URL and branch when the worktree is clean. A dirty checkout is never
# reset or deleted: the worker refuses to start until that is resolved.
# The marker lives in .git so it is not an untracked file in the worktree.
mkdir -p "$HOME/work"
declare -A wanted=()
worker_dirs=()

marker_of() { printf '%s/.git/cs-clone' "$1"; }

worktree_dirty() {
  [ -n "$(git -C "$1" status --porcelain)" ]
}

sync_repo() {
  local url="$1" branch="$2"
  local dir="$HOME/work/$(basename "$url" .git)"
  local marker origin current
  marker="$(marker_of "$dir")"
  if [ ! -d "$dir/.git" ]; then
    log "cloning $url${branch:+ ($branch)}"
    rm -rf "$dir.partial"
    local -a clone=(git clone --quiet)
    if [ -n "$branch" ]; then clone+=(--branch "$branch"); fi
    if ! GIT_TERMINAL_PROMPT=0 "${clone[@]}" -- "$url" "$dir.partial"; then
      rm -rf "$dir.partial"
      fail "could not clone $url. Private repo? Add a GitHub token on the setup page."
    fi
    mv "$dir.partial" "$dir"
    printf '%s\t%s\n' "$url" "$branch" >"$marker"
    return
  fi

  origin="$(git -C "$dir" remote get-url origin)"
  current="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  if [ "$origin" = "$url" ] && { [ -z "$branch" ] || [ "$current" = "$branch" ]; }; then
    printf '%s\t%s\n' "$url" "$branch" >"$marker"
    return
  fi
  if worktree_dirty "$dir"; then
    fail "$dir has local changes, so it was not switched${branch:+ to $branch} ($url). Commit or discard them, or delete the sandbox."
  fi
  log "updating $dir${branch:+ to $branch}"
  git -C "$dir" remote set-url origin "$url"
  if ! GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --quiet origin; then
    fail "could not fetch $url"
  fi
  if [ -n "$branch" ]; then
    if ! git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      fail "branch $branch was not found in $url"
    fi
    git -C "$dir" checkout --quiet -B "$branch" "origin/$branch"
  fi
  printf '%s\t%s\n' "$url" "$branch" >"$marker"
}

repos_file="$HOME/.cs-repos.tsv"
printf '%s' "${CS_REPOS:-[]}" | jq -r '.[] | [.url, (.branch // "")] | @tsv' >"$repos_file"
while IFS=$'\t' read -r url branch || [ -n "${url:-}" ]; do
  [ -n "$url" ] || continue
  dir="$HOME/work/$(basename "$url" .git)"
  sync_repo "$url" "$branch"
  wanted["$dir"]=1
  worker_dirs+=(--worker-dir "$dir")
done <"$repos_file"
rm -f "$repos_file"

shopt -s nullglob
for dir in "$HOME/work"/*; do
  [ -d "$dir/.git" ] || continue
  [ -f "$(marker_of "$dir")" ] || continue
  [ -n "${wanted[$dir]+x}" ] && continue
  if worktree_dirty "$dir"; then
    log "leaving $(basename "$dir") (removed from this sandbox, but it has local changes)"
    continue
  fi
  log "removing $(basename "$dir") (no longer in this sandbox)"
  rm -rf "$dir"
done

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
