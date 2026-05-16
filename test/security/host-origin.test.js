import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { createServer } from '../../src/daemon/server.js';
import request from 'supertest';

describe('security: Origin and Host header validation (L2+L3)', () => {
  let project, app;
  beforeEach(() => {
    project = createTmpProject();
    app = createServer({ wtDir: project.wtDir }).app;
  });
  afterEach(() => cleanup(project));

  test('rejects request with cross-origin Origin header (defangs DNS rebinding)', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  test('rejects request with non-localhost Host header', async () => {
    const res = await request(app).get('/health').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/host header/i);
  });

  test('rejects POST with cross-origin Origin (covers all routes via app-level middleware)', async () => {
    const res = await request(app)
      .post('/channel/message')
      .set('Origin', 'https://evil.example.com')
      .send({ body: 'hi', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });
    expect(res.status).toBe(403);
  });

  test('accepts request with no Origin header (server-to-server)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('accepts request with Origin: null (e.g., file:// or sandboxed iframe)', async () => {
    const res = await request(app).get('/health').set('Origin', 'null');
    expect(res.status).toBe(200);
  });

  test('accepts request with Host: 127.0.0.1', async () => {
    const res = await request(app).get('/health').set('Host', '127.0.0.1:12345');
    expect(res.status).toBe(200);
  });

  test('accepts request with Host: localhost', async () => {
    const res = await request(app).get('/health').set('Host', 'localhost:12345');
    expect(res.status).toBe(200);
  });
});
