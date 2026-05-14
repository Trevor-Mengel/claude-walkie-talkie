import { execFileSync } from 'node:child_process';

function tryRun(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort git metadata. Returns null fields when not in a repo or git unavailable.
 * Uses execFileSync (no shell) to avoid command-injection surface.
 * @param {string} cwd
 * @returns {{branch:string|null, hash:string|null, userName:string|null, userEmail:string|null}}
 */
export function gitMetadata(cwd) {
  return {
    branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    hash: tryRun('git', ['rev-parse', '--short', 'HEAD'], cwd),
    userName: tryRun('git', ['config', '--local', 'user.name'], cwd),
    userEmail: tryRun('git', ['config', '--local', 'user.email'], cwd)
  };
}
