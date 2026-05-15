import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { createServer } from '../../src/daemon/server.js';
import request from 'supertest';

describe('GET /sessions/:id/inbox', () => {
  let project;
  let app;

  beforeEach(async () => {
    project = createTmpProject();
    const srv = createServer({ wtDir: project.wtDir });
    app = srv.app;
    const join = await request(app).post('/sessions/join').send({ tool: 'claude-code' });
    project.sessionId = join.body.sessionId;
  });

  afterEach(() => cleanup(project));

  test('returns empty when there are no messages', async () => {
    const res = await request(app).get(`/sessions/${project.sessionId}/inbox`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.mentionedForMe).toEqual([]);
  });

  test('returns new messages then marks them as read', async () => {
    await request(app).post('/channel/message').send({
      body: 'hello',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    const first = await request(app).get(`/sessions/${project.sessionId}/inbox`);
    expect(first.body.messages.length).toBe(1);
    const second = await request(app).get(`/sessions/${project.sessionId}/inbox`);
    expect(second.body.messages.length).toBe(0);
  });

  test('flags messages mentioning this session in mentionedForMe', async () => {
    const sess = (await request(app).get('/sessions')).body.active[0];
    await request(app).post(`/sessions/${sess.sessionId}/rename`).send({ alias: 'demo-builder' });
    await request(app).post('/channel/message').send({
      body: '@demo-builder ping',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    const inbox = await request(app).get(`/sessions/${sess.sessionId}/inbox`);
    expect(inbox.body.mentionedForMe.length).toBe(1);
    expect(inbox.body.mentionedForMe[0].body.trim()).toBe('@demo-builder ping');
  });

  test('excludes memory-update messages by default', async () => {
    await request(app).post('/channel/message').send({
      body: 'normal',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    await request(app).post('/channel/message').send({
      body: 'memory entry',
      type: 'memory-update',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    const inbox = await request(app).get(`/sessions/${project.sessionId}/inbox`);
    expect(inbox.body.messages.length).toBe(1);
    expect(inbox.body.messages[0].body.trim()).toBe('normal');
  });

  test('include_memory_updates=true returns memory entries too', async () => {
    await request(app).post('/channel/message').send({
      body: 'memory entry',
      type: 'memory-update',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    const inbox = await request(app)
      .get(`/sessions/${project.sessionId}/inbox?include_memory_updates=true`);
    expect(inbox.body.messages.length).toBe(1);
  });
});
