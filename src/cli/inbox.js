import { clientForProject } from './client.js';

export async function inboxCommand(opts) {
  const projectRoot = process.cwd();
  const client = clientForProject(projectRoot);
  const latest = await client.latest(opts.limit ? Number(opts.limit) : 10, false);
  const payload = { messages: latest.messages };

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.messages.length === 0) {
    process.stdout.write('walkie-talkie inbox: (no new messages)\n');
    return;
  }
  process.stdout.write('walkie-talkie inbox: ' + payload.messages.length + ' message(s)\n');
  for (const m of payload.messages) {
    process.stdout.write(`- [${m.id}] ${m.fromAlias ?? m.fromSessionId} → ${(m.mentions ?? []).join(',') || 'all'}: ${m.body.trim().split('\n')[0]}\n`);
  }
}
