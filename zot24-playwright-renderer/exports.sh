# Playwright Renderer exports for other Umbrel apps
# These let dependent apps point a Cloudflare Tunnel ingress (or any sibling
# service) at the renderer without hard-coding the container hostname.

export APP_ZOT24_PLAYWRIGHT_RENDERER_IP="zot24-playwright-renderer_playwright_1"
export APP_ZOT24_PLAYWRIGHT_RENDERER_PORT="3030"
