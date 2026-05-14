import { clientForProject } from './client.js';

export async function renameCommand(newAlias) {
  const c = clientForProject(process.cwd());
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) {
    console.error('No current session context (CLAUDE_SESSION_ID not set). Use `walkie alias <session-id> <alias>` instead.');
    process.exit(1);
  }
  const r = await c.rename(sessionId, newAlias);
  console.log(`Renamed ${sessionId} → ${r.alias}${r.fulfilled ? ' (fulfilled pending invitation)' : ''}.`);
}
