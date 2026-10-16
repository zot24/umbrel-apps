// node --test manager/test/scheduler.test.mjs
//
// Runs the real server.mjs as a child process against the fake GitHub API
// (fake-github.mjs) and a fake Docker daemon (fake-docker.mjs), so the
// scheduler's decisions can be checked end to end without Docker, without a
// token, and without registering anything on github.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeDocker } from './fake-docker.mjs';
import { REPO, TOKEN, createFakeGitHub } from './fake-github.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const POLL_MS = 150;

const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, resolve));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await listen(s, 0, '127.0.0.1');
  const { port } = s.address();
  await close(s);
  return port;
}

async function waitFor(what, fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(50);
  }
}

// One manager, one fake GitHub, one fake Docker daemon, torn down after the test.
// `gh` shares one fake GitHub between managers (two Umbrels, one repo).
async function stack(t, { queued = 1, gh: shared = null, env = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghr-'));
  const gh = shared || createFakeGitHub({ queued });
  if (!shared) await listen(gh.server, 0, '127.0.0.1');
  const docker = createFakeDocker();
  const sock = path.join(dir, 'docker.sock');
  await listen(docker.server, sock);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DOCKER_SOCK: sock,
      STATE_DIR: path.join(dir, 'state'),
      WORK_DIR: path.join(dir, 'work'),
      CACHE_DIR: path.join(dir, 'cache'),
      RUNNER_IMAGE: 'ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807',
      GITHUB_API_URL: `http://127.0.0.1:${gh.server.address().port}`,
      POLL_MS: String(POLL_MS),
      RUNNER_UID: String(process.getuid()),
      RUNNER_GID: String(process.getgid()),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.on('exit', r));
  t.after(async () => {
    child.kill('SIGKILL');
    await exited;
    docker.server.closeAllConnections?.();
    if (!shared) gh.server.closeAllConnections?.();
    await Promise.all([close(docker.server), ...(shared ? [] : [close(gh.server)])]);
    await rm(dir, { recursive: true, force: true });
  });

  async function api(method, urlPath, body) {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'X-GHR-Request': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  await waitFor('manager up', () => api('GET', '/healthz').then((r) => r.status === 200, () => false));
  const s = {
    gh,
    docker,
    dir,
    api,
    log: () => log,
    state: async () => (await api('GET', '/api/state')).body,
    repo: async (name = REPO) => (await s.state()).repos.find((r) => r.name === name),
    // Resolves after `n` more scheduler passes have completed.
    async ticks(n) {
      const seen = new Set([(await s.state()).tickAt]);
      await waitFor(`${n} ticks`, async () => {
        seen.add((await s.state()).tickAt);
        return seen.size > n;
      });
    },
    // Token saved and fake/private-repo served.
    async serve() {
      assert.equal((await api('POST', '/api/settings', { token: TOKEN })).status, 200);
      const add = await api('POST', '/api/repos', { repo: REPO });
      assert.equal(add.status, 200, JSON.stringify(add.body));
    },
  };
  return s;
}

test('a queued job gets one runner, with its JIT config and the box limits', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  await s.ticks(3);
  assert.equal(s.docker.runners().length, 1, 'one queued job, one runner');
  const [c] = s.docker.runners();
  assert.match(c.Name, /^ghr-umbrel-[0-9a-f]{4}-[0-9a-f]{6}$/);
  assert.ok(c.spec.Env.some((e) => e.startsWith('ACTIONS_RUNNER_INPUT_JITCONFIG=')));
  assert.ok(!c.spec.Env.some((e) => e.includes(TOKEN)), 'the token never reaches a runner');
  // No hard CPU quota: jobs share the CPU by weight, and dind's low
  // cpu_shares lets other apps win under contention.
  assert.equal(c.spec.HostConfig.NanoCpus, undefined, 'no hard CPU quota');
  assert.equal(c.spec.HostConfig.Memory, c.spec.HostConfig.MemorySwap);
  // The repository's pnpm store outlives the job: a bind at the same path, for pnpm 9 and later.
  const store = path.join(s.dir, 'cache', REPO.replace('/', '__'), 'pnpm-store');
  assert.ok(c.spec.HostConfig.Binds.includes(`${store}:${store}`), 'the pnpm store is mounted');
  assert.ok(c.spec.Env.includes(`npm_config_store_dir=${store}`), 'pnpm 9 uses it');
  assert.ok(c.spec.Env.includes(`pnpm_config_store_dir=${store}`), 'pnpm 10 and later use it');
  assert.equal(s.gh.runners.size, 1, 'one registration on GitHub');
  const saved = await readFile(path.join(s.dir, 'state', 'state.json'), 'utf8');
  assert.ok(!s.log().includes(TOKEN), 'the token is not logged');
  assert.ok(saved.includes(TOKEN), 'the token is kept in state.json');
});

