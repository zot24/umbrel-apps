import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import * as source from './source.mjs';
import { childEnv, run, setting } from './util.mjs';

const DATA = '/data';
const REPO = `${DATA}/repo`;
const STAGE = `${DATA}/stage`;
const STATE = `${DATA}/state.json`;
const LOCK = `${DATA}/job.lock`;
const TMP = `${DATA}/tmp`;
export const RESTORES = `${DATA}/restores`;

const DAY = 86_400_000;
export const STALE_AFTER = 26 * 3_600_000;
export const R2_MIN_AGE = 30 * DAY;
const KEEP = ['--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '12', '--keep-yearly', 'unlimited'];

// Supabase-managed schemas with no project data, or data that is useless
// outside the project (vault secrets are sealed with the project's key).
const SKIP_SCHEMAS = ['_analytics', '_realtime', '_supavisor', 'cron', 'dbdev', 'graphql', 'graphql_public', 'net', 'pgbouncer',
  'pgmq', 'pgsodium', 'pgsodium_masks', 'pgtle', 'realtime', 'repack', 'supabase_functions', 'tiger', 'tiger_data', 'topology', 'vault'];

const R2 = {
  accessKeyId: setting('LIFEBOAT_R2_ACCESS_KEY_ID'),
  secretAccessKey: setting('LIFEBOAT_R2_SECRET_ACCESS_KEY'),
  endpoint: setting('LIFEBOAT_R2_ENDPOINT').replace(/\/$/, ''),
  bucket: setting('LIFEBOAT_R2_BUCKET'),
};
const RESTIC_PASSWORD = setting('LIFEBOAT_RESTIC_PASSWORD');

const resticLocal = { RESTIC_REPOSITORY: REPO, RESTIC_PASSWORD, RESTIC_CACHE_DIR: `${DATA}/cache` };
// R2 aliases us-east-1 to its "auto" region.
const resticR2 = {
  RESTIC_REPOSITORY: `s3:${R2.endpoint}/${R2.bucket}`,
  RESTIC_PASSWORD,
  RESTIC_CACHE_DIR: `${DATA}/cache`,
  AWS_ACCESS_KEY_ID: R2.accessKeyId,
  AWS_SECRET_ACCESS_KEY: R2.secretAccessKey,
  AWS_DEFAULT_REGION: 'us-east-1',
};
const rcloneEnv = {
  RCLONE_CONFIG_R2_TYPE: 's3',
  RCLONE_CONFIG_R2_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_R2_ACCESS_KEY_ID: R2.accessKeyId,
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: R2.secretAccessKey,
  RCLONE_CONFIG_R2_ENDPOINT: R2.endpoint,
  RCLONE_CONFIG_R2_REGION: 'us-east-1',
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET: 'true',
};
const R2_REMOTE = `r2:${R2.bucket}`;
const REPO_FILES = ['/config', '/keys/**', '/snapshots/**', '/index/**', '/data/**'];

const restic = (env, args) => run('restic', args, { env });
const rclone = (args, stdin) => run('rclone', args, { env: rcloneEnv, stdin });
const psql = (url, args, stdin) => run('psql', ['-X', '-A', '-t', `--dbname=${url}`, ...args], { stdin });

export const log = (...a) => console.log(new Date().toISOString(), ...a);
const sum = (values) => [...values].reduce((a, b) => a + b, 0);
export const redact = (url) => url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

export function missingSettings() {
  const required = { LIFEBOAT_RESTIC_PASSWORD: RESTIC_PASSWORD, LIFEBOAT_R2_ACCESS_KEY_ID: R2.accessKeyId,
    LIFEBOAT_R2_SECRET_ACCESS_KEY: R2.secretAccessKey, LIFEBOAT_R2_ENDPOINT: R2.endpoint, LIFEBOAT_R2_BUCKET: R2.bucket };
  return Object.keys(required).filter((name) => !required[name]).concat(source.missingSettings());
}

// --- state and the one-job-at-a-time lock (shared with `docker exec` runs) ---

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return {};
  }
}

