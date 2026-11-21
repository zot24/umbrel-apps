# Herdr for Umbrel

An [Umbrel](https://umbrel.com) app that runs
[herdr-core](https://herdr.dev/core/), the runtime behind the
[Herdr](https://herdr.dev) desktop and phone apps, as an always-on machine
on your Umbrel box. Your agents (Claude Code, Codex, Grok, Kimi, …) keep
running 24/7 on home hardware; you attach from the Herdr apps, Moshi, or a
browser, and everything is where you left it.

- **App ID**: `zot24-herdr`
- **Ports**: 7681 web terminal (behind Umbrel auth, never published) · 7683
  SSH (published, key-only)
- **Upstream**: [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core)
  (`hc`) v0.1.21, Apache-2.0

## How it's wired

```
  laptop / phone / browser
        |
        |  (a) Herdr desktop app, over SSH (7683)   — machine in its sidebar
        |  (b) Herdr phone app or Moshi, over SSH   — phone
        |  (c) Umbrel app proxy (Umbrel login)      — web terminal
        |  (d) plain ssh (7683)                     — hc picker, then a shell
        v
  zot24-herdr_server_1 container
    ├── herdr-core (hc)             (headless; owns every terminal and agent)
    ├── ttyd :7684 ──► hc picker    (behind web-gate :7681)
    ├── sshd :7683                  (key-only; the Herdr apps run `herdr-core connect`)
    └── moshi-hook                  (Moshi pairing, approvals, session picker)
              └── /data volume: herdr-core state, agent CLIs, workspaces, keys
```

herdr-core runs headless in the container and owns every terminal. Every
client only attaches and detaches; closing all of them leaves every agent
running. The desktop app, the phone app, Moshi, the web terminal and plain
SSH all see the same terminals.

Up to 0.10.x the app also ran the Herdr TUI (`herdr`), a separate runtime
that did not share terminals with herdr-core. 0.11.0 dropped it: upstream's
work is on herdr-core, and every Herdr client now uses it.

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

Every client except the web terminal comes in over the app's own sshd on
**7683** (published on the host), as user `node`, with a key. You connect to
the container, not to the Umbrel host, so your user does not need to be in
the `docker` group. Put the Umbrel and your devices on the same tailnet
(install the Tailscale Umbrel app); do **not** port-forward anything on your
router.

### Adding a key

- **Phone (Moshi):** Easy Pair on the web setup page (Umbrel tile → tile
  password → **Pair phone**): enter a Tailscale/LAN hostname the phone can
  reach, Generate QR, scan it in the Moshi app. Do not screenshot the QR.
  sshd is already running; the scan writes the first key and no restart is
  needed.
- **Any other device:** paste its public key on the same page (**Edit
  keys**), or drop it on disk:

  ```bash
  # (i) drop it in the app's data dir, from a host shell
  mkdir -p ~/umbrel/app-data/zot24-herdr/data/.ssh
  chmod 700 ~/umbrel/app-data/zot24-herdr/data/.ssh
  echo "ssh-ed25519 AAAA… laptop" >> ~/umbrel/app-data/zot24-herdr/data/.ssh/authorized_keys
  chmod 600 ~/umbrel/app-data/zot24-herdr/data/.ssh/authorized_keys

  # (ii) or via the .env the app already reads (';' between keys), then restart
  #   …/zot24-herdr/data/.env
  #   SSH_AUTHORIZED_KEYS=ssh-ed25519 AAAA… phone;ssh-ed25519 AAAA… laptop
  ```

Empty keys + no passwords = nobody can log in. sshd stays up so Easy Pair
can land the first key.

### (a) Desktop app — the Umbrel as a Herdr machine

The [Herdr desktop app](https://herdr.dev) (macOS, Linux, Windows) adds other
computers as machines over SSH, and this app's sshd on 7683 is that door.
Terminals on the Umbrel machine run in the container's herdr-core, so agents
keep working while your laptop sleeps.

1. Add your computer's public key (above).
2. Add a host to `~/.ssh/config` on that computer. The setup page's Ready
   screen shows this entry with your hostname filled in:

   ```
   Host umbrel-herdr
       HostName your-umbrel
       User node
       Port 7683
   ```

3. In Herdr, choose **Add machine** and pick `umbrel-herdr`. From a shell,
   `hc machine add umbrel-herdr --name umbrel` does the same.

The image ships herdr-core, so the app finds it and does not offer to copy
one over. Update the Umbrel app to update it; `hc machine update` against
this box only lasts until the next app restart, which goes back to the
image's copy. New terminals start a login bash, so they get the same `PATH`
and `/data/.env` keys as an SSH session. An app update or restart stops
the programs in them; the desktop app's panes come back with a fresh shell
in their last folder, as after a reboot of any Herdr machine.

Spaces belong to the desktop app's window, not the core: the desktop app
shows its spaces for this machine, while the phone app, Moshi and the web
terminal see the terminals without them.

### (b) Phone — the Herdr app or Moshi

- **[Herdr phone app](https://herdr.dev/mobile)** (iPhone, iPad, Android):
  add this machine over SSH like the desktop app (host, port 7683, user
  `node`, a key). It needs nothing else on the box and shows the same
  terminals and agents, with an inbox of agents that need you.
- **[Moshi](https://getmoshi.app)**: pair with Easy Pair (above). Moshi lists
  this machine's herdr-core terminals in its session picker through
  moshi-hook, which the image ships (0.4.62; Moshi needs 0.4.45 or newer)
  and runs as a daemon. Check from an SSH session with
  `moshi-hook mux ls --json` and `moshi-hook doctor`.

For Mosh (survives sleep/network switches): install `mosh` on the **host OS**
(`sudo apt install mosh`; the container's copy is for outbound use) and allow
UDP 60000–61000 **on the tailnet only**. Mosh replaces SSH as transport;
herdr-core still owns persistence. Moshi does not scroll herdr-core
terminals over Mosh; use SSH for scrollback.

### (c) Web terminal — the app UI

Open the Herdr tile in the Umbrel dashboard; Umbrel's app proxy enforces your
Umbrel login, then the tile password. **Open terminal** starts herdr-core's
terminal picker (`hc`) in the browser: attach to any terminal the Herdr apps
run here, or pick **new…** to start one in the core. `ctrl+\` detaches and
leaves a plain shell, where `hc` opens the picker again. Closing the tab
only detaches; terminals keep running.

### (d) Plain SSH

```bash
ssh -p 7683 node@your-umbrel
```

A bare login lands in the same picker, then a shell. An explicit command
still runs, which is how the Herdr apps (`herdr-core connect`) and Moshi
(`moshi-hook mux ls`) reach the box:

```bash
ssh -p 7683 node@your-umbrel hc ls
```

## Signing in (GitHub, Codex, Grok, …)

Easiest: paste keys on the setup page (Umbrel tile → tile password → **Edit
keys**). They land in `/data/.env`, and an SSH login and new terminals pick
them up right away. Terminals started before the save don't; start a new one.

- **GitHub**: a [fine-grained token](https://github.com/settings/personal-access-tokens)
  in the GitHub field is used by `gh` *and* by `git clone/push` over HTTPS,
  so no `gh auth login` is needed.
- **Grok**: an xAI API key from [console.x.ai](https://console.x.ai) in the
  Grok field (`XAI_API_KEY`).
- **Codex**: an OpenAI API key in the Codex (OpenAI) field (`OPENAI_API_KEY`).
  Codex ignores that variable on its own, so the bootstrap runs
  `codex login --with-api-key` with it on every start. It leaves a ChatGPT
  sign-in alone.

Prefer signing in with your account instead of pasting a key? These CLIs
have a device-code flow that works over SSH. Run it, then open the printed link on
any device and enter the code:

```bash
ssh -t -p 7683 node@your-umbrel grok login --device-auth
ssh -t -p 7683 node@your-umbrel codex login --device-auth   # ChatGPT plan
ssh -t -p 7683 node@your-umbrel gh auth login --web --hostname github.com --git-protocol https
```

An agent that already has SSH access can run these itself and send you the
link and code. Sign-ins persist on the data volume.

### Codex sandbox (bubblewrap)

Codex sandboxes the commands it runs with bubblewrap. The image ships
`/usr/bin/bwrap`, but Docker's default seccomp profile blocks the user
namespaces (and the mount / pivot_root calls inside them) that bwrap needs,
so with this app's default container settings a sandboxed command fails
with:

```
bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.
```

The host kernel is not the problem; the container's seccomp filter is.
Making the sandbox work needs the `server` service to run with:

```yaml
    security_opt:
      - seccomp=unconfined
      - apparmor=unconfined   # Umbrel hosts run Docker's docker-default AppArmor profile, which denies mount
```

`cap_add: [SYS_ADMIN]` is neither needed nor enough (bwrap then fails at
`pivot_root`). This app does not set these by default: they drop the
container's syscall filter and AppArmor profile, which widens what a process
in the container can ask of the host kernel. Without them, run Codex with
its sandbox off (the container is the boundary), e.g.
`codex --sandbox danger-full-access`.

## Setting up agents + platform CLIs

This image is the **credential + CLI home** for coding agents; secrets stay
in `/data/.env`.

### Bundled vs bootstrapped

| Tool | How it lands | Binary |
| --- | --- | --- |
| **gh** (GitHub CLI) | Baked into the image | `gh` |
| **git**, **curl**, **node 22**, **npm** | Baked into the image | — |
| **bubblewrap** (`bwrap`) | Baked into the image (Codex sandbox) | `bwrap` |
| **Claude Code** | Bootstrap / npm | `claude` |
| **Codex** (OpenAI) | Bootstrap / npm `@openai/codex` | `codex` |
| **Grok Build** (xAI) | Bootstrap via `https://x.ai/cli/install.sh` | `grok` |
| **Kimi Code** (Moonshot) | Bootstrap via official script (npm fallback) | `kimi` |
| **Pi** (pi.dev) | Bootstrap / npm `@earendil-works/pi-coding-agent` | `pi` |
| **Vercel CLI** | Bootstrap / npm | `vercel` |
| **Supabase CLI** | Bootstrap / npm | `supabase` |

All bootstrapped tools install onto the **persistent volume**
(`NPM_CONFIG_PREFIX=/data/.npm-global`, Grok under `/data/.grok`, etc.) so
they survive image updates. herdr-core needs no per-agent integration.

### One-shot bootstrap (recommended)

In `/data/.env` (see `data-env.example`):

```bash
HERDR_BOOTSTRAP_AGENTS=1
# HERDR_BOOTSTRAP_TOOLS=all
# # or a subset: claude codex grok kimi pi vercel supabase

ANTHROPIC_API_KEY=…
# XAI_API_KEY=…          # and/or GROK_DEPLOYMENT_KEY=
# MOONSHOT_API_KEY=…     # Kimi
# OPENAI_API_KEY=…       # Codex
GITHUB_TOKEN=…           # also used by gh
# GH_TOKEN=…
GIT_AUTHOR_NAME=…
GIT_AUTHOR_EMAIL=…
# VERCEL_TOKEN=…
# SUPABASE_ACCESS_TOKEN=…
```

Restart the Herdr app. On start, `bootstrap-agents.sh` installs any missing
CLIs. Or run anytime from the web terminal or an SSH session:

```bash
bash /usr/local/lib/herdr-umbrel/bootstrap-agents.sh
# subset:
HERDR_BOOTSTRAP_TOOLS="claude vercel" bash /usr/local/lib/herdr-umbrel/bootstrap-agents.sh
```

### Manual installs (same destinations)

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g vercel
npm install -g supabase
# Kimi (npm fallback; script path is preferred in bootstrap)
npm install -g @moonshot-ai/kimi-code
# Grok
curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/data/.grok/bin HOME=/data bash

```

### Workspaces

```bash
cd /data/workspaces
git clone https://github.com/you/project.git
# or gh repo clone you/project
```

## What persists (and where)

Everything lives under the app data volume mounted at `/data` (which is also
`$HOME` inside the container):

| Path | Contents |
| --- | --- |
| `/data/.local/state/herdr-core/` | herdr-core socket, terminal records, saved screens, machine connections, logs |
| `/data/.config/herdr-core/` | herdr-core `config.toml` and templates |
| `/data/.npm-global/` | npm-installed CLIs (`claude`, `vercel`, `supabase`, …) |
| `/data/.codex/` | Codex auth + config |
| `/data/.grok/` | Grok Build CLI binary + auth |
| `/data/.local/bin/`, `/data/.kimi/` | Kimi / other user-local bins |
| `/data/workspaces/` | your git clones / project dirs |
| `/data/.env` | secrets + git identity + bootstrap flags (compose `env_file`) |
| `/data/.ssh/` | SSH host key + `authorized_keys` (host key generated once, so clients don't see a changed fingerprint after an app update) |
| `/data/.profile` | seeded once: puts agent CLIs on `PATH` and sources `.env` so an SSH login matches the web terminal |

Persistence semantics are herdr-core's own: detach keeps processes alive; a
container restart restarts the core, and the desktop app's terminals come
back as a fresh shell in their last folder. Live processes do not survive a
full container stop.

Installs from 0.10.x or earlier also have `/data/.config/herdr/`, the old
Herdr TUI's config and session state. Nothing reads it any more; delete it
if you like.


## Playwright Renderer

If the Playwright Renderer app is installed, its URL and bearer token arrive
here as `PLAYWRIGHT_RENDERER_URL` and `PLAYWRIGHT_RENDERER_TOKEN`, in the web
terminal, SSH, and Moshi sessions. Agents can render a page with:

```bash
curl -sS -X POST "$PLAYWRIGHT_RENDERER_URL/render" \
  -H "Authorization: Bearer $PLAYWRIGHT_RENDERER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

The token is generated on the renderer's first boot, so restart Herdr once
after installing it. An empty `PLAYWRIGHT_RENDERER_TOKEN` means it is not
installed or has not booted yet.

## Updating

herdr-core is baked into the image (pinned + sha256-verified). App updates
ship new versions through the Umbrel store update flow — do **not** run
`hc update` inside the container, or
`hc machine update` against it (the image's binaries are root-owned; and an
in-place update would be lost on the next container rebuild anyway).

## Security notes

- The web terminal is **full shell access** to the container. It sits behind
  Umbrel's app-proxy auth and publishes no port; keep it that way. Never
  `tailscale funnel` or tunnel it publicly without adding real
  authentication.
- Reach the host over **Tailscale**; don't expose SSH on your router.
- Treat the app data volume like a dev workstation: agent CLIs can read
  everything in `/data`, use your API keys, and push to your git remotes.
- herdr-core has no password of its own: anyone who reaches its socket can
  run commands as `node`. It listens only on a Unix socket inside the
  container; the desktop app reaches it through the same key-only SSH on
  7683. Its saved screens in `/data/.local/state/herdr-core/` can hold
  secrets that were on screen.
- The container runs as an unprivileged user (UID 1000) and needs no
  capabilities beyond the one-shot `/data` chown at startup.

## Local development

```bash
docker compose -f docker-compose.local.yml up --build
# open http://localhost:7681 — no auth in local dev; bind to localhost only
```

State lands in the `herdr-local-data` named volume (a bind mount is
deliberately not used: macOS Docker Desktop bind mounts can't host the Unix
sockets herdr-core needs). Reset with
`docker compose -f docker-compose.local.yml down -v`.

## Repo layout

This app lives in the [zot24/umbrel-apps](https://github.com/zot24/umbrel-apps)
community store repo as `zot24-herdr/`:

```
server/Dockerfile        # node:22-bookworm-slim + herdr-core + moshi-hook (pinned sha256) + ttyd + mosh + bwrap
server/entrypoint.sh     # chown /data, seed config, start herdr-core + sshd + moshi-hook + ttyd
server/attach-shell.sh   # web terminal + interactive SSH: hc picker, then a login shell
server/ssh-login.sh      # sshd ForceCommand: runs explicit commands, else attach-shell.sh
server/login-shell.sh    # $SHELL for herdr-core terminals (login bash)
docker-compose.yml       # Umbrel production compose (app_proxy + server)
docker-compose.local.yml # local dev (build from source, publishes 7681)
umbrel-app.yml           # Umbrel app manifest (manifestVersion 1.1)
exports.sh               # APP_ZOT24_HERDR_IP / _PORT for sibling apps
../../.github/workflows/build-herdr.yml  # multi-arch build + digest pin-back
```
