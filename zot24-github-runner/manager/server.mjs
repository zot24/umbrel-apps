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
import { chown, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_RUNNERS,
  MAX_RUNNERS_LIMIT,
  INSTALL_ID_RE,
  RUNNER_NAME_RE,
  attributeOom,
  backoffMs,
  classifyQueued,
  cleanStepLog,
  demuxDockerLogs,
  failureExcerpt,
  failureHint,
  foldUsage,
  forkHead,
  historyStats,
  hostCpuBusy,
  jobLimits,
  jobLink,
  jobWantsUs,
  memUsed,
  normalizeRepo,
  ownsRunner,
  parseMeminfo,
  parseProcStat,
  parseRunnerLog,
  planSpawns,
  pruneHistory,
  reapReason,
  runnerLabels,
  stepSummary,
  stepsOf,
  stripAnsi,
  tokenKind,
  usageView,
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
const DOCKER_LABELS = runnerLabels(ARCH, { docker: true });
// Docker runners alive at once. Jobs on one daemon share its host network
// and container names, so two compose stacks with fixed ports would clash.
const MAX_DOCKER = 1;
// Queue polling reads up to MAX_RUN_PAGES pages of runs per status, so a
// backlog older than the newest page still shows (and still gets runners).
const RUNS_PER_PAGE = Number(process.env.RUNS_PER_PAGE || 100);
const MAX_RUN_PAGES = 3;
const ORPHAN_SWEEP_MS = Number(process.env.ORPHAN_SWEEP_MS || 60 * 60_000);
// How often a registration GitHub would not delete yet is asked for again.
const DEREG_RETRY_MS = 4 * POLL_MS;
const IMAGE_PRUNE_MS = 24 * 3600_000;
// How much of the current step's output the Logs window reads per refresh.
const STEP_TAIL_BYTES = 32 * 1024;

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

// maxBytes: stop reading there and resolve with what came (a stream from
// inside a job's container is not trusted to stop by itself).
function dockerRequest(method, urlPath, body, { timeout = 30_000, onData, maxBytes = Infinity } = {}) {
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
        let size = 0;
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (onData) onData(c);
          if (size >= maxBytes) {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).subarray(0, maxBytes) });
            req.destroy();
          }
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

// One-shot stats: no second sample, so it answers at once. CPU is the
// container's CPU time since it started; foldUsage turns two reads into a
// rate. A container that has just exited answers with empty figures: null.
async function containerStats(id) {
  const st = await docker('GET', `/containers/${id}/stats?stream=false&one-shot=true`, undefined, { timeout: 10_000 });
  if (!st?.memory_stats?.limit) return null;
  return { cpuNs: Number(st.cpu_stats?.cpu_usage?.total_usage) || 0, mem: memUsed(st.memory_stats), memLimit: Number(st.memory_stats.limit) };
}