// Requests to the fake for the served repo, as a string: V is a visibility
// read (GET /repos/{repo}), Q a read of its queued runs.
function polls(gh, from = 0) {
  return gh.requests
    .slice(from)
    .map((r) => (r.startsWith(`GET /repos/${REPO} `) ? 'V' : r.startsWith(`GET /repos/${REPO}/actions/runs?status=queued`) ? 'Q' : ''))
    .join('');
}

test('visibility is re-read on every poll, before the queue', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const from = s.gh.requests.length;
  await s.ticks(6);
  const seq = polls(s.gh, from);
  assert.ok((seq.match(/Q/g) || []).length >= 5, `queue read on every poll: ${seq}`);
  assert.match(seq, /^Q?(VQ)+V?$/, 'every queue read follows a fresh visibility read');
  // Unchanged visibility costs a 304, which GitHub does not count against
  // the rate limit.
  assert.ok(s.gh.requests.slice(from).some((r) => r === `GET /repos/${REPO} 304`));
});

test('a repo made public is seen on the next poll and its queue is not read again', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  s.gh.repos[REPO].private = false;
  const from = s.gh.requests.length;
  await s.ticks(3);
  assert.equal((await s.repo()).private, false);
  // A pass already past its visibility read when the flip landed may read
  // the queue once more; after that, never.
  assert.match(polls(s.gh, from), /^Q?V+$/);
  assert.equal(s.docker.runners().length, 0, 'its idle runner is gone');
  assert.equal(s.gh.runners.size, 0, 'and deregistered');
});

test('while paused, a repo with a runner still up keeps having its visibility read', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const [c] = s.docker.runners();
  s.docker.takeJob(c, 'build 1');
  s.gh.assign(c.Labels['ghr.runner-id']);
  await waitFor('runner busy', async () => (await s.state()).runners[0]?.busy);
  assert.equal((await s.api('POST', '/api/settings', { paused: true })).status, 200);
  await s.ticks(1);
  const from = s.gh.requests.length;
  await s.ticks(3);
  assert.match(polls(s.gh, from), /^V{3,}$/, 'visibility read on every pass, queue not read');
});

