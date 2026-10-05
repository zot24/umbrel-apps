// Cursor Sandboxes manager: the Umbrel tile and the reconciler.
//
// Node standard library only. It runs on the stock node:22-alpine image and
// ships in the app folder (like Dockyard's status.py), so changing it needs
// no image build. It drives the app's private Docker daemon over its unix
// socket and keeps one container per sandbox in step with state.json:
//
//   state.json (desired)  ->  reconcile()  ->  cs-<name> containers (actual)
//
// Every sandbox container runs the sandbox image (../sandbox), which clones
// the sandbox's repos and starts `agent worker --name <name> start`.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 7690);
// The manager's view of the private daemon's socket.
const SOCK = process.env.DOCKER_SOCK || '/sock/docker.sock';
// The same socket as a path inside the dind container: bind source for
// sandboxes created with Docker access.
const DIND_SOCK = process.env.DIND_SOCK_PATH || '/sock/docker.sock';
const STATE_DIR = process.env.STATE_DIR || '/state';
const IMAGE = normalizeRef(process.env.SANDBOX_IMAGE || '');
const CURSOR_API = process.env.CURSOR_API_URL || 'https://api.cursor.com';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const NETWORK = 'cs-net';
const RECONCILE_EVERY_MS = 60_000;

const containerName = (name) => `cs-${name}`;
const volumeName = (name) => `cs-${name}-home`;

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// "repo:tag@sha256:…" -> "repo@sha256:…". Docker stores and resolves
// digest-pinned images by repo@digest; the tag is decoration.
function normalizeRef(ref) {
  const at = ref.indexOf('@');
  if (at < 0) return ref;
  const repoTag = ref.slice(0, at);
  const colon = repoTag.indexOf(':', repoTag.lastIndexOf('/') + 1);
  return (colon < 0 ? repoTag : repoTag.slice(0, colon)) + ref.slice(at);
}

// ---------------------------------------------------------------- docker --

