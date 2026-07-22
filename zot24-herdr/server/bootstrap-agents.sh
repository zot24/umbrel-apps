#!/usr/bin/env bash
# Optional first-boot / on-demand agent CLI bootstrap for the herdr volume.
# Safe to re-run. Installs into NPM_CONFIG_PREFIX=/data/.npm-global (persistent).
set -euo pipefail

export HOME=/data
export NPM_CONFIG_PREFIX=/data/.npm-global
export PATH="/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

mkdir -p /data/.npm-global /data/workspaces /data/.config/herdr

log() { printf '[bootstrap-agents] %s\n' "$*" >&2; }

need_npm() {
  command -v npm >/dev/null 2>&1 || {
    log "npm missing — image is broken"
    exit 1
  }
}

install_npm_pkg() {
  local pkg="$1"
  local bin="${2:-}"
  if [ -n "$bin" ] && command -v "$bin" >/dev/null 2>&1; then
    log "skip $pkg ($bin already present: $(command -v "$bin"))"
    return 0
  fi
  log "npm install -g $pkg"
  npm install -g "$pkg"
}

install_gh() {
  if command -v gh >/dev/null 2>&1; then
    log "skip gh (present: $(command -v gh))"
    return 0
  fi
  # gh may be baked into the image; if not, leave a clear message.
  log "gh not in PATH — rebuild image with gh package or install manually"
}

main() {
  need_npm
  # Core coding agents. Toggle via HERDR_BOOTSTRAP_PACKAGES (space-separated
  # npm package names). Default: claude-code only.
  local packages="${HERDR_BOOTSTRAP_PACKAGES:-@anthropic-ai/claude-code}"
  # shellcheck disable=SC2206
  local list=($packages)
  for pkg in "${list[@]}"; do
    case "$pkg" in
      @anthropic-ai/claude-code) install_npm_pkg "$pkg" claude ;;
      @openai/codex) install_npm_pkg "$pkg" codex ;;
      *) install_npm_pkg "$pkg" ;;
    esac
  done
  install_gh

  if command -v claude >/dev/null 2>&1 && command -v herdr >/dev/null 2>&1; then
    # Best-effort integration hook; ignore failure on older herdr builds.
    herdr integration install claude >/dev/null 2>&1 || true
  fi

  log "done"
  command -v claude >/dev/null 2>&1 && claude --version >&2 || true
  command -v gh >/dev/null 2>&1 && gh --version >&2 || true
}

main "$@"
