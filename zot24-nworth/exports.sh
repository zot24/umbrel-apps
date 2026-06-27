# nworth exports for other Umbrel apps
# Let dependent apps (e.g. a Cloudflare Tunnel ingress) point at the nworth web
# service without hard-coding the container hostname.

export APP_ZOT24_NWORTH_IP="zot24-nworth_web_1"
export APP_ZOT24_NWORTH_PORT="8080"
