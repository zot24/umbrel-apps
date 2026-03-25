# Hermes Setup & Status Server for Umbrel
# Lightweight Node.js server for first-run setup wizard and status dashboard

FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY server.js wizard.html status.html ./

EXPOSE 8080

CMD ["node", "server.js"]
