# Clients on the LAN or Tailscale use the published host port, not the tile.
# The tile is the Verdaccio UI on port 25753. The Umbrel login on it is off.
# From a Mac or a runner: http://<umbrel-host>:25751
# From a sibling container on the Umbrel network: http://npm-cache:4873
export APP_ZOT24_NPM_CACHE_IP="npm-cache"
export APP_ZOT24_NPM_CACHE_PORT="4873"
export APP_ZOT24_NPM_CACHE_HOST_PORT="25751"
