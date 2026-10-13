// node --test manager/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RUNNER_NAME_RE,
  attributeOom,
  cleanStepLog,
  foldUsage,
  hostCpuBusy,
  memUsed,
  ownsRunner,
  parseMeminfo,
  parseProcStat,
  failureExcerpt,
  failureHint,
  stepSummary,
  stepsOf,
  usageView,
  backoffMs,
  demuxDockerLogs,
  forkHead,
  classifyQueued,
  historyStats,
  jobLimits,
  jobLink,
  jobWantsUs,
  normalizeRepo,
  parseRunnerLog,
  planSpawns,
  pruneHistory,
  reapReason,
  runnerLabels,
  tokenKind,
} from './lib.mjs';

const GiB = 1024 ** 3;
const repos_ = (plan) => plan.map((p) => p.repo);

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
  assert.deepEqual(runnerLabels('x64', { docker: true }), ['self-hosted', 'umbrel-docker', 'Linux', 'X64']);
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
  assert.equal(jobWantsUs(['self-hosted', 'umbrel-docker'], ours), false, 'a Docker job is not for a light runner');
  const docker = runnerLabels('x64', { docker: true });
  assert.equal(jobWantsUs(['self-hosted', 'umbrel-docker'], docker), true);
  assert.equal(jobWantsUs(['self-hosted', 'umbrel'], docker), false, 'a light job never lands on a Docker runner');
  assert.equal(jobWantsUs(['self-hosted', 'umbrel', 'umbrel-docker'], docker), false);
});

test('jobLimits: memory is half the box split across the cap; CPU is the whole box, shared by weight', () => {
  // A 4-core, 16 GB Umbrel Home.
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 2 }), { cpus: 4, memory: 4 * GiB, pids: 4096, shm: GiB });
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 1 }), { cpus: 4, memory: 8 * GiB, pids: 4096, shm: GiB });
  // A 4 GB Raspberry Pi: the memory floor wins.
  const pi = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 4 });
  assert.equal(pi.cpus, 4);
  assert.equal(pi.memory, GiB);
  assert.equal(pi.shm, GiB / 4);
  // A big server: the memory ceiling wins; a job may still use every CPU.
  const big = jobLimits({ ncpu: 64, memBytes: 256 * GiB, maxRunners: 1 });
  assert.equal(big.cpus, 64);
  assert.equal(big.memory, 8 * GiB);
  // A bogus cap is clamped, not trusted. An unknown CPU count reads as 2.
  assert.deepEqual(jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 99 }), jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 4 }));
  assert.equal(jobLimits({ memBytes: 16 * GiB, maxRunners: 2 }).cpus, 2);
});

test('jobLimits: when the memory floor binds, a full set can take all the memory', () => {
  // The README's numbers. 4-core, 4 GB Pi at cap 4: memory is all used.
  const pi = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 4 });
  assert.equal(4 * pi.memory, 4 * GiB);
  // Cap at most half the memory in GB: within half.
  const half = jobLimits({ ncpu: 4, memBytes: 4 * GiB, maxRunners: 2 });
  assert.equal(2 * half.memory, 2 * GiB);
  // 4-core, 16 GB at the default cap: 8 GB for the set.
  const home = jobLimits({ ncpu: 4, memBytes: 16 * GiB, maxRunners: 2 });
  assert.equal(2 * home.memory, 8 * GiB);
});

test('docker-compose: dind has a low CPU weight and no hard CPU cap', () => {
  // Every job runs inside dind. A low weight lets the Umbrel's other apps
  // win when the CPU is busy; an idle box gives the jobs every core.
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const dind = compose.slice(compose.indexOf('\n  dind:\n'), compose.indexOf('\n  manager:\n'));
  const shares = Number(dind.match(/^    cpu_shares: (\d+)$/m)?.[1]);
  assert.ok(shares >= 2 && shares < 1024, `dind cpu_shares is ${shares}`);
  assert.doesNotMatch(dind, /^    (cpus|cpu_quota|cpu_period):/m);
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
  assert.deepEqual(repos_(planSpawns({ repos, runners: [{ repo: 'a/x', busy: true }, { repo: 'a/y', busy: true }], maxRunners: 2 })), []);
  assert.deepEqual(repos_(planSpawns({ repos: [{ name: 'a/x', queued: 0 }], runners: [], maxRunners: 2 })), []);
});

