# syntax=docker/dockerfile:1
#
# Umbrel packaging of Proton Mail Bridge.
# Runtime base is shenxn/protonmail-bridge (unofficial Docker of Proton's
# GPL-3.0 bridge, built from source — amd64 + arm64). We add ttyd so the
# Umbrel tile is an operator console behind app_proxy auth.
#
# Do not publish IMAP/SMTP or ttyd to the public internet.

FROM shenxn/protonmail-bridge:3.26.0-build

# ttyd is not in Debian sid-slim. Pin the upstream static binary.
# Hashes verified against tsl0922/ttyd 1.7.7 SHA256SUMS (same pins as zot24-herdr).
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

ARG TARGETARCH
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates procps; \
    rm -rf /var/lib/apt/lists/*; \
    case "$TARGETARCH" in \
        amd64)  arch=x86_64;  ttyd_sha="$TTYD_SHA256_X86_64" ;; \
        arm64)  arch=aarch64; ttyd_sha="$TTYD_SHA256_AARCH64" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${arch}"; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod +x /usr/local/bin/ttyd; \
    ttyd --version

COPY daemon.sh /usr/local/lib/bridge-daemon.sh
COPY entrypoint.sh /umbrel-entrypoint.sh
COPY console.sh /usr/local/bin/bridge-console
COPY login-cli status restart info-hint /usr/local/bin/

RUN chmod +x /umbrel-entrypoint.sh \
        /usr/local/bin/bridge-console \
        /usr/local/bin/login-cli \
        /usr/local/bin/status \
        /usr/local/bin/restart \
        /usr/local/bin/info-hint \
    && chmod 644 /usr/local/lib/bridge-daemon.sh

ENV HOME=/root \
    LANG=C.UTF-8 \
    TERM=xterm-256color

EXPOSE 7681 25 143

ENTRYPOINT ["/umbrel-entrypoint.sh"]
