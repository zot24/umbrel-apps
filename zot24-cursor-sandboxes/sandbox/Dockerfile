# Cursor Sandboxes — the image every sandbox runs.
#
# One sandbox = one container in the app's private Docker daemon, running a
# personal "My Machines" worker: `agent worker --name <sandbox> start`. Cursor
# runs the agent loop in its cloud; this container executes the tool calls
# (file edits, terminal commands, local MCP servers) against the repos cloned
# into /home/agent/work.
#
# Built for linux/amd64 + linux/arm64 by .github/workflows/build-cursor-sandboxes.yml,
# which pins the digest into ../docker-compose.yml (SANDBOX_IMAGE). The manager
# pulls that exact digest into the nested daemon.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ARG TARGETARCH
# Cursor CLI build. ci/update-cursor-cli.sh rewrites this line when
# https://cursor.com/install points at a newer build.
ARG CURSOR_AGENT_VERSION=2026.10.01-e373342
ARG GH_VERSION=2.102.0
ARG DOCKER_CLI_VERSION=28.5.2

# A general-purpose dev toolchain: agents build, test and lint here. Anything
# else can be installed per sandbox with sudo (lost on image updates) or into
# $HOME (kept — it is the sandbox's volume).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git git-lfs openssh-client gnupg \
      jq ripgrep fd-find less nano procps psmisc lsof iproute2 \
      unzip zip xz-utils bzip2 file sudo \
      build-essential pkg-config \
      python3 python3-venv python3-pip python3-dev \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Cursor CLI, pinned. Installed outside $HOME on purpose: the sandbox volume
# is mounted over /home/agent and would shadow anything baked in there, and a
# root-owned install cannot drift away from the pinned build at runtime.
RUN set -eux; \
    case "$TARGETARCH" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
    mkdir -p /opt/cursor-agent; \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${a}/agent-cli-package.tar.gz" \
      | tar -xz -C /opt/cursor-agent --strip-components=1; \
    ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
    ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
    test -x /usr/local/bin/agent
# Do not run `agent --version` here. The CLI is a native binary and the
# arm64 build is emulated on the amd64 runner; executing it crashes the
# build (same reason gh and the docker CLI are not executed below).
# The entrypoint prints the version when a sandbox starts.

# GitHub CLI (agents use it for issues/PRs) and the Docker CLI (only useful
# when a sandbox is created with Docker access; the daemon is the app's own).
RUN set -eux; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    case "$TARGETARCH" in amd64) d=x86_64 ;; arm64) d=aarch64 ;; esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${d}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    test -x /usr/local/bin/gh; test -x /usr/local/bin/docker
# (No `--version` runs here: Go binaries crash under cross-arch emulation, so
# executing them would break the emulated half of the multi-arch build.)

# The base image's `node` user (uid 1000) becomes `agent`, with passwordless
# sudo. The sandbox is already fenced off inside the app's private Docker
# daemon, and agents routinely need to apt-get a missing dependency.
RUN usermod -l agent -d /home/agent -m node \
 && groupmod -n agent node \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent \
 && mkdir -p /home/agent/work \
 && chown -R agent:agent /home/agent

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 0755 /usr/local/bin/sandbox-entrypoint

# /usr/local/bin comes before ~/.local/bin so a CLI self-update dropped into
# ~/.local/bin/agent never shadows the pinned build. npm -g installs land in
# ~/.local (the persistent volume) and are still on PATH.
ENV LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/home/agent/.local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/home/agent/.local

WORKDIR /home/agent

# /healthz on the worker's management server tells us whether the worker is
# connected to Cursor. The manager reads this as the sandbox's status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS -o /dev/null --max-time 4 http://127.0.0.1:9090/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