function dockerRequest(method, urlPath, body, { timeout = 30_000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCK,
        method,
        path: urlPath,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => {
          chunks.push(c);
          if (onData) onData(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`docker ${method} ${urlPath}: timed out`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function dockerError(res) {
  let msg = res.body.toString().trim();
  try {
    msg = JSON.parse(msg).message || msg;
  } catch {}
  const err = new Error(`docker: ${msg}`);
  err.status = res.status;
  return err;
}

async function docker(method, urlPath, body, opts) {
  const res = await dockerRequest(method, urlPath, body, opts);
  if (res.status >= 400) throw dockerError(res);
  const text = res.body.toString();
  return text ? JSON.parse(text) : null;
}

async function listManaged() {
  const filters = encodeURIComponent(JSON.stringify({ label: ['cs.managed=1'] }));
  return docker('GET', `/containers/json?all=1&filters=${filters}`);
}

// Run a command in a container and return its exit code and output. The
// exec uses a TTY so the output is one plain stream, not Docker's
// multiplexed stdout/stderr framing.
async function execIn(id, cmd, { user, env, timeout = 10_000 } = {}) {
  const ex = await docker('POST', `/containers/${id}/exec`, {
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: user,
    Env: env,
  });
  const res = await dockerRequest('POST', `/exec/${ex.Id}/start`, { Detach: false, Tty: true }, { timeout });
  if (res.status >= 400) throw dockerError(res);
  const info = await docker('GET', `/exec/${ex.Id}/json`);
  return { code: info.ExitCode, out: res.body.toString() };
}

// ----------------------------------------------------------------- state --

const DEFAULT_STATE = {
  settings: { apiKey: '', apiKeyOwner: '', githubToken: '', githubLogin: '', gitName: '', gitEmail: '' },
  sandboxes: [],
};
let state = structuredClone(DEFAULT_STATE);
// A state file we cannot parse stops all reconciling: acting on an empty
// state would delete every sandbox container.
let stateError = '';

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = {
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
      sandboxes: Array.isArray(parsed.sandboxes) ? parsed.sandboxes : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') stateError = `Cannot read ${STATE_FILE}: ${e.message}`;
  }
}

async function saveState() {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_FILE);
}

// All mutations of state or containers run one at a time.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------- reconcile --

const image = { ref: IMAGE, present: false, pulling: false, progress: 0, error: '' };
let reconcileError = '';
let reconciledAt = 0;

async function imagePresent() {
  if (!IMAGE) throw new Error('SANDBOX_IMAGE is not set in docker-compose.yml');
  try {
    await docker('GET', `/images/${encodeURIComponent(IMAGE)}/json`);
    image.present = true;
    image.error = '';
  } catch (e) {
    if (e.status !== 404) throw e;
    image.present = false;
  }
  return image.present;
}

// The first pull can take minutes, so it runs outside the serial chain:
// settings and sandboxes can be saved meanwhile, and the reconcile that
// follows a finished pull starts their containers.
let pulling = null;
function startPull() {
  pulling ??= pullImage()
    .then(() => serial(reconcile))
    .catch((e) => console.error('[pull]', e.message))
    .finally(() => {
      pulling = null;
    });
}

async function pullImage() {
  image.pulling = true;
  image.progress = 0;
  image.error = '';
  const layers = new Map();
  let buf = '';
  let streamError = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.error) streamError = ev.error;
      if (!ev.id) continue;
      const layer = layers.get(ev.id) || { current: 0, total: 0 };
      if (ev.status === 'Downloading' && ev.progressDetail?.total) {
        layer.current = ev.progressDetail.current || 0;
        layer.total = ev.progressDetail.total;
      }
      if (/^(Download complete|Pull complete|Already exists)$/.test(ev.status || '')) layer.current = layer.total;
      layers.set(ev.id, layer);
      let cur = 0;
      let tot = 0;
      for (const l of layers.values()) {
        cur += l.current;
        tot += l.total;
      }
      if (tot) image.progress = Math.min(0.99, cur / tot);
    }
  };
  try {
    const res = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(IMAGE)}`, undefined, {
      timeout: 60 * 60_000,
      onData,
    });
    if (res.status >= 400) throw dockerError(res);
    if (streamError) throw new Error(`pull ${IMAGE}: ${streamError}`);
    await docker('GET', `/images/${encodeURIComponent(IMAGE)}/json`);
    image.present = true;
    image.progress = 1;
  } catch (e) {
    image.error = e.message;
    throw e;
  } finally {
    image.pulling = false;
  }
}

async function ensureNetwork() {
  try {
    await docker('GET', `/networks/${NETWORK}`);
    return;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  // icc=false: sandboxes reach the internet but not each other. The MTU is
  // set explicitly because dockerd's --mtu covers only the default bridge,
  // and this network nests inside Umbrel's 1500-byte one.
  await docker('POST', '/networks/create', {
    Name: NETWORK,
    Driver: 'bridge',
    Options: {
      'com.docker.network.bridge.enable_icc': 'false',
      'com.docker.network.driver.mtu': '1450',
    },
    Labels: { 'cs.managed': '1' },
  });
}

// The container a sandbox should have. Its hash goes on a label; a sandbox
// whose hash changed (new image, new key, edited repos) is recreated. The
// home volume survives recreation, so checkouts and caches are kept.
function containerSpec(sb) {
  const s = state.settings;
  const env = [`CS_NAME=${sb.name}`, `CS_REPOS=${JSON.stringify(sb.repos)}`, `CURSOR_API_KEY=${s.apiKey}`];
  if (s.githubToken) env.push(`GH_TOKEN=${s.githubToken}`);
  if (s.gitName) env.push(`CS_GIT_NAME=${s.gitName}`);
  if (s.gitEmail) env.push(`CS_GIT_EMAIL=${s.gitEmail}`);
  if (sb.connectWorkspace) env.push('CS_CONNECT_WORKSPACE=1');
  const body = {
    Image: IMAGE,
    Hostname: sb.name,
    Env: env,
    Tty: true,
    Labels: { 'cs.managed': '1', 'cs.name': sb.name },
    HostConfig: {
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NETWORK,
      Mounts: [{ Type: 'volume', Source: volumeName(sb.name), Target: '/home/agent' }],
      Binds: sb.docker ? [`${DIND_SOCK}:/var/run/docker.sock`] : [],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  };
  body.Labels['cs.hash'] = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return body;
}

async function removeContainer(id) {
  await docker('DELETE', `/containers/${id}?force=1`);
}

// Each app update pins a new sandbox image digest; drop the previous ones
// (about 1.4 GB each) once no container uses them. Only digests of our own
// repository are touched: agents with Docker access build and pull images
// in this daemon too, and those are theirs to keep.
async function pruneOldSandboxImages() {
  const at = IMAGE.indexOf('@');
  if (at < 0) return; // unpinned (local dev): nothing to compare against
  const repo = IMAGE.slice(0, at);
  for (const img of await docker('GET', '/images/json')) {
    const ours = (img.RepoDigests || []).filter((d) => d.startsWith(`${repo}@`));
    if (!ours.length || ours.includes(IMAGE)) continue;
    try {
      await docker('DELETE', `/images/${img.Id}`);
      console.log(`[prune] removed old sandbox image ${ours[0]}`);
    } catch (e) {
      if (e.status !== 409) throw e; // 409: still used by a container
    }
  }
}

async function reconcile() {
  if (stateError) return;
  try {
    if (!image.present && !(await imagePresent())) {
      startPull();
      reconcileError = '';
      return;
    }
    await ensureNetwork();
    const byName = new Map((await listManaged()).map((c) => [c.Labels['cs.name'], c]));
    for (const sb of state.sandboxes) {
      const want = containerSpec(sb);
      let c = byName.get(sb.name);
      byName.delete(sb.name);
      if (c && c.Labels['cs.hash'] !== want.Labels['cs.hash']) {
        await removeContainer(c.Id);
        c = null;
      }
      if (!c) {
        if (!state.settings.apiKey) continue; // nothing can run without a key
        const created = await docker('POST', `/containers/create?name=${containerName(sb.name)}`, want);
        if (!sb.stopped) await docker('POST', `/containers/${created.Id}/start`);
        continue;
      }
      const up = c.State === 'running' || c.State === 'restarting';
      if (sb.stopped && up) await docker('POST', `/containers/${c.Id}/stop?t=20`, undefined, { timeout: 60_000 });
      if (!sb.stopped && !up) await docker('POST', `/containers/${c.Id}/start`);
    }
    // Managed containers with no sandbox behind them. Volumes are left alone.
    for (const c of byName.values()) await removeContainer(c.Id);
    await pruneOldSandboxImages();
    reconcileError = '';
  } catch (e) {
    reconcileError = e.message;
    // Image removed from the daemon behind our back: pull it again.
    if (/no such image/i.test(e.message)) image.present = false;
    console.error('[reconcile]', e.message);
  } finally {
    reconciledAt = Date.now();
  }
}

// ---------------------------------------------------------------- status --

function parseMetrics(text) {
  const sums = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+(\S+)/);
    if (m) sums[m[1]] = (sums[m[1]] || 0) + Number(m[2]);
  }
  const last = sums.cursor_self_hosted_worker_last_activity_unix_seconds;
  return {
    connected: sums.cursor_self_hosted_worker_connected === 1,
    activeSessions: sums.cursor_self_hosted_worker_session_active || 0,
    lastActivity: last ? new Date(last * 1000).toISOString() : null,
  };
}

async function sandboxStatus(sb, containers) {
  const out = {
    name: sb.name,
    repos: sb.repos,
    docker: !!sb.docker,
    connectWorkspace: !!sb.connectWorkspace,
    stopped: !!sb.stopped,
    container: null,
    worker: null,
  };
  const c = containers.find((x) => x.Labels['cs.name'] === sb.name);
  if (!c) return out;
  const info = await docker('GET', `/containers/${c.Id}/json`);
  out.container = {
    state: info.State.Status,
    health: info.State.Health?.Status || '',
    startedAt: info.State.StartedAt,
    restarts: info.RestartCount,
    exitCode: info.State.ExitCode,
    upToDate: c.Labels['cs.hash'] === containerSpec(sb).Labels['cs.hash'],
  };
  if (info.State.Running) {
    try {
      const r = await execIn(c.Id, ['curl', '-fsS', '--max-time', '3', 'http://127.0.0.1:9090/metrics']);
      if (r.code === 0) out.worker = parseMetrics(r.out);
    } catch {}
    // The last error line the entrypoint printed, if the worker is not up.
    if (!out.worker?.connected) out.lastError = await lastErrorLine(c.Id);
  } else {
    out.lastError = await lastErrorLine(c.Id);
  }
  return out;
}

async function lastErrorLine(id) {
  try {
    const res = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=50`);
    const lines = stripAnsi(res.body.toString()).split('\n').filter((l) => /error|fail|invalid|unauthori/i.test(l));
    return lines.at(-1)?.trim().slice(0, 300) || '';
  } catch {
    return '';
  }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

