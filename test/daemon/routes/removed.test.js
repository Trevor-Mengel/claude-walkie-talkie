import { createServer, get } from 'node:http';
import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { SCHEMA_VERSION } from '../../../src/store/db.js';
import { createFixture, mintActor, mountedRoutes, cursorRows, cleanupFixtures } from './helpers.js';

afterEach(cleanupFixtures);

/**
 * Every route v0.2 exposed that v0.3 removes, with the method it answered on.
 * These are not deprecated — they are absent, so they fall through to the
 * terminal 404 handler.
 */
const REMOVED = [
  ['get', '/permits'],
  ['post', '/permits'],
  ['delete', '/permits/cs_someone'],
  ['post', '/sessions/join'],
  ['post', '/sessions/cs_someone/rename'],
  ['post', '/sessions/invite'],
  ['get', '/sessions'],
  ['get', '/sessions/cs_someone/inbox']
];

describe('the removed routes are gone', () => {
  test('each fails: 401 unauthenticated, 404 with a capability', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { role: 'operator', alias: 'operator' });

    for (const [method, path] of REMOVED) {
      // Authentication is mounted above routing, so an unauthenticated caller
      // never learns whether a path exists — every removed route answers with
      // the same 401 as a live one.
      const unauth = await request(fx.app)[method](path).send({});
      expect(unauth.status, `${method} ${path} unauthenticated`).toBe(401);
      expect(unauth.body.error.code).toBe('unauthenticated');

      const auth = await request(fx.app)[method](path).set('Authorization', actor.bearer).send({});
      expect(auth.status, `${method} ${path} authenticated`).toBe(404);
      expect(auth.body.error.code).toBe('not_found');
    }
  });

  test('none of them are mounted at all', () => {
    const fx = createFixture();
    const routes = mountedRoutes(fx.app);
    for (const route of routes) {
      expect(route).not.toContain('/permits');
      expect(route).not.toContain('/sessions');
    }
    // The complete v0.3 inventory, so a route added by accident fails here.
    expect(routes).toEqual([
      'DELETE /capability/:id',
      'GET /channel/latest',
      'GET /channel/message/:id',
      'GET /channel/since/:ulid',
      'GET /events',
      'GET /health',
      'GET /inbox',
      'GET /principals',
      'GET /self',
      'PATCH /channel/message/:id',
      'POST /channel/message',
      'POST /channel/message/:id/archive',
      'POST /cursor/ack',
      'POST /cursor/read',
      'POST /delegate',
      'POST /enroll/exchange',
      'POST /self/alias'
    ]);
  });

  test('they cannot mutate anything', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { role: 'operator', alias: 'operator' });
    const before = readFileSync(fx.channelPath, 'utf8');

    // The v0.2 shapes, complete with the authority fields they used to carry.
    await request(fx.app)
      .post('/sessions/join')
      .send({ sessionId: 'cs_attacker', alias: 'attacker', tool: 'claude-code' });
    await request(fx.app)
      .post('/permits')
      .set('Authorization', actor.bearer)
      .send({ sessionId: 'cs_attacker', duration: 'always' });
    await request(fx.app)
      .get('/sessions/cs_attacker/inbox')
      .set('Authorization', actor.bearer);

    expect(readFileSync(fx.channelPath, 'utf8')).toBe(before);
    expect(fx.store.db.prepare('SELECT COUNT(*) c FROM principal').get().c).toBe(1);
    expect(fx.store.db.prepare('SELECT COUNT(*) c FROM permit').get().c).toBe(0);
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([]);
  });
});

describe('GET /health', () => {
  test('is unauthenticated and discloses no filesystem path', async () => {
    const fx = createFixture();
    const res = await request(fx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      namespace: fx.namespace,
      mode: fx.config.mode,
      schemaVersion: SCHEMA_VERSION
    });

    // v0.2 answered with `wtDir`, handing over the project path.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('/');
    expect(serialized).not.toContain(fx.root);
    expect(serialized).not.toContain('wtDir');
    expect(serialized).not.toContain('.walkie-talkie');
  });
});

describe('GET /events', () => {
  test('requires channel:read', async () => {
    const fx = createFixture();
    const publisher = mintActor(fx.store, { scopes: ['channel:publish'] });
    const res = await request(fx.app).get('/events').set('Authorization', publisher.bearer);
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('channel:read');
  });

  test('is 401 without a token — v0.2 streamed to anyone', async () => {
    const fx = createFixture();
    const res = await request(fx.app).get('/events');
    expect(res.status).toBe(401);
  });

  test('streams a posted message to an authorised subscriber', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });

    // SSE never ends, so supertest's buffered client cannot drive it. Bind the
    // real app to an ephemeral loopback port and read one frame off the wire.
    const server = createServer(fx.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const frame = await new Promise((resolve, reject) => {
        const req = get(
          {
            host: '127.0.0.1',
            port,
            path: '/events',
            headers: { authorization: reader.bearer }
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`expected 200, got ${res.statusCode}`));
              return;
            }
            let buffered = '';
            res.on('data', (chunk) => {
              buffered += chunk.toString();
              // An SSE frame is `event:` then `data:` then a blank line; the
              // two lines arrive as separate writes, so wait for the terminator.
              if (buffered.includes('message.posted') && buffered.includes('data: ')) {
                req.destroy();
                resolve(buffered);
              }
            });
          }
        );
        req.on('error', (err) => {
          // `destroy()` above surfaces as ECONNRESET once we already have the frame.
          if (err.code !== 'ECONNRESET') reject(err);
        });

        // Post only once the subscriber has registered its emitter listeners.
        setTimeout(async () => {
          const post = await request(fx.app)
            .post('/channel/message')
            .set('Authorization', writer.bearer)
            .send({ body: 'streamed' });
          if (post.status !== 201) reject(new Error(`post failed: ${post.status}`));
        }, 50);
      });

      expect(frame).toContain('event: message.posted');
      expect(frame).toContain(`"from":"${writer.principal.id}"`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
