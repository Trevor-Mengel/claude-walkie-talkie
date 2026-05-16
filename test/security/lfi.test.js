import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { createServer } from '../../src/daemon/server.js';
import request from 'supertest';

describe('security: LFI / path traversal on :id route params (H1)', () => {
  let project, app, decoyDir, decoyFile;
  beforeEach(() => {
    project = createTmpProject();
    app = createServer({ wtDir: project.wtDir }).app;
    // Plant a "decoy" history file the attacker would target if traversal worked.
    decoyDir = mkdtempSync(join(tmpdir(), 'walkie-lfi-'));
    decoyFile = join(decoyDir, 'secret.history.md');
    writeFileSync(decoyFile, '## Revision 1\nEdited at: 2026-05-15\nEdited by: attacker\n\nSECRET-CONTENT-LEAKED\n\n---\n');
  });
  afterEach(() => {
    cleanup(project);
    rmSync(decoyDir, { recursive: true, force: true });
  });

  test('rejects ..%2F path traversal on GET /channel/message/:id', async () => {
    // Use a relative-path traversal that would resolve to the planted decoy file.
    // Encode '..' segments as %2E%2E and '/' as %2F so Express decodes path-piece-style.
    // We don't actually need to chase the decoy; the test asserts the route rejects
    // before ever touching the file system. Use a stylized traversal pattern.
    const malicious = encodeURIComponent('../../../etc/hostname');
    const res = await request(app).get(`/channel/message/${malicious}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  test('rejects non-ULID strings on GET /channel/message/:id (e.g., spaces, dots)', async () => {
    const res = await request(app).get(`/channel/message/${encodeURIComponent('foo.bar')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  test('rejects ULIDs containing forbidden Crockford-base32 chars (I/L/O/U)', async () => {
    const fakeUlid = '01HXFAKEUUUUUUUUUUUUUUUUUU'; // contains U
    const res = await request(app).get(`/channel/message/${fakeUlid}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  test('legitimate well-formed ULID returns 404 (not 400) when message doesn\'t exist', async () => {
    const validUlidThatDoesNotExist = '01J7QXP9R5K8VYZAB3CDEFGHJK';
    const res = await request(app).get(`/channel/message/${validUlidThatDoesNotExist}`);
    expect(res.status).toBe(404);
  });

  test('PATCH /channel/message/:id rejects non-ULID id (defense in depth)', async () => {
    const res = await request(app).patch(`/channel/message/${encodeURIComponent('../../etc/passwd')}`).send({
      body: 'edited',
      editedBy: 'operator'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  test('POST /channel/message/:id/archive rejects non-ULID id (defense in depth)', async () => {
    const res = await request(app).post(`/channel/message/${encodeURIComponent('../etc/x')}/archive`).send({
      archivedBy: 'operator',
      reason: 'cleanup'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  test('GET /channel/since/:ulid rejects non-ULID values', async () => {
    const res = await request(app).get(`/channel/since/${encodeURIComponent('not-a-ulid')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid (id|ulid) format/i);
  });

  test('legitimate POST + GET round-trip still works', async () => {
    const post = await request(app).post('/channel/message').send({
      body: 'hi',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator'
    });
    expect(post.status).toBe(201);
    const get = await request(app).get(`/channel/message/${post.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.message.body.trim()).toBe('hi');
  });
});
