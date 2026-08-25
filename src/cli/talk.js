import { clientForProject } from './client.js';

/**
 * Post as the operator principal.
 *
 * Gone from v0.2: `fromSessionId: 'operator'`, `fromAlias: opts.as`, `fromTool: 'operator'`.
 * The operator was a string in a request body, and `--as` let the CLI post under any alias it
 * liked. Authorship is now derived from the operator capability, so there is nothing to forge
 * and nothing to override.
 */
export async function talkCommand(body, opts = {}) {
  const { api } = clientForProject();
  const res = await api.post({ body, type: opts.type || 'broadcast' });
  process.stdout.write(`Posted ${res.id}\n`);
  for (const warning of res.warnings ?? []) {
    if (warning.type !== 'unresolved-mention') continue;
    // Invitations are gone: an alias is claimed by a principal that enrolled, never reserved
    // in advance by someone else. So this is information, not a prompt.
    process.stdout.write(
      `warning: @${warning.token} is not a principal on this channel, so nobody was mentioned.\n`
    );
  }
}
