#!/usr/bin/env bash
# Bootstrap agent + platform CLIs onto the herdr persistent volume.
# Safe to re-run. Prefer this over baking huge npm trees into the image.
set -euo pipefail

export HOME=/data
export NPM_CONFIG_PREFIX=/data/.npm-global
export PATH="/data/.npm-global/bin:/data/.grok/bin:/data/.local/bin:/data/.kimi/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

mkdir -p \
  /data/.npm-global \
  /data/workspaces \
  /data/.config/herdr \
  /data/.grok/bin \
  /data/.local/bin \
  /data/.kimi

log() { printf '[bootstrap-agents] %s\n' "$*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

need_npm() {
  have npm || {
    log "npm missing — image is broken"
    exit 1
  }
}

install_npm_pkg() {
  local pkg="$1"
  local bin="${2:-}"
  if [ -n "$bin" ] && have "$bin"; then
    log "skip $pkg ($bin already: $(command -v "$bin"))"
    return 0
  fi
  log "npm install -g $pkg"
  npm install -g "$pkg"
}

# --- coding agents -----------------------------------------------------------

install_claude() {
  install_npm_pkg "@anthropic-ai/claude-code" claude
  if have claude && have herdr; then
    herdr integration install claude >/dev/null 2>&1 || true
  fi
}

install_grok() {
  if have grok; then
    log "skip grok (present: $(command -v grok))"
    return 0
  fi
  log "install Grok Build CLI → /data/.grok/bin"
  # Official xAI installer. HOME=/data so auth + binary land on the volume.
  # GROK_BIN_DIR keeps the binary on the persistent volume explicitly.
  if curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/data/.grok/bin HOME=/data bash; then
    # Ensure PATH-visible symlinks under the npm-global bin (always on PATH).
    mkdir -p /data/.npm-global/bin
    if [ -x /data/.grok/bin/grok ]; then
      ln -sfn /data/.grok/bin/grok /data/.npm-global/bin/grok
    fi
    if [ -x /data/.grok/bin/agent ]; then
      ln -sfn /data/.grok/bin/agent /data/.npm-global/bin/agent
    fi
  else
    log "WARN: grok install failed (network or auth). Retry later."
    return 0
  fi
}

install_kimi() {
  if have kimi; then
    log "skip kimi (present: $(command -v kimi))"
    return 0
  fi
  # Prefer official Moonshot install script (native binary, no Node 24 req).
  log "install Kimi Code CLI (official script)"
  if curl -fsSL https://code.kimi.com/kimi-code/install.sh | HOME=/data bash; then
    # Script usually puts kimi on PATH via ~/.local/bin or similar — link if needed.
    mkdir -p /data/.npm-global/bin
    for cand in \
      /data/.local/bin/kimi \
      /data/.kimi/bin/kimi \
      /data/bin/kimi \
      "$(have kimi && command -v kimi || true)"; do
      if [ -n "$cand" ] && [ -x "$cand" ]; then
        ln -sfn "$cand" /data/.npm-global/bin/kimi
        break
      fi
    done
  else
    log "official kimi script failed — falling back to npm @moonshot-ai/kimi-code"
    install_npm_pkg "@moonshot-ai/kimi-code" kimi || log "WARN: kimi npm install failed"
  fi
  if have kimi && have herdr; then
    herdr integration install kimi >/dev/null 2>&1 || true
  fi
}

# --- platform CLIs -----------------------------------------------------------

install_vercel() {
  install_npm_pkg vercel vercel
}

install_supabase() {
  install_npm_pkg supabase supabase
}

install_gh_note() {
  if have gh; then
    log "gh ok: $(command -v gh) ($(gh --version 2>/dev/null | head -1))"
  else
    log "WARN: gh missing — should be baked into the image"
  fi
}

# --- driver ------------------------------------------------------------------

# HERDR_BOOTSTRAP_TOOLS controls the set. Space-separated tokens:
#   claude grok kimi vercel supabase all
# Default: all of the above (minus anything you strip).
resolve_tools() {
  local raw="${HERDR_BOOTSTRAP_TOOLS:-all}"
  if [ "$raw" = "all" ]; then
    echo "claude grok kimi vercel supabase"
    return
  fi
  echo "$raw"
}

main() {
  need_npm
  install_gh_note

  # Legacy: HERDR_BOOTSTRAP_PACKAGES still accepted for extra npm pkgs.
  local tools
  tools=$(resolve_tools)
  log "tools: $tools"

  for t in $tools; do
    case "$t" in
      claude) install_claude ;;
      grok) install_grok ;;
      kimi) install_kimi ;;
      vercel) install_vercel ;;
      supabase) install_supabase ;;
      gh) install_gh_note ;;
      *)
        # treat unknown token as bare npm package name
        install_npm_pkg "$t"
        ;;
    esac
  done

  if [ -n "${HERDR_BOOTSTRAP_PACKAGES:-}" ]; then
    # shellcheck disable=SC2206
    local extra=(${HERDR_BOOTSTRAP_PACKAGES})
    for pkg in "${extra[@]}"; do
      install_npm_pkg "$pkg"
    done
  fi

  log "done — versions:"
  for bin in claude grok kimi vercel supabase gh herdr node npm; do
    if have "$bin"; then
      printf '  %-10s %s\n' "$bin" "$(command -v "$bin")" >&2
      case "$bin" in
        claude|grok|kimi|vercel|supabase|gh|herdr|node|npm)
          "$bin" --version >/dev/null 2>&1 && "$bin" --version 2>&1 | head -1 | sed 's/^/    /' >&2 || true
          ;;
      esac
    else
      printf '  %-10s MISSING\n' "$bin" >&2
    fi
  done
}

main "$@"
