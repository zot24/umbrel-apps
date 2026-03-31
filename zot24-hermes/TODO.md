# Hermes Umbrel App — TODO

## Dashboard Chat & Inter-Agent Comms: API Server Not Running

**Priority:** High
**Affects:** F6 Agent Chat, Inter-Agent Communication (ask-agent skill)

### Problem

The dashboard chat interface (F6 Agents) and inter-agent communication both rely on
sending HTTP requests to each profile's OpenAI-compatible API endpoint (`/v1/responses`
on a per-profile port). However, the web container only starts `hermes gateway run`,
which is the **messaging gateway** (Telegram, WhatsApp, Discord, etc.) — it does not
start the HTTP API server that listens on the expected ports.

This means:
- **Dashboard chat** (`POST /api/profiles/{name}/chat`) always returns `[ERROR] fetch failed`
  because nothing is listening on the profile's API port.
- **Inter-agent comms** (the `ask-agent` skill) would also fail for the same reason —
  one profile cannot query another profile's API endpoint.
- **Profile health checks** (`GET /api/profiles/{name}/health`) also fail silently.

### Root Cause

`entrypoint.sh` runs `hermes gateway run` which only starts the messaging platform
bridge (Telegram bot, WhatsApp bridge, etc.). The OpenAI-compatible API server is a
separate component (`hermes api-server` or similar) that needs to be started alongside
the gateway for each profile.

### What Needs to Happen

1. **Start the API server per profile** — Each profile needs both the gateway AND an
   API server running, each on their assigned port (`BASE_API_PORT + offset`).
2. **Update `entrypoint.sh`** — Start the API server as a background process alongside
   the gateway for the default profile, and for any auto-started profile gateways.
3. **Update profile start/stop** in `server.js` — When starting/stopping a profile,
   manage both the gateway and API server processes.
4. **Verify port assignments** — Ensure `getProfileApiPort()` returns ports that match
   what the API server actually binds to.

### Files Involved

- `web/entrypoint.sh` — Process startup
- `setup/server.js` — `getProfileApiPort()`, profile start/stop/health endpoints
- `web/skills/ask-agent/` — Inter-agent communication skill

### How to Test

1. Start locally: `docker compose -f docker-compose.local.yml up --build`
2. Open `http://localhost:8080/dashboard`, go to F6 Agents
3. Select the default profile tab and send a message
4. Should get a real response instead of `[ERROR] fetch failed`
5. Health indicator on profile cards should turn green
6. If multiple profiles are running, inter-agent comms log should show messages
