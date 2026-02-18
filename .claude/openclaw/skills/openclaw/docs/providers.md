<!-- Source: https://deepwiki.com/openclaw/moltbot/5.2-model-providers -->
<!-- Source: https://deepwiki.com/openclaw/openclaw/12.4-model-commands -->
<!-- Source: https://www.getopenclaw.ai/help/api-key-setup-all-providers -->
<!-- Source: https://open-claw.bot/docs/concepts/model-providers/ -->
<!-- Source: https://blog.laozhang.ai/en/posts/openclaw-custom-model -->
<!-- Source: https://openrouter.ai/docs/guides/guides/openclaw-integration -->
<!-- Source: https://github.com/openclaw/openclaw/blob/main/.env.example -->
<!-- Source: https://help.apiyi.com/en/openclaw-web-search-configuration-guide-en.html -->
<!-- Updated: 2026-02-17 -->

# OpenClaw Model Providers

Complete guide to configuring LLM providers in OpenClaw (formerly Clawdbot).

## Model Reference Format

OpenClaw uses the `provider/model-id` pattern for all model references. The system splits on the first forward slash to separate provider name from model identifier.

Examples: `anthropic/claude-opus-4-6`, `openai/gpt-5.1-codex`, `openrouter/anthropic/claude-sonnet-4.5`, `ollama/llama3.3`

---

## Provider Priority (Built-in)

When auto-selecting a primary model, OpenClaw uses this priority order:

Anthropic > OpenAI > OpenRouter > Gemini > OpenCode > GitHub Copilot > xAI > Groq > Mistral > Cerebras > Venice > Moonshot > Kimi > MiniMax > Synthetic > ZAI > AI Gateway > Xiaomi > Bedrock > Ollama

---

## API Types

| API Type | Description | Providers |
|----------|-------------|-----------|
| `anthropic-messages` | Anthropic Messages API | anthropic, minimax, chutes, synthetic |
| `openai-chat` | OpenAI Chat Completions | openai, azure-openai |
| `openai-responses` | OpenAI Responses API (Codex) | openai, openai-codex |
| `openai-completions` | OpenAI-compatible completions | moonshot, ollama, vllm, lm-studio, venice, groq, mistral, cerebras |
| `google-genai` | Google GenAI SDK | google, google-gemini-cli |
| `google-antigravity` | Google Vertex AI | google-antigravity |
| `aws-bedrock` | AWS Bedrock SDK | aws-bedrock-anthropic, aws-bedrock-nova |
| `github-copilot-api` | GitHub Copilot Chat | github-copilot |

---

## Provider Overview

| Provider | Models | Auth Method | Env Variable |
|----------|--------|-------------|--------------|
| Anthropic | Claude Opus 4.6, Sonnet 4, Opus 4.5 | API Key, OAuth, setup-token | `ANTHROPIC_API_KEY` |
| OpenAI | GPT-5.1-codex, GPT-4o, o1 | API Key, OAuth | `OPENAI_API_KEY` |
| Google | Gemini 2.0 Flash, Gemini Pro 1.5 | API Key, OAuth (Vertex) | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| OpenRouter | Multiple (aggregated) | API Key | `OPENROUTER_API_KEY` |
| Moonshot | Kimi K2.5 | API Key | `MOONSHOT_API_KEY` |
| MiniMax | MiniMax-M2.1 | API Key | `MINIMAX_API_KEY` |
| Z.AI (GLM) | GLM-5, GLM-4.7-flash | API Key | `ZAI_API_KEY` |
| Groq | Multiple (fast inference) | API Key | `GROQ_API_KEY` |
| Mistral | Mistral models | API Key | `MISTRAL_API_KEY` |
| Cerebras | Cerebras models | API Key | `CEREBRAS_API_KEY` |
| Venice | Venice models (OpenAI-compatible) | API Key | `VENICE_API_KEY` |
| xAI | Grok models | API Key | `XAI_API_KEY` |
| Synthetic | Synthetic models | API Key | `SYNTHETIC_API_KEY` |
| AI Gateway | Gateway models | API Key | `AI_GATEWAY_API_KEY` |
| Xiaomi | MiMo-V2-Flash | API Key | - |
| GitHub Copilot | Copilot Chat | GitHub Copilot auth | - |
| AWS Bedrock | Anthropic, Nova | AWS SDK credential chain | AWS env vars |
| Ollama | Local models (llama3.3, etc.) | None (auto-detected) | - |
| Qwen | Qwen Coder | OAuth device-code flow | - |

