import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('daemon server scaffold', () => {
  test('GET /health returns { ok: true } and the project root', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wtDir).toBe(project.wtDir);
  });

  test('returns 404 for unknown routes', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});
