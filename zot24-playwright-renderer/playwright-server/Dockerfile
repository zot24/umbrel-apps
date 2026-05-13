FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# gosu lets the entrypoint drop from root → pwuser after fixing /data ownership.
# Umbrel mounts the data volume as root, so we need root briefly at startup.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && gosu nobody true

WORKDIR /app

# Install only runtime deps; the Playwright base image already ships Chromium.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3030

EXPOSE 3030

# Stay as root so entrypoint can chown the Umbrel-mounted /data volume; the
# entrypoint exec's `gosu pwuser` before launching node, so the server itself
# runs unprivileged.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
