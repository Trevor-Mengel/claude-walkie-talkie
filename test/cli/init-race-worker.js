// One `collabcast init` in its own process, released at a shared instant.
//
// argv: <projectDir> <identitiesPath> <namespace> <startAtEpochMs>
// exit 0 = registered, 3 = refused with a collabcast error, 1 = anything else.

import { initCommand } from '../../src/cli/init.js';

const [dir, identities, namespace, startAt] = process.argv.slice(2);

process.env.COLLABCAST_IDENTITIES = identities;
process.chdir(dir);

const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

try {
  await initCommand({ operator: 'Race Op', namespace, mode: 'standalone' });
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err.code ?? 'internal'}: ${err.message}\n`);
  process.exit(err.code ? 3 : 1);
}
