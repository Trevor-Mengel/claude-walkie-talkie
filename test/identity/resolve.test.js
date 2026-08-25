import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot, resolveNamespace } from '../../src/identity/resolve.js';
import { GIT_ENV, cleanup, git, initRepo, mkdirp, tmpRoot, writeIdentities } from './tmp-git.js';

let base;
let mapPath;

function writeMap(identities) {
  return writeIdentities(mapPath, { schemaVersion: 1, identities });
}

function env(extra = {}) {
  return { ...GIT_ENV, WALKIE_IDENTITIES: mapPath, ...extra };
}

function expectThrow(fn, code) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'expected a throw').toBeDefined();
  expect(thrown.name).toBe('WalkieError');
  expect(thrown.code).toBe(code);
  return thrown;
}

beforeEach(() => {
  base = tmpRoot('walkie-resolve-');
  mapPath = join(base, 'identities.json');
});

afterEach(() => cleanup(base));

describe('resolveNamespace with a real git worktree', () => {
  it('resolves a linked worktree to the MAIN repository namespace', () => {
    const main = initRepo(join(base, 'main'));
    const worktree = join(base, 'elsewhere', 'feature-checkout');
    mkdirp(join(base, 'elsewhere'));
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], main);

    writeMap({
      'walkie-talkie': {
        canonicalRoot: main,
        registrations: [main],
        paseoProjectKey: 'remote:github.com/owner/repo'
      }
    });

    const fromMain = resolveNamespace({ cwd: main, env: env() });
    const fromWorktree = resolveNamespace({ cwd: worktree, env: env() });
    const fromWorktreeSubdir = resolveNamespace({
      cwd: mkdirp(join(worktree, 'src', 'deep')),
      env: env()
    });

    expect(fromWorktree.namespace).toBe('walkie-talkie');
    expect(fromWorktree.canonicalRoot).toBe(main);
    expect(fromWorktree.registrationRoot).toBe(main);
    expect(fromWorktree.paseoProjectKey).toBe('remote:github.com/owner/repo');
    expect(fromWorktree).toEqual(fromMain);
    expect(fromWorktreeSubdir).toEqual(fromMain);
    expect(Object.isFrozen(fromWorktree)).toBe(true);
  });

  it('reports the main repository root from inside a worktree', () => {
    const main = initRepo(join(base, 'main'));
    const worktree = join(base, 'wt');
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], main);

    expect(repositoryRoot({ cwd: worktree, env: GIT_ENV })).toEqual({
      root: main,
      inRepo: true,
      gitCommonDir: join(main, '.git')
    });
    expect(git(['rev-parse', '--show-toplevel'], worktree)).toBe(worktree);
  });

  it('falls back to cwd when the directory is not in a repository', () => {
    const plain = mkdirp(join(base, 'plain'));
    expect(repositoryRoot({ cwd: plain, env: GIT_ENV })).toEqual({
      root: plain,
      inRepo: false,
      gitCommonDir: null
    });

    writeMap({ plain: { canonicalRoot: plain, registrations: [plain] } });
    expect(resolveNamespace({ cwd: plain, env: env() }).namespace).toBe('plain');
  });

  // Every git failure used to return `{root: cwd, inRepo: false}`. That is a fabrication:
  // "git could not tell me" became "there is no repository here", and inside a linked
  // worktree the WORKTREE path was then matched against the registration map instead of the
  // main checkout's — so a directory could resolve to a namespace that does not own it.
  it('fails closed when git refuses to answer for a reason other than "no repository"', () => {
    const repo = initRepo(join(base, 'broken'));
    writeFileSync(join(repo, '.git', 'config'), '[core\n');

    const thrown = expectThrow(() => repositoryRoot({ cwd: repo, env: GIT_ENV }), 'namespace_unresolved');
    expect(thrown.detail.reason).toBe('git_indeterminate');

    // And it fails closed all the way out: the namespace registered at this very path is
    // NOT handed over on the strength of a fabricated root.
    writeMap({ broken: { canonicalRoot: repo, registrations: [repo] } });
    expectThrow(() => resolveNamespace({ cwd: repo, env: env() }), 'namespace_unresolved');
  });

  it('a poisoned GIT_DIR cannot point resolution at another repository', () => {
    const main = initRepo(join(base, 'main'));
    const other = initRepo(join(base, 'other'));
    const worktree = join(base, 'wt');
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], main);

    writeMap({
      mine: { canonicalRoot: main, registrations: [main] },
      theirs: { canonicalRoot: other, registrations: [other] }
    });

    // git honours GIT_DIR and would answer `other/.git` — a successful, WRONG answer.
    const poisoned = env({ GIT_DIR: join(other, '.git') });
    expect(repositoryRoot({ cwd: worktree, env: poisoned }).root).toBe(main);
    expect(resolveNamespace({ cwd: worktree, env: poisoned }).namespace).toBe('mine');
  });

  it('a poisoned GIT_CEILING_DIRECTORIES cannot detach a worktree from its owner', () => {
    const main = initRepo(join(base, 'main'));
    const worktree = join(base, 'elsewhere', 'wt');
    mkdirp(join(base, 'elsewhere'));
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], main);
    const deep = mkdirp(join(worktree, 'src', 'deep'));

    // `elsewhere` is a DIFFERENT namespace that happens to contain the worktree path.
    writeMap({
      mine: { canonicalRoot: main, registrations: [main] },
      neighbour: { canonicalRoot: join(base, 'elsewhere'), registrations: [join(base, 'elsewhere')] }
    });

    // With the ceiling set, git's discovery cannot see the worktree's `.git` file and
    // reports no repository — which used to make `deep` its own root, land it inside
    // `elsewhere`, and hand over the neighbour's namespace.
    const poisoned = env({ GIT_CEILING_DIRECTORIES: worktree });
    expect(repositoryRoot({ cwd: deep, env: poisoned })).toEqual({
      root: main,
      inRepo: true,
      gitCommonDir: join(main, '.git')
    });
    expect(resolveNamespace({ cwd: deep, env: poisoned }).namespace).toBe('mine');
  });
});

