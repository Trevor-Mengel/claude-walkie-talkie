import { clientForProject } from './client.js';

function parseDuration(s) {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new Error(`Bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  const factor = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return n * factor;
}

async function resolveSession(client, sessionOrAlias) {
  if (/^[a-z]{2,}_/.test(sessionOrAlias) || sessionOrAlias === 'operator') return sessionOrAlias;
  const s = await client.sessions();
  const match = [...s.active, ...s.recent].find((x) => x.alias === sessionOrAlias);
  if (!match) throw new Error(`No session with alias "${sessionOrAlias}"`);
  return match.sessionId;
}

export async function permitCommand(session, opts) {
  const c = clientForProject(process.cwd());
  let mode = 'once';
  let durationMs;
  if (opts.always) mode = 'always';
  else if (opts.duration) {
    mode = 'duration';
    durationMs = parseDuration(opts.duration);
  } else if (opts.once || (!opts.always && !opts.duration)) {
    mode = 'once';
  }
  const sessionId = await resolveSession(c, session);
  const permit = await c.grantPermit({ sessionId, mode, durationMs });
  console.log(`Granted ${mode} permit to ${sessionId}${permit.expiresAt ? ` (expires ${permit.expiresAt})` : ''}.`);
}
