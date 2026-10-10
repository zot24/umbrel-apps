# Runner image: GitHub's official runner image plus zstd and build-essential,
# so jobs do not apt-get them on every run. zstd also makes actions/cache
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
RUN apt-get update \
 && apt-get install -y --no-install-recommends zstd build-essential \
 && rm -rf /var/lib/apt/lists/*
USER runner
