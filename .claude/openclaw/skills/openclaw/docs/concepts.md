<!-- Source: https://github.com/openclaw/openclaw/tree/main/docs/concepts -->
<!-- Fetched: 2026-02-17 -->

# OpenClaw Core Concepts

Core concepts and architecture of OpenClaw (formerly Clawdbot).

## Architecture

### Core Components

- **Gateway (Daemon)**: Long-lived process that owns all messaging surfaces (WhatsApp via Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat). Exposes a typed WebSocket API at `ws://127.0.0.1:18789` with request-response and server-push event patterns. Validates inbound frames against JSON Schema and emits event categories: agent, chat, presence, health, heartbeat, and cron.
- **Control-Plane Clients**: CLI, macOS app, web admin — each maintains its own WebSocket connection to the Gateway. Sends requests (`health`, `status`, `send`, `agent`, `system-presence`) and subscribes to events (`tick`, `agent`, `presence`, `shutdown`).
- **Nodes**: iOS, Android, macOS devices connect with `role: node` via WebSocket (or legacy Bridge protocol on TCP port 18790). Declare device identity and expose commands for canvas, camera, screen recording, and location retrieval.
- **WebChat**: Static UI served at Gateway `/chat` path.
- **Agent Runtime**: Embedded runtime based on pi-mono, manages workspace directories and session bootstrapping.

### Wire Protocol (WebSocket)

The Gateway uses WebSocket text frames containing JSON payloads. The initial frame **must** be a `connect` request.

**Handshake flow:**

1. Server sends challenge: `{"type":"event","event":"connect.challenge","payload":{"nonce":"...","ts":...}}`
2. Client responds with connect request containing protocol version negotiation (`minProtocol`/`maxProtocol`), client metadata (ID, version, platform), role declaration, auth token, device fingerprint with cryptographic signature, and capability claims for nodes.
3. Server approves: `{"type":"res","ok":true,"payload":{"type":"hello-ok","protocol":3}}`

**Message framing:**

```json
{"type": "req", "id": "uuid", "method": "agent.run", "params": {...}}
{"type": "res", "id": "uuid", "ok": true, "payload": {...}}
{"type": "event", "event": "agent.delta", "payload": {...}, "seq": 1, "stateVersion": 2}
```

**Roles and authorization:**

- **Operator** clients (CLI, web UI, automation) declare scopes: `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`, `operator.pairing`
- **Node** clients declare capabilities, commands, and granular permissions
- Token-based authentication via `OPENCLAW_GATEWAY_TOKEN`; device tokens bind to connection roles/scopes
- Non-local connections require signed challenges using device keypairs
- Idempotency keys mandatory for side-effecting operations (short-lived dedup cache)

### Bridge Protocol (Legacy)

The Bridge protocol is a legacy TCP JSONL node transport. **New node clients should use the unified Gateway WebSocket protocol.** Current OpenClaw builds no longer ship the TCP bridge listener.

Key aspects of the legacy protocol:
- TCP, one JSON object per line (JSONL), optional TLS
- Legacy default port: 18790
- Connection handshake: `hello` -> `pair-request` -> `pair-ok` -> `hello-ok`
- Frame types: `req`/`res` (scoped RPC), `event` (node signals), `invoke`/`invoke-res` (node commands), `ping`/`pong` (keepalive)
- Supported Bonjour LAN discovery and tailnet connections
- TLS records included `bridgeTls=1` plus `bridgeTlsSha256` (unauthenticated hints)

---

## Agent Runtime

### Execution Flow

The agent loop is a complete operational cycle:

```
intake -> context assembly -> model inference -> tool execution -> streaming replies -> persistence
```

### Agent Loop Detail

1. **Entry**: Gateway RPC `agent` or `agent.wait`, or CLI `agent` command
2. **Validation**: The `agent` RPC validates parameters, resolves session, returns `runId` and `acceptedAt` timestamp immediately
3. **Orchestration**: `AgentCommand` resolves model settings, loads skills, invokes embedded Pi-agent runtime
4. **Serialization**: `runEmbeddedPiAgent` handles per-session and global queues, establishes Pi session, subscribes to events, enforces timeouts with automatic abortion
5. **Event streaming**: Pi-agent events bridge to OpenClaw streams:
   - Tool events -> `stream: "tool"`
   - Model output -> `stream: "assistant"` deltas
   - Lifecycle transitions -> `stream: "lifecycle"` (phases: start, end, error)