test('planSpawns: idle runners already cover their repo', () => {
  const repos = [{ name: 'a/x', queued: 2 }];
  assert.deepEqual(repos_(planSpawns({ repos, runners: [{ repo: 'a/x', busy: false }], maxRunners: 4 })), ['a/x']);
  assert.deepEqual(repos_(planSpawns({ repos, runners: [{ repo: 'a/x', busy: false }, { repo: 'a/x', busy: false }], maxRunners: 4 })), []);
  // A busy runner is on another job; it does not cover the queue.
  assert.deepEqual(repos_(planSpawns({ repos, runners: [{ repo: 'a/x', busy: true }], maxRunners: 4 })), ['a/x', 'a/x']);
});

test('planSpawns: oldest queue first, slots shared across repos', () => {
  const repos = [
    { name: 'a/new', queued: 5, oldestQueuedAt: '2026-10-09T12:05:00Z' },
    { name: 'a/old', queued: 5, oldestQueuedAt: '2026-10-09T12:00:00Z' },
  ];
  assert.deepEqual(repos_(planSpawns({ repos, runners: [], maxRunners: 3 })), ['a/old', 'a/new', 'a/old']);
  assert.deepEqual(repos_(planSpawns({ repos, runners: [], maxRunners: 1 })), ['a/old']);
});

test('planSpawns: a repo in back-off waits', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const repos = [
    { name: 'a/x', queued: 1, blockedUntil: now + 1000 },
    { name: 'a/y', queued: 1, blockedUntil: now - 1000 },
  ];
  assert.deepEqual(repos_(planSpawns({ repos, runners: [], maxRunners: 4, now })), ['a/y']);
});

test('planSpawns: Docker jobs get Docker runners, at most maxDocker at once', () => {
  const repos = [{ name: 'a/x', queued: 1, queuedDocker: 3, oldestQueuedAt: '2026-10-09T12:05:00Z', oldestDockerQueuedAt: '2026-10-09T12:00:00Z' }];
  assert.deepEqual(planSpawns({ repos, runners: [], maxRunners: 4 }), [
    { repo: 'a/x', docker: true },
    { repo: 'a/x', docker: false },
  ]);
  // A Docker runner already up, busy: no second one, the light job still starts.
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/x', busy: true, docker: true }], maxRunners: 4 }), [{ repo: 'a/x', docker: false }]);
  // An idle light runner does not cover a Docker job, nor the reverse.
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queuedDocker: 1 }], runners: [{ repo: 'a/x', busy: false, docker: false }], maxRunners: 4 }), [{ repo: 'a/x', docker: true }]);
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queued: 1 }], runners: [{ repo: 'a/x', busy: false, docker: true }], maxRunners: 4 }), [{ repo: 'a/x', docker: false }]);
  assert.deepEqual(planSpawns({ repos: [{ name: 'a/x', queuedDocker: 1 }], runners: [{ repo: 'a/x', busy: false, docker: true }], maxRunners: 4 }), []);
  // The parallel-jobs cap still counts Docker runners.
  assert.deepEqual(planSpawns({ repos, runners: [{ repo: 'a/y', busy: true }], maxRunners: 2 }), [{ repo: 'a/x', docker: true }]);
  assert.deepEqual(repos_(planSpawns({ repos, runners: [], maxRunners: 4, maxDocker: 2 })).length, 3);
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
  assert.ok(RUNNER_NAME_RE.test('umbrel-0a1b2c3d'), 'the pre-0.1.5 name');
  assert.ok(RUNNER_NAME_RE.test('umbrel-ab12-0a1b2c'));
  assert.ok(ownsRunner('ab12', 'umbrel-ab12-0a1b2c'));
  assert.ok(!ownsRunner('ab12', 'umbrel-cd34-0a1b2c'), "another Umbrel's runner");
  assert.ok(!ownsRunner('ab12', 'umbrel-0a1b2c3d'), 'a pre-0.1.5 name is nobody\'s');
  assert.ok(!ownsRunner('', 'umbrel-ab12-0a1b2c'), 'no install ID owns nothing');
  assert.ok(!ownsRunner('ab12', 'umbrel-ab12-zzzzzz'));
  assert.ok(!RUNNER_NAME_RE.test('umbrel-runner'));
  assert.ok(!RUNNER_NAME_RE.test('my-laptop'));
});