---

## Anthropic (Default / Recommended)

OpenClaw recommends Anthropic Pro/Max (100/200) + Opus 4.6 for long-context strength and better prompt-injection resistance.

### Authentication Methods

**API Key (recommended for production):**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

**OAuth (via Claude Pro/Max subscription):**
```bash
openclaw models auth setup-token --provider anthropic
# Paste token from: claude setup-token
```

**Non-interactive onboarding:**
```bash
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Auth Profiles

Configure multiple auth profiles for rate limit resilience:

```json5
{
  auth: {
    order: {
      anthropic: ["anthropic:subscription", "anthropic:api"]
    },
    profiles: {
      "anthropic:subscription": {
        provider: "anthropic",
        mode: "oauth",
        email: "me@example.com"
      },
      "anthropic:api": {
        provider: "anthropic",
        mode: "api_key"
      }
    }
  }
}
```

### OAuth Tool Restrictions

When using Anthropic OAuth (vs API key), tool names are restricted. OpenClaw remaps tool names on the wire:
- `exec` -> `bash`
- `apply_patch` -> `str_replace_editor`

### Available Models

| Model ID | Context | Max Output | Reasoning |
|----------|---------|------------|-----------|
| `claude-opus-4-6` | 1,000,000 | 128,000 | Yes |
| `claude-opus-4-5` | 200,000 | 32,000 | Yes |
| `claude-sonnet-4-5` | 200,000 | 16,000 | No |
| `claude-sonnet-4-20250514` | 200,000 | 16,000 | No |
| `claude-3-5-haiku-20241022` | 200,000 | 8,192 | No |

### Configuration

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["anthropic/claude-opus-4-5"]
      },
      contextTokens: 1000000
    }
  }
}
```

### Adding Opus 4.6 to Catalog (if not yet in built-in catalog)

```json5
{
  models: {
    mode: "merge",
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1000000,
            maxTokens: 128000
          }
        ]
      }
    }
  }
}
```

### Model Parameters

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          alias: "opus",
          temperature: 0.7,
          maxTokens: 128000,
          cacheControlTtl: 300
        }
      }
    }
  }
}
```

After changes, restart gateway and start a new session:
```bash
openclaw gateway restart
# Use /new or /reset in chat for new session
openclaw models status
```

---

## OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

OAuth via ChatGPT/Codex subscriptions also supported.

### Available Models

- `openai/gpt-5.1-codex` (Responses API)
- `openai/gpt-4o`
- `openai/gpt-4o-mini`
- `openai/gpt-4-turbo`
- `openai/gpt-4-vision` (image model)
- `openai/o1-preview`, `openai/o1-mini`

### Configuration

```json5
{
  models: {
    providers: {
      openai: {
        apiKey: "${OPENAI_API_KEY}",
        organization: "org-..."
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.1-codex"
      }
    }
  }
}
```

### OpenAI Codex (Responses API)

OpenAI Codex uses the Responses API with reasoning blocks. OpenClaw handles reasoning replay and tool-call flows differently, extracting reasoning content and flattening tool calls into single-turn responses.

---

## Google (Gemini)

```bash
export GEMINI_API_KEY="AIza..."
# or
export GOOGLE_API_KEY="AIza..."
```

Enable the Gemini API in Google Cloud Console for your project to resolve 403 errors.

### Configuration

```json5
{
  models: {
    providers: {
      google: {
        apiKey: "$GOOGLE_API_KEY"
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "google/gemini-2.0-flash"
      }
    }
  }
}
```

### Google Vertex AI (Antigravity)

Requires OAuth and plugin enablement:
```bash
openclaw plugins enable google-antigravity-auth
```

### Google-Specific Adaptations

Google's API rejects certain JSON schema features. OpenClaw strips unsupported constructs including root-level `anyOf`/`oneOf`/`allOf`, `additionalProperties` in tool schemas, and empty `required` arrays. Google also requires alternating user/assistant turns; OpenClaw merges consecutive user turns when needed.

---

## OpenRouter

Access multiple models through one API. OpenClaw has built-in support -- you do not need to configure `models.providers`, just set the API key.

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

### Quick Setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

### Model Format

Uses `openrouter/<author>/<slug>` pattern:

- `openrouter/anthropic/claude-sonnet-4.5`
- `openrouter/google/gemini-pro-1.5`
- `openrouter/openrouter/auto` (cost-optimized routing)
- `openrouter/meta-llama/llama-3.2-3b-instruct:free` (free models use `:free` suffix)

### Configuration

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "openrouter/anthropic/claude-sonnet-4.5",
        fallbacks: ["openrouter/openrouter/auto"]
      }
    }
  }
}
```

