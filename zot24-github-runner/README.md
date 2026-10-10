# GitHub Runner

Self-hosted [GitHub Actions](https://docs.github.com/actions) runners on an Umbrel, for your
own private repositories. Jobs that ask for `runs-on: [self-hosted, umbrel]` run here, one
fresh container per job, instead of on GitHub's machines.

- **App ID**: `zot24-github-runner`
- **Port**: 3500 (setup page, behind Umbrel login). Runners are outbound-only.
- **GitHub account**: any. Runners register per repository, with a fine-grained token you create.

## Why: minutes

GitHub does not bill self-hosted runner minutes. Its billing docs say: "GitHub Actions usage is
free for self-hosted runners and for public repositories that use standard GitHub-hosted
runners" ([About billing for GitHub Actions](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions),
checked 2026-10-09). On 2025-12-16 GitHub announced a $0.002/minute "cloud platform charge" for
self-hosted runner usage from 2026-03-01, and added a note postponing it within two days, "to take
time to re-evaluate our approach", with no new date
([changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/),
checked 2026-10-09). If that charge comes back, jobs run here would count toward plan minutes
again. Re-check both pages before relying on this.

## How it fits together

```
Umbrel
└── zot24-github-runner
    ├── manager   ghcr.io/zot24/github-runner-manager (setup page on :3500 + scheduler)
    │              state: data/manager/state.json (token, repos, job history), mode 0600
    └── dind      private Docker daemon, own network namespace, not on the Umbrel network
         └── ghr-umbrel-xxxxxxxx   one container per job, image = RUNNER_IMAGE
              (ghcr.io/actions/actions-runner, GitHub's official image, pinned by digest)
```

