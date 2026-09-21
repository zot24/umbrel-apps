# Dockyard

A sandboxed Docker host on your Umbrel — an isolated place to deploy and run
containers, kept separate from the host's Docker and your other apps.

## Why it's isolated the way it is

Dockyard runs a Docker daemon in **its own network namespace**. That keeps it
walled off from the host, and — unlike Umbrel's built-in Docker-in-Docker,
which runs in **host network mode** — it lets the containers you run here
network with each other normally. Host-mode nesting makes two Docker daemons
share one firewall ruleset and clobber each other's rules, so
container-to-container traffic is dropped. Dockyard is that idea done right.

## The status page

Opening the app tile shows a small status page: whether Dockyard's daemon is
healthy, how many containers are running, and what they are. It reads the
nested daemon's socket read-only — it can't start, stop, or change anything.

## Managing it

Drive the daemon however you like:

- **Komodo** — Dockyard includes a Komodo Periphery agent, so if you run
  Komodo, add Dockyard as a server (`https://zot24-dockyard_periphery_1:8120`)
  with this app's per-install passkey (file `passkey` in the app data dir)
  and deploy straight to it. The Umbrel tile on port 8120 is the status
  page, not Periphery. Do not point Komodo at `umbrel.local:8120`.
- **Directly** — the daemon's socket lives at
  `<app-data>/data/dind/docker.sock`. Use it from the Docker CLI over SSH
  (`docker -H unix://…`), or mount it into another tool.

## Reaching what you deploy

Publish a port from your stack; it binds on Dockyard's own container, which is
on the Umbrel network. Point a Cloudflare Tunnel (or another app) at
`zot24-dockyard_dind_1:<port>`.
