// Pure pieces of the Orca Umbrel gate: Tailscale address checks, the
// orca-ide argv, the ready-line parser, and the process supervisor.
// Nothing here opens a socket or starts Orca.
import { BlockList, isIP } from 'node:net';

// Tailscale's IPv4 range is CGNAT 100.64.0.0/10. Its IPv6 range is the
// ULA fd7a:115c:a1e0::/48. A LAN address is not accepted: this app is
// reached over the tailnet, and the pairing link must name that address.
const TAILSCALE_4 = new BlockList();
TAILSCALE_4.addSubnet('100.64.0.0', 10, 'ipv4');
const TAILSCALE_6 = new BlockList();
TAILSCALE_6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i;

export const WS_PORT = 6768;

export function validatePairingAddress(input) {
  const address = String(input ?? '').trim();
  if (!address) return { ok: false, error: 'Enter the Umbrel Tailscale address.' };
  if (/[\s/?#@\\]/.test(address) || address.includes('//')) {
    return { ok: false, error: 'Enter the Tailscale address only, not a URL.' };
  }
  const kind = isIP(address);
  if (kind === 4) {
    if (!TAILSCALE_4.check(address, 'ipv4')) {
      return {
        ok: false,
        error: 'Use the Tailscale IPv4 address. It starts with 100.64. through 100.127.',
      };
    }
    return { ok: true, address };
  }
  if (kind === 6) {
    if (!TAILSCALE_6.check(address, 'ipv6')) {
      return {
        ok: false,
        error: 'Use a Tailscale IPv6 address (fd7a:115c:a1e0::/48), or the Tailscale IPv4 address.',
      };
    }
    return { ok: true, address };
  }
  if (address.includes(':') || address.startsWith('[') || address.endsWith(']')) {
    return { ok: false, error: 'Leave the port off. Clients use port 6768.' };
  }
  if (address.length > 253 || address.endsWith('.')) {
    return { ok: false, error: 'That hostname is not a Tailscale address.' };
  }
  const host = address;
  const labels = host.split('.');
  if (labels.some((label) => !HOSTNAME.test(label))) {
    return { ok: false, error: 'That hostname is not a Tailscale address.' };
  }
  const lowered = host.toLowerCase();
  if (
    lowered === 'localhost' ||
    lowered.endsWith('.localhost') ||
    lowered.endsWith('.local') ||
    lowered === '0.0.0.0'
  ) {
    return {
      ok: false,
      error: 'That name only works on this machine. Enter the Tailscale address or MagicDNS name.',
    };
  }
  return { ok: true, address: host };
}

// A missing file and a blank file both mean "not configured yet".
export function readPairingAddress(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#')) ?? '';
  if (!line) return { ok: true, address: '' };
  return validatePairingAddress(line);
}

export function buildServeArgs({ bin = 'orca-ide', address, port = WS_PORT } = {}) {
  // --refuse-public stays on even for a MagicDNS hostname. Orca otherwise
  // treats a hostname pairing address as permission to accept public clients.
  // --bind 0.0.0.0 is the container interface; Docker publishes 6768 on the
  // Umbrel host, which is where Tailscale is listening.
  return [
    bin,
    'serve',
    '--port', String(port),
    '--bind', '0.0.0.0',
    '--pairing-address', address,
    '--refuse-public',
    '--json',
  ];
}

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/orca:\/\/\S+/gi, 'orca://pair?code=redacted')
    .replace(/((?:pairing|code|token)=)[^\s&"]+/gi, '$1redacted');
}

export function rememberLog(lines, text) {
  const next = lines.slice();
  for (const raw of redactSecrets(text).split(/\r?\n/)) {
    const line = raw.trim().slice(0, 400);
    if (!line) continue;
    if (/^pairing url:/i.test(line)) continue;
    next.push(line);
  }
  return next.slice(-8);
}

// One stdout line from `orca-ide serve --json`, or the human-readable form.
export function parseReadyLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (!obj || (obj.type !== 'orca_server_ready' && !obj.pairing)) return null;
      return {
        pairingUrl: typeof obj.pairing?.url === 'string' ? obj.pairing.url : '',
        advertisedEndpoint: firstString(obj.advertisedEndpoint, obj.pairing?.endpoint),
        boundEndpoint: firstString(obj.boundEndpoint, obj.endpoint),
      };
    } catch {
      return null;
    }
  }
  const pairingUrl = trimmed.match(/^Pairing URL:\s*(\S+)/i)?.[1] ?? '';
  const advertisedEndpoint = trimmed.match(/^Advertised endpoint:\s*(\S+)/i)?.[1] ?? '';
  const boundEndpoint = trimmed.match(/^Bound endpoint:\s*(\S+)/i)?.[1] ?? '';
  if (!pairingUrl && !advertisedEndpoint && !boundEndpoint) return null;
  return { pairingUrl, advertisedEndpoint, boundEndpoint };
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value) ?? '';
}

function mergeReady(current, next) {
  return {
    pairingUrl: next.pairingUrl || current.pairingUrl,
    advertisedEndpoint: next.advertisedEndpoint || current.advertisedEndpoint,
    boundEndpoint: next.boundEndpoint || current.boundEndpoint,
  };
}