### Concurrency and Queuing

Runs are serialized per session key (session lane) and optionally through a global lane, preventing races and preserving history consistency. Messaging channels employ different queue modes that integrate with the lane system.

- `agents.defaults.maxConcurrent`: 4
- `agents.defaults.subagents.maxConcurrent`: 8

### Hook Interception Points

Two hook systems:
- **Gateway hooks** (event-driven): bootstrap and commands
- **Plugin hooks** (full lifecycle): `before_model_resolve`, `before_prompt_build`, tool call interception, message hooks, session boundaries

### Timeouts

- Agent runtime: 600s (`agents.defaults.timeoutSeconds`)
- `agent.wait`: 30s (configurable via `timeoutMs`)
- Early termination: timeout, AbortSignal, gateway disconnection, or RPC timeout

---

## System Prompt

OpenClaw builds custom system prompts for each agent run using fixed sections: tooling, safety guidelines, skills, workspace configuration, documentation paths, sandbox details, timestamp data, and runtime information.

### Bootstrap Files

Auto-injected into context on every turn (if present):

| File | Purpose |
|------|---------|
| `AGENTS.md` | Operating instructions and behavioral guidelines |
| `SOUL.md` | Persona, tone, and boundaries |
| `TOOLS.md` | Local tool notes (guidance only) |
| `IDENTITY.md` | Agent name, vibe, emoji |
| `USER.md` | User identity and addressing preferences |
| `HEARTBEAT.md` | Optional checklist for heartbeat runs |
| `BOOTSTRAP.md` | One-time first-run ritual (delete after use) |
| `MEMORY.md` / `memory.md` | Persistent memory (when present) |

All of these files consume tokens on every turn. Large files are trimmed with truncation markers; blank files are skipped.

### File Size Limits

- Per-file maximum: 20,000 characters (configurable via `agents.defaults.bootstrapMaxChars`)
- Total injected bootstrap: 150,000 characters (default)

### Prompt Modes

| Mode | Description |
|------|-------------|
| `full` | All sections (default) |
| `minimal` | Sub-agents; omits skills and self-update |
| `none` | Identity only |

### Skills in System Prompt

When eligible, OpenClaw injects a compact skills list with file paths, instructing the model to read skill documentation as needed rather than including full skill content upfront.

---

## Memory System

Memory operates as **plain Markdown files in the agent workspace**. The filesystem is the definitive source; the model only retains information written to disk.

### Memory Files

| Type | Path | Behavior |
|------|------|----------|
| **Daily logs** | `memory/YYYY-MM-DD.md` | Append-only daily notes, read at session start (today + yesterday) |
| **Long-term** | `MEMORY.md` | Curated durable facts, loaded only in private sessions (not groups) |

Both reside under the workspace directory (default: `~/.openclaw/workspace`).

**When to write memory:** Store decisions, preferences, and durable facts in `MEMORY.md`. Day-to-day notes and running context go to daily logs. Ask the bot to write it to ensure persistence.

### Pre-Compaction Memory Flush

When sessions approach auto-compaction, OpenClaw triggers a silent agentic turn reminding the model to write durable memory before context compression. Produces `NO_REPLY` so users see nothing.

- **Soft threshold**: triggers when tokens cross `contextWindow - reserveTokensFloor - softThresholdTokens`
- **Default prompt**: "Session nearing compaction. Store durable memories now."
- **One flush per cycle**: tracked in `sessions.json`
- **Workspace requirement**: skipped if workspace access is read-only or none

### Memory Search (Vector)

Hybrid search combining vector similarity (semantic match) with BM25 keyword relevance (exact tokens, IDs, code symbols):

```json
{
  "agents": {
    "defaults": {
      "memorySearch": { "enabled": true }
    }
  }
}
```

- **Enabled by default**, file watcher tracks changes (1.5s debounce)
- **Provider auto-selection**: local (if configured) -> OpenAI -> Gemini -> Voyage
- **Remote embeddings require API keys** from auth profiles or environment variables
- **Chunking**: ~400-token target with 80-token overlap
- **Index**: SQLite at `~/.openclaw/memory/<agentId>.sqlite`
- **Sync**: on session start, search, or interval

#### MMR Re-ranking (Diversity)

Iteratively selects chunks that balance relevance with diversity. Default lambda of 0.7 (balanced preference for relevance).

#### Temporal Decay (Recency)

