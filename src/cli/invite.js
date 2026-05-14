import { clientForProject } from './client.js';

export async function inviteCommand(alias) {
  const c = clientForProject(process.cwd());
  await c.invite(alias);
  console.log(`Invited @${alias}. When a matching session joins, run \`walkie alias <session-id> ${alias}\` to fulfill.`);
}
