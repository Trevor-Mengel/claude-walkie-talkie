// Leak detection for the suite's own mkdtemp fixtures.
//
// A fixture that forgets to remove its temp directory still passes every test
// it participates in — the only symptom is stray directories piling up in the
// OS temp dir, which nothing observes. `createFixtureDir` is the one door every
// fixture goes through: it creates the directory AND stamps it with the current
// run's isolation root, so `global-setup.js`'s teardown can name exactly the
// directories THIS run leaked and fail the run on them.
//
// Stamping is what makes the check safe to run on a shared machine: several
// suites (or several agents) may be running concurrently, and a sibling's live
// or leaked fixture must never be reported as ours.
//
// Detection is driven by the stamp, never by a list of directory-name prefixes.
// A prefix allowlist is a guard that reports clean by construction: it covered 2
// of the suite's ~30 prefixes, so the other fixtures could leak silently and
// every newly added fixture started life invisible. Ownership is what the stamp
// encodes, so ownership is what we scan for — a fixture created through the
// helper is covered whatever it calls itself.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = '.walkie-run';

/**
 * Stamp a freshly created fixture directory with the current run's id. A no-op
 * when the run id is absent, which keeps the module usable outside the harness.
 */
export function markFixtureDir(root, env = process.env) {
  const runId = env.WALKIE_ISOLATION_ROOT;
  if (!runId) return;
  writeFileSync(join(root, MARKER), `${runId}\n`, { mode: 0o600 });
}

/**
 * Create a fixture directory directly under the OS temp dir and stamp it. Every
 * fixture in the suite MUST come from here rather than calling `mkdtemp`
 * itself — `test/helpers/fixture-leaks.test.js` fails the run on a raw call —
 * because stamping by construction is the only version of this that survives
 * someone adding a fixture without having read this file.
 *
 * Directories nested INSIDE an already-stamped fixture need no stamp of their
 * own: removing the fixture removes them, and stamping them would report one
 * leak as several.
 *
 * @param {string} prefix `mkdtemp` prefix, e.g. `'walkie-store-'`.
 * @returns {string} the created directory.
 */
export function createFixtureDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  markFixtureDir(root);
  return root;
}

/**
 * Stamped fixture directories still present in the OS temp dir, i.e. leaked by
 * this run. Directories without our marker — a sibling suite's, or a
 * half-removed tree — are never reported.
 */
export function findLeakedFixtureDirs(env = process.env) {
  const runId = env.WALKIE_ISOLATION_ROOT;
  if (!runId) return [];
  const leaked = [];
  const temp = tmpdir();
  let entries;
  try {
    entries = readdirSync(temp, { withFileTypes: true });
  } catch {
    return leaked;
  }
  for (const entry of entries) {
    // Directories only: a marker can only live inside one, and skipping the rest
    // keeps this a single readdir plus one open per candidate directory.
    if (!entry.isDirectory()) continue;
    const dir = join(temp, entry.name);
    let stamp;
    try {
      stamp = readFileSync(join(dir, MARKER), 'utf8');
    } catch {
      continue; // not ours, or already gone
    }
    if (stamp.trim() === runId) leaked.push(dir);
  }
  return leaked;
}