// The current step's output, as the runner writes it before uploading it to
// GitHub (secrets already masked): the newest page file in its _diag/pages.
// Read by an exec inside the job's own container, as `runner`, so a path is
// resolved in that container and never in the manager's, where the token is.
// The job controls that container (sudo), so it can change what this prints
// but gains nothing it did not have; the reply is capped and timed out, and
// the page shows it as text.
async function stepOutput(id) {
  const ex = await docker('POST', `/containers/${id}/exec`, {
    User: 'runner',
    AttachStdout: true,
    AttachStderr: false,
    Cmd: ['sh', '-c', `f=$(ls -t /home/runner/_diag/pages/*.log 2>/dev/null | head -n 1); [ -z "$f" ] || tail -c ${STEP_TAIL_BYTES} "$f"`],
  });
  const res = await dockerRequest('POST', `/exec/${ex.Id}/start`, { Detach: false, Tty: false }, { timeout: 5000, maxBytes: 2 * STEP_TAIL_BYTES });
  if (res.status >= 400) throw dockerError(res);
  const text = demuxDockerLogs(res.body, { truncated: res.body.length >= 2 * STEP_TAIL_BYTES });
  return cleanStepLog(text, { cut: Buffer.byteLength(text) >= STEP_TAIL_BYTES - 8 });
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
  installId: '', // set once on first start; names this install's runners
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
      history: pruneHistory(Array.isArray(parsed.history) ? parsed.history : []),
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

// The whole Umbrel, other apps included: /proc/stat and /proc/meminfo in a
// container are the host's. Free disk is of the work folder's volume, where
// jobs and the private daemon's images live. A figure that cannot be read
// (no /proc outside Linux) stays null.
const hostUsage = { cpu: null, memTotal: null, memAvailable: null, diskFree: null, diskTotal: null };
let procStat = null;

async function readHostUsage() {
  const [stat, meminfo, fsStat] = await Promise.all([
    readFile('/proc/stat', 'utf8').catch(() => ''),
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    statfs(WORK_DIR).catch(() => null),
  ]);
  const cur = parseProcStat(stat);
  hostUsage.cpu = hostCpuBusy(procStat, cur);
  procStat = cur;
  const mem = parseMeminfo(meminfo);
  hostUsage.memTotal = mem?.total ?? null;
  hostUsage.memAvailable = mem?.available ?? null;
  hostUsage.diskFree = fsStat ? fsStat.bavail * fsStat.bsize : null;
  hostUsage.diskTotal = fsStat ? fsStat.blocks * fsStat.bsize : null;
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
const jobLinks = new Map(); // runner name -> jobLink() of the job it took, seen while polling
const jobSteps = new Map(); // runner name -> stepsOf() that job, as of the last poll
const usage = new Map(); // runner name -> foldUsage() record of its samples
// Docker events are read from here on: OOM kills before the manager started
// belong to runners it no longer knows. Both ends of a read are inclusive,
// so the events of the last read are remembered and not counted twice.
let eventsSince = Date.now() / 1000;
let eventsSeen = new Set();
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
    // Its CPU limit as started (a cap change applies to new runners only).
    cpus: Number(L['ghr.cpus']) || limits().cpus,
  };
}

function workDirOf(name) {
  return path.join(WORK_DIR, name);
}

async function spawn(repo, { dockerJob = false } = {}) {
  const withDocker = dockerJob && !!state.settings.dockerForJobs;
  const name = `umbrel-${state.installId}-${randomBytes(3).toString('hex')}`;
  const workDir = workDirOf(name);
  await mkdir(workDir, { recursive: true });
  await chown(workDir, RUNNER_UID, RUNNER_GID);
  const jit = await gh('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, {
    name,
    runner_group_id: 1,
    labels: withDocker ? DOCKER_LABELS : LABELS,
    work_folder: workDir,
  });
  const lim = limits();
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
      'ghr.cpus': String(lim.cpus),
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
    console.log(`[spawn] ${name} for ${repo} (runner ${jit.runner.id}${withDocker ? ', docker' : ''})`);
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
  const link = jobLinks.get(r.name) || (ranJob ? await findJobLink(r) : null);
  const steps = jobSteps.get(r.name) || [];
  const used = usageView(usage.get(r.name), { live: false });
  jobLinks.delete(r.name);
  jobSteps.delete(r.name);
  usage.delete(r.name);
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
    const failed = ranJob && result !== 'Succeeded';
    const step = failed ? await stepOfEnd(r.repo, link, steps) : null;
    // A cancelled job was stopped on purpose: its log says nothing new.
    if (failed && link?.jobId && !/^Cancell?ed$/.test(result)) {
      failLogs.push({ repo: r.repo, jobId: link.jobId, runner: r.name, due: Date.now() + FAIL_LOG_DELAY_MS, tries: 0 });
      if (failLogs.length > 20) failLogs.shift();
    }
    state.history.unshift({
      runner: r.name,
      repo: r.repo,
      job: r.job,
      link,
      pool: r.docker ? 'docker' : 'light',
      result,
      createdAt: new Date(r.createdAt).toISOString(),
      jobStartedAt: r.jobStartedAt,
      finishedAt: parsed.jobFinishedAt || new Date().toISOString(),
      docker: r.docker,
      // Samples every poll: peaks and averages are of those, not exact.
      usage: used && (used.samples || used.memPeak || used.oom) ? used : null,
      step,
      failure: failed && used?.oom ? { hint: 'oom', excerpt: '' } : null,
      tail: result === 'Succeeded' ? '' : logs.trim().split('\n').slice(-25).join('\n'),
    });
    state.history = pruneHistory(state.history);
    await saveState();
  }
  await removeContainer(c.Id);
  await rm(workDirOf(r.name), { recursive: true, force: true });
  console.log(`[done] ${r.name} ${r.repo}: ${result}${r.job ? ` (${r.job})` : ''}`);
}

