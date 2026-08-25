import { clientForProject } from './client.js';
import { renderMessages } from './render.js';

export async function readCommand(opts = {}) {
  const { api } = clientForProject();
  const limit = Number(opts.limit) || 5;
  const response = opts.since
    ? await api.since(opts.since)
    : await api.latest(limit, Boolean(opts.includeArchived));
  const messages = opts.type
    ? response.messages.filter((m) => m.type === opts.type)
    : response.messages;
  process.stdout.write(`${renderMessages(messages)}\n`);
}
