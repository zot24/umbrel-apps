# Spines for Umbrel

One library for music and books. Source and app docs: [zot24/spines](https://github.com/zot24/spines).

- App id: `zot24-spines`
- UI port: 8787, behind the Umbrel login
- Image: `ghcr.io/zot24/spines:0.1.0`. This package does not publish it. Umbrel rejects an unpinned image, so the app will not install until a later commit pins a digest.

## Books

Spines mounts the Calibre-Web library read-only:

```yaml
- ${UMBREL_ROOT}/app-data/calibre-web/data/books:/books:ro
```

Calibre-Web is a dependency, so Umbrel installs it first. Spines opens `metadata.db` read-only. It does not read the book in the browser and it does not download the file.

## Music

The music folder on this Umbrel is not known. The package does not guess a path. Where do the albums live? A follow-up can add a read-only volume and `SPINES_MUSIC=/music`.

## Data

The catalog, generated spines, and cover cache live in this app's data folder. Reinstalling the container with that folder intact does not rescan the libraries.