test('a repo made public mid-run: its runners are stopped and deregistered, busy or not, until re-enabled', async (t) => {
  const s = await stack(t, { queued: 2 });
  await s.serve();
  await waitFor('two runners', () => s.docker.runners().length === 2);
  const [busy, idle] = s.docker.runners();
  const busyId = Number(busy.Labels['ghr.runner-id']);
  const idleId = Number(idle.Labels['ghr.runner-id']);
  s.docker.takeJob(busy, 'build 1');
  s.gh.assign(busyId);
  await waitFor('one runner busy', async () => (await s.state()).runners.some((r) => r.busy));

  s.gh.repos[REPO].private = false;
  await waitFor('both runners stopped', () => s.docker.runners().length === 0);
  assert.ok(!s.gh.runners.has(idleId), 'the idle runner is deregistered');
  assert.ok(s.gh.requests.includes(`DELETE /repos/${REPO}/actions/runners/${busyId} 422`), 'the busy one was asked for too');
  // Once GitHub lets go of the killed runner's job, its registration goes.
  s.gh.runners.get(busyId).busy = false;
  await waitFor('busy runner deregistered', () => !s.gh.runners.has(busyId));

  const st = await s.state();
  const repo = st.repos.find((r) => r.name === REPO);
  assert.ok(repo.publicAt, 'the repo is marked as gone public');
  const stopped = st.history.find((h) => h.job === 'build 1');
  assert.equal(stopped?.result, 'RepoPublic');
  const saved = JSON.parse(await readFile(path.join(s.dir, 'state', 'state.json'), 'utf8'));
  assert.ok(saved.repos.find((r) => r.name === REPO).publicAt, 'and that survives a restart');

  // Private again with a job still queued: still nothing, until re-enabled.
  s.gh.repos[REPO].private = true;
  const jit = () => s.gh.requests.filter((r) => r.includes('/generate-jitconfig')).length;
  const before = jit();
  await s.ticks(4);
  assert.equal(s.docker.runners().length, 0);
  assert.equal(jit(), before, 'no runner registered');

  s.gh.repos[REPO].private = false;
  const refused = await s.api('POST', `/api/repos/${REPO}/enable`);
  assert.equal(refused.status, 400, 're-enabling a public repo is refused');
  assert.match(refused.body.error, /public/);
  s.gh.repos[REPO].private = true;
  const ok = await s.api('POST', `/api/repos/${REPO}/enable`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await waitFor('served again', () => s.docker.runners().length === 1);
  assert.equal((await s.repo()).publicAt, '');
});

test('a queued job from a fork gets no runner, whatever its labels, and is logged once', async (t) => {
  const s = await stack(t, { queued: 0 });
  await s.serve();
  const fork = 'someone/private-repo';
  const runs = [
    s.gh.queueRun({ head: fork, fork: true, event: 'pull_request' }),
    // pull_request_target runs the base branch's workflow for the fork's
    // pull request; GitHub still reports the fork as the head repository.
    s.gh.queueRun({ head: fork, fork: true, event: 'pull_request_target', labels: ['self-hosted', 'umbrel', 'Linux'] }),
    // The fork was deleted: no head repository at all.
    s.gh.queueRun({ head: null, event: 'pull_request' }),
    // Not ours by its labels either; skipped and logged all the same.
    s.gh.queueRun({ head: fork, fork: true, event: 'pull_request', labels: ['ubuntu-latest'] }),
  ];
  await s.ticks(5);
  assert.equal(s.docker.runners().length, 0, 'no runner');
  assert.equal(s.gh.requests.filter((r) => r.includes('/generate-jitconfig')).length, 0, 'nothing registered');
  const lines = s.log().split('\n').filter((l) => l.startsWith('[fork] '));
  for (const run of runs) {
    const id = run.jobs[0].id;
    assert.equal(lines.filter((l) => l.includes(` job ${id} `)).length, 1, `job ${id} logged once over 5 passes`);
  }
  assert.ok(lines.some((l) => l.includes(`${fork} is a fork`) && l.includes('pull_request_target')));
  assert.ok(!s.log().includes(TOKEN), 'no token in the log');
  assert.equal((await s.repo()).forks, 3, 'the page counts the three that asked for this runner');

  // A job from the repository itself still gets its runner.
  s.gh.queueRun();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  await s.ticks(2);
  assert.equal(s.docker.runners().length, 1);

  // Made public: the fork count goes with the rest of its queue.
  s.gh.repos[REPO].private = false;
  await waitFor('marked public', async () => (await s.repo()).publicAt);
  assert.equal((await s.repo()).forks, 0);
});

test('a job links to its log and its pull request, also when it was never seen running', async (t) => {
  const s = await stack(t, { queued: 0 });
  await s.serve();
  const run = s.gh.queueRun({ event: 'pull_request', pr: 42, branch: 'feat/x' });
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const [c] = s.docker.runners();
  s.docker.takeJob(c, 'build 1');
  s.gh.assign(c.Labels['ghr.runner-id']);
  const link = await waitFor('the running runner has its link', async () => (await s.state()).runners[0]?.link);
  const expected = {
    workflow: 'CI',
    event: 'pull_request',
    branch: 'feat/x',
    pr: 42,
    prUrl: `https://github.com/${REPO}/pull/42`,
    runUrl: `https://github.com/${REPO}/actions/runs/${run.id}`,
    jobUrl: `https://github.com/${REPO}/actions/runs/${run.id}/job/${run.jobs[0].id}`,
    runId: run.id,
    jobId: run.jobs[0].id,
    queuedAt: run.jobs[0].created_at,
  };
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(link[k], v, k);
  s.docker.finishJob(c, 'build 1');
  const done = await waitFor('in the history', async () => (await s.state()).history.find((h) => h.runner === c.Labels['ghr.name']));
  assert.equal(done.result, 'Succeeded');
  assert.deepEqual(done.link, link, 'the history keeps the link');

  // Over before any poll saw it with its runner: found among the latest runs.
  const quick = s.gh.queueRun({ event: 'schedule' });
  await waitFor('a new runner', () => s.docker.runners().some((x) => x.Id !== c.Id));
  const c2 = s.docker.runners().find((x) => x.Id !== c.Id);
  s.docker.takeJob(c2, 'build 1');
  s.gh.assign(c2.Labels['ghr.runner-id'], { done: true });
  s.docker.finishJob(c2, 'build 1', 'Failed');
  const quickDone = await waitFor('in the history', async () => (await s.state()).history.find((h) => h.runner === c2.Labels['ghr.name']));
  assert.equal(quickDone.link?.jobUrl, `https://github.com/${REPO}/actions/runs/${quick.id}/job/${quick.jobs[0].id}`);
  assert.equal(quickDone.link.event, 'schedule');
  assert.equal(quickDone.link.prUrl, '', 'a scheduled run has no pull request');
});

test('Docker for jobs: umbrel-docker jobs get a Docker runner, one at a time; umbrel jobs never get the socket', async (t) => {
  const s = await stack(t, { queued: 0 });
  await s.serve();
  s.gh.queueRun({ jobs: 2, labels: ['self-hosted', 'umbrel-docker'] });
  await s.ticks(3);
  assert.equal(s.docker.runners().length, 0, 'off: a Docker job gets no runner');
  assert.equal((await s.repo()).dockerOff, 2, 'and the page says why');

  // Four parallel jobs, so only the one-Docker-runner limit holds the second Docker job back.
  assert.equal((await s.api('POST', '/api/settings', { dockerForJobs: true, maxRunners: 4 })).status, 200);
  s.gh.queueRun({ labels: ['self-hosted', 'umbrel'] });
  await waitFor('a Docker runner and a light runner', () => s.docker.runners().length === 2);
  await s.ticks(3);
  assert.equal(s.docker.runners().length, 2, 'two Docker jobs queued, still one Docker runner');
  const d = s.docker.runners().find((c) => c.Labels['ghr.docker'] === '1');
  const l = s.docker.runners().find((c) => c.Labels['ghr.docker'] === '0');
  assert.ok(d && l, 'one of each');
  assert.equal(d.spec.HostConfig.NetworkMode, 'host');
  assert.ok(d.spec.HostConfig.Binds.some((b) => b.endsWith(':/var/run/docker.sock')));
  assert.notEqual(l.spec.HostConfig.NetworkMode, 'host');
  assert.ok(!l.spec.HostConfig.Binds.some((b) => b.includes('docker.sock')), 'the light runner has no socket');
  const registered = (c) => s.gh.runners.get(Number(c.Labels['ghr.runner-id'])).labels.map((x) => x.name);
  assert.deepEqual(registered(d).slice(0, 3), ['self-hosted', 'umbrel-docker', 'Linux']);
  assert.deepEqual(registered(l).slice(0, 3), ['self-hosted', 'umbrel', 'Linux']);

  // The Docker runner takes the first Docker job and ends: the second one
  // gets the next Docker runner.
  s.docker.takeJob(d, 'build 1');
  s.gh.assign(d.Labels['ghr.runner-id']);
  s.docker.finishJob(d, 'build 1');
  await waitFor('the next Docker runner', () => s.docker.runners().some((c) => c.Labels['ghr.docker'] === '1' && c.Id !== d.Id));

  // Off again: the idle Docker runner goes, and the job waits on GitHub.
  assert.equal((await s.api('POST', '/api/settings', { dockerForJobs: false })).status, 200);
  await waitFor('no Docker runner', () => !s.docker.runners().some((c) => c.Labels['ghr.docker'] === '1'));
  await waitFor('counted as waiting', async () => (await s.repo()).dockerOff === 1);
});

test('two Umbrels on one repository: each sweeps and unregisters only its own runners', async (t) => {
  const gh = createFakeGitHub({ queued: 2 });
  await listen(gh.server, 0, '127.0.0.1');
  t.after(async () => {
    gh.server.closeAllConnections?.();
    await close(gh.server);
  });
  // Sweep orphans on every pass: a runner that just registered is offline
  // until it connects, and the fake's runners never connect.
  const a = await stack(t, { gh, env: { ORPHAN_SWEEP_MS: '100' } });
  const b = await stack(t, { gh, env: { ORPHAN_SWEEP_MS: '100' } });
  await a.serve();
  await b.serve();
  const ida = (await a.state()).installId;
  const idb = (await b.state()).installId;
  assert.match(ida, /^[0-9a-f]{4}$/);
  assert.notEqual(ida, idb, 'each install has its own ID');
  const regs = (id) => [...gh.runners.values()].filter((r) => r.name.startsWith(`umbrel-${id}-`));
  await waitFor('both Umbrels registered runners', () => regs(ida).length > 0 && regs(idb).length > 0);
  // A pre-0.1.5 registration: either Umbrel could own it, so neither removes it.
  gh.runners.set(9999, { id: 9999, name: 'umbrel-0a1b2c3d', os: 'Linux', status: 'offline', busy: false, ephemeral: true, labels: [] });
  await a.ticks(4);
  await b.ticks(4);
  const bBefore = regs(idb).map((r) => r.id).sort();
  assert.ok(bBefore.length > 0, "B's offline runners survive A's sweeps");
  assert.ok(gh.runners.has(9999), 'the legacy registration survives the sweeps');

  const res = await a.api('POST', '/api/unregister');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(regs(ida).length, 0, "A's idle runners are deregistered");
  assert.deepEqual(regs(idb).map((r) => r.id).sort(), bBefore, "B's runners are untouched");
  assert.ok(gh.runners.has(9999), 'the legacy registration is untouched');
  assert.ok(res.body.report.some((l) => /left alone/.test(l)), JSON.stringify(res.body.report));
});

test('the queue: every page is read, waiting jobs carry a reason, and an API error shows stale data', async (t) => {
  // Two runs per page, so five queued runs take three pages.
  const s = await stack(t, { queued: 0, env: { RUNS_PER_PAGE: '2' } });
  await s.serve();
  for (let i = 0; i < 5; i += 1) s.gh.queueRun();
  s.gh.queueRun({ labels: ['self-hosted', 'umbrel', 'gpu'] });
  const repo = await waitFor('all five counted', async () => {
    const r = await s.repo();
    return r.queued === 5 ? r : null;
  });
  assert.equal(repo.waitingTotal, 6, 'five for this Umbrel plus one it cannot take');
  const mismatch = repo.waiting.find((w) => w.kind === 'mismatch');
  assert.deepEqual(mismatch.labels, ['self-hosted', 'umbrel', 'gpu']);
  assert.match(mismatch.url, /^https:\/\/github\.com\//);
  assert.ok(repo.waiting.every((w, i, a) => i === 0 || a[i - 1].queuedAt <= w.queuedAt), 'oldest first');
  assert.ok(repo.oldestQueuedAt, 'the oldest wait is on the page');

  // Five queued, cap 2: wait for both runners, so none is still starting
  // when the API starts failing.
  await waitFor('a full set of runners', () => s.docker.runners().length === 2);
  const before = s.docker.runners().length;
  s.gh.failRuns = true;
  const stale = await waitFor('marked stale', async () => {
    const r = await s.repo();
    return r.stale ? r : null;
  });
  assert.equal(stale.queued, 5, 'the last numbers stay on the page');
  assert.match(stale.error, /Server Error|502/);
  await s.ticks(3);
  assert.equal(s.docker.runners().length, before, 'no new runner starts on stale data');
  s.gh.failRuns = false;
  await waitFor('fresh again', async () => !(await s.repo()).stale);
});

const GiB = 1024 ** 3;
const runnerOfState = async (s, name) => (await s.state()).runners.find((r) => r.name === name);

test('a running job shows its steps, CPU and memory; its history keeps the peaks, the OOM kills and the failed step', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  const name = c.Labels['ghr.name'];
  s.docker.takeJob(c, 'build 1');
  const job = s.gh.assign(c.Labels['ghr.runner-id']);
  const t0 = new Date().toISOString();
  job.steps = [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: t0, completed_at: t0 },
    { number: 2, name: 'Type check', status: 'in_progress', conclusion: null, started_at: t0, completed_at: null },
    { number: 3, name: 'Complete job', status: 'queued', conclusion: null, started_at: null, completed_at: null },
  ];
  c.stats = { cpuNs: 1e9, mem: 2 * GiB };
  const r1 = await waitFor('steps and memory on the runner', async () => {
    const r = await runnerOfState(s, name);
    return r?.steps?.length === 3 && r.usage?.mem === 2 * GiB ? r : null;
  });
  assert.equal(r1.steps[1].name, 'Type check');
  assert.equal(r1.steps[1].status, 'in_progress');
  assert.equal(r1.usage.memLimit, c.spec.HostConfig.Memory, 'the limit Docker enforces');
  assert.equal(r1.usage.cpuLimit, 4, 'a job may use every CPU of the box');
  assert.equal(r1.usage.job, null, 'a light runner starts no containers');

  c.stats = { cpuNs: 30e9, mem: 3 * GiB };
  const r2 = await waitFor('CPU over the interval', async () => {
    const r = await runnerOfState(s, name);
    return r?.usage?.cpu > 0 && r.usage.memPeak === 3 * GiB ? r : null;
  });
  assert.ok(r2.usage.cpuPeak >= r2.usage.cpu);
  c.stats = { cpuNs: 31e9, mem: 1 * GiB };
  await waitFor('memory went down, the peak stays', async () => {
    const r = await runnerOfState(s, name);
    return r?.usage?.mem === 1 * GiB && r.usage.memPeak === 3 * GiB;
  });

  s.docker.oom(c);
  await waitFor('the OOM kill is counted', async () => (await runnerOfState(s, name))?.usage?.oom === 1);
  assert.match(s.log(), new RegExp(`\\[oom\\] ${name}`));

  Object.assign(job, { status: 'completed', conclusion: 'failure' });
  Object.assign(job.steps[1], { status: 'completed', conclusion: 'failure', completed_at: new Date().toISOString() });
  s.docker.finishJob(c, 'build 1', 'Failed');
  const done = await waitFor('history entry', async () => (await s.state()).history.find((h) => h.runner === name));
  assert.equal(done.usage.memPeak, 3 * GiB);
  assert.equal(done.usage.oom, 1, s.log().split('\n').filter((l) => l.includes('[oom]')).join('\n'));
  assert.equal(done.usage.memLimit, c.spec.HostConfig.Memory);
  assert.ok(done.usage.cpuAvg > 0);
  assert.equal(done.usage.cpu, undefined, 'no live figures in history');
  assert.deepEqual(done.step, { n: 2, name: 'Type check', total: 3, conclusion: 'failure' });
  const st = await s.state();
  assert.equal(st.stats.day.oom, 1);
  assert.equal(st.runners.length, 0);
});

