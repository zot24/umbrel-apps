import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

// CI-only agent. flue run loads this module. It is not a hosted Worker.
export function AdaptUpstream() {
  useModel(process.env.FLUE_MODEL || 'anthropic/claude-sonnet-4-6');
  useSandbox(
    local({
      cwd: process.env.REPO_ROOT || repoRoot,
    }),
  );
  return [
    'You port upstream product changes onto the zot24 Umbrel Cloudflare Tunnel app.',
    'Read zot24-cloudflared/ci/adapt-upstream-prompt.md and follow it exactly.',
    'The report and unapplied diffs are under zot24-cloudflared/ci/pending/.',
    'Edit files in the sandbox. Do not run git commit, git push, git checkout, or gh.',
  ].join('\n');
}
