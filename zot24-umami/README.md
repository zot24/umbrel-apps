# Umami (zot24-umami)

Privacy-friendly web analytics, packaged for IRL's Umbrel.

This is a pin of the official Umami and Postgres images so version
bumps go through zot24/umbrel-apps. It uses a different id and port
from the official Umbrel Umami app (`umami`, port 25727), so both
can be installed.

- App id: `zot24-umami`
- Tile port: 25728
- Images: `ghcr.io/umami-software/umami:3.4.1` and `postgres:15-alpine`, both digest-pinned
- Default Umami login: `admin` / `umami` (change it after install)
- Sibling apps and Cloudflare Tunnel should use `http://zot24-umami:3000`
