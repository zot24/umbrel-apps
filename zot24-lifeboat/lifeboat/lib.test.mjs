process.env.TZ = 'America/Asuncion';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { R2_MIN_AGE, countCopyRows, nextRun, planR2Deletes } from './lib.mjs';
import { projectOf, signGet } from './source.mjs';

test('next run is the coming 03:00 in Asuncion (UTC-3)', () => {
  assert.equal(nextRun(new Date('2026-10-31T12:00:00Z')).toISOString(), '2026-11-01T06:00:00.000Z');
  assert.equal(nextRun(new Date('2026-11-01T05:59:00Z')).toISOString(), '2026-11-01T06:00:00.000Z');
  assert.equal(nextRun(new Date('2026-11-01T06:00:00Z')).toISOString(), '2026-11-02T06:00:00.000Z');
});

test('R2 keeps a file until it has been gone locally for 30 days', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const remote = ['config', 'data/aa/new', 'data/bb/gone-today', 'data/cc/gone-29d', 'data/dd/gone-30d'];
  const local = new Set(['config', 'data/aa/new']);
  const gone = { 'data/cc/gone-29d': now - R2_MIN_AGE + 86_400_000, 'data/dd/gone-30d': now - R2_MIN_AGE, 'data/ee/already-deleted': 0 };
  const { remove, waiting } = planR2Deletes(remote, local, gone, now);
  assert.deepEqual(remove, ['data/dd/gone-30d']);
  assert.deepEqual(waiting, { 'data/bb/gone-today': now, 'data/cc/gone-29d': gone['data/cc/gone-29d'] });
});

test('counts COPY rows per table, including quoted names and escaped newlines', async () => {
  const dump = [
    'SET statement_timeout = 0;',
    'COPY public.residents (id, notes) FROM stdin;',
    '1\tmulti\\nline',
    '2\t\\N',
    '\\.',
    'COPY public."Weird ""Table""" ("odd col") FROM stdin;',
    'a|b',
    '\\.',
    'COPY app.empty (id) FROM stdin;',
    '\\.',
    "SELECT pg_catalog.setval('public.seq', 3, true);",
  ].join('\n');
  const counts = await countCopyRows(Readable.from([dump]));
  assert.deepEqual([...counts], [['public.residents', 2], ['public."Weird ""Table"""', 1], ['app.empty', 0]]);
});

test('finds the Supabase project behind direct, pooled and other URLs', () => {
  assert.equal(projectOf('postgresql://ro:x@db.abcdefghijklmnop.supabase.co:5432/postgres'), 'abcdefghijklmnop');
  assert.equal(projectOf('postgresql://ro.abcdefghijklmnop:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres'), 'abcdefghijklmnop');
  assert.equal(projectOf('postgres://u:p@target:5432/app'), 'target:5432/app');
  assert.equal(projectOf('postgres://u:p@target/postgres'), 'target:5432/postgres');
});

test('signs S3 GETs as in the AWS SigV4 example', () => {
  const headers = signGet({
    url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});
