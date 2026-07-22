# syntax=docker/dockerfile:1

# Herdr Umbrel app image.
#
# Ships:
#   - herdr v0.7.5 (pinned release binary, sha256-verified per arch)
#   - ttyd web terminal (the Umbrel app UI, behind Umbrel's app proxy auth)
#   - agent-bridge (internal HTTP API on :7682 for sibling apps — NOT proxied)
#   - mosh + openssh-client (documented phone attach path, see README)
#   - Node.js 22 + npm (agent CLIs install into the persistent /data volume)
#   - git, curl, gh (GitHub CLI for agent workflows inside the box)
#
# Multi-arch: built with docker buildx for linux/amd64 + linux/arm64;
# TARGETARCH selects the matching pinned herdr binary.

FROM node:22-bookworm-slim

ARG HERDR_VERSION=0.7.5
# herdr releases don't publish checksums. These were computed from the
# v0.7.5 release assets on 2026-07-21 (see BUILD-REPORT.md); bump them
# together with HERDR_VERSION.
ARG HERDR_SHA256_X86_64=3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253
ARG HERDR_SHA256_AARCH64=32e763a1499a6b694b1d708e4f062b743be1da9f34fcfa4d212d6db6fe09a8b9

# ttyd is not in the Debian bookworm repos, so pin the upstream static
# binary instead. Hashes verified against the release's SHA256SUMS file.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

# GitHub CLI — install from official apt repo (bookworm).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        gosu \
        mosh \
        openssh-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

# Pinned herdr + ttyd binaries, each verified against the recorded sha256
# for the arch.
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64)  arch=x86_64;  herdr_sha="$HERDR_SHA256_X86_64"; ttyd_sha="$TTYD_SHA256_X86_64" ;; \
        arm64)  arch=aarch64; herdr_sha="$HERDR_SHA256_AARCH64"; ttyd_sha="$TTYD_SHA256_AARCH64" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/herdr \
        "https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${arch}"; \
    echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum -c -; \
    curl -fsSL -o /usr/local/bin/ttyd \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${arch}"; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod +x /usr/local/bin/herdr /usr/local/bin/ttyd; \
    herdr --version; \
    ttyd --version

COPY entrypoint.sh /entrypoint.sh
COPY agent-bridge.mjs bootstrap-agents.sh /usr/local/lib/herdr-umbrel/
RUN chmod +x /entrypoint.sh /usr/local/lib/herdr-umbrel/bootstrap-agents.sh \
    && chmod 644 /usr/local/lib/herdr-umbrel/agent-bridge.mjs

# HOME must live on the Umbrel-managed volume so ~/.config/herdr (config,
# socket, session state, logs), npm-global agent CLIs, and workspaces all
# persist across container rebuilds and app updates.
#
# ENV alone is not enough: gosu sets HOME from the target user's passwd entry
# when dropping privileges, so point the node user's passwd home at /data as
# well. That also covers any tool that resolves home via getpwuid instead of
# $HOME.
RUN usermod --home /data node
ENV HOME=/data \
    NPM_CONFIG_PREFIX=/data/.npm-global \
    PATH="/data/.npm-global/bin:/data/.grok/bin:/data/.local/bin:/data/.kimi/bin:${PATH}" \
    LANG=C.UTF-8 \
    TERM=xterm-256color \
    HERDR_AGENT_PORT=7682

EXPOSE 7681 7682

# The base image's unprivileged `node` user (UID 1000) is the runtime user.
# We still start as root so the entrypoint can chown the Umbrel-mounted /data
# volume; it drops to `node` via gosu before starting anything.
ENTRYPOINT ["/entrypoint.sh"]
