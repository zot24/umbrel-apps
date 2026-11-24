# syntax=docker/dockerfile:1

# Headless Orca remote server for Umbrel.
#
# Ships the official Linux server tarball (orcad + its Node + orca-ide),
# not the desktop build. No GTK, X11, or Electron. Agent CLIs install into
# /data/npm-global, which is the persistent volume.
#
# Multi-arch: buildx for linux/amd64 and linux/arm64. TARGETARCH selects
# the matching Orca tarball and ttyd binary. Both are sha256-pinned.

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# https://github.com/stablyai/orca/releases/download/v1.4.272/orca-server-sha256sums.txt
ARG ORCA_VERSION=1.4.272
ARG ORCA_SHA256_AMD64=7d6186b5ece0bf7cd3466e967f7f0b59ac54ccde5060d157b66218a468daf7df
ARG ORCA_SHA256_ARM64=fb0cec993d7427dbcf111ba37a8d552015b42b67c62825d759542d76794e8483

# ttyd is not in Debian bookworm. Hashes match the release SHA256SUMS.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        gosu \
        jq \
        openssh-client \
        python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) ttyd_arch=x86_64; ttyd_sha="$TTYD_SHA256_AMD64" ;; \
        arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_ARM64" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 755 /usr/local/bin/ttyd; \
    ttyd --version

ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) arch=x64; sha="$ORCA_SHA256_AMD64" ;; \
        arm64) arch=arm64; sha="$ORCA_SHA256_ARM64" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/orca-server.tar.gz \
        "https://github.com/stablyai/orca/releases/download/v${ORCA_VERSION}/orca-server-linux-${arch}.tar.gz"; \
    echo "${sha}  /tmp/orca-server.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/orca-server; \
    tar -xzf /tmp/orca-server.tar.gz -C /opt/orca-server --strip-components=1; \
    rm /tmp/orca-server.tar.gz; \
    chmod 755 /opt/orca-server/bin/orca-ide; \
    /opt/orca-server/bin/orca-ide --version

ENV ORCA_VERSION=${ORCA_VERSION} \
    HOME=/data/home \
    ORCA_USER_DATA=/data/orca \
    ORCA_USER_DATA_PATH=/data/orca \
    NPM_CONFIG_PREFIX=/data/npm-global \
    PATH="/opt/orca-server/bin:/data/npm-global/bin:/data/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

COPY lib.mjs gate.mjs /usr/local/lib/orca-umbrel/
COPY web/index.html /usr/local/lib/orca-umbrel/web/index.html
COPY login-shell.sh /usr/local/lib/orca-umbrel/login-shell.sh
COPY entrypoint.sh /usr/local/bin/orca-umbrel-entrypoint
RUN chmod 755 /usr/local/bin/orca-umbrel-entrypoint /usr/local/lib/orca-umbrel/login-shell.sh

ENTRYPOINT ["/usr/local/bin/orca-umbrel-entrypoint"]
