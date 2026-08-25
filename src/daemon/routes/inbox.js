import { Router } from 'express';
import { readChannel } from '../../core/channel.js';
import { getCursorViews } from '../../store/cursors.js';
import { requireScope } from '../auth.js';
import { addressesPrincipal, handler, readFlag } from './support.js';

/**
 * The inbox.
 *
 * v0.2's `GET /sessions/:id/inbox` advanced the addressed session's read cursor
 * as a side effect of answering, which made a plain read destructive: any
 * caller could empty anyone's queue, an interrupted client lost every message
 * it had been handed, and a read racing a write skipped the write. This route
 * is a pure function of (channel, cursors). Cursors move only through
 * `POST /cursor/read` and `POST /cursor/ack`.
 *
 * It is also a pure function of the messages that are actually in the file: the
 * cutoff is the ack cursor's message id, compared against each message's own id.
 * When it was the recomputed 1-based ordinal of a message among those that
 * parsed, one older message dropping out of the parse — a corrupted marker, a
 * hand-edited heading, a retention prune — renumbered everything after it and
 * moved unread messages BELOW every stored cursor, permanently and silently.
 *
 * The category filter runs BEFORE the cutoff, and each view has its own cursor.
 * Ordered the other way round — cutoff first, then drop `memory-update` — one scalar
 * mark governed two differently-filtered sets, and a scalar high-water mark is sound
 * only over a set that cannot gain members below the mark. It could: the default view
 * hid a memory-update, the reader acked a LATER broadcast exactly as instructed, and the
 * memory-update was then below the mark and unreachable in the inclusive view forever.
 * Non-delivery converted into acknowledgement. One mark per view, each sound over its
 * own set.
 *
 * @param {{store:object, channelPath:string}} deps
 */
export function inboxRoutes({ store, channelPath } = {}) {
  if (!store) throw new Error('inboxRoutes requires a store');
  if (!channelPath) throw new Error('inboxRoutes requires a channelPath');
  const router = Router();

  router.get(
    '/inbox',
    requireScope('channel:read'),
    handler(async (req, res) => {
      const principal = req.collabcast.principal;
      const includeMemory = readFlag(req.query.include_memory_updates);

      // Read the cursors first: a message appended between this read and the
      // channel read shows up next call rather than being silently skipped,
      // because nothing here writes a cursor.
      const views = getCursorViews(store, principal.id);
      const { messages } = await readChannel(channelPath);

      // The category predicate defines the SET; this view's own ack mark is the cutoff
      // over that set. Pairing them correctly is the fix — a mark is sound only over the
      // set it was recorded against. `m.id > ack` and nothing else: no counting, so no
      // message can become invisible because an unrelated message failed to parse.
      const cursors = views[includeMemory ? 'withMemoryUpdates' : 'default'];
      const visible = messages.filter(
        (m) =>
          !m.archived &&
          (includeMemory || m.type !== 'memory-update') &&
          m.id > cursors.ack
      );
      // Oldest first: an inbox is a queue, and the client acks the id of the last
      // message it actually processed.
      visible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      res.json({
        messages: visible,
        mentionedForMe: visible.filter((m) => addressesPrincipal(principal, m)),
        // The marks for the view this response was served from...
        lastReadId: cursors.read,
        lastAckedId: cursors.ack,
        // ...and both, so a client can see that acking here did not move the other one.
        cursors: {
          default: { lastReadId: views.default.read, lastAckedId: views.default.ack },
          withMemoryUpdates: {
            lastReadId: views.withMemoryUpdates.read,
            lastAckedId: views.withMemoryUpdates.ack
          }
        }
      });
    })
  );

  return router;
}