The auto router automatically selects the most cost-effective model based on your prompt. Monitor usage via the OpenRouter Activity Dashboard.

---

## Ollama (Local Models - Auto-Detected)

Ollama is auto-detected at `http://127.0.0.1:11434/v1`. No manual configuration needed.

```bash
ollama pull llama3.3
openclaw models list
```

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/llama3.3"
      }
    }
  }
}
```

Note: Some builds disable streaming for certain Ollama setups because of SDK and streaming format quirks.

---

## Custom / OpenAI-Compatible Providers (vLLM, LM Studio, etc.)

For any OpenAI-compatible endpoint, configure under `models.providers`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      providerName: {
        baseUrl: "https://api.endpoint/v1",
        apiKey: "${ENV_VAR}",
        api: "openai-completions",
        models: [
          {
            id: "model-id",
            name: "Display Name",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  }
}
```

`mode: "merge"` combines your custom providers with the built-in ones (recommended).

### Common Local Endpoints

| Runtime | Default Base URL |
|---------|-----------------|
| Ollama | `http://127.0.0.1:11434/v1` (auto-detected) |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| LiteLLM | Configurable |
| llama.cpp | Configurable |

Set cost fields to zero for local inference.

---

## Moonshot (Kimi)

OpenAI-compatible provider.

```bash
export MOONSHOT_API_KEY="..."
```

```json5
{
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }]
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "moonshot/kimi-k2.5"
      }
    }
  }
}
```

---

## MiniMax

Uses the `anthropic-messages` API type with tag enforcement.

```bash
export MINIMAX_API_KEY="..."
```

When `enforceFinalTag` is enabled, only content inside `<final>` blocks is returned, suppressing content outside to prevent reasoning leakage.

Available models: `minimax/MiniMax-M2.1`

---

## Z.AI (GLM)

```bash
export ZAI_API_KEY="..."
```

Requires subscription to the GLM Coding Plan at https://z.ai/model-api.

### Available Models

- `zai/glm-5` (primary)
- `zai/glm-4.7-flash` (fallback)

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "zai/glm-5",
        fallbacks: ["zai/glm-4.7-flash"]
      }
    }
  }
}
```

---

## Qwen (OAuth)

Uses device-code flow authentication with a bundled plugin. One of the rare free-tier options that is usable for real work.

Model references use `qwen-portal/coder-model` format.

---

## Other Built-in Providers

| Provider | Env Variable | Example Model | Notes |
|----------|-------------|---------------|-------|
| Groq | `GROQ_API_KEY` | `groq/llama-3.3-70b` | Fast inference, generous experimentation access |
| Mistral | `MISTRAL_API_KEY` | `mistral/mistral-large` | Built-in provider |
| xAI | `XAI_API_KEY` | `xai/grok-2` | Built-in provider |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras/...` | Built-in provider |
| Venice | `VENICE_API_KEY` | `venice/...` | OpenAI-compatible |
| Synthetic | `SYNTHETIC_API_KEY` | `synthetic/...` | Uses `anthropic-messages` at `api.synthetic.new/anthropic` |
| Cohere | - | - | Summarization/classification focus |
| DeepSeek | - | - | Low-cost hosted or local |
| GitHub Copilot | - | `github/...` | Uses `github-copilot-api` type |
| AWS Bedrock | AWS env vars | `bedrock/...` | AWS SDK credential chain (IAM roles, env, profiles), no explicit API key |
| Xiaomi | - | `xiaomi/mimo-v2-flash` | MiMo-V2-Flash |

