// A stand-in for the few GitHub REST endpoints the manager calls, for local
// development without credentials (see docker-compose.local.yml) and for
// scheduler.test.mjs. It knows one private repo with one queued
// `runs-on: [self-hosted, umbrel]` job and one public repo, and it hands out
// JIT configs that point the runner back at this server, where it fails to
// connect. Nothing reaches github.com.
//
//   token: github_pat_FAKE_0000000000000000000000
//   repos: fake/private-repo (served), fake/public-repo (refused)
//   FAKE_QUEUED=n          queue n jobs instead of one
//   POST /_admin/visibility?repo=fake/private-repo&private=false
//                          flip a repo's visibility (no auth)
//   POST /_admin/run?head=someone/private-repo&fork=true&jobs=1
//                          queue a run whose head is another repo (a fork)
//
// GET answers carry an ETag and honour If-None-Match with a 304, as GitHub
// does, so the manager's ETag cache is exercised too.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TOKEN = 'github_pat_FAKE_0000000000000000000000';
export const REPO = 'fake/private-repo';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');

export function createFakeGitHub({ queued = 1, publicUrl = 'http://127.0.0.1:8080', log = false } = {}) {
  const repos = {
    'fake/private-repo': { id: 1, full_name: 'fake/private-repo', private: true, fork: false },
    'fake/public-repo': { id: 2, full_name: 'fake/public-repo', private: false, fork: false },
  };
  // Workflow runs on fake/private-repo, each with its jobs. The jobs stay
  // queued: runners never connect, which is the point.
  const runs = [];
  const jobs = {};
  const runners = new Map();
  const requests = []; // "GET /repos/fake/private-repo 304"
  const blobAuth = []; // the Authorization header each log download carried
  let nextRunId = 1001;
  let nextJobId = 5001;
  let nextRunnerId = 1;

  // A run and its queued jobs. `head` is the repository the run's code
  // comes from: the served repo itself, or a fork of it.
  function queueRun({ jobs: n = 1, labels = ['self-hosted', 'umbrel'], head = REPO, fork = false, event = 'push', pr = 0, branch = 'main', message = 'a commit' } = {}) {
    const id = nextRunId++;
    const base = repos[REPO];
    const headRepo = head === null ? null : head === REPO ? base : { id: 900 + id, full_name: head, private: true, fork };
    const html = `https://github.com/${REPO}/actions/runs/${id}`;
    runs.push({
      id,
      name: 'CI',
      status: 'queued',
      event,
      head_branch: branch,
      html_url: html,
      pull_requests: pr ? [{ number: pr }] : [],
      head_sha: `${id}`.padStart(40, 'c'),
      head_commit: { message },
      run_attempt: 1,
      updated_at: new Date().toISOString(),
      repository: { id: base.id, full_name: base.full_name },
      head_repository: headRepo,
    });
    jobs[id] = Array.from({ length: n }, (_, i) => {
      const jobId = nextJobId++;
      return {
        id: jobId,
        run_id: id,
        status: 'queued',
        labels,
        created_at: new Date().toISOString(),
        name: `build ${i + 1}`,
        html_url: `${html}/job/${jobId}`,
        runner_name: null,
        steps: [],
      };
    });
    return { id, jobs: jobs[id] };
  }
  if (queued > 0) queueRun({ jobs: queued });

  function jitConfig(name, workFolder, id) {
    return b64({
      '.runner': b64({
        AgentId: id,
        AgentName: name,
        PoolId: 1,
        PoolName: 'Default',
        Ephemeral: true,
        ServerUrl: `${publicUrl}/_fake/pipelines/`,
        GitHubUrl: `${publicUrl}/fake/private-repo`,
        WorkFolder: workFolder,
      }),
      '.credentials': b64({ Scheme: 'OAuth', Data: { clientId: 'fake', authorizationUrl: `${publicUrl}/_fake/oauth`, requireFipsCryptography: 'False' } }),
      '.credentials_rsaparams': b64({}),
    });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (status, data) => {
      const text = data === undefined ? '' : JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'github-authentication-token-expiration': '2027-01-01 00:00:00 UTC',
      };
      if (req.method === 'GET' && status === 200) {
        headers.ETag = `W/"${createHash('sha1').update(text).digest('hex')}"`;
        if (req.headers['if-none-match'] === headers.ETag) status = 304;
      }
      requests.push(`${req.method} ${req.url} ${status}`);
      if (log) console.log(req.method, req.url, status);
      res.writeHead(status, headers);
      res.end(status === 304 || status === 204 ? '' : text);
    };

    if (req.method === 'POST' && p === '/_admin/visibility') {
      const r = repos[url.searchParams.get('repo')];
      if (!r) return send(404, { message: 'Not Found' });
      r.private = url.searchParams.get('private') === 'true';
      return send(200, r);
    }
    if (req.method === 'POST' && p === '/_admin/run') {
      const q = url.searchParams;
      return send(201, queueRun({ jobs: Number(q.get('jobs') || 1), head: q.get('head') || REPO, fork: q.get('fork') === 'true', event: q.get('event') || 'push' }));
    }
    if (p.startsWith('/_fake/')) return send(401, { message: 'fake server: runners cannot connect here' });
    // Where a job log download redirects: storage that needs no token.
    const blob = p.match(/^\/_blob\/(\d+)$/);
    if (blob) {
      blobAuth.push(req.headers.authorization || '');
      const job = Object.values(jobs).flat().find((j) => j.id === Number(blob[1]));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(job?.log || '');
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });

    if (req.method === 'GET' && p === '/user') return send(200, { login: 'fake-owner' });
    if (req.method === 'GET' && p === '/user/repos') return send(200, Object.values(repos).filter((r) => r.private));

    const m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m || !repos[m[1]]) return send(404, { message: 'Not Found' });
    const [, repo, rest = ''] = m;

    if (req.method === 'GET' && rest === '') return send(200, repos[repo]);
    if (req.method === 'POST' && rest === '/actions/runners/registration-token') {
      return send(201, { token: 'FAKEREGTOKEN', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === 'GET' && rest === '/actions/runs') {
      // `fake.failRuns = true` makes the queue read fail, as an outage would.
      if (fake.failRuns) return send(502, { message: 'Server Error' });
      const status = url.searchParams.get('status');
      // Newest first, as GitHub lists them.
      const all = repo === REPO ? runs.filter((r) => !status || r.status === status).sort((a, b) => b.id - a.id) : [];
      const perPage = Number(url.searchParams.get('per_page') || 30);
      const page = Number(url.searchParams.get('page') || 1);
      const list = all.slice((page - 1) * perPage, page * perPage);
      return send(200, { total_count: all.length, workflow_runs: list });
    }
    const jm = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (req.method === 'GET' && jm) return send(200, { total_count: (jobs[jm[1]] || []).length, jobs: jobs[jm[1]] || [] });
    // A job's log: 404 until it is there (GitHub needs a moment after the
    // job ends), then a redirect to storage, as GitHub does.
    const logs = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    if (req.method === 'GET' && logs) {
      const job = Object.values(jobs).flat().find((j) => j.id === Number(logs[1]));
      if (!job || job.log === undefined) return send(404, { message: 'Not Found' });
      requests.push(`GET ${req.url} 302`);
      res.writeHead(302, { Location: `http://${req.headers.host}/_blob/${job.id}` });
      return res.end();
    }
    const one = rest.match(/^\/actions\/jobs\/(\d+)$/);
    if (req.method === 'GET' && one) {
      const job = Object.values(jobs).flat().find((j) => j.id === Number(one[1]));
      return job ? send(200, job) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && rest === '/actions/runners/generate-jitconfig') {
      const id = nextRunnerId++;
      const runner = { id, name: body.name, os: 'Linux', status: 'offline', busy: false, ephemeral: true, labels: body.labels.map((name) => ({ name })) };
      runners.set(id, runner);
      return send(201, { runner, encoded_jit_config: jitConfig(body.name, body.work_folder, id) });
    }
    if (req.method === 'GET' && rest === '/actions/runners') return send(200, { total_count: runners.size, runners: [...runners.values()] });
    const rm = rest.match(/^\/actions\/runners\/(\d+)$/);
    if (req.method === 'DELETE' && rm) {
      const runner = runners.get(Number(rm[1]));
      if (!runner) return send(404, { message: 'Not Found' });
      // GitHub refuses to delete a runner it still counts as running a job.
      if (runner.busy) return send(422, { message: `Bad request - Runner "${runner.name}" is still running a job` });
      runners.delete(runner.id);
      return send(204);
    }
    send(404, { message: 'Not Found' });
  });

  const fake = {
    server,
    repos,
    runs,
    jobs,
    runners,
    requests,
    blobAuth,
    queueRun,
    // A runner picks up one of the queued jobs: GitHub counts it busy and
    // the job leaves the queue, with the runner's name on it. `done`: the
    // job and its run are already over by the next poll.
    assign(runnerId, { done = false } = {}) {
      const job = Object.values(jobs).flat().find((j) => j.status === 'queued' && runs.find((r) => r.id === j.run_id)?.head_repository?.full_name === REPO);
      const r = runners.get(Number(runnerId));
      if (job) {
        Object.assign(job, { status: done ? 'completed' : 'in_progress', runner_name: r?.name || null });
        Object.assign(runs.find((x) => x.id === job.run_id), { status: done ? 'completed' : 'in_progress', updated_at: new Date().toISOString() });
      }
      if (r) Object.assign(r, { busy: true, status: 'online' });
      return job;
    },
  };
  return fake;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT || 8080);
  const publicUrl = process.env.FAKE_PUBLIC_URL || `http://127.0.0.1:${port}`;
  const { server } = createFakeGitHub({ queued: Number(process.env.FAKE_QUEUED || 1), publicUrl, log: true });
  server.listen(port, () => console.log(`fake github on :${port}, runners will dial ${publicUrl}`));
}
