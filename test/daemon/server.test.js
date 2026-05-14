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

describe('channel routes', () => {
  test('GET /channel/latest returns empty for fresh project', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/channel/latest?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  test('POST /channel/message creates a message and GET /channel/latest returns it', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({
        body: 'hello world',
        type: 'broadcast',
        fromSessionId: 'operator',
        fromAlias: 'Trevor',
        fromTool: 'operator'
      });
    expect(post.status).toBe(201);
    expect(post.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const list = await request(app).get('/channel/latest?limit=5');
    expect(list.body.messages.length).toBe(1);
    expect(list.body.messages[0].body.trim()).toBe('hello world');
  });

  test('GET /channel/message/:id returns the message with history', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({ body: 'first', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    const id = post.body.id;
    await request(app).patch(`/channel/message/${id}`).send({ body: 'second', editedBy: 'operator' });
    const get = await request(app).get(`/channel/message/${id}`);
    expect(get.body.message.revision).toBe(1);
    expect(get.body.history.length).toBe(1);
    expect(get.body.history[0].body).toBe('first');
  });

  test('POST /channel/message/:id/archive archives', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({ body: 'kill me', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    const id = post.body.id;
    const arch = await request(app)
      .post(`/channel/message/${id}/archive`)
      .send({ archivedBy: 'operator', reason: 'duplicate' });
    expect(arch.status).toBe(200);
    const list = await request(app).get('/channel/latest?limit=5');
    expect(list.body.messages.length).toBe(0);
    const listAll = await request(app).get('/channel/latest?limit=5&include_archived=true');
    expect(listAll.body.messages.length).toBe(1);
  });

  test('GET /channel/since/:ulid returns only newer messages', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const a = await request(app).post('/channel/message').send({
      body: 'a',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator'
    });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post('/channel/message').send({
      body: 'b',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator'
    });
    const res = await request(app).get(`/channel/since/${a.body.id}`);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].body.trim()).toBe('b');
  });
});

describe('sessions routes', () => {
  test('GET /sessions returns active, recent, invitations', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.active).toEqual([]);
    expect(res.body.recent).toEqual([]);
    expect(res.body.invitations).toEqual([]);
  });

  test('POST /sessions/join creates a session with generated alias', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).post('/sessions/join').send({ tool: 'claude-code' });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('claude-code-1');
  });

  test('POST /sessions/:id/rename renames + fulfills matching invitation', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const join = await request(app).post('/sessions/join').send({ tool: 'codex' });
    await request(app).post('/sessions/invite').send({ alias: 'codex-helper' });
    const renamed = await request(app)
      .post(`/sessions/${join.body.sessionId}/rename`)
      .send({ alias: 'codex-helper' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.alias).toBe('codex-helper');
    expect(renamed.body.fulfilled).toBe(true);
    const after = await request(app).get('/sessions');
    expect(after.body.invitations).toEqual([]);
  });
});
