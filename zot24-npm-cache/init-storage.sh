#!/bin/sh
# The official image runs as uid 10001, which cannot write a host
# directory owned by the Umbrel user. Start as root, fix ownership,
# then drop to 10001. No compose $vars in this file: Umbrel would
# interpolate them.
set -e
mkdir -p /verdaccio/storage/data /verdaccio/plugins
chown -R 10001:65533 /verdaccio/storage /verdaccio/plugins
exec setpriv --reuid=10001 --regid=65533 --init-groups -- \
  verdaccio --config /verdaccio/conf/config.yaml --listen http://0.0.0.0:4873
