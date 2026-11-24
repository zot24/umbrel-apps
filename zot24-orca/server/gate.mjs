// Tile for the Orca Umbrel app.
//
// Umbrel's app_proxy (login) is the only peer allowed to connect. This
// process then asks for the tile password, serves the setup page, and
// proxies /t to a localhost ttyd. orca-ide itself listens on 6768, which
// docker-compose publishes on the Umbrel host for Tailscale. That port is
// not this HTTP server, and it is not behind the tile password: Orca's own
// pairing grant is the credential. Do not log the pairing URL.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSupervisor,
  peerAllowed,
  readPairingAddress,
  WS_PORT,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GATE_PORT || 6770);
const BIND = process.env.GATE_BIND || '0.0.0.0';
const TTYD_PORT = Number(process.env.TTYD_PORT || 6771);
const ORCA_BIN = process.env.ORCA_BIN || '/opt/orca-server/bin/orca-ide';
const DATA = process.env.ORCA_DATA_DIR || '/data';
const ADDRESS_FILE = path.join(DATA, 'pairing-address');
const USER_DATA = process.env.ORCA_USER_DATA || '/data/orca';
const WEB = path.join(HERE, 'web', 'index.html');
const LOGIN_SHELL = process.env.ORCA_LOGIN_SHELL || '/usr/local/lib/orca-umbrel/login-shell.sh';
const REQUIRE_PROXY = process.env.ORCA_REQUIRE_PROXY === '1';
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || '';
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const APP_SEED = (process.env.APP_SEED || APP_PASSWORD || 'orca-dev-seed').trim();
const COOKIE = 'orca_gate';
const MAX_BODY = 16 * 1024;

const orcaEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME || '/data/home',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  ORCA_USER_DATA: USER_DATA,
  ORCA_USER_DATA_PATH: USER_DATA,
  NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX || '/data/npm-global',
};

let proxyIps = new Set();
let lookedUpAt = 0;
const failures = new Map();

function log(message) {
  console.error(`[orca] ${message}`);
}

