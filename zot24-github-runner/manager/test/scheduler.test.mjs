// node --test manager/test/scheduler.test.mjs
//
// Runs the real server.mjs as a child process against the fake GitHub API
// (fake-github.mjs) and a fake Docker daemon (fake-docker.mjs), so the
// scheduler's decisions can be checked end to end without Docker, without a
// token, and without registering anything on github.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
async function stack(t, { queued = 1 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghr-'));
  const gh = createFakeGitHub({ queued });
  await listen(gh.server, 0, '127.0.0.1');
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
      RUNNER_IMAGE: 'ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807',
      GITHUB_API_URL: `http://127.0.0.1:${gh.server.address().port}`,
      POLL_MS: String(POLL_MS),
      RUNNER_UID: String(process.getuid()),
      RUNNER_GID: String(process.getgid()),
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
    gh.server.closeAllConnections?.();
    await Promise.all([close(docker.server), close(gh.server)]);
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
  assert.match(c.Name, /^ghr-umbrel-[0-9a-f]{8}$/);
  assert.ok(c.spec.Env.some((e) => e.startsWith('ACTIONS_RUNNER_INPUT_JITCONFIG=')));
  assert.ok(!c.spec.Env.some((e) => e.includes(TOKEN)), 'the token never reaches a runner');
  assert.equal(c.spec.HostConfig.NanoCpus, 1e9);
  assert.equal(c.spec.HostConfig.Memory, c.spec.HostConfig.MemorySwap);
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
