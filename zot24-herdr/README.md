# Herdr for Umbrel

An [Umbrel](https://umbrel.com) app that runs [Herdr](https://herdr.dev) —
the terminal multiplexer for AI coding agents — as a persistent server on
your Umbrel box. Your agents (Claude Code, Codex, Gemini, …) keep running
24/7 on home hardware; you attach over SSH from your laptop or your phone and
everything is exactly where you left it.

- **App ID**: `zot24-herdr`
- **Ports**: 7681 status page (the app tile, behind Umbrel auth, never
  published) · 7682 SSH (published on the host, key-only) — **SSH is the way
  in; there is no terminal in the browser**
- **Upstream**: [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) v0.7.5 (AGPL-3.0)

## How it's wired

```
  browser / laptop / phone
        |
        |  (a) Umbrel app proxy (Umbrel login)      — status page only
        |  (b) SSH :7682 straight into the app      — phone (Moshi), laptop
        |  (c) herdr --remote over that same SSH    — laptop thin client
        v
  zot24-herdr_server_1 container
    ├── status :7681 ─► read-only page  (is it up, which sessions, how to attach)
    ├── sshd   :7682 ─► login shell     (key-only, unprivileged, → herdr)
    └── herdr server (PID 1)            (owns panes, agents, sessions)
              └── /data volume: config, session state, agent CLIs, workspaces,
                                SSH host key + authorized_keys
```

`herdr server` runs as PID 1 and owns all panes and agents — if it dies the
container dies and compose restarts it, instead of lingering with an SSH port
that attaches to nothing. Clients — an SSH session or `herdr --remote` — only
attach/detach (`ctrl+b q`). Closing every client leaves every agent running.

**There is no terminal in the browser, on purpose.** A web terminal is full
shell access to a container holding your API keys and git credentials, behind
a single password, with no second factor — so this app doesn't ship one. The
app tile is a status page because Umbrel requires every app to answer on its
manifest `port`; it takes no input.

**SSH lands inside the app, not on your Umbrel host.** That is deliberate: the
alternative (SSH to the host + `docker exec`) needs a host-side wrapper script
and puts the `umbrel` user in the `docker` group, which is root-equivalent on
the box. A key that only opens this container is a much smaller thing to lose
with a phone.

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

### (a) The app tile — status only

Open the Herdr tile in the Umbrel dashboard and you get a read-only page:
whether the server is up, which sessions exist, and the SSH command to attach.
No terminal, no input, no WebSocket. `GET /health` on the same port returns the
session list as JSON if you want to poll it from elsewhere.

### (b) Phone — Moshi (or any SSH client), over Tailscale

**One-time: authorise a key.** There is no password on this account and there
never will be, so the app needs your public key before it will start sshd at
all. Two ways, pick either:

- Drop the key into the app's data dir from your Umbrel host (`ssh umbrel`,
  no sudo needed — the dir is owned by your `umbrel` user):

  ```bash
  # <umbrel>/home/.../app-data/zot24-herdr/data/.ssh/authorized_keys
  echo "ssh-ed25519 AAAA… phone" >> …/zot24-herdr/data/.ssh/authorized_keys
  ```

- Or put it in the same `.env` the app already reads, and restart the app —
  use `;` between keys for more than one:

  ```bash
  # …/zot24-herdr/data/.env
  SSH_AUTHORIZED_KEYS=ssh-ed25519 AAAA… phone;ssh-ed25519 AAAA… laptop
  ```

Until a key exists, sshd does not start and the app log says so — an SSH
daemon nobody can log into is just attack surface.

**Then, from the phone:**

1. Put the Umbrel box and your phone on the same tailnet (install the
   Tailscale Umbrel app; sign in on both devices). Do **not** port-forward
   anything on your router.
2. In Moshi (getmoshi.app) or any SSH client, connect to your Umbrel's
   tailnet name on **port 7682**, user `node`:

   ```bash
   ssh -p 7682 node@your-umbrel      # lands in the container
   herdr                             # attach the TUI
   ```

Moshi has native Herdr support: its session picker runs
`herdr session list --json`, which works over this SSH login with no wrapper
and no host-side setup, because `herdr` is genuinely installed here.

