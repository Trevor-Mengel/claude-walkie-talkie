import express from 'express';
import { createEvents } from './events.js';
import { channelRoutes } from './routes/channel.js';
import { sessionsRoutes } from './routes/sessions.js';
import { permitsRoutes } from './routes/permits.js';
import { eventsRoutes } from './routes/events.js';

// Defense in depth against DNS-rebinding-style browser attacks against the
// local-only daemon. The daemon is bound to 127.0.0.1 so external network
// callers cannot reach it directly, but a malicious page in the operator's
// browser could pin DNS for a domain to 127.0.0.1 and reach us via the
// browser's same-origin policy unless we explicitly reject suspicious
// Origin / Host headers.
function rejectCrossOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    return res.status(403).json({ error: 'cross-origin requests not allowed' });
  }
  const host = (req.headers.host || '').split(':')[0];
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    return res.status(403).json({ error: 'host header must be 127.0.0.1 or localhost' });
  }
  next();
}

export function createServer({ wtDir }) {
  const app = express();
  const events = createEvents();
  app.locals.wtDir = wtDir;
  app.locals.events = events;
  app.use(rejectCrossOrigin);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, wtDir });
  });

  app.use(channelRoutes());
  app.use(sessionsRoutes());
  app.use(permitsRoutes());
  app.use(eventsRoutes());

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return { app, events };
}
