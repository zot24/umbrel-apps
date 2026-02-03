# OpenClaw for Umbrel

AI assistant that connects Claude/LLMs to messaging platforms.

## Configuration

Currently, API keys must be set via SSH:

```bash
ssh umbrel@umbrel.local
nano ~/umbrel/app-data/zot24-openclaw/exports.sh
```

Set your environment variables:
- `ANTHROPIC_API_KEY` - Required for Claude models
- `TELEGRAM_BOT_TOKEN` - For Telegram integration
- `OPENAI_API_KEY` - Optional, for embeddings

Then restart the app from Umbrel UI.

## TODO

- [ ] Add settings page in WebChat UI for configuring API keys (Umbrel doesn't support native app settings forms yet - see [Issue #1949](https://github.com/getumbrel/umbrel/issues/1949))
