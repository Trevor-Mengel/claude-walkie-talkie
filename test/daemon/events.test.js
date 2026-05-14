import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
let server;
afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  if (project) cleanup(project);
  project = null;
});

function startListening(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ s, port: s.address().port }));
  });
}

describe('SSE events', () => {
  test('GET /events streams a message.posted event when a message is posted', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const { s, port } = await startListening(app);
    server = s;
    const chunks = [];
    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      res.on('data', (c) => chunks.push(c.toString()));
    });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${port}/channel/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'hi',
        type: 'broadcast',
        fromSessionId: 'operator',
        fromAlias: 'Trevor',
        fromTool: 'operator'
      })
    });
    await new Promise((r) => setTimeout(r, 100));
    const joined = chunks.join('');
    expect(joined).toContain('event: message.posted');
    expect(joined).toContain('"type":"broadcast"');
    req.destroy();
  });
});
