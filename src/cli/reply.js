import { clientForProject } from './client.js';

export async function replyCommand(id, parts, opts) {
  const client = clientForProject(process.cwd());
  const target = await client.message(id);
  const fromAlias = target.message.fromAlias || target.message.fromSessionId;
  const body = `@${fromAlias} ${parts.join(' ')}`;
  const res = await client.post({
    body,
    type: 'reply',
    fromSessionId: 'operator',
    fromAlias: opts.as || 'operator',
    fromTool: 'operator',
    replyTo: id
  });
  console.log(`Replied ${res.id} (in reply to ${id}).`);
}
