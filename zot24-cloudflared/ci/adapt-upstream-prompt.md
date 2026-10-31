Adapt upstream product changes onto this Umbrel app. The deterministic job already classified the diff and wrote `zot24-cloudflared/ci/pending/REPORT.md`.

Read that report and every file in `zot24-cloudflared/ci/pending/`. Port only product behavior that is still unapplied: forked-file diffs, `*.rej` files, and `ci/pending/*.diff`.

Keep these local behaviors. Do not revert them to match upstream:

- The `cloudflare/cloudflared` tag and digest in `connector/Dockerfile`. The hourly job owns that release.
- `connector/update-bin.sh`.
- `APP_ZOT24_CLOUDFLARED_METRICS_PORT` and metrics port 40901.
- The three-cards-per-row route layout in `web/src/routes/+page.svelte` and `web/src/lib/components/TunnelRoute.svelte`.
- The phosphor UI shared with the other zot24 apps: dark ground, Oxanium and Fira Code, sharp panels, and the square-tunnel icon. Do not restore the light theme, the rounded cards, the Umbrel-logo footer, or the line "Cloudflare Tunnel app by Radiokot". Keep the GPL line that names Radiokot's app.
- Image names under `ghcr.io/zot24/`. Do not introduce `ghcr.io/radiokot` images.
- App id `zot24-cloudflared`, UI port 4500, and the official app id `cloudflared` left as a separate app.

Skip a hunk that only bumps a cloudflared version. Skip a change that does not change behavior this app needs, and say why. When you edit a forked file, keep the local behavior above and add only the upstream behavior that still fits.

Do not merge. Do not push. Do not commit. Do not edit anything outside `zot24-cloudflared/`. Do not edit `.github/workflows`. Write `zot24-cloudflared/ci/pending/ADAPTATION.md` with what you kept, what you skipped, and which files you edited. If nothing is worth porting, write that and edit no other file.
