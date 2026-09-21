# Persist the Komodo Periphery passkey across app updates.
# This file is sourced before APP_DATA_DIR and APP_SEED exist (set -u).
# EXPORTS_APP_DIR is the app folder. If passkey is already there, reuse it.
# Otherwise compose falls back to APP_SEED.
PASSKEY_FILE="${EXPORTS_APP_DIR}/passkey"
if [ -s "$PASSKEY_FILE" ]; then
  APP_DOCKYARD_PASSKEY="$(tr -d '\n' < "$PASSKEY_FILE")"
  export APP_DOCKYARD_PASSKEY
fi
