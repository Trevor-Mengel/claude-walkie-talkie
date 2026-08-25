// The host identity map under real process concurrency.
//
// The map is the root of ALL namespace resolution: `resolveNamespace` reads it to find the
// project a client belongs to. `collabcast init` used to do read -> JSON.parse -> mutate ->
// writeFile with no lock and no temp+rename, so two inits in different projects on one host
// silently lost one registration (that project then failed every command with
// `namespace_unresolved` and nothing to point at), and an interrupted write left JSON that
// `parseIdentities` rejects for EVERY project on the box.
//
// Real child processes, released at a shared instant, are the point: an in-process test of an
// unlocked read-modify-write would pass, because one event loop serialises it for free.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITIES_SCHEMA_VERSION, parseIdentities } from '../../src/identity/identities.js';
import { assertDisposable } from '../helpers/isolation.js';
import { GIT_ENV } from '../identity/tmp-git.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'init-race-worker.js');
const WORKERS = 10;

let base;
let identities;

beforeEach(() => {
  base = realpathSync(createFixtureDir('collabcast-init-race-'));
  assertDisposable(base, 'init race scratch dir');
  identities = join(base, 'identities.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function spawnInit(dir, namespace, startAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, dir, identities, namespace, String(startAt)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...GIT_ENV }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ namespace, code, stderr }));
  });
}

describe('concurrent collabcast init against one host identity map', () => {
  test(`${WORKERS} racing processes all keep their registration`, async () => {
    const projects = Array.from({ length: WORKERS }, (_, i) => {
      const namespace = `race-${i}`;
      const dir = join(base, namespace);
      mkdirSync(dir, { recursive: true });
      return { namespace, dir };
    });

    const startAt = Date.now() + 1500;
    const results = await Promise.all(
      projects.map((p) => spawnInit(p.dir, p.namespace, startAt))
    );

    const failures = results.filter((r) => r.code !== 0);
    expect(failures.map((f) => `${f.namespace}:${f.code}:${f.stderr.trim()}`)).toEqual([]);

    // The map must be parseable — an interleaved write leaves truncated or doubled JSON.
    const raw = readFileSync(identities, 'utf8');
    const map = parseIdentities(JSON.parse(raw), { source: identities });
    expect(map.schemaVersion).toBe(IDENTITIES_SCHEMA_VERSION);

    // And every registration must have survived. This is what an unlocked
    // read-modify-write loses: the last writer overwrites everyone it did not read.
    const registered = Object.keys(map.identities).sort();
    expect(registered).toEqual(projects.map((p) => p.namespace).sort());
    for (const p of projects) {
      expect(map.identities[p.namespace].registrations).toEqual([p.dir]);
    }
  }, 60000);

  test('a loose-mode identity map is tightened to 0600 by the next write', async () => {
    writeFileSync(
      identities,
      `${JSON.stringify({ schemaVersion: IDENTITIES_SCHEMA_VERSION, identities: {} }, null, 2)}\n`
    );
    chmodSync(identities, 0o644);
    expect(statSync(identities).mode & 0o777).toBe(0o644);

    const dir = join(base, 'tighten');
    mkdirSync(dir, { recursive: true });
    const result = await spawnInit(dir, 'tighten', Date.now());

    expect(`${result.code}:${result.stderr.trim()}`).toBe('0:');
    expect(statSync(identities).mode & 0o777).toBe(0o600);
    // No temp file left behind by the atomic write.
    expect(existsSync(`${identities}.tmp`)).toBe(false);
    const map = parseIdentities(JSON.parse(readFileSync(identities, 'utf8')), {
      source: identities
    });
    expect(Object.keys(map.identities)).toEqual(['tighten']);
  }, 30000);

  test('a freshly created map is 0600, not whatever the umask allows', async () => {
    // `writeFile({ mode })` is masked by the umask, so the mode it lands is the host's
    // business, not ours. An explicit chmod is the only way the map is owner-only on every
    // host — this file names signal targets and every project path on the box.
    const dir = join(base, 'fresh');
    mkdirSync(dir, { recursive: true });
    const result = await spawnInit(dir, 'freshns', Date.now());

    expect(`${result.code}:${result.stderr.trim()}`).toBe('0:');
    expect(statSync(identities).mode & 0o777).toBe(0o600);
  }, 30000);
});
