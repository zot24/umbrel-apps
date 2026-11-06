# Umami (zot24-umami)

Privacy-friendly web analytics, packaged for IRL's Umbrel.

We rebuild upstream Umami at the tag in `UMAMI_VERSION` on the Node
base in `NODE_IMAGE_VERSION`. That lets us bump Node without waiting
on Umami's published image, and bump Umami without forking
umami-software/umami. Today both pins match upstream v3.4.1
(`node:22.23.4-alpine`).

- App id: `zot24-umami`
- Tile port: 25728 (official Umbrel Umami is `umami` on 25727)
- Image: `ghcr.io/zot24/umami`, built by `.github/workflows/build-umami.yml`
- Watch: `.github/workflows/update-umami.yml` opens a bump PR when
  upstream publishes a new release or a newer Node 22.x.y-alpine exists
- Default Umami login: `admin` / `umami` (change it after install)
- Sibling apps and Cloudflare Tunnel should use `http://zot24-umami:3000`
