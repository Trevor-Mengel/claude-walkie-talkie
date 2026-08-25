import { clientForProject } from './client.js';

/** Reply to a message as the operator principal. */
export async function replyCommand(id, parts) {
  const { api } = clientForProject();
  const target = await api.message(id);
  const addressee = target.message.fromAlias || target.message.fromSessionId;
  const body = `@${addressee} ${parts.join(' ')}`;
  const res = await api.post({ body, type: 'reply', replyTo: id });
  process.stdout.write(`Replied ${res.id} (in reply to ${id}).\n`);
}
