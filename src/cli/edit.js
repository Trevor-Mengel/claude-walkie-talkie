import { clientForProject } from './client.js';

/**
 * Edit a message. v0.2 asserted `editedBy: 'operator'`; ownership is now decided by the
 * service from the capability, and a non-author is refused with `not_owner`.
 */
export async function editCommand(id, parts) {
  const { api } = clientForProject();
  const res = await api.edit(id, { body: parts.join(' ') });
  process.stdout.write(`Edited ${id} (revision ${res.revision}).\n`);
}
