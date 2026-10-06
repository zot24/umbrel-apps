#!/usr/bin/env bash
# Bootstrap agent + platform CLIs onto the herdr persistent volume.
# Safe to re-run. Prefer this over baking huge npm trees into the image.
set -euo pipefail

export HOME=/data
export NPM_CONFIG_PREFIX=/data/.npm-global
export PATH="/usr/local/bin:/data/.npm-global/bin:/data/.grok/bin:/data/.local/bin:/data/.kimi/bin:/data/.kimi-code/bin:/usr/bin:/bin:${PATH:-}"

mkdir -p \
  /data/.npm-global \
  /data/workspaces \
  /data/.config/herdr \
  /data/.grok/bin \
  /data/.local/bin \
  /data/.kimi \
  /data/.kimi-code/bin

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
  log "npm install -g $pkg"
  npm install -g "$pkg"
}

# --- coding agents -----------------------------------------------------------

install_claude() {
  install_npm_pkg "@anthropic-ai/claude-code"
  if have claude && have herdr; then
    herdr integration install claude >/dev/null 2>&1 || true
  fi
}

install_grok() {
  log "install/upgrade Grok Build CLI → /data/.grok/bin"
  # Official xAI installer. HOME=/data so auth + binary land on the volume.
  # GROK_BIN_DIR keeps the binary on the persistent volume explicitly.
  if curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/data/.grok/bin HOME=/data bash; then
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
  if have grok && have herdr; then
    herdr integration install grok >/dev/null 2>&1 || true
  fi
}

install_codex() {
  install_npm_pkg "@openai/codex"
  # Codex keeps auth, config and hooks in ~/.codex (/data/.codex, on the
  # volume). herdr refuses to install its hook until that directory exists,
  # and a fresh install has not created it yet.
  mkdir -p /data/.codex
  if have codex && have herdr; then
    herdr integration install codex >/dev/null 2>&1 || true
  fi
  codex_login_from_env
}

# The Codex TUI ignores OPENAI_API_KEY in the environment; it only uses the
# credentials in ~/.codex/auth.json. Log in with the setup page's key, and
# re-run it each start so a changed key takes effect. Leave a ChatGPT
# sign-in (`codex login --device-auth`) alone.
codex_login_from_env() {
  [ -n "${OPENAI_API_KEY:-}" ] && have codex || return 0
  local status
  status="$(codex login status 2>&1 || true)"
  case "$status" in
    "Not logged in"* | *"API key"*) ;;
    *)
      log "codex: already signed in another way — not touching it"
      return 0
      ;;
  esac
  if printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; then
    log "codex: signed in with OPENAI_API_KEY"
  else
    log "WARN: codex login --with-api-key failed"
  fi
}

install_kimi() {
  log "install/upgrade Kimi Code CLI (official script)"
  if curl -fsSL https://code.kimi.com/kimi-code/install.sh | HOME=/data bash; then
    mkdir -p /data/.npm-global/bin
    for cand in \
      /data/.kimi-code/bin/kimi \
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
    install_npm_pkg "@moonshot-ai/kimi-code" || log "WARN: kimi npm install failed"
  fi
  if have kimi && have herdr; then
    herdr integration install kimi >/dev/null 2>&1 || true
  fi
}

install_pi() {
  # Pi coding-agent harness (pi.dev). Upstream recommends --ignore-scripts;
  # pi needs no postinstall. Lands in /data/.npm-global/bin/pi (on PATH).
  log "npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  if have pi && have herdr; then
    herdr integration install pi >/dev/null 2>&1 || true
  fi
}

# --- platform CLIs -----------------------------------------------------------

install_vercel() {
  install_npm_pkg vercel
}

install_supabase() {
  install_npm_pkg supabase
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
#   claude codex grok kimi vercel supabase pi all
# Default: all of the above (minus anything you strip).
resolve_tools() {
  local raw="${HERDR_BOOTSTRAP_TOOLS:-all}"
  if [ "$raw" = "all" ]; then
    echo "claude codex grok kimi vercel supabase pi"
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
      codex) install_codex ;;
      grok) install_grok ;;
      kimi) install_kimi ;;
      pi) install_pi ;;
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
  for bin in claude codex grok kimi vercel supabase pi gh herdr node npm; do
    if have "$bin"; then
      printf '  %-10s %s\n' "$bin" "$(command -v "$bin")" >&2
      case "$bin" in
        claude|codex|grok|kimi|vercel|supabase|pi|gh|herdr|node|npm)
          "$bin" --version >/dev/null 2>&1 && "$bin" --version 2>&1 | head -1 | sed 's/^/    /' >&2 || true
          ;;
      esac
    else
      printf '  %-10s MISSING\n' "$bin" >&2
    fi
  done
}

main "$@"
