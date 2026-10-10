// GitHub Runner manager: the Umbrel tile and the scheduler.
//
// Node standard library only. The code is baked into
// ghcr.io/zot24/github-runner-manager (manager/Dockerfile), because an Umbrel
// app update does not refresh arbitrary files under the app data dir.
//
// Every POLL_MS it asks GitHub whether any selected private repository has a
// queued job for `runs-on: [self-hosted, umbrel]`. For each one, up to the
// concurrency cap, it mints a just-in-time runner registration for that repo
// and starts a fresh container from the official runner image inside the
// app's private Docker daemon:
//
//   GitHub queue  ->  tick()  ->  generate-jitconfig  ->  ghr-<runner> container
//
// The runner takes one job and exits (JIT runners are ephemeral). The
// manager records the result, removes the container and its work folder,
// and the next queued job gets a new container. The GitHub token never
// leaves this process: a runner only gets its own single-use JIT config.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { chown, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_RUNNERS,
  MAX_RUNNERS_LIMIT,
  RUNNER_NAME_RE,
  backoffMs,
  demuxDockerLogs,
  forkHead,
  jobLimits,
  jobWantsUs,
  normalizeRepo,
  parseRunnerLog,
  planSpawns,
  reapReason,
  runnerLabels,
  stripAnsi,
  tokenKind,
} from './lib.mjs';

const PORT = Number(process.env.PORT || 3500);
// The manager's view of the private daemon's socket.
const SOCK = process.env.DOCKER_SOCK || '/sock/docker.sock';
// The same socket as a path inside the dind container: bind source for
// runners when Docker for jobs is on.
const DIND_SOCK = process.env.DIND_SOCK_PATH || '/sock/docker.sock';
const STATE_DIR = process.env.STATE_DIR || '/state';
// Job work folders. Mounted at the SAME path in dind and in this container,
// so a path the runner hands to Docker (container jobs bind-mount the
// workspace) means the same directory to the daemon.
const WORK_DIR = process.env.WORK_DIR || '/ghr';
// The manager's view of dind's /home/runner/externals (see ensureExternals).
const EXTERNALS_DIR = process.env.EXTERNALS_DIR || '/externals';
const IMAGE = normalizeRef(process.env.RUNNER_IMAGE || '');
const GITHUB_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const POLL_MS = Number(process.env.POLL_MS || 15_000);
// A runner that has not picked up a job by then is deregistered and removed.
const IDLE_MS = Number(process.env.IDLE_TIMEOUT_MS || 10 * 60_000);
// Hard stop for one job. GitHub's own default `timeout-minutes` is 360.
const MAX_JOB_MS = Number(process.env.MAX_JOB_MS || 6 * 3600_000 + 10 * 60_000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const NETWORK = 'ghr-net';
// `runner` in ghcr.io/actions/actions-runner. Overridable only so
// test/scheduler.test.mjs can run the manager as an ordinary user.
const RUNNER_UID = Number(process.env.RUNNER_UID || 1001);
const RUNNER_GID = Number(process.env.RUNNER_GID || RUNNER_UID);
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const LABELS = runnerLabels(ARCH);
const HISTORY_MAX = 50;
const ORPHAN_SWEEP_MS = 60 * 60_000;
// How often a registration GitHub would not delete yet is asked for again.
const DEREG_RETRY_MS = 4 * POLL_MS;
const IMAGE_PRUNE_MS = 24 * 3600_000;

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

const q = (obj) => encodeURIComponent(JSON.stringify(obj));

async function listRunnerContainers() {
  return docker('GET', `/containers/json?all=1&filters=${q({ label: ['ghr.runner=1'] })}`);
}

async function containerLogs(id, tail = 400) {
  const res = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`);
  if (res.status >= 400) throw dockerError(res);
  return stripAnsi(demuxDockerLogs(res.body));
}

async function removeContainer(id) {
  try {
    await docker('DELETE', `/containers/${id}?force=1`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

// ----------------------------------------------------------------- state --

const DEFAULT_STATE = {
  settings: {
    token: '',
    tokenLogin: '',
    tokenExpires: '',
    maxRunners: DEFAULT_MAX_RUNNERS,
    dockerForJobs: false,
    paused: false,
  },
  repos: [],
  history: [],
  prunedAt: 0,
};
let state = structuredClone(DEFAULT_STATE);
// A state file we cannot parse stops all scheduling: acting on an empty
// state would deregister and remove every runner.
let stateError = '';

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = {
      ...DEFAULT_STATE,
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
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

// All scheduling and every mutation run one at a time.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- github --

class GitHubError extends Error {
  constructor(message, status, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// GET responses are cached by URL with their ETag. GitHub answers an
// unchanged resource with 304, and a 304 does not count against the rate
// limit, so polling an idle repository every few seconds is nearly free.
const etags = new Map();
const rate = { limit: 0, remaining: null, reset: 0 };
// Set when GitHub refuses the token outright; nothing runs until it changes.
let tokenError = '';

async function gh(method, urlPath, body, { token = state.settings.token } = {}) {
  const url = `${GITHUB_API}${urlPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'zot24-github-runner',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const cached = method === 'GET' ? etags.get(url) : undefined;
  if (cached) headers['If-None-Match'] = cached.etag;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new GitHubError(`Could not reach GitHub: ${e.cause?.code || e.message}`, 0);
  }
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    rate.remaining = Number(remaining);
    rate.limit = Number(res.headers.get('x-ratelimit-limit') || 0);
    rate.reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
  }
  if (res.status === 304 && cached) return cached.body;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new GitHubError(githubMessage(res, data), res.status, res.headers);
  if (method === 'GET' && res.headers.get('etag')) {
    if (etags.size > 1000) etags.clear();
    etags.set(url, { etag: res.headers.get('etag'), body: data });
  }
  return data;
}

