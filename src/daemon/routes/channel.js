import { Router } from 'express';
import { join } from 'node:path';
import {
  readChannel,
  appendMessage,
  editMessage,
  archiveMessage
} from '../../core/channel.js';
import { gitMetadata } from '../../core/git.js';
import { readHistory } from '../../core/history.js';
import { now } from '../../core/time.js';
import { parseMentions, resolveMentions } from '../../core/mentions.js';
import { loadSessions } from '../../registry/sessions.js';
import { checkAndConsume } from '../permits.js';

function channelPath(wtDir) {
  return join(wtDir, 'channel.md');
}

function sessionsDir(wtDir) {
  return join(wtDir, '.sessions');
}

function filterArchived(messages, include) {
  return include ? messages : messages.filter((m) => !m.archived);
}

export function channelRoutes() {
  const router = Router();

  router.get('/channel/latest', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 200);
      const includeArchived = req.query.include_archived === 'true';
      const { messages } = await readChannel(channelPath(req.app.locals.wtDir));
      const filtered = filterArchived(messages, includeArchived).slice(0, limit);
      res.json({ messages: filtered });
    } catch (e) {
      next(e);
    }
  });

  router.get('/channel/since/:ulid', async (req, res, next) => {
    try {
      const { messages } = await readChannel(channelPath(req.app.locals.wtDir));
      const after = req.params.ulid;
      const filtered = messages.filter((m) => m.id > after && !m.archived);
      res.json({ messages: filtered });
    } catch (e) {
      next(e);
    }
  });

  router.get('/channel/message/:id', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const { messages } = await readChannel(channelPath(wtDir));
      const message = messages.find((m) => m.id === req.params.id);
      if (!message) return res.status(404).json({ error: 'not found' });
      const history = await readHistory(sessionsDir(wtDir), req.params.id);
      res.json({ message, history });
    } catch (e) {
      next(e);
    }
  });

  router.post('/channel/message', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { body, type = 'broadcast', fromSessionId, fromAlias, fromTool, replyTo, autonomous } = req.body;
      if (!body || !fromSessionId) {
        return res.status(400).json({ error: 'body and fromSessionId are required' });
      }
      if (autonomous && fromSessionId !== 'operator') {
        const check = await checkAndConsume(wtDir, fromSessionId);
        if (!check.allowed) {
          req.app.locals.events.emit('permit.required', { session_id: fromSessionId });
          return res.status(403).json({
            status: 'permit_required',
            session_id: fromSessionId,
            reason: check.reason,
            hint: `Operator: run \`walkie permit ${fromSessionId} --once\` (or --duration X / --always) to allow this write.`
          });
        }
      }
      const tokens = parseMentions(body);
      const { active } = await loadSessions(wtDir);
      const { resolved, unresolved } = resolveMentions(tokens, active);
      const mentions = resolved.filter((r) => !r.startsWith('@'));
      const projectRoot = wtDir.replace(/\/\.walkie-talkie$/, '');
      const id = await appendMessage(channelPath(wtDir), {
        type,
        fromSessionId,
        fromAlias,
        fromTool,
        mentions,
        mentionsPending: unresolved,
        replyTo,
        autonomous: Boolean(autonomous),
        timestamp: now(),
        git: gitMetadata(projectRoot),
        body
      });
      events.emit('message.posted', { id, type, from: fromSessionId, mentions });
      res.status(201).json({
        id,
        warnings: unresolved.map((tok) => ({ type: 'unresolved-mention', token: tok }))
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/channel/message/:id', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { body, editedBy } = req.body;
      if (!body || !editedBy) {
        return res.status(400).json({ error: 'body and editedBy are required' });
      }
      const { revision } = await editMessage(channelPath(wtDir), req.params.id, body, editedBy);
      events.emit('message.edited', { id: req.params.id, revision });
      res.json({ id: req.params.id, revision });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  router.post('/channel/message/:id/archive', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { archivedBy, reason } = req.body;
      if (!archivedBy) return res.status(400).json({ error: 'archivedBy required' });
      await archiveMessage(channelPath(wtDir), req.params.id, archivedBy, reason ?? null);
      events.emit('message.archived', { id: req.params.id, by: archivedBy });
      res.json({ ok: true });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  return router;
}
