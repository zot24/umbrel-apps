# herdr CI extras

`workflow` scope is required to push `.github/workflows/*`. Until that exists
on the PAT, keep YAML here.

| File | Purpose |
|---|---|
| `update-deps.sh` | Fetch latest stable herdr + ttyd, rewrite Dockerfile pins, bump VERSION |
| `update-herdr-deps.yml` | Weekly Action: run the script, open PR if pins moved |
| `build-herdr.yml` | Copy of the image build workflow with bootstrap/bridge path filters |

## Activate the updater

1. Copy `update-herdr-deps.yml` → `.github/workflows/update-herdr-deps.yml`
2. Copy `build-herdr.yml` over `.github/workflows/build-herdr.yml` (adds path filters)
3. Or grant the PAT `workflow` scope and let a later PR land them.

Volume agent CLIs are **not** pinned in the image. `bootstrap-agents.sh`
installs/upgrades them onto `/data` on every container start when
`HERDR_BOOTSTRAP_AGENTS=1`.