// Where a job that did not succeed stopped: the step GitHub marks failed,
// else the step it was running at the last poll. Asks GitHub for the job
// once (the last poll can be up to one interval old). Null when unknown.
async function stepOfEnd(repo, link, lastSeen) {
  let steps = lastSeen;
  if (link?.jobId) {
    try {
      const job = await gh('GET', `/repos/${repo}/actions/jobs/${link.jobId}`);
      if (job?.steps?.length) steps = stepsOf(job);
    } catch (e) {
      noteTokenFailure(e);
      console.error('[steps]', repo, link.jobId, e.message);
    }
  }
  const sum = stepSummary(steps);
  // GitHub's job can say neither yet; the last poll then knows best.
  const last = stepSummary(lastSeen);
  const s = sum.failed || sum.current || last.failed || last.current;
  return s ? { n: s.n, name: s.name, total: sum.total || last.total, conclusion: s.conclusion || s.status } : null;
}

// ------------------------------------------------------- failure logs ----

// For a job that did not succeed, GitHub's own log has the lines that say
// why. It is there a few seconds after the job ends, so it is fetched later,
// off the scheduling chain, and kept on the history entry (failureExcerpt).
const FAIL_LOG_DELAY_MS = Number(process.env.FAIL_LOG_DELAY_MS ?? 20_000);
const FAIL_LOG_TRIES = 4;
const FAIL_LOG_MAX_BYTES = 16 * 1024 * 1024;
const failLogs = []; // { repo, jobId, runner, due, tries }
let failLogsRunning = false;

