# Metrics port inside the connector container. The web UI reads the same value.
# Named with the zot24 prefix so it does not clash with the official
# cloudflared app's APP_CLOUDFLARED_METRICS_PORT when both are installed.
export APP_ZOT24_CLOUDFLARED_METRICS_PORT="40901"
