import { startDaemon } from '../daemon/lifecycle.js';
import { contextForProject } from './client.js';
import { walkieError } from '../identity/errors.js';

/**
 * Start the service for this namespace — standalone mode only.
 *
 * In managed mode the service is Paseo's to run. A client that spawned one would put a second
 * writer on the same socket and the same channel file as the supervised instance.
 */
export async function startCommand() {
  const context = contextForProject();
  if (context.mode === 'managed') {
    throw walkieError(
      'forbidden',
      `namespace "${context.namespace}" is managed: its walkie service is supervised by Paseo ` +
        'and must not be started by a client. Start the Paseo-supervised walkie-svc for this ' +
        'project, or set "mode": "standalone" in .walkie-talkie/config.json to run it yourself.',
      { namespace: context.namespace, mode: context.mode }
    );
  }
  const status = await startDaemon({
    canonicalRoot: context.canonicalRoot,
    namespace: context.namespace,
    config: context.config
  });
  process.stdout.write(
    `Service for ${status.namespace} is answering${status.pid ? ` (pid ${status.pid})` : ''}.\n`
  );
}
