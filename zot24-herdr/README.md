# Herdr for Umbrel

An [Umbrel](https://umbrel.com) app that runs [Herdr](https://herdr.dev) —
the terminal multiplexer for AI coding agents — as a persistent server on
your Umbrel box. Your agents (Claude Code, Codex, Gemini, …) keep running
24/7 on home hardware; you attach from a browser, your laptop, or your phone
and everything is exactly where you left it.

- **App ID**: `zot24-herdr`
- **Port**: 7681 (web terminal, behind Umbrel auth — never exposed directly)
- **Upstream**: [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) v0.7.5 (AGPL-3.0)

## How it's wired

```
  browser / laptop / phone
        |
        |  (a) Umbrel app proxy (Umbrel login)      — web UI
        |  (b) SSH/Mosh into host, over Tailscale   — phone (Moshi)
        |  (c) herdr --remote, over SSH/Tailscale   — laptop thin client
        v
  zot24-herdr_server_1 container
    ├── ttyd :7681 ──► herdr        (attach client for browser sessions)
    └── herdr server                (headless; owns panes, agents, sessions)
              └── /data volume: config, session state, agent CLIs, workspaces
```

`herdr server` runs headless in the container and owns all panes and agents.
Clients — the ttyd web terminal, an `ssh` + `docker exec` session, or
`herdr --remote` — only attach/detach (`ctrl+b q`). Closing every client
leaves every agent running.

## Installing on Umbrel

Add the community app store on your Umbrel (**App Store → Community App
Stores → Add**), then install **Herdr**:

```
https://github.com/zot24/umbrel-apps
```

> Note: until the first CI build runs, `docker-compose.yml` has no pinned
> `@sha256` digest and Umbrel will refuse to install. Push to `main` (or run
> the *Build: Herdr* workflow manually) to build and pin the image.

## Attaching

### (a) Web terminal — the app UI

Open the Herdr tile in the Umbrel dashboard. ttyd serves the full Herdr TUI
in the browser; Umbrel's app proxy enforces your Umbrel login. Detach with
`ctrl+b q` or just close the tab — the server and agents keep running.

### (b) Phone — Moshi over SSH/Mosh (recommended)

1. Put the Umbrel box and your phone on the same tailnet (install the
   Tailscale Umbrel app; sign in on both devices). Do **not** port-forward
   SSH on your router.
2. SSH from the phone to the **host** (Moshi, Blink, Termius…), then:

   ```bash
   docker exec -it zot24-herdr_server_1 herdr
   ```

3. Optional but recommended — install this wrapper on the host so `herdr`
   works as if it were installed natively (Moshi's herdr picker runs
   `herdr session list --json`, and `herdr --remote` from a laptop invokes
   `herdr` over SSH):

   ```bash
   sudo tee /usr/local/bin/herdr >/dev/null <<'EOF'
   #!/bin/sh
   # herdr-on-host: proxy into the zot24-herdr Umbrel app container.
   if [ -t 0 ] && [ -t 1 ]; then
       exec docker exec -it zot24-herdr_server_1 herdr "$@"
   else
       exec docker exec -i zot24-herdr_server_1 herdr "$@"
   fi
   EOF
   sudo chmod +x /usr/local/bin/herdr
   ```

   Then plain `herdr` works right after SSH login, and Moshi's session
   detection picks up your sessions.

For Mosh (survives sleep/network switches): install `mosh` on the **host OS**
(`sudo apt install mosh`; the container's copy is for outbound use) and allow
UDP 60000–61000 **on the tailnet only**. Mosh replaces SSH as transport;
Herdr still owns persistence.

### (c) Laptop — `herdr --remote`

With the wrapper from (b) in place and Herdr installed locally:

```bash
herdr --remote umbrel            # umbrel = an entry in ~/.ssh/config
herdr --remote umbrel --session agents
```

The local process is a thin client; the server on your Umbrel owns the
session. Use `--remote-keybindings server` to apply the container's
keybindings instead of your laptop's.

## Setting up agents

From the web terminal (or any attach path):

```bash
# Agent CLIs install onto the persistent volume (NPM_CONFIG_PREFIX=/data/.npm-global)
npm install -g @anthropic-ai/claude-code
# npm install -g @openai/codex …

# Enable Herdr's native session restore per agent
herdr integration install claude
herdr integration status

# API keys + git identity: write them to the app's data dir and restart the app
#   <umbrel>/home/.../app-data/zot24-herdr/data/.env
#     ANTHROPIC_API_KEY=sk-…
#     GIT_AUTHOR_NAME=…  GIT_AUTHOR_EMAIL=…
#     GIT_COMMITTER_NAME=… GIT_COMMITTER_EMAIL=…

# Keep your code on the volume so it persists
cd /data/workspaces
git clone git@github.com:you/project.git
```

## What persists (and where)

Everything lives under the app data volume mounted at `/data` (which is also
`$HOME` inside the container):

| Path | Contents |
| --- | --- |
| `/data/.config/herdr/` | config.toml, server socket, session state, logs |
| `/data/.npm-global/` | npm-installed agent CLIs (survive image updates) |
| `/data/workspaces/` | your git clones / project dirs |
| `/data/.env` | optional secrets + git identity (compose `env_file`) |

Persistence semantics are Herdr's own: detach keeps processes alive; a
container restart restarts the server and restores the session layout, and
agents with installed integrations resume natively
(`[session] resume_agents_on_restore`, on by default). Live pane processes
do not survive a full container stop — same as any Herdr server restart.


## Sibling apps / Hermes agent-bridge

Human attach path stays the web terminal (ttyd on **7681**, Umbrel login).

Machine attach path for sibling containers on the Umbrel Docker network:

| | |
|---|---|
| URL | `http://zot24-herdr_server_1:7682` (export `APP_ZOT24_HERDR_AGENT_PORT`) |
| Auth | `Authorization: Bearer $HERDR_AGENT_TOKEN` |
| Health | `GET /health` (no auth) |
| Status | `GET /v1/status` |
| Shell | `POST /v1/exec` `{"cmd":"claude --version","cwd":"/data/workspaces"}` |
| Herdr CLI | `POST /v1/herdr` `{"args":["session","list","--json"]}` |

**Not** exposed via `app_proxy`. Treat the token like root on this container.

### `/data/.env` (restart app after edit)

```bash
# required for agent-bridge auth
HERDR_AGENT_TOKEN=generate-a-long-random-string

# optional: install Claude Code (etc.) onto the persistent volume at start
HERDR_BOOTSTRAP_AGENTS=1
# HERDR_BOOTSTRAP_PACKAGES=@anthropic-ai/claude-code

# agent / git credentials living IN herdr (not in Hermes)
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# XAI_API_KEY=
GITHUB_TOKEN=
# GH_TOKEN=   # gh CLI also accepts this
GIT_AUTHOR_NAME=
GIT_AUTHOR_EMAIL=
GIT_COMMITTER_NAME=
GIT_COMMITTER_EMAIL=
# VERCEL_TOKEN=
# SUPABASE_ACCESS_TOKEN=
```

Bootstrap without restart (from web terminal or bridge exec):

```bash
HERDR_BOOTSTRAP_AGENTS=1 bash /usr/local/lib/herdr-umbrel/bootstrap-agents.sh
```

### Hermes side

1. Put the **same** `HERDR_AGENT_TOKEN` in Hermes env (or a skill secret file).
2. Call `http://zot24-herdr_server_1:7682` (or the discovered IP) — never the public Umbrel URL for the bridge.
3. Keep high-value cloud creds in herdr's `/data/.env`; Hermes orchestrates, herdr executes.

## Updating

Herdr is baked into the image (pinned + sha256-verified). App updates ship
new Herdr versions through the Umbrel store update flow — do **not** run
`herdr update` inside the container (the binary is root-owned; and an
in-place update would be lost on the next container rebuild anyway).

## Security notes

- The web terminal is **full shell access** to the container. It sits behind
  Umbrel's app-proxy auth and publishes no port; keep it that way. Never
  `tailscale funnel` or tunnel it publicly without adding real
  authentication.
- Reach the host over **Tailscale**; don't expose SSH on your router.
- Treat the app data volume like a dev workstation: agent CLIs can read
  everything in `/data`, use your API keys, and push to your git remotes.
- Herdr pane-history replay (`[experimental] pane_history`) can persist
  secrets visible on screen — leave it off unless you need it.
- The container runs as an unprivileged user (UID 1000) and needs no
  capabilities beyond the one-shot `/data` chown at startup.

## Local development

```bash
docker compose -f docker-compose.local.yml up --build
# open http://localhost:7681 — no auth in local dev; bind to localhost only
```

State lands in the `herdr-local-data` named volume (a bind mount is
deliberately not used: macOS Docker Desktop bind mounts can't host the Unix
sockets herdr's server needs). Reset with
`docker compose -f docker-compose.local.yml down -v`.

## Repo layout

This app lives in the [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps)
community store repo as `zot24-herdr/`:

```
server/Dockerfile        # node:22-bookworm-slim + herdr (pinned sha256) + ttyd + mosh
server/entrypoint.sh     # chown /data, seed config, start herdr server + ttyd
docker-compose.yml       # Umbrel production compose (app_proxy + server)
docker-compose.local.yml # local dev (build from source, publishes 7681)
umbrel-app.yml           # Umbrel app manifest (manifestVersion 1.1)
exports.sh               # APP_ZOT24_HERDR_IP / _PORT for sibling apps
../../.github/workflows/build-herdr.yml  # multi-arch build + digest pin-back
```
