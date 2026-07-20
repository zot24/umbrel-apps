# zot24's Umbrel Community App Store

Custom apps for [Umbrel](https://umbrel.com).

## Adding this App Store

On your Umbrel, go to **App Store** → **Community App Stores** → **Add** and enter:

```
https://github.com/zot24/umbrel-apps
```

## Available Apps

### nworth

Self-hosted personal net-worth & portfolio tracker.

- **App ID**: `zot24-nworth`
- **Port**: 8484

### Playwright Renderer

Self-hosted headless-browser renderer with residential-IP egress.

- **App ID**: `zot24-playwright-renderer`
- **Port**: 3030

## Retired Apps

- **zot24-hermes** (Hermes Agent) — removed 2026-07-20; superseded by the official
  [Hermes Agent app](https://github.com/getumbrel/umbrel-apps) in Umbrel's official store.
- **zot24-openclaw** (OpenClaw) — removed; its `openclaw-docker` image is no longer available.

## Architecture

This repository uses a **separate gallery repository** for icons and screenshots:
- [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery)

### Why a Separate Gallery Repo?

Umbrel community app stores have a limitation: icons and gallery images placed in the app folder don't display correctly. Umbrel tries to fetch them from the official gallery endpoint instead of the local store.

**The workaround**: Host assets in a separate repository and use full URLs in `umbrel-app.yml`:

```yaml
icon: https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-nworth/icon.png
gallery:
  - https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-nworth/1.jpg
```

This is documented in [Umbrel issue #1998](https://github.com/getumbrel/umbrel/issues/1998).

## Related Repositories

| Repository | Purpose |
|------------|---------|
| [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps) | This repo - app definitions |
| [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery) | Icons and gallery images |
