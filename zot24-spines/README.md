# Spines for Umbrel

One library for music and books. Source and app docs: [zot24/spines](https://github.com/zot24/spines).

- App id: `zot24-spines`
- UI port: 8787, behind the Umbrel login
- Image: `ghcr.io/zot24/spines:0.1.1@sha256:91783f8fea7ee94fc4b77ef1639588d5aca907c2b8b45100a8c3729286381a89`. The manifest is linux/amd64. The package is private, so the Umbrel host needs a `docker login ghcr.io` that can read it.

## Books

Spines mounts the Calibre-Web library read-only:

```yaml
- ${UMBREL_ROOT}/app-data/calibre-web/data/books:/books:ro
```

Calibre-Web is a dependency, so Umbrel installs it first. Spines opens `metadata.db` read-only. It does not read the book in the browser and it does not download the file.

## Music

The package mounts `${UMBREL_ROOT}/data/storage/downloads` read-only at `/media`. That is the Downloads folder in the Files app. The first-open screen starts at `/media/music`, which is `Downloads/music`, the same folder the official Navidrome app uses. Another folder under Downloads can be chosen there, or later from Library. The choice is stored in this app's data folder.

## Data

The catalog, generated spines, and cover cache live in this app's data folder. Reinstalling the container with that folder intact does not rescan the libraries.