test('Logs: the current step output comes from the runner page file, read as runner, only while a job runs', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  const name = c.Labels['ghr.name'];
  c.stepLog = '2026-10-12T00:00:01.1234567Z ##[group]Run pnpm tsc\n2026-10-12T00:00:02.0000000Z src/a.ts(1,1): error TS2322\n';
  const idle = await s.api('GET', `/api/runners/${name}/logs`);
  assert.equal(idle.status, 200);
  assert.equal(idle.body.output, '', 'no job yet: nothing is read');
  assert.equal(s.docker.execs.size, 0);
  assert.match(idle.body.logs, /Listening for Jobs/);

  s.docker.takeJob(c, 'build 1');
  s.gh.assign(c.Labels['ghr.runner-id']);
  await waitFor('busy', async () => (await runnerOfState(s, name))?.busy);
  const busy = await s.api('GET', `/api/runners/${name}/logs`);
  assert.equal(busy.body.output, '00:00:01 ##[group]Run pnpm tsc\n00:00:02 src/a.ts(1,1): error TS2322');
  const [ex] = s.docker.execs.values();
  assert.equal(ex.User, 'runner');
  assert.match(ex.Cmd.join(' '), /_diag\/pages\/\*\.log/);
  assert.match(ex.Cmd.join(' '), /tail -c \d+/);
});

