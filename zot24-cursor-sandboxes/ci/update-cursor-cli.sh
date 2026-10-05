#!/usr/bin/env bash
# Check which Cursor CLI build https://cursor.com/install currently ships. If
# the sandbox image pins an older one, rewrite the pin and bump the app's
# patch version (VERSION, umbrel-app.yml) so Umbrel offers the update and
# the build workflow tags a new image. Does not commit; the Action opens a PR.
#
# Usage (from repo root):
#   bash zot24-cursor-sandboxes/ci/update-cursor-cli.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/zot24-cursor-sandboxes"
DF="$APP/sandbox/Dockerfile"
MANIFEST="$APP/umbrel-app.yml"
VERSION_FILE="$APP/VERSION"

out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

CUR="$(grep -E '^ARG CURSOR_AGENT_VERSION=' "$DF" | cut -d= -f2-)"
LATEST="$(curl -fsSL -H 'User-Agent: zot24-cursor-sandboxes-update' https://cursor.com/install \
  | grep -oE 'downloads\.cursor\.com/lab/[^/]+/' | head -1 | cut -d/ -f3)"

if [ -z "$LATEST" ]; then
  echo "Could not find a CLI version in https://cursor.com/install" >&2
  exit 1
fi
# Builds look like 2026.10.01-e373342; refuse anything else rather than
# writing junk into the Dockerfile.
if ! [[ "$LATEST" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]+$ ]]; then
  echo "Unexpected CLI version format: $LATEST" >&2
  exit 1
fi

echo "Cursor CLI pinned: $CUR  latest: $LATEST"
out cli_current "$CUR"
out cli_latest "$LATEST"

# Newer means a later date prefix; a same-day rebuild (different hash) also
# counts. Never downgrade.
if [ "$LATEST" = "$CUR" ] || [[ "${LATEST%%-*}" < "${CUR%%-*}" ]]; then
  echo "Up to date."
  out changed 0
  exit 0
fi

APP_CUR="$(tr -d ' \n' < "$VERSION_FILE")"
IFS=. read -r MAJ MIN PAT <<<"$APP_CUR"
APP_NEW="$MAJ.$MIN.$((PAT + 1))"

sed -i.bak "s|^ARG CURSOR_AGENT_VERSION=.*|ARG CURSOR_AGENT_VERSION=$LATEST|" "$DF"
printf '%s\n' "$APP_NEW" > "$VERSION_FILE"
sed -i.bak -E "s|^version: \"[^\"]+\"|version: \"$APP_NEW\"|" "$MANIFEST"
# releaseNotes is a folded block: replace its body (the indented lines after
# the key) with one line about this bump.
python3 - "$MANIFEST" "$CUR" "$LATEST" <<'PY'
import re, sys
path, cur, latest = sys.argv[1:]
text = open(path).read()
notes = f"releaseNotes: >-\n  Cursor CLI {cur} -> {latest}. Sandboxes restart on the new build.\n"
text = re.sub(r"^releaseNotes: >-\n(?:  .*\n)+", notes, text, count=1, flags=re.M)
open(path, "w").write(text)
PY
rm -f "$DF.bak" "$MANIFEST.bak"

echo "Bumped app $APP_CUR -> $APP_NEW"
out app_version "$APP_NEW"
out changed 1
