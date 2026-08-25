import { clientForProject } from './client.js';

/**
 * Archive a message. v0.2 asserted `archivedBy: 'operator'`; the service now derives the
 * archiver, and permits the operator role to archive anyone's message as moderation.
 */
export async function archiveCommand(id, opts = {}) {
  const { api } = clientForProject();
  await api.archive(id, { reason: opts.reason ?? null });
  process.stdout.write(`Archived ${id}.\n`);
}
