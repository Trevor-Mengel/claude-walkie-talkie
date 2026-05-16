import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('permits', () => {
  test('autonomous post without permit returns 403 with structured guidance', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    const res = await request(app).post('/channel/message').send({
      body: 'auto hi',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('permit_required');
    expect(res.body.session_id).toBe('cs_abc');
  });

  test('operator post (autonomous=false) is always allowed', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).post('/channel/message').send({
      body: 'manual hi',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    expect(res.status).toBe(201);
  });

  test('once permit allows exactly one autonomous post', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'once' });
    const ok = await request(app).post('/channel/message').send({
      body: 'one',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(ok.status).toBe(201);
    const blocked = await request(app).post('/channel/message').send({
      body: 'two',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(blocked.status).toBe(403);
  });

  test('always permit allows unlimited autonomous posts', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'always' });
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/channel/message').send({
        body: `auto ${i}`,
        type: 'broadcast',
        fromSessionId: 'cs_abc',
        fromAlias: 'claude-code-1',
        fromTool: 'claude-code',
        autonomous: true
      });
      expect(r.status).toBe(201);
    }
  });

  test('DELETE /permits/:sessionId revokes', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'always' });
    await request(app).delete('/permits/cs_abc');
    const list = await request(app).get('/permits');
    expect(list.body.permits).toEqual([]);
  });
});