describe('resolveNamespace matching', () => {
  it('throws namespace_unresolved for an unmapped cwd', () => {
    const mapped = initRepo(join(base, 'mapped'));
    const stranger = initRepo(join(base, 'stranger'));
    writeMap({ mapped: { canonicalRoot: mapped, registrations: [mapped] } });

    const err = expectThrow(
      () => resolveNamespace({ cwd: stranger, env: env() }),
      'namespace_unresolved'
    );
    expect(err.message).toContain(stranger);
    expect(err.detail.searchRoot).toBe(stranger);
  });

  it('picks the longest matching registration prefix', () => {
    const outer = mkdirp(join(base, 'outer'));
    const inner = mkdirp(join(base, 'outer', 'nested'));
    const leaf = mkdirp(join(inner, 'pkg'));
    writeMap({
      outer: { canonicalRoot: outer, registrations: [outer] },
      inner: { canonicalRoot: inner, registrations: [inner] }
    });

    expect(resolveNamespace({ cwd: leaf, env: env() })).toEqual({
      namespace: 'inner',
      canonicalRoot: inner,
      registrationRoot: inner,
      paseoProjectKey: null
    });
    expect(resolveNamespace({ cwd: outer, env: env() }).namespace).toBe('outer');
  });

  it('throws config_invalid naming both namespaces when a path is claimed twice', () => {
    const shared = mkdirp(join(base, 'shared'));
    const other = mkdirp(join(base, 'other'));
    writeMap({
      alpha: { canonicalRoot: shared, registrations: [shared] },
      beta: { canonicalRoot: other, registrations: [other, shared] }
    });

    const err = expectThrow(() => resolveNamespace({ cwd: shared, env: env() }), 'config_invalid');
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
  });

  it('never falls back to a default namespace when the map is empty', () => {
    const plain = mkdirp(join(base, 'plain'));
    writeMap({});
    expectThrow(() => resolveNamespace({ cwd: plain, env: env() }), 'namespace_unresolved');
  });
});

describe('WALKIE_NAMESPACE is a hint, not an authority', () => {
  it('rejects a hint that does not own the cwd', () => {
    const owned = mkdirp(join(base, 'owned'));
    const elsewhere = mkdirp(join(base, 'elsewhere'));
    writeMap({
      owner: { canonicalRoot: owned, registrations: [owned] },
      squatter: { canonicalRoot: elsewhere, registrations: [elsewhere] }
    });

    const err = expectThrow(
      () => resolveNamespace({ cwd: owned, env: env({ WALKIE_NAMESPACE: 'squatter' }) }),
      'namespace_unresolved'
    );
    expect(err.detail.reason).toBe('hint_does_not_own_cwd');
    expect(err.detail.owner).toBe('owner');
  });

  it('rejects a hint that is absent from the map or malformed', () => {
    const owned = mkdirp(join(base, 'owned'));
    writeMap({ owner: { canonicalRoot: owned, registrations: [owned] } });

    expect(
      expectThrow(
        () => resolveNamespace({ cwd: owned, env: env({ WALKIE_NAMESPACE: 'ghost' }) }),
        'namespace_unresolved'
      ).detail.reason
    ).toBe('hint_unknown_namespace');

    expect(
      expectThrow(
        () => resolveNamespace({ cwd: owned, env: env({ WALKIE_NAMESPACE: 'Bad Name' }) }),
        'namespace_unresolved'
      ).detail.reason
    ).toBe('hint_invalid');
  });

  it('honours a hint that agrees with the resolved owner', () => {
    const owned = mkdirp(join(base, 'owned'));
    writeMap({ owner: { canonicalRoot: owned, registrations: [owned] } });
    expect(
      resolveNamespace({ cwd: owned, env: env({ WALKIE_NAMESPACE: 'owner' }) }).namespace
    ).toBe('owner');
  });
});
