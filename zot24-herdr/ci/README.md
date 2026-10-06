# herdr CI extras

| File | Purpose |
|---|---|
| `update-deps.sh` | Fetch latest stable herdr + ttyd + moshi-hook, rewrite Dockerfile pins, bump VERSION |
| `update-herdr-deps.yml` | Weekly Action: run the script, open PR if pins moved |
| `build-herdr.yml` | Copy of the image build workflow with bootstrap/bridge path filters |

Both workflows are active: they live in `.github/workflows/` as copies of the
YAML here. Edit both copies together. Pushing `.github/workflows/*` needs a
token with `workflow` scope, and the weekly PR needs "Allow GitHub Actions to
create and approve pull requests" enabled in the repo settings.

Volume agent CLIs are **not** pinned in the image. `bootstrap-agents.sh`
installs/upgrades them onto `/data` on every container start when
`HERDR_BOOTSTRAP_AGENTS=1`.