test('jobLink: the job, its run, and its pull request when it has one', () => {
  const run = { name: 'CI', event: 'pull_request', head_branch: 'feat/x', html_url: 'https://github.com/me/app/actions/runs/7', pull_requests: [{ number: 12 }] };
  const job = { html_url: 'https://github.com/me/app/actions/runs/7/job/70' };
  assert.deepEqual(jobLink('me/app', run, job), {
    workflow: 'CI',
    event: 'pull_request',
    branch: 'feat/x',
    pr: 12,
    prUrl: 'https://github.com/me/app/pull/12',
    prMerged: false,
    runUrl: 'https://github.com/me/app/actions/runs/7',
    jobUrl: 'https://github.com/me/app/actions/runs/7/job/70',
    runId: 0,
    attempt: 1,
    jobId: 0,
    sha: '',
    queuedAt: '',
    startedAt: '',
  });
  const nightly = jobLink('me/app', { ...run, event: 'schedule', pull_requests: [] }, job);
  assert.equal(nightly.pr, 0);
  assert.equal(nightly.prUrl, '', 'no pull request, no PR link');
  assert.equal(nightly.runUrl, run.html_url);
  // A push of a merged pull request (main after a squash or merge) names it
  // in the commit title; the run itself lists no pull request.
  const push = (message, branch = 'main', opts = { defaultBranch: 'main' }) => jobLink('me/app', { ...run, event: 'push', head_branch: branch, pull_requests: [], head_commit: { message } }, job, opts);
  assert.deepEqual([push('feat: add a thing (#1702)\n\nbody').pr, push('feat: add a thing (#1702)').prMerged], [1702, true]);
  assert.equal(push('Merge pull request #88 from me/branch\n\ntitle').pr, 88);
  assert.equal(push('fix: see #12 for why').pr, 0, 'a mention is not a merge');
  assert.equal(push('docs: body mentions it\n\n(#9)').pr, 0, 'only the title counts');
  assert.equal(push('feat: add a thing (#1702)', 'feat/x').pr, 0, 'a push to another branch merged nothing');
  assert.equal(push('feat: add a thing (#1702)', 'main', {}).pr, 0, 'default branch unknown: no guess');
  assert.equal(jobLink('me/app', { ...run, event: 'schedule', pull_requests: [], head_commit: { message: 'x (#5)' } }, job).pr, 0, 'not a push: no guess');
  // Only https links reach the page.
  const odd = jobLink('me/app', { html_url: 'javascript:alert(1)' }, { html_url: 'http://x' });
  assert.equal(odd.runUrl, '');
  assert.equal(odd.jobUrl, '');
  assert.deepEqual(jobLink('me/app', undefined, undefined), {
    workflow: '', event: '', branch: '', pr: 0, prUrl: '', prMerged: false, runUrl: '', jobUrl: '',
    runId: 0, attempt: 1, jobId: 0, sha: '', queuedAt: '', startedAt: '',
  });
  const ids = jobLink('me/app', { ...run, id: 7, run_attempt: 2, head_sha: 'abcdef0123456789' }, { ...job, id: 70, created_at: '2026-10-11T10:00:00Z', started_at: '2026-10-11T10:00:30Z' });
  assert.deepEqual([ids.runId, ids.attempt, ids.jobId, ids.sha, ids.queuedAt, ids.startedAt], [7, 2, 70, 'abcdef012345', '2026-10-11T10:00:00Z', '2026-10-11T10:00:30Z']);
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

test('classifyQueued: what this Umbrel can do with a queued job', () => {
  const light = runnerLabels('x64');
  const docker = runnerLabels('x64', { docker: true });
  const c = (labels, dockerOn = true) => classifyQueued(labels, { light, docker, dockerOn });
  assert.equal(c(['self-hosted', 'umbrel']), 'light');
  assert.equal(c(['self-hosted', 'umbrel-docker']), 'docker');
  assert.equal(c(['self-hosted', 'umbrel-docker'], false), 'docker-off');
  assert.equal(c(['self-hosted', 'umbrel', 'ARM64']), 'mismatch', 'an arm64 job on an x64 box');
  assert.equal(c(['self-hosted', 'umbrel', 'gpu']), 'mismatch');
  assert.equal(c(['self-hosted', 'zot24-mac']), '', 'a Mac job is not for an Umbrel');
  assert.equal(c(['ubuntu-latest']), '');
});

test('pruneHistory: the failure excerpt is kept like the runner lines, on the newest only', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const at = new Date(now - 60_000).toISOString();
  const kept = pruneHistory([{ finishedAt: at, failure: { hint: 'heap', excerpt: 'a' } }, { finishedAt: at, failure: { hint: 'oom', excerpt: 'b' } }], { now, keepTails: 1 });
  assert.deepEqual(kept.map((h) => h.failure), [{ hint: 'heap', excerpt: 'a' }, { hint: 'oom', excerpt: '' }], 'the hint stays');
});

test('pruneHistory: seven days, a count cap, and runner lines only on the newest', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const at = (h) => new Date(now - h * 3600_000).toISOString();
  const history = [
    { finishedAt: at(1), tail: 'a' },
    { finishedAt: at(2), tail: 'b' },
    { finishedAt: at(24 * 8), tail: 'old' },
  ];
  const kept = pruneHistory(history, { now, keepTails: 1 });
  assert.equal(kept.length, 2, 'older than seven days goes');
  assert.equal(kept[0].tail, 'a');
  assert.equal(kept[1].tail, '', 'only the newest keep their runner lines');
  assert.equal(pruneHistory(history, { now, maxEntries: 1 }).length, 1);
});