// GitHub answers with a redirect to storage. It is followed by hand, so the
// token goes to the API and never to the storage host. A log bigger than
// FAIL_LOG_MAX_BYTES keeps its end. Null while GitHub has no log yet.
async function jobLogText(repo, jobId) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${state.settings.token}`, 'User-Agent': 'zot24-github-runner', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 410) return null;
  const to = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !to) throw new GitHubError(githubMessage(res, null), res.status, res.headers);
  const target = new URL(to, GITHUB_API);
  if (target.protocol !== 'https:' && target.origin !== new URL(GITHUB_API).origin) throw new Error(`log redirect to ${target.origin} refused`);
  const blob = await fetch(target, { headers: { 'User-Agent': 'zot24-github-runner' }, signal: AbortSignal.timeout(120_000) });
  if (!blob.ok) throw new Error(`log download: HTTP ${blob.status}`);
  const chunks = [];
  let size = 0;
  for await (const c of blob.body) {
    chunks.push(c);
    size += c.length;
    while (size - chunks[0].length > FAIL_LOG_MAX_BYTES) size -= chunks.shift().length;
  }
  return Buffer.concat(chunks).toString();
}

async function drainFailLogs() {
  if (failLogsRunning) return;
  failLogsRunning = true;
  try {
    for (const x of [...failLogs]) {
      if (x.due > Date.now() || !state.settings.token || tokenError) continue;
      let text = null;
      try {
        text = await jobLogText(x.repo, x.jobId);
      } catch (e) {
        noteTokenFailure(e);
        console.error('[faillog]', x.repo, x.jobId, e.message);
      }
      x.tries += 1;
      if (text === null && x.tries < FAIL_LOG_TRIES) {
        x.due = Date.now() + FAIL_LOG_DELAY_MS * 2 ** x.tries;
        continue;
      }
      failLogs.splice(failLogs.indexOf(x), 1);
      if (text === null) continue;
      // By now GitHub has the job's end: which step failed, read again.
      const step = await stepOfEnd(x.repo, { jobId: x.jobId }, []);
      await serial(async () => {
        const h = state.history.find((e) => e.runner === x.runner && e.link?.jobId === x.jobId);
        if (!h) return;
        h.failure = { hint: failureHint(text, { oom: h.usage?.oom || 0 }), excerpt: failureExcerpt(text) };
        if (step) h.step = step;
        await saveState();
      });
    }
  } finally {
    failLogsRunning = false;
  }
}

// A job that started and ended between two polls was never seen with its
// runner: look for it in the repository's latest runs. One push starts a
// run per workflow, so 30 of them; only runs updated since the runner
// started have their jobs read. This runs on the scheduling chain, so it
// gives up after FIND_LINK_MS. Null if not found.
const FIND_LINK_MS = 15_000;
async function findJobLink(r) {
  const deadline = Date.now() + FIND_LINK_MS;
  try {
    const since = new Date(r.createdAt).toISOString();
    const runs = await gh('GET', `/repos/${r.repo}/actions/runs?per_page=30`);
    for (const run of runs?.workflow_runs || []) {
      if ((run.updated_at || '') < since) continue;
      if (Date.now() > deadline) break;
      const jobs = await gh('GET', `/repos/${r.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      const j = (jobs?.jobs || []).find((x) => x.runner_name === r.name);
      if (j) return jobLink(r.repo, run, j, { defaultBranch: repoStatus.get(r.repo)?.defaultBranch });
    }
  } catch (e) {
    noteTokenFailure(e);
    console.error('[link]', r.name, e.message);
  }
  return null;
}

// OOM kills since the last read, from the private daemon's event log: one
// call for every container, a job process killed inside a runner that keeps
// going included. Read before collect(), so a runner that died of it has
// the kill in its history entry.
async function readOomEvents() {
  const until = Date.now() / 1000;
  const res = await dockerRequest('GET', `/events?since=${eventsSince.toFixed(3)}&until=${until.toFixed(3)}&filters=${q({ type: ['container'], event: ['oom'] })}`, undefined, { timeout: 10_000 });
  if (res.status >= 400) throw dockerError(res);
  eventsSince = until;
  const events = [];
  for (const line of res.body.toString().split('\n')) {
    try {
      if (line.trim()) events.push(JSON.parse(line));
    } catch {}
  }
  const key = (e) => `${e.Actor?.ID}:${e.timeNano}`;
  const fresh = events.filter((e) => !eventsSeen.has(key(e)));
  eventsSeen = new Set(events.map(key));
  // A kill in a container without a runner label is the Docker job's only
  // if that container was started after its runner (one left by an
  // earlier job can still be up). One gone already was this job's.
  const dockerRunner = alive.find((r) => r.docker);
  const mine = [];
  for (const e of fresh) {
    if (e.Actor?.Attributes?.['ghr.name'] || !dockerRunner) {
      mine.push(e);
      continue;
    }
    const c = await docker('GET', `/containers/${e.Actor?.ID}/json`, undefined, { timeout: 10_000 }).catch(() => null);
    if (!c || Date.parse(c.Created) >= dockerRunner.createdAt - 1000) mine.push(e);
  }
  const counts = attributeOom(mine, { dockerRunner: dockerRunner?.name || '' });
  for (const [name, n] of counts) {
    const u = usage.get(name) || {};
    usage.set(name, { ...u, oom: (u.oom || 0) + n });
    console.log(`[oom] ${name}: ${n} process${n > 1 ? 'es' : ''} killed for memory`);
  }
}

