# syntax=docker/dockerfile:1

# Herdr Umbrel app image.
#
# Ships:
#   - herdr v0.7.5 (pinned release binary, sha256-verified per arch)
#   - openssh-server (key-only SSH straight into the app: Moshi on a phone,
#     `herdr --remote` from a laptop — no shell on the Umbrel host needed)
#   - status.js, a read-only status page for the Umbrel app tile. Umbrel
#     requires every app to answer on a port; this app deliberately has no
#     browser terminal, so the tile shows how to attach instead.
#   - mosh + openssh-client (outbound, plus mosh-server for flaky mobile links)
#   - Node.js LTS + npm (agent CLIs install into the persistent /data volume)
#   - git, curl
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

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gosu \
        mosh \
        openssh-client \
        openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    # Debian's package starts sshd at boot from its own config and host keys in
    # /etc/ssh. We want neither: the entrypoint runs sshd as the unprivileged
    # runtime user with a generated config and host keys that persist on the
    # app data volume. Drop the packaged host keys so there is no chance of
    # serving an image-baked (i.e. shared-with-every-installation) key.
    && rm -f /etc/ssh/ssh_host_*

# Pinned herdr binary, verified against the recorded sha256 for the arch.
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64)  arch=x86_64;  herdr_sha="$HERDR_SHA256_X86_64" ;; \
        arm64)  arch=aarch64; herdr_sha="$HERDR_SHA256_AARCH64" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/herdr \
        "https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${arch}"; \
    echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum -c -; \
    chmod +x /usr/local/bin/herdr; \
    herdr --version

COPY entrypoint.sh /entrypoint.sh
COPY status.js /usr/local/lib/herdr-status.js
RUN chmod +x /entrypoint.sh

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
    PATH="/data/.npm-global/bin:${PATH}" \
    LANG=C.UTF-8 \
    TERM=xterm-256color

# 7681: status page (via Umbrel's app proxy — the app tile). 7682: sshd,
# published on the host by docker-compose.yml, see APP_ZOT24_HERDR_SSH_PORT
# in exports.sh. The way in is 7682; 7681 only tells you that.
EXPOSE 7681 7682

# The base image's unprivileged `node` user (UID 1000) is the runtime user.
# We still start as root so the entrypoint can chown the Umbrel-mounted /data
# volume; it drops to `node` via gosu before starting anything.
ENTRYPOINT ["/entrypoint.sh"]
