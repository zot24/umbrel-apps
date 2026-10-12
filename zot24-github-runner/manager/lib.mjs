// Pure helpers for the GitHub Runner manager. No I/O here, so lib.test.mjs
// covers them with node:test and server.mjs stays about wiring.

// Every runner this app registers is named like this. Cleanup only ever
// touches registrations whose name matches, never the owner's other runners.
// Runner names are umbrel-<install>-<random>. The install ID belongs to
// this app install and lives in state.json, so when two Umbrels serve the
// same repository each one only ever deletes its own registrations.
// umbrel-<8 hex> is the name before 0.1.5; either Umbrel could have made it.
export const RUNNER_NAME_RE = /^umbrel-(?:[0-9a-f]{4}-[0-9a-f]{6}|[0-9a-f]{8})$/;
export const INSTALL_ID_RE = /^[0-9a-f]{4}$/;

export function ownsRunner(installId, name) {
  return INSTALL_ID_RE.test(installId || '') && typeof name === 'string' && name.startsWith(`umbrel-${installId}-`) && RUNNER_NAME_RE.test(name);
}

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
// case-insensitively; these spellings mirror GitHub's own defaults. A Docker
// runner carries `umbrel-docker` instead of `umbrel`, so GitHub never hands
// a [self-hosted, umbrel] job to a runner that has the Docker socket.
export function runnerLabels(arch, { docker = false } = {}) {
  return ['self-hosted', docker ? 'umbrel-docker' : 'umbrel', 'Linux', arch === 'arm64' ? 'ARM64' : 'X64'];
}

