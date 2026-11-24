import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServeArgs,
  createSupervisor,
  parseReadyLine,
  peerAllowed,
  readPairingAddress,
  redactSecrets,
  rememberLog,
  validatePairingAddress,
} from './lib.mjs';

test('accepts a Tailscale IPv4 address and a MagicDNS name', () => {
  assert.deepEqual(validatePairingAddress(' 100.64.1.20 '), { ok: true, address: '100.64.1.20' });
  assert.equal(validatePairingAddress('100.127.255.254').ok, true);
  assert.equal(validatePairingAddress('umbrel.tailnet.ts.net').ok, true);
  assert.equal(validatePairingAddress('umbrel').ok, true);
  assert.equal(validatePairingAddress('fd7a:115c:a1e0::1').ok, true);
});

test('rejects addresses clients on the tailnet cannot use', () => {
  for (const input of [
    '',
    '   ',
    '10.0.0.5',
    '192.168.1.2',
    '8.8.8.8',
    '100.63.1.1',
    '100.128.0.1',
    '127.0.0.1',
    'localhost',
    'umbrel.local',
    'http://100.64.1.20',
    '100.64.1.20:6768',
    'ws://100.64.1.20:6768',
    '::1',
    'fd7a:115c:a1e1::1',
  ]) {
    assert.equal(validatePairingAddress(input).ok, false, input);
  }
});

test('a blank pairing file means not configured', () => {
  assert.deepEqual(readPairingAddress(''), { ok: true, address: '' });
  assert.deepEqual(readPairingAddress('# note\n\n'), { ok: true, address: '' });
  assert.deepEqual(readPairingAddress('100.64.1.20\n'), { ok: true, address: '100.64.1.20' });
  assert.equal(readPairingAddress('10.1.1.1\n').ok, false);
});

test('serve argv pins the port, binds inside the container, and refuses public clients', () => {
  const args = buildServeArgs({ bin: '/opt/orca-server/bin/orca-ide', address: '100.64.1.20' });
  assert.deepEqual(args, [
    '/opt/orca-server/bin/orca-ide',
    'serve',
    '--port', '6768',
    '--bind', '0.0.0.0',
    '--pairing-address', '100.64.1.20',
    '--refuse-public',
    '--json',
  ]);
  assert.equal(args.includes('--allow-public'), false);
  assert.equal(args.includes('--mobile-pairing'), false);
});

test('ready parser reads the json contract and the text form', () => {
  const json = JSON.stringify({
    type: 'orca_server_ready',
    endpoint: 'ws://0.0.0.0:6768',
    boundEndpoint: 'ws://0.0.0.0:6768',
    advertisedEndpoint: 'ws://100.64.1.20:6768',
    pairing: { url: 'orca://pair?code=secret', endpoint: 'ws://100.64.1.20:6768' },
  });
  assert.equal(parseReadyLine(json).pairingUrl, 'orca://pair?code=secret');
  assert.equal(parseReadyLine('Advertised endpoint: ws://100.64.1.20:6768').advertisedEndpoint, 'ws://100.64.1.20:6768');
  assert.equal(parseReadyLine('listening'), null);
  assert.equal(parseReadyLine('{'), null);
});

test('logs keep the pairing code out', () => {
  const lines = rememberLog([], 'Pairing URL: orca://pair?code=super-secret\nbound ws://0.0.0.0:6768 token=abc');
  assert.deepEqual(lines, ['bound ws://0.0.0.0:6768 token=redacted']);
  assert.equal(redactSecrets('orca://pair?code=super-secret').includes('super-secret'), false);
});

test('only loopback and the Umbrel proxy may open the tile when the proxy is required', () => {
  const proxyIps = new Set(['172.18.0.4']);
  assert.equal(peerAllowed({ ip: '127.0.0.1', proxyIps, requireProxy: true }), true);
  assert.equal(peerAllowed({ ip: '::ffff:172.18.0.4', proxyIps, requireProxy: true }), true);
  assert.equal(peerAllowed({ ip: '172.18.0.9', proxyIps, requireProxy: true }), false);
  assert.equal(peerAllowed({ ip: '172.18.0.9', proxyIps, requireProxy: false }), true);
});