export async function updateState(patch) {
  const next = { ...(await readState()), ...patch };
  await mkdir(DATA, { recursive: true });
  await writeFile(`${STATE}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${STATE}.tmp`, STATE);
  return next;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export async function currentJob() {
  try {
    const held = JSON.parse(await readFile(LOCK, 'utf8'));
    return alive(held.pid) ? held : null;
  } catch (e) {
    // A lock being written right now is held.
    return e.code === 'ENOENT' ? null : { kind: 'job', pid: 0 };
  }
}

export const clearLock = () => rm(LOCK, { force: true });

async function acquire(kind) {
  await mkdir(DATA, { recursive: true });
  try {
    const fh = await open(LOCK, 'wx');
    await fh.writeFile(JSON.stringify({ kind, pid: process.pid, startedAt: new Date().toISOString() }));
    await fh.close();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const held = await currentJob();
    if (held) throw Object.assign(new Error(`busy: a ${held.kind} is running since ${held.startedAt}`), { busy: true });
    await clearLock();
    return acquire(kind);
  }
}

async function job(kind, fn) {
  await acquire(kind);
  const startedAt = new Date().toISOString();
  const step = (s) => {
    log(`${kind}: ${s}`);
    writeFileSync(LOCK, JSON.stringify({ kind, pid: process.pid, startedAt, step: s }));
  };
  try {
    const result = await fn(step);
    const done = { ok: true, startedAt, finishedAt: new Date().toISOString(), ...result };
    await updateState({ [kind]: done, ...(kind === 'backup' && { lastSuccessAt: done.finishedAt }) });
    log(`${kind}: ok`);
    return done;
  } catch (e) {
    if (!e.busy) await updateState({ [kind]: { ok: false, startedAt, finishedAt: new Date().toISOString(), error: e.message } });
    log(`${kind}: FAILED: ${e.message}`);
    throw e;
  } finally {
    if ((await currentJob())?.pid === process.pid) await clearLock();
  }
}

// --- backup ---

export function backup() {
  return job('backup', async (step) => {
    const missing = missingSettings();
    if (missing.length) throw new Error(`not configured: ${missing.join(', ')}`);
    const db = `${STAGE}/db`;
    await rm(db, { recursive: true, force: true });
    await mkdir(db, { recursive: true });

    step('dumping database');
    await source.dumpRoles(`${db}/roles.sql`);
    await source.dumpDatabase(`${db}/database.dump`, SKIP_SCHEMAS);
    const counts = await dumpRowCounts(`${db}/database.dump`);

    step('pulling storage');
    const { fetched, ...storage } = await mirrorStorage(`${STAGE}/storage`);

    const manifest = { takenAt: new Date().toISOString(), project: source.sourceProject(), tables: counts.size, rows: sum(counts.values()), ...storage };
    await writeFile(`${STAGE}/manifest.json`, JSON.stringify(manifest, null, 2));

    step('saving snapshot');
    if (!existsSync(`${REPO}/config`)) {
      // A reinstall carries on the repo already in R2 instead of starting a new one.
      if ((await listR2()).has('config')) await rclone(['copy', R2_REMOTE, REPO, ...REPO_FILES.flatMap((f) => ['--include', f])]);
      else await restic(resticLocal, ['init']);
    }
    const { stdout } = await restic(resticLocal, ['backup', '--json', '--quiet', '--host', 'lifeboat', '--tag', 'lifeboat', STAGE]);
    const summary = stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.message_type === 'summary');
    const snapshot = summary.snapshot_id;

    step('applying retention');
    await restic(resticLocal, ['forget', '--prune', '--host', 'lifeboat', ...KEEP]);

    step('copying to R2');
    const r2 = await mirrorToR2(Date.now());
    await restic(resticR2, ['--no-lock', 'cat', 'snapshot', snapshot]);

    return { snapshot, ...manifest, fetched, r2 };
  });
}

