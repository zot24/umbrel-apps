# Dockyard

An isolated Docker host on your Umbrel for [Komodo](https://komo.do) to deploy
into. Komodo is the control panel; Dockyard is where the workloads run.

## Why it exists

Umbrel's stock Komodo app runs its bundled Docker-in-Docker in **host network
mode**, so two Docker daemons share one firewall ruleset and fight over it —
containers Komodo deploys there can't reach each other. Dockyard runs the
nested daemon in **its own network namespace**, so Docker networking works
normally, while staying fully isolated from the host's Docker and your other
Umbrel apps.

## How it fits together

```
Komodo (control panel)  ──HTTPS──▶  Dockyard periphery  ──socket──▶  nested dockerd
                                                                     └─ your stacks
```

Add Dockyard to Komodo as a server (address `https://zot24-dockyard_periphery_1:8120`),
using this app's per-install passkey. Deploy stacks onto it from Komodo.

## Reaching a deployed app

A stack publishes a port; that port binds on Dockyard's own container, which
is on the Umbrel network. Point a Cloudflare Tunnel (or another app) at
`zot24-dockyard_dind_1:<port>`.

## Wiring the passkey

Komodo Core must present a passkey this agent accepts. This app's passkey is
its Umbrel `APP_SEED`. Add that same value to your Komodo Core's
`KOMODO_PASSKEYS` and restart Core, then add the server in the Komodo UI.
