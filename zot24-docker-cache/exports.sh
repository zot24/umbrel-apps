# Clients on the LAN or Tailscale use the published host port, not the tile.
# The tile is behind the Umbrel login, so Docker cannot talk to it.
# From a Mac or a runner: http://<umbrel-host>:25750
# From a sibling container on the Umbrel network: http://docker-cache:5000
export APP_ZOT24_DOCKER_CACHE_IP="docker-cache"
export APP_ZOT24_DOCKER_CACHE_PORT="5000"
export APP_ZOT24_DOCKER_CACHE_HOST_PORT="25750"