test('a Docker job counts the containers it starts in the private daemon', async (t) => {
  const s = await stack(t, { queued: 0 });
  await s.serve();
  assert.equal((await s.api('POST', '/api/settings', { dockerForJobs: true })).status, 200);
  s.gh.queueRun({ labels: ['self-hosted', 'umbrel-docker'] });
  await waitFor('a Docker runner', () => s.docker.runners().length === 1);
  const d = s.docker.runners()[0];
  const name = d.Labels['ghr.name'];
  s.docker.takeJob(d, 'build 1');
  s.gh.assign(d.Labels['ghr.runner-id']);
  // Left by an earlier Docker job: not this one's.
  const old = s.docker.jobContainer('leftover', { cpuNs: 900e9, mem: 5 * GiB });
  old.Created = Number(d.Labels['ghr.created']) / 1000 - 600;
  const db = s.docker.jobContainer('supabase_db', { cpuNs: 5e9, mem: 2 * GiB });
  s.docker.jobContainer('supabase_kong', { cpuNs: 1e9, mem: 1 * GiB });
  const r = await waitFor('job containers on the runner', async () => {
    const x = await runnerOfState(s, name);
    return x?.usage?.job?.containers === 2 ? x : null;
  });
  assert.equal(r.usage.job.mem, 3 * GiB);
  db.stats = { cpuNs: 50e9, mem: 2 * GiB };
  await waitFor('their CPU', async () => (await runnerOfState(s, name))?.usage?.job?.cpu > 0);
  s.docker.oom(old);
  await s.ticks(2);
  assert.equal((await runnerOfState(s, name)).usage.oom, 0, 'a leftover\'s OOM kill is not this job\'s');
  s.docker.oom(db);
  await waitFor('an OOM kill in a job container is the Docker runner\'s', async () => (await runnerOfState(s, name))?.usage?.oom === 1);
});