1. Every 15 seconds the manager asks GitHub for queued jobs in the served repositories
   (`GET .../actions/runs?status=queued|in_progress`, then each run's jobs). Responses are cached
   by ETag; GitHub does not count a 304 against the rate limit, so an idle repository costs
   next to nothing.
2. A queued job is ours when its labels include `umbrel` and every label it asks for is one our
   runners carry: `self-hosted`, `umbrel`, `Linux`, and `X64` or `ARM64`. A job that asks only
   for `self-hosted` is left for whatever other runner it was meant for.
3. For each such job, up to the parallel-jobs cap, the manager asks GitHub for a just-in-time
   runner config for that repository (`POST .../actions/runners/generate-jitconfig`) and starts a
   new container from the runner image with it. JIT runners are ephemeral: one job, then they
   deregister.
4. When the container exits, the manager records the job and its result, then deletes the
   container and the job's work folder. The next job gets a new container.
5. A runner that gets no job within 10 minutes (another runner took it, or it was cancelled) is
   deregistered and removed. A job still running after 6 hours 10 minutes is stopped.

## Using it

1. Create a fine-grained token at GitHub → Settings → Developer settings → Fine-grained tokens
   ([direct link](https://github.com/settings/personal-access-tokens/new)):
   - **Resource owner**: you (or the organization that owns the repositories).
   - **Repository access**: Only select repositories → the private repositories this runner
     should serve.
   - **Repository permissions**: **Administration: Read and write** and **Actions: Read-only**.
     Metadata: Read-only is added on its own. Nothing else.
2. Open the app and paste the token. It is checked with GitHub (`GET /user`) before it is saved.
   Classic tokens (`ghp_…`) are refused: they need the `repo` scope, which is full control of every
   repository you have.
3. Add the repositories. The page lists the private ones the token can see. Before saving one,
   the app checks that it is private, that the token can register runners on it, and that the
   token can read its job queue.
4. In each repository's workflows, change the jobs that should run here:

   ```yaml
   jobs:
     build:
       runs-on: [self-hosted, umbrel]
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
         - run: npm ci && npm test
   ```

   Pin a job to one architecture with `runs-on: [self-hosted, umbrel, X64]` (or `ARM64`).

### Which repositories it serves, and why the token needs what it needs

GitHub has no per-user runners. A runner belongs to a repository, an organization or an
enterprise, and a personal account only has repositories. So this app registers **per
repository**: each job's runner is registered on the repository the job is in. It serves exactly
the repositories listed on its page, and only while they are private. The token's own repository
selection is the outer fence: the app cannot serve a repository the token was not given.

- **Administration: Read and write** is the only permission GitHub accepts for registering a
  repository runner (`generate-jitconfig`, deleting a runner). No narrower one exists. It also
  covers repository settings, so keep the token's repository list to what this runner serves.
- **Actions: Read-only** lets the app see the job queue. Without it, it could not tell when to
  start a runner.

A GitHub App would need the same Administration permission. A fine-grained token is one paste
and no app to maintain; it expires on the date you pick, and the page shows that date.

## Safety

- **Private repositories only.** A self-hosted runner on a public repository can run code from
  anyone's fork pull request. Public repositories are refused when added, and every served
  repository's visibility is read again on every poll (every 15 seconds, before its queue). If one
  is made public, the next poll stops all its runners at once, a job in progress included (GitHub
  fails that job), and deletes their registrations. The app then serves it no new runner, even
  after it is private again, until you press **re-enable** on its row; that checks with GitHub
  that it is private before serving it. On a private repository only people with access can push
  or open pull requests; GitHub's "Run workflows from fork pull requests" setting for private
  repositories is off by default, keep it off.
- **A fixed concurrency cap.** No more than 1 to 4 runners (default 2) exist at once, whatever is
  queued. Extra jobs wait in GitHub's queue.
- **Resource limits sized for an Umbrel.** Each runner gets half of the Umbrel's CPUs and half its
  memory divided by the cap, with no swap, so a full set of runners stays within half: at least
  0.5 CPU and 1 GB, at most 4 CPUs and 8 GB per job. Also 4096 processes and 6 h 10 min of run
  time. On a 4-core, 16 GB box with the default cap: 1 CPU and 4 GB per job. Limits are set when a
  runner starts, so after raising the cap the runners already up keep their larger share until
  they finish. The page shows the actual values.
- **No access to the Umbrel's Docker.** No container of this app mounts the Umbrel's Docker
  socket, and there is no setting for it. Runners run inside a Docker daemon private to the app,
  on a bridge with inter-container traffic disabled; they reach the internet, not each other,
  other apps, or the Umbrel's Docker.
- **Docker for jobs is opt-in, and it is root on the Umbrel.** Off by default: `container:` jobs,
  `services:` and Docker container actions fail. On, each runner gets the app's private daemon
  socket. That daemon runs privileged, so a job with it can start a privileged container and reach
  the Umbrel's disks and processes. The page asks you to type `docker` before turning it on. Only
  do that if every workflow, and every action those workflows use, is yours to trust.
- **Nothing survives a job.** Each job runs in a new container with a new work folder; both are
  deleted when it ends, along with the runner's credentials and tool cache. While no job runs, the
  app also removes whatever jobs left in the private daemon (containers, networks, volumes), and
  once a day every image except the runner's own.
- **The token stays in the manager.** A runner container only gets its own single-use JIT
  config. The runner reads it from the environment, masks it and removes it before running the
  job. Jobs run as `runner` with passwordless sudo inside their own container, so treat a job as
  able to read anything in that container.
- **The setup page** is behind the Umbrel login, and the manager answers only its own app proxy,
  the Umbrel host and itself, so another app on the Umbrel network cannot call it. Writes also
  need an `X-GHR-Request` header, which a page on another origin cannot send. Do not expose port
  3500 publicly.

## Coming from `ubuntu-latest`

The runner image is GitHub's own minimal one: Ubuntu 24.04 with git, curl, jq, unzip, tar, gzip,
python3 (no pip), ssh, sudo, the Docker CLI and buildx, and the Node.js builds the runner uses
for JavaScript actions. A GitHub-hosted `ubuntu-latest` has much more. What jobs will miss:

| Missing here | What to do |
|---|---|
| Node.js, Python packages/pip, Java, Go, Ruby, .NET SDK, Rust on `PATH` | `actions/setup-node`, `setup-python`, `setup-java`, `setup-go`, `ruby/setup-ruby`, `setup-dotnet`, `dtolnay/rust-toolchain` |
| A warm tool cache (`/opt/hostedtoolcache`) | The setup actions download on every job, because the work folder (where the cache lives) is wiped. |
| `build-essential` (gcc, g++, make), cmake, pkg-config | `sudo apt-get update && sudo apt-get install -y build-essential` (native npm modules need this) |
| `zstd`, `xz`, `zip`, `wget`, `rsync` | `sudo apt-get install -y …`. Without `zstd`, `actions/cache` falls back to gzip, so caches saved by hosted runners are not restored here and the reverse. |
| `gh`, cloud CLIs (aws, az, gcloud), kubectl, helm, terraform | Install them in the job, or use their setup actions. |
| `docker compose` | Install the compose plugin in the job; Docker itself needs Docker for jobs. |
| Docker daemon: `container:`, `services:`, Docker actions | Turn on Docker for jobs (see Safety). With it on, runners share the private daemon's network, so `services:` ports are on `localhost` as on GitHub; two parallel jobs that both publish the same fixed port collide. |
| Browsers (Chrome, Firefox) for Playwright, Puppeteer, Cypress | `npx playwright install --with-deps` and the like. |
| PostgreSQL, MySQL preinstalled | `services:` (needs Docker for jobs) or `sudo apt-get install`. |
| x86-64 everywhere | On an arm64 Umbrel (Raspberry Pi) runners are `ARM64`: x64-only binaries and actions fail. |
| A clean VM per job with ~14 GB free disk | A clean container per job; disk is the Umbrel's, shared with everything else. |

Leave a job on `ubuntu-latest` when it needs macOS or Windows, lots of disk, or anything above.

## Removing it

1. On the app's page: Settings → **Remove runners from GitHub**. It pauses the app and deletes
   every registration it made (named `umbrel-xxxxxxxx`) from the served repositories.
2. Uninstall the app. Stopping it also deregisters idle runners; a job that is running when the
   app stops fails, and GitHub drops that ephemeral registration within a day on its own.
3. Revoke the token: GitHub → Settings → Developer settings → Fine-grained tokens.
4. Point the workflows back at `ubuntu-latest`, or their jobs wait in the queue until GitHub
   fails them after 24 hours.

A stale registration can also be removed by hand: repository → Settings → Actions → Runners →
the runner → Remove.

## Data

| Path (under the app data dir) | What |
|---|---|
| `data/manager/state.json` | Token, served repositories, settings, last 50 jobs (0600) |
| `data/dind/` | The private daemon's storage: the runner image, job containers, images pulled by jobs |
| `data/work/` | One work folder per running job (`/ghr/umbrel-xxxxxxxx`), deleted when the job ends |
| `data/externals/` | Copy of the runner's Node.js builds, for container jobs (Docker for jobs only) |
| `data/sock/docker.sock` | The private daemon's socket (shared by dind and manager) |

## Images and updates

- `manager/` builds `ghcr.io/zot24/github-runner-manager` (linux/amd64 + linux/arm64) via
  `.github/workflows/build-github-runner.yml`, which runs the unit tests and pins the digest into
  `docker-compose.yml`. The GHCR package must be **public**: the Umbrel pulls it without
  credentials. The app will not install until that pin is on `main`.
- The runner image is GitHub's `ghcr.io/actions/actions-runner`, pinned by digest in
  `docker-compose.yml` (`RUNNER_IMAGE`). `ci/update-runner.sh` +
  `.github/workflows/update-github-runner.yml` check the latest `actions/runner` release weekly
  and open a PR that bumps the pin and the app's patch version. Keep up: a runner older than the
  latest release updates itself at the start of every job, a download of about 150 MB each time.
- Why GitHub's image and not a community one such as `myoung34/github-runner`: GitHub's is built
  with each runner release for amd64 and arm64, is what Actions Runner Controller runs, and starts
  from a JIT config the manager hands it, so no long-lived credential is ever inside a runner.
  `myoung34/github-runner` is well maintained, multi-arch and has more tools preinstalled, but it
  registers itself from a PAT or GitHub App key passed in its own environment (left there for jobs
  to read unless `UNSET_CONFIG_VARS` is set), runs jobs as root by default, and in its usual
  setup re-registers by restarting the same container, which keeps the previous job's files.
- Why polling and not GitHub's runner scale set API (`actions/scaleset`): that client is in public
  preview, is a Go library, and documents multi-label scale sets for GitHub Enterprise Server but
  not how `runs-on: [self-hosted, umbrel]` maps onto them on github.com. Revisit when it is GA; it
  would also drop the need for Actions: Read.

## Local development

```
node --test manager/lib.test.mjs manager/test/scheduler.test.mjs
docker compose -f docker-compose.local.yml up -d
open http://localhost:3500
```

`manager/test/scheduler.test.mjs` runs the real `server.mjs` against a fake GitHub API
(`manager/test/fake-github.mjs`) and a fake Docker daemon on a unix socket
(`manager/test/fake-docker.mjs`): no Docker, no token, nothing registered.

Without real credentials, run against the fake GitHub API in `manager/test/fake-github.mjs`. It
queues one `[self-hosted, umbrel]` job on `fake/private-repo` and hands out JIT configs that
point back at itself, so a runner container starts and fails to connect. Nothing is registered
on github.com.

```
GITHUB_API_URL=http://fake-github:8080 IDLE_TIMEOUT_MS=60000 \
  docker compose -f docker-compose.local.yml --profile fake up -d
# token: github_pat_FAKE_0000000000000000000000   repo: fake/private-repo
```

The manager restarts on edits to `manager/*.mjs` (`node --watch`).
