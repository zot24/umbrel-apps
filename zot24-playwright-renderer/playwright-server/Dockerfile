FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install only runtime deps; the Playwright base image already ships Chromium.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3030

EXPOSE 3030

# Run as the unprivileged user the Playwright image ships with.
USER pwuser

CMD ["node", "server.js"]
