// node --test manager/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
  tokenKind,
} from './lib.mjs';

const GiB = 1024 ** 3;

test('normalizeRepo accepts the usual spellings', () => {
  for (const s of [
    'zot24/umbrel-apps',
    ' zot24/umbrel-apps ',
    'https://github.com/zot24/umbrel-apps',
    'https://github.com/zot24/umbrel-apps.git',
    'https://github.com/zot24/umbrel-apps/',
    'git@github.com:zot24/umbrel-apps.git',
  ]) {
    assert.equal(normalizeRepo(s), 'zot24/umbrel-apps', s);
  }
  assert.equal(normalizeRepo('a-b/c.d_e'), 'a-b/c.d_e');
});

test('normalizeRepo refuses everything else', () => {
  for (const s of ['', 'zot24', 'zot24/', '/repo', 'a/b/c', 'zot24/..', '-x/y', 'x/y z', 'https://gitlab.com/a/b', 'a/b?x', null]) {
    assert.equal(normalizeRepo(s), null, String(s));
  }
});

test('runner labels follow the host architecture', () => {
  assert.deepEqual(runnerLabels('x64'), ['self-hosted', 'umbrel', 'Linux', 'X64']);
  assert.deepEqual(runnerLabels('arm64'), ['self-hosted', 'umbrel', 'Linux', 'ARM64']);
});

test('jobWantsUs: needs umbrel, and only labels we have', () => {
  const ours = runnerLabels('x64');
  assert.equal(jobWantsUs(['self-hosted', 'umbrel'], ours), true);
  assert.equal(jobWantsUs(['Self-Hosted', 'UMBREL', 'linux', 'x64'], ours), true);
  assert.equal(jobWantsUs(['umbrel'], ours), true);
  assert.equal(jobWantsUs(['self-hosted'], ours), false, 'plain self-hosted may be another runner');
  assert.equal(jobWantsUs(['ubuntu-latest'], ours), false);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel', 'gpu'], ours), false);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel', 'ARM64'], ours), false);
  assert.equal(jobWantsUs([], ours), false);
  assert.equal(jobWantsUs(undefined, ours), false);
});

test('jobLimits: half the box, split across the cap', () => {
  // A 4-core, 16 GB Umbrel Home.
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 2 }), { cpus: 1, memory: 4 * GiB, pids: 4096, shm: GiB });
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 1 }), { cpus: 2, memory: 8 * GiB, pids: 4096, shm: GiB });
  // A 4 GB Raspberry Pi: the floor wins.
  const pi = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 4 });
  assert.equal(pi.cpus, 0.5);
  assert.equal(pi.memory, GiB);
  assert.equal(pi.shm, GiB / 4);
  // A big server: the ceiling wins.
  const big = jobLimits({ ncpu: 64, memBytes: 256 * GiB, maxRunners: 1 });
  assert.equal(big.cpus, 4);
  assert.equal(big.memory, 8 * GiB);
  // A bogus cap is clamped, not trusted.
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 99 }), jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 4 }));
});

test('jobLimits: when the floor binds, a full set can take the whole box', () => {
  // The README's numbers. 4-core, 4 GB Pi at cap 4: memory is all used.
  const pi = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 4 });
  assert.equal(4 * pi.memory, 4 * GiB);
  assert.equal(4 * pi.cpus, 2);
  // 2-core box at cap 4: every core.
  assert.equal(4 * jobLimits({ ncpu: 2, memBytes: 16 * GiB, maxRunners: 4 }).cpus, 2);
  // Cap at most the CPU count and half the memory in GB: within half.
  const half = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 2 });
  assert.deepEqual([2 * half.cpus, 2 * half.memory], [2, 2 * GiB]);
  // 4-core, 16 GB at the default cap: 2 CPUs and 8 GB for the set.
  const home = jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 2 });
  assert.deepEqual([2 * home.cpus, 2 * home.memory], [2, 8 * GiB]);
});

test('demuxDockerLogs strips stream frames and passes raw text through', () => {
  const frame = (type, s) => {
    const body = Buffer.from(s);
    const h = Buffer.alloc(8);
    h[0] = type;
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  assert.equal(demuxDockerLogs(Buffer.concat([frame(1, 'hello '), frame(2, 'world\n')])), 'hello world\n');
  assert.equal(demuxDockerLogs(Buffer.from('plain text output\n')), 'plain text output\n');
  assert.equal(demuxDockerLogs(Buffer.alloc(0)), '');
});

test('parseRunnerLog follows a runner through one job', () => {
  const start = '√ Connected to GitHub\n\nCurrent runner version: \'2.338.0\'\n2026-10-09 12:00:00Z: Listening for Jobs\n';
  assert.deepEqual(parseRunnerLog(start), { connected: true, listening: true });
  const running = `${start}2026-10-09 12:00:05Z: Running job: build (ubuntu, 20)\n`;
  assert.deepEqual(parseRunnerLog(running), {
    connected: true,
    listening: true,
    job: 'build (ubuntu, 20)',
    jobStartedAt: '2026-10-09T12:00:05Z',
  });
  const done = `${running}2026-10-09 12:03:10Z: Job build (ubuntu, 20) completed with result: Succeeded\n√ Removed .credentials\n`;
  assert.equal(parseRunnerLog(done).result, 'Succeeded');
  assert.equal(parseRunnerLog(done).jobFinishedAt, '2026-10-09T12:03:10Z');
  assert.deepEqual(parseRunnerLog('Runner is not configured.\n'), { connected: false, listening: false });
});

test('planSpawns: nothing when full or nothing queued', () => {
  const repos = [{ name: 'a/x', queued: 3 }];
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/x', busy: true }, { repo: 'a/y', busy: true }], maxRunners: 2 }), []);
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queued: 0 }], runners: [], maxRunners: 2 }), []);
});