const COPY_LINE = /^COPY ((?:"(?:[^"]|"")+"|[^\s."]+)\.(?:"(?:[^"]|"")+"|[^\s."]+)) (?:\(.*\) )?FROM stdin;$/;

// Rows per table in a dump, read from its COPY blocks (one line per row).
export async function countCopyRows(stream) {
  const counts = new Map();
  let table = null;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (table === null) {
      const m = line.match(COPY_LINE);
      if (m) counts.set((table = m[1]), 0);
    } else if (line === '\\.') table = null;
    else counts.set(table, counts.get(table) + 1);
  }
  return counts;
}

async function dumpRowCounts(file) {
  const child = spawn('pg_restore', ['--data-only', '--file=-', file], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('close', resolve));
  const counts = await countCopyRows(child.stdout);
  if ((await exited) !== 0) throw new Error(`pg_restore could not read ${file}: ${stderr.trim()}`);
  return counts;
}

function safePath(...parts) {
  const segments = parts.flatMap((p) => p.split('/'));
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new Error(`cannot store object "${parts.join('/')}" as a file`);
  return segments.join('/');
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

async function pruneEmptyDirs(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await pruneEmptyDirs(path.join(dir, e.name));
  }
  await rmdir(dir).catch(() => {});
}

// Keep a local mirror of every object, so a run only GETs what changed.
async function mirrorStorage(root) {
  const buckets = await source.buckets();
  const expected = await source.objectCounts();
  await mkdir(root, { recursive: true });
  for (const name of await readdir(root)) {
    if (!buckets.includes(name)) await rm(path.join(root, name), { recursive: true, force: true });
  }
  let objects = 0;
  let bytes = 0;
  let fetched = 0;
  for (const bucket of buckets) {
    const keep = new Set();
    let listed = 0;
    for await (const o of source.listObjects(bucket)) {
      const file = path.join(root, safePath(bucket, o.key));
      keep.add(file);
      listed++;
      bytes += o.size;
      const st = await stat(file).catch(() => null);
      if (st?.size === o.size && Math.floor(st.mtimeMs / 1000) === Math.floor(o.lastModified / 1000)) continue;
      await mkdir(path.dirname(file), { recursive: true });
      await source.downloadObject(bucket, o.key, `${file}.lifeboat-part`);
      await utimes(`${file}.lifeboat-part`, o.lastModified, o.lastModified);
      await rename(`${file}.lifeboat-part`, file);
      fetched++;
    }
    if (listed < (expected[bucket] ?? 0)) {
      throw new Error(`bucket ${bucket}: the backup user sees ${listed} of ${expected[bucket]} objects; check its select policy on storage.objects`);
    }
    for (const file of await walk(path.join(root, bucket))) if (!keep.has(file)) await rm(file);
    await pruneEmptyDirs(path.join(root, bucket));
    objects += listed;
  }
  return { buckets, objects, bytes, fetched };
}

// --- R2: an append-only mirror of the local repo, files compared by size ---

// A file leaves R2 only once it has been gone from the local repo for 30
// days. Everything it held was then in some repo state of the last 30 days,
// so the R2 copy stays a consistent restic repo, and it is at least 30 days
// old, so the bucket's Object Lock allows the delete.
export function planR2Deletes(remote, local, gone, now) {
  const remove = [];
  const waiting = {};
  for (const file of remote) {
    if (local.has(file)) continue;
    const since = gone[file] ?? now;
    if (now - since >= R2_MIN_AGE) remove.push(file);
    else waiting[file] = since;
  }
  return { remove, waiting };
}

async function listLocalRepo() {
  const files = new Map();
  for (const file of await walk(REPO)) {
    const rel = path.relative(REPO, file);
    if (!rel.startsWith('locks/')) files.set(rel, (await stat(file)).size);
  }
  return files;
}

