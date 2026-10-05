# Manager image. Umbrel only copies a whitelist of files on app update
# (docker-compose.yml, exports.sh, hooks, umbrel-app.yml), so server.mjs
# cannot live as a bind mount: a bugfix would never reach an installed box.
# This image is what an update actually ships.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app
COPY server.mjs index.html ./

EXPOSE 7690
CMD ["node", "/app/server.mjs"]
