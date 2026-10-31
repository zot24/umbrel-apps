# Lifeboat

Nightly encrypted backups of one Supabase project: the database and every Storage file, as
a restic snapshot on the Umbrel, mirrored to Cloudflare R2.

- **App ID**: `zot24-lifeboat`
- **Port**: 7746 (behind the Umbrel login)
- **Image**: `ghcr.io/zot24/lifeboat` (Postgres 17 client, restic, rclone, Node)

## Settings

Put them in `<app-data>/data/.env` (or Docker secrets of the same names) and restart the app:

```sh
LIFEBOAT_PG_URL=postgresql://lifeboat_ro:...@db.<ref>.supabase.co:5432/postgres
LIFEBOAT_SUPABASE_URL=https://<ref>.supabase.co
LIFEBOAT_SUPABASE_ANON_KEY=...
LIFEBOAT_SUPABASE_S3_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3
LIFEBOAT_BACKUP_USER_EMAIL=...
LIFEBOAT_BACKUP_USER_PASSWORD=...
LIFEBOAT_BUCKETS=                  # optional: a,b,c (default: every row in storage.buckets)
LIFEBOAT_RESTIC_PASSWORD=...       # keep a copy elsewhere: no snapshot opens without it
LIFEBOAT_R2_ACCESS_KEY_ID=...
LIFEBOAT_R2_SECRET_ACCESS_KEY=...
LIFEBOAT_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
LIFEBOAT_R2_BUCKET=...
LIFEBOAT_ALERT_WEBHOOK=            # optional: a Slack incoming webhook
```

`LIFEBOAT_PG_URL` must be a direct or session-mode (port 5432) connection, as `pg_dump` cannot
run through the transaction pooler. Lifeboat expects these on the Supabase side:

```sql
create role lifeboat_ro login password '...' bypassrls;
grant pg_read_all_data to lifeboat_ro;
alter role lifeboat_ro set default_transaction_read_only = on;
-- the backup user (created in Auth) may only read Storage
create policy lifeboat_backup_read on storage.objects for select to authenticated
  using ((select auth.jwt() ->> 'email') = '<backup user email>');
create policy lifeboat_backup_read on storage.buckets for select to authenticated
  using ((select auth.jwt() ->> 'email') = '<backup user email>');
```

## Commands

The page has Restore and Drill buttons. The same, from a shell on the Umbrel:

```sh
docker exec -it zot24-lifeboat_lifeboat_1 lifeboat backup
docker exec -it zot24-lifeboat_lifeboat_1 lifeboat snapshots [--from r2]
docker exec -it zot24-lifeboat_lifeboat_1 lifeboat restore <snapshot|latest> <target-postgres-url> /data/restores/<name> [--from r2]
docker exec -it zot24-lifeboat_lifeboat_1 lifeboat drill
```

Restore fills an empty Postgres database (a plain Postgres 17, or a new Supabase project)
and the folder, then checks that every table has the rows in the snapshot and every
`storage.objects` row has its file. It refuses a target that is the source project, by URL or
by server. Extensions the target lacks are left out, and other `pg_restore` errors are listed
as warnings; the checks decide success. Without the Umbrel, run the same image anywhere with
the restic and R2 settings and `--from r2`.

## How it works

- **Backup**: `pg_dumpall --roles-only` and `pg_dump -Fc` (all schemas except Supabase's
  internal ones), then a sign-in as the backup user and S3 `GET`s of every object into a local
  mirror, so later runs only fetch what changed. Both go into one restic snapshot.
- **Read-only**: all access to the project is in [`lifeboat/source.mjs`](lifeboat/source.mjs),
  and [`test/readonly-check.mjs`](test/readonly-check.mjs) fails the build if anything there
  could write.
- **R2**: `restic copy` and `forget` need lock files that a 30-day bucket lock will not let
  restic delete. So the local repo is mirrored file by file (`rclone copy --ignore-existing`),
  and a file is deleted from R2 only after it has been gone locally for 30 days. R2 is a full
  restic repo with the same snapshot IDs.
- **Alerts**: umbrelOS has no API for apps to post notifications, so a missed backup shows on
  the page, on the home-screen widget, and in Slack.
- **Drill**: the scratch database is a Postgres 17 server started inside the Lifeboat container
  on a Unix socket, not a separate container, so the app needs no Docker socket.

## Local proof

`./test/e2e.sh` runs it all against a fake Supabase (Supabase's Postgres, Auth and Storage
images) and a fake R2 (MinIO), with made-up data. It needs only Docker and Node.