let statusCache = { at: 0, value: null };
async function fullStatus() {
  if (statusCache.value && Date.now() - statusCache.at < 3000) return statusCache.value;
  let sandboxes = state.sandboxes.map((sb) => ({ name: sb.name, repos: sb.repos, stopped: !!sb.stopped }));
  let daemon = '';
  try {
    const containers = await listManaged();
    sandboxes = await Promise.all(state.sandboxes.map((sb) => sandboxStatus(sb, containers)));
  } catch (e) {
    daemon = e.message;
  }
  const s = state.settings;
  const value = {
    stateError,
    daemonError: daemon,
    reconcileError,
    reconciledAt,
    image: { ...image },
    settings: {
      apiKeySet: !!s.apiKey,
      apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '',
      apiKeyOwner: s.apiKeyOwner,
      githubTokenSet: !!s.githubToken,
      githubLogin: s.githubLogin,
      gitName: s.gitName,
      gitEmail: s.gitEmail,
    },
    sandboxes,
  };
  statusCache = { at: Date.now(), value };
  return value;
}

// ------------------------------------------------------------ validation --

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const BRANCH_RE = /^(?![-/])(?!.*\.\.)(?!.*\/\/)[\w./-]{1,200}$/;

function str(v, max, label) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new UserError(`${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new UserError(`${label} is too long.`);
  if (/[\r\n\0]/.test(t)) throw new UserError(`${label} must be a single line.`);
  return t;
}

function normalizeRepo(input) {
  let url = String(input || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  // Sandboxes authenticate to GitHub over HTTPS with the token, so an SSH
  // clone URL pasted from GitHub becomes its HTTPS twin.
  url = url.replace(/^git@github\.com:/i, 'https://github.com/');
  const m = url.match(/^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/([\w./-]+?)(?:\.git)?\/?$/i);
  if (!m || m[2].split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new UserError(`"${input}" is not a repository. Use owner/repo for GitHub, or an https:// clone URL.`);
  }
  return `https://${m[1].toLowerCase()}/${m[2]}.git`;
}

