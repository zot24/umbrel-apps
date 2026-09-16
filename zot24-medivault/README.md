# MediVault

Medical records — documents, imaging studies and symptoms — on your own
Umbrel. Source: https://github.com/zot24/medivault

## What it does here

- Reads hospital CDs and groups the files into the studies they are, then
  draws them in the browser: CT phases, echocardiogram views, catheterization
  runs as cine loops, structured reports with their measurements.
- Keeps everything under `${APP_DATA_DIR}`, so Umbrel's backups cover it.
  Expect real cases to be large; one coronary CT plus an echo plus a cath is
  around 2.4 GB across 7,600 files.
- Shares a study as a link: the recipient opens the same viewer with no
  account, nothing to download, and an expiry you set.

## Where things live

| Path | Holds |
|---|---|
| `${APP_DATA_DIR}/data/db` | Postgres, the records and their metadata |
| `${APP_DATA_DIR}/data/uploads` | The image files themselves |
| `${APP_DATA_DIR}/data/.env` | Optional overrides, created by you |

## Exposing it

The app sits behind Umbrel's login. To let a doctor open a share link from
outside the house, use the Cloudflare Tunnel app and put Cloudflare Access in
front of the hostname, with a **Bypass → Everyone** policy on `/s/*` only.
The app then stays yours while share links keep working for the people you
send them to.

When it is reached over HTTPS that way, add `SECURE_COOKIES=1` to
`${APP_DATA_DIR}/data/.env` and restart the app, so the session cookie is
never sent in the clear.

## Releases

Tagging the source repository publishes the image, and
`.github/workflows/pin-medivault.yml` pins the digest here and bumps the
version, so the update appears on your Umbrel by itself.