**Mosh** is in the image but no UDP ports are published, so it isn't wired up
by default — one published TCP port is a smaller surface, and Herdr already
gives you the thing Mosh is usually for: drop the connection and every agent
keeps running, reconnect and you are back. If you want real Mosh anyway, add
`- "60000-60005:60000-60005/udp"` to the `ports:` block and connect with
`mosh --ssh="ssh -p 7682" --port=60000:60005 node@your-umbrel`.

### (c) Laptop — `herdr --remote`

With a key authorised and Herdr installed locally, add the port to your SSH
config and point Herdr at it:

```
# ~/.ssh/config
Host umbrel-herdr
    HostName your-umbrel
    User node
    Port 7682
```

```bash
herdr --remote umbrel-herdr
herdr --remote umbrel-herdr --session agents
```

The local process is a thin client; the server on your Umbrel owns the
session. Use `--remote-keybindings server` to apply the container's
keybindings instead of your laptop's.

## Setting up agents

From an SSH session (`ssh -p 7682 node@your-umbrel`):

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
| `/data/.ssh/` | SSH host key + `authorized_keys` (host key is generated once, so clients don't see a changed fingerprint after an app update) |
| `/data/.profile` | seeded once: puts agent CLIs on `PATH` and sources `.env` so an SSH login has the environment the app was started with |

Persistence semantics are Herdr's own: detach keeps processes alive; a
container restart restarts the server and restores the session layout, and
agents with installed integrations resume natively
(`[session] resume_agents_on_restore`, on by default). Live pane processes
do not survive a full container stop — same as any Herdr server restart.

## Updating

Herdr is baked into the image (pinned + sha256-verified). App updates ship
new Herdr versions through the Umbrel store update flow — do **not** run
`herdr update` inside the container (the binary is root-owned; and an
in-place update would be lost on the next container rebuild anyway).

## Security notes

- **Port 7682 is a shell into this container**, and Docker publishes it on
  every host interface — its DNAT rules sit in front of host firewalls, so
  treat it as reachable from your whole LAN, not just the tailnet. That is an
  acceptable posture only because there is nothing to guess: key auth only,
  `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers node`, and
  sshd refuses to start without an authorized key. **Never forward 7682 on
  your router.** Reach it over **Tailscale**.
- The blast radius of a lost phone key is this container: agents, `/data`,
  your API keys and git credentials. Not the Umbrel host — that's the whole
  reason SSH lives in here rather than being a `docker exec` wrapper on the
  host, which would need the `umbrel` user in the `docker` group
  (root-equivalent on the box).
- sshd runs as the unprivileged runtime user (UID 1000) on an unprivileged
  port, so no root daemon survives startup. TCP forwarding, X11 forwarding and
  tunnelling are off; agent forwarding is left on so you can push to git from
  an agent pane without copying a private key onto the box.
- Port 7681 serves a **status page only** — no terminal, no input, no
  WebSocket — behind Umbrel's app-proxy auth and never published. This app
  ships no browser shell at all, which is the point: a web terminal would put
  full access to your keys and repos behind one password.
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

# SSH path (7682 is bound to 127.0.0.1 in dev). Authorise a key first:
docker compose -f docker-compose.local.yml exec server \
    sh -c 'cat >> /data/.ssh/authorized_keys' < ~/.ssh/id_ed25519.pub
docker compose -f docker-compose.local.yml restart
ssh -p 7682 node@127.0.0.1 herdr
```

State lands in the `herdr-local-data` named volume (a bind mount is
deliberately not used: macOS Docker Desktop bind mounts can't host the Unix
sockets herdr's server needs). Reset with
`docker compose -f docker-compose.local.yml down -v`.

## Repo layout

This app lives in the [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps)
community store repo as `zot24-herdr/`:

```
server/Dockerfile        # node:22-bookworm-slim + herdr (pinned sha256) + sshd + mosh
server/entrypoint.sh     # chown /data, seed config, set up sshd, start status page + herdr server
server/status.js         # read-only status page for the app tile (port 7681)
docker-compose.yml       # Umbrel production compose (app_proxy + server, publishes 7682)
docker-compose.local.yml # local dev (build from source, publishes 7681 + 7682)
umbrel-app.yml           # Umbrel app manifest (manifestVersion 1.1)
exports.sh               # APP_ZOT24_HERDR_IP / _PORT / _SSH_PORT for sibling apps
../../.github/workflows/build-herdr.yml  # multi-arch build + digest pin-back
```
