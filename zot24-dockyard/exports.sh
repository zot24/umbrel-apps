# Persist the Komodo Periphery passkey across app updates.
# Umbrel interpolates APP_SEED into compose on every start. If that value
# ever differs from what Komodo already stored (manual pin, older compose),
# Core gets "Invalid passkey". Keep the first key in APP_DATA_DIR/passkey.
PASSKEY_FILE="${APP_DATA_DIR}/passkey"
if [ ! -s "$PASSKEY_FILE" ]; then
  printf '%s' "${APP_SEED}" > "$PASSKEY_FILE"
  chmod 600 "$PASSKEY_FILE" 2>/dev/null || true
fi
APP_DOCKYARD_PASSKEY="$(tr -d '\n' < "$PASSKEY_FILE")"
export APP_DOCKYARD_PASSKEY
