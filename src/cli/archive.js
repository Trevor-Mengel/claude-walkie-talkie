import { clientForProject } from './client.js';

export async function archiveCommand(id, opts) {
  const client = clientForProject(process.cwd());
  await client.archive(id, { archivedBy: 'operator', reason: opts.reason || null });
  console.log(`Archived ${id}.`);
}
