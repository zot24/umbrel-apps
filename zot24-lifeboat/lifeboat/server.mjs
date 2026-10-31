import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import { RESTORES, STALE_AFTER, backup, clearLock, currentJob, drill, log, missingSettings, nextRun, readState, restore, snapshots, updateState } from './lib.mjs';
import { sourceProject } from './source.mjs';
import { setting } from './util.mjs';

const PORT = 7746;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const WEBHOOK = setting('LIFEBOAT_ALERT_WEBHOOK');

async function status() {
  const s = await readState();
  const since = Date.parse(s.lastSuccessAt ?? s.firstStartAt ?? new Date().toISOString());
  return {
    project: sourceProject(),
    missing: missingSettings(),
    nextRun: nextRun().toISOString(),
    running: await currentJob(),
    lastSuccessAt: s.lastSuccessAt ?? null,
    stale: Date.now() - since > STALE_AFTER,
    backup: s.backup ?? null,
    drill: s.drill ?? null,
    restore: s.restore ?? null,
  };
}

async function checkAlert() {
  const st = await status();
  if (!st.stale) return;
  const { alertedAt } = await readState();
  if (alertedAt && alertedAt > (st.lastSuccessAt ?? '') && Date.now() - Date.parse(alertedAt) < 86_400_000) return;
  const text = `Lifeboat: no successful backup of ${st.project} in over 26 hours (last success: ${st.lastSuccessAt ?? 'never'}).` +
    (st.backup?.error ? ` Last error: ${st.backup.error}` : '');
  log(`ALERT ${text}`);
  if (WEBHOOK) {
    const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch((e) => e);
    if (!res.ok) return log(`alert webhook failed: ${res.status ?? res.message}`);
  }
  await updateState({ alertedAt: new Date().toISOString() });
}

// A scheduled run waits up to an hour for a drill or restore to finish.
async function scheduledBackup() {
  for (let i = 0; i < 12; i++) {
    try {
      return await backup();
    } catch (e) {
      if (!e.busy) return;
      await new Promise((r) => setTimeout(r, 5 * 60_000));
    }
  }
}

function schedule() {
  setTimeout(() => scheduledBackup().finally(schedule), nextRun() - Date.now());
}

const ago = (iso) => {
  if (!iso) return 'never';
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

// Umbrel home-screen widget: the closest native surface to a notification.
async function widget() {
  const st = await status();
  const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return {
    type: 'four-stats',
    refresh: '1m',
    link: '',
    items: [
      { title: 'Status', text: st.stale ? 'OVERDUE' : st.backup?.ok === false ? 'FAILED' : 'OK', subtext: st.running ? st.running.kind : '' },
      { title: 'Last backup', text: ago(st.lastSuccessAt), subtext: st.lastSuccessAt ? 'ago' : '' },
      { title: 'Next run', text: time(st.nextRun), subtext: 'Asuncion' },
      { title: 'Last drill', text: st.drill ? (st.drill.ok ? 'passed' : 'failed') : 'never', subtext: st.drill ? `${ago(st.drill.finishedAt)} ago` : '' },
    ],
  };
}

// Only the app proxy (Umbrel login), the Umbrel host (widgets) and loopback may connect.
const PEERS = new Set(['127.0.0.1', '::1']);
try {
  for (const line of readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)) {
    const gw = line.trim().split(/\s+/)[2];
    if (gw && gw !== '00000000' && gw.length === 8) PEERS.add(Buffer.from(gw, 'hex').reverse().join('.'));
  }
} catch {}
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || '';
let proxyIps = new Set();
let lookedUpAt = 0;
async function allowed(ip) {
  if (PEERS.has(ip) || proxyIps.has(ip)) return true;
  if (APP_PROXY_HOST && Date.now() - lookedUpAt > 2000) {
    lookedUpAt = Date.now();
    proxyIps = new Set((await lookup(APP_PROXY_HOST, { all: true }).catch(() => [])).map((a) => a.address));
  }
  return proxyIps.has(ip);
}

const body = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', () => resolve(JSON.parse(data || '{}')));
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function start(fn) {
  const running = await currentJob();
  if (running) throw httpError(409, `busy: a ${running.kind} is running`);
  fn().catch(() => {});
  return { started: true };
}

const routes = {
  'GET /api/status': status,
  'GET /api/snapshots': () => snapshots(),
  'GET /widgets/status': widget,
  'POST /api/drill': () => start(drill),
  'POST /api/restore': async (req) => {
    const { snapshot, targetUrl, folder } = await body(req);
    if (!/^[\w.-]+$/.test(folder ?? '') || folder.startsWith('.')) throw httpError(400, 'folder: letters, digits, dot, dash and underscore only');
    if (!/^postgres(ql)?:\/\//.test(targetUrl ?? '')) throw httpError(400, 'target must be a postgres:// URL');
    return start(() => restore(snapshot || 'latest', targetUrl, path.join(RESTORES, folder)));
  },
};

http.createServer(async (req, res) => {
  const send = (code, data, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  try {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!(await allowed(ip))) return send(403, { error: 'forbidden' });
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && pathname === '/') return send(200, await readFile(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/healthz') return send(200, { ok: true });
    // A cross-site page cannot set this header without a preflight, which is never approved.
    if (req.method !== 'GET' && req.headers['x-lifeboat'] !== '1') return send(403, { error: 'missing header' });
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return send(404, { error: 'not found' });
    return send(200, await route(req));
  } catch (e) {
    if (!e.status) log(`[${req.method} ${req.url}] ${e.message}`);
    send(e.status ?? 500, { error: e.message });
  }
}).listen(PORT, () => log(`lifeboat listening on ${PORT}; next backup ${nextRun().toISOString()}`));

await clearLock();
if (!(await readState()).firstStartAt) await updateState({ firstStartAt: new Date().toISOString() });
schedule();
setInterval(() => checkAlert().catch((e) => log(`alert check: ${e.message}`)), 10 * 60_000);
setTimeout(() => checkAlert().catch(() => {}), 60_000);
