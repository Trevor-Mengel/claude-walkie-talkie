// Local fixtures for the store slice. Never touches a default path: every
// store lives in its own mkdtemp directory and is removed afterwards.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import { openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { recordApproval } from '../../src/store/approvals.js';
import { sha256 } from '../../src/store/digest.js';

export const NAMESPACE = 'collabcast';

/**
 * Every store this module has handed out and not yet removed. Cleanup is the
 * fixture's own business, not the caller's: a test body that opens a SECOND
 * store overwrites the caller's `let fixture`, and the first directory would
 * then survive the whole run with nothing observing it.
 */
const live = new Set();

/** @returns {{root:string, dir:string, path:string, namespace:string, store:object}} */
export function createTmpStore({ namespace = NAMESPACE } = {}) {
  const root = createFixtureDir('collabcast-store-');
  const dir = join(root, 'store');
  const path = join(dir, 'collabcast.db');
  const store = openStore({ path, namespace });
  const fixture = { root, dir, path, namespace, store };
  live.add(fixture);
  return fixture;
}

/** Idempotent: cleaning an already-cleaned fixture (or `null`) does nothing. */
export function cleanupTmpStore(fixture) {
  if (!fixture || !live.delete(fixture)) return;
  try {
    fixture.store.close();
  } catch {
    // already closed
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

// Registered once per test file that imports this module, so it covers every
// store the file creates however the caller tracks them. Callers keep their own
// `afterEach(() => cleanupTmpStore(fixture))` for readability; both are safe
// because `cleanupTmpStore` is idempotent and hook order does not matter.
afterEach(() => {
  for (const fixture of [...live]) cleanupTmpStore(fixture);
});

/** Operator + hub principals and a prune approval to hang permits off. */
export function seedActors(store, { subject = 'prune-plan' } = {}) {
  const operator = createPrincipal(store, { role: 'operator', displayAlias: 'operator' });
  const hub = createPrincipal(store, { role: 'goal_hub', displayAlias: 'Main' });
  const approval = recordApproval(store, {
    kind: 'prune',
    subjectDigest: sha256(subject),
    approvingPrincipal: operator.id,
    attestationKind: 'operator_cli'
  });
  return { operator, hub, approval };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
