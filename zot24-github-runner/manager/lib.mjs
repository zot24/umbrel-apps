// Pure helpers for the GitHub Runner manager. No I/O here, so lib.test.mjs
// covers them with node:test and server.mjs stays about wiring.

// Every runner this app registers is named like this. Cleanup only ever
// touches registrations whose name matches, never the owner's other runners.
export const RUNNER_NAME_RE = /^umbrel-[0-9a-f]{8}$/;

// GitHub user/org names: alphanumerics and single dashes, up to 39 chars.
// Repo names: alphanumerics, dot, dash, underscore, up to 100 chars.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const MAX_RUNNERS_LIMIT = 4;
export const DEFAULT_MAX_RUNNERS = 2;

// "owner/repo", "https://github.com/owner/repo(.git)" or
// "git@github.com:owner/repo.git" -> "owner/repo". Anything else -> null.
export function normalizeRepo(input) {
  const s = String(input ?? '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

// The labels each runner registers with. GitHub matches runs-on labels
// case-insensitively; these spellings mirror GitHub's own defaults.
export function runnerLabels(arch) {
  return ['self-hosted', 'umbrel', 'Linux', arch === 'arm64' ? 'ARM64' : 'X64'];
}

// A queued job is ours when it asks for `umbrel` and every label it asks for
// is one our runners carry. `runs-on: self-hosted` alone is not ours: that
// job may be meant for another runner the owner has.
export function jobWantsUs(jobLabels, labels) {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  const want = (jobLabels || []).map((l) => String(l).toLowerCase());
  return want.includes('umbrel') && want.every((l) => have.has(l));
}

// Why a workflow run's code is not the served repository's own, or '' when
// it is. For a pull request from a fork, pull_request_target included,
// GitHub reports the fork as the run's head_repository (fork: true). A run
// in a served repository that is itself a fork has fork: true as well, so
// none of that repository's jobs are served. A run with no head repository
// (its fork was deleted) counts as a fork.
export function forkHead(run) {
  const head = run?.head_repository;
  if (!head) return 'it has no head repository';
  if (head.fork === true) return `its head repository ${head.full_name} is a fork`;
  if (run.repository && head.id !== run.repository.id) return `its head repository ${head.full_name} is not ${run.repository.full_name}`;
  return '';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const GiB = 1024 ** 3;

// Per-job limits, sized for an Umbrel: half its CPUs and half its memory,
// divided by the concurrency cap. Floors keep a job usable on a small box;
// ceilings keep a big box from handing one job everything. A full set of
// runners stays within half the box only while the floors do not bind: with
// fewer CPUs than the cap, or less than 2 GB of memory per runner, a full
// set takes cap x 0.5 CPU and cap x 1 GB, up to the whole box.
export function jobLimits({ ncpu, memBytes, maxRunners }) {
  const cap = clamp(Math.floor(maxRunners) || 1, 1, MAX_RUNNERS_LIMIT);
  const cpus = Math.round(clamp((ncpu || 2) / 2 / cap, 0.5, 4) * 100) / 100;
  const memory = clamp(Math.floor((memBytes || 4 * GiB) / 2 / cap), GiB, 8 * GiB);
  return { cpus, memory, pids: 4096, shm: Math.min(GiB, Math.floor(memory / 4)) };
}

// Docker's non-TTY log stream frames every chunk with an 8-byte header
// (stream type, 3 zero bytes, big-endian length). Anything that does not
// look like that is returned as-is.
export function demuxDockerLogs(buf) {
  const parts = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const type = buf[o];
    if (type > 2 || buf[o + 1] || buf[o + 2] || buf[o + 3]) return buf.toString();
    const size = buf.readUInt32BE(o + 4);
    parts.push(buf.subarray(o + 8, o + 8 + size));
    o += 8 + size;
  }
  if (o !== buf.length) return buf.toString();
  return Buffer.concat(parts).toString();
}

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

// The runner's console lines (actions/runner JobDispatcher.cs, Runner.cs):
//   √ Connected to GitHub
//   2026-10-09 12:00:00Z: Listening for Jobs
//   2026-10-09 12:00:05Z: Running job: build
//   2026-10-09 12:03:10Z: Job build completed with result: Succeeded
const STAMP = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z)`;
const RUNNING_RE = new RegExp(`^${STAMP}: Running job: (.+)$`, 'm');
const DONE_RE = new RegExp(`^${STAMP}: Job (.+) completed with result: (\\w+)$`, 'm');

const isoOf = (stamp) => stamp.replace(' ', 'T');

export function parseRunnerLog(text) {
  const out = { connected: /Connected to GitHub/.test(text), listening: /Listening for Jobs/.test(text) };
  const run = text.match(RUNNING_RE);
  if (run) Object.assign(out, { job: run[2].trim(), jobStartedAt: isoOf(run[1]) });
  const done = text.match(DONE_RE);
  if (done) Object.assign(out, { result: done[3], jobFinishedAt: isoOf(done[1]) });
  return out;
}

// Which repositories get a new runner this round, one entry per runner.
//   repos:   [{ name, queued, oldestQueuedAt, blockedUntil }]
//   runners: [{ repo, busy }]  (every runner alive right now)
// A runner that is up but not yet busy will take one of its repo's queued
// jobs, so it counts against that repo's queue. Repos with the oldest
// queued job go first, and slots are handed out one at a time across
// repos so a single busy repo cannot take every slot.
export function planSpawns({ repos, runners, maxRunners, now = Date.now() }) {
  let free = maxRunners - runners.length;
  if (free <= 0) return [];
  const idle = new Map();
  for (const r of runners) if (!r.busy) idle.set(r.repo, (idle.get(r.repo) || 0) + 1);
  const wants = repos
    .filter((r) => r.queued > 0 && !(r.blockedUntil > now))
    .map((r) => ({ name: r.name, need: r.queued - (idle.get(r.name) || 0), oldest: r.oldestQueuedAt || '' }))
    .filter((r) => r.need > 0)
    .sort((a, b) => a.oldest.localeCompare(b.oldest));
  const out = [];
  while (free > 0) {
    let progressed = false;
    for (const w of wants) {
      if (free > 0 && w.need > 0) {
        out.push(w.name);
        w.need -= 1;
        free -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

// Why a live runner should go, or '' to keep it.
//   timeout: past the hard job limit, busy or not.
//   idle:    no job picked up in time (the job it was started for was taken
//            by another runner or cancelled). The next poll starts a new one
//            if work is still queued.
export function reapReason({ createdAt, busy }, { now = Date.now(), idleMs, maxJobMs }) {
  const age = now - createdAt;
  if (age > maxJobMs) return 'timeout';
  if (!busy && age > idleMs) return 'idle';
  return '';
}

// Back-off after a runner exits without running a job (bad registration,
// GitHub outage): 30 s, doubling, at most 10 minutes.
export function backoffMs(failures) {
  if (failures <= 0) return 0;
  return Math.min(10 * 60_000, 30_000 * 2 ** (failures - 1));
}

// A fine-grained token is the least-privileged credential that can register
// repository runners. Classic tokens need the `repo` scope, which is full
// control of every repository the owner has, so they are refused.
export function tokenKind(token) {
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) return 'fine-grained';
  if (/^gh[pousr]_[A-Za-z0-9]{20,}$/.test(token)) return 'classic';
  return 'unknown';
}
