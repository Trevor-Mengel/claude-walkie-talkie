import { walkieError } from '../identity/errors.js';
import { isId } from '../core/ids.js';
import { clientForProject } from './client.js';

/**
 * The operator's inbox, for hook use.
 *
 * `GET /inbox` is strictly non-mutating: printing messages here does not acknowledge them.
 * Acknowledgement is `walkie ack`.
 *
 * `--include-memory-updates` selects the memory-inclusive view, which has its OWN cursor
 * pair. Acking what this printed therefore has to carry the same flag, or the ack lands on
 * the default view's mark and the memory-updates just shown stay unacknowledged forever —
 * so the printed hint carries it through.
 */
export async function inboxCommand(opts = {}) {
  const includeMemoryUpdates = opts.includeMemoryUpdates === true;
  const { api } = clientForProject();
  const inbox = await api.inbox({ includeMemoryUpdates });
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  const messages =
    limit !== undefined && Number.isFinite(limit)
      ? (inbox.messages ?? []).slice(-limit)
      : (inbox.messages ?? []);

  if (opts.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          messages,
          mentionedForMe: inbox.mentionedForMe ?? [],
          lastReadId: inbox.lastReadId ?? null,
          lastAckedId: inbox.lastAckedId ?? null,
          cursors: inbox.cursors ?? null
        },
        null,
        2
      )}\n`
    );
    return;
  }
  if (messages.length === 0) {
    process.stdout.write('walkie-talkie inbox: (no new messages)\n');
    return;
  }
  process.stdout.write(`walkie-talkie inbox: ${messages.length} message(s)\n`);
  for (const m of messages) {
    const sender = m.fromAlias ?? m.fromSessionId;
    const to = (m.mentions ?? []).join(',') || 'all';
    process.stdout.write(`- [${m.id}] ${sender} → ${to}: ${m.body.trim().split('\n')[0]}\n`);
  }
  // The id of the last message actually shown — the only value worth acking. (The old
  // hint echoed the CURRENT cursor, which just re-acked what was already acked.) The flag
  // rides along because it names WHICH view's mark to move; drop it and the ack silently
  // lands on the other view's cursor.
  const flag = includeMemoryUpdates ? ' --include-memory-updates' : '';
  process.stdout.write(
    `(acknowledge with \`walkie ack ${messages[messages.length - 1].id}${flag}\`)\n`
  );
}

/**
 * Advance the read and acknowledgement cursors explicitly.
 *
 * `--include-memory-updates` must match the `walkie inbox` call whose output is being
 * acknowledged: each `/inbox` view carries its own cursor pair, and acking the wrong one
 * leaves what was actually read unacknowledged.
 */
export async function ackCommand(idArg, opts = {}) {
  if (!isId(idArg)) {
    throw walkieError(
      'invalid_request',
      'expected the id of the last message you processed (26-character uppercase ULID)'
    );
  }
  const view = { includeMemoryUpdates: opts.includeMemoryUpdates === true };
  const { api } = clientForProject();
  const out = {};
  if (opts.markRead !== false) out.lastReadId = (await api.markRead(idArg, view)).id;
  out.lastAckedId = (await api.ack(idArg, view)).id;
  process.stdout.write(
    `Acknowledged through ${out.lastAckedId}` +
      `${out.lastReadId === undefined ? '' : ` (read cursor ${out.lastReadId})`}.\n`
  );
}
