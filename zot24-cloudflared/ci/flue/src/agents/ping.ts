import { useModel } from '@flue/runtime';

// Smoke test for the Actions secret. No sandbox, so this agent cannot edit the repo.
export function Ping() {
  useModel(process.env.FLUE_MODEL || 'anthropic/claude-sonnet-4-6');
  return 'Reply with exactly this line and no other text: flue-ok zot24-cloudflared';
}