Exponential multiplier based on age: `score x e^(-lambda x ageInDays)`. Evergreen files (`MEMORY.md`, non-dated notes) skip decay. Default half-life: 30 days.

#### QMD Backend (Experimental)

Optional local-first sidecar combining BM25 + vectors + reranking. Requires separate QMD CLI installation and runs fully locally with auto-downloaded GGUF models.

### Memory Tools

- `memory_search` — semantic search returning snippets with file paths, line ranges, and scores (~700 char cap)
- `memory_get` — reads specific memory files by workspace-relative path with optional line-range parameters

---

## Sessions

### Session Keys

One primary direct-chat session per agent, collapsing to `agent:<agentId>:<mainKey>` format (typically `main`). Group and channel chats receive their own distinct keys.

**Routing patterns:**

| Type | Key Format |
|------|-----------|
| Direct chats | Follow `dmScope` rules |
| Groups | `agent:<agentId>:<channel>:group:<id>` |
| Cron jobs | `cron:<job.id>` |
| Webhooks | `hook:<uuid>` |
| Telegram topics | Append `:topic:<threadId>` |

### DM Scope Control

`session.dmScope` manages DM grouping:

| Value | Behavior |
|-------|----------|
| `main` (default) | All DMs share the main session for continuity |
| `per-peer` | Isolates by sender across channels |
| `per-channel-peer` | Isolates by channel plus sender |
| `per-account-channel-peer` | Isolates by account, channel, and sender |

Use `session.identityLinks` to map provider-prefixed peer identifiers to canonical identities for cross-channel continuity.

**Security**: Multi-user setups should enable secure DM mode to prevent context leakage. Set `dmScope` to isolate sessions per user for environments with multiple senders, allowlists, or open policies.

### Session Storage

- **Gateway authority**: Gateway host is the authoritative session store; UI clients query it
- **State file**: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **Transcripts**: JSONL at `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

### Session Lifecycle

**Reset policies:**

- Daily reset: 4:00 AM local time on the gateway host (default)
- Idle reset: optional sliding window via `idleMinutes`
- When both configured, whichever expires first forces a new session
- Per-type overrides: `resetByType` for direct/group/thread sessions
- Per-channel overrides: `resetByChannel`

**Manual triggers:**

- `/new` or `/reset` creates fresh session
- `/new <model>` accepts model aliases or providers
- Delete store keys manually to recreate sessions

### Session Pruning (In-Memory)

Trims aged tool results from in-memory context before LLM calls without modifying on-disk JSONL history:

- Activates when `mode: "cache-ttl"` is set and most recent Anthropic API call exceeds TTL
- Only applies to Anthropic API calls and OpenRouter Anthropic models
- User and assistant messages untouched; only `toolResult` messages are candidates
- Last `keepLastAssistants` assistant messages establish cutoff zone
- Image blocks always protected
- **Soft-trim**: preserves content head/tail for oversized results (>50,000 chars), inserts ellipsis
- **Hard-clear**: replaces entire results with `"[Old tool result content cleared]"`
- Default TTL: 5 minutes; protected assistant messages: 3

### Compaction

Summarizes older conversation into compact entries while preserving recent messages. Persistent in JSONL (unlike pruning which is in-memory only).

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard"
      }
    }
  }
}
```

| Mode | Description |
|------|-------------|
| `safeguard` | Compacts when approaching context limit (default) |
| `aggressive` | Compacts more frequently |
| `none` | Never auto-compact |

Manual compaction: `/compact` with optional instructions.

### Send Policy

Block delivery by session type using configuration rules without listing individual IDs. Runtime overrides: `/send on`, `/send off`, `/send inherit`.

### Origin Metadata

Sessions record sourcing info: label, provider, sender/recipient routing IDs, account ID, thread ID.

### Inspection Commands

- `openclaw status` — store path and recent sessions
- `openclaw sessions --json` — dump all entries
- `/status` — reachability and context usage
- `/context list` / `/context detail` — system prompt contents
- `/compact` — summarize older context

---

## Context Pruning

