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
  echo "ERROR: Hermes directory not found at $HERMES_DIR"
  echo ""
  echo "Set HERMES_HOME or pass the path as an argument:"
  echo "  HERMES_HOME=/path/to/.hermes bash hermes-export.sh"
  echo "  bash hermes-export.sh /path/to/.hermes"
  exit 1
fi

echo "=== Hermes Export ==="
echo "Source: $HERMES_DIR"
echo ""

tar czf "$BACKUP_FILE" \
  -C "$(dirname "$HERMES_DIR")" \
  --exclude='*/logs' \
  --exclude='*/image_cache' \
  --exclude='*/audio_cache' \
  --exclude='*/document_cache' \
  --exclude='*/browser_screenshots' \
  --exclude='*/gateway_state.json' \
  "$(basename "$HERMES_DIR")"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo "Backup created: $BACKUP_FILE ($SIZE)"
echo ""
echo "To import into Umbrel Hermes:"
echo "  1. Open the Hermes app in Umbrel"
echo "  2. Go to the Backup panel on the status page"
echo "  3. Click Import and select this file"
echo ""
echo "Contents include: config, secrets, sessions, memories,"
echo "skills, cron jobs, scripts, and platform auth state."
echo ""
echo "Excluded: logs, image/audio/document caches, runtime state."
