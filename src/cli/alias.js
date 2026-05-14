import { clientForProject } from './client.js';

export async function aliasCommand(sessionId, newAlias) {
  const c = clientForProject(process.cwd());
  const r = await c.rename(sessionId, newAlias);
  console.log(`Renamed ${sessionId} → ${r.alias}${r.fulfilled ? ' (fulfilled pending invitation)' : ''}.`);
}
