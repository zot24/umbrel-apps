# Postgres 17 client tools (and a server for drills), restic, rclone and Node.
FROM postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b

RUN apk add --no-cache nodejs restic rclone tzdata \
 && adduser -D -u 1000 lifeboat \
 && mkdir /data && chown lifeboat:lifeboat /data

ENV TZ=America/Asuncion
WORKDIR /app
COPY lifeboat.mjs lib.mjs server.mjs source.mjs util.mjs index.html ./
RUN chmod +x lifeboat.mjs && ln -s /app/lifeboat.mjs /usr/local/bin/lifeboat

USER lifeboat
STOPSIGNAL SIGTERM
ENTRYPOINT []
EXPOSE 7746
CMD ["lifeboat", "serve"]
