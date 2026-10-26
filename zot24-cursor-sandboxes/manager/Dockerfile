# Manager image. Umbrel only copies a whitelist of files on app update
# (docker-compose.yml, exports.sh, hooks, umbrel-app.yml), so server.mjs
# cannot live as a bind mount: a bugfix would never reach an installed box.
# This image is what an update actually ships.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

WORKDIR /app
COPY server.mjs index.html ./

EXPOSE 7690
CMD ["node", "/app/server.mjs"]
