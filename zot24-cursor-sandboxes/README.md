# Cursor Sandboxes

Self-hosted machines for [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent/self-hosted),
running on an Umbrel. Cursor keeps the agent loop and the model in its cloud; each sandbox
executes the agent's tool calls (file edits, terminal commands, local MCP servers) against
its own clones of your repositories.

- **App ID**: `zot24-cursor-sandboxes`
- **Port**: 7690 (manager UI, behind Umbrel login)
- **Cursor plan**: any. Sandboxes are personal [My Machines](https://cursor.com/docs/cloud-agent/self-hosted/my-machines)
  workers and sign in with your user API key. Team Pools (Enterprise, service account) are not used.

## How it fits together

```
Umbrel
└── zot24-cursor-sandboxes
    ├── manager   ghcr.io/zot24/cursor-sandboxes-manager (tile UI + reconciler)
    │              state: data/manager/state.json (keys, sandbox list), mode 0600
    └── dind      private Docker daemon, own network namespace, not on the Umbrel network
         ├── cs-<name>   one container per sandbox, image = SANDBOX_IMAGE
         │    └── agent worker --name <name> --worker-dir ~/work/<repo>... start
         └── cs-<name>-home   that sandbox's /home/agent volume (checkouts, caches, tools)
```

- The manager keeps the sandbox containers in step with `state.json`: a sandbox whose config
  changed (new key, edited repos, new image after an app update) is recreated. Its home volume
  is kept.
- Sandboxes sit on a bridge network with inter-container traffic disabled: they reach the
  internet, not each other, the Umbrel host's Docker, or other apps.
- Workers only make outbound HTTPS connections (`api2.cursor.sh`, `api2direct.cursor.sh`,
  `downloads.cursor.com`, the artifacts S3 bucket). Nothing is exposed.
- Status comes from each worker's management server (`--management-addr 127.0.0.1:9090`):
  `/healthz` backs the container healthcheck, `/metrics` gives connection, active sessions and
  last activity.

## Using it

1. Open the tile, paste a personal API key (Cursor Dashboard → API Keys). The manager checks it
   against `GET https://api.cursor.com/v1/me` before saving; team and service-account keys are
   refused because My Machines needs a user key.
2. Optional: a GitHub token for private repos and pushing branches. Use a fine-grained token
   limited to the repos you put in sandboxes (see Security).
3. Create a sandbox: a name and 1-20 repositories (`owner/repo`, an `https://` URL, or a
   `git@github.com:` URL, optionally followed by a branch). Each repo is cloned into
   `/home/agent/work/<repo>`. A later edit follows a new branch or URL when the checkout
   is clean. Local changes are kept, and they stop the worker until you commit or discard them.
4. Send it work:
   - Cursor app: pick the sandbox in the Cloud Agent machine picker.
   - Slack: `@Cursor worker=<name> fix the flaky test`
   - GitHub: `@cursoragent worker=<name> ...`
   - Linear: `worker=<name>` in the issue body.

   Cursor only routes to a machine whose registered repos (the git remotes of its worker
   directories) include the request's target repo.

Per-sandbox options:

- **Docker access** mounts the private daemon's socket. That daemon runs in a privileged
  container, so this is root on the Umbrel: an agent can start a privileged container and
  mount the host disks. It can also see and control the other sandboxes. Leave it off.
- **Connect workspace** passes `--connect-workspace`, so the Cursor app can open an agent's live
  workspace (files, terminal, ports).

## Security notes

- Agents run as `agent` with passwordless sudo, inside their sandbox. They can read the
  sandbox's environment, which holds your Cursor API key and GitHub token. Scope the GitHub
  token to the sandboxed repos.
- The GitHub token reaches git through a credential helper that reads `$GH_TOKEN` at call
  time; it is never written to `~/.gitconfig`.
- The manager listens on the Umbrel app network, because that is how the tile reaches it:
  browser → `zot24-cursor-sandboxes_app_proxy_1` (Umbrel login) → manager. It accepts
  connections only from that proxy (resolved by name, `APP_PROXY_HOST`), the Docker bridge
  gateway (the Umbrel host) and loopback (its own healthcheck). Another app cannot call the API. Writes also
  require `X-CS-Request`, which a browser page on another origin cannot send. Do not expose
  port 7690 publicly.
- `dind` is on a private bridge, not `umbrel_main_network`, so a port published inside the
  private daemon is not reachable by other apps.

## Data

| Path (under the app data dir) | What |
|---|---|
| `data/manager/state.json` | Credentials + sandbox definitions (0600) |
| `data/dind/` | The private daemon's storage: images, containers, every sandbox's home volume |
| `data/sock/docker.sock` | The private daemon's socket (shared by dind and manager) |

## Images and updates

- `sandbox/` builds `ghcr.io/zot24/cursor-sandbox-umbrel` and `manager/` builds
  `ghcr.io/zot24/cursor-sandboxes-manager` (linux/amd64 + linux/arm64) via
  `.github/workflows/build-cursor-sandboxes.yml`, which pins both digests into
  `docker-compose.yml`. Both GHCR packages must be **public**: the Umbrel pulls them
  without credentials. New packages are private until that workflow (or you) flips them.
  The app will not install until those digest pins are on `main`.
- The manager used to be a bind-mounted `server.mjs`. Umbrel updates do not copy that
  file, so the code is in the image instead. Local dev still bind-mounts it.
- The Cursor CLI is pinned (`ARG CURSOR_AGENT_VERSION`) and installed under `/opt`, outside the
  home volume, so it never drifts at runtime. `ci/update-cursor-cli.sh` + `ci/update-cursor-cli.yml`
  check `https://cursor.com/install` weekly and open a PR that bumps the pin and the app's patch
  version. Copy the workflow into `.github/workflows/` to activate it (see `zot24-herdr/ci/README.md`
  for why it lives here).
- An app update recreates every sandbox on the new image. Home volumes (checkouts, `npm -g`
  installs, caches) survive; apt-installed packages do not.

## Local development

```
docker build -t cursor-sandbox-umbrel:dev sandbox
docker compose -f docker-compose.local.yml up -d
docker save cursor-sandbox-umbrel:dev \
  | docker compose -f docker-compose.local.yml exec -T dind docker -H unix:///sock/docker.sock load
open http://localhost:7690
```

The manager restarts on edits to `manager/server.mjs` (`node --watch`); if a change is missed
on a macOS bind mount, `docker compose -f docker-compose.local.yml restart manager`.

Not in v1: Team Pools / per-session disposable sandboxes (Enterprise), computer use (Linux
desktop over VNC).