function hmac(value) {
  return crypto.createHmac('sha256', APP_SEED).update(value).digest('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authed(req) {
  if (!APP_PASSWORD) return true;
  const got = parseCookies(req)[COOKIE] || '';
  const want = hmac('ok');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

async function allowed(ip) {
  if (REQUIRE_PROXY && APP_PROXY_HOST && Date.now() - lookedUpAt > 2000) {
    lookedUpAt = Date.now();
    const found = await lookup(APP_PROXY_HOST, { all: true }).catch((err) => {
      log(`proxy lookup failed: ${err.message}`);
      return [];
    });
    proxyIps = new Set(found.map((item) => item.address));
  }
  return peerAllowed({ ip, proxyIps, requireProxy: REQUIRE_PROXY });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (chunk) => {
      n += chunk.length;
      if (n > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('expected json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function publicStatus(extra = {}) {
  const snap = supervisor.snapshot();
  return {
    ok: true,
    version: process.env.ORCA_VERSION || '',
    port: Number(process.env.ORCA_WS_PORT || WS_PORT),
    address: snap.address,
    phase: snap.phase,
    advertisedEndpoint: snap.advertisedEndpoint,
    pairingUrl: snap.pairingUrl,
    error: snap.error,
    log: snap.log,
    passwordRequired: Boolean(APP_PASSWORD),
    ...extra,
  };
}

function locked(ip) {
  const row = failures.get(ip);
  return row && row.until > Date.now();
}

function markFailure(ip) {
  const row = failures.get(ip) || { n: 0, until: 0 };
  row.n += 1;
  if (row.n >= 8) {
    row.until = Date.now() + 60_000;
    row.n = 0;
  }
  failures.set(ip, row);
}

const supervisor = createSupervisor({
  bin: ORCA_BIN,
  port: Number(process.env.ORCA_WS_PORT || WS_PORT),
  env: orcaEnv,
  cwd: '/data/workspaces',
  spawn,
  kill: (pid, sig) => process.kill(pid, sig),
  clearFallback() {
    // A stale remembered port makes `orca serve --port 6768` bind something
    // else and strand every client dialing 6768. Drop it before each start.
    try {
      fs.unlinkSync(path.join(USER_DATA, 'mobile-ws-fallback-port.json'));
    } catch {
      // absent
    }
  },
});

let ttyd = null;

function startTtyd() {
  ttyd = spawn(
    'ttyd',
    [
      '-i', '127.0.0.1',
      '-p', String(TTYD_PORT),
      '-W',
      '-b', '/t',
      '-t', 'fontSize=15',
      '-t', 'disableLeaveAlert=true',
      '-t', 'titleFixed=Orca',
      LOGIN_SHELL,
    ],
    { env: orcaEnv, stdio: 'ignore' },
  );
  ttyd.on('exit', (code, signal) => {
    ttyd = null;
    if (shuttingDown) return;
    log(`ttyd exited (${signal || code})`);
    setTimeout(startTtyd, 1000);
  });
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${TTYD_PORT}` };
  const upstream = http.request(
    { hostname: '127.0.0.1', port: TTYD_PORT, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) send(res, 502, { ok: false, error: 'shell not ready' });
    else res.end();
  });
  req.pipe(upstream);
}

async function handle(req, res) {
  const ip = clientIp(req);
  if (!(await allowed(ip))) return send(res, 403, { ok: false, error: 'forbidden' });
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(WEB);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/t' || url.pathname.startsWith('/t/')) {
    if (!authed(req)) {
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }
    return proxyHttp(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    if (req.headers['x-orca-umbrel'] !== '1') return send(res, 403, { ok: false, error: 'missing header' });
    if (!APP_PASSWORD) return send(res, 200, { ok: true });
    if (locked(ip)) return send(res, 429, { ok: false, error: 'Too many tries. Wait a minute.' });
    const body = await readBody(req);
    const given = String(body.password ?? '');
    const a = Buffer.from(given);
    const b = Buffer.from(APP_PASSWORD);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) {
      markFailure(ip);
      return send(res, 401, { ok: false, error: 'Wrong password.' });
    }
    failures.delete(ip);
    res.setHeader('Set-Cookie', `${COOKIE}=${hmac('ok')}; Path=/; HttpOnly; SameSite=Lax`);
    return send(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authed(req)) return send(res, 401, { ok: false, error: 'Sign in with the tile password.' });
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, publicStatus());
    if (req.method === 'POST' && url.pathname === '/api/pairing-address') {
      if (req.headers['x-orca-umbrel'] !== '1') return send(res, 403, { ok: false, error: 'missing header' });
      const body = await readBody(req);
      const parsed = readPairingAddress(String(body.address ?? ''));
      if (!parsed.ok) return send(res, 400, { ok: false, error: parsed.error });
      const current = supervisor.snapshot();
      fs.mkdirSync(DATA, { recursive: true });
      const tmp = `${ADDRESS_FILE}.tmp`;
      fs.writeFileSync(tmp, parsed.address ? `${parsed.address}\n` : '', { mode: 0o600 });
      fs.renameSync(tmp, ADDRESS_FILE);
      if (parsed.address === current.address && current.phase !== 'exited') {
        return send(res, 200, publicStatus());
      }
      const snap = await supervisor.setAddress(parsed.address);
      log(parsed.address ? `pairing address set, orca ${snap.phase}` : 'pairing address cleared');
      return send(res, 200, publicStatus());
    }
    return send(res, 404, { ok: false, error: 'not found' });
  }
  return send(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status || 500, { ok: false, error: 'gate error' });
    else res.end();
  });
});

server.on('upgrade', async (req, socket, head) => {
  const ip = clientIp(req);
  const url = req.url || '';
  if (!(await allowed(ip)) || !url.startsWith('/t') || !authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = net.connect(TTYD_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = { ...req.headers, host: `127.0.0.1:${TTYD_PORT}` };
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

async function boot() {
  let initial = '';
  try {
    const parsed = readPairingAddress(fs.readFileSync(ADDRESS_FILE, 'utf8'));
    if (!parsed.ok) log(`ignoring pairing address: ${parsed.error}`);
    else initial = parsed.address;
  } catch (err) {
    if (err.code !== 'ENOENT') log(`pairing address unreadable: ${err.message}`);
  }
  if (!initial && process.env.ORCA_PAIRING_ADDRESS) {
    const parsed = readPairingAddress(process.env.ORCA_PAIRING_ADDRESS);
    if (parsed.ok) initial = parsed.address;
    else log(`ignoring ORCA_PAIRING_ADDRESS: ${parsed.error}`);
    // Keep the poll from treating a missing file as "cleared" and stopping Orca.
    if (initial && !fs.existsSync(ADDRESS_FILE)) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(ADDRESS_FILE, `${initial}\n`, { mode: 0o600 });
    }
  }
  startTtyd();
  server.listen(PORT, BIND, () => log(`tile on ${BIND}:${PORT}`));
  if (initial) {
    await supervisor.setAddress(initial);
    log('orca starting');
  } else {
    log('waiting for a Tailscale address');
  }
  setInterval(async () => {
    let text = '';
    try {
      text = fs.readFileSync(ADDRESS_FILE, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') return;
    }
    const parsed = readPairingAddress(text);
    if (!parsed.ok) return;
    if (parsed.address !== supervisor.snapshot().address) {
      await supervisor.setAddress(parsed.address);
      log('pairing address changed on disk');
    }
  }, 2000).unref();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}, stopping`);
  if (ttyd) ttyd.kill('SIGTERM');
  await supervisor.stop();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch((err) => {
  log(err.stack || err.message);
  process.exit(1);
});
