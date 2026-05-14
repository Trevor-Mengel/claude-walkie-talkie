import express from 'express';
import { createEvents } from './events.js';
import { channelRoutes } from './routes/channel.js';

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

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return { app, events };
}