test('historyStats: jobs, results, runner minutes and queue wait with sample counts', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const h = (minsAgo, result, runMin, waitS) => {
    const end = now - minsAgo * 60_000;
    const start = end - runMin * 60_000;
    return {
      result,
      finishedAt: new Date(end).toISOString(),
      jobStartedAt: new Date(start).toISOString(),
      link: waitS === null ? null : { queuedAt: new Date(start - waitS * 1000).toISOString(), startedAt: new Date(start).toISOString() },
    };
  };
  const history = [h(10, 'Succeeded', 5, 30), h(20, 'Failed', 10, 90), h(30, 'Succeeded', 15, null), h(60 * 30, 'Succeeded', 60, 600)];
  const day = historyStats(history, { now, windowMs: 24 * 3600_000 });
  assert.equal(day.jobs, 3);
  assert.deepEqual(day.results, { Succeeded: 2, Failed: 1 });
  assert.equal(day.runnerMinutes, 30);
  assert.equal(day.wait.samples, 2, 'a job without a link has no wait sample');
  assert.equal(day.wait.p50, 90);
  const week = historyStats(history, { now, windowMs: 7 * 24 * 3600_000 });
  assert.equal(week.jobs, 4);
  assert.equal(week.runnerMinutes, 90);
  assert.equal(historyStats([], { now, windowMs: 1000 }).wait.p50, null);
});

