#!/bin/bash
set -e

CONFIG_DIR="${CLAWDBOT_DATA_DIR:-/root/.clawdbot}"
CONFIG_FILE="${CONFIG_DIR}/clawdbot.json"
WORKSPACE="${CLAWDBOT_WORKSPACE:-/root/clawd}"

# Create directories if they don't exist
mkdir -p "${CONFIG_DIR}" "${WORKSPACE}" "${WORKSPACE}/memory" "${WORKSPACE}/skills"

# Generate configuration if it doesn't exist or if Telegram token is provided
if [ ! -f "${CONFIG_FILE}" ] || [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
    echo "Generating Clawdbot configuration..."

    # Build Telegram configuration
    TELEGRAM_CONFIG=""
    if [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
        TELEGRAM_CONFIG=$(cat <<EOF
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "pairing",
      "streamMode": "partial"
    }
EOF
)
    else
        TELEGRAM_CONFIG=$(cat <<EOF
    "telegram": {
      "enabled": false,
      "botToken": "",
      "dmPolicy": "pairing",
      "streamMode": "partial"
    }
EOF
)
    fi

    # Write configuration file
    cat > "${CONFIG_FILE}" <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "${CLAWDBOT_BIND:-0.0.0.0}",
    "port": ${CLAWDBOT_GATEWAY_PORT:-18789}
  },
  "webchat": {
    "enabled": true,
    "port": ${CLAWDBOT_WEBCHAT_PORT:-18790}
  },
  "channels": {
${TELEGRAM_CONFIG},
    "whatsapp": {
      "enabled": false
    },
    "discord": {
      "enabled": false
    },
    "slack": {
      "enabled": false
    },
    "signal": {
      "enabled": false
    }
  },
  "agents": {
    "defaults": {
      "workspace": "${WORKSPACE}",
      "timeoutSeconds": 600,
      "memorySearch": {
        "enabled": false
      }
    }
  },
  "skills": {
    "entries": {}
  }
}
EOF
    echo "Configuration generated at ${CONFIG_FILE}"
fi

# Check if Telegram is configured
if [ -n "${TELEGRAM_BOT_TOKEN}" ]; then
    echo "Telegram bot token configured - Telegram channel enabled"
else
    echo "WARNING: No TELEGRAM_BOT_TOKEN set. Telegram channel disabled."
    echo "To enable Telegram:"
    echo "  1. Create a bot via @BotFather on Telegram"
    echo "  2. Copy the bot token"
    echo "  3. Set TELEGRAM_BOT_TOKEN environment variable in Umbrel"
fi

# Check for Anthropic API key
if [ -z "${ANTHROPIC_API_KEY}" ]; then
    echo "WARNING: No ANTHROPIC_API_KEY set. Claude models will not work."
    echo "Set ANTHROPIC_API_KEY environment variable to use Claude."
fi

# Create default workspace files if they don't exist
if [ ! -f "${WORKSPACE}/SOUL.md" ]; then
    cat > "${WORKSPACE}/SOUL.md" <<EOF
# Soul

You are a helpful AI assistant running on Umbrel.
You are friendly, concise, and helpful.
EOF
fi

if [ ! -f "${WORKSPACE}/MEMORY.md" ]; then
    cat > "${WORKSPACE}/MEMORY.md" <<EOF
# Long-term Memory

This file stores durable facts and preferences.
EOF
fi

echo "Starting Clawdbot..."
echo "  Gateway port: ${CLAWDBOT_GATEWAY_PORT:-18789}"
echo "  WebChat port: ${CLAWDBOT_WEBCHAT_PORT:-18790}"

# Start the gateway
cd /app
exec node dist/index.js "$@"
