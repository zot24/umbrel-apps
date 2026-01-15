# zot24's Umbrel Community App Store

Custom apps for [Umbrel](https://umbrel.com).

## Adding this App Store

On your Umbrel, go to **App Store** → **Community App Stores** → **Add** and enter:

```
https://github.com/zot24/umbrel-apps
```

## Available Apps

### Clawdbot

Self-hosted AI assistant with Telegram integration. Connect Claude to your messaging platforms.

- **App ID**: `zot24-clawdbot`
- **Ports**: 18789 (Gateway), 18790 (WebChat UI)
- **Docker Image**: [ghcr.io/zot24/clawdbot-docker](https://github.com/zot24/clawdbot-docker)

## Architecture

This repository uses a **separate gallery repository** for icons and screenshots:
- [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery)

### Why a Separate Gallery Repo?

Umbrel community app stores have a limitation: icons and gallery images placed in the app folder don't display correctly. Umbrel tries to fetch them from the official gallery endpoint instead of the local store.

**The workaround**: Host assets in a separate repository and use full URLs in `umbrel-app.yml`:

```yaml
icon: https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-clawdbot/icon.png
gallery:
  - https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-clawdbot/1.jpg
  - https://raw.githubusercontent.com/zot24/umbrel-apps-gallery/main/zot24-clawdbot/2.jpg
```

This is documented in [Umbrel issue #1998](https://github.com/getumbrel/umbrel/issues/1998).

## Related Repositories

| Repository | Purpose |
|------------|---------|
| [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps) | This repo - app definitions |
| [zot24/umbrel-apps-gallery](https://github.com/zot24/umbrel-apps-gallery) | Icons and gallery images |
| [zot24/clawdbot-docker](https://github.com/zot24/clawdbot-docker) | Docker image builds |
