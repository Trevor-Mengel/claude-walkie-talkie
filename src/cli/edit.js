import { clientForProject } from './client.js';

export async function editCommand(id, parts) {
  const client = clientForProject(process.cwd());
  const res = await client.edit(id, { body: parts.join(' '), editedBy: 'operator' });
  console.log(`Edited ${id} (revision ${res.revision}).`);
}