Controls how conversation history is managed. Context refers to everything sent to the model: system prompt, conversation history, tool calls, results, attachments.

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "1h"
      }
    }
  }
}
```

| Mode | Description |
|------|-------------|
| `cache-ttl` | Prune tool results older than TTL (default). Reduces `cacheWrite` size on first request after TTL expiration. TTL window resets post-pruning. |
| `sliding` | Sliding window of recent messages |
| `none` | Keep everything until compaction |

### What Counts Toward Context Window

Everything transmitted to the model accumulates tokens:
- System prompt components (bootstrap files, tool schemas, skills list)
- Conversation history
- Tool calls and results
- Attachments (images, audio, files)
- Compaction summaries
- Provider wrapper overhead

### Context Inspection

- `/status` — window fullness overview
- `/context list` — injected files and rough token counts
- `/context detail` — breakdown by file, tool schema, and skill sizes
- `/usage tokens` — per-reply token usage footer

---

## Workspaces

The workspace is the agent's home directory -- the **only** working directory used for file tools and operations.

### Standard Layout

```
~/.openclaw/workspace/
├── AGENTS.md          # Operating instructions
├── SOUL.md            # Persona and boundaries
├── TOOLS.md           # Tool guidance
├── BOOTSTRAP.md       # One-time setup ritual
├── IDENTITY.md        # Agent identity
├── USER.md            # User profile
├── HEARTBEAT.md       # Heartbeat config
├── BOOT.md            # Optional startup checklist on gateway restart
├── MEMORY.md          # Long-term curated memory
├── memory/            # Daily memory logs (YYYY-MM-DD.md)
├── skills/            # Workspace-specific skills (optional)
└── canvas/            # Canvas UI files (optional)
```

### Location and Configuration

- **Default**: `~/.openclaw/workspace`
- **Profile-based**: `~/.openclaw/workspace-<profile>` when `OPENCLAW_PROFILE` is set
- **Configurable**: `agent.workspace` in `~/.openclaw/openclaw.json`

### Security Caveat

The workspace functions as the **default cwd, not a hard sandbox**. Relative paths resolve within it, but absolute paths can access the host system unless sandboxing is explicitly enabled through `agents.defaults.sandbox`.

### Items Stored Separately (Under `~/.openclaw/`)

- Configuration files
- Credentials and OAuth tokens
- Session transcripts
- Managed skills

### Backup

Treat the workspace as private memory. Maintain it in a **private git repository** for recovery. Migration: clone backup repo, run `openclaw setup --workspace <path>`.

---

## Multi-Agent Routing

An **agent** represents a fully isolated "brain" with dedicated workspace, state directory, and session store. The Gateway can host multiple agents simultaneously.

### What Defines an Agent

- **Workspace** containing AGENTS.md, SOUL.md, USER.md, and persona rules
- **State directory** (`agentDir`) for authentication profiles and model registry
- **Session store** at `~/.openclaw/agents/<agentId>/sessions`
- **Auth profiles** per-agent at `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

### Agent List Configuration

```json
{
  "agents": {
    "list": [
      { "id": "home", "workspace": "~/.openclaw/workspace-home" },
      { "id": "work", "workspace": "~/.openclaw/workspace-work" }
    ],
    "defaults": {
      "maxConcurrent": 4,
      "subagents": { "maxConcurrent": 8 }
    }
  }
}
```

Each entry specifies unique identity, workspace location, and optional model preferences.

### Per-Agent SOUL.md

Each workspace maintains its own `SOUL.md` file (`~/.openclaw/agents/{agent_id}/SOUL.md`) defining personality and behavior. Enables distinct personas despite shared infrastructure.

### Routing Through Bindings

Bindings connect inbound messages to specific agents using deterministic rules. Priority order:
1. Peer match (exact DM/group/channel id)
2. parentPeer
3. Guild/role data
4. Fallback routing

### Key Isolation Features

- Separate authentication prevents credential sharing
- Independent session stores prevent cross-agent message leakage
- Per-agent sandboxing and tool restrictions available
- Different phone numbers/accounts per channel per agent
- Switch agents with `/agent work` or `/agent code`

---

## Streaming

### Block Streaming (Channels)

Emits completed blocks as the assistant writes. These are normal channel messages (not token deltas). Uses `EmbeddedBlockChunker` with min/max character boundaries (800-1200 characters).

- `blockStreamingDefault`: on/off toggle
- `blockStreamingBreak`: `text_end` (immediate emission) or `message_end` (end of response)
- Coalescing options to merge consecutive chunks before sending

### Telegram Preview Streaming

Telegram is the **only** channel with live preview streaming via Bot API message updates.

Stream modes (`streamMode`):

| Mode | Description |
|------|-------------|
| `partial` | Updates preview with latest streamed text |
| `block` | Updates follow chunker rules |
| `off` | Disables preview updates |

