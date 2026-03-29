#!/usr/bin/env bash
# Hermes Agent — Export Script
# Creates a backup archive for importing into Umbrel Hermes.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zot24/umbrel-apps/main/zot24-hermes/hermes-export.sh | bash
#   # or
#   bash hermes-export.sh
#   bash hermes-export.sh /custom/path/to/.hermes

set -euo pipefail

HERMES_DIR="${1:-${HERMES_HOME:-$HOME/.hermes}}"
BACKUP_FILE="hermes-backup-$(date +%Y%m%d-%H%M%S).tar.gz"

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

echo "Creating archive..."
tar czf "$BACKUP_FILE" \
  -C "$(dirname "$HERMES_DIR")" \
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
  "$(basename "$HERMES_DIR")" || {
  rm -f "$BACKUP_FILE"
  echo "ERROR: Failed to create backup archive." >&2
  exit 1
}

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo "Backup created: $BACKUP_FILE ($SIZE)"
echo ""
echo "To import into Umbrel Hermes:"
echo "  1. Open the Hermes app in Umbrel"
echo "  2. Click the floppy disk icon (bottom-right)"
echo "  3. Click Import and select this file"
echo ""
echo "Contents: config, secrets, state.db, sessions, memories,"
echo "skills, cron jobs, scripts, and platform auth state."
echo ""
echo "Excluded: hermes-agent source, checkpoints, binaries, logs,"
echo "caches, node_modules, runtime state, SQLite WAL files."
