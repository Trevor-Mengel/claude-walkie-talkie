import { Router } from 'express';
import {
  loadSessions,
  joinSession,
  renameSession
} from '../../registry/sessions.js';
import {
  loadInvitations,
  addInvitation,
  findInvitation,
  fulfillInvitation
} from '../../registry/invitations.js';

export function sessionsRoutes() {
  const router = Router();

  router.get('/sessions', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const sessions = await loadSessions(wtDir);
      const invitations = await loadInvitations(wtDir);
      res.json({ active: sessions.active, recent: sessions.recent, invitations });
    } catch (e) {
      next(e);
    }
  });

  router.post('/sessions/join', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { tool, sessionId, alias } = req.body;
      if (!tool) return res.status(400).json({ error: 'tool required' });
      const session = await joinSession(wtDir, { tool, sessionId, alias });
      events.emit('session.joined', { session_id: session.sessionId, alias: session.alias, tool: session.tool });
      res.json(session);
    } catch (e) {
      next(e);
    }
  });

  router.post('/sessions/:id/rename', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { alias } = req.body;
      if (!alias) return res.status(400).json({ error: 'alias required' });
      const session = await renameSession(wtDir, req.params.id, alias);
      const matchingInvite = await findInvitation(wtDir, alias);
      let fulfilled = false;
      if (matchingInvite) {
        await fulfillInvitation(wtDir, alias, session.sessionId);
        events.emit('mention.fulfilled', {
          pending_alias: alias,
          fulfilling_session_id: session.sessionId
        });
        fulfilled = true;
      }
      events.emit('session.renamed', { session_id: session.sessionId, alias, tool: session.tool });
      res.json({ ...session, fulfilled });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  router.post('/sessions/invite', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const { alias, invitedBy = 'operator', fromMessage = null } = req.body;
      if (!alias) return res.status(400).json({ error: 'alias required' });
      await addInvitation(wtDir, { alias, invitedBy, fromMessage });
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
