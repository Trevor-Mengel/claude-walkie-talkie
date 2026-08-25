import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { listAudit } from '../../../src/store/audit.js';
import {
  createFixture,
  mintActor,
  cursorRows,
  mountedRoutes,
  cleanupFixtures
} from './helpers.js';

afterEach(cleanupFixtures);

// A cursor position is a message id, so these are ids — ascending, and spelled out rather
// than minted, because the property under test is the ORDER the store compares them in.
const A = '01J000000000000000000000AA';
const B = '01J000000000000000000000BB';
const C = '01J000000000000000000000CC';

function ack(app, actor, id, includeMemoryUpdates) {
  const payload = { id };
  if (includeMemoryUpdates !== undefined) {
    payload.include_memory_updates = includeMemoryUpdates;
  }
  return request(app).post('/cursor/ack').set('Authorization', actor.bearer).send(payload);
}

function read(app, actor, id, includeMemoryUpdates) {
  const payload = { id };
  if (includeMemoryUpdates !== undefined) {
    payload.include_memory_updates = includeMemoryUpdates;
  }
  return request(app).post('/cursor/read').set('Authorization', actor.bearer).send(payload);
}

describe('cursor writes are monotonic', () => {
  test('ack advances, then a lower and an equal id are both no-ops', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);

    // The default view's mark, and the memory-inclusive view's, which this never touches.
    const up = await ack(fx.app, actor, B);
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ id: B, cursors: { default: B, withMemoryUpdates: '' } });

    const lower = await ack(fx.app, actor, A);
    expect(lower.status).toBe(200);
    expect(lower.body.id).toBe(B);

    const equal = await ack(fx.app, actor, B);
    expect(equal.status).toBe(200);
    expect(equal.body.id).toBe(B);

    const higher = await ack(fx.app, actor, C);
    expect(higher.body).toEqual({ id: C, cursors: { default: C, withMemoryUpdates: '' } });
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([
      { kind: 'ack', last_message_id: C, updated_at: expect.any(String) }
    ]);
  });

  test('read and ack are independent cursors', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    await read(fx.app, actor, C);
    await ack(fx.app, actor, A);
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([
      { kind: 'ack', last_message_id: A, updated_at: expect.any(String) },
      { kind: 'read', last_message_id: C, updated_at: expect.any(String) }
    ]);
  });

  test('a no-op is audited as a no-op, not as an advance', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    await ack(fx.app, actor, B);
    await ack(fx.app, actor, A);
    const rows = listAudit(fx.store, { action: 'cursor.ack' });
    // listAudit is newest-first.
    expect(rows.map((r) => r.outcome)).toEqual(['noop', 'allowed']);
    expect(rows[0].detail).toEqual({ requested: A, id: B });
    expect(rows[0].subject).toBe(actor.principal.id);
  });

  // A cursor write has to name which `/inbox` view was read, because a high-water mark is
  // sound only over the set it was recorded against. Without this, one mark governed both
  // the default view and the memory-inclusive one, and acking a later broadcast in the
  // default view put an undelivered memory-update permanently below the cutoff.
  test('the flag decides which view is acked: absent moves one mark, true moves both', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);

    // Absent, and explicitly false, both mean "the default view" — one row only.
    await ack(fx.app, actor, A);
    await ack(fx.app, actor, B, false);
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([
      { kind: 'ack', last_message_id: B, updated_at: expect.any(String) }
    ]);

    // True means the reader saw the inclusive view, which is a SUPERSET of the default
    // one, so both marks are evidenced and both move.
    const both = await ack(fx.app, actor, C, true);
    expect(both.body).toEqual({ id: C, cursors: { default: C, withMemoryUpdates: C } });
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([
      { kind: 'ack', last_message_id: C, updated_at: expect.any(String) },
      { kind: 'ack_with_memory', last_message_id: C, updated_at: expect.any(String) }
    ]);
  });

  test('the read cursor carries the same flag, and read/ack stay separate per view', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    const res = await read(fx.app, actor, C, true);
    expect(res.body).toEqual({ id: C, cursors: { default: C, withMemoryUpdates: C } });
    await ack(fx.app, actor, A);
    // Four kinds are reachable and none of them is the same row as any other.
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([
      { kind: 'ack', last_message_id: A, updated_at: expect.any(String) },
      { kind: 'read', last_message_id: C, updated_at: expect.any(String) },
      { kind: 'read_with_memory', last_message_id: C, updated_at: expect.any(String) }
    ]);
  });

  test('a non-boolean flag is rejected rather than coerced', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    // 'true' is the dangerous one: a truthy string would silently widen a cursor write to
    // the other view, which is the mistake the flag exists to prevent.
    for (const raw of ['true', 'false', 1, 0, null, 'yes', {}]) {
      const res = await ack(fx.app, actor, A, raw);
      expect(res.status, `flag ${JSON.stringify(raw)}`).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([]);
  });

  test('the audit row names the view only when it is not the default one', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    await ack(fx.app, actor, A);
    await ack(fx.app, actor, B, true);
    const rows = listAudit(fx.store, { action: 'cursor.ack' });
    // listAudit is newest-first. The ordinary ack's row shape is unchanged.
    expect(rows[1].detail).toEqual({ requested: A, id: A });
    expect(rows[0].detail).toEqual({ requested: B, id: B, includeMemoryUpdates: true });
    expect(rows.map((r) => r.outcome)).toEqual(['allowed', 'allowed']);
  });

  // Both marks in ONE transaction. A client told "failed" must never find one of them
  // already advanced: it would replay its ack against a cursor that has moved past it.
  test('a failed audit write leaves neither mark advanced', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    fx.store.db.exec('DROP TABLE audit');
    const res = await ack(fx.app, actor, C, true);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([]);
  });

  // Ordinals are exactly what a cursor must never be: `2` used to mean "the second message
  // that currently parses", which moved whenever an older message stopped parsing.
  test('anything that is not a message id is rejected, ordinals included', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    const rejected = [
      2,
      -1,
      1.5,
      '3',
      null,
      undefined,
      '',
      A.toLowerCase(),
      `${A}X`,
      A.slice(0, 25),
      '01J000000000000000000000AI'
    ];
    for (const id of rejected) {
      const res = await ack(fx.app, actor, id);
      expect(res.status, `ack ${String(id)}`).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([]);
  });
});

