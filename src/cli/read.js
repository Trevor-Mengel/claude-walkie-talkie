import { clientForProject } from './client.js';
import { renderMessages } from './render.js';

export async function readCommand(opts) {
  const client = clientForProject(process.cwd());
  const limit = Number(opts.limit) || 5;
  let response;
  if (opts.since) {
    response = await client.since(opts.since);
  } else {
    response = await client.latest(limit, Boolean(opts.includeArchived));
  }
  let messages = response.messages;
  if (opts.type) messages = messages.filter((m) => m.type === opts.type);
  console.log(renderMessages(messages));
}