async function listR2() {
  const { stdout } = await rclone(['lsf', '-R', '--files-only', '--format', 'sp', '--separator', '\t', R2_REMOTE]);
  return new Map(stdout.split('\n').filter(Boolean).map((l) => {
    const [size, file] = l.split('\t');
    return [file, Number(size)];
  }));
}

async function mirrorToR2(now) {
  await rclone(['copy', REPO, R2_REMOTE, '--exclude', '/locks/**', '--ignore-existing']);
  const local = await listLocalRepo();
  const remote = await listR2();
  const short = [...local].filter(([file, size]) => remote.get(file) !== size);
  if (short.length) throw new Error(`R2 copy is missing ${short.length} files, e.g. ${short[0][0]}`);
  const repoFiles = [...remote.keys()].filter((f) => f === 'config' || /^(keys|snapshots|index|data)\//.test(f));
  const { remove, waiting } = planR2Deletes(repoFiles, local, (await readState()).r2Gone ?? {}, now);
  if (remove.length) await rclone(['delete', R2_REMOTE, '--files-from-raw', '-'], remove.join('\n'));
  await updateState({ r2Gone: waiting });
  return { files: remote.size - remove.length, deleted: remove.length, held: Object.keys(waiting).length };
}

// --- snapshots, restore, drill ---

const repoFor = (from) => (from === 'r2' ? resticR2 : resticLocal);
const readArgs = (from) => (from === 'r2' ? ['--no-lock'] : []);

export async function snapshots(from = 'local') {
  if (from === 'local' && !existsSync(`${REPO}/config`)) return [];
  const { stdout } = await restic(repoFor(from), ['--no-lock', 'snapshots', '--json']);
  return JSON.parse(stdout)
    .map((s) => ({ id: s.id, short: s.short_id, time: s.time, bytes: s.summary?.total_bytes_processed ?? null }))
    .reverse();
}

async function sameServer(targetUrl) {
  const identity = (url) => psql(url, ['-v', 'ON_ERROR_STOP=1', '-c', "select concat_ws('|', inet_server_addr(), inet_server_port(), current_database(), pg_postmaster_start_time())"]).then((r) => r.stdout.trim());
  const [a, b] = await Promise.all([source.serverIdentity().catch(() => null), identity(targetUrl)]);
  return a !== null && a === b;
}

export function restore(snapshot, targetUrl, folder, from = 'local') {
  return job('restore', (step) => restoreInto(snapshot, targetUrl, folder, from, step));
}

async function restoreInto(snapshot, targetUrl, folder, from, step) {
  step('checking target');
  const [snap] = JSON.parse((await restic(repoFor(from), ['--no-lock', 'snapshots', '--json', snapshot])).stdout);
  if (!snap) throw new Error(`no snapshot ${snapshot}`);
  const manifest = JSON.parse((await restic(repoFor(from), ['--no-lock', 'dump', snap.id, `${STAGE}/manifest.json`])).stdout);
  const target = source.projectOf(targetUrl);
  if (target === source.sourceProject() || target === manifest.project || (await sameServer(targetUrl))) {
    throw new Error(`refusing to restore into the source project (${target})`);
  }
  if ((await readdir(folder).catch(() => [])).length) throw new Error(`${folder} is not empty`);

  step('restoring files');
  await mkdir(folder, { recursive: true });
  await restic(repoFor(from), [...readArgs(from), 'restore', `${snap.id}:${STAGE}`, '--target', folder]);

  step('restoring database');
  const errors = await restoreDatabase(`${folder}/db`, targetUrl);

  step('verifying');
  const checked = await verify(folder, targetUrl, manifest.buckets);
  return { snapshot: snap.id, target: redact(targetUrl), folder, restoreErrors: errors, ...checked };
}

async function restoreDatabase(dir, url) {
  const roles = [...(await readFile(`${dir}/roles.sql`, 'utf8')).matchAll(/^CREATE ROLE ("(?:[^"]|"")+"|[^\s";]+);$/gm)].map((m) => m[1]);
  const createRoles = roles.map((r) => `DO $lb$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object OR insufficient_privilege THEN NULL; END $lb$;`);
  if (createRoles.length) await psql(url, ['-v', 'ON_ERROR_STOP=1'], createRoles.join('\n'));

  // Leave out extensions the target cannot install (Supabase's own, on plain
  // Postgres), and grants inside the schemas a backup skips.
  const available = new Set((await psql(url, ['-v', 'ON_ERROR_STOP=1', '-c', 'select name from pg_available_extensions'])).stdout.split('\n').filter(Boolean));
  const toc = (await run('pg_restore', ['--list', `${dir}/database.dump`])).stdout.split('\n').filter((line) => {
    const ext = line.match(/^\d+; \d+ \d+ (?:EXTENSION - |COMMENT - EXTENSION )"?([^"\s]+)"?/);
    if (ext) return available.has(ext[1]);
    const acl = line.match(/^\d+; \d+ \d+ ACL (\S+) /);
    return !(acl && SKIP_SCHEMAS.includes(acl[1]));
  });
  await writeFile(`${dir}/restore.list`, toc.join('\n'));
  const result = await run('pg_restore', ['--no-owner', `--use-list=${dir}/restore.list`, `--dbname=${url}`, `${dir}/database.dump`]).catch((e) => e);
  return result.stderr.split('\n').filter((l) => l.startsWith('pg_restore: error:'));
}

