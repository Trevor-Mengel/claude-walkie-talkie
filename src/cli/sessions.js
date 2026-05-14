import { clientForProject } from './client.js';

export async function sessionsCommand() {
  const c = clientForProject(process.cwd());
  const s = await c.sessions();
  console.log('Active sessions:');
  if (!s.active.length) console.log('  (none)');
  for (const x of s.active) {
    console.log(`  ${x.alias}  [${x.tool}]  session ${x.sessionId}  last seen ${x.lastSeen}`);
  }
  console.log('\nRecent sessions:');
  if (!s.recent.length) console.log('  (none)');
  for (const x of s.recent.slice(0, 10)) {
    console.log(`  ${x.alias}  [${x.tool}]  retired ${x.retiredAt}`);
  }
  console.log('\nPending invitations:');
  if (!s.invitations.length) console.log('  (none)');
  for (const x of s.invitations) {
    console.log(`  @${x.alias}  invited by ${x.invitedBy} at ${x.invitedAt}`);
  }
}
