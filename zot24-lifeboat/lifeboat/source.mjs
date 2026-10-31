// Everything Lifeboat does to the source Supabase project lives in this file,
// and all of it is read-only: pg_dump, pg_dumpall and SELECTs over a
// read-only session, one sign-in, and S3 GETs. test/readonly-check.mjs fails
// the build if anything else appears here or if another file touches the
// source's settings.
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { run, setting } from './util.mjs';

export const PG_URL = setting('LIFEBOAT_PG_URL');
const SUPABASE_URL = setting('LIFEBOAT_SUPABASE_URL');
const ANON_KEY = setting('LIFEBOAT_SUPABASE_ANON_KEY');
const S3_ENDPOINT = setting('LIFEBOAT_SUPABASE_S3_ENDPOINT');
const USER_EMAIL = setting('LIFEBOAT_BACKUP_USER_EMAIL');
const USER_PASSWORD = setting('LIFEBOAT_BACKUP_USER_PASSWORD');
const BUCKETS = setting('LIFEBOAT_BUCKETS');

// The server refuses writes in this session even if the role could make them.
const readOnlyEnv = { PGOPTIONS: '-c default_transaction_read_only=on' };

export function dumpRoles(file) {
  return run('pg_dumpall', ['--roles-only', '--no-role-passwords', `--dbname=${PG_URL}`, `--file=${file}`], { env: readOnlyEnv });
}

export function dumpDatabase(file, excludeSchemas) {
  const exclude = excludeSchemas.map((s) => `--exclude-schema=${s}`);
  return run('pg_dump', ['--format=custom', ...exclude, `--file=${file}`, `--dbname=${PG_URL}`], { env: readOnlyEnv });
}

async function select(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error('source queries must be SELECTs');
  const { stdout } = await run('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', `--dbname=${PG_URL}`, '-c', sql], { env: readOnlyEnv });
  return stdout.split('\n').filter(Boolean);
}

export function missingSettings() {
  const required = { LIFEBOAT_PG_URL: PG_URL, LIFEBOAT_SUPABASE_URL: SUPABASE_URL, LIFEBOAT_SUPABASE_ANON_KEY: ANON_KEY,
    LIFEBOAT_SUPABASE_S3_ENDPOINT: S3_ENDPOINT, LIFEBOAT_BACKUP_USER_EMAIL: USER_EMAIL, LIFEBOAT_BACKUP_USER_PASSWORD: USER_PASSWORD };
  return Object.keys(required).filter((name) => !required[name]);
}

export async function buckets() {
  if (BUCKETS) return BUCKETS.split(',').map((b) => b.trim()).filter(Boolean);
  return select('select id from storage.buckets order by id');
}

export async function objectCounts() {
  const rows = await select("select bucket_id || '|' || count(*) from storage.objects group by bucket_id");
  return Object.fromEntries(rows.map((r) => [r.slice(0, r.lastIndexOf('|')), Number(r.slice(r.lastIndexOf('|') + 1))]));
}

export async function serverIdentity() {
  const [row] = await select('select concat_ws(\'|\', inet_server_addr(), inet_server_port(), current_database(), pg_postmaster_start_time())');
  return row;
}

export function sourceProject() {
  return PG_URL ? projectOf(PG_URL) : '';
}

// The Supabase project ref behind a Postgres URL: db.<ref>.supabase.co,
// <role>.<ref>@...pooler.supabase.com, or the host itself elsewhere.
export function projectOf(pgUrl) {
  const u = new URL(pgUrl);
  const direct = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.(co|com|in|net)$/);
  if (direct) return direct[1];
  const pooled = decodeURIComponent(u.username).match(/^[^.]+\.([a-z0-9]+)$/);
  if (pooled && /\.pooler\.supabase\.com$/.test(u.hostname)) return pooled[1];
  return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1) || 'postgres'}`;
}

// --- Storage: sign in as the backup user, then S3 GETs with its session ---

function jwtClaims(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}

const projectRef = () => jwtClaims(ANON_KEY).ref || new URL(SUPABASE_URL).hostname.split('.')[0];

let session = null;

async function accessToken() {
  if (session && session.expiresAt - Date.now() > 5 * 60_000) return session.token;
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in as ${USER_EMAIL} failed: ${res.status} ${body.error_description || body.msg || body.error || ''}`.trim());
  }
  session = { token: body.access_token, expiresAt: (jwtClaims(body.access_token).exp ?? 0) * 1000 };
  return session.token;
}

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

export function signGet({ url, accessKeyId, secretAccessKey, sessionToken, region = 'us-east-1', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = { host: url.host, 'x-amz-content-sha256': sha256(''), 'x-amz-date': amzDate };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  const canonical = ['GET', url.pathname, query, ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), headers['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${secretAccessKey}`, day), region));
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  delete headers.host;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}

async function s3get(bucket, key = '', params = {}) {
  const base = S3_ENDPOINT.replace(/\/$/, '');
  const url = new URL(`${base}/${rfc3986(bucket)}${key ? '/' + key.split('/').map(rfc3986).join('/') : ''}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = signGet({ url, accessKeyId: projectRef(), secretAccessKey: ANON_KEY, sessionToken: await accessToken() });
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) throw new Error(`GET ${bucket}/${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

const xmlText = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] ??
    String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlText(m[1]) : undefined;
};

export async function* listObjects(bucket) {
  let token;
  do {
    const xml = await (await s3get(bucket, '', { 'list-type': '2', ...(token && { 'continuation-token': token }) })).text();
    for (const [, c] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      yield { key: tag(c, 'Key'), size: Number(tag(c, 'Size')), lastModified: new Date(tag(c, 'LastModified')) };
    }
    token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
  } while (token);
}

export async function downloadObject(bucket, key, file) {
  const res = await s3get(bucket, key);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}
