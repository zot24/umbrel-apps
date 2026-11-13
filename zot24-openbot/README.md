# OpenBot

LAN-only Umbrel tile for [OpenBot](https://github.com/CopilotKit/OpenBot) v1.0.2.

- Tile (Umbrel login): 25754
- Container listen port: 3001 (not published on the host)
- Image: `ghcr.io/copilotkit/openbot:v1.0.2` (sha256-pinned, linux/amd64 only)

This app is not installed by adding it to the store. Installing needs a
fresh yes.

## What it runs

One tile talks to the official all-in-one OpenBot image. Postgres has a
volume under `${APP_DATA_DIR}/data/postgres`. A one-shot migrate
container applies the schema. A cron container runs
`bun scripts/fire-routines.ts` and `bun scripts/cull-staged-attachments.ts`
once a minute. There is no public URL, no host port, and no tunnel.

Single-user mode is on. The Umbrel dashboard login is the gate to the
tile. Do not set `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, or
`TRUSTED_ORIGINS` to a public address.

## Secrets

Copy `data-env.example` to `<umbrel>/app-data/zot24-openbot/data/.env`
and fill the placeholder names before install. Compose reads that file
as `env_file`. Do not commit it or print its values.

Required names: `POSTGRES_PASSWORD`, `DATABASE_URL`,
`KEY_ENCRYPTION_KEY`, `CPK_INTELLIGENCE_API_KEY`, `OPENAI_API_KEY`,
`WORKER_SHARED_SECRET`.

Set `TRUSTED_ORIGINS`, `BETTER_AUTH_URL`, and `OPENBOT_APP_URL` to the
LAN tile origin (for example `http://umbrel.local:25754`).

## Memory limits

| Service | mem_limit |
|---------|-----------|
| openbot | 2g |
| postgres | 512m |
| cron | 256m |
| migrate | 256m |

These caps were sized from a read-only measurement of the Umbrel while
the GitHub runners and the cache apps were running. The 2g OpenBot cap
is the upstream minimum for one user. Lint memory on the runners stays
the higher priority.

## CopilotKit Intelligence

OpenBot will not start without Intelligence. The application source is
MIT-licensed. Intelligence is separately licensed. Personal laptop use
is free. Production use is paid, and OpenBot for Business includes
Intelligence for use with OpenBot. See [OpenBot pricing](https://open.bot/pricing)
and the upstream [README](https://github.com/CopilotKit/OpenBot/blob/main/README.md).
