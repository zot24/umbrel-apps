# Bookshelf for Umbrel

Your Calibre library as a real bookshelf. Source and app docs: [zot24/bookshelf](https://github.com/zot24/bookshelf).

- **App ID**: `zot24-bookshelf`
- **UI port**: 8697, behind the Umbrel login
- **Image**: `ghcr.io/zot24/bookshelf`, built in zot24/bookshelf for amd64 and arm64

## Calibre

Bookshelf mounts the library of Umbrel's Calibre-Web app read-only:

```yaml
- ${UMBREL_ROOT}/app-data/calibre-web/data/books:/library:ro
```

That is Calibre-Web's `${APP_DATA_DIR}/data/books:/books` volume in [getumbrel/umbrel-apps `calibre-web/docker-compose.yml`](https://github.com/getumbrel/umbrel-apps/blob/f4c4f96a2498035f5778d29cba0a2a83be8c531b/calibre-web/docker-compose.yml). Its starter `metadata.db` lives there. The `${UMBREL_ROOT}/app-data/<app>/...:ro` mount is the same pattern `albyhub` and `mempool` use to read `lightning`'s data. `dependencies: [calibre-web]` makes Umbrel install Calibre-Web first.

Bookshelf opens `metadata.db` read-only and immutable and never writes to the library. If Calibre-Web's library lives in a subfolder of `/books`, Bookshelf finds `metadata.db` one level down.

To use a Calibre content server instead, create `~/umbrel/app-data/zot24-bookshelf/data/.env`:

```sh
CALIBRE_URL=http://<calibre host>:<port>
CALIBRE_USERNAME=...           # only if the content server requires a login
CALIBRE_PASSWORD=...
CALIBRE_PUBLIC_URL=http://umbrel.local:<calibre port>   # optional, for Read on EPUBs
```

It is used only when the mounted library has no `metadata.db`. Spine colors are cached in `data/palettes.json`.

## Install

1. Publish the image by pushing a `v0.1.0` tag in zot24/bookshelf, then pin its digest in `docker-compose.yml`.
2. The package is private by default. Either make it public or `docker login ghcr.io` on the Umbrel with a `read:packages` token.
