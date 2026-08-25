// Vitest globalSetup: create one disposable state tree per run and export it
// into `process.env` so `setupFiles` (test/helpers/isolation.js) and every test
// worker see it. Verified against Vitest 1.6: env mutations made here reach
// setup files and test files.
//
// The bootstrap flag suppresses isolation.js's on-import guard for this one
// module graph — this is the process that establishes the isolation, so the
// variables cannot exist yet.

export default async function setup() {
  globalThis.__COLLABCAST_ISOLATION_BOOTSTRAP__ = true;
  const { makeDisposableRoots, applyIsolationEnv, installIsolation } = await import('./isolation.js');
  const { findLeakedFixtureDirs } = await import('./fixture-leaks.js');
  const { rmSync } = await import('node:fs');

  const roots = makeDisposableRoots();
  applyIsolationEnv(roots);
  installIsolation();

  return async () => {
    // A fixture that never removes its mkdtemp directory passes every test it
    // takes part in; the only evidence is `collabcast-*` trees accumulating in the
    // OS temp dir. Fail the run on ours, and sweep them so the next run starts
    // from a clean floor. Only directories stamped with THIS run's id count, so
    // a concurrent suite on the same machine can never make this red.
    const leaked = findLeakedFixtureDirs();
    roots.cleanup();
    if (leaked.length === 0) return;
    for (const dir of leaked) rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `test fixtures leaked ${leaked.length} temp director${leaked.length === 1 ? 'y' : 'ies'} ` +
        `(swept now, but the fixture must clean up after itself):\n  ${leaked.join('\n  ')}`
    );
  };
}