**Note**: No true token-delta streaming to channel messages today. Most channels require explicit `blockStreaming: true`.

### Reasoning Visibility

Controlled via `/reasoning on|off|stream`:
- `on`: Reasoning sent as a separate message prefixed with `Reasoning:`
- `stream`: Telegram-specific, displays reasoning in draft form during generation
- `off`: Reasoning hidden
- Reasoning tokens count toward usage

---

## Presence

Lightweight, best-effort view of the Gateway and connected clients. Supports the macOS app Instances tab and operator visibility.

### Presence Fields

- `instanceId` (stable identifier)
- Connection details: `host`, `ip`
- Technical info: `version`, `deviceFamily`
- Operational context: `mode`
- Activity metrics: `lastInputSeconds`
- Source attribution: `reason`
- Timestamps

### Data Sources

1. **Gateway self-entry** — initialized at startup
2. **WebSocket connections** — triggered by client handshakes (excluding CLI one-off commands)
3. **System-event beacons** — periodic updates from clients (e.g., macOS app)
4. **Node connections** — entries for nodes with `role: node`

### Lifecycle

- **TTL**: 5 minutes; entries exceeding this are removed
- **Capacity**: Maximum 200 entries; oldest dropped first
- Keys are case-insensitive
- Loopback addresses from SSH tunnels deliberately ignored

---

## Queue

Serializes inbound auto-reply runs across all channels through a tiny in-process queue, preventing multiple agent runs from colliding while allowing safe parallelism across sessions.

### Queue Modes

| Mode | Behavior |
|------|----------|
| `steer` | Inject immediately into current run |
| `followup` | Enqueue for next turn after current run ends |
| `collect` | Coalesce queued messages into single followup (default) |
| `steer-backlog` | Steer now and preserve message for later |
| `interrupt` | Abort active run and execute newest message |

### Configuration

- `debounceMs`: wait before followup (default 1000ms)
- `cap`: max queued messages per session (default 20)
- `drop` policy: `old` / `new` / `summarize` (default: summarize)
- Lane-aware FIFO with configurable concurrency (default 1 per lane; main defaults to 4, subagent to 8)

### Per-Session Override

Users send `/queue <mode>` commands: `/queue collect debounce:2s cap:25 drop:summarize`

---

## Token Usage Tracking

Pulls provider usage/quota directly from their usage endpoints. No estimated costs; only provider-reported windows.

### Display Locations

| Location | Details |
|----------|---------|
| Chat `/status` | Emoji-rich status card with session tokens + estimated cost (API key only) |
| Chat `/usage` | Tokens-only view for OAuth; full breakdown via local logs |
| CLI `openclaw status --usage` | Per-provider details |
| CLI `openclaw channels list` | Usage snapshots |
| macOS menu | Usage section under Context when data exists |

### Credential Requirements

Supports usage tracking through:
- **OAuth tokens**: Anthropic, GitHub Copilot, Gemini CLI, Antigravity, OpenAI Codex
- **API keys**: MiniMax (5-hour coding plan window), z.ai (via env/config/auth store)

Usage hidden if no matching OAuth/API credentials exist.

---

## Thinking Modes (`/think`)

Inline directives: `/t <level>`, `/think:<level>`, or `/thinking <level>`.

### Available Levels

| Level | Description |
|-------|-------------|
| `off` | No extended thinking |
| `minimal` | Basic thinking |
| `low` | Enhanced reasoning |
| `medium` | Deeper analysis |
| `high` | Maximum budget allocation |
| `xhigh` | Extended maximum (GPT-5.2 + Codex models only) |

### Setting Session Defaults

Send a message that is **only** the directive (whitespace allowed), e.g., `/think:medium`. The system confirms and maintains the setting for the current session.

### Resolution Hierarchy

1. Inline message directives
2. Session overrides
3. Global configuration defaults
4. Fallback settings

### Verbose Logging (`/verbose`)

Three states: `on` (minimal), `full`, `off`. When enabled, agents emit structured tool results as metadata-only messages. `full` additionally forwards tool outputs after completion.

---

## Sandbox Mode

Non-main sessions can run in Docker container sandboxes for security isolation.

