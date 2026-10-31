// node readonly-check.mjs [dir]: fails if Lifeboat's code (default ../lifeboat)
// has any way to write to or delete from the source Supabase project.
//
// The rules: only source.mjs may hold the source's settings; in source.mjs
// the only HTTP calls are the sign-in POST and GETs, the only programs run
// are pg_dump, pg_dumpall and psql, each in a read-only session, and SQL is
// SELECT only. Child processes never inherit Lifeboat's settings, so restic
// and rclone cannot reach the source either.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_SETTINGS = ['LIFEBOAT_PG_URL', 'LIFEBOAT_SUPABASE_URL', 'LIFEBOAT_SUPABASE_ANON_KEY', 'LIFEBOAT_SUPABASE_S3_ENDPOINT',
  'LIFEBOAT_BACKUP_USER_EMAIL', 'LIFEBOAT_BACKUP_USER_PASSWORD', 'LIFEBOAT_BUCKETS'];
const SIGN_IN = '/auth/v1/token?grant_type=password';

// The argument text of every call to fn(...), by matching parentheses.
function calls(code, fn) {
  const out = [];
  for (const m of code.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))) {
    if (/function\s*$/.test(code.slice(0, m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth; i++) depth += code[i] === '(' ? 1 : code[i] === ')' ? -1 : 0;
    out.push(code.slice(m.index + m[0].length, i - 1).trim());
  }
  return out;
}

export function check(dir) {
  const problems = [];
  const files = readdirSync(dir).filter((f) => /\.(mjs|js|html)$/.test(f));
  if (!files.includes('source.mjs')) return ['source.mjs is missing'];

  for (const file of files) {
    const code = readFileSync(path.join(dir, file), 'utf8');
    if (file === 'source.mjs') continue;
    for (const name of SOURCE_SETTINGS) if (code.includes(name)) problems.push(`${file} reads ${name}; only source.mjs may`);
    for (const m of code.matchAll(/\bsetting\(([^)]*)\)/g)) {
      if (!/^'[A-Z0-9_]+'$/.test(m[1].trim()) && !(file === 'util.mjs' && m[1].trim() === 'name')) problems.push(`${file}: setting(${m[1]}) must name a literal setting`);
    }
  }

  const util = readFileSync(path.join(dir, 'util.mjs'), 'utf8');
  if (!/filter\(\(\[k\]\) => !k\.startsWith\('LIFEBOAT_'\)\)/.test(util)) problems.push('util.mjs: child processes must not inherit LIFEBOAT_ settings');

  const src = readFileSync(path.join(dir, 'source.mjs'), 'utf8');
  for (const m of src.matchAll(/^import .* from '([^']+)';$/gm)) {
    if (!['node:crypto', 'node:fs', 'node:stream/promises', 'node:stream', './util.mjs'].includes(m[1])) problems.push(`source.mjs imports ${m[1]}`);
  }
  if (/\b(require|import)\s*\(/.test(src)) problems.push('source.mjs: no dynamic imports');
  if (/\b(XMLHttpRequest|WebSocket|http\.request|https\.request)\b/.test(src)) problems.push('source.mjs: only fetch may make requests');

  for (const args of calls(src, 'fetch')) {
    const method = args.match(/method:\s*'([A-Z]+)'/)?.[1];
    if (method === 'GET') continue;
    if (method === 'POST' && args.includes(SIGN_IN)) continue;
    problems.push(`source.mjs: fetch with method ${method ?? '(none)'}: fetch(${args.slice(0, 80)}...)`);
  }
  if ((src.match(/method:\s*'POST'/g) ?? []).length > 1) problems.push('source.mjs: only the sign-in may POST');
  for (const verb of ['PUT', 'DELETE', 'PATCH', 'COPY']) if (new RegExp(`'${verb}'`).test(src)) problems.push(`source.mjs mentions '${verb}'`);
  if (!/\['GET', url\.pathname/.test(src)) problems.push('source.mjs: S3 requests must be signed as GET');

  for (const args of calls(src, 'run')) {
    const program = args.match(/^'([^']+)'/)?.[1];
    if (!['pg_dump', 'pg_dumpall', 'psql'].includes(program)) problems.push(`source.mjs runs ${program ?? args.slice(0, 40)}`);
    if (!/\{ env: readOnlyEnv \}$/.test(args)) problems.push(`source.mjs runs ${program} outside the read-only session`);
  }
  if (!/const readOnlyEnv = \{ PGOPTIONS: '-c default_transaction_read_only=on' \};/.test(src)) problems.push('source.mjs: readOnlyEnv must force default_transaction_read_only=on');
  for (const m of src.matchAll(/\bselect\((['"`])([\s\S]*?)\1\)/g)) {
    if (!/^\s*select\b/i.test(m[2])) problems.push(`source.mjs: non-SELECT query: ${m[2]}`);
  }
  if (!/if \(!\/\^\\s\*select\\b\/i\.test\(sql\)\) throw/.test(src)) problems.push('source.mjs: select() must reject anything but SELECT');
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../lifeboat');
  const problems = check(dir);
  for (const p of problems) console.error(`READ-ONLY CHECK FAILED: ${p}`);
  if (problems.length) process.exit(1);
  console.log('read-only check passed: no code path writes to or deletes from the source project');
}
