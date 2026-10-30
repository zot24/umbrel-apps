#!/usr/bin/env bash
# If connector/Dockerfile is behind the latest cloudflare/cloudflared release,
# rewrite its FROM line (tag + multi-arch digest) and bump this app's patch
# version (VERSION, umbrel-app.yml). Does not commit and does not build.
# update-cloudflared.yml builds our images and commits the compose pins in
# the same commit as this bump, so Umbrel never sees a new version whose
# digest is still missing.
#
# Usage (from repo root; needs curl and python3):
#   bash zot24-cloudflared/ci/update-cloudflared.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/zot24-cloudflared"
DOCKERFILE="$APP/connector/Dockerfile"
MANIFEST="$APP/umbrel-app.yml"
VERSION_FILE="$APP/VERSION"
REPO=cloudflare/cloudflared

out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

CUR="$(grep -oE "^FROM ${REPO}:[0-9.]+" "$DOCKERFILE" | sed -E 's/.*:([0-9.]+)$/\1/')"
auth=()
if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
LATEST="$(curl -fsSL ${auth[@]+"${auth[@]}"} -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/cloudflare/cloudflared/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"

if ! [[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$LATEST" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected versions: pinned '$CUR', latest '$LATEST'" >&2
  exit 1
fi

echo "cloudflared pinned: $CUR  latest: $LATEST"
out cf_current "$CUR"
out cf_latest "$LATEST"

# Never downgrade.
if [ "$(printf '%s\n%s\n' "$CUR" "$LATEST" | sort -V | tail -1)" = "$CUR" ]; then
  echo "Up to date."
  out changed 0
  exit 0
fi

# The image can lag the GitHub release by a few minutes. Missing, or not yet
# a multi-arch index: leave the pin and try again next run.
hdr="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$hdr" "$body"' EXIT
token="$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
if ! curl -fsSL -D "$hdr" -o "$body" \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/${REPO}/manifests/${LATEST}"; then
  echo "${REPO}:${LATEST} is not published yet."
  out changed 0
  exit 0
fi

set +e
DIGEST="$(python3 - "$hdr" "$body" <<'PY'
import json, sys
header, body = sys.argv[1:]
digest = ""
for line in open(header):
    if line.lower().startswith("docker-content-digest:"):
        digest = line.split(":", 1)[1].strip()
doc = json.load(open(body))
platforms = {
    (m.get("platform", {}).get("os"), m.get("platform", {}).get("architecture"))
    for m in doc.get("manifests", [])
}
missing = {("linux", "amd64"), ("linux", "arm64")} - platforms
if missing or not digest.startswith("sha256:"):
    print(f"not-multiarch missing={sorted(missing)} digest={digest}", file=sys.stderr)
    sys.exit(2)
print(digest)
PY
)"
py_status=$?
set -e
if [ "$py_status" -eq 2 ]; then
  echo "${REPO}:${LATEST} has no linux/amd64 + linux/arm64 index yet."
  out changed 0
  exit 0
fi
if [ "$py_status" -ne 0 ] || [ -z "$DIGEST" ]; then
  echo "Could not read the manifest digest for ${REPO}:${LATEST}" >&2
  exit 1
fi

APP_CUR="$(tr -d ' \n' < "$VERSION_FILE")"
IFS=. read -r MAJ MIN PAT <<<"$APP_CUR"
APP_NEW="$MAJ.$MIN.$((PAT + 1))"

# [^ ]+ stops before " as cloudflared", so that stage name stays put.
sed -i.bak -E "s|^FROM ${REPO}:[^ ]+|FROM ${REPO}:${LATEST}@${DIGEST}|" "$DOCKERFILE"
rm -f "$DOCKERFILE.bak"
printf '%s\n' "$APP_NEW" > "$VERSION_FILE"
sed -i.bak -E "s|^version: \"[^\"]+\"|version: \"$APP_NEW\"|" "$MANIFEST"
python3 - "$MANIFEST" "$CUR" "$LATEST" <<'PY'
import re, sys
path, cur, latest = sys.argv[1:]
text = open(path).read()
notes = (
    "releaseNotes: >-\n"
    f"  cloudflared {cur} -> {latest}. Updating the app pulls the new connector.\n"
)
text = re.sub(r"^releaseNotes: >-\n(?:(?:  .*)?\n)+?(?=^\S)", notes, text, count=1, flags=re.M)
open(path, "w").write(text)
PY
rm -f "$MANIFEST.bak"

echo "Bumped app $APP_CUR -> $APP_NEW, ${REPO}:${LATEST}@${DIGEST}"
out app_version "$APP_NEW"
out changed 1
