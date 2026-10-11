# Runner image: GitHub's official runner image plus zstd, build-essential, the
# GitHub CLI (gh) and the Docker Compose plugin, so jobs do not install them
# on every run. gh comes from GitHub's own apt repository and Compose from
# Docker's, as on ubuntu-latest. zstd also makes actions/cache
# use the same compression as GitHub-hosted runners, so caches saved there
# restore here and the reverse.
#
# Everything else stays GitHub's: the `runner` user (uid 1001, passwordless
# sudo), WORKDIR /home/runner, CMD, run.sh, the externals the manager copies
# out, and DEBIAN_FRONTEND=noninteractive. The manager starts every job from
# this image with a JIT config.
#
# ci/update-runner.sh bumps the FROM line (tag + index digest) weekly;
# build-github-runner.yml rebuilds this image and pins it as RUNNER_IMAGE.
FROM ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807

USER root
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod 0644 /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends zstd build-essential gh docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && gh --version \
 && docker compose version
USER runner
