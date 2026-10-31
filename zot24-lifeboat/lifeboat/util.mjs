import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A setting comes from the environment, or from a Docker secret of the same name.
export function setting(name) {
  if (process.env[name]) return process.env[name];
  try {
    return readFileSync(`/run/secrets/${name}`, 'utf8').trim();
  } catch {
    return '';
  }
}

// Child processes never see Lifeboat's own settings, only what a call passes.
export function childEnv(env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIFEBOAT_')));
  return { ...base, ...env };
}

export function run(cmd, args, { env, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv(env), stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    if (stdin) child.stdin.end(stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} ${args[0] ?? ''} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`);
      Object.assign(err, { code, stdout, stderr });
      reject(err);
    });
  });
}
