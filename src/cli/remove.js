import { clientForProject } from './client.js';

export async function removeCommand(session) {
  const c = clientForProject(process.cwd());
  let sessionId = session;
  if (!/^[a-z]{2,}_/.test(session) && session !== 'operator') {
    const s = await c.sessions();
    const match = [...s.active, ...s.recent].find((x) => x.alias === session);
    if (!match) throw new Error(`No session with alias "${session}"`);
    sessionId = match.sessionId;
  }
  await c.revokePermit(sessionId);
  console.log(`Removed permit for ${sessionId}.`);
}