const EMPTY_READY = { pairingUrl: '', advertisedEndpoint: '', boundEndpoint: '' };

// Owns the orca-ide child. A pairing-address change kills the process
// group and starts a new one. Docker restarts the container if this
// supervisor's parent dies; the supervisor itself restarts Orca with
// backoff so a crash does not tight-loop.
export function createSupervisor(opts) {
  const port = opts.port ?? WS_PORT;
  const bin = opts.bin ?? 'orca-ide';
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clear ?? ((handle) => clearTimeout(handle));
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let address = '';
  let phase = 'needs-address';
  let ready = { ...EMPTY_READY };
  let error = '';
  let log = [];
  let buf = '';
  let errBuf = '';
  let child = null;
  let generation = 0;
  let timer = null;
  let backoff = 1000;
  let stopped = false;

  function snapshot() {
    return {
      address,
      phase,
      pairingUrl: ready.pairingUrl,
      advertisedEndpoint: ready.advertisedEndpoint,
      boundEndpoint: ready.boundEndpoint,
      error,
      log: log.slice(),
    };
  }

  function ingest(text) {
    buf += text;
    const parts = buf.split(/\n/);
    buf = parts.pop() ?? '';
    for (const line of parts) applyReady(parseReadyLine(line));
  }

  function applyReady(parsed) {
    if (!parsed || (!parsed.pairingUrl && !parsed.advertisedEndpoint && !parsed.boundEndpoint)) return false;
    ready = mergeReady(ready, parsed);
    if (ready.pairingUrl || ready.advertisedEndpoint) {
      phase = 'ready';
      error = '';
      backoff = 1000;
    }
    return true;
  }

  // A ready line on stderr carries the pairing code. Keep it in the status
  // field and out of the log.
  function noteError(text) {
    errBuf += text;
    const parts = errBuf.split(/\n/);
    errBuf = parts.pop() ?? '';
    const kept = [];
    for (const line of parts) {
      if (applyReady(parseReadyLine(line))) continue;
      kept.push(line);
    }
    if (!kept.length) return;
    log = rememberLog(log, kept.join('\n'));
    const last = log[log.length - 1];
    if (last && phase !== 'ready') error = last;
  }

  function signal(pid, sig) {
    try {
      opts.kill(-pid, sig);
    } catch {
      try {
        opts.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }

  function whenExit(proc) {
    if (proc.exited) return Promise.resolve();
    return new Promise((resolve) => proc.once('exit', () => resolve()));
  }

  async function stopChild() {
    const proc = child;
    if (!proc) return;
    child = null;
    const gen = generation;
    signal(proc.pid, 'SIGTERM');
    await Promise.race([
      whenExit(proc),
      sleep(8000).then(() => {
        if (generation === gen) signal(proc.pid, 'SIGKILL');
      }),
    ]);
  }

  function arm(gen, addr) {
    if (timer) clear(timer);
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30_000);
    timer = schedule(() => {
      timer = null;
      launch(gen, addr);
    }, wait);
  }

  function launch(gen, addr) {
    if (stopped || gen !== generation) return;
    opts.clearFallback?.();
    phase = 'starting';
    error = '';
    log = [];
    ready = { ...EMPTY_READY };
    buf = '';
    errBuf = '';
    const args = buildServeArgs({ bin, address: addr, port });
    let proc;
    try {
      proc = opts.spawn(args[0], args.slice(1), {
        env: opts.env,
        cwd: opts.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      phase = 'exited';
      error = err.message;
      arm(gen, addr);
      return;
    }
    child = proc;
    proc.stdout?.on('data', (chunk) => ingest(chunk.toString()));
    proc.stderr?.on('data', (chunk) => noteError(chunk.toString()));
    proc.on('error', (err) => noteError(`${err.message}\n`));
    proc.on('exit', (code, signalName) => {
      if (child !== proc) return;
      child = null;
      if (stopped || gen !== generation) return;
      phase = 'exited';
      if (!error) error = `orca-ide exited (${signalName || code})`;
      arm(gen, addr);
    });
  }

  async function setAddress(next) {
    if (stopped) return snapshot();
    address = next;
    generation += 1;
    const gen = generation;
    if (timer) {
      clear(timer);
      timer = null;
    }
    backoff = 1000;
    await stopChild();
    if (stopped || gen !== generation) return snapshot();
    if (!next) {
      phase = 'needs-address';
      ready = { ...EMPTY_READY };
      error = '';
      log = [];
      buf = '';
      errBuf = '';
      return snapshot();
    }
    launch(gen, next);
    return snapshot();
  }

  async function stop() {
    stopped = true;
    generation += 1;
    if (timer) {
      clear(timer);
      timer = null;
    }
    await stopChild();
  }

  return { snapshot, setAddress, stop };
}

export function peerAllowed({ ip, proxyIps, requireProxy }) {
  const normalized = String(ip ?? '').replace(/^::ffff:/, '');
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  if (proxyIps?.has(normalized)) return true;
  return !requireProxy;
}
