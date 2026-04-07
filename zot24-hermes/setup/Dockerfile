# Hermes Setup & Dashboard Server for Umbrel
# Lightweight Node.js server for first-run setup wizard and dashboard

FROM node:20-alpine

RUN apk add --no-cache curl python3 make g++

WORKDIR /app

RUN npm init -y && npm install qrcode@1.5.4 better-sqlite3@11.9.1

COPY server.js wizard.html dashboard.html atlas.html ./
COPY avatars/ ./avatars/

EXPOSE 8080

CMD ["node", "server.js"]
