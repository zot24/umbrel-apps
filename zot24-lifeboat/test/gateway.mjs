// The fake project's API gateway (Supabase's Kong) and the fake R2. Every
// request is logged to /tmp/requests.log, so the proof can show what
// Lifeboat sent to each side.
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const LOG = '/tmp/requests.log';
const note = (line) => appendFileSync(LOG, `${line}\n`);

function forward(req, res, host, port, path, tag, onDone = () => {}) {
  const up = http.request({ host, port, method: req.method, path, headers: req.headers }, (r) => {
    note(`${tag} ${req.method} ${req.url} ${r.statusCode}`);
    onDone(r.statusCode);
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(up);
}

const deny = (req, res, tag, why) => {
  note(`${tag} ${req.method} ${req.url} 403 ${why}`);
  res.writeHead(403, { 'content-type': 'application/xml' });
  res.end(`<Error><Code>AccessDenied</Code><Message>${why}</Message></Error>`);
};

// Supabase: /auth/v1 -> GoTrue, /storage/v1 -> Storage, with the Host header kept for S3 signatures.
http.createServer((req, res) => {
  for (const [prefix, host, port] of [['/auth/v1', 'auth', 9999], ['/storage/v1', 'storage', 5000]]) {
    if (req.url.startsWith(`${prefix}/`)) return forward(req, res, host, port, req.url.slice(prefix.length), 'supabase');
  }
  res.writeHead(404);
  res.end();
}).listen(8000);

// R2 stand-in: MinIO under R2's bucket lock rules. An object cannot be
// overwritten, or deleted within 30 days of its upload.
const uploadedAt = new Map();
const LOCK_MS = 30 * 86_400_000;
http.createServer((req, res) => {
  const key = req.url.split('?')[0];
  const isObject = key.split('/').filter(Boolean).length > 1;
  const multipart = /[?&]uploadId=/.test(req.url);
  if (isObject && req.method === 'PUT' && !multipart && uploadedAt.has(key)) return deny(req, res, 'r2', 'locked: overwrite');
  if (isObject && req.method === 'DELETE' && Date.now() - (uploadedAt.get(key) ?? 0) < LOCK_MS) return deny(req, res, 'r2', 'locked: younger than 30 days');
  if (req.method === 'POST' && /[?&]delete/.test(req.url)) return deny(req, res, 'r2', 'locked: batch delete');
  forward(req, res, 'minio', 9000, req.url, 'r2', (status) => {
    if (isObject && req.method === 'PUT' && status === 200 && !multipart) uploadedAt.set(key, Date.now());
  });
}).listen(9000);

// Slack incoming-webhook stand-in.
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    note(`webhook ${req.method} ${req.url} ${body}`);
    res.end('ok');
  });
}).listen(7000);
