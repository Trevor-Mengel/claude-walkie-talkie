import { Router } from 'express';
import {
  advanceCursor,
  cursorKindsToAdvance,
  cursorView,
  getCursorViews,
  requireMessageId
} from '../../store/cursors.js';
import { collabcastError } from '../../identity/errors.js';
import { audit } from '../../store/audit.js';
import { requireScope } from '../auth.js';
import { handler, readBody } from './support.js';

const FIELDS = ['id', 'include_memory_updates'];

/** `include_memory_updates: true` and nothing but a boolean. */
function readFlagBody(raw) {
  if (raw === undefined || raw === false) return false;
  if (raw === true) return true;
  throw collabcastError('invalid_request', 'include_memory_updates must be a boolean');
}

/**
 * Cursor writes.
 *
 * There is deliberately no `:principalId` parameter on either route: the cursor
 * moved is always `req.collabcast.principal`'s. v0.2 addressed the cursor by path
 * segment with no authentication at all, so one session could burn another's
 * queue; the shape of these routes makes that unrepresentable.
 *
 * Both are monotonic and idempotent. An id at or below the current position is a
 * no-op that returns the current value — not an error, because a client retrying
 * after a dropped response must be able to replay its last ack safely.
 * The position is a MESSAGE ID, not an ordinal. An ordinal was recomputed from
 * whatever `channel.md` currently parses, so losing one message silently moved
 * every stored cursor past messages that had never been delivered.
 *
 * Both routes take the same `include_memory_updates` flag as `GET /inbox`, because a
 * mark is only sound over the set it was recorded against and `/inbox` serves two
 * differently-filtered sets. Absent/false means "I read the default view", which is no
 * evidence at all about the `memory-update` messages that view hid, so only the default
 * mark moves. True means "I read the memory-inclusive view", where the reader genuinely
 * saw every non-archived message at or below that id — a superset of the default view's
 * — so BOTH marks move. Without the flag one scalar mark governed both views and acking
 * a later broadcast in the default view put an undelivered memory-update permanently
 * below the cutoff: non-delivery recorded as acknowledgement.
 *
 * @param {{store:object, namespace:string}} deps
 */
export function cursorRoutes({ store, namespace } = {}) {
  if (!store) throw new Error('cursorRoutes requires a store');
  const router = Router();
  const move = (kind, action) =>
    handler(async (req, res) => {
      const principal = req.collabcast.principal;
      const body = readBody(req.body, FIELDS);
      const id = requireMessageId(body.id);
      const includeMemory = readFlagBody(body.include_memory_updates);
      const view = cursorView(includeMemory);
      const kinds = cursorKindsToAdvance(includeMemory, kind);

      // One transaction, both marks. A committed cursor move whose audit INSERT threw
      // would be reported to the client as a failure, and the client would replay the
      // ack it thinks it lost against a cursor that has already moved past it. Two marks
      // make that worse, not better: a client told "failed" must never find one of them
      // already advanced and the other not.
      const result = store.tx((tx) => {
        const moved = new Map(
          kinds.map((k) => [
            k,
            advanceCursor(tx, { ownerPrincipalId: principal.id, kind: k, messageId: id })
          ])
        );
        // The mark of the view the caller actually read — the one its next `/inbox` call
        // in that view will be filtered by, and so the only honest thing to answer with.
        const mine = moved.get(view[kind]);
        const detail = { requested: id, id: mine.messageId };
        // Only present when it changes the meaning of the row, so the audit shape of an
        // ordinary ack is unchanged.
        if (includeMemory) detail.includeMemoryUpdates = true;
        audit(tx, {
          namespace,
          actorPrincipalId: principal.id,
          action,
          subject: principal.id,
          outcome: [...moved.values()].some((m) => m.advanced) ? 'allowed' : 'noop',
          detail
        });
        return { id: mine.messageId, views: getCursorViews(tx, principal.id) };
      });
      res.json({
        id: result.id,
        // Both views' marks for this kind, so a client can see that acking the default
        // view left the memory-inclusive mark where it was rather than guessing.
        cursors: {
          default: result.views.default[kind],
          withMemoryUpdates: result.views.withMemoryUpdates[kind]
        }
      });
    });

  router.post('/cursor/read', requireScope('self:cursor'), move('read', 'cursor.read'));
  router.post('/cursor/ack', requireScope('channel:ack'), move('ack', 'cursor.ack'));

  return router;
}
