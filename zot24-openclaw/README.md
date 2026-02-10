# OpenClaw for Umbrel

AI assistant that connects Claude/LLMs to messaging platforms.

## Setup

When you first open the app, a setup wizard will guide you through configuration:

1. **Choose your AI provider** - Anthropic (Claude), OpenAI, OpenRouter, or local Ollama
2. **Enter your API key** and select a model
3. **Optionally** add Telegram or Discord bot tokens for messaging integration
4. Click **Start OpenClaw** and wait for the app to initialize

To reconfigure later, visit `/setup` in the app URL.

## Environment Variables

The wizard writes these to `openclaw.env` in the app data directory:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` - Provider API key
- `OPENCLAW_MODEL` - Selected model
- `TELEGRAM_BOT_TOKEN` - For Telegram integration (optional)
- `DISCORD_BOT_TOKEN` - For Discord integration (optional)
- `OPENAI_API_KEY` - For embeddings/memory if not using OpenAI as primary (optional)
