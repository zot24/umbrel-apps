#!/usr/bin/env bash
# Check upstream herdr + ttyd (and snapshot agent CLI latest versions).
# If image pins are behind, rewrite Dockerfile / VERSION / umbrel-app.yml.
# Does not commit. The GitHub Action opens the PR.
#
# Usage (from repo root):
#   bash zot24-herdr/ci/update-deps.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/zot24-herdr"
DF="$APP/server/Dockerfile"
MANIFEST="$APP/umbrel-app.yml"
VERSION_FILE="$APP/VERSION"
CLI_JSON="$APP/cli-versions.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

UA="zot24-herdr-update-deps"
github_json() {
  local url="$1"
  if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    gh api "$url"
  else
    curl -fsSL -H "User-Agent: $UA" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/$url"
  fi
}

current_arg() {
  local key="$1"
  grep -E "^ARG ${key}=" "$DF" | head -1 | cut -d= -f2-
}

HERDR_CUR="$(current_arg HERDR_VERSION)"
TTYD_CUR="$(current_arg TTYD_VERSION)"

HERDR_LATEST_TAG="$(github_json repos/ogulcancelik/herdr/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
HERDR_LATEST="${HERDR_LATEST_TAG#v}"
TTYD_LATEST="$(github_json repos/tsl0922/ttyd/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"

npm_latest() {
  curl -fsSL -H "User-Agent: $UA" "https://registry.npmjs.org/$1/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

CLAUDE_V="$(npm_latest @anthropic-ai/claude-code)"
VERCEL_V="$(npm_latest vercel)"
SUPABASE_V="$(npm_latest supabase)"

python3 - "$CLI_JSON" "$HERDR_CUR" "$HERDR_LATEST" "$TTYD_CUR" "$TTYD_LATEST" \
  "$CLAUDE_V" "$VERCEL_V" "$SUPABASE_V" <<'PY'
import json, sys, datetime
path, herdr_cur, herdr_latest, ttyd_cur, ttyd_latest, claude, vercel, supabase = sys.argv[1:]
doc = {
    "checked_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "image_pins": {
        "herdr": {"current": herdr_cur, "latest_stable": herdr_latest},
        "ttyd": {"current": ttyd_cur, "latest_stable": ttyd_latest},
    },
    "volume_clis_latest": {
        "claude-code": claude,
        "vercel": vercel,
        "supabase": supabase,
        "grok": "install.sh (unpinned)",
        "kimi": "install.sh (unpinned)",
        "gh": "apt (image rebuild)",
    },
    "note": "Volume CLIs upgrade on container start via bootstrap-agents.sh. Image pins (herdr/ttyd) change only via this script + Build: Herdr.",
}
with open(path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(json.dumps(doc["image_pins"], indent=2))
print("cli snapshot", path)
PY

changed=0

if [ "$HERDR_LATEST" != "$HERDR_CUR" ]; then
  echo "==> herdr $HERDR_CUR → $HERDR_LATEST"
  for arch in x86_64 aarch64; do
    curl -fsSL -o "$TMP/herdr-linux-${arch}" \
      "https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_LATEST}/herdr-linux-${arch}"
  done
  SHA_X86="$(sha256sum "$TMP/herdr-linux-x86_64" | awk '{print $1}')"
  SHA_ARM="$(sha256sum "$TMP/herdr-linux-aarch64" | awk '{print $1}')"
  echo "    x86_64  $SHA_X86"
  echo "    aarch64 $SHA_ARM"
  python3 - "$DF" "$HERDR_LATEST" "$SHA_X86" "$SHA_ARM" <<'PY'
from pathlib import Path
import re, sys
path, ver, sha_x, sha_a = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r"(#   - herdr v)[0-9.]+", rf"\g<1>{ver}", text, count=1)
text = re.sub(r"^ARG HERDR_VERSION=.*$", f"ARG HERDR_VERSION={ver}", text, count=1, flags=re.M)
text = re.sub(r"(# v)[0-9.]+( release assets on )[0-9-]+", rf"\g<1>{ver}\g<2>auto", text, count=1)
text = re.sub(r"^ARG HERDR_SHA256_X86_64=.*$", f"ARG HERDR_SHA256_X86_64={sha_x}", text, count=1, flags=re.M)
text = re.sub(r"^ARG HERDR_SHA256_AARCH64=.*$", f"ARG HERDR_SHA256_AARCH64={sha_a}", text, count=1, flags=re.M)
Path(path).write_text(text)
PY
  changed=1
else
  echo "herdr pin current ($HERDR_CUR)"
fi

if [ "$TTYD_LATEST" != "$TTYD_CUR" ]; then
  echo "==> ttyd $TTYD_CUR → $TTYD_LATEST"
  curl -fsSL -o "$TMP/SHA256SUMS" \
    "https://github.com/tsl0922/ttyd/releases/download/${TTYD_LATEST}/SHA256SUMS"
  SHA_X86="$(awk '/ ttyd.x86_64$/{print $1}' "$TMP/SHA256SUMS")"
  SHA_ARM="$(awk '/ ttyd.aarch64$/{print $1}' "$TMP/SHA256SUMS")"
  if [ -z "$SHA_X86" ] || [ -z "$SHA_ARM" ]; then
    echo "::error::could not parse ttyd SHA256SUMS"
    exit 1
  fi
  python3 - "$DF" "$TTYD_LATEST" "$SHA_X86" "$SHA_ARM" <<'PY'
from pathlib import Path
import re, sys
path, ver, sha_x, sha_a = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r"^ARG TTYD_VERSION=.*$", f"ARG TTYD_VERSION={ver}", text, count=1, flags=re.M)
text = re.sub(r"^ARG TTYD_SHA256_X86_64=.*$", f"ARG TTYD_SHA256_X86_64={sha_x}", text, count=1, flags=re.M)
text = re.sub(r"^ARG TTYD_SHA256_AARCH64=.*$", f"ARG TTYD_SHA256_AARCH64={sha_a}", text, count=1, flags=re.M)
Path(path).write_text(text)
PY
  changed=1
else
  echo "ttyd pin current ($TTYD_CUR)"
fi

if [ "$changed" -eq 1 ]; then
  NEW_VER="$(current_arg HERDR_VERSION)"
  printf '%s\n' "$NEW_VER" > "$VERSION_FILE"
  python3 - "$MANIFEST" "$NEW_VER" "$HERDR_CUR" "$HERDR_LATEST" <<'PY'
from pathlib import Path
import re, sys
path, new_ver, old_herdr, new_herdr = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r'^version: ".*"', f'version: "{new_ver}"', text, count=1, flags=re.M)
note = (
    f"  {new_ver}: Herdr binary {old_herdr} → {new_herdr}. "
    "Image pins refreshed by zot24-herdr/ci/update-deps.sh.\n\n\n"
)
text = re.sub(r"(releaseNotes: >-\n)", rf"\1{note}", text, count=1)
Path(path).write_text(text)
PY
  echo "bumped app version to $NEW_VER"
else
  echo "no image pin changes"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "changed=$changed" >> "$GITHUB_OUTPUT"
  echo "herdr_current=$HERDR_CUR" >> "$GITHUB_OUTPUT"
  echo "herdr_latest=$HERDR_LATEST" >> "$GITHUB_OUTPUT"
  echo "ttyd_current=$TTYD_CUR" >> "$GITHUB_OUTPUT"
  echo "ttyd_latest=$TTYD_LATEST" >> "$GITHUB_OUTPUT"
fi
exit 0
