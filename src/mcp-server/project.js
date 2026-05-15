import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureRunning } from '../daemon/lifecycle.js';

export function findProjectRoot({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.WALKIE_PROJECT_ROOT) return resolve(env.WALKIE_PROJECT_ROOT);
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(`${dir}/.walkie-talkie`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('no .walkie-talkie/ found walking up from ' + cwd);
    }
    dir = parent;
  }
}

export async function ensureDaemon(projectRoot, { projectName } = {}) {
  return ensureRunning(projectRoot, { projectName: projectName ?? 'project' });
}
