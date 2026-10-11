// A stand-in for the few Docker Engine API endpoints the manager calls, on a
// unix socket, for scheduler.test.mjs. Containers never run anything: a
// "started" runner prints the lines a real one prints while it waits for a
// job, and the test decides when it takes one (takeJob) or exits.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const GiB = 1024 ** 3;

// The runner's own timestamp format: "2026-10-09 12:00:00Z".
const stamp = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

export function createFakeDocker({ ncpu = 4, memBytes = 16 * GiB } = {}) {
  const containers = new Map(); // Id -> { Id, Name, Labels, State, Created, spec, logs }
  const networks = new Set();
  const requests = [];

  const summary = (c) => ({ Id: c.Id, Names: [`/${c.Name}`], Labels: c.Labels, State: c.State, Created: c.Created });
  const find = (id) => containers.get(id) || [...containers.values()].find((c) => c.Name === id);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url, 'http://docker');
    const p = url.pathname;
    requests.push(`${req.method} ${p}`);
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    let m;

    if (req.method === 'GET' && p === '/info') return send(200, { NCPU: ncpu, MemTotal: memBytes });
    if (req.method === 'GET' && /^\/images\/.+\/json$/.test(p)) return send(200, { Id: 'sha256:fake' });
    if (req.method === 'GET' && p === '/images/json') return send(200, []);
    if (req.method === 'POST' && /^\/(networks|volumes|build)\/prune$/.test(p)) return send(200, {});
    if ((m = p.match(/^\/networks\/([^/]+)$/)) && req.method === 'GET') {
      return networks.has(m[1]) ? send(200, { Name: m[1] }) : send(404, { message: 'network not found' });
    }
    if (req.method === 'POST' && p === '/networks/create') {
      networks.add(body.Name);
      return send(201, { Id: body.Name });
    }

    if (req.method === 'GET' && p === '/containers/json') {
      const want = JSON.parse(url.searchParams.get('filters') || '{}').label || [];
      const list = [...containers.values()].filter((c) => want.every((l) => {
        const [k, v] = l.split('=');
        return c.Labels?.[k] === v;
      }));
      return send(200, list.map(summary));
    }
    if (req.method === 'POST' && p === '/containers/create') {
      const c = {
        Id: randomBytes(32).toString('hex'),
        Name: url.searchParams.get('name') || '',
        Labels: body.Labels || {},
        State: 'created',
        Created: Math.floor(Date.now() / 1000),
        spec: body,
        logs: '',
      };
      containers.set(c.Id, c);
      return send(201, { Id: c.Id });
    }
    if ((m = p.match(/^\/containers\/([^/]+)(?:\/(start|kill|wait|logs))?$/))) {
      const c = find(m[1]);
      if (!c) return send(404, { message: `No such container: ${m[1]}` });
      const op = m[2] || '';
      if (req.method === 'POST' && op === 'start') {
        c.State = 'running';
        c.logs += `√ Connected to GitHub\n\n${stamp()}: Listening for Jobs\n`;
        return send(204);
      }
      if (req.method === 'POST' && op === 'kill') {
        c.State = 'exited';
        return send(204);
      }
      if (req.method === 'POST' && op === 'wait') return send(200, { StatusCode: 0 });
      if (req.method === 'GET' && op === 'logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(c.logs);
      }
      if (req.method === 'DELETE' && !op) {
        containers.delete(c.Id);
        return send(204);
      }
    }
    send(404, { message: `fake docker: ${req.method} ${p} not implemented` });
  });

  return {
    server,
    containers,
    requests,
    // Runner containers, by their runner name (umbrel-xxxxxxxx).
    runners: () => [...containers.values()].filter((c) => c.Labels['ghr.runner'] === '1'),
    byName: (name) => [...containers.values()].find((c) => c.Labels['ghr.name'] === name),
    // The runner picks up a job: what it prints when it does.
    takeJob(c, job) {
      c.logs += `${stamp()}: Running job: ${job}\n`;
    },
    // The job ends and the ephemeral runner exits.
    finishJob(c, job, result = 'Succeeded') {
      c.logs += `${stamp()}: Job ${job} completed with result: ${result}\n`;
      c.State = 'exited';
    },
  };
}