// One stats read per live runner, and for a Docker runner (at most one per
// daemon) also per container its job started: every running container in
// the daemon without the ghr.managed label created since that runner
// started (housekeeping waits while a Docker job runs, so one from an
// earlier job can still be up).
async function sampleUsage() {
  const at = Date.now();
  const dockerRunner = alive.find((r) => r.docker);
  let jobIds = [];
  if (dockerRunner) {
    const since = Math.floor(dockerRunner.createdAt / 1000) - 1;
    jobIds = (await docker('GET', '/containers/json')).filter((c) => !c.Labels?.['ghr.managed'] && c.Created >= since).map((c) => c.Id);
  }
  await Promise.all(
    alive.map(async (r) => {
      try {
        const own = await containerStats(r.id);
        if (!own) return;
        let job = null;
        if (r.docker) {
          const reads = await Promise.all(jobIds.map((id) => containerStats(id).then((st) => st && { id, cpuNs: st.cpuNs, mem: st.mem }, () => null)));
          job = reads.filter(Boolean);
        }
        usage.set(r.name, foldUsage(usage.get(r.name) || null, { at, busy: r.busy, cpuNs: own.cpuNs, mem: own.mem, memLimit: own.memLimit, cpuLimit: r.cpus, job }));
      } catch (e) {
        if (e.status !== 404) console.error('[usage]', r.name, e.message);
      }
    }),
  );
  // An OOM count for a runner that is gone without a finish here.
  for (const name of usage.keys()) if (!alive.some((r) => r.name === name)) usage.delete(name);
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
    st.defaultBranch = String(info.default_branch || '');
    if (!st.private) {
      Object.assign(st, { queued: 0, queuedDocker: 0, dockerOff: 0, forks: 0, oldestQueuedAt: '', oldestDockerQueuedAt: '', error: PUBLIC_ERROR });
      await wentPublic(repo);
      return;
    }
    if (!queue) {
      Object.assign(st, { queued: 0, queuedDocker: 0, dockerOff: 0, forks: 0, oldestQueuedAt: '', oldestDockerQueuedAt: '', error: '' });
      return;
    }
    const dockerOn = !!state.settings.dockerForJobs;
    let queued = 0;
    let queuedDocker = 0;
    let dockerOff = 0;
    let forks = 0;
    let oldest = '';
    let oldestDocker = '';
    const waiting = [];
    const seen = new Set();
    const ours = new Set(alive.map((x) => x.name));
    // A run is `queued` until its first job starts and `in_progress` after,
    // while later jobs in it can still be waiting for a runner. A run can move
    // from one list to the other between two reads, so each is read once.
    for (const status of ['queued', 'in_progress']) {
      for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
        const runs = await gh('GET', `/repos/${repo}/actions/runs?status=${status}&per_page=${RUNS_PER_PAGE}&page=${page}`);
        const list = runs?.workflow_runs || [];
        for (const run of list) {
          if (seen.has(run.id)) continue;
          seen.add(run.id);
          const fork = forkHead(run);
          const jobs = await gh('GET', `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
          for (const j of jobs?.jobs || []) {
            // Which job each of our runners took, for links on the page.
            if (j.runner_name && ours.has(j.runner_name)) {
              jobLinks.set(j.runner_name, jobLink(repo, run, j, { defaultBranch: st.defaultBranch }));
              jobSteps.set(j.runner_name, stepsOf(j));
            }
            if (j.status !== 'queued') continue;
            // Never a fork's code, whatever the job's labels.
            if (fork) {
              logForkJob(repo, run, j, fork);
              if (jobWantsUs(j.labels, LABELS) || jobWantsUs(j.labels, DOCKER_LABELS)) forks += 1;
              continue;
            }
            const kind = classifyQueued(j.labels, { light: LABELS, docker: DOCKER_LABELS, dockerOn });
            if (!kind) continue;
            if (kind === 'light') {
              queued += 1;
              if (!oldest || (j.created_at || '') < oldest) oldest = j.created_at || '';
            } else if (kind === 'docker') {
              queuedDocker += 1;
              if (!oldestDocker || (j.created_at || '') < oldestDocker) oldestDocker = j.created_at || '';
            } else if (kind === 'docker-off') {
              // Waits on GitHub while Docker for jobs is off; the page says so.
              dockerOff += 1;
            }
            const link = jobLink(repo, run, j, { defaultBranch: st.defaultBranch });
            waiting.push({ kind, jobId: link.jobId, name: String(j.name || ''), workflow: link.workflow, url: link.jobUrl, pr: link.pr, labels: (j.labels || []).map(String), queuedAt: link.queuedAt });
          }
        }
        if (list.length < RUNS_PER_PAGE) break;
      }
    }
    waiting.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    Object.assign(st, {
      queued,
      queuedDocker,
      dockerOff,
      forks,
      oldestQueuedAt: oldest,
      oldestDockerQueuedAt: oldestDocker,
      waiting: waiting.slice(0, 20),
      waitingTotal: waiting.length,
      stale: false,
      error: '',
      polledAt: Date.now(),
    });
  } catch (e) {
    noteTokenFailure(e);
    // Keep the last numbers on the page, marked stale: an API error does not
    // mean the queue is empty. The scheduler starts nothing on stale data.
    Object.assign(st, { stale: true, error: e.message });
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
        // Only this install's: another Umbrel's runner is offline for a few
        // seconds between registering and connecting.
        if (!ownsRunner(state.installId, r.name) || mine.has(r.name) || r.busy || r.status !== 'offline') continue;
        await deleteRegistration(repo, r.id);
        console.log(`[sweep] removed stale registration ${r.name} from ${repo}`);
      }
    } catch (e) {
      noteTokenFailure(e);
      console.error('[sweep]', repo, e.message);
    }
  }
}

// When no Docker job is running, clear what jobs with Docker access left in the
// private daemon (stray containers, networks, volumes), orphaned work dirs,
// and once a day every image except the runner's own.
async function housekeeping() {
  const live = new Set(alive.map((r) => r.name));
  for (const dir of await readdir(WORK_DIR).catch(() => [])) {
    if (!live.has(dir)) await rm(path.join(WORK_DIR, dir), { recursive: true, force: true });
  }
  // Light runners never touch the daemon, so only a Docker job holds this back.
  if (alive.some((r) => r.docker)) return;
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
    await readOomEvents().catch((e) => console.error('[oom]', e.message));
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
      if (!reason && !r.busy && r.docker && !state.settings.dockerForJobs) reason = 'idle';
      if (reason) await stopRunner(r, reason);
    }

    if (active()) {
      const plan = planSpawns({
        repos: state.repos
          .filter((r) => servable(r.name))
          .map((r) => {
            const st = repoStatus.get(r.name);
            return {
              name: r.name,
              queued: st.stale ? 0 : st.queued || 0,
              queuedDocker: st.stale ? 0 : st.queuedDocker || 0,
              oldestQueuedAt: st.oldestQueuedAt,
              oldestDockerQueuedAt: st.oldestDockerQueuedAt,
              blockedUntil: repoBackoff.get(r.name)?.until || 0,
            };
          }),
        // GitHub's job list can still say `queued` for a few seconds after
        // a runner took the job. A job that started that recently still
        // covers one queued entry, so it does not get a second runner.
        runners: alive.map((r) => ({
          repo: r.repo,
          docker: r.docker,
          busy: r.busy && Date.now() - Date.parse(r.jobStartedAt) > 2 * POLL_MS,
        })),
        maxRunners: state.settings.maxRunners,
        maxDocker: MAX_DOCKER,
      });
      for (const { repo, docker: dockerJob } of plan) {
        try {
          await spawn(repo, { dockerJob });
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

    // Figures for the page: a failed read is logged, never a tick error.
    await sampleUsage().catch((e) => console.error('[usage]', e.message));
    await readHostUsage().catch((e) => console.error('[host]', e.message));
    await housekeeping();
    // Off the chain: a slow log download does not hold up scheduling.
    if (failLogs.length) drainFailLogs().catch((e) => console.error('[faillog]', e.message));
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
    installId: state.installId,
    labels: LABELS,
    dockerLabels: DOCKER_LABELS,
    maxDocker: MAX_DOCKER,
    host: { ...host },
    hostUsage: { ...hostUsage },
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
        queuedDocker: st.queuedDocker || 0,
        dockerOff: st.dockerOff || 0,
        oldestQueuedAt: st.oldestQueuedAt || '',
        oldestDockerQueuedAt: st.oldestDockerQueuedAt || '',
        waiting: st.waiting || [],
        waitingTotal: st.waitingTotal || 0,
        stale: !!st.stale,
        forks: st.forks || 0,
        error: r.publicAt ? PUBLIC_ERROR : st.error || '',
        polledAt: st.polledAt || 0,
        backoffUntil: b?.until > Date.now() ? b.until : 0,
        running: alive.filter((x) => x.repo === r.name).length,
      };
    }),
    runners: alive.map(({ c, parsed, id, ...r }) => ({ ...r, link: jobLinks.get(r.name) || null, steps: jobSteps.get(r.name) || [], usage: usageView(usage.get(r.name)) })),
    // The newest 50 for the table; the stats cover all kept history.
    history: state.history.slice(0, 50).map(({ tail, failure, ...h }, i) => ({
      ...h,
      failure: failure ? { hint: failure.hint } : null,
      index: i,
      hasTail: !!(tail || failure?.excerpt),
    })),
    historyKept: state.history.length,
    stats: {
      day: historyStats(state.history, { windowMs: 24 * 3600_000 }),
      week: historyStats(state.history, { windowMs: 7 * 24 * 3600_000 }),
    },
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
    /^\/api\/runners\/(umbrel-(?:[0-9a-f]{4}-[0-9a-f]{6}|[0-9a-f]{8}))\/logs$/,
    async (_req, [, name]) => {
      const r = findRunner(name);
      // The step output only exists while a job runs; nothing is exec'd before.
      const [logs, out] = await Promise.all([
        containerLogs(r.id),
        r.busy ? stepOutput(r.id).then((output) => ({ output }), (e) => ({ output: '', outputError: e.message })) : { output: '' },
      ]);
      return { logs, output: out.output, outputError: out.outputError || '' };
    },
  ],

  [
    'POST',
    /^\/api\/runners\/(umbrel-(?:[0-9a-f]{4}-[0-9a-f]{6}|[0-9a-f]{8}))\/stop$/,
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
      return { tail: h.tail || '', excerpt: h.failure?.excerpt || '' };
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
        let others = 0;
        if (state.settings.token && !tokenError) {
          for (const { name: repo } of state.repos) {
            try {
              const list = await gh('GET', `/repos/${repo}/actions/runners?per_page=100`);
              for (const r of list?.runners || []) {
                if (!RUNNER_NAME_RE.test(r.name)) continue;
                // Another Umbrel's runner, or an unowned pre-0.1.5 name.
                if (!ownsRunner(state.installId, r.name)) {
                  others += 1;
                  continue;
                }
                const res = await deleteRegistration(repo, r.id);
                report.push(`${repo}: ${r.name} ${res === 'busy' ? 'is running a job; it deregisters itself when the job ends' : 'removed'}`);
              }
            } catch (e) {
              noteTokenFailure(e);
              report.push(`${repo}: ${e.message}`);
            }
          }
        }
        if (others) report.push(`${others} umbrel registration(s) of another Umbrel, or from before 0.1.5, were left alone.`);
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
else if (!INSTALL_ID_RE.test(state.installId || '')) {
  state.installId = randomBytes(2).toString('hex');
  await saveState();
}
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