test('a quick job is linked even when its run is not among the ten newest', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  // Newer runs, none of them for an Umbrel, as one push makes many.
  for (let i = 0; i < 14; i += 1) s.gh.queueRun({ labels: ['ubuntu-latest'] });
  s.docker.takeJob(c, 'build 1');
  const job = s.gh.assign(c.Labels['ghr.runner-id'], { done: true });
  s.docker.finishJob(c, 'build 1');
  const done = await waitFor('history entry', async () => (await s.state()).history[0]);
  assert.equal(done.link?.jobId, job.id);
});

test('the page has the Umbrel\'s own CPU, memory and free disk, where /proc has them', async (t) => {
  const s = await stack(t);
  await s.ticks(2);
  const { hostUsage } = await s.state();
  assert.ok(hostUsage, 'always present');
  assert.ok(hostUsage.diskFree > 0 && hostUsage.diskTotal >= hostUsage.diskFree, 'statfs of the work folder');
  if (existsSync('/proc/stat')) {
    assert.ok(hostUsage.cpu.busy >= 0 && hostUsage.cpu.busy <= 1);
    assert.ok(hostUsage.cpu.iowait >= 0);
    assert.ok(hostUsage.memAvailable > 0 && hostUsage.memTotal > hostUsage.memAvailable);
  } else {
    assert.equal(hostUsage.cpu, null, 'no /proc here (macOS): left empty');
  }
});

