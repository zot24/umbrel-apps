#!/usr/bin/env bash
# Hermes Agent — Export Helper
# Creates a backup compatible with both `hermes profile import` and Umbrel Import.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zot24/umbrel-apps/main/zot24-hermes/hermes-export.sh | bash
#

set -euo pipefail

# Optimized export — excludes caches, logs, binaries, checkpoints SQLite WAL
HERMES_DIR="${1:-${HERMES_HOME:-$HOME/.hermes}}"
BACKUP_FILE="default.tar.gz"

if [ ! -d "$HERMES_DIR" ]; then
  echo "ERROR: Hermes directory not found at $HERMES_DIR" >&2
  echo "" >&2
  echo "Set HERMES_HOME or pass the path as an argument:" >&2
  echo "  HERMES_HOME=/path/to/.hermes bash hermes-export.sh" >&2
  echo "  bash hermes-export.sh /path/to/.hermes" >&2
  exit 1
fi

echo "=== Hermes Export ==="
echo "Source: $HERMES_DIR"
echo ""

# Checkpoint SQLite WAL before backup (if sqlite3 is available)
STATE_DB="$HERMES_DIR/state.db"
if [ -f "$STATE_DB" ] && command -v sqlite3 &>/dev/null; then
  echo "Checkpointing SQLite database..."
  sqlite3 "$STATE_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
fi

# Create symlink so archive uses "default/" as top-level (hermes profile format)
NEEDS_LINK=false
if [ "$(basename "$HERMES_DIR")" != "default" ]; then
  NEEDS_LINK=true
  STAGING_DIR="$(mktemp -d)"
  LINK_DIR="$STAGING_DIR/default"
  ln -sfn "$HERMES_DIR" "$LINK_DIR"
  TAR_CONTEXT="$STAGING_DIR"
else
  TAR_CONTEXT="$(dirname "$HERMES_DIR")"
fi

echo "Creating archive..."
tar czfh "$BACKUP_FILE" \
  -C "$TAR_CONTEXT" \
  --exclude='*/hermes-agent' \
  --exclude='*/checkpoints' \
  --exclude='*/bin' \
  --exclude='*/logs' \
  --exclude='*/image_cache' \
  --exclude='*/audio_cache' \
  --exclude='*/document_cache' \
  --exclude='*/browser_screenshots' \
  --exclude='*/pastes' \
  --exclude='*/node_modules' \
  --exclude='*/gateway_state.json' \
  --exclude='*/*-shm' \
  --exclude='*/*-wal' \
  default || {
  [ "$NEEDS_LINK" = true ] && rm -rf "$STAGING_DIR"
  rm -f "$BACKUP_FILE"
  echo "ERROR: Failed to create backup archive." >&2
  exit 1
}

[ "$NEEDS_LINK" = true ] && rm -rf "$STAGING_DIR"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo "Backup created: $BACKUP_FILE ($SIZE)"
echo ""
echo "Compatible with:"
echo "  hermes profile import $BACKUP_FILE"
echo "  Umbrel Hermes app → Import Backup"
echo ""
echo "Note: The Umbrel import also accepts native 'hermes profile export' files."
