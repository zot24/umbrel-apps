# Apprise API exports for sibling Umbrel apps (Gitea Mirror, Gitea, scripts).
# The notify API is NOT on a host port. Reach it on the Umbrel app network only.

export APP_ZOT24_APPRISE_IP="apprise"
export APP_ZOT24_APPRISE_PORT="8000"

# ntfy-compatible ingest -> Apprise. Not published on the host.
export APP_ZOT24_APPRISE_NTFY_IP="apprise-ntfy"
export APP_ZOT24_APPRISE_NTFY_PORT="8080"