test('planSpawns: idle runners already cover their repo', () => {
  const repos = [{ name: 'a/x', queued: 2 }];
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/x', busy: false }], maxRunners: 4 }), ['a/x']);
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/x', busy: false }, { repo: 'a/x', busy: false }], maxRunners: 4 }), []);
  // A busy runner is on another job; it does not cover the queue.
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/x', busy: true }], maxRunners: 4 }), ['a/x', 'a/x']);
});

test('planSpawns: oldest queue first, slots shared across repos', () => {
  const repos = [
    { name: 'a/new', queued: 5, oldestQueuedAt: '2026-10-09T12:05:00Z' },
    { name: 'a/old', queued: 5, oldestQueuedAt: '2026-10-09T12:00:00Z' },
  ];
  assert.deepEqual(planSpawns({ repos, runners: [], maxRunners: 3 }), ['a/old', 'a/new', 'a/old']);
  assert.deepEqual(planSpawns({ repos, runners: [], maxRunners: 1 }), ['a/old']);
});

test('planSpawns: a repo in back-off waits', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const repos = [
    { name: 'a/x', queued: 1, blockedUntil: now + 1000 },
    { name: 'a/y', queued: 1, blockedUntil: now - 1000 },
  ];
  assert.deepEqual(planSpawns({ repos, runners: [], maxRunners: 4, now }), ['a/y']);
});

test('reapReason', () => {
  const now = 10_000_000;
  const opts = { now, idleMs: 600_000, maxJobMs: 6 * 3600_000 };
  assert.equal(reapReason({ createdAt: now - 60_000, busy: false }, opts), '');
  assert.equal(reapReason({ createdAt: now - 700_000, busy: false }, opts), 'idle');
  assert.equal(reapReason({ createdAt: now - 700_000, busy: true }, opts), '');
  assert.equal(reapReason({ createdAt: now - 7 * 3600_000, busy: true }, opts), 'timeout');
});

test('backoffMs doubles up to ten minutes', () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(5), 480_000);
  assert.equal(backoffMs(6), 600_000);
  assert.equal(backoffMs(50), 600_000);
});

test('tokenKind keeps classic tokens out', () => {
  assert.equal(tokenKind(`github_pat_11AAAAAAA0${'x'.repeat(70)}`), 'fine-grained');
  assert.equal(tokenKind(`ghp_${'a'.repeat(36)}`), 'classic');
  assert.equal(tokenKind(`gho_${'a'.repeat(36)}`), 'classic');
  assert.equal(tokenKind('hunter2'), 'unknown');
});

test('runner names', () => {
  assert.ok(RUNNER_NAME_RE.test('umbrel-0a1b2c3d'));
  assert.ok(!RUNNER_NAME_RE.test('umbrel-runner'));
  assert.ok(!RUNNER_NAME_RE.test('my-laptop'));
});

test('forkHead: only a run of the repository itself is served', () => {
  const base = { id: 1, full_name: 'me/app', fork: false };
  const fork = { id: 2, full_name: 'them/app', fork: true };
  assert.equal(forkHead({ event: 'push', repository: base, head_repository: base }), '');
  assert.equal(forkHead({ event: 'pull_request', repository: base, head_repository: base }), '', 'a branch of the repo itself');
  assert.match(forkHead({ event: 'pull_request', repository: base, head_repository: fork }), /them\/app is a fork/);
  assert.match(forkHead({ event: 'pull_request_target', repository: base, head_repository: fork }), /them\/app is a fork/);
  assert.match(forkHead({ event: 'pull_request', repository: base, head_repository: null }), /no head repository/);
  assert.match(forkHead({ event: 'pull_request', repository: base, head_repository: { id: 3, full_name: 'x/app', fork: false } }), /is not me\/app/);
  // A served repository that is itself a fork: its own runs are headed by a fork.
  const mine = { id: 4, full_name: 'me/fork-of-app', fork: true };
  assert.match(forkHead({ event: 'push', repository: mine, head_repository: mine }), /is a fork/);
});
