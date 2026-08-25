import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { getPrincipal } from '../../../src/store/principals.js';
import { listAudit } from '../../../src/store/audit.js';
import { resolveRosterMentions } from '../../../src/daemon/routes/support.js';
import { createFixture, mintActor, cleanupFixtures } from './helpers.js';

afterEach(cleanupFixtures);

describe('GET /principals', () => {
  test('returns the roster with no credential material', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, { alias: 'alpha', role: 'root', paseoAgentId: 'paseo-agent-1' });
    const b = mintActor(fx.store, { alias: 'beta', role: 'listener' });

    const res = await request(fx.app).get('/principals').set('Authorization', a.bearer);
    expect(res.status).toBe(200);
    expect(res.body.principals.length).toBe(2);
    for (const p of res.body.principals) {
      expect(Object.keys(p).sort()).toEqual(['createdAt', 'displayAlias', 'id', 'role']);
    }
    expect(res.body.principals.map((p) => p.displayAlias)).toEqual(['alpha', 'beta']);
    expect(res.body.principals.map((p) => p.id)).toEqual([a.principal.id, b.principal.id]);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('paseo-agent-1');
    expect(serialized).not.toContain(a.token);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('sha256');
  });

  test('requires channel:read and a token', async () => {
    const fx = createFixture();
    const publisher = mintActor(fx.store, { scopes: ['channel:publish'] });
    const scoped = await request(fx.app).get('/principals').set('Authorization', publisher.bearer);
    expect(scoped.status).toBe(403);
    expect(scoped.body.error.detail.scope).toBe('channel:read');

    const unauth = await request(fx.app).get('/principals');
    expect(unauth.status).toBe(401);
  });
});

describe('GET /self', () => {
  test('describes the caller, and two capabilities get two answers', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, {
      alias: 'alpha',
      role: 'goal_hub',
      scopes: ['channel:read', 'channel:publish'],
      paseoAgentId: 'paseo-agent-1'
    });
    const b = mintActor(fx.store, {
      alias: 'beta',
      role: 'listener',
      scopes: ['channel:read', 'listener:consume']
    });

    const first = await request(fx.app).get('/self').set('Authorization', a.bearer);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      principalId: a.principal.id,
      role: 'goal_hub',
      displayAlias: 'alpha',
      tool: 'omp',
      scopes: ['channel:publish', 'channel:read'],
      capabilityId: a.capabilityId,
      expiresAt: expect.any(String)
    });

    const second = await request(fx.app).get('/self').set('Authorization', b.bearer);
    expect(second.body.principalId).toBe(b.principal.id);
    expect(second.body.role).toBe('listener');
    expect(second.body.capabilityId).toBe(b.capabilityId);
    expect(second.body.scopes).toEqual(['channel:read', 'listener:consume']);
    expect(second.body.principalId).not.toBe(first.body.principalId);
  });

  test('expiresAt comes from the capability record', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { ttlSeconds: 120 });
    const res = await request(fx.app).get('/self').set('Authorization', actor.bearer);
    const row = fx.store.db
      .prepare('SELECT expires_at FROM capability WHERE id = ?')
      .get(actor.capabilityId);
    expect(res.body.expiresAt).toBe(row.expires_at);
  });

  test('needs no scope beyond authentication', async () => {
    const fx = createFixture();
    // The narrowest possible grant: a scope this route does not consult.
    const actor = mintActor(fx.store, { scopes: ['self:cursor'] });
    const res = await request(fx.app).get('/self').set('Authorization', actor.bearer);
    expect(res.status).toBe(200);
    expect(res.body.scopes).toEqual(['self:cursor']);
  });

  test('401s unauthenticated', async () => {
    const fx = createFixture();
    const none = await request(fx.app).get('/self');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('unauthenticated');

    const bogus = await request(fx.app).get('/self').set('Authorization', 'Bearer nope');
    expect(bogus.status).toBe(401);
  });

  test('leaks no token, hash or paseoAgentId', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'alpha', paseoAgentId: 'paseo-agent-secret' });
    const res = await request(fx.app).get('/self').set('Authorization', actor.bearer);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(actor.token);
    expect(serialized).not.toContain('paseo-agent-secret');
    expect(serialized).not.toContain('paseoAgentId');
    expect(serialized).not.toContain('tokenSha256');
    expect(Object.keys(res.body).sort()).toEqual([
      'capabilityId',
      'displayAlias',
      'expiresAt',
      'principalId',
      'role',
      'scopes',
      'tool'
    ]);
  });
});