---

## Brave Search Integration

OpenClaw supports Brave Search for web search capabilities.

```bash
export BRAVE_API_KEY="..."
```

### Configuration

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY",
        maxResults: 10,
        timeoutSeconds: 5,
        cacheTtlMinutes: 15,
        // Optional locale settings
        country: "US",
        search_lang: "en",
        ui_lang: "en"
      }
    }
  }
}
```

Get API key at https://brave.com/search/api/ -- choose the "Data for Search" plan (not "Data for AI"). Free tier: 2,000 monthly requests.

### Multi-Engine Fallback

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "YOUR_BRAVE_API_KEY",
        fallback: {
          provider: "duckduckgo"
        }
      }
    }
  }
}
```

### Alternative Search Providers

- **Tavily MCP** -- AI-optimized search (1,000 free monthly searches), integrates via MCP
- **DuckDuckGo** -- No API key needed (fallback option)
- **Perplexity** -- `PERPLEXITY_API_KEY=pplx-...`
- **Built-in WebSearch** -- Available for Claude-based models, zero configuration
- **OneSearch MCP** -- Unified search supporting Tavily, DuckDuckGo, Bing, SearXNG

---

## Provider Failover

OpenClaw supports automatic failover with auth profile rotation and model fallbacks.

### Fallback Chain Configuration

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["moonshot/kimi-k2.5", "openai/gpt-5.1-codex", "ollama/llama3.3"]
      }
    }
  }
}
```

When the primary provider hits rate limits, requests automatically cascade through fallbacks.

### Failover Reasons

| Reason | Trigger | Behavior |
|--------|---------|----------|
| `auth` | 401, invalid key | Try next auth profile, then next fallback |
| `billing` | 402, billing error | Try next profile, cooldown, then fallback |
| `rate_limit` | 429, quota exceeded | Try next profile (with cooldown), then fallback |
| `context_overflow` | Context too large | Compact session, retry, then fallback |
| `timeout` | Network timeout | Retry with backoff, then fallback |
| `image_size` | Image too large | Downscale image, retry, then fallback |

### Auth Profile Rotation

When a model fails due to rate limits or billing:
1. Try primary auth profile
2. Mark failed (cooldown period)
3. Try next profile in `auth.order[provider]`
4. If all profiles exhausted, try fallback model

```bash
openclaw models auth order get
openclaw models auth order set anthropic:work,anthropic:default
openclaw models auth order clear
```

### Per-Agent Model Overrides

```json5
{
  agents: {
    list: [{
      id: "work",
      model: { primary: "anthropic/claude-opus-4-5" },
      imageModel: { primary: "openai/gpt-4-vision" },
      fallbacks: ["openai/gpt-4-turbo"]
    }]
  }
}
```

Empty `fallbacks` array disables the global chain for that agent.

---

## Authentication

### Auth Modes

| Mode | Description | Example |
|------|-------------|---------|
| `api-key` | Static API key | `ANTHROPIC_API_KEY=sk-ant-...` |
| `oauth` | OAuth2 with refresh | Anthropic setup-token, Google Vertex |
| `token` | Long-lived token | Manually pasted credentials |
| `aws-sdk` | AWS credential chain | Bedrock models |

### OAuth Providers

- `anthropic`: Anthropic Console OAuth (supports tool-name restrictions)
- `google-gemini-cli`: Google Cloud OAuth (requires project ID)
- `google-antigravity`: Google Vertex AI OAuth
- `chutes`: Chutes platform OAuth (Anthropic-compatible)

### Auth Resolution Order (highest to lowest)

1. Explicit profile ID (if specified)
2. `auth.order.<provider>` rotation order
3. Environment variables (`ANTHROPIC_API_KEY`, etc.)
4. Config file stored profiles
5. Provider-specific fallbacks (AWS SDK chain)

### Auth Commands

```bash
openclaw models auth add                           # Interactive auth setup
openclaw models auth setup-token --provider anthropic  # Setup token auth
openclaw models auth paste-token --provider openai --expires-in 365d  # Manual token
openclaw models auth order get                     # View profile rotation
openclaw models auth order set anthropic:work,anthropic:default  # Set rotation
```

---

## CLI Backend Support

OpenClaw supports CLI backends as fallback when API providers are unavailable. CLI backends invoke local AI tools via subprocess and parse their output.

| Backend | Tool |
|---------|------|
| `claude-cli` | Official Claude CLI (Anthropic) |
| `gemini-cli` | Official Gemini CLI (Google) |
| `ai-cli` | Generic OpenAI CLI |
| `openrouter-cli` | OpenRouter CLI wrapper |

---

## Model Definition Parameters

Each model entry in the providers config supports:

| Field | Description | Default |
|-------|-------------|---------|
| `id` | Model identifier (e.g., `claude-opus-4-6`) | Required |
| `name` | Display name | - |
| `api` | API type (e.g., `anthropic-messages`) | - |
| `reasoning` | Supports native reasoning mode | `false` |
| `input` | Supported input types (e.g., `["text", "image"]`) | `["text"]` |
| `cost` | Token costs (`input`, `output`, `cacheRead`, `cacheWrite`) | - |
| `contextWindow` | Max context tokens | `200000` |
| `maxTokens` | Max output tokens | `8192` |

---

## Rate Limiting & Usage

```json5
{
  providers: {
    anthropic: {
      rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100000 }
    },
    usage: { enabled: true, logFile: "~/.openclaw/usage.log" }
  }
}
```

```bash
openclaw usage show --provider anthropic --period month
```

---

## Environment Variables (Complete)

### Model Providers

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Google Gemini |
| `GOOGLE_API_KEY` | Google (alternative) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `MOONSHOT_API_KEY` | Moonshot (Kimi) |
| `MINIMAX_API_KEY` | MiniMax |
| `ZAI_API_KEY` | Z.AI (GLM) |
| `AI_GATEWAY_API_KEY` | AI Gateway |
| `SYNTHETIC_API_KEY` | Synthetic |
| `GROQ_API_KEY` | Groq |
| `MISTRAL_API_KEY` | Mistral |
| `CEREBRAS_API_KEY` | Cerebras |
| `VENICE_API_KEY` | Venice |
| `XAI_API_KEY` | xAI (Grok) |

### Tools & Search

| Variable | Service |
|----------|---------|
| `BRAVE_API_KEY` | Brave Search |
| `PERPLEXITY_API_KEY` | Perplexity |
| `FIRECRAWL_API_KEY` | Firecrawl |

### Voice & Media

| Variable | Service |
|----------|---------|
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |
| `XI_API_KEY` | ElevenLabs (alias) |
| `DEEPGRAM_API_KEY` | Deepgram STT |

### Gateway & System

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token |
| `OPENCLAW_GATEWAY_PASSWORD` | Alternative gateway auth |
| `OPENCLAW_STATE_DIR` | State directory (default: `~/.openclaw`) |
| `OPENCLAW_CONFIG_PATH` | Config file path |
| `OPENCLAW_HOME` | Home directory |
| `OPENCLAW_LOAD_SHELL_ENV` | Import keys from login shell (`1` to enable) |
| `OPENCLAW_SHELL_ENV_TIMEOUT_MS` | Shell env import timeout (default: `15000`) |

### Channels

| Variable | Channel |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram |
| `DISCORD_BOT_TOKEN` | Discord |
| `SLACK_BOT_TOKEN` | Slack |
| `SLACK_APP_TOKEN` | Slack (app token) |
| `MATTERMOST_BOT_TOKEN` | Mattermost |
| `MATTERMOST_URL` | Mattermost server URL |
| `ZALO_BOT_TOKEN` | Zalo |
| `OPENCLAW_TWITCH_ACCESS_TOKEN` | Twitch |

### Env-Source Precedence (highest to lowest)

1. Process environment variables
2. `./.env` (project-local)
3. `~/.openclaw/.env` (user-level)
4. `openclaw.json` `env` block

Existing non-empty process env vars are not overridden by dotenv/config env loading.

Environment variables can be referenced in config with `${VAR_NAME}` or `$VAR_NAME` syntax:
```json5
{
  env: {
    ANTHROPIC_API_KEY: "sk-ant-...",
    OPENAI_API_KEY: "sk-..."
  },
  models: {
    providers: {
      anthropic: { apiKey: "$ANTHROPIC_API_KEY" },
      openai: { apiKey: "$OPENAI_API_KEY" }
    }
  }
}
```

---

## CLI Commands Reference

```bash
# Model status and listing
openclaw models status                  # Show auth status and current model
openclaw models status --probe          # Test connectivity and auth
openclaw models status --check          # Exit code indicates auth health
openclaw models list                    # List available models
openclaw models list --all              # Full catalog
openclaw models list --local            # Locally available only
openclaw models list --provider <name>  # Specific provider models