// A queued job is ours when it asks for `umbrel` (or `umbrel-docker`) and
// every label it asks for is one these runners carry. `runs-on: self-hosted`
// alone is not ours: that job may be meant for another runner the owner has.
export function jobWantsUs(jobLabels, labels) {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  const want = (jobLabels || []).map((l) => String(l).toLowerCase());
  return want.some((l) => l === 'umbrel' || l === 'umbrel-docker') && want.every((l) => have.has(l));
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

// The pull request a pushed commit merged, from its title as GitHub writes
// it: "title (#12)" for a squash merge, "Merge pull request #12 from ..."
// for a merge commit. 0 when the title is neither.
function mergedPr(message) {
  const title = String(message || '').split('\n')[0];
  const m = title.match(/\(#(\d+)\)\s*$/) || title.match(/^Merge pull request #(\d+) from /);
  return m ? Number(m[1]) : 0;
}

// Where a runner's job is on GitHub, for links on the page: the job's log,
// its run, and the pull request the run belongs to (none for a run not tied
// to one, such as a schedule). A push run lists no pull request; a push to
// the default branch whose commit merged one is shown with it, as merged.
// Only https URLs are kept.
export function jobLink(repo, run, job, { defaultBranch = '' } = {}) {
  const url = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : '');
  const open = Number(run?.pull_requests?.[0]?.number) || 0;
  const onDefault = !!defaultBranch && run?.head_branch === defaultBranch;
  const merged = !open && run?.event === 'push' && onDefault ? mergedPr(run?.head_commit?.message) : 0;
  const pr = open || merged;
  return {
    workflow: String(run?.name || ''),
    event: String(run?.event || ''),
    branch: String(run?.head_branch || ''),
    pr,
    prUrl: pr ? `https://github.com/${repo}/pull/${pr}` : '',
    prMerged: !!merged,
    runUrl: url(run?.html_url),
    jobUrl: url(job?.html_url),
    // Stable identities and GitHub's own times, for history and stats.
    runId: Number(run?.id) || 0,
    attempt: Number(run?.run_attempt) || 1,
    jobId: Number(job?.id) || 0,
    sha: String(run?.head_sha || '').slice(0, 12),
    queuedAt: String(job?.created_at || ''),
    startedAt: String(job?.started_at || ''),
  };
}

// What this Umbrel can do with a queued job of a served repository:
//   light | docker   it will start a runner for it (up to the caps)
//   docker-off       it asks for umbrel-docker, and Docker for jobs is off
//   mismatch         it asks for umbrel or umbrel-docker plus a label this
//                    Umbrel's runners lack (for example ARM64 on an X64 box)
//   ''               not meant for an Umbrel (a Mac job, ubuntu-latest, ...)
export function classifyQueued(jobLabels, { light, docker, dockerOn }) {
  const want = (jobLabels || []).map((l) => String(l).toLowerCase());
  if (jobWantsUs(jobLabels, light)) return 'light';
  if (jobWantsUs(jobLabels, docker)) return dockerOn ? 'docker' : 'docker-off';
  if (want.includes('umbrel') || want.includes('umbrel-docker')) return 'mismatch';
  return '';
}

// History kept in state.json: seven days, at most `maxEntries`, and the
// runner's last lines and the failure excerpt only on the newest
// `keepTails` entries (the failure's hint stays on all).
export function pruneHistory(history, { now = Date.now(), maxAgeMs = 7 * 24 * 3600_000, maxEntries = 2000, keepTails = 50 } = {}) {
  return history
    .filter((h) => !(now - Date.parse(h.finishedAt || 0) > maxAgeMs))
    .slice(0, maxEntries)
    .map((h, i) => (i < keepTails || (!h.tail && !h.failure?.excerpt) ? h : { ...h, tail: '', ...(h.failure ? { failure: { ...h.failure, excerpt: '' } } : {}) }));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Totals for the page, with the number of samples behind each figure.
// Runner minutes count from the job's start (runner log) to its end; the
// wait is GitHub's queued -> started time for jobs whose link was seen.
// Memory: jobs with an OOM kill, and jobs that peaked at 90% or more of
// their limit without one, out of the jobs that were sampled at all.
export function historyStats(history, { now = Date.now(), windowMs }) {
  const recent = history.filter((h) => now - Date.parse(h.finishedAt || 0) <= windowMs);
  const by = {};
  let runnerMs = 0;
  const waits = [];
  let sampled = 0;
  let oom = 0;
  let nearMemLimit = 0;
  for (const h of recent) {
    by[h.result] = (by[h.result] || 0) + 1;
    if (h.usage) {
      sampled += 1;
      if (h.usage.oom > 0) oom += 1;
      else if (h.usage.memLimit && h.usage.memPeak >= 0.9 * h.usage.memLimit) nearMemLimit += 1;
    }
    const start = Date.parse(h.jobStartedAt || '');
    const end = Date.parse(h.finishedAt || '');
    if (start && end > start) runnerMs += end - start;
    const q = Date.parse(h.link?.queuedAt || '');
    const s = Date.parse(h.link?.startedAt || '');
    if (q && s >= q) waits.push((s - q) / 1000);
  }
  waits.sort((a, b) => a - b);
  return {
    jobs: recent.length,
    results: by,
    runnerMinutes: Math.round(runnerMs / 60_000),
    wait: { samples: waits.length, p50: percentile(waits, 50), p95: percentile(waits, 95) },
    sampled,
    oom,
    nearMemLimit,
  };
}

// ----------------------------------------------------------- job usage --
// Every poll the manager reads one-shot Docker stats of each live runner's
// container (and, for a Docker runner, of every container its job started
// in the private daemon). These fold the samples into what the page shows.

const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

// Memory a container really holds: usage minus the page cache the kernel
// can drop, as `docker stats` shows it. cgroup v2 names that inactive_file,
// v1 total_inactive_file. An exited container reports nothing: 0.
export function memUsed(memoryStats) {
  const usage = Number(memoryStats?.usage) || 0;
  const cache = Number(memoryStats?.stats?.inactive_file ?? memoryStats?.stats?.total_inactive_file) || 0;
  return Math.max(0, usage - cache);
}

// CPU counters only grow; one that went back (a restarted process tree)
// counts as nothing rather than negative CPU.
const grew = (now, before) => Math.max(0, now - before);

// Folds one sample of a runner into its record (null before the first):
//   { at, busy, cpuNs, mem, memLimit, cpuLimit, job }
// cpuNs is the container's CPU time since it started. job is null for a
// light runner, else [{ id, cpuNs, mem }] for the job's own containers; one
// first seen now started after the last sample, so all its CPU time is new.
// CPU averages and peaks only count intervals that end while the runner is
// busy, so a runner's idle wait for its job does not dilute them.
export function foldUsage(prev, s) {
  const dt = prev ? s.at - prev.at : 0;
  const u = {
    at: s.at,
    cpuNs: s.cpuNs,
    cpu: null,
    cpuPeak: prev?.cpuPeak ?? null,
    busyCpuNs: prev?.busyCpuNs || 0,
    busyMs: prev?.busyMs || 0,
    samples: prev?.samples || 0,
    mem: s.mem,
    memPeak: Math.max(prev?.memPeak || 0, s.mem),
    memLimit: s.memLimit,
    cpuLimit: s.cpuLimit,
    oom: prev?.oom || 0,
    job: null,
  };
  if (dt > 0) {
    const used = grew(s.cpuNs, prev.cpuNs);
    u.cpu = used / 1e6 / dt;
    if (s.busy) {
      u.busyCpuNs += used;
      u.busyMs += dt;
      u.samples += 1;
      u.cpuPeak = Math.max(u.cpuPeak ?? 0, u.cpu);
    }
  }
  if (s.job) {
    const pj = prev?.job;
    const byId = {};
    let used = 0;
    let mem = 0;
    for (const c of s.job) {
      byId[c.id] = c.cpuNs;
      used += grew(c.cpuNs, pj?.byId[c.id] ?? 0);
      mem += c.mem;
    }
    const j = {
      byId,
      count: s.job.length,
      countMax: Math.max(pj?.countMax || 0, s.job.length),
      cpu: null,
      cpuPeak: pj?.cpuPeak ?? null,
      busyCpuNs: pj?.busyCpuNs || 0,
      busyMs: pj?.busyMs || 0,
      mem,
      memPeak: Math.max(pj?.memPeak || 0, mem),
    };
    if (pj && dt > 0) {
      j.cpu = used / 1e6 / dt;
      if (s.busy) {
        j.busyCpuNs += used;
        j.busyMs += dt;
        j.cpuPeak = Math.max(j.cpuPeak ?? 0, j.cpu);
      }
    }
    u.job = j;
  }
  return u;
}

// What the page shows of a record. live: false is what a finished job keeps
// in its history entry (no "now" figures).
export function usageView(u, { live = true } = {}) {
  if (!u) return null;
  const avg = (x) => (x.busyMs ? round2(x.busyCpuNs / 1e6 / x.busyMs) : null);
  const job = u.job
    ? live
      ? { containers: u.job.count, containersMax: u.job.countMax, cpu: round2(u.job.cpu), cpuAvg: avg(u.job), cpuPeak: round2(u.job.cpuPeak), mem: u.job.mem, memPeak: u.job.memPeak }
      : { containersMax: u.job.countMax, cpuAvg: avg(u.job), cpuPeak: round2(u.job.cpuPeak), memPeak: u.job.memPeak }
    : null;
  const kept = { cpuAvg: avg(u), cpuPeak: round2(u.cpuPeak), cpuLimit: u.cpuLimit, memPeak: u.memPeak, memLimit: u.memLimit, oom: u.oom, samples: u.samples, job };
  return live ? { cpu: round2(u.cpu), mem: u.mem, ...kept } : kept;
}

// Docker `oom` events -> OOM kills per runner name. A runner's own
// container carries its name as the ghr.name label. Any other container in
// the private daemon was started by the Docker job running there (at most
// one at a time), so its kills are that runner's.
export function attributeOom(events, { dockerRunner = '' } = {}) {
  const counts = new Map();
  for (const e of events) {
    if (e?.Action !== 'oom') continue;
    const name = e.Actor?.Attributes?.['ghr.name'] || dockerRunner;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// ------------------------------------------------------------ job steps --

// A job's steps as GitHub's jobs API lists them, for the page.
export function stepsOf(job) {
  return (Array.isArray(job?.steps) ? job.steps : []).slice(0, 100).map((s) => ({
    n: Number(s.number) || 0,
    name: String(s.name || ''),
    status: String(s.status || ''),
    conclusion: String(s.conclusion || ''),
    startedAt: String(s.started_at || ''),
    completedAt: String(s.completed_at || ''),
  }));
}

// How far a job is: steps done, the one running, and the first that
// stopped it (failed, timed out, or was cancelled; later ones are skipped).
const STOPPED = new Set(['failure', 'timed_out', 'cancelled']);
export function stepSummary(steps) {
  return {
    total: steps.length,
    done: steps.filter((s) => s.status === 'completed').length,
    current: steps.find((s) => s.status === 'in_progress') || null,
    failed: steps.find((s) => STOPPED.has(s.conclusion)) || null,
  };
}

// The runner writes each step's console output (secrets already masked) to
// _diag/pages/<timeline>_<step>_<n>.log, one line per write, each starting
// with a 7-digit ISO time. The page shows the time as HH:MM:SS. `cut`: the
// text is a tail -c of a longer file, so its first line is partial.
export function cleanStepLog(text, { cut }) {
  const lines = stripAnsi(text).replace(/^\uFEFF/, '').split('\n');
  if (cut) lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z /, '$1 ')).join('\n');
}

// --------------------------------------------------------------- host ----
// Inside a container /proc/stat and /proc/meminfo are the host's, so the
// manager can show how busy the whole Umbrel is, other apps included.

export function parseProcStat(text) {
  const m = String(text).match(/^cpu\s+(\d+(?:\s+\d+){6,})/m);
  if (!m) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = m[1].trim().split(/\s+/).map(Number);
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, iowait, total: busy + idle + iowait };
}

// Fractions of all CPUs busy, and idle waiting on disk (iowait), between
// two reads, or null. A box stuck on disk shows little busy and much iowait.
export function hostCpuBusy(prev, cur) {
  if (!prev || !cur || cur.total <= prev.total) return null;
  const d = cur.total - prev.total;
  return { busy: round2((cur.busy - prev.busy) / d), iowait: round2((cur.iowait - prev.iowait) / d) };
}

export function parseMeminfo(text) {
  const kb = (key) => Number(String(text).match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1]);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || !Number.isFinite(available)) return null;
  return { total: total * 1024, available: available * 1024 };
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
// look like that is returned as-is. `truncated`: the read stopped at a cap,
// so the last frame may be cut; its bytes so far are kept.
export function demuxDockerLogs(buf, { truncated = false } = {}) {
  const parts = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const type = buf[o];
    if (type > 2 || buf[o + 1] || buf[o + 2] || buf[o + 3]) return buf.toString();
    const size = buf.readUInt32BE(o + 4);
    parts.push(buf.subarray(o + 8, o + 8 + size));
    o += 8 + size;
  }
  if (o !== buf.length && !(truncated && o > buf.length)) return buf.toString();
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
//
// Docker jobs (queuedDocker) get Docker runners, at most maxDocker of them
// alive at once: jobs that share one daemon also share its ports and
// container names, so by default they run one after another.
export function planSpawns({ repos, runners, maxRunners, maxDocker = 1, now = Date.now() }) {
  let free = maxRunners - runners.length;
  let freeDocker = maxDocker - runners.filter((r) => r.docker).length;
  if (free <= 0) return [];
  const key = (repo, docker) => `${docker ? 'd' : 'l'}:${repo}`;
  const idle = new Map();
  for (const r of runners) if (!r.busy) idle.set(key(r.repo, r.docker), (idle.get(key(r.repo, r.docker)) || 0) + 1);
  const wants = repos
    .filter((r) => !(r.blockedUntil > now))
    .flatMap((r) => [
      { repo: r.name, docker: false, need: (r.queued || 0) - (idle.get(key(r.name, false)) || 0), oldest: r.oldestQueuedAt || '' },
      { repo: r.name, docker: true, need: (r.queuedDocker || 0) - (idle.get(key(r.name, true)) || 0), oldest: r.oldestDockerQueuedAt || '' },
    ])
    .filter((w) => w.need > 0)
    .sort((a, b) => a.oldest.localeCompare(b.oldest));
  const out = [];
  while (free > 0) {
    let progressed = false;
    for (const w of wants) {
      if (free > 0 && w.need > 0 && (!w.docker || freeDocker > 0)) {
        out.push({ repo: w.repo, docker: w.docker });
        w.need -= 1;
        free -= 1;
        if (w.docker) freeDocker -= 1;
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

// ------------------------------------------------------------ failures --

// GitHub's log of a failed job -> the lines that explain it: up to `before`
// lines leading to its last ##[error] line (the failing step's "Process
// completed with exit code N"; an earlier error can be from a step allowed
// to fail), or its last lines when there is none. Times cut to HH:MM:SS.
export function failureExcerpt(text, { before = 40, maxBytes = 8192 } = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('##[error]')) {
      last = i;
      break;
    }
  }
  const pick = last < 0 ? lines.slice(-before) : lines.slice(Math.max(0, last - before), last + 1);
  const out = cleanStepLog(pick.join('\n'), { cut: false });
  return out.length > maxBytes ? out.slice(-maxBytes) : out;
}

// A one-word cause the page can flag, or '':
//   heap    Node.js stopped at its own heap limit (exit 134; no OOM event)
//   oom     the kernel killed a process for memory (an oom event was seen)
//   killed  exit code 137 without an oom event (SIGKILL: memory, or a stop)
//   disk    the disk was full
export function failureHint(text, { oom = 0 } = {}) {
  const t = String(text || '');
  if (/JavaScript heap out of memory|Reached heap limit/.test(t)) return 'heap';
  if (oom > 0) return 'oom';
  if (/exit code 137\b/.test(t)) return 'killed';
  if (/No space left on device|ENOSPC/i.test(t)) return 'disk';
  return '';
}
