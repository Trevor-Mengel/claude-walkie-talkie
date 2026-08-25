import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

/**
 * Git environment for tests: never read the operator's global/system git config, never prompt,
 * never depend on ambient author identity.
 */
export const GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Collabcast Test',
  GIT_AUTHOR_EMAIL: 'collabcast-test@example.invalid',
  GIT_COMMITTER_NAME: 'Collabcast Test',
  GIT_COMMITTER_EMAIL: 'collabcast-test@example.invalid',
  GIT_TERMINAL_PROMPT: '0'
});

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** A physical (symlink-resolved) temp directory. */
export function tmpRoot(prefix = 'collabcast-identity-') {
  return realpathSync(createFixtureDir(prefix));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Initializes a real git repo with one commit.
 * @param {string} dir
 * @param {{gitignore?:string, files?:Record<string,string>}} [opts]
 */
export function initRepo(dir, { gitignore, files } = {}) {
  mkdirp(dir);
  git(['init', '-q', '-b', 'main', '.'], dir);
  writeFileSync(join(dir, 'README.md'), '# tmp\n');
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore);
  for (const [name, content] of Object.entries(files ?? {})) {
    mkdirp(join(dir, name, '..'));
    writeFileSync(join(dir, name), content);
  }
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
  return dir;
}

/** Writes an identities.json map and returns its path. */
export function writeIdentities(path, map, mode = 0o600) {
  mkdirp(join(path, '..'));
  writeFileSync(path, JSON.stringify(map, null, 2), { mode });
  return path;
}