### Sandbox Modes

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main"
      }
    }
  }
}
```

| Mode | Description |
|------|-------------|
| `off` | Disables sandboxing entirely |
| `non-main` | Only non-main sessions use containers (default for standard chat on host) |
| `all` | Every session runs sandboxed |

Non-main classification depends on `session.mainKey` (defaults to `"main"`), not agent identity. Group and channel sessions receive their own keys, making them non-main.

### Container Scope

| Scope | Description |
|-------|-------------|
| `session` | One container per session (default) |
| `agent` | One container per agent |
| `shared` | Single container for all sandboxed sessions |

### Workspace Access in Sandbox

| Access | Description |
|--------|-------------|
| `none` | Isolated sandbox workspace under `~/.openclaw/sandboxes` |
| `ro` | Read-only agent workspace mount at `/agent` |
| `rw` | Full read-write workspace access at `/workspace` |

### What Gets Sandboxed

- Tool operations: exec, read, write, edit, apply_patch, process commands
- Optional sandboxed browser
- **Not sandboxed**: Gateway process, elevated exec tools, host-allowed tools

### Session Tools Visibility

When running in a sandboxed agent session, session tools default to **spawned-only visibility**. Configuration via `agents.defaults.sandbox.sessionToolsVisibility` (`"spawned"` or `"all"`) can hard-clamp visibility, overriding broader `tools.sessions.visibility`.

### Container Runtime

- Default image: `openclaw-sandbox:bookworm-slim`
- Build: `scripts/sandbox-setup.sh`
- No network access by default (override via `agents.defaults.sandbox.docker.network`)
- Custom mounts: `agents.defaults.sandbox.docker.binds` (blocks `/etc`, `/proc`, `/sys`, docker.sock)
- Inbound media transferred into active sandbox workspace
- Skills mirrored into sandbox when needed
- Debug: `openclaw sandbox explain`

---

## Model Configuration and Failover

### Model Format

Model refs: `provider/model` (e.g., `anthropic/claude-opus-4-6`, `openai/gpt-5.1-codex`).

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": [
          "anthropic/claude-sonnet-4-20250514",
          "openai/gpt-4o"
        ]
      }
    }
  }
}
```

### Two-Stage Failover

1. **Auth profile rotation** within the current provider
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`

### Auth Profile Rotation

Profiles at `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`. Selection order:
1. Explicit `auth.order[provider]`
2. Configured `auth.profiles`
3. Stored profiles (round-robin: OAuth before API keys, oldest `lastUsed` first)

Session stickiness: chosen auth profile pinned per session for cache warmth. Auto-pinned profiles retried first but may rotate on rate limits.

### Cooldown

- Failed profiles: exponential backoff (1 min -> 5 min -> 25 min -> 1 hour max)
- Billing failures: 5 hours initial, doubling per failure, capped at 24 hours

---

## Messages

### Message Flow

```
Inbound message -> routing/bindings -> session key -> queue (if run active) -> agent run (streaming + tools) -> outbound replies
```

### Deduplication and Debouncing

- Short-lived cache keyed by `channel/account/peer/session/message id` prevents duplicate runs
- Rapid consecutive messages batched into single turn via debouncing
- Scoped per channel + conversation; uses most recent message for reply threading
- Text-only messages debounced; media flushes immediately; control commands bypass debouncing

### Typing Indicators

Controlled via `agents.defaults.typingMode`:

| Mode | Description |
|------|-------------|
| `never` | No typing indicator |
| `message` | Starts on first non-silent text delta |
| `thinking` | Starts on first reasoning delta (requires streaming reasoning) |
| `instant` | Activates as soon as model loop begins |

Refresh interval: `typingIntervalSeconds` (default 6s). Heartbeats never display typing.

---

## Retry Policy

Per HTTP request retry, not per multi-step flow. Default: 3 attempts, 30s max delay, 10% jitter.

| Channel | Behavior |
|---------|----------|
| Discord | Retries only on HTTP 429 (rate limit); leverages `retry_after` header |
| Telegram | Retries transient failures (rate limits, timeouts, connection issues). Markdown parse errors not retried; fall back to plain text. Min delay 400ms. |

Composite flows do not retry completed steps.

---

## Upstream Sources

- https://github.com/openclaw/openclaw/tree/main/docs/concepts
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/system-prompt.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/session.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/session-pruning.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/streaming.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/presence.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/queue.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/usage-tracking.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/compaction.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/context.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-workspace.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-failover.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/messages.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/typing-indicators.md
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/retry.md
- https://github.com/openclaw/openclaw/blob/main/docs/tools/thinking.md
- https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md
- https://github.com/openclaw/openclaw/blob/main/docs/gateway/bridge-protocol.md
- https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md
