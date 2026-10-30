# Baked-in cloudflared. This is the binary a new container uses until
# update-bin.sh has a checksum-verified newer one on the data volume.
# The digest is the multi-arch index. update-cloudflared.yml republishes
# our image hourly so a fresh install does not start years behind.
FROM cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba as cloudflared

# take the alpine image
FROM alpine:3.18.4

# curl talks to GitHub for update-bin.sh. nc and killall serve the control
# port. tini forwards stop signals to the tunnel and the update loop.
RUN apk add --update --no-cache tini netcat-openbsd psmisc curl ca-certificates

# copy the connector binary from the cloudflared image
COPY --from=cloudflared /usr/local/bin/cloudflared ./cloudflared

# copy the control scripts
COPY accept.sh default-response process.sh control-loop.sh update-bin.sh ./

# expose the control port
EXPOSE 8018

# make tiny the entrypoint and make it to kill the process group
ENTRYPOINT ["/sbin/tini", "-g", "--"]

# run the control loop
CMD ["sh", "control-loop.sh"]