function githubMessage(res, data) {
  const msg = data?.message || `HTTP ${res.status}`;
  if (res.status === 401) return `GitHub rejected the token (${msg}). It may have expired or been revoked.`;
  const need = res.headers.get('x-accepted-github-permissions');
  if (res.status === 403 && need) return `The token is missing a permission GitHub needs here (${need}).`;
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'GitHub API rate limit reached; waiting for it to reset.';
  if (res.status === 404) return 'Not found, or the token cannot see it.';
  return `GitHub: ${msg}`;
}

// Stop using a refused token at once, so a revoked or expired token does
// not keep hammering the API from every repo every few seconds.
function noteTokenFailure(e) {
  if (e instanceof GitHubError && e.status === 401) tokenError = e.message;
}

async function deleteRegistration(repo, runnerId) {
  try {
    await gh('DELETE', `/repos/${repo}/actions/runners/${runnerId}`);
    return 'deleted';
  } catch (e) {
    if (e.status === 404) return 'gone';
    if (e.status === 422) return 'busy'; // still running a job
    throw e;
  }
}

// ------------------------------------------------------- runner image ----

const image = { ref: IMAGE, present: false, pulling: false, progress: 0, error: '' };

async function imagePresent() {
  if (!IMAGE) throw new Error('RUNNER_IMAGE is not set in docker-compose.yml');
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

// The first pull (about 500 MB) runs outside the serial chain, so the token
// and repositories can be set up meanwhile.
let pulling = null;
function startPull() {
  pulling ??= pullImage()
    .then(() => serial(tick))
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
  // icc=false: concurrent runners reach the internet but not each other.
  // The MTU leaves headroom under the network this daemon nests in.
  await docker('POST', '/networks/create', {
    Name: NETWORK,
    Driver: 'bridge',
    Options: {
      'com.docker.network.bridge.enable_icc': 'false',
      'com.docker.network.driver.mtu': '1450',
    },
    Labels: { 'ghr.managed': '1' },
  });
}

// Container jobs and Docker container actions mount the runner's externals
// (the Node.js builds JavaScript actions run on) from /home/runner/externals
// as the DAEMON sees it, that is inside dind. dind has that path as a
// volume; fill it from the runner image once per image digest.
async function ensureExternals() {
  const marker = path.join(EXTERNALS_DIR, '.ghr-image');
  const have = await readFile(marker, 'utf8').catch(() => '');
  if (have.trim() === IMAGE) return;
  console.log('[externals] copying runner externals into the private daemon');
  const created = await docker('POST', '/containers/create', {
    Image: IMAGE,
    User: 'root',
    Entrypoint: ['bash', '-c'],
    Cmd: ['set -e; find /out -mindepth 1 -delete; cp -a /home/runner/externals/. /out/; printf %s "$GHR_IMAGE" > /out/.ghr-image'],
    Env: [`GHR_IMAGE=${IMAGE}`],
    Labels: { 'ghr.managed': '1' },
    HostConfig: { Binds: ['/home/runner/externals:/out'], NetworkMode: 'none' },
  });
  try {
    await docker('POST', `/containers/${created.Id}/start`);
    const r = await docker('POST', `/containers/${created.Id}/wait`, undefined, { timeout: 5 * 60_000 });
    if (r.StatusCode !== 0) throw new Error(`copying runner externals failed: ${(await containerLogs(created.Id, 20)).trim()}`);
  } finally {
    await removeContainer(created.Id);
  }
}

// ------------------------------------------------------------- daemon ----

const host = { ncpu: 0, memBytes: 0 };
let daemonError = '';

async function readDaemonInfo() {
  const info = await docker('GET', '/info');
  host.ncpu = info.NCPU;
  host.memBytes = info.MemTotal;
}

function limits() {
  return jobLimits({ ncpu: host.ncpu, memBytes: host.memBytes, maxRunners: state.settings.maxRunners });
}

function socketGid() {
  try {
    return statSync(SOCK).gid;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------- runners --

// Live view of each selected repo: privacy, queue, errors. Not persisted.
const repoStatus = new Map();
const repoBackoff = new Map(); // repo -> { failures, until }
let alive = []; // runners with a running container, refreshed every tick
let tickError = '';
let tickAt = 0;
let orphansSweptAt = 0;

function runnerOf(c, parsed) {
  const L = c.Labels;
  return {
    id: c.Id,
    name: L['ghr.name'],
    repo: L['ghr.repo'],
    runnerId: L['ghr.runner-id'],
    createdAt: Number(L['ghr.created']) || c.Created * 1000,
    docker: L['ghr.docker'] === '1',
    state: c.State,
    connected: parsed.connected,
    listening: parsed.listening,
    busy: !!parsed.job && !parsed.result,
    job: parsed.job || '',
    jobStartedAt: parsed.jobStartedAt || '',
    result: parsed.result || '',
  };
}

function workDirOf(name) {
  return path.join(WORK_DIR, name);
}

async function spawn(repo) {
  const name = `umbrel-${randomBytes(4).toString('hex')}`;
  const workDir = workDirOf(name);
  await mkdir(workDir, { recursive: true });
  await chown(workDir, RUNNER_UID, RUNNER_GID);
  const jit = await gh('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, {
    name,
    runner_group_id: 1,
    labels: LABELS,
    work_folder: workDir,
  });
  const lim = limits();
  const withDocker = !!state.settings.dockerForJobs;
  const spec = {
    Image: IMAGE,
    User: 'runner',
    WorkingDir: '/home/runner',
    Cmd: ['/home/runner/run.sh'],
    // The runner reads its JIT config from here, masks it, and removes it
    // from the environment its jobs inherit.
    Env: [`ACTIONS_RUNNER_INPUT_JITCONFIG=${jit.encoded_jit_config}`, 'ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=0'],
    Labels: {
      'ghr.managed': '1',
      'ghr.runner': '1',
      'ghr.name': name,
      'ghr.repo': repo,
      'ghr.runner-id': String(jit.runner.id),
      'ghr.created': String(Date.now()),
      'ghr.docker': withDocker ? '1' : '0',
    },
    HostConfig: {
      Init: true,
      // Without Docker: the isolated ghr-net. With Docker: the daemon's own
      // network namespace, so `services:` ports published by the job are on
      // localhost, as on a GitHub-hosted runner.
      NetworkMode: withDocker ? 'host' : NETWORK,
      NanoCpus: Math.round(lim.cpus * 1e9),
      Memory: lim.memory,
      MemorySwap: lim.memory,
      PidsLimit: lim.pids,
      ShmSize: lim.shm,
      Binds: [`${workDir}:${workDir}`, ...(withDocker ? [`${DIND_SOCK}:/var/run/docker.sock`] : [])],
      GroupAdd: withDocker ? [String(socketGid())] : [],
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  };
  if (!withDocker) spec.Hostname = name;
  try {
    const created = await docker('POST', `/containers/create?name=ghr-${name}`, spec);
    await docker('POST', `/containers/${created.Id}/start`);
    console.log(`[spawn] ${name} for ${repo} (runner ${jit.runner.id})`);
  } catch (e) {
    await deleteRegistration(repo, jit.runner.id).catch(() => {});
    await rm(workDir, { recursive: true, force: true });
    throw e;
  }
}

// A runner whose container has exited: record what it did, free its
// registration if it never ran a job, and wipe its container and work dir.
async function finish(c, parsed, reason = '', deregistered = false) {
  const r = runnerOf(c, parsed);
  let logs = '';
  try {
    logs = await containerLogs(c.Id, 40);
  } catch {}
  const ranJob = !!r.job;
  if (!ranJob && !deregistered) {
    // An ephemeral registration that never took a job can linger as an
    // offline runner; remove it now rather than wait a day for GitHub to.
    await deleteRegistration(r.repo, r.runnerId).catch((e) => console.error('[finish]', r.name, e.message));
  }
  const forced = { timeout: 'TimedOut', stopped: 'Stopped', public: 'RepoPublic' }[reason];
  const result = forced || r.result || (ranJob ? 'Lost' : reason === 'idle' ? 'Unused' : 'NoJob');
  const b = repoBackoff.get(r.repo) || { failures: 0, until: 0 };
  if (result === 'NoJob') {
    b.failures += 1;
    b.until = Date.now() + backoffMs(b.failures);
  } else if (ranJob) {
    b.failures = 0;
    b.until = 0;
  }
  repoBackoff.set(r.repo, b);
  // An idle runner removed on schedule is not news; everything else is.
  if (result !== 'Unused') {
    state.history.unshift({
      runner: r.name,
      repo: r.repo,
      job: r.job,
      result,
      createdAt: new Date(r.createdAt).toISOString(),
      jobStartedAt: r.jobStartedAt,
      finishedAt: parsed.jobFinishedAt || new Date().toISOString(),
      docker: r.docker,
      tail: result === 'Succeeded' ? '' : logs.trim().split('\n').slice(-25).join('\n'),
    });
    state.history.length = Math.min(state.history.length, HISTORY_MAX);
    await saveState();
  }
  await removeContainer(c.Id);
  await rm(workDirOf(r.name), { recursive: true, force: true });
  console.log(`[done] ${r.name} ${r.repo}: ${result}${r.job ? ` (${r.job})` : ''}`);
}

// Reads every runner container. Exited ones are finished; the rest are the
// live set the scheduler plans against.
async function collect() {
  const next = [];
  for (const c of await listRunnerContainers()) {
    let parsed = {};
    try {
      parsed = parseRunnerLog(await containerLogs(c.Id));
    } catch {}
    if (c.State === 'running' || c.State === 'restarting') next.push({ c, parsed, ...runnerOf(c, parsed) });
    else await finish(c, parsed);
  }
  alive = next;
}

// Registrations whose container is gone but GitHub did not let us delete:
// it refuses (422) while it still counts the runner as busy, which lasts
// until it notices the job's runner is gone, and it cannot be asked at all
// in an outage. Asked again every DEREG_RETRY_MS until deleted or gone.
// Not persisted: after a restart GitHub's own expiry (about a day) applies.
const leftovers = new Map(); // `${repo}#${runnerId}` -> { repo, runnerId, name, triedAt }

async function retryLeftovers() {
  for (const [key, x] of leftovers) {
    if (Date.now() - x.triedAt < DEREG_RETRY_MS) continue;
    x.triedAt = Date.now();
    try {
      const res = await deleteRegistration(x.repo, x.runnerId);
      if (res === 'busy') continue;
      leftovers.delete(key);
      console.log(`[deregister] ${x.name} ${x.repo}: ${res === 'deleted' ? 'removed from GitHub' : 'already gone'}`);
    } catch (e) {
      noteTokenFailure(e);
      console.error('[deregister]', x.name, e.message);
    }
  }
}

// Deregister first: if GitHub says the runner is busy, it just took a job,
// so an idle stop leaves it alone. Any other stop kills the container
// anyway, and a registration GitHub would not delete yet is retried
// (leftovers above).
async function stopRunner(r, reason) {
  let reg = '';
  try {
    reg = await deleteRegistration(r.repo, r.runnerId);
  } catch (e) {
    noteTokenFailure(e);
    console.error('[stop]', r.name, e.message);
  }
  if (reg === 'busy' && reason === 'idle') return false;
  await docker('POST', `/containers/${r.id}/kill`).catch(() => {});
  const deregistered = reg === 'deleted' || reg === 'gone';
  if (!deregistered) leftovers.set(`${r.repo}#${r.runnerId}`, { repo: r.repo, runnerId: r.runnerId, name: r.name, triedAt: Date.now() });
  await finish(r.c, r.parsed, reason, deregistered);
  alive = alive.filter((x) => x.id !== r.id);
  return true;
}

const servedRepo = (name) => state.repos.find((r) => r.name === name);

// The repos the scheduler may serve right now: selected, not stopped for
// going public, and private as of the latest poll.
function servable(repo) {
  return !!servedRepo(repo) && !servedRepo(repo).publicAt && repoStatus.get(repo)?.private === true;
}

// A served repository that is no longer private: its runners are stopped
// and deregistered now, one in the middle of a job included (GitHub fails
// that job), and it gets no runner again until the owner re-enables it on
// the page, which checks that it is private again. Kept in state.json, so
// a restart does not serve it either.
async function wentPublic(name) {
  const entry = servedRepo(name);
  if (!entry || entry.publicAt) return;
  entry.publicAt = new Date().toISOString();
  await saveState();
  const mine = alive.filter((x) => x.repo === name);
  console.log(`[public] ${name} is no longer private: stopping its ${mine.length} runner(s); not served until re-enabled`);
  for (const r of mine) await stopRunner(r, 'public');
}

const PUBLIC_ERROR =
  'Made public: its runners were stopped and removed from GitHub. It is not served again until it is private and you re-enable it here.';

// A skipped fork job waits in GitHub's queue and is seen on every poll; log
// it once. Only ids, names, labels and repository names: nothing secret.
const forkJobsLogged = new Set();
function logForkJob(repo, run, job, why) {
  if (forkJobsLogged.has(job.id)) return;
  if (forkJobsLogged.size > 10_000) forkJobsLogged.clear();
  forkJobsLogged.add(job.id);
  console.log(
    `[fork] ${repo}: skipped queued job ${job.id} ${JSON.stringify(job.name || '')} ` +
      `(run ${run.id}, ${run.event || 'unknown'} event, labels ${JSON.stringify(job.labels || [])}): ${why}`,
  );
}

// One poll of a served repository: its visibility, then (with `queue`) its
// queued jobs. A poll that fails starts nothing (queued 0).
async function pollRepo(repo, { queue = true } = {}) {
  const st = repoStatus.get(repo) || {};
  repoStatus.set(repo, st);
  try {
    // Visibility on every poll, before the queue, so a repository made
    // public is not served from the next poll on. The read is ETag-cached:
    // while nothing changes GitHub answers 304, which costs no rate limit.
    const info = await gh('GET', `/repos/${repo}`);
    st.private = info.private === true;
    if (!st.private) {
      Object.assign(st, { queued: 0, forks: 0, oldestQueuedAt: '', error: PUBLIC_ERROR });
      await wentPublic(repo);
      return;
    }
    if (!queue) {
      Object.assign(st, { queued: 0, forks: 0, oldestQueuedAt: '', error: '' });
      return;
    }
    let queued = 0;
    let forks = 0;
    let oldest = '';
    // A run is `queued` until its first job starts and `in_progress` after,
    // while later jobs in it can still be waiting for a runner.
    for (const status of ['queued', 'in_progress']) {
      const runs = await gh('GET', `/repos/${repo}/actions/runs?status=${status}&per_page=30`);
      for (const run of runs?.workflow_runs || []) {
        const fork = forkHead(run);
        const jobs = await gh('GET', `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        for (const j of jobs?.jobs || []) {
          if (j.status !== 'queued') continue;
          // Never a fork's code, whatever the job's labels.
          if (fork) {
            logForkJob(repo, run, j, fork);
            if (jobWantsUs(j.labels, LABELS)) forks += 1;
            continue;
          }
          if (!jobWantsUs(j.labels, LABELS)) continue;
          queued += 1;
          if (!oldest || (j.created_at || '') < oldest) oldest = j.created_at || '';
        }
      }
    }
    Object.assign(st, { queued, forks, oldestQueuedAt: oldest, error: '', polledAt: Date.now() });
  } catch (e) {
    noteTokenFailure(e);
    Object.assign(st, { queued: 0, error: e.message });
  }
}

// Registrations named like ours that GitHub still lists as offline, with no
// container behind them: left over from a crash or a stopped app. Ephemeral
// runners would vanish on their own after a day; this is sooner.
async function sweepOrphans() {
  const mine = new Set(alive.map((r) => r.name));
  for (const repo of state.repos.map((r) => r.name)) {
    if (!servable(repo)) continue;
    try {
      const list = await gh('GET', `/repos/${repo}/actions/runners?per_page=100`);
      for (const r of list?.runners || []) {
        if (!RUNNER_NAME_RE.test(r.name) || mine.has(r.name) || r.busy || r.status !== 'offline') continue;
        await deleteRegistration(repo, r.id);
        console.log(`[sweep] removed stale registration ${r.name} from ${repo}`);
      }
    } catch (e) {
      noteTokenFailure(e);
      console.error('[sweep]', repo, e.message);
    }
  }
}

// When no job is running, clear what jobs with Docker access left in the
// private daemon (stray containers, networks, volumes), orphaned work dirs,
// and once a day every image except the runner's own.
async function housekeeping() {
  const live = new Set(alive.map((r) => r.name));
  for (const dir of await readdir(WORK_DIR).catch(() => [])) {
    if (!live.has(dir)) await rm(path.join(WORK_DIR, dir), { recursive: true, force: true });
  }
  if (alive.length) return;
  for (const c of await docker('GET', '/containers/json?all=1')) {
    if (!c.Labels?.['ghr.managed']) await removeContainer(c.Id);
  }
  await docker('POST', `/networks/prune?filters=${q({ 'label!': ['ghr.managed=1'] })}`);
  await docker('POST', `/volumes/prune?filters=${q({ all: ['true'] })}`);
  if (Date.now() - (state.prunedAt || 0) < IMAGE_PRUNE_MS) return;
  for (const img of await docker('GET', '/images/json')) {
    if ((img.RepoDigests || []).includes(IMAGE) || (img.RepoTags || []).includes(IMAGE)) continue;
    try {
      await docker('DELETE', `/images/${img.Id}`);
      console.log(`[prune] removed image ${(img.RepoDigests || [])[0] || (img.RepoTags || [])[0] || img.Id}`);
    } catch (e) {
      if (e.status !== 409) throw e; // in use
    }
  }
  await docker('POST', '/build/prune?all=1').catch(() => {});
  state.prunedAt = Date.now();
  await saveState();
}

function active() {
  const s = state.settings;
  return !!s.token && !s.paused && !tokenError;
}

async function tick() {
  if (stateError) return;
  try {
    try {
      await readDaemonInfo();
      daemonError = '';
    } catch (e) {
      daemonError = e.message;
      return;
    }
    if (!image.present && !(await imagePresent())) {
      startPull();
      tickError = '';
      return;
    }
    await ensureNetwork();
    if (state.settings.dockerForJobs) await ensureExternals();
    await collect();

    // Every pass re-reads each served repo's visibility. While paused, only
    // repos that still have a runner up are read, and their queues are not.
    // A repo that went public is not read at all until it is re-enabled.
    if (state.settings.token && !tokenError) {
      for (const r of state.repos) {
        if (r.publicAt) continue;
        if (active() || alive.some((x) => x.repo === r.name)) await pollRepo(r.name, { queue: active() });
      }
      await retryLeftovers();
    }
    for (const name of [...repoStatus.keys()]) if (!state.repos.some((r) => r.name === name)) repoStatus.delete(name);

    // Every runner of a repo that went public goes, busy or not. Idle
    // runners go when the app is paused, the token is gone, their repo was
    // removed, or nobody gave them a job in time.
    for (const r of [...alive]) {
      let reason = reapReason(r, { idleMs: IDLE_MS, maxJobMs: MAX_JOB_MS });
      if (!reason && servedRepo(r.repo)?.publicAt) reason = 'public';
      if (!reason && !r.busy && (!active() || !servable(r.repo))) reason = 'idle';
      if (reason) await stopRunner(r, reason);
    }

    if (active()) {
      const plan = planSpawns({
        repos: state.repos
          .filter((r) => servable(r.name))
          .map((r) => {
            const st = repoStatus.get(r.name);
            return { name: r.name, queued: st.queued || 0, oldestQueuedAt: st.oldestQueuedAt, blockedUntil: repoBackoff.get(r.name)?.until || 0 };
          }),
        // GitHub's job list can still say `queued` for a few seconds after
        // a runner took the job. A job that started that recently still
        // covers one queued entry, so it does not get a second runner.
        runners: alive.map((r) => ({
          repo: r.repo,
          busy: r.busy && Date.now() - Date.parse(r.jobStartedAt) > 2 * POLL_MS,
        })),
        maxRunners: state.settings.maxRunners,
      });
      for (const repo of plan) {
        try {
          await spawn(repo);
        } catch (e) {
          noteTokenFailure(e);
          const st = repoStatus.get(repo);
          if (st) st.error = `Could not start a runner: ${e.message}`;
          const b = repoBackoff.get(repo) || { failures: 0, until: 0 };
          b.failures += 1;
          b.until = Date.now() + backoffMs(b.failures);
          repoBackoff.set(repo, b);
          console.error('[spawn]', repo, e.message);
        }
      }
      if (plan.length) await collect();
      if (Date.now() - orphansSweptAt > ORPHAN_SWEEP_MS) {
        orphansSweptAt = Date.now();
        await sweepOrphans();
      }
    }

    await housekeeping();
    tickError = '';
  } catch (e) {
    tickError = e.message;
    if (/no such image/i.test(e.message)) image.present = false;
    console.error('[tick]', e.message);
  } finally {
    tickAt = Date.now();
  }
}

// The next tick comes sooner when there is work in flight, and later when
// the rate limit runs low.
function nextDelay() {
  if (rate.remaining !== null && rate.remaining < 200) return Math.max(60_000, rate.reset - Date.now());
  if (rate.remaining !== null && rate.remaining < 1000) return 60_000;
  return POLL_MS;
}

let timer = null;
let stopping = false;
function schedule() {
  if (stopping) return;
  timer = setTimeout(() => serial(tick).finally(schedule), nextDelay());
}

// ---------------------------------------------------------------- status --

function publicState() {
  const s = state.settings;
  const lim = limits();
  return {
    stateError,
    daemonError,
    tickError,
    tickAt,
    pollMs: POLL_MS,
    image: { ...image },
    arch: ARCH,
    labels: LABELS,
    host: { ...host },
    limits: { ...lim, maxJobHours: Math.round((MAX_JOB_MS / 3600_000) * 10) / 10, idleMinutes: Math.round(IDLE_MS / 60_000) },
    rate: { ...rate },
    settings: {
      tokenSet: !!s.token,
      tokenHint: s.token ? `…${s.token.slice(-4)}` : '',
      tokenLogin: s.tokenLogin,
      tokenExpires: s.tokenExpires,
      tokenError,
      maxRunners: s.maxRunners,
      maxRunnersLimit: MAX_RUNNERS_LIMIT,
      dockerForJobs: !!s.dockerForJobs,
      paused: !!s.paused,
    },
    repos: state.repos.map((r) => {
      const st = repoStatus.get(r.name) || {};
      const b = repoBackoff.get(r.name);
      return {
        name: r.name,
        addedAt: r.addedAt,
        publicAt: r.publicAt || '',
        private: st.private,
        queued: st.queued || 0,
        forks: st.forks || 0,
        error: r.publicAt ? PUBLIC_ERROR : st.error || '',
        polledAt: st.polledAt || 0,
        backoffUntil: b?.until > Date.now() ? b.until : 0,
        running: alive.filter((x) => x.repo === r.name).length,
      };
    }),
    runners: alive.map(({ c, parsed, id, ...r }) => r),
    history: state.history.map(({ tail, ...h }, i) => ({ ...h, index: i, hasTail: !!tail })),
  };
}

// ------------------------------------------------------------- settings --

function str(v, max, label) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new UserError(`${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new UserError(`${label} is too long.`);
  if (/[\s\0]/.test(t)) throw new UserError(`${label} must not contain spaces or line breaks.`);
  return t;
}

async function verifyToken(token) {
  const kind = tokenKind(token);
  if (kind === 'classic') {
    throw new UserError(
      'This is a classic token. Classic tokens need the `repo` scope, which is full control of every repository you have. ' +
        'Create a fine-grained token instead (github_pat_...), limited to the private repositories this runner should serve.',
    );
  }
  if (kind !== 'fine-grained') throw new UserError('This does not look like a fine-grained GitHub token (github_pat_...).');
  let res;
  try {
    res = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'zot24-github-runner',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new UserError(`Could not reach GitHub to check the token: ${e.cause?.code || e.message}`, 502);
  }
  if (res.status === 401) throw new UserError('GitHub rejected this token. Check that you copied all of it and that it has not expired.');
  if (!res.ok) throw new UserError(`GitHub answered ${res.status} while checking the token.`, 502);
  const user = await res.json();
  return { login: user.login, expires: res.headers.get('github-authentication-token-expiration') || '' };
}

// Adding a repository proves the three things the runner needs, before it
// is saved: the repo is private, the token can register runners on it
// (Administration: write; minting a registration token registers nothing
// and the token expires in an hour), and the token can see its job queue
// (Actions: read).
async function verifyRepo(name, token) {
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (e) {
      throw new UserError(`${name}: ${what}. ${e.message}`, e.status === 0 ? 502 : 400);
    }
  };
  const info = await step('cannot read the repository', () => gh('GET', `/repos/${name}`, undefined, { token }));
  if (info.private !== true) {
    throw new UserError(
      `${info.full_name} is public. A self-hosted runner on a public repository can run code from anyone's pull request, so this app only serves private repositories.`,
    );
  }
  await step('the token cannot register runners here (needs Administration: Read and write)', () =>
    gh('POST', `/repos/${info.full_name}/actions/runners/registration-token`, undefined, { token }),
  );
  await step('the token cannot read workflow runs here (needs Actions: Read)', () =>
    gh('GET', `/repos/${info.full_name}/actions/runs?per_page=1`, undefined, { token }),
  );
  return info.full_name;
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
    return result;
  });
}

function findRunner(name) {
  const r = alive.find((x) => x.name === name);
  if (!r) throw new UserError(`No running runner named "${name}".`, 404);
  return r;
}

const routes = [
  ['GET', /^\/healthz$/, () => ({ ok: true })],

  ['GET', /^\/api\/state$/, () => publicState()],

  [
    'POST',
    /^\/api\/settings$/,
    async (req) => {
      const b = await readJson(req);
      const token = str(b.token, 300, 'Token');
      const checked = token ? await verifyToken(token) : null;
      if (b.maxRunners !== undefined && !(Number.isInteger(b.maxRunners) && b.maxRunners >= 1 && b.maxRunners <= MAX_RUNNERS_LIMIT)) {
        throw new UserError(`Parallel jobs must be 1 to ${MAX_RUNNERS_LIMIT}.`);
      }
      const result = await mutate(() => {
        const s = state.settings;
        if (checked) {
          Object.assign(s, { token, tokenLogin: checked.login, tokenExpires: checked.expires });
          tokenError = '';
          etags.clear();
        }
        if (b.clearToken === true) Object.assign(s, { token: '', tokenLogin: '', tokenExpires: '' });
        if (b.maxRunners !== undefined) s.maxRunners = b.maxRunners;
        if (typeof b.dockerForJobs === 'boolean') s.dockerForJobs = b.dockerForJobs;
        if (typeof b.paused === 'boolean') s.paused = b.paused;
        return { ok: true, tokenLogin: s.tokenLogin };
      });
      serial(tick);
      return result;
    },
  ],

  [
    'GET',
    /^\/api\/github\/repos$/,
    async () => {
      if (!state.settings.token) throw new UserError('Add a token first.');
      // A fine-grained token sees the repositories it was given (plus public
      // ones, which are never offered).
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const list = await gh('GET', `/user/repos?visibility=private&per_page=100&page=${page}&sort=pushed`).catch((e) => {
          noteTokenFailure(e);
          throw new UserError(e.message, 502);
        });
        out.push(...list.filter((r) => r.private).map((r) => r.full_name));
        if (list.length < 100) break;
      }
      return { repos: out };
    },
  ],

  [
    'POST',
    /^\/api\/repos$/,
    async (req) => {
      const b = await readJson(req);
      const name = normalizeRepo(b.repo);
      if (!name) throw new UserError('Use owner/repo, or the repository\'s GitHub URL.');
      if (!state.settings.token) throw new UserError('Add a token first.');
      if (state.repos.length >= 50) throw new UserError('At most 50 repositories.');
      const fullName = await verifyRepo(name, state.settings.token);
      const result = await mutate(() => {
        if (state.repos.some((r) => r.name.toLowerCase() === fullName.toLowerCase())) throw new UserError(`${fullName} is already served.`, 409);
        state.repos.push({ name: fullName, addedAt: new Date().toISOString() });
        repoStatus.set(fullName, { private: true, queued: 0 });
        return { ok: true, repo: fullName };
      });
      serial(tick);
      return result;
    },
  ],

  [
    'DELETE',
    /^\/api\/repos\/([^/]+)\/([^/]+)$/,
    async (_req, [, owner, repo]) => {
      const name = `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
      const result = await mutate(() => {
        if (!state.repos.some((r) => r.name === name)) throw new UserError(`${name} is not served.`, 404);
        state.repos = state.repos.filter((r) => r.name !== name);
        repoStatus.delete(name);
        return { ok: true };
      });
      serial(tick);
      return result;
    },
  ],

  // Serve a repository again after it went public. verifyRepo checks it is
  // private again, and that the token can still register runners there.
  [
    'POST',
    /^\/api\/repos\/([^/]+)\/([^/]+)\/enable$/,
    async (_req, [, owner, repo]) => {
      const name = `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
      if (!servedRepo(name)) throw new UserError(`${name} is not served.`, 404);
      if (!state.settings.token) throw new UserError('Add a token first.');
      await verifyRepo(name, state.settings.token);
      const result = await mutate(() => {
        const entry = servedRepo(name);
        if (!entry) throw new UserError(`${name} is not served.`, 404);
        delete entry.publicAt;
        repoStatus.set(name, { private: true, queued: 0 });
        console.log(`[public] ${name} is private again and re-enabled by the owner`);
        return { ok: true };
      });
      serial(tick);
      return result;
    },
  ],

  [
    'GET',
    /^\/api\/runners\/(umbrel-[0-9a-f]{8})\/logs$/,
    async (_req, [, name]) => ({ logs: await containerLogs(findRunner(name).id) }),
  ],

  [
    'POST',
    /^\/api\/runners\/(umbrel-[0-9a-f]{8})\/stop$/,
    async (_req, [, name]) =>
      serial(async () => {
        const r = findRunner(name);
        // A busy runner is stopped too: the owner asked. GitHub marks the
        // job failed when its runner disappears.
        await stopRunner(r, 'stopped');
        return { ok: true };
      }),
  ],

  [
    'GET',
    /^\/api\/history\/(\d+)$/,
    async (_req, [, i]) => {
      const h = state.history[Number(i)];
      if (!h) throw new UserError('No such entry.', 404);
      return { tail: h.tail || '' };
    },
  ],

  // Before uninstalling: stop taking jobs and remove this app's runner
  // registrations from every served repository.
  [
    'POST',
    /^\/api\/unregister$/,
    async () =>
      mutate(async () => {
        state.settings.paused = true;
        const report = [];
        for (const r of [...alive]) {
          if (r.busy) continue;
          if (await stopRunner(r, 'idle')) report.push(`${r.repo}: ${r.name} removed (was waiting for a job)`);
        }
        if (state.settings.token && !tokenError) {
          for (const { name: repo } of state.repos) {
            try {
              const list = await gh('GET', `/repos/${repo}/actions/runners?per_page=100`);
              for (const r of list?.runners || []) {
                if (!RUNNER_NAME_RE.test(r.name)) continue;
                const res = await deleteRegistration(repo, r.id);
                report.push(`${repo}: ${r.name} ${res === 'busy' ? 'is running a job; it deregisters itself when the job ends' : 'removed'}`);
              }
            } catch (e) {
              noteTokenFailure(e);
              report.push(`${repo}: ${e.message}`);
            }
          }
        }
        if (!report.length) report.push('No runner registrations of this app were found on GitHub.');
        return { ok: true, report };
      }),
  ],
];

// Umbrel puts every app on umbrel_main_network, and the Umbrel login only
// guards the tile's path: browser -> this app's app_proxy container -> here.
// Any other app on that network could open this port directly, so the
// manager only answers:
//   - its own app_proxy (APP_PROXY_HOST, resolved by name below),
//   - the bridge gateway (the Umbrel host itself),
//   - loopback (the in-container healthcheck).
function bridgeGateways() {
  const ips = new Set(['127.0.0.1', '::1']);
  let text = '';
  try {
    text = readFileSync('/proc/net/route', 'utf8');
  } catch {
    return ips;
  }
  for (const line of text.trim().split('\n').slice(1)) {
    const gw = line.trim().split(/\s+/)[2];
    if (!gw || gw === '00000000' || gw.length !== 8) continue;
    const b = Buffer.from(gw, 'hex');
    ips.add(`${b[3]}.${b[2]}.${b[1]}.${b[0]}`);
  }
  return ips;
}

const PEERS = bridgeGateways();
if (PEERS.size <= 2) console.error('[peers] no bridge gateway in /proc/net/route; only loopback can connect');

// umbreld names the proxy `${APP_ID}_app_proxy_1`. Its address changes when
// the proxy is recreated, so an unknown peer triggers a fresh lookup, at
// most once every 5 seconds so other apps cannot make us spin on DNS. While
// the name does not resolve yet (manager and proxy start together), retry
// sooner so the proxy's first request is not refused.
const APP_PROXY_HOST = process.env.APP_PROXY_HOST || '';
let proxyIps = new Set();
let proxyLookupAt = 0;
let proxyResolved = false;

async function refreshProxyIps() {
  if (!APP_PROXY_HOST || Date.now() - proxyLookupAt < (proxyResolved ? 5000 : 500)) return;
  proxyLookupAt = Date.now();
  try {
    proxyIps = new Set((await lookup(APP_PROXY_HOST, { all: true })).map((a) => a.address));
    proxyResolved = true;
  } catch (e) {
    proxyIps = new Set();
    proxyResolved = false;
    console.error(`[peers] cannot resolve ${APP_PROXY_HOST}: ${e.code || e.message}`);
  }
}

async function allowedPeer(ip) {
  if (PEERS.has(ip) || proxyIps.has(ip)) return true;
  await refreshProxyIps();
  return proxyIps.has(ip);
}

function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

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
    const ip = clientIp(req);
    if (!(await allowedPeer(ip))) throw new UserError('Forbidden.', 403);
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, await readFile(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }
    // Writes need the custom header. A cross-site page cannot send it
    // without a CORS preflight, which this server never approves.
    if (req.method !== 'GET' && req.headers['x-ghr-request'] !== '1') throw new UserError('Missing request header.', 403);
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

// On stop (app stop, update or uninstall), deregister runners that are not
// running a job, so GitHub does not hand them work they will never do. A
// busy runner's job fails when the private daemon stops; GitHub drops its
// ephemeral registration within a day.
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  server.close();
  const done = serial(async () => {
    for (const r of [...alive]) {
      if (r.busy) continue;
      try {
        await stopRunner(r, 'idle');
      } catch (e) {
        console.error('[shutdown]', r.name, e.message);
      }
    }
  });
  await Promise.race([done, new Promise((r) => setTimeout(r, 20_000))]);
  process.exit(0);
}

await loadState();
if (stateError) console.error(stateError);
await mkdir(WORK_DIR, { recursive: true });
await refreshProxyIps();
// Also refresh in the background, so a recreated proxy's old address does
// not stay allowed for whichever container picks it up next.
setInterval(refreshProxyIps, 30_000).unref();
server.listen(PORT, () =>
  console.log(
    `github-runner manager on :${PORT}, image ${IMAGE || '(unset)'}, labels ${LABELS.join(',')}, peers ${[...PEERS, ...proxyIps].join(',')}` +
      (APP_PROXY_HOST ? ` (app_proxy ${APP_PROXY_HOST})` : ''),
  ),
);
serial(tick).finally(schedule);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, shutdown);
