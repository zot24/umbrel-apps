# npm Cache (zot24-npm-cache)

A cache-only npm registry for an Umbrel, using official Verdaccio
as a proxy in front of registry.npmjs.org.

- App id: `zot24-npm-cache`
- Host port: 25751
- Image: `verdaccio/verdaccio:7.1.0@sha256:c1b1b86154b43a4e1861bc7a4496d4977aa43c8bdb5db49b68445f8a9273729f`
- Remote: `https://registry.npmjs.org/`
- Access: anyone can install. Nobody can publish or unpublish.
  User signup is disabled.

The first install of a package is fetched from npm and stored under
the app data directory. Later installs of the same package are
served from that copy.

## Point npm or pnpm at the cache

Replace `<umbrel-host>` with the Umbrel's LAN or Tailscale address.
Do not use the Umbrel tile URL. It is the web UI, behind the
dashboard login.

In the project (or your user) `.npmrc`:

```
registry=http://<umbrel-host>:25751
```

pnpm reads the same `.npmrc` `registry=` line. You can also run
`pnpm config set registry http://<umbrel-host>:25751`.

Sibling containers on the Umbrel should use
`http://npm-cache:4873` instead of the host port.

## If the Umbrel is down

npm and pnpm do not fall back to registry.npmjs.org. Installs fail
until you remove the `registry=` line, or override it for one
command:

```
npm install --registry https://registry.npmjs.org
pnpm install --registry https://registry.npmjs.org
```

## What this is not

- Not a private package host. Publishing is rejected for everyone.
- Not published to the public internet. Do not add a Cloudflare
  Tunnel hostname for it.
