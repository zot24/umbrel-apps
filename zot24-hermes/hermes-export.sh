#!/usr/bin/env bash
# Hermes Agent — Export Helper
# Creates a backup compatible with both `hermes profile import` and Umbrel Import.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zot24/umbrel-apps/main/zot24-hermes/hermes-export.sh | bash
#   # or
#   hermes profile export default

set -euo pipefail

# If hermes CLI is available, use native export
if command -v hermes &>/dev/null; then
  echo "Hermes CLI detected — using native profile export."
  echo ""
  hermes profile export default
  echo ""
  echo "To import into Umbrel Hermes:"
  echo "  1. Open the Hermes app in Umbrel"
  echo "  2. Click the floppy disk icon (bottom-right)"
  echo "  3. Click Import and select the exported file"
  exit 0
fi

# Fallback: manual export for systems without hermes CLI
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
LINK_DIR="$(dirname "$HERMES_DIR")/default"
NEEDS_LINK=false
if [ "$(basename "$HERMES_DIR")" != "default" ]; then
  NEEDS_LINK=true
  ln -sfn "$HERMES_DIR" "$LINK_DIR"
fi

echo "Creating archive..."
tar czfh "$BACKUP_FILE" \
  -C "$(dirname "$HERMES_DIR")" \
  --exclude='default/hermes-agent' \
  --exclude='default/checkpoints' \
  --exclude='default/bin' \
  --exclude='default/logs' \
  --exclude='default/image_cache' \
  --exclude='default/audio_cache' \
  --exclude='default/document_cache' \
  --exclude='default/browser_screenshots' \
  --exclude='default/pastes' \
  --exclude='default/node_modules' \
  --exclude='default/gateway_state.json' \
  --exclude='default/*-shm' \
  --exclude='default/*-wal' \
  default || {
  [ "$NEEDS_LINK" = true ] && rm -f "$LINK_DIR"
  rm -f "$BACKUP_FILE"
  echo "ERROR: Failed to create backup archive." >&2
  exit 1
}

[ "$NEEDS_LINK" = true ] && rm -f "$LINK_DIR"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo "Backup created: $BACKUP_FILE ($SIZE)"
echo ""
echo "Compatible with:"
echo "  hermes profile import $BACKUP_FILE"
echo "  Umbrel Hermes app → Import Backup"