function parseRepos(list) {
  if (!Array.isArray(list) || list.length === 0) throw new UserError('Add at least one repository.');
  if (list.length > 20) throw new UserError('A sandbox can serve at most 20 repositories.');
  const seen = new Set();
  return list.map((r) => {
    const url = normalizeRepo(r?.url);
    const branch = str(r?.branch, 200, 'Branch') || '';
    if (branch && !BRANCH_RE.test(branch)) throw new UserError(`"${branch}" is not a valid branch name.`);
    const dir = path.posix.basename(url, '.git');
    if (seen.has(dir)) throw new UserError(`Two repositories would share the folder "${dir}". Use separate sandboxes.`);
    seen.add(dir);
    return branch ? { url, branch } : { url };
  });
}

function findSandbox(name) {
  const sb = state.sandboxes.find((s) => s.name === name);
  if (!sb) throw new UserError(`No sandbox named "${name}".`, 404);
  return sb;
}

// ---------------------------------------------------- credential checks --

async function verifyCursorKey(key) {
  let res;
  try {
    res = await fetch(`${CURSOR_API}/v1/me`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new UserError(`Could not reach Cursor to check the key: ${e.cause?.code || e.message}`, 502);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new UserError(`Cursor rejected this key: ${body.message || res.status}.`);
  }
  if (!res.ok) throw new UserError(`Cursor answered ${res.status} while checking the key.`, 502);
  if (!body.userEmail) {
    throw new UserError('This is not a personal API key. My Machines workers need a user key from Cursor Dashboard -> API Keys.');
  }
  return body.userEmail;
}

async function verifyGithubToken(token) {
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'zot24-cursor-sandboxes' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new UserError(`Could not reach GitHub to check the token: ${e.cause?.code || e.message}`, 502);
  }
  if (res.status === 401) throw new UserError('GitHub rejected this token.');
  if (!res.ok) throw new UserError(`GitHub answered ${res.status} while checking the token.`, 502);
  return (await res.json()).login;
}

