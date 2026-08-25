import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPathExcluded, loadConfig, verifyPathExcluded } from '../../src/config/load.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  configPath,
  defaultHistoryDir
} from '../../src/config/schema.js';
import { GIT_ENV, cleanup, git, initRepo, mkdirp, tmpRoot } from '../identity/tmp-git.js';

let base;

function writeConfig(root, contents) {
  const path = configPath(root);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

function expectThrow(fn, code) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'expected a throw').toBeDefined();
  expect(thrown.name).toBe('CollabcastError');
  expect(thrown.code).toBe(code);
  return thrown;
}

beforeEach(() => {
  base = tmpRoot('collabcast-load-');
});

afterEach(() => cleanup(base));

describe('loadConfig', () => {
  it('returns a deeply frozen config with schema defaults applied', () => {
    const root = mkdirp(join(base, 'proj'));
    writeConfig(root, { schemaVersion: CONFIG_SCHEMA_VERSION, namespace: 'collabcast' });

    const config = loadConfig({ canonicalRoot: root });
    expect(config.namespace).toBe('collabcast');
    expect(config.retention.hotDays).toBe(DEFAULT_CONFIG.retention.hotDays);
    expect(config.retention.historyDir).toBe(defaultHistoryDir(root));
    expect(config.mode).toBe(DEFAULT_CONFIG.mode);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.retention)).toBe(true);
    expect(Object.isFrozen(config.transport.tcp)).toBe(true);
    expect(Object.isFrozen(config.routing.hubs)).toBe(true);
    expect(() => {
      config.retention.hotDays = 1;
    }).toThrow(TypeError);
  });

  it('keeps explicit values and validates them', () => {
    const root = mkdirp(join(base, 'proj'));
    writeConfig(root, {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      namespace: 'collabcast',
      mode: 'standalone',
      retention: {
        hotDays: 7,
        snapshotGenerations: 4,
        pruneCadence: 'daily',
        historyDir: join(root, 'snapshots')
      },
      transport: { unixSocket: true, tcp: { enabled: true, host: '::1' } },
      routing: { root: { paseoAgentId: 'agt_root' }, hubs: {} }
    });

    const config = loadConfig({ canonicalRoot: root });
    expect(config.mode).toBe('standalone');
    expect(config.retention).toEqual({
      hotDays: 7,
      snapshotGenerations: 4,
      pruneCadence: 'daily',
      historyDir: join(root, 'snapshots')
    });
    expect(config.transport.tcp).toEqual({ enabled: true, host: '::1', port: 0 });
    expect(config.routing.root).toEqual({ paseoAgentId: 'agt_root' });
  });

  it('reports a missing config as not_found and bad JSON as config_invalid', () => {
    const root = mkdirp(join(base, 'proj'));
    const missing = expectThrow(() => loadConfig({ canonicalRoot: root }), 'not_found');
    expect(missing.detail.path).toBe(configPath(root));

    writeConfig(root, '{ nope');
    expectThrow(() => loadConfig({ canonicalRoot: root }), 'config_invalid');
  });

  it('rejects an invalid config body and a namespace mismatch', () => {
    const root = mkdirp(join(base, 'proj'));
    writeConfig(root, {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      namespace: 'collabcast',
      retention: { hotDays: 0 }
    });
    expectThrow(() => loadConfig({ canonicalRoot: root }), 'config_invalid');

    writeConfig(root, { schemaVersion: CONFIG_SCHEMA_VERSION, namespace: 'collabcast' });
    expectThrow(
      () => loadConfig({ canonicalRoot: root, expectNamespace: 'other' }),
      'config_invalid'
    );
    expect(() => loadConfig({})).toThrow(/requires canonicalRoot/);
  });
});

describe('verifyPathExcluded', () => {
  it('accepts a path that is both git-ignored and untracked', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: '.collabcast/\n' });
    const history = join(repo, '.collabcast', 'history');

    expect(verifyPathExcluded(history, { repoRoot: repo, env: GIT_ENV })).toEqual({
      ok: true,
      reason: 'ignored-and-untracked',
      path: history
    });
    expect(() => assertPathExcluded(history, { repoRoot: repo, env: GIT_ENV })).not.toThrow();
  });

  it('rejects a tracked path', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: 'ignored-dir/\n' });
    const tracked = join(repo, 'README.md');

    expect(verifyPathExcluded(tracked, { repoRoot: repo, env: GIT_ENV })).toEqual({
      ok: false,
      reason: 'tracked',
      path: tracked
    });
    const err = expectThrow(
      () => assertPathExcluded(tracked, { repoRoot: repo, env: GIT_ENV }),
      'config_invalid'
    );
    expect(err.detail.reason).toBe('tracked');
  });

  it('rejects a path that is ignored but tracked anyway', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: 'history/\n' });
    const dir = mkdirp(join(repo, 'history'));
    writeFileSync(join(dir, 'kept.txt'), 'forced in\n');
    git(['add', '-f', join(dir, 'kept.txt')], repo);
    git(['commit', '-qm', 'force-add ignored file'], repo);

    expect(verifyPathExcluded(dir, { repoRoot: repo, env: GIT_ENV })).toEqual({
      ok: false,
      reason: 'tracked',
      path: dir
    });
  });

  it('rejects a path that is untracked but not ignored', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: 'other/\n' });
    const stray = join(repo, 'stray');

    expect(verifyPathExcluded(stray, { repoRoot: repo, env: GIT_ENV })).toEqual({
      ok: false,
      reason: 'not-ignored',
      path: stray
    });
  });

  it('accepts a path outside any repository', () => {
    const plain = mkdirp(join(base, 'plain', 'history'));
    expect(verifyPathExcluded(plain, { repoRoot: join(base, 'plain'), env: GIT_ENV })).toEqual({
      ok: true,
      reason: 'not-a-repo',
      path: plain
    });
  });

  it('defaults repoRoot to the parent directory of the target', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: '.collabcast/\n' });
    const history = mkdirp(join(repo, '.collabcast', 'history'));

    expect(verifyPathExcluded(history, { env: GIT_ENV })).toEqual({
      ok: true,
      reason: 'ignored-and-untracked',
      path: history
    });
    expect(verifyPathExcluded(join(repo, 'README.md'), { env: GIT_ENV }).reason).toBe('tracked');
  });

  it('checks a path whose parent directory does not exist yet', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: '.collabcast/\n' });
    const unborn = join(repo, '.collabcast', 'history', 'gen-001');

    expect(verifyPathExcluded(unborn, { repoRoot: repo, env: GIT_ENV }).reason).toBe(
      'ignored-and-untracked'
    );
    expect(verifyPathExcluded(unborn, { env: GIT_ENV }).reason).toBe('ignored-and-untracked');
    expect(verifyPathExcluded(join(repo, 'src', 'later.txt'), { env: GIT_ENV }).reason).toBe(
      'not-ignored'
    );
  });

  it('sees a worktree checkout as a repository', () => {
    const repo = initRepo(join(base, 'repo'), { gitignore: '.collabcast/\n' });
    const worktree = join(base, 'wt');
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], repo);

    expect(
      verifyPathExcluded(join(worktree, '.collabcast', 'history'), {
        repoRoot: worktree,
        env: GIT_ENV
      }).reason
    ).toBe('ignored-and-untracked');
  });
});