function fakeRuntime() {
  const byPid = new Map();
  const spawns = [];
  const pending = [];
  let pid = 0;
  let cleared = 0;
  return {
    spawns,
    pending,
    cleared: () => cleared,
    spawn(cmd, args) {
      const child = new EventEmitter();
      child.pid = ++pid;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exited = false;
      byPid.set(child.pid, child);
      spawns.push({ cmd, args, child });
      return child;
    },
    kill(id, sig) {
      const child = byPid.get(Math.abs(id));
      if (!child || child.signaled) {
        const err = new Error('esrch');
        err.code = 'ESRCH';
        throw err;
      }
      child.signaled = sig;
      queueMicrotask(() => {
        child.exited = true;
        child.emit('exit', 0, sig);
      });
    },
    schedule(fn, ms) {
      const handle = { fn, ms, cancelled: false };
      pending.push(handle);
      return handle;
    },
    clear(handle) {
      handle.cancelled = true;
    },
    sleep() {
      return new Promise(() => {});
    },
    clearFallback() {
      cleared += 1;
    },
  };
}

test('supervisor starts orca, keeps the pairing url, and restarts on exit', async () => {
  const rt = fakeRuntime();
  const sup = createSupervisor(rt);
  await sup.setAddress('100.64.1.20');
  assert.equal(rt.spawns.length, 1);
  assert.equal(rt.cleared(), 1);
  assert.equal(rt.spawns[0].args[rt.spawns[0].args.indexOf('--pairing-address') + 1], '100.64.1.20');
  const line = JSON.stringify({
    type: 'orca_server_ready',
    advertisedEndpoint: 'ws://100.64.1.20:6768',
    pairing: { url: 'orca://pair?code=secret' },
  });
  rt.spawns[0].child.stderr.emit('data', Buffer.from(`${line}\n`));
  assert.equal(sup.snapshot().phase, 'ready');
  assert.equal(sup.snapshot().pairingUrl, 'orca://pair?code=secret');
  assert.equal(JSON.stringify(sup.snapshot().log).includes('secret'), false);

  rt.spawns[0].child.stderr.emit('data', Buffer.from('orca-ide: boom\n'));
  rt.spawns[0].child.emit('exit', 1, null);
  assert.equal(sup.snapshot().phase, 'exited');
  assert.equal(rt.pending.length, 1);
  assert.equal(rt.pending[0].ms, 1000);
  rt.pending[0].fn();
  assert.equal(rt.spawns.length, 2);
});

test('a new Tailscale address replaces the running server', async () => {
  const rt = fakeRuntime();
  const sup = createSupervisor(rt);
  await sup.setAddress('100.64.1.20');
  await sup.setAddress('100.90.0.8');
  assert.equal(rt.spawns.length, 2);
  assert.equal(rt.spawns[0].child.signaled, 'SIGTERM');
  const args = rt.spawns[1].args;
  assert.equal(args[args.indexOf('--pairing-address') + 1], '100.90.0.8');
  assert.equal(sup.snapshot().address, '100.90.0.8');
});

test('clearing the address stops orca and a stop cancels a pending restart', async () => {
  const rt = fakeRuntime();
  const sup = createSupervisor(rt);
  await sup.setAddress('100.64.1.20');
  await sup.setAddress('');
  assert.equal(sup.snapshot().phase, 'needs-address');
  assert.equal(rt.spawns[0].child.signaled, 'SIGTERM');

  await sup.setAddress('100.64.1.20');
  const child = rt.spawns.at(-1).child;
  child.emit('exit', 1, null);
  assert.equal(rt.pending.length, 1);
  await sup.stop();
  assert.equal(rt.pending[0].cancelled, true);
  rt.pending[0].fn();
  assert.equal(rt.spawns.length, 2);
});
