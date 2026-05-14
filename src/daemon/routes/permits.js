import { Router } from 'express';
import { listPermits, grantPermit, revokePermit } from '../permits.js';

export function permitsRoutes() {
  const router = Router();

  router.get('/permits', async (req, res, next) => {
    try {
      const permits = await listPermits(req.app.locals.wtDir);
      res.json({ permits });
    } catch (e) {
      next(e);
    }
  });

  router.post('/permits', async (req, res, next) => {
    try {
      const events = req.app.locals.events;
      const { sessionId, mode, durationMs } = req.body;
      if (!sessionId || !mode) return res.status(400).json({ error: 'sessionId and mode required' });
      if (!['once', 'duration', 'always'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be once|duration|always' });
      }
      const permit = await grantPermit(req.app.locals.wtDir, { sessionId, mode, durationMs });
      events.emit('permit.granted', { sessionId, mode });
      res.status(201).json(permit);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/permits/:sessionId', async (req, res, next) => {
    try {
      await revokePermit(req.app.locals.wtDir, req.params.sessionId);
      req.app.locals.events.emit('permit.revoked', { sessionId: req.params.sessionId });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
