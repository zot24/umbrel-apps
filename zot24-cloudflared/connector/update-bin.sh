#!/bin/sh
# Install a newer cloudflared onto the data volume when Cloudflare publishes one.
# Exit 0 after installing. Exit 10 when there is nothing to do or the check
# could not be finished. Never downgrades, and never starts the tunnel.
#
# The checksum is the SHA256 Cloudflare publishes in that release. The binary
# stays on the data volume, so it survives a container restart. --no-autoupdate
# stays on: cloudflared's own updater is not checked and a recreate would
# throw its copy away.
set -u

BIN="${CLOUDFLARED_BIN:-/cloudflared}"
DEST="${CLOUDFLARED_STATE_DIR:-/data/bin}"
API=https://api.github.com/repos/cloudflare/cloudflared/releases/latest

log() { echo "update-bin: $*" >&2; }
skip() { log "$1"; exit 10; }

case "$(uname -m)" in
  x86_64|amd64) asset=cloudflared-linux-amd64 ;;
  aarch64|arm64) asset=cloudflared-linux-arm64 ;;
  armv7l|armv6l) asset=cloudflared-linux-arm ;;
  *) skip "no binary for $(uname -m)" ;;
esac

version_of() {
  "$1" version 2>/dev/null | sed -n 's/.*version \([0-9][0-9.]*\).*/\1/p' | head -1
}

# 0 when $1 is a newer X.Y.Z than $2.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, A, "."); split(b, B, ".")
    for (i = 1; i <= 3; i++) {
      x = A[i] + 0; y = B[i] + 0
      if (x > y) exit 0
      if (x < y) exit 1
    }
    exit 1
  }'
}

rel="$(mktemp)"
tmp=""
trap 'rm -f "$rel" "$tmp"' EXIT
if ! curl -fsSL --max-time 30 -H "Accept: application/vnd.github+json" "$API" -o "$rel"; then
  skip "GitHub release check failed"
fi

tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$rel" | head -1)
sum=$(sed -n "s/.*${asset}: \([0-9a-fA-F]\{64\}\).*/\1/p" "$rel" | head -1)
url=$(awk -v name="$asset" '
  {
    if (index($0, "\"name\": \"" name "\"")) found = 1
    if (found && index($0, "browser_download_url")) {
      line = $0
      sub(/.*browser_download_url": "/, "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
  }
' "$rel")

case "$tag" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) skip "unexpected tag '$tag'" ;;
esac
case "$url" in
  "https://github.com/cloudflare/cloudflared/releases/download/${tag}/${asset}") ;;
  *) skip "unexpected download url" ;;
esac
echo "$sum" | grep -Eq '^[0-9a-fA-F]{64}$' || skip "no checksum for $asset"

cur=""
if [ -s "$DEST/VERSION" ]; then
  cur=$(tr -d ' \n' < "$DEST/VERSION")
fi
if [ -z "$cur" ] && [ -x "$BIN" ]; then
  cur=$(version_of "$BIN")
fi

# A recreated container may carry a newer binary than the saved one.
if [ -n "$cur" ] && [ -x "$BIN" ]; then
  image=$(version_of "$BIN")
  if [ -n "$image" ] && newer "$image" "$cur"; then
    log "image $image is newer than saved $cur"
    rm -f "$DEST/cloudflared" "$DEST/VERSION"
    cur=$image
  fi
fi

if [ -n "$cur" ] && ! newer "$tag" "$cur"; then
  skip "running $cur, latest $tag"
fi

tmp="$(mktemp)"
if ! curl -fsSL --max-time 180 -o "$tmp" "$url"; then
  skip "download failed"
fi
if ! echo "$sum  $tmp" | sha256sum -c - >/dev/null; then
  skip "checksum mismatch for $tag"
fi
mkdir -p "$DEST" || skip "could not create $DEST"
cp "$tmp" "$DEST/cloudflared.new" || skip "could not write $DEST/cloudflared.new"
chmod 0755 "$DEST/cloudflared.new" || skip "could not chmod the new binary"
mv "$DEST/cloudflared.new" "$DEST/cloudflared" || skip "could not install $DEST/cloudflared"
printf '%s\n' "$tag" > "$DEST/VERSION" || skip "could not record the version"
log "installed $tag"
exit 0