test('memUsed: usage minus the page cache the kernel can drop, as docker stats shows', () => {
  assert.equal(memUsed({ usage: 5000, stats: { inactive_file: 1200 } }), 3800, 'cgroup v2');
  assert.equal(memUsed({ usage: 5000, stats: { total_inactive_file: 1000 } }), 4000, 'cgroup v1');
  assert.equal(memUsed({ usage: 100, stats: { inactive_file: 300 } }), 0, 'never negative');
  assert.equal(memUsed({}), 0, 'an exited container reports nothing');
  assert.equal(memUsed(undefined), 0);
});

test('foldUsage: CPU over each interval, peaks, and the average over busy time only', () => {
  const s = (t, cpuS, mem, busy = true, job = null) => ({ at: t * 1000, busy, cpuNs: cpuS * 1e9, mem, memLimit: 8000, cpuLimit: 2, job });
  let u = foldUsage(null, s(0, 0.5, 100, false));
  assert.equal(u.cpu, null, 'the first sample has no interval yet');
  assert.equal(u.samples, 0);
  u = foldUsage(u, s(10, 1.5, 3000)); // 1 CPU-second over 10 s while busy
  assert.equal(u.cpu, 0.1);
  u = foldUsage(u, s(20, 16.5, 6000)); // 15 CPU-seconds over 10 s
  assert.equal(u.cpu, 1.5);
  u = foldUsage(u, s(30, 17.5, 2000));
  const v = usageView(u);
  assert.equal(v.cpu, 0.1, 'now');
  assert.equal(v.cpuPeak, 1.5);
  assert.equal(v.cpuAvg, 0.57, '17 CPU-seconds over 30 busy seconds');
  assert.equal(v.mem, 2000);
  assert.equal(v.memPeak, 6000);
  assert.deepEqual([v.memLimit, v.cpuLimit, v.samples, v.oom], [8000, 2, 3, 0]);
  // Idle intervals (before the job starts) count toward peaks of memory only.
  const idle = foldUsage(foldUsage(null, s(0, 0, 10, false)), s(10, 5, 20, false));
  assert.equal(usageView(idle).cpuAvg, null, 'no busy interval, no average');
  assert.equal(usageView(idle).cpuPeak, null);
  // A counter that went backwards (container restarted) is not negative CPU.
  assert.equal(foldUsage(foldUsage(null, s(0, 9, 1)), s(10, 1, 1)).cpu, 0);
});

test('foldUsage: a Docker job also counts the containers it starts, new ones from zero', () => {
  const s = (t, job) => ({ at: t * 1000, busy: true, cpuNs: 0, mem: 500, memLimit: 8000, cpuLimit: 2, job });
  let u = foldUsage(null, s(0, [{ id: 'db', cpuNs: 40e9, mem: 1000 }]));
  assert.equal(u.job.cpu, null, 'first sample: no interval');
  u = foldUsage(u, s(10, [{ id: 'db', cpuNs: 50e9, mem: 1500 }, { id: 'api', cpuNs: 5e9, mem: 700 }]));
  assert.equal(u.job.cpu, 1.5, 'db used 10 s, api (new since the last sample) 5 s, over 10 s');
  u = foldUsage(u, s(20, [{ id: 'api', cpuNs: 6e9, mem: 300 }]));
  const v = usageView(u);
  assert.deepEqual(v.job, { containers: 1, containersMax: 2, cpu: 0.1, cpuAvg: 0.8, cpuPeak: 1.5, mem: 300, memPeak: 2200 });
  assert.equal(usageView(foldUsage(null, s(0, null))).job, null, 'a light runner has no job containers');
});

test('usageView without live values: what a finished job keeps', () => {
  const u = foldUsage(foldUsage(null, { at: 0, busy: true, cpuNs: 0, mem: 10, memLimit: 100, cpuLimit: 1, job: null }), { at: 5000, busy: true, cpuNs: 5e9, mem: 95, memLimit: 100, cpuLimit: 1, job: null });
  u.oom = 2;
  const kept = usageView(u, { live: false });
  assert.deepEqual(kept, { cpuAvg: 1, cpuPeak: 1, cpuLimit: 1, memPeak: 95, memLimit: 100, oom: 2, samples: 1, job: null });
  assert.equal(usageView(null), null);
});

