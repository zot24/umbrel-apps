targets: ui=7e2d3a57cdbfb402467d29731dee6ba6a61d836f connector=2ec28d03d684e126a0453bbcfe0e33f837a03245 umbrel=1129e29f4ca04a828169a28de50d7738e2d2c4a1

Upstream product changes for this app. Cloudflared image tags are
not in this pull request; the hourly update-cloudflared job commits those.
Merge this if the applied edits look right. Port any forked files
below before merging, and keep our digest, update-bin.sh, metrics
port, and the three-column route layout. A source whose SHA did not
move in `ci/upstreams.json` did not apply cleanly. The next run tries
it again after this pull request is closed.

Repos we maintain:
- this one, zot24/umbrel-apps
- zot24/umbrel-apps-gallery (icons and screenshots; this job cannot open a PR there)

Upstreams:

## ui

Unchanged `Radiokot/umbrel-cloudflared` `7e2d3a5`.


## connector

Unchanged `Radiokot/umbrel-cloudflared-connector` `2ec28d0`.


## umbrel

`getumbrel/umbrel-apps` `86fa1b8` -> `1129e29`

Commits:
- 9ee85c3 Update fedimint-gateway to v0.13.0
- 445b219 Update fedimintd to v0.13.0
- 28a764d Update BOLT12 Pay to 0.3.18 (#6287)
- 7af6567 Update gitea-mirror to v3.51.0
- 7fbad1d Update ntfy to v2.36.0
- ad6de67 Clarify Lightning Node release notes
- c306244 Update Hermes Agent to 0.22.5-patch.1 (#6293)
- d874028 Update Murmur to 0.10.0 (#6292)
- d1f560c Update BOLT12 Pay to 0.3.19 (#6289)
- e878e5f Update searxng to v2026.11.1
- 6f92125 Update gitea to v28.3.0
- 0db137b Update memos to v26.10.0
- b0652c8 Update jackett to v0.24.2985
- 6550821 Update lobe-chat to v2.3.0
- 59f6a9a Update zigbee2mqtt to v2.14.3
- a716a11 Update airtrail to v3.14.0
- 4ba9d25 Update metube to v2026.11.01
- 5034d6b Update mstream to v6.32.2
- 5607e6f Update wealthfolio to v3.12.0
- 3a1bd1f Update actual to v26.11.0
- 663870e Update agent-zero to v2.15
- 4b1ce1f Update autobrr to v1.90.0
- 72c0f56 Update ekko-studio to v0.8.12
- 21bc7bc Update invoice-ninja to v5.13.53
- 3d910a2 Update mailflow to v4.1.2
- 1d7b147 Update memos to v26.11.0
- 93181fd Update poznote to v6.136.2
- 4fd78d1 Update vaultwarden to v1.37.5
- b9db2ca Update wallos to v5.10.4
- a353dd0 Update Hermes Agent to 0.22.5-patch.2 (#6295)

Product changes are in `ci/pending/umbrel.diff`. Our compose and manifest stay as written for this store. Image tag lines in that diff are still the hourly job.
