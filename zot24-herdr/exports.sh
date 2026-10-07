# Herdr exports for other Umbrel apps
# Lets sibling apps reference the container hostname/port without hard-coding.

export APP_ZOT24_HERDR_IP="zot24-herdr_server_1"
# Web terminal: web-gate on 7681 (app_proxy). ttyd is localhost :7684.
export APP_ZOT24_HERDR_PORT="7681"
# Internal agent-bridge HTTP API. NOT on app_proxy. Auth: HERDR_AGENT_TOKEN.
export APP_ZOT24_HERDR_AGENT_PORT="7682"
# In-container sshd (key-only). Published on the Umbrel host by
# docker-compose.yml. 7683, not 7682 — 7682 is the agent-bridge above.
export APP_ZOT24_HERDR_SSH_PORT="7683"

# Playwright Renderer bearer token, if that app is installed, so agents here
# can call /render (compose passes it on as PLAYWRIGHT_RENDERER_TOKEN). Umbrel
# only sources the exports of an app's declared dependencies, and Herdr does
# not depend on the renderer, so read the token file the renderer writes on
# first boot instead. EXPORTS_APP_DIR is this app's folder under app-data/.
RENDERER_ENV_FILE="${EXPORTS_APP_DIR%/*}/zot24-playwright-renderer/data/.env"
if [ -r "$RENDERER_ENV_FILE" ]; then
  APP_ZOT24_HERDR_RENDERER_TOKEN="$(sed -n 's/^RENDERER_TOKEN=//p' "$RENDERER_ENV_FILE" | head -n1 | tr -d '\r\n')"
  export APP_ZOT24_HERDR_RENDERER_TOKEN
fi