test('attributeOom: an oom event goes to the runner it names, or to the Docker runner', () => {
  const ev = (name, ghr, id = 'x') => ({ Type: 'container', Action: 'oom', timeNano: 1, Actor: { ID: id, Attributes: { name, ...(ghr ? { 'ghr.name': ghr } : {}) } } });
  const counts = attributeOom(
    [ev('ghr-umbrel-8ef4-aaaaaa', 'umbrel-8ef4-aaaaaa'), ev('ghr-umbrel-8ef4-aaaaaa', 'umbrel-8ef4-aaaaaa'), ev('supabase_db', null), { Type: 'container', Action: 'die', Actor: { Attributes: {} } }],
    { dockerRunner: 'umbrel-8ef4-dddddd' },
  );
  assert.deepEqual(Object.fromEntries(counts), { 'umbrel-8ef4-aaaaaa': 2, 'umbrel-8ef4-dddddd': 1 });
  assert.deepEqual(Object.fromEntries(attributeOom([ev('stray', null)], { dockerRunner: '' })), {}, 'no Docker job running: nobody to charge');
});

test('stepsOf and stepSummary: the step GitHub says is running, and the one that failed', () => {
  const job = {
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: '2026-10-12T00:00:00Z', completed_at: '2026-10-12T00:00:02Z' },
      { number: 2, name: 'Type check', status: 'in_progress', conclusion: null, started_at: '2026-10-12T00:00:02Z', completed_at: null },
      { number: 3, name: 'Post Run actions/checkout@v4', status: 'queued', conclusion: null, started_at: null, completed_at: null },
    ],
  };
  const steps = stepsOf(job);
  assert.deepEqual(steps[1], { n: 2, name: 'Type check', status: 'in_progress', conclusion: '', startedAt: '2026-10-12T00:00:02Z', completedAt: '' });
  assert.deepEqual(stepSummary(steps), { total: 3, done: 1, current: steps[1], failed: null });
  steps[1] = { ...steps[1], status: 'completed', conclusion: 'failure' };
  assert.equal(stepSummary(steps).failed.name, 'Type check');
  assert.equal(stepSummary(steps).current, null);
  assert.deepEqual(stepsOf({}), []);
  assert.equal(stepsOf({ steps: Array.from({ length: 300 }, (_, i) => ({ number: i, name: 's' })) }).length, 100, 'capped');
  assert.deepEqual(stepSummary([]), { total: 0, done: 0, current: null, failed: null });
});

test('cleanStepLog: the runner page file, cut to whole lines with short times', () => {
  const text = 'cut line\n2026-10-12T00:23:56.1234567Z ##[group]Run pnpm test\n2026-10-12T00:23:57.0000000Z \u001b[32m ok 12 tests\u001b[0m\r\nplain continuation\n';
  assert.equal(cleanStepLog(text, { cut: true }), '00:23:56 ##[group]Run pnpm test\n00:23:57  ok 12 tests\nplain continuation');
  assert.equal(cleanStepLog('2026-10-12T00:00:01.5Z first\n', { cut: false }), '00:00:01 first');
  assert.equal(cleanStepLog('', { cut: true }), '');
});

test('host figures from /proc: CPU busy between two reads, and memory', () => {
  const a = parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3\n');
  const b = parseProcStat('cpu  160 0 70 900 70 0 0 0 0 0\n');
  assert.deepEqual(a, { busy: 150, iowait: 50, total: 1000 });
  assert.deepEqual(hostCpuBusy(a, b), { busy: 0.4, iowait: 0.1 }, '80 of 200 jiffies busy, 20 waiting on disk');
  assert.equal(hostCpuBusy(null, b), null);
  assert.equal(hostCpuBusy(b, b), null, 'no time passed');
  assert.equal(parseProcStat('garbage'), null);
  assert.deepEqual(parseMeminfo('MemTotal:       16118656 kB\nMemFree:  1 kB\nMemAvailable:    8059328 kB\n'), { total: 16118656 * 1024, available: 8059328 * 1024 });
  assert.equal(parseMeminfo('nothing'), null);
});

