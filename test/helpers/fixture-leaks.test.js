// The suite's leak detector, and the guard that keeps it from reporting clean by
// construction.
//
// Two defects are being defended against here, and they are different:
//
//   1. Detection used to be gated on a hand-maintained list of directory-name
//      prefixes (`FIXTURE_PREFIXES`). It listed 2 of the ~30 prefixes the suite
//      creates, so most fixtures could leak in total silence, and the list went
//      stale the moment anyone added a fixture. Detection is now driven by the
//      run stamp, so a fixture is covered whatever it calls itself.
//   2. A stamp only exists if the fixture asks for one. `markFixtureDir` was
//      called by exactly one file. `createFixtureDir` closes that by making
//      creation and stamping the same act — but only for as long as nobody goes
//      back to calling `mkdtemp` directly, which is what the last test here is
//      for. It fails the run on a raw fixture-root creation anywhere in `test/`.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { createFixtureDir, findLeakedFixtureDirs, markFixtureDir } from './fixture-leaks.js';

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything this file created, removed even when an expectation throws. */
const trash = [];
afterEach(() => {
  while (trash.length) rmSync(trash.pop(), { recursive: true, force: true });
});

function track(dir) {
  trash.push(dir);
  return dir;
}

/** A directory under the OS temp dir created WITHOUT `mkdtemp`, so the guard below stays true. */
function bareDir(prefix) {
  const dir = join(tmpdir(), `${prefix}${randomUUID()}`);
  mkdirSync(dir);
  return track(dir);
}

describe('fixture leak detection', () => {
  test('detects a leaked fixture under a prefix nothing has ever heard of', () => {
    // Deliberately a prefix no list could have anticipated: the point is that
    // coverage follows from the stamp, not from the name.
    const leaked = track(createFixtureDir('collabcast-brand-new-prefix-'));

    expect(findLeakedFixtureDirs()).toContain(leaked);

    // ...and stops reporting it once the fixture cleans up after itself, which is
    // what a passing run looks like.
    rmSync(leaked, { recursive: true, force: true });
    expect(findLeakedFixtureDirs()).not.toContain(leaked);
  });

  test('stamps every fixture it creates, with this run id and owner-only', () => {
    const dir = track(createFixtureDir('collabcast-stamp-probe-'));
    const marker = join(dir, '.collabcast-run');
    expect(readFileSync(marker, 'utf8').trim()).toBe(process.env.COLLABCAST_ISOLATION_ROOT);
    expect(statSync(marker).mode & 0o777).toBe(0o600);
  });

  test('ignores an unstamped directory: ownership is the stamp, not the name', () => {
    // Same shape as one of ours, no marker — a sibling suite's tree, or a
    // half-removed one. Reporting it would fail our run for someone else's mess.
    const stranger = bareDir('collabcast-store-');
    expect(findLeakedFixtureDirs()).not.toContain(stranger);
  });

  test('ignores a directory stamped by a different run', () => {
    const other = bareDir('collabcast-other-run-');
    markFixtureDir(other, { COLLABCAST_ISOLATION_ROOT: '/tmp/some-other-agents-run' });
    expect(findLeakedFixtureDirs()).not.toContain(other);
  });

  test('reports nothing at all when there is no run id to compare against', () => {
    const dir = track(createFixtureDir('collabcast-norunid-'));
    expect(findLeakedFixtureDirs({})).toEqual([]);
    expect(existsSync(join(dir, '.collabcast-run'))).toBe(true);
  });
});

/**
 * Every `mkdtemp` call in `test/` that is allowed to root a fixture at the OS
 * temp dir, as `file -> parent expression`. Three entries, each load-bearing:
 *
 *   - `helpers/fixture-leaks.js` IS the shared door.
 *   - `helpers/isolation.js` creates the run's own disposable root, which
 *     `roots.cleanup()` owns; stamping it would report it as leaked on every run,
 *     since the leak scan runs before the cleanup.
 *   - `security/init-injection.test.js` nests inside an already-stamped fixture,
 *     so it inherits both the stamp and the removal.
 */
const RAW_MKDTEMP_ALLOWED = Object.freeze([
  'helpers/fixture-leaks.js',
  'helpers/isolation.js',
  'security/init-injection.test.js'
]);

function testFiles(dir = TEST_ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'scratch') continue;
      out.push(...testFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('the shared fixture door', () => {
  test('is the only way test/ creates a fixture root', () => {
    // A list of prefixes drifts the moment someone adds a fixture; a list of
    // files permitted to call `mkdtemp` at all does not, because adding a fixture
    // the ordinary way does not touch it. Anything new is red until its author
    // either routes through `createFixtureDir` or argues for an entry here.
    const offenders = [];
    for (const file of testFiles()) {
      const rel = relative(TEST_ROOT, file).split(sep).join('/');
      if (RAW_MKDTEMP_ALLOWED.includes(rel)) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`test/${rel}:${line}`);
      }
    }
    expect(offenders, [
      'raw mkdtemp in test/: create fixture roots with',
      "`createFixtureDir(prefix)` from test/helpers/fixture-leaks.js so the run's",
      'leak detector can see them. A directory nested inside an already-stamped',
      'fixture needs no stamp; add the file to RAW_MKDTEMP_ALLOWED with a reason.'
    ].join(' ')).toEqual([]);
  });

  test('is imported by every file that creates a fixture root', () => {
    // The inverse direction: a file could route through the helper and then have
    // its import dropped by a bad merge, which fails loudly — but a file that
    // calls the helper without importing it is a typo away from being invisible,
    // so state the pairing.
    const missing = [];
    for (const file of testFiles()) {
      const rel = relative(TEST_ROOT, file).split(sep).join('/');
      if (rel === 'helpers/fixture-leaks.js') continue; // defines it
      const source = readFileSync(file, 'utf8');
      if (!source.includes('createFixtureDir(')) continue;
      if (/from '[^']*fixture-leaks\.js'/.test(source)) continue;
      missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});

describe('the run teardown that consumes this', () => {
  test('would fail the run on a leak, naming the directory', async () => {
    const setup = (await import('./global-setup.js')).default;
    const saved = { ...process.env };
    let err;
    let leaked;
    try {
      const teardown = await setup();
      // `setup()` re-pointed the isolation env at a fresh disposable tree; the leak
      // it must notice has to be stamped with THAT run id, not this worker's.
      leaked = track(createFixtureDir('collabcast-teardown-probe-'));
      try {
        await teardown();
      } catch (e) {
        err = e;
      }
    } finally {
      Object.assign(process.env, saved);
    }
    expect(err?.message).toMatch(/test fixtures leaked 1 temp directory/);
    expect(err.message).toContain(leaked);
    // The teardown sweeps what it reports, so the next run starts from a clean floor.
    expect(existsSync(leaked)).toBe(false);
  });
});