# Setting models
openclaw models set <provider/model>    # Set primary text model
openclaw models set-image <model>       # Set primary image model

# Aliases
openclaw models aliases list            # Show aliases
openclaw models aliases add <a> <m>     # Create alias (e.g., opus anthropic/claude-opus-4-6)
openclaw models aliases remove <alias>  # Remove alias

# Fallbacks
openclaw models fallbacks list          # Show fallback chain
openclaw models fallbacks add <model>   # Add to fallback chain
openclaw models fallbacks remove <m>    # Remove from chain
openclaw models fallbacks clear         # Disable fallbacks

# Scanning
openclaw models scan                    # Auto-scan and select best model
openclaw models scan --set-default      # Update primary after scan

# Authentication
openclaw models auth add                # Interactive auth setup
openclaw models auth setup-token --provider anthropic  # Setup token auth
openclaw models auth paste-token --provider openai --expires-in 365d  # Manual token
openclaw models auth order get          # View profile rotation order
openclaw models auth order set <list>   # Set rotation order

# Diagnostics
openclaw doctor                         # Full diagnostic check
openclaw models status --probe          # Test all providers
```

---

## Provider-Specific Behavior Notes

### MiniMax Tag Enforcement

When `enforceFinalTag` is enabled, only content inside `<final>` blocks is returned, suppressing content outside to prevent reasoning leakage.

### Provider-Specific Tool Policy

Use `tools.byProvider` to narrow tools for specific providers or models without changing global defaults.

### Model Discovery

OpenClaw writes a `models.json` file to each agent directory at runtime. This file merges configured providers with model metadata, enabling the SDK to discover available models.

---

## Upstream Sources

- https://deepwiki.com/openclaw/moltbot/5.2-model-providers
- https://deepwiki.com/openclaw/openclaw/12.4-model-commands
- https://www.getopenclaw.ai/help/api-key-setup-all-providers
- https://open-claw.bot/docs/concepts/model-providers/
- https://blog.laozhang.ai/en/posts/openclaw-custom-model
- https://openrouter.ai/docs/guides/guides/openclaw-integration
- https://github.com/openclaw/openclaw/blob/main/.env.example
- https://help.apiyi.com/en/openclaw-web-search-configuration-guide-en.html
- https://docs.z.ai/devpack/tool/openclaw
- https://lumadock.com/tutorials/free-ai-models-openclaw
