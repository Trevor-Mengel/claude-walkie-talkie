import express from 'express';
import { createEvents } from './events.js';

/**
 * @param {{ wtDir: string }} opts
 * @returns {{ app: import('express').Express, events: import('node:events').EventEmitter }}
 */
export function createServer({ wtDir }) {
  const app = express();
  const events = createEvents();
  app.locals.wtDir = wtDir;
  app.locals.events = events;
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, wtDir });
  });

  // Additional routes mounted in later tasks.

  return { app, events };
}
