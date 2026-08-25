// Git discovery overrides must never change an answer this codebase derives from git.
//
// Three independent holes came from honouring them, all found late and all fail-OPEN:
//   - `identity/resolve.js` resolved a directory to a namespace that does not own it.
//   - `config/load.js` declared a TRACKED path safe to overwrite, because a poisoned
//     `GIT_DIR` makes git say "not a git repository" — which the not-a-repo
//     classification reads as "nothing here to protect".
//   - `core/git.js`'s `gitMetadata` stamped another repository's branch, hash and user
//     identity into the durable message marker.
//
// The invariant under test is deliberately stronger than "does not fail open": the
// answer must be IDENTICAL with and without poison. A guard that started returning
// `git-indeterminate` for everything would also close the hole, and would also be a
// regression — so equality is asserted, not just safety.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, git, tmpRoot } from '../identity/tmp-git.js';
import { GIT_DISCOVERY_OVERRIDES, gitMetadata } from '../../src/core/git.js';
import { verifyPathExcluded } from '../../src/config/load.js';

/** A repo with a committed file under `sub/` and an ignored sibling. */
function makeRepo(branch, who) {
  const root = tmpRoot('walkie-gitdisc-');
  git(['init', '-q', '-b', branch], root);
  git(['config', 'user.name', who], root);
  git(['config', 'user.email', `${who.toLowerCase()}@example.invalid`], root);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'tracked.txt'), 'tracked\n');
  writeFileSync(join(root, '.gitignore'), 'sub/ignored.txt\n');
  writeFileSync(join(root, 'sub', 'ignored.txt'), 'ignored\n');
  git(['add', 'sub/tracked.txt', '.gitignore'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

describe('git discovery overrides are never honoured', () => {
  let mine;
  let theirs;
  /** @type {Array<[string, Record<string,string>]>} */
  let poisons;

  beforeAll(() => {
    mine = makeRepo('mine', 'Mine');
    theirs = makeRepo('theirs', 'Theirs');
    // One poison per override. Each is a value that, if honoured, sends git somewhere
    // other than the directory being asked about: at another repository, or nowhere.
    poisons = [
      ['GIT_DIR -> another repo', { GIT_DIR: join(theirs, '.git') }],
      ['GIT_DIR -> nowhere', { GIT_DIR: '/nonexistent/x.git' }],
      ['GIT_COMMON_DIR', { GIT_COMMON_DIR: join(theirs, '.git') }],
      ['GIT_WORK_TREE', { GIT_WORK_TREE: theirs }],
      // Ceiling at the repo root blocks discovery ascending out of `sub/`.
      ['GIT_CEILING_DIRECTORIES', { GIT_CEILING_DIRECTORIES: mine }],
      ['GIT_DISCOVERY_ACROSS_FILESYSTEM', { GIT_DISCOVERY_ACROSS_FILESYSTEM: 'false' }]
    ];
  });

  afterAll(() => {
    cleanup(mine);
    cleanup(theirs);
  });

  test('the poison list covers every declared override', () => {
    const covered = new Set(poisons.flatMap(([, env]) => Object.keys(env)));
    expect([...GIT_DISCOVERY_OVERRIDES].sort()).toEqual([...covered].sort());
  });

  test('a tracked path is never declared git-excluded', () => {
    const target = join(mine, 'sub', 'tracked.txt');
    const clean = verifyPathExcluded(target);
    expect(clean).toMatchObject({ ok: false, reason: 'tracked' });

    for (const [label, env] of poisons) {
      // `ok: true` here is the original defect: a tracked file reported safe to
      // overwrite because git was pointed away from the repository that tracks it.
      expect(verifyPathExcluded(target, { env }), label).toEqual(clean);
    }
  });

  test('an ignored path keeps answering ignored-and-untracked', () => {
    const target = join(mine, 'sub', 'ignored.txt');
    const clean = verifyPathExcluded(target);
    expect(clean).toMatchObject({ ok: true, reason: 'ignored-and-untracked' });

    for (const [label, env] of poisons) {
      expect(verifyPathExcluded(target, { env }), label).toEqual(clean);
    }
  });

  test('message provenance is read from the directory, not the environment', () => {
    const clean = gitMetadata(mine);
    expect(clean).toMatchObject({ branch: 'mine', userName: 'Mine' });
    // `gitMetadata` takes no env parameter — it reads `process.env`, so the ambient
    // case is the only case, and it is the one that reaches the channel marker.
    for (const [label, env] of poisons) {
      const restore = Object.entries(env).map(([k, v]) => {
        const had = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
        process.env[k] = v;
        return [k, had];
      });
      try {
        expect(gitMetadata(mine), label).toEqual(clean);
      } finally {
        for (const [k, had] of restore) {
          if (had === undefined) delete process.env[k];
          else process.env[k] = had;
        }
      }
    }
  });
});
