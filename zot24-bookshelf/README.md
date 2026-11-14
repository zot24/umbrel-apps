# Bookshelf for Umbrel

Your Calibre library as a real bookshelf. Source and app docs: [zot24/bookshelf](https://github.com/zot24/bookshelf).

- **App ID**: `zot24-bookshelf`
- **UI port**: 8697, behind the Umbrel login
- **Image**: `ghcr.io/zot24/bookshelf`, built in zot24/bookshelf for amd64 and arm64

## Calibre

Bookshelf reads the Calibre content server's JSON API and never writes to it. Calibre-Web (the "Calibre" app in Umbrel's official store) has a different API and does not work as the backend.

## Configure

Create `~/umbrel/app-data/zot24-bookshelf/data/.env` and restart the app:

```sh
CALIBRE_URL=http://<calibre host>:<port>
CALIBRE_USERNAME=...           # only if the content server requires a login
CALIBRE_PASSWORD=...
CALIBRE_PUBLIC_URL=http://umbrel.local:<calibre port>   # optional, for Read on EPUBs
```

Without `CALIBRE_URL` the app opens and tells you to set it. Spine colors are cached in `data/palettes.json`.

## Install

1. Publish the image by pushing a `v0.1.0` tag in zot24/bookshelf, then pin its digest in `docker-compose.yml`.
2. The package is private by default. Either make it public or `docker login ghcr.io` on the Umbrel with a `read:packages` token.
