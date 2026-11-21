#!/usr/bin/env bash
# Check upstream herdr-core + ttyd + moshi-hook (and snapshot agent
# CLI latest versions).
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

TTYD_CUR="$(current_arg TTYD_VERSION)"

TTYD_LATEST="$(github_json repos/tsl0922/ttyd/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"

# herdr-core ships on releases.herdr.dev, not GitHub releases. latest.json
# names the version; that version's manifest.json holds each tarball's sha256.
HC_CUR="$(current_arg HC_VERSION)"
HC_LATEST="$(curl -fsSL -H "User-Agent: $UA" https://releases.herdr.dev/core/latest.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"

MOSHI_CUR="$(current_arg MOSHI_HOOK_VERSION)"
MOSHI_LATEST="$(curl -fsSL -H "User-Agent: $UA" https://cdn.getmoshi.app/hook/latest/version.txt | tr -d " \r\n")"
MOSHI_LATEST="${MOSHI_LATEST#v}"

npm_latest() {
  curl -fsSL -H "User-Agent: $UA" "https://registry.npmjs.org/$1/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

CLAUDE_V="$(npm_latest @anthropic-ai/claude-code)"
VERCEL_V="$(npm_latest vercel)"
SUPABASE_V="$(npm_latest supabase)"

python3 - "$CLI_JSON" "$HC_CUR" "$HC_LATEST" "$TTYD_CUR" "$TTYD_LATEST" \
  "$MOSHI_CUR" "$MOSHI_LATEST" "$CLAUDE_V" "$VERCEL_V" "$SUPABASE_V" <<'PY'
import json, sys, datetime
path, hc_cur, hc_latest, ttyd_cur, ttyd_latest, moshi_cur, moshi_latest, claude, vercel, supabase = sys.argv[1:]
doc = {
    "checked_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "image_pins": {
        "herdr-core": {"current": hc_cur, "latest_stable": hc_latest},
        "ttyd": {"current": ttyd_cur, "latest_stable": ttyd_latest},
        "moshi-hook": {"current": moshi_cur, "latest_stable": moshi_latest},
    },
    "volume_clis_latest": {
        "claude-code": claude,
        "vercel": vercel,
        "supabase": supabase,
        "grok": "install.sh (unpinned)",
        "kimi": "install.sh (unpinned)",
        "gh": "apt (image rebuild)",
    },
    "note": "Volume CLIs upgrade on container start via bootstrap-agents.sh. Image pins (herdr-core/ttyd/moshi-hook) change only via this script + Build: Herdr.",
}
with open(path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(json.dumps(doc["image_pins"], indent=2))
print("cli snapshot", path)
PY

changed=0

if [ "$HC_LATEST" != "$HC_CUR" ]; then
  echo "==> herdr-core $HC_CUR → $HC_LATEST"
  curl -fsSL -H "User-Agent: $UA" -o "$TMP/hc-manifest.json" \
    "https://releases.herdr.dev/core/${HC_LATEST}/manifest.json"
  SHA_X86="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["targets"]["linux-x86_64"]["sha256"])' "$TMP/hc-manifest.json")"
  SHA_ARM="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["targets"]["linux-aarch64"]["sha256"])' "$TMP/hc-manifest.json")"
  echo "    x86_64  $SHA_X86"
  echo "    aarch64 $SHA_ARM"
  python3 - "$DF" "$HC_LATEST" "$SHA_X86" "$SHA_ARM" <<'PY'
from pathlib import Path
import re, sys
path, ver, sha_x, sha_a = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r"(#   - herdr-core \(hc\) v)[0-9.]+", rf"\g<1>{ver}", text, count=1)
text = re.sub(r"^ARG HC_VERSION=.*$", f"ARG HC_VERSION={ver}", text, count=1, flags=re.M)
text = re.sub(r"^ARG HC_SHA256_X86_64=.*$", f"ARG HC_SHA256_X86_64={sha_x}", text, count=1, flags=re.M)
text = re.sub(r"^ARG HC_SHA256_AARCH64=.*$", f"ARG HC_SHA256_AARCH64={sha_a}", text, count=1, flags=re.M)
Path(path).write_text(text)
PY
  changed=1
else
  echo "herdr-core pin current ($HC_CUR)"
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

if [ -n "$MOSHI_LATEST" ] && [ "$MOSHI_LATEST" != "$MOSHI_CUR" ]; then
  echo "==> moshi-hook $MOSHI_CUR -> $MOSHI_LATEST"
  curl -fsSL -o "$TMP/mh-x86_64.tgz" "https://cdn.getmoshi.app/hook/v${MOSHI_LATEST}/moshi-hook_Linux_x86_64.tar.gz"
  curl -fsSL -o "$TMP/mh-arm64.tgz"  "https://cdn.getmoshi.app/hook/v${MOSHI_LATEST}/moshi-hook_Linux_arm64.tar.gz"
  SHA_X86="$(sha256sum "$TMP/mh-x86_64.tgz" | awk '{print $1}')"
  SHA_ARM="$(sha256sum "$TMP/mh-arm64.tgz" | awk '{print $1}')"
  echo "    x86_64  $SHA_X86"
  echo "    arm64   $SHA_ARM"
  python3 - "$DF" "$MOSHI_LATEST" "$SHA_X86" "$SHA_ARM" <<'PY'
from pathlib import Path
import re, sys
path, ver, sha_x, sha_a = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r"^ARG MOSHI_HOOK_VERSION=.*$", f"ARG MOSHI_HOOK_VERSION={ver}", text, count=1, flags=re.M)
text = re.sub(r"^ARG MOSHI_HOOK_SHA256_X86_64=.*$", f"ARG MOSHI_HOOK_SHA256_X86_64={sha_x}", text, count=1, flags=re.M)
text = re.sub(r"^ARG MOSHI_HOOK_SHA256_AARCH64=.*$", f"ARG MOSHI_HOOK_SHA256_AARCH64={sha_a}", text, count=1, flags=re.M)
Path(path).write_text(text)
PY
  changed=1
else
  echo "moshi-hook pin current ($MOSHI_CUR)"
fi

if [ "$changed" -eq 1 ]; then
  CUR_APP_VER="$(grep -E '^version: ' "$MANIFEST" | sed -E 's/^version: *"([^"]+)".*/\1/')"
  NEW_VER="$(python3 -c 'import sys; a=sys.argv[1].split("."); a[-1]=str(int(a[-1])+1); print(".".join(a))' "$CUR_APP_VER")"
  printf '%s\n' "$NEW_VER" > "$VERSION_FILE"
  python3 - "$MANIFEST" "$NEW_VER" "$HC_LATEST" <<'PY'
from pathlib import Path
import re, sys
path, new_ver, new_hc = sys.argv[1:]
text = Path(path).read_text()
text = re.sub(r'^version: ".*"', f'version: "{new_ver}"', text, count=1, flags=re.M)
note = (
    f"  {new_ver}: image pins refreshed (herdr-core {new_hc}; see cli-versions.json). "
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
  echo "hc_current=$HC_CUR" >> "$GITHUB_OUTPUT"
  echo "hc_latest=$HC_LATEST" >> "$GITHUB_OUTPUT"
  echo "ttyd_current=$TTYD_CUR" >> "$GITHUB_OUTPUT"
  echo "ttyd_latest=$TTYD_LATEST" >> "$GITHUB_OUTPUT"
  echo "moshi_current=$MOSHI_CUR" >> "$GITHUB_OUTPUT"
  echo "moshi_latest=$MOSHI_LATEST" >> "$GITHUB_OUTPUT"
fi
exit 0
