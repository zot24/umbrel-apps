# syntax=docker/dockerfile:1

# LOCAL PROTOTYPE image for the herdr setup wizard + status dashboard.
#
# Mirrors zot24-herdr/server/Dockerfile where it matters (node:22-bookworm-slim,
# HOME=/data, npm-global on the volume, pinned herdr binary) and diverges where
# a prototype is allowed to: no sshd, no mosh, and a builder stage for node-pty.
#
# node-pty is a native module, so the real image would need this two-stage build
# for linux/amd64 + linux/arm64. That is the single largest new build cost this
# design adds — see the report.

FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund


FROM node:22-bookworm-slim

ARG HERDR_VERSION=0.7.5
# Same pins as zot24-herdr/server/Dockerfile — the prototype runs a real herdr
# server so the sessions table on the dashboard is not faked.
ARG HERDR_SHA256_X86_64=3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253
ARG HERDR_SHA256_AARCH64=32e763a1499a6b694b1d708e4f062b743be1da9f34fcfa4d212d6db6fe09a8b9

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gosu \
    && rm -rf /var/lib/apt/lists/*

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

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY server.js herdr-setup catalog.json ./
COPY lib ./lib
RUN chmod +x /app/herdr-setup

# Vendor the terminal front-end out of node_modules at build time. No CDN, no
# runtime fetch — the app ships no external assets and must not gain any.
RUN mkdir -p /app/assets \
    && cp node_modules/@xterm/xterm/lib/xterm.js /app/assets/xterm.js \
    && cp node_modules/@xterm/xterm/css/xterm.css /app/assets/xterm.css \
    && cp node_modules/@xterm/addon-fit/lib/addon-fit.js /app/assets/addon-fit.js \
    && cp node_modules/@xterm/addon-web-links/lib/addon-web-links.js /app/assets/addon-web-links.js

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN usermod --home /data node
ENV HOME=/data \
    NPM_CONFIG_PREFIX=/data/.npm-global \
    PATH="/data/.npm-global/bin:${PATH}" \
    LANG=C.UTF-8 \
    TERM=xterm-256color

EXPOSE 7681
ENTRYPOINT ["/entrypoint.sh"]
