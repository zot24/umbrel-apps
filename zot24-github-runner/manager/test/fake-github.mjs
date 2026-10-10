// A stand-in for the few GitHub REST endpoints the manager calls, for local
// development without credentials (see docker-compose.local.yml). It knows
// one private repo with one queued `runs-on: [self-hosted, umbrel]` job and
// one public repo, and it hands out JIT configs that point the runner back
// at this server, where it fails to connect. Nothing reaches github.com.
//
//   token: github_pat_FAKE_0000000000000000000000
//   repos: fake/private-repo (served), fake/public-repo (refused)
//   FAKE_QUEUED=n          queue n jobs instead of one
//   POST /_admin/visibility?repo=fake/private-repo&private=false
//                          flip a repo's visibility (no auth)
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = process.env.FAKE_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const TOKEN = 'github_pat_FAKE_0000000000000000000000';

const repos = {
  'fake/private-repo': { full_name: 'fake/private-repo', private: true },
  'fake/public-repo': { full_name: 'fake/public-repo', private: false },
};
// One run with FAKE_QUEUED queued jobs for us. The jobs stay queued: the
// runners never connect, which is the point.
const QUEUED = Number(process.env.FAKE_QUEUED || 1);
const runs = [{ id: 1001, status: 'queued' }];
const jobs = {
  1001: Array.from({ length: QUEUED }, (_, i) => ({
    id: 5001 + i,
    status: 'queued',
    labels: ['self-hosted', 'umbrel'],
    created_at: new Date().toISOString(),
    name: `build ${i + 1}`,
  })),
};
const runners = new Map();
let nextRunnerId = 1;

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');

function jitConfig(name, workFolder, id) {
  return b64({
    '.runner': b64({
      AgentId: id,
      AgentName: name,
      PoolId: 1,
      PoolName: 'Default',
      Ephemeral: true,
      ServerUrl: `${PUBLIC_URL}/_fake/pipelines/`,
      GitHubUrl: `${PUBLIC_URL}/fake/private-repo`,
      WorkFolder: workFolder,
    }),
    '.credentials': b64({ Scheme: 'OAuth', Data: { clientId: 'fake', authorizationUrl: `${PUBLIC_URL}/_fake/oauth`, requireFipsCryptography: 'False' } }),
    '.credentials_rsaparams': b64({}),
  });
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'github-authentication-token-expiration': '2027-01-01 00:00:00 UTC',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  console.log(req.method, req.url);

  if (req.method === 'POST' && p === '/_admin/visibility') {
    const r = repos[url.searchParams.get('repo')];
    if (!r) return send(res, 404, { message: 'Not Found' });
    r.private = url.searchParams.get('private') === 'true';
    return send(res, 200, r);
  }
  if (p.startsWith('/_fake/')) return send(res, 401, { message: 'fake server: runners cannot connect here' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Bad credentials' });

  if (req.method === 'GET' && p === '/user') return send(res, 200, { login: 'fake-owner' });
  if (req.method === 'GET' && p === '/user/repos') return send(res, 200, [repos['fake/private-repo']]);

  const m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!m || !repos[m[1]]) return send(res, 404, { message: 'Not Found' });
  const [, repo, rest = ''] = m;

  if (req.method === 'GET' && rest === '') return send(res, 200, repos[repo]);
  if (req.method === 'POST' && rest === '/actions/runners/registration-token') {
    return send(res, 201, { token: 'FAKEREGTOKEN', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (req.method === 'GET' && rest === '/actions/runs') {
    const status = url.searchParams.get('status');
    const list = repo === 'fake/private-repo' ? runs.filter((r) => !status || r.status === status) : [];
    return send(res, 200, { total_count: list.length, workflow_runs: list });
  }
  const jm = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
  if (req.method === 'GET' && jm) return send(res, 200, { total_count: (jobs[jm[1]] || []).length, jobs: jobs[jm[1]] || [] });
  if (req.method === 'POST' && rest === '/actions/runners/generate-jitconfig') {
    const id = nextRunnerId++;
    const runner = { id, name: body.name, os: 'Linux', status: 'offline', busy: false, ephemeral: true, labels: body.labels.map((name) => ({ name })) };
    runners.set(id, runner);
    return send(res, 201, { runner, encoded_jit_config: jitConfig(body.name, body.work_folder, id) });
  }
  if (req.method === 'GET' && rest === '/actions/runners') return send(res, 200, { total_count: runners.size, runners: [...runners.values()] });
  const rm = rest.match(/^\/actions\/runners\/(\d+)$/);
  if (req.method === 'DELETE' && rm) {
    if (!runners.delete(Number(rm[1]))) return send(res, 404, { message: 'Not Found' });
    res.writeHead(204);
    return res.end();
  }
  send(res, 404, { message: 'Not Found' });
});

server.listen(PORT, () => console.log(`fake github on :${PORT}, runners will dial ${PUBLIC_URL}`));
