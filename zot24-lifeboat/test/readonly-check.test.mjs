// The read-only check passes on Lifeboat as it is, and fails on each way a
// write to the source could be added.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check } from './readonly-check.mjs';

const LIFEBOAT = path.join(path.dirname(new URL(import.meta.url).pathname), '../lifeboat');

function mutated(file, from, to) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lifeboat-check-'));
  cpSync(LIFEBOAT, dir, { recursive: true });
  const code = readFileSync(path.join(dir, file), 'utf8');
  assert.ok(code.includes(from), `${file} no longer contains ${from}`);
  writeFileSync(path.join(dir, file), code.replace(from, to));
  return dir;
}

test('passes on the real code', () => assert.deepEqual(check(LIFEBOAT), []));

const writes = {
  'an S3 PUT': ['source.mjs', "  return res;\n}", "  await fetch(url, { method: 'PUT', headers });\n  return res;\n}"],
  'an S3 DELETE': ['source.mjs', "fetch(url, { method: 'GET', headers })", "fetch(url, { method: 'DELETE', headers })"],
  'a POST that is not the sign-in': ['source.mjs', 'export async function* listObjects', "export const post = () => fetch(S3_ENDPOINT, { method: 'POST' });\nexport async function* listObjects"],
  'a fetch without a method': ['source.mjs', "fetch(url, { method: 'GET', headers })", 'fetch(url, { headers })'],
  'signing anything but GET': ['source.mjs', "['GET', url.pathname", "[method, url.pathname"],
  'rclone run against the source': ['source.mjs', 'export function dumpRoles', "export const wipe = () => run('rclone', ['delete', 'x'], { env: readOnlyEnv });\nexport function dumpRoles"],
  'psql outside the read-only session': ['source.mjs', "`--file=${file}`], { env: readOnlyEnv });", "`--file=${file}`], {});"],
  'a write query': ['source.mjs', "select('select id from storage.buckets order by id')", "select('delete from storage.objects')"],
  'a source setting in another file': ['lib.mjs', "const DATA = '/data';", "const DATA = '/data';\nconst sneaky = setting('LIFEBOAT_SUPABASE_URL');"],
  'child processes inheriting settings': ['util.mjs', ".filter(([k]) => !k.startsWith('LIFEBOAT_'))", ''],
  'a network module in source.mjs': ['source.mjs', "import { run, setting } from './util.mjs';", "import { run, setting } from './util.mjs';\nimport https from 'node:https';"],
};

for (const [name, [file, from, to]] of Object.entries(writes)) {
  test(`fails on ${name}`, () => assert.notDeepEqual(check(mutated(file, from, to)), []));
}