test('historyStats: jobs that ran out of memory or came close to their limit', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const at = new Date(now - 60_000).toISOString();
  const h = (usage) => ({ result: 'Succeeded', finishedAt: at, jobStartedAt: at, usage });
  const st = historyStats([h({ oom: 1, memPeak: 50, memLimit: 100 }), h({ oom: 0, memPeak: 95, memLimit: 100 }), h({ oom: 0, memPeak: 10, memLimit: 100 }), h(undefined)], { now, windowMs: 3600_000 });
  assert.equal(st.oom, 1);
  assert.equal(st.nearMemLimit, 1, 'at or above 90% of the limit, without an OOM kill');
  assert.equal(st.sampled, 3);
});

test('failureExcerpt: the lines leading to the last error of GitHub\'s job log', () => {
  const t = (s, line) => `2026-10-12T00:00:${String(s).padStart(2, '0')}.1234567Z ${line}`;
  const log = [
    t(0, '##[group]Run actions/upload-artifact@v4'),
    t(1, '##[error]Artifact storage quota has been hit'), // continue-on-error, not the failure
    ...Array.from({ length: 50 }, (_, i) => t(2, `tsc line ${i}`)),
    t(3, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'),
    t(4, '##[error]Process completed with exit code 134.'),
    t(5, 'Post job cleanup.'),
  ].join('\r\n');
  const ex = failureExcerpt(log, { before: 5 });
  assert.deepEqual(ex.split('\n'), ['00:00:02 tsc line 46', '00:00:02 tsc line 47', '00:00:02 tsc line 48', '00:00:02 tsc line 49', '00:00:03 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', '00:00:04 ##[error]Process completed with exit code 134.']);
  assert.equal(failureExcerpt([t(0, 'a'), t(1, 'b'), t(2, 'c')].join('\n'), { before: 2 }), '00:00:01 b\n00:00:02 c', 'no error line: the last lines');
  assert.ok(failureExcerpt(t(0, 'x'.repeat(20_000)), { maxBytes: 1000 }).length <= 1000, 'capped');
});

test('failureHint: what a failure looks like, from the log and the OOM count', () => {
  assert.equal(failureHint('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'), 'heap');
  assert.equal(failureHint('##[error]Process completed with exit code 137.', { oom: 1 }), 'oom');
  assert.equal(failureHint('', { oom: 2 }), 'oom', 'the kernel said so, whatever the log');
  assert.equal(failureHint('##[error]Process completed with exit code 137.'), 'killed');
  assert.equal(failureHint('ENOSPC: no space left on device, write'), 'disk');
  assert.equal(failureHint('Error: No space left on device'), 'disk');
  assert.equal(failureHint('##[error]Process completed with exit code 1.'), '');
});

test('demuxDockerLogs: a stream cut by the read cap keeps its whole frames and the cut one\'s start', () => {
  const frame = (t) => { const b = Buffer.from(t); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const full = Buffer.concat([frame('first line\n'), frame('second line that goes on')]);
  const cut = full.subarray(0, full.length - 8);
  assert.equal(demuxDockerLogs(cut, { truncated: true }), 'first line\nsecond line that');
  assert.equal(demuxDockerLogs(cut), cut.toString(), 'not asked to: an odd buffer is returned as-is');
});

test('stepSummary: a step that timed out or was cancelled is where the job stopped too', () => {
  const st = (n, status, conclusion) => ({ n, name: `s${n}`, status, conclusion, startedAt: '', completedAt: '' });
  assert.equal(stepSummary([st(1, 'completed', 'success'), st(2, 'completed', 'timed_out'), st(3, 'completed', 'skipped')]).failed.n, 2);
  assert.equal(stepSummary([st(1, 'completed', 'success'), st(2, 'completed', 'cancelled'), st(3, 'completed', 'cancelled')]).failed.n, 2);
  assert.equal(stepSummary([st(1, 'completed', 'skipped')]).failed, null);
});