describe('a cursor belongs to exactly one principal', () => {
  test('one principal ack does not move another', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, { alias: 'a' });
    const b = mintActor(fx.store, { alias: 'b' });
    await ack(fx.app, a, C);
    expect(cursorRows(fx.store, a.principal.id).map((r) => r.last_message_id)).toEqual([C]);
    expect(cursorRows(fx.store, b.principal.id)).toEqual([]);
  });

  test('no mounted route can address another principal cursor', () => {
    const fx = createFixture();
    const routes = mountedRoutes(fx.app);
    const cursorPaths = routes.filter((r) => r.includes('/cursor'));
    // Exactly two, and neither carries a parameter naming whose cursor to move.
    expect(cursorPaths).toEqual(['POST /cursor/ack', 'POST /cursor/read']);
    for (const route of cursorPaths) expect(route).not.toContain(':');
  });

  test('an extra body field claiming a principal is rejected', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, { alias: 'a' });
    const b = mintActor(fx.store, { alias: 'b' });
    const res = await request(fx.app)
      .post('/cursor/ack')
      .set('Authorization', a.bearer)
      .send({ id: A, principalId: b.principal.id });
    expect(res.status).toBe(400);
    expect(cursorRows(fx.store, b.principal.id)).toEqual([]);
  });
});

describe('cursor scopes', () => {
  test('/cursor/read requires self:cursor', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { scopes: ['channel:read', 'channel:ack'] });
    const res = await read(fx.app, actor, A);
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('self:cursor');
  });

  test('/cursor/ack requires channel:ack', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { scopes: ['channel:read', 'self:cursor'] });
    const res = await ack(fx.app, actor, A);
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('channel:ack');
  });

  test('both are 401 without a token', async () => {
    const fx = createFixture();
    for (const path of ['/cursor/read', '/cursor/ack']) {
      const res = await request(fx.app).post(path).send({ id: A });
      expect(res.status).toBe(401);
    }
  });
});
