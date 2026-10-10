#!/usr/bin/env bash
# Check the latest actions/runner release. If runner/Dockerfile is built FROM
# an older ghcr.io/actions/actions-runner, rewrite its FROM line (tag + index
# digest) and bump the app's patch version (VERSION, umbrel-app.yml) so
# Umbrel offers the update. Does not commit; the Action opens a PR. Merging
# it makes build-github-runner.yml rebuild ghcr.io/zot24/github-runner-image
# on the new base and pin it as RUNNER_IMAGE.
#
# Why weekly: a runner older than the latest release updates itself at the
# start of every job, a ~150 MB download per job.
#
# Usage (from repo root; needs curl, docker buildx, python3):
#   bash zot24-github-runner/ci/update-runner.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/zot24-github-runner"
DOCKERFILE="$APP/runner/Dockerfile"
MANIFEST="$APP/umbrel-app.yml"
VERSION_FILE="$APP/VERSION"
IMG=ghcr.io/actions/actions-runner

out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

CUR="$(grep -oE "^FROM ${IMG}:[0-9.]+@" "$DOCKERFILE" | sed -E 's/.*:([0-9.]+)@$/\1/')"
auth=()
if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
LATEST="$(curl -fsSL ${auth[@]+"${auth[@]}"} -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"

if ! [[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$LATEST" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected versions: pinned '$CUR', latest '$LATEST'" >&2
  exit 1
fi

echo "Runner pinned: $CUR  latest: $LATEST"
out runner_current "$CUR"
out runner_latest "$LATEST"

# Never downgrade.
if [ "$(printf '%s\n%s\n' "$CUR" "$LATEST" | sort -V | tail -1)" = "$CUR" ]; then
  echo "Up to date."
  out changed 0
  exit 0
fi

# The image is published a little after the release. Not there yet: try
# again next week (or re-run by hand).
if ! DIGEST="$(docker buildx imagetools inspect "${IMG}:${LATEST}" --format '{{ .Manifest.Digest }}' 2>/dev/null)" || [ -z "$DIGEST" ]; then
  echo "${IMG}:${LATEST} is not published yet."
  out changed 0
  exit 0
fi

APP_CUR="$(tr -d ' \n' < "$VERSION_FILE")"
IFS=. read -r MAJ MIN PAT <<<"$APP_CUR"
APP_NEW="$MAJ.$MIN.$((PAT + 1))"

sed -i.bak -E "s|^FROM ${IMG}:[^ ]+|FROM ${IMG}:${LATEST}@${DIGEST}|" "$DOCKERFILE"
rm -f "$DOCKERFILE.bak"
printf '%s\n' "$APP_NEW" > "$VERSION_FILE"
sed -i.bak -E "s|^version: \"[^\"]+\"|version: \"$APP_NEW\"|" "$MANIFEST"
# releaseNotes is a folded block: replace its body (the indented lines after
# the key, blank paragraph breaks included, up to the next top-level key)
# with one line about this bump.
python3 - "$MANIFEST" "$CUR" "$LATEST" <<'PY'
import re, sys
path, cur, latest = sys.argv[1:]
text = open(path).read()
notes = f"releaseNotes: >-\n  GitHub Actions runner {cur} -> {latest}. The next job runs on the new image.\n"
text = re.sub(r"^releaseNotes: >-\n(?:(?:  .*)?\n)+?(?=^\S)", notes, text, count=1, flags=re.M)
open(path, "w").write(text)
PY
rm -f "$MANIFEST.bak"

echo "Bumped app $APP_CUR -> $APP_NEW, runner ${IMG}:${LATEST}@${DIGEST}"
out app_version "$APP_NEW"
out changed 1
