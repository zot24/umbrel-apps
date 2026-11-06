#!/usr/bin/env bash
# Compare pinned Umami tag + Node 22 alpine base to upstream.
# Prints GitHub Actions outputs. Does not commit.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
current_umami="$(tr -d '[:space:]' < "$APP/UMAMI_VERSION")"
current_node="$(tr -d '[:space:]' < "$APP/NODE_IMAGE_VERSION")"

latest_umami="$(gh release view -R umami-software/umami --json tagName --jq .tagName)"
if [ -z "$latest_umami" ]; then
  echo "::error::Could not read the latest umami-software/umami release"
  exit 1
fi

upstream_df="$(curl -fsSL "https://raw.githubusercontent.com/umami-software/umami/${latest_umami}/Dockerfile")"
upstream_node="$(printf '%s\n' "$upstream_df" | sed -nE 's/^ARG NODE_IMAGE_VERSION="([^"]+)".*/\1/p' | head -1)"

latest_node="$(
  curl -fsSL "https://hub.docker.com/v2/repositories/library/node/tags?page_size=100&name=22." \
    | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
pat = re.compile(r"^22\.\d+\.\d+-alpine$")
vers = []
for item in data.get("results") or []:
    name = item.get("name") or ""
    if pat.match(name):
        vers.append(name)
def key(name):
    n, _ = name.rsplit("-", 1)
    return tuple(int(p) for p in n.split("."))
vers = sorted(set(vers), key=key)
print(vers[-1] if vers else "")
'
)"

newer_node="$current_node"
for cand in "$upstream_node" "$latest_node"; do
  if [ -n "$cand" ]; then
    newer_node="$(
      python3 -c '
import sys
a, b = sys.argv[1], sys.argv[2]
def key(name):
    n = name.split("-", 1)[0]
    return tuple(int(p) for p in n.split("."))
print(a if key(a) >= key(b) else b)
' "$newer_node" "$cand"
    )"
  fi
done

changed=0
if [ "$latest_umami" != "$current_umami" ]; then
  printf '%s\n' "$upstream_df" | python3 -c '
import sys
from pathlib import Path
body = sys.stdin.read()
header = """# zot24 pin of umami-software/umami. We do not fork that repo.
# Source tag is zot24-umami/UMAMI_VERSION. CI clones that tag and builds
# this file against it, passing NODE_IMAGE_VERSION from NODE_IMAGE_VERSION.
# Refresh this file from upstream when UMAMI_VERSION moves.
# Tracked from: https://github.com/umami-software/umami/blob/%s/Dockerfile

""" % sys.argv[1]
Path(sys.argv[2]).write_text(header + body)
' "$latest_umami" "$APP/Dockerfile"
  printf '%s\n' "$latest_umami" > "$APP/UMAMI_VERSION"
  changed=1
fi

if [ "$newer_node" != "$current_node" ]; then
  printf '%s\n' "$newer_node" > "$APP/NODE_IMAGE_VERSION"
  python3 -c '
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
text2, n = re.subn(r"^ARG NODE_IMAGE_VERSION=\".*\"$", f"ARG NODE_IMAGE_VERSION=\"{sys.argv[2]}\"", text, count=1, flags=re.M)
if n != 1:
    raise SystemExit("Could not update ARG NODE_IMAGE_VERSION in Dockerfile")
p.write_text(text2)
' "$APP/Dockerfile" "$newer_node"
  changed=1
fi

app_version="${latest_umami#v}"
python3 -c '
import pathlib, re, sys
ver = sys.argv[1]
p = pathlib.Path(sys.argv[2])
text = p.read_text()
text, n = re.subn(r"(?m)^version:.*$", f"version: \"{ver}\"", text, count=1)
if n != 1:
    raise SystemExit("Could not update umbrel-app.yml version")
p.write_text(text)
pathlib.Path(sys.argv[3]).write_text(ver + "\n")
' "$app_version" "$APP/umbrel-app.yml" "$APP/VERSION"

{
  echo "changed=$changed"
  echo "umami_current=$current_umami"
  echo "umami_latest=$latest_umami"
  echo "node_current=$current_node"
  echo "node_latest=$newer_node"
  echo "app_version=$app_version"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"

echo "Umami $current_umami -> $latest_umami"
echo "Node $current_node -> $newer_node"
echo "changed=$changed"
