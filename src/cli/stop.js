import { stopDaemon } from '../daemon/lifecycle.js';
import { contextForProject } from './client.js';
import { walkieError } from '../identity/errors.js';

/** Stop the service for this namespace — standalone mode only. */
export async function stopCommand() {
  const context = contextForProject();
  if (context.mode === 'managed') {
    throw walkieError(
      'forbidden',
      `namespace "${context.namespace}" is managed: stopping its walkie service is Paseo's ` +
        'job, not a client\'s. Stop the supervised walkie-svc through Paseo.',
      { namespace: context.namespace, mode: context.mode }
    );
  }
  const result = await stopDaemon({
    canonicalRoot: context.canonicalRoot,
    namespace: context.namespace,
    config: context.config
  });
  if (!result.stopped) {
    process.stdout.write('Nothing is answering for this namespace.\n');
    return;
  }
  process.stdout.write(`Service stopped (pid ${result.pid}).\n`);
}
