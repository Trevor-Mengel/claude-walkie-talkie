// A throw-away namespace that is actually registered, so the client-side resolution path
// (identity map -> config -> transport paths) runs for real in a test.
//
// The host identity map is NOT the harness's shared `WALKIE_IDENTITIES` file: every namespace
// created here writes its own map inside its own temp tree and hands back an `env` that points
// at it. Test workers therefore never mutate a file another worker is reading.

import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { assertDisposable } from './isolation.js';
import { CONFIG_SCHEMA_VERSION } from '../../src/config/schema.js';
import { IDENTITIES_SCHEMA_VERSION } from '../../src/identity/identities.js';
import { createFixtureDir } from './fixture-leaks.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.namespace]
 * @param {'managed'|'standalone'} [opts.mode]
 * @param {object} [opts.config] extra config keys merged over the generated ones
 * @param {Record<string,string|undefined>} [opts.env] extra env for the returned `env`
 * @param {boolean} [opts.autoCleanup]
 */
export function createRegisteredNamespace({
  namespace = 'walkie-test',
  mode = 'managed',
  config = {},
  env: extraEnv = {},
  autoCleanup = true
} = {}) {
  // Kept short: AF_UNIX paths cap near 104 bytes and the socket lives under `runtimeRoot`.
  const base = realpathSync(createFixtureDir('wk-ns-'));
  assertDisposable(base, 'registered namespace base');
  const canonicalRoot = join(base, 'p');
  const runtimeRoot = join(base, 'r');
  const walkieDir = join(canonicalRoot, '.walkie-talkie');
  mkdirSync(walkieDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

  writeFileSync(
    join(walkieDir, 'config.json'),
    `${JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, namespace, mode, ...config }, null, 2)}\n`
  );
  writeFileSync(join(walkieDir, 'channel.md'), '# channel\n');

  const identitiesPath = join(base, 'identities.json');
  writeFileSync(
    identitiesPath,
    `${JSON.stringify(
      {
        schemaVersion: IDENTITIES_SCHEMA_VERSION,
        identities: { [namespace]: { canonicalRoot, registrations: [canonicalRoot] } }
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const env = {
    ...process.env,
    WALKIE_IDENTITIES: identitiesPath,
    WALKIE_PROJECT_ROOT: canonicalRoot,
    WALKIE_RUNTIME_ROOT: runtimeRoot,
    ...extraEnv
  };
  // A capability injected into the ambient environment would silently authenticate every test.
  if (extraEnv.WALKIE_CAPABILITY === undefined) delete env.WALKIE_CAPABILITY;
  if (extraEnv.WALKIE_NAMESPACE === undefined) delete env.WALKIE_NAMESPACE;

  const handle = {
    base,
    namespace,
    mode,
    canonicalRoot,
    runtimeRoot,
    walkieDir,
    identitiesPath,
    socketPath: join(runtimeRoot, 'walkie.sock'),
    operatorCredPath: join(runtimeRoot, 'operator.cred'),
    env,
    /** Write an operator credential (bare token or the enrollment document) at 0600. */
    writeOperatorCredential(credential, fileMode = 0o600) {
      const text = typeof credential === 'string' ? credential : JSON.stringify(credential);
      writeFileSync(handle.operatorCredPath, `${text}\n`, { mode: fileMode });
      return handle.operatorCredPath;
    },
    cleanup() {
      assertDisposable(base, 'registered namespace base');
      rmSync(base, { recursive: true, force: true });
    }
  };

  if (autoCleanup) {
    try {
      onTestFinished(() => handle.cleanup());
    } catch {
      // Outside a test context; the caller owns cleanup.
    }
  }
  return handle;
}
