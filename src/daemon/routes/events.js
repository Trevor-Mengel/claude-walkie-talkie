import { Router } from 'express';
import { requireScope } from '../auth.js';

// Exactly the events something in `src/` actually emits. Six entries were dead
// after the P0 cutover and advertised themselves to every SSE subscriber
// regardless: `mention.fulfilled` (invitations removed), `session.joined` and
// `session.renamed` (sessions replaced by principals), `permit.granted` and
// `permit.revoked` (routes/permits.js deleted), `permit.required` (the per-post
// permit gate is gone — publishing is the `channel:publish` capability).
// `test/daemon/routes/events.test.js` asserts this list against the emitters in
// `src/`, so it fails rather than drifting the next time an event is added or
// retired.
export const EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.archived',
  'channel.external_edit'
];

/**
 * SSE fan-out. Still an in-memory, best-effort stream: it replays nothing and
 * survives no restart, which is why P1 replaces it with a durable cursor over
 * the event log. Until then the only change here is that a subscriber must
 * prove `channel:read` — v0.2 streamed every message to any unauthenticated
 * caller that opened the socket.
 *
 * @param {{events?:object}} [deps] optional emitter; defaults to `app.locals.events`
 */
export function eventsRoutes({ events: injected } = {}) {
  const router = Router();

  router.get('/events', requireScope('channel:read'), (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();

    const emitter = injected || req.app.locals.events;
    const send = (type, payload) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const listeners = EVENT_TYPES.map((t) => {
      const fn = (payload) => send(t, payload);
      emitter.on(t, fn);
      return { t, fn };
    });

    const keepalive = setInterval(() => res.write(': ka\n\n'), 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const { t, fn } of listeners) emitter.off(t, fn);
    });
  });

  return router;
}
