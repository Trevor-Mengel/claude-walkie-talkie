import { clientForProject } from './client.js';

/**
 * Who is on the channel.
 *
 * The command name is kept because "who is on the channel" is the stable user-facing concept,
 * but the payload is a principal roster now: there are no sessions, no retired sessions and no
 * pending invitations to report, so the old three-section output cannot be reconstructed.
 */
export async function sessionsCommand() {
  const { api } = clientForProject();
  const { principals } = await api.principals();
  if (!principals?.length) {
    process.stdout.write('No principals on this channel.\n');
    return;
  }
  const rows = [...principals].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  process.stdout.write('Principals on this channel:\n');
  for (const p of rows) {
    const alias = p.displayAlias ? `@${p.displayAlias}` : '(no alias)';
    process.stdout.write(`  ${alias.padEnd(24)} ${p.role.padEnd(10)} ${p.id}  joined ${p.createdAt}\n`);
  }
}
