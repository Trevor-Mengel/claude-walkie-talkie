// The store fixture's own contract: it removes every directory it creates.
//
// This is not decoration. Measured before the fix: the suite left `walkie-store-*`
// trees behind in the OS temp dir, because cleanup ran off a caller-held
// `let fixture` — so a test body that opened a SECOND store silently orphaned
// the first one's directory, and nothing failed. `createTmpStore` now tracks
// every store it hands out and drains them itself; the run-wide backstop lives
// in test/helpers/global-setup.js, which fails the run on any stamped fixture
// directory that survives it.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

/** Roots handed to us by the first test, checked by the second. */
const roots = [];

describe('createTmpStore cleans up every store it hands out', () => {
  test('one test body may open two stores, and neither is the caller\'s to track', () => {
    const first = createTmpStore();
    const second = createTmpStore({ namespace: 'other-project' });
    roots.push(first.root, second.root);

    expect(first.root).not.toBe(second.root);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    // Both are stamped, so global-setup's teardown can attribute a leak to this run.
    for (const root of roots) {
      expect(readFileSync(join(root, '.walkie-run'), 'utf8').trim()).toBe(
        process.env.WALKIE_ISOLATION_ROOT
      );
    }
  });

  // Order-dependent by design: it asserts what the PREVIOUS test's teardown did.
  test('both directories are gone once that test finished', () => {
    expect(roots, 'run the whole file: this test reads the previous one`s roots').toHaveLength(2);
    expect(roots.filter((root) => existsSync(root))).toEqual([]);
  });

  test('cleanupTmpStore is idempotent, so a caller hook and the fixture cannot fight', () => {
    const fixture = createTmpStore();
    cleanupTmpStore(fixture);
    expect(existsSync(fixture.root)).toBe(false);
    // Second call: no throw on the already-closed handle, no ENOENT on the tree.
    expect(() => cleanupTmpStore(fixture)).not.toThrow();
    expect(() => cleanupTmpStore(null)).not.toThrow();
  });
});
