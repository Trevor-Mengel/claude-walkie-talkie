import { statusDaemon } from '../daemon/lifecycle.js';
import { loadIdentities } from '../identity/identities.js';
import { collabcastError } from '../identity/errors.js';
import { contextForProject } from './client.js';

/**
 * Local service status.
 *
 * Refuses in managed mode: lifecycle there belongs to Paseo, and a client reporting on a
 * process it does not own invites the operator to act on it. `collabcast whoami` is the
 * managed-mode question — it proves the service is answering and says with what authority.
 *
 * `--all` enumerates registered namespaces from the host identity map rather than a
 * machine-wide daemon registry: a namespace is the unit now, and its socket is the claim.
 */
export async function statusCommand(opts = {}) {
  if (opts.all) {
    const map = loadIdentities();
    const entries = Object.values(map.identities);
    if (!entries.length) {
      process.stdout.write('No collabcast namespaces are registered on this host.\n');
      return;
    }
    for (const entry of entries) {
      let line;
      try {
        const status = await statusDaemon({
          canonicalRoot: entry.canonicalRoot,
          namespace: entry.namespace
        });
        const where = status.running ? `answering${status.pid ? ` (pid ${status.pid})` : ''}` : `down (${status.reason})`;
        line = `- ${entry.namespace}  ${entry.canonicalRoot}  ${status.mode ?? '?'}  ${where}`;
      } catch (err) {
        line = `- ${entry.namespace}  ${entry.canonicalRoot}  unreadable (${err.code ?? 'error'})`;
      }
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  const context = contextForProject();
  if (context.mode === 'managed') {
    throw collabcastError(
      'forbidden',
      `namespace "${context.namespace}" is managed: its collabcast service lifecycle belongs to ` +
        'Paseo, so this command does not report on it. Use `collabcast whoami` to confirm the ' +
        'service is answering and what authority you hold.',
      { namespace: context.namespace, mode: context.mode }
    );
  }
  const status = await statusDaemon({
    canonicalRoot: context.canonicalRoot,
    namespace: context.namespace,
    config: context.config
  });
  if (!status.running) {
    process.stdout.write(
      `Service for ${status.namespace} is not answering (${status.reason}). Run \`collabcast start\`.\n`
    );
    return;
  }
  process.stdout.write(
    `Service for ${status.namespace} is answering${status.pid ? ` (pid ${status.pid})` : ''}, ` +
      `mode ${status.mode}, schema ${status.schemaVersion}.\n`
  );
}