describe('POST /self/alias', () => {
  test('renames the caller only', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'before' });
    const other = mintActor(fx.store, { alias: 'untouched' });

    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias: 'after' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: actor.principal.id, displayAlias: 'after' });
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('after');
    expect(getPrincipal(fx.store, other.principal.id).displayAlias).toBe('untouched');
  });

  test('a collision is 409 and the incumbent keeps its alias', async () => {
    const fx = createFixture();
    const incumbent = mintActor(fx.store, { alias: 'taken' });
    const newcomer = mintActor(fx.store, { alias: 'newcomer' });

    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', newcomer.bearer)
      .send({ alias: 'taken' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');

    expect(getPrincipal(fx.store, incumbent.principal.id).displayAlias).toBe('taken');
    expect(getPrincipal(fx.store, newcomer.principal.id).displayAlias).toBe('newcomer');

    // Read back the PERSISTED row, not the object handed to `audit`: `redactDetail`
    // rewrites secret-bearing keys to '[redacted]', so a detail keyed `code` would
    // arrive hollowed out rather than carrying the refusal reason.
    const rows = listAudit(fx.store, { action: 'self.alias' });
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].actorPrincipalId).toBe(newcomer.principal.id);
    expect(rows[0].detail).toEqual({ reason: 'conflict' });
  });

  test('an invalid alias is rejected', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'ok' });
    for (const alias of ['', '   ', 'has space', 'x'.repeat(65), '@nope', 42, null]) {
      const res = await request(fx.app)
        .post('/self/alias')
        .set('Authorization', actor.bearer)
        .send({ alias });
      expect(res.status, `alias ${String(alias)}`).toBe(400);
    }
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('ok');
  });

  test('there is no route naming whose alias to change', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, { alias: 'a' });
    const b = mintActor(fx.store, { alias: 'b' });
    // v0.2's `POST /sessions/:id/rename`.
    const res = await request(fx.app)
      .post(`/sessions/${b.principal.id}/rename`)
      .set('Authorization', a.bearer)
      .send({ alias: 'stolen' });
    expect(res.status).toBe(404);
    expect(getPrincipal(fx.store, b.principal.id).displayAlias).toBe('b');
  });

  test('requires self:alias', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'ok', scopes: ['channel:read'] });
    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('self:alias');
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('ok');
  });

  test('a successful rename is audited', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'first' });
    await request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias: 'second' });
    const rows = listAudit(fx.store, { action: 'self.alias' });
    expect(rows[0].outcome).toBe('allowed');
    expect(rows[0].detail).toEqual({ displayAlias: 'second' });
    expect(rows[0].subject).toBe(actor.principal.id);
  });
});

/**
 * F2/F3 regressions, driven end to end: an alias is only worth anything if the
 * grammar that admits it is the grammar the mention resolver reads back.
 */
describe('an alias cannot capture another principal traffic', () => {
  async function rename(fx, actor, alias) {
    return request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias });
  }

  test('claiming the prefix of a dotted alias captures nothing', async () => {
    const fx = createFixture();
    const incumbent = mintActor(fx.store, { alias: 'ops.hub' });
    const attacker = mintActor(fx.store, { alias: null });

    // `ops` is a legal alias in its own right, and taking it is allowed — what
    // must not follow is receiving mail addressed to `ops.hub`.
    expect((await rename(fx, attacker, 'ops')).status).toBe(200);

    for (const body of ['heads up @ops.hub', 'ping @ops.hub.', 'see @ops.hub, please']) {
      const out = resolveRosterMentions(fx.store, body);
      expect(out.mentions, body).toEqual([incumbent.principal.id]);
      expect(out.unresolved, body).toEqual([]);
    }

    // The shorter alias still works for its own name, and only for it.
    expect(resolveRosterMentions(fx.store, 'hi @ops').mentions).toEqual([
      attacker.principal.id
    ]);
  });

  test('an alias nobody holds is reported as unresolved rather than delivered nearby', () => {
    const fx = createFixture();
    mintActor(fx.store, { alias: 'ops' });

    const out = resolveRosterMentions(fx.store, 'ping @ops.hub and @nobody');
    expect(out.mentions).toEqual([]);
    expect(out.unresolved).toEqual(['ops.hub', 'nobody']);
  });

  test('mint and rename enforce the same grammar', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'ok' });

    // Accepted by v0.3's store-side grammar, rejected by `isValidAlias`. Both
    // paths have to agree, or whichever is looser is the one that matters.
    for (const alias of ['trailing.', 'trailing-', 'trailing_', 'has space', 'x'.repeat(65)]) {
      expect(() => mintActor(fx.store, { alias }), alias).toThrowError(/display alias/);
      expect((await rename(fx, actor, alias)).status, alias).toBe(400);
    }
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('ok');

    // And both accept the same legal shapes.
    expect(mintActor(fx.store, { alias: 'ops.hub' }).principal.displayAlias).toBe('ops.hub');
    expect((await rename(fx, actor, 'ops.desk')).status).toBe(200);
  });

  test('a case variant is refused, and the incumbent keeps receiving its mentions', async () => {
    const fx = createFixture();
    const incumbent = mintActor(fx.store, { alias: 'alice' });
    const squatter = mintActor(fx.store, { alias: 'zed' });

    for (const variant of ['Alice', 'ALICE', 'aLiCe']) {
      const res = await rename(fx, squatter, variant);
      expect(res.status, variant).toBe(409);
      expect(res.body.error.code, variant).toBe('conflict');
    }
    expect(getPrincipal(fx.store, incumbent.principal.id).displayAlias).toBe('alice');
    expect(getPrincipal(fx.store, squatter.principal.id).displayAlias).toBe('zed');

    const out = resolveRosterMentions(fx.store, 'morning @alice');
    expect(out.mentions).toEqual([incumbent.principal.id]);
    expect(out.unresolved).toEqual([]);
  });
});
