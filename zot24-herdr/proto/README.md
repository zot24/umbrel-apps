# herdr setup wizard — local prototype

**Local test only. Not shippable, not installed on any Umbrel, not on `main`.**

```bash
cd zot24-herdr/proto
./run.sh
```

Then open <http://127.0.0.1:7681>.

| Command | What it does |
| --- | --- |
| `./run.sh` | build + start, wait for health, print the URL |
| `./run.sh reset` | wipe the scratch data dir → back to the first-run wizard |
| `./run.sh test` | drive the wizard headlessly + run the WebSocket auth probes |
| `./run.sh logs` | follow container logs |
| `./run.sh stop` | stop and remove the container |

## Use fake credentials only

Nothing authenticates this page: there is no Umbrel app proxy in front of it,
which is the entire auth boundary in the real design. It binds `127.0.0.1` and
writes to `./scratch-data`, which is gitignored. Use obviously-fake placeholders
like `sk-ant-FAKE-do-not-use`.

## Shape

- `server.js` — HTTP + the WebSocket PTY. **Never a shell**: `WIZARD_ARGV` is a
  module-scope constant and no request data reaches it.
- `herdr-setup` — the wizard. The only thing the PTY ever execs.
- `lib/state.js` — derived "is this configured?" plus the tool/credential
  inventory. No sentinel file.
- `lib/envfile.js` — merge-write `/data/.env` atomically at `0600`, preserving
  comments and unknown keys.
- `lib/pages.js` — server-rendered HTML. No CDN; xterm.js is vendored from
  `node_modules` at build time.
- `catalog.json` — the credential and tool catalogue both halves read.

Full write-up: `reports/2026-07-28/HERDR-WIZARD-PROTOTYPE.md`.
Design rationale and the Hermes prior art it follows:
`reports/2026-07-27/HERDR-SETUP-PAGE.md`.
