import express from 'express';
import { createEvents } from './events.js';
import { channelRoutes } from './routes/channel.js';
import { sessionsRoutes } from './routes/sessions.js';
import { permitsRoutes } from './routes/permits.js';
import { eventsRoutes } from './routes/events.js';

export function createServer({ wtDir }) {
  const app = express();
  const events = createEvents();
  app.locals.wtDir = wtDir;
  app.locals.events = events;
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
