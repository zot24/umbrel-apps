# Herdr exports for other Umbrel apps
# Lets sibling apps reference the container hostname/port without hard-coding.

export APP_ZOT24_HERDR_IP="zot24-herdr_server_1"
# Web terminal (ttyd → herdr TUI). Fronted by Umbrel app_proxy auth.
export APP_ZOT24_HERDR_PORT="7681"
# Internal agent-bridge HTTP API. NOT on app_proxy. Auth: HERDR_AGENT_TOKEN.
export APP_ZOT24_HERDR_AGENT_PORT="7682"