test('a failed job keeps the lines before its error from GitHub\'s log, fetched without the token at the storage end', async (t) => {
  const s = await stack(t, { env: { FAIL_LOG_DELAY_MS: '0' } });
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  const name = c.Labels['ghr.name'];
  s.docker.takeJob(c, 'build 1');
  const job = s.gh.assign(c.Labels['ghr.runner-id']);
  job.steps = [{ number: 1, name: 'Type check', status: 'in_progress', conclusion: null, started_at: new Date().toISOString(), completed_at: null }];
  await waitFor('linked', async () => (await runnerOfState(s, name))?.link);
  // GitHub has not caught up when the runner exits: the step still runs.
  s.docker.finishJob(c, 'build 1', 'Failed');
  const first = await waitFor('history entry', async () => (await s.state()).history.find((h) => h.runner === name));
  assert.equal(first.step.conclusion, 'in_progress');
  await s.ticks(2);
  assert.ok(!(await s.state()).history[0].failure?.excerpt, 'the log is not there yet: asked again later');
  Object.assign(job, { status: 'completed', conclusion: 'failure' });
  Object.assign(job.steps[0], { status: 'completed', conclusion: 'failure', completed_at: new Date().toISOString() });
  job.log = ['2026-10-12T00:00:01.0000000Z ##[group]Run pnpm tsc', '2026-10-12T00:00:09.0000000Z FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', '2026-10-12T00:00:09.5000000Z ##[error]Process completed with exit code 134.', '2026-10-12T00:00:10.0000000Z Post job cleanup.'].join('\n');
  const h = await waitFor('the excerpt', async () => {
    const x = (await s.state()).history[0];
    return x.failure?.hint ? x : null;
  }, 15_000);
  assert.equal(h.failure.hint, 'heap');
  assert.equal(h.step.conclusion, 'failure', 'the step is read again with the log, once GitHub has the end');
  assert.equal(h.hasTail, true, 'the row opens');
  const detail = await s.api('GET', `/api/history/${h.index}`);
  assert.match(detail.body.excerpt, /^00:00:01 ##\[group\]Run pnpm tsc\n00:00:09 FATAL ERROR.*\n00:00:09 ##\[error\]Process completed with exit code 134\.$/);
  assert.deepEqual(s.gh.blobAuth, [''], 'one download, and the token never left for the storage host');
  assert.equal(JSON.stringify(await s.state()).includes('FATAL ERROR'), false, 'the excerpt is not in every page poll');
});

test('a succeeded job fetches no log', async (t) => {
  const s = await stack(t, { env: { FAIL_LOG_DELAY_MS: '0' } });
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  s.docker.takeJob(c, 'build 1');
  const job = s.gh.assign(c.Labels['ghr.runner-id']);
  job.log = 'x';
  s.docker.finishJob(c, 'build 1');
  await waitFor('history entry', async () => (await s.state()).history[0]);
  await s.ticks(3);
  assert.equal(s.gh.requests.filter((r) => r.includes('/logs')).length, 0);
});

test('Logs: a step output larger than the cap is cut, not read whole', async (t) => {
  const s = await stack(t);
  await s.serve();
  await waitFor('one runner', () => s.docker.runners().length === 1);
  const c = s.docker.runners()[0];
  s.docker.takeJob(c, 'build 1');
  s.gh.assign(c.Labels['ghr.runner-id']);
  await waitFor('busy', async () => (await runnerOfState(s, c.Labels['ghr.name']))?.busy);
  // A job can replace tail; what comes back is still bounded.
  c.stepLog = Array.from({ length: 3000 }, (_, i) => `2026-10-12T00:00:01.0000000Z line ${i} ${'y'.repeat(1000)}`).join('\n');
  const r = await s.api('GET', `/api/runners/${c.Labels['ghr.name']}/logs`);
  assert.equal(r.status, 200);
  assert.ok(r.body.output.length <= 64 * 1024, `got ${r.body.output.length}`);
  assert.match(r.body.output, /^00:00:01 line \d+ y+\n/, 'text, not Docker stream framing');
  assert.equal(/[\u0000-\u0008]/.test(r.body.output), false);
});