// ---------------------------------------------------------------- routes --

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new UserError('Request too large.', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new UserError('Request body is not JSON.');
  }
}

async function mutate(fn) {
  if (stateError) throw new UserError(stateError, 500);
  return serial(async () => {
    const result = await fn();
    await saveState();
    statusCache.value = null;
    await reconcile();
    if (reconcileError) throw new UserError(reconcileError, 500);
    return result;
  });
}

const routes = [
  ['GET', /^\/healthz$/, () => ({ ok: true })],

  ['GET', /^\/api\/state$/, () => fullStatus()],

  [
    'POST',
    /^\/api\/settings$/,
    async (req) => {
      const b = await readJson(req);
      const apiKey = str(b.apiKey, 500, 'Cursor API key');
      const githubToken = str(b.githubToken, 500, 'GitHub token');
      const gitName = str(b.gitName, 100, 'Commit name');
      const gitEmail = str(b.gitEmail, 200, 'Commit email');
      if (gitEmail && !/^[^\s@<>]+@[^\s@<>]+$/.test(gitEmail)) throw new UserError('Commit email does not look like an email.');
      // Check credentials before touching state: a bad key never lands.
      const apiKeyOwner = apiKey ? await verifyCursorKey(apiKey) : undefined;
      const githubLogin = githubToken ? await verifyGithubToken(githubToken) : undefined;
      return mutate(() => {
        const s = state.settings;
        if (apiKey) Object.assign(s, { apiKey, apiKeyOwner });
        if (githubToken) Object.assign(s, { githubToken, githubLogin });
        if (b.clearGithubToken === true) Object.assign(s, { githubToken: '', githubLogin: '' });
        if (gitName !== undefined) s.gitName = gitName;
        if (gitEmail !== undefined) s.gitEmail = gitEmail;
        return { ok: true, apiKeyOwner: s.apiKeyOwner, githubLogin: s.githubLogin };
      });
    },
  ],

  [
    'POST',
    /^\/api\/sandboxes$/,
    async (req) => {
      const b = await readJson(req);
      const name = str(b.name, 32, 'Name') || '';
      if (!NAME_RE.test(name)) {
        throw new UserError('Name: 1-32 lowercase letters, digits and dashes, starting and ending with a letter or digit.');
      }
      const repos = parseRepos(b.repos);
      if (!state.settings.apiKey) throw new UserError('Add your Cursor API key first.');
      return mutate(() => {
        if (state.sandboxes.some((s) => s.name === name)) throw new UserError(`A sandbox named "${name}" already exists.`, 409);
        state.sandboxes.push({
          name,
          repos,
          docker: b.docker === true,
          connectWorkspace: b.connectWorkspace === true,
          createdAt: new Date().toISOString(),
        });
        return { ok: true };
      });
    },
  ],

  [
    'POST',
    /^\/api\/sandboxes\/([a-z0-9-]+)$/,
    async (req, [, name]) => {
      const b = await readJson(req);
      const repos = b.repos === undefined ? undefined : parseRepos(b.repos);
      return mutate(() => {
        const sb = findSandbox(name);
        if (repos) sb.repos = repos;
        if (typeof b.docker === 'boolean') sb.docker = b.docker;
        if (typeof b.connectWorkspace === 'boolean') sb.connectWorkspace = b.connectWorkspace;
        return { ok: true };
      });
    },
  ],

  [
    'POST',
    /^\/api\/sandboxes\/([a-z0-9-]+)\/(start|stop)$/,
    async (_req, [, name, action]) =>
      mutate(() => {
        findSandbox(name).stopped = action === 'stop';
        return { ok: true };
      }),
  ],

  [
    'POST',
    /^\/api\/sandboxes\/([a-z0-9-]+)\/restart$/,
    async (_req, [, name]) =>
      serial(async () => {
        const sb = findSandbox(name);
        const c = (await listManaged()).find((x) => x.Labels['cs.name'] === sb.name);
        if (!c) throw new UserError('This sandbox has no container yet.', 409);
        await docker('POST', `/containers/${c.Id}/restart?t=20`, undefined, { timeout: 60_000 });
        sb.stopped = false;
        await saveState();
        statusCache.value = null;
        return { ok: true };
      }),
  ],

  [
    'DELETE',
    /^\/api\/sandboxes\/([a-z0-9-]+)$/,
    async (_req, [, name]) =>
      mutate(async () => {
        findSandbox(name);
        state.sandboxes = state.sandboxes.filter((s) => s.name !== name);
        const c = (await listManaged()).find((x) => x.Labels['cs.name'] === name);
        if (c) await removeContainer(c.Id);
        try {
          await docker('DELETE', `/volumes/${volumeName(name)}`);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
        return { ok: true };
      }),
  ],

  [
    'GET',
    /^\/api\/sandboxes\/([a-z0-9-]+)\/logs$/,
    async (_req, [, name]) => {
      findSandbox(name);
      const c = (await listManaged()).find((x) => x.Labels['cs.name'] === name);
      if (!c) return { logs: '' };
      const res = await dockerRequest('GET', `/containers/${c.Id}/logs?stdout=1&stderr=1&tail=400`);
      if (res.status >= 400) throw dockerError(res);
      return { logs: stripAnsi(res.body.toString()) };
    },
  ],

  [
    'POST',
    /^\/api\/sandboxes\/([a-z0-9-]+)\/diagnose$/,
    async (_req, [, name]) => {
      const sb = findSandbox(name);
      const c = (await listManaged()).find((x) => x.Labels['cs.name'] === name);
      if (!c || c.State !== 'running') throw new UserError('Start the sandbox to run diagnostics.', 409);
      const dirs = sb.repos.flatMap((r) => ['--worker-dir', `/home/agent/work/${path.posix.basename(r.url, '.git')}`]);
      const r = await execIn(c.Id, ['agent', 'worker', '--name', sb.name, ...dirs, 'debug'], {
        user: 'agent',
        env: ['HOME=/home/agent'],
        timeout: 120_000,
      });
      return { code: r.code, output: stripAnsi(r.out) };
    },
  ],
];

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, await readFile(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }
    // Writes need the custom header. A cross-site page cannot send it
    // without a CORS preflight, which this server never approves.
    if (req.method !== 'GET' && req.headers['x-cs-request'] !== '1') throw new UserError('Missing request header.', 403);
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(200, await handler(req, m));
    }
    throw new UserError('Not found.', 404);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    if (!(e instanceof UserError)) console.error(`[${req.method} ${req.url}]`, e);
    send(status, { error: e.message });
  }
});

await loadState();
if (stateError) console.error(stateError);
server.listen(PORT, () => console.log(`cursor-sandboxes manager on :${PORT}, image ${IMAGE || '(unset)'}`));
// First reconcile pulls the sandbox image (can take minutes); the UI shows
// progress meanwhile. Afterwards, keep containers in step every minute.
serial(reconcile);
setInterval(() => serial(reconcile), RECONCILE_EVERY_MS).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
