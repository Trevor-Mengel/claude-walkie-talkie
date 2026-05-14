import { Router } from 'express';

const EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.archived',
  'mention.fulfilled',
  'session.joined',
  'session.renamed',
  'permit.granted',
  'permit.revoked',
  'permit.required',
  'channel.external_edit'
];

export function eventsRoutes() {
  const router = Router();

  router.get('/events', (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();

    const emitter = req.app.locals.events;
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
