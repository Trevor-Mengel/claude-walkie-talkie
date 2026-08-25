import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitMetadata } from '../../src/core/git.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

describe('git metadata', () => {
  let repoDir;
  let nonRepoDir;

  beforeAll(() => {
    repoDir = createFixtureDir('walkie-git-');
    nonRepoDir = createFixtureDir('walkie-nogit-');
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'tester@example.com'], repoDir);
    git(['config', 'user.name', 'Tester'], repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    git(['add', 'a.txt'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(nonRepoDir, { recursive: true, force: true });
  });

  test('returns metadata in a git repo', () => {
    const meta = gitMetadata(repoDir);
    expect(meta.branch).toBe('main');
    expect(meta.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(meta.userName).toBe('Tester');
    expect(meta.userEmail).toBe('tester@example.com');
  });

  test('returns nulls outside a git repo', () => {
    const meta = gitMetadata(nonRepoDir);
    expect(meta).toEqual({ branch: null, hash: null, userName: null, userEmail: null });
  });
});
