<!-- Source: https://docs.openclaw.ai/tools/skills -->

# OpenClaw Tools & Skills

Complete guide to tools and skills in OpenClaw.

## Tool System

### Core Tools

| Category | Tools |
|----------|-------|
| File Operations | `read`, `write`, `edit`, `apply_patch` |
| Execution | `exec`, `bash`, `process` |
| Sessions | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` |
| Memory | `memory_search`, `memory_get` |
| Web | `web_search`, `web_fetch` |
| UI | `browser`, `canvas` |

### Tool Profiles

| Profile | Available Tools |
|---------|----------------|
| `minimal` | session_status only |
| `coding` | file I/O, runtime, sessions, memory |
| `messaging` | messaging and session tools |
| `full` | all available tools |

### Tool Policy

Cascading filter where each stage can only restrict, never expand:

```
profile → global/agent policies → group policies → sandbox policies → subagent overrides
```

Deny rules always override allow rules at every stage.

```json
{
  "tools": {
    "profile": "coding",
    "deny": ["browser", "canvas"],
    "byProvider": {
      "openai/gpt-4": {
        "allow": ["group:fs", "sessions_list"]
      }
    }
  }
}
```

### Tool Groups

| Group | Tools |
|-------|-------|
| `group:runtime` | exec, bash, process |
| `group:fs` | file system tools |
| `group:sessions` | all session operations |
| `group:memory` | semantic search tools |

---

## Skills System

AgentSkills-compatible folders with `SKILL.md` that teach OpenClaw tools and capabilities.

### Skill Locations (Precedence)

1. **Workspace skills**: `<workspace>/skills/` (highest)
2. **Agent-specific**: `~/.openclaw/agents/<agentId>/skills/`
3. **Managed/local**: `~/.openclaw/skills/`
4. **Bundled**: Shipped with installation (lowest)

### Creating Skills

```markdown
---
name: my-skill
description: What this skill does
allowed-tools: Read, Write, Edit, Bash
---

# My Skill

Instructions for the agent...
```

### Skill Configuration

```json
{
  "skills": {
    "install": { "nodeManager": "bun" },
    "entries": {
      "my-skill": {
        "enabled": true,
        "env": { "MY_VAR": "value" },
        "apiKey": "${MY_API_KEY}"
      }
    }
  }
}
```

### Skills CLI

```bash
openclaw skills list
openclaw skills install <skill-slug>
openclaw skills config <skill> set <key> <value>
openclaw skills run <skill> <command>
openclaw skills update --all
openclaw skills remove <skill-name>
```

---

## Plugins System

Four integration types: channels, tools, providers, memory.

```bash
openclaw plugins list                        # List installed
openclaw plugins add <plugin-name>           # Install from npm
openclaw plugins enable <plugin>             # Enable
openclaw plugins disable <plugin>            # Disable
openclaw plugins update                      # Update all
```

### Plugin Configuration

```json
{
  "plugins": {
    "entries": {
      "telegram": { "enabled": true },
      "unbrowse-openclaw": {
        "enabled": true,
        "credentialSource": "auto"
      }
    },
    "installs": {
      "unbrowse-openclaw": {
        "source": "npm",
        "spec": "@getfoundry/unbrowse-openclaw",
        "version": "0.5.2"
      }
    }
  }
}
```

---

## Hooks

Internal hooks for automation:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "boot-md": { "enabled": true },
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": true }
      }
    }
  }
}
```

- `boot-md` — Load BOOT.md on startup
- `command-logger` — Log executed commands
- `session-memory` — Persist conversation memory

---

## ClawdHub

Public skills registry at https://clawhub.com (5,700+ community skills)

```bash
clawdhub install <skill-slug>
clawdhub update --all
clawdhub search "web scraping"
clawdhub publish <skill-dir>
```

---

## Exec Tool

```json
{
  "tools": {
    "exec": {
      "enabled": true,
      "allowedCommands": ["ls", "cat", "grep"],
      "blockedCommands": ["rm", "sudo"],
      "timeout": 30000,
      "sandbox": { "enabled": true, "network": false }
    }
  }
}
```

### Sandbox Execution Modes

- **Sandbox** (Docker): Isolated per-session containers
- **Host**: Runs directly on Gateway process
- **Node**: Remote execution on paired devices via `node.invoke`
- **Elevated**: Bypasses sandbox when authorized

---

## Browser Automation

```json
{
  "tools": {
    "browser": { "enabled": true, "engine": "playwright", "headless": true }
  }
}
```

Includes **unbrowse** — visual element detection for API reverse-engineering.

Capabilities: Navigate, click, fill forms, screenshots, extract content, execute JS, CDP access, profile support.

---

## Web Search

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "brave",
        "apiKey": "${BRAVE_SEARCH_KEY}"
      }
    }
  }
}
```

Built-in skills include: Web Search (Brave), Web Fetch, Browser automation.

---

## Slash Commands

### Built-in

| Command | Description |
|---------|-------------|
| `/help` | Show commands |
| `/status` | Session status |
| `/new` / `/reset` | Reset session |
| `/mesh <goal>` | Multi-step workflow |
| `/think <level>` | Thinking depth |
| `/compact` | Context compaction |
| `/verbose on\|off` | Toggle verbosity |
| `/model` | Switch model |

### Custom Commands

Define in skill files:

```markdown
## /mycommand
When user runs `/mycommand`: Do something...
```

---

## Thinking Modes

```bash
openclaw agent --thinking high "Deep analysis"
```

In-channel: `/think off|minimal|low|medium|high|xhigh`

---

## Subagents

```json
{
  "agents": {
    "defaults": {
      "subagents": { "maxConcurrent": 8 }
    }
  }
}
```

Session tools enable agent-to-agent coordination: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`.

---

## Tool Permissions

```json
{
  "tools": {
    "permissions": {
      "session:whatsapp:+1234567890": { "exec": false, "browser": true }
    }
  }
}
```

**Owner-only tools**: gateway actions (restart, update) and WhatsApp login, regardless of policy.

---

## Custom Tool Development

```javascript
// tools/mytool.js
module.exports = {
  name: 'mytool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string' } }
  },
  execute: async ({ input }) => ({ result: 'done' })
};
```

---

## MCP Servers (via MCPorter)

Connect to Model Context Protocol (MCP) servers using [MCPorter](https://github.com/steipete/mcporter).

**Note**: Native MCP integration is not yet implemented (GitHub Issue #13248).

### Configuration

Create `~/.openclaw/mcporter.json`:

```json
{
  "servers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"],
      "env": { "LINEAR_API_KEY": "${LINEAR_API_KEY}" }
    }
  }
}
```

### Auto-Discovery

MCPorter auto-discovers MCP servers configured in Claude Code/Desktop, Cursor, Codex, and local overrides.

```bash
npx mcporter list
npx mcporter list <server-name>
npx mcporter call <server>.<tool> [args]
```

---

## Upstream Sources

- https://docs.openclaw.ai/tools/skills
- https://docs.openclaw.ai/tools/exec
- https://docs.openclaw.ai/tools/browser
- https://docs.openclaw.ai/tools/slash-commands
- https://docs.openclaw.ai/tools/subagents
- https://docs.openclaw.ai/tools/clawdhub
- https://github.com/steipete/mcporter
- https://github.com/openclaw/openclaw