// Every table has the rows its dump has, and every storage object row has its bytes.
async function verify(folder, url, buckets) {
  const expected = await dumpRowCounts(`${folder}/db/database.dump`);
  const tables = [...expected.keys()];
  const { stdout } = await psql(url, [], tables.map((t, i) => `select ${i}, count(*) from only ${t};`).join('\n'));
  const got = new Map(stdout.split('\n').filter(Boolean).map((l) => l.split('|').map(Number)));
  const problems = tables.flatMap((t, i) => (got.get(i) === expected.get(t) ? [] : [`${t}: ${expected.get(t)} rows in backup, ${got.get(i) ?? 'no table'} restored`]));

  const { stdout: raw } = await psql(url, ['-v', 'ON_ERROR_STOP=1', '-z', '-0', '-c', "select bucket_id, name, coalesce(metadata->>'size', '-1') from storage.objects"]);
  const fields = raw.split('\0');
  let objects = 0;
  let bytes = 0;
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [bucket, name, size] = fields.slice(i, i + 3);
    if (!buckets.includes(bucket)) continue;
    const st = await stat(path.join(folder, 'storage', bucket, name)).catch(() => null);
    if (!st || (size !== '-1' && st.size !== Number(size))) problems.push(`storage object ${bucket}/${name} has no matching file`);
    else {
      objects++;
      bytes += st.size;
    }
  }
  if (problems.length) throw new Error(`${problems.length} checks failed: ${problems.slice(0, 10).join('; ')}`);
  return { tables: tables.length, rows: sum(expected.values()), objects, bytes };
}

export function drill() {
  return job('drill', async (step) => {
    await mkdir(TMP, { recursive: true });
    const dir = await mkdtemp(`${TMP}/drill-`);
    const pg = ['-D', `${dir}/pg`];
    try {
      step('starting scratch Postgres');
      await run('initdb', [...pg, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
      await run('pg_ctl', [...pg, '-w', '-l', `${dir}/pg.log`, '-o', `-c listen_addresses='' -k ${dir} -c fsync=off`, 'start']);
      const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(dir)}`;
      return await restoreInto('latest', url, `${dir}/files`, 'local', step);
    } finally {
      await run('pg_ctl', [...pg, '-m', 'immediate', 'stop']).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
}

export function nextRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
    next.setHours(3, 0, 0, 0);
  }
  return next;
}
