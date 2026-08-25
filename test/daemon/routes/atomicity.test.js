// A mutation and the audit row that records it must land together.
//
// Every mutating route on this surface used to do the effect first and the audit
// INSERT second, on the store handle rather than in the effect's transaction. If
// the INSERT throws, the route's error handler renders a 500 — so the client is
// told the operation FAILED while the capability is already revoked, the alias
// already moved, the cursor already advanced, and nothing anywhere records who
// did it. The same window is open to a plain crash between the two statements.
//
// The audit INSERT is made to fail with a BEFORE INSERT trigger that RAISEs.
// That is a real SQLite failure on the real table — no stubbing — and it stands
// in for the whole class: a full disk, a corrupt page, a locked table, a
// constraint nobody anticipated.
//
// `src/daemon/routes/channel.js` is deliberately absent. Its mutations are file
// writes through `src/core/channel.js`, which cannot join a SQL transaction; the
// limits of what that route can promise are documented at its `record` helper
// rather than pretended away here.

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { verifyCapability } from '../../../src/store/capabilities.js';
import { getPrincipal } from '../../../src/store/principals.js';
import { createFixture, cursorRows, mintActor, cleanupFixtures, NAMESPACE } from './helpers.js';

afterEach(cleanupFixtures);

/**
 * Makes every subsequent INSERT into `audit` fail.
 * @returns {() => void} disarms it, so the table can be read back
 */
function breakAudit(store) {
  store.db.exec(
    "CREATE TRIGGER audit_insert_fails BEFORE INSERT ON audit " +
      "BEGIN SELECT RAISE(ABORT, 'audit table is unavailable'); END"
  );
  return () => store.db.exec('DROP TRIGGER audit_insert_fails');
}

function auditRows(store, action) {
  return store.db
    .prepare('SELECT outcome, subject, detail FROM audit WHERE namespace = ? AND action = ?')
    .all(NAMESPACE, action);
}

describe('DELETE /capability/:id', () => {
  test('a revocation whose audit row cannot be written does not take effect', async () => {
    const fx = createFixture();
    const victim = mintActor(fx.store, { alias: 'victim' });
    const operator = mintActor(fx.store, { role: 'operator', alias: 'operator' });

    const disarm = breakAudit(fx.store);
    const res = await request(fx.app)
      .delete(`/capability/${victim.capabilityId}`)
      .set('Authorization', operator.bearer);
    disarm();

    // The client is told it failed...
    expect(res.status).toBe(500);
    // ...and it did. Without the shared transaction the capability would be dead
    // here while its holder had been told the revocation did not happen — and an
    // operator chasing the incident would find no row saying who killed it.
    expect(verifyCapability(fx.store, victim.token)).not.toBe(null);
    expect(auditRows(fx.store, 'capability.revoke')).toEqual([]);
  });

  test('a revocation with a working audit table records exactly one row', async () => {
    const fx = createFixture();
    const victim = mintActor(fx.store, { alias: 'victim' });
    const operator = mintActor(fx.store, { role: 'operator', alias: 'operator' });

    const res = await request(fx.app)
      .delete(`/capability/${victim.capabilityId}`)
      .set('Authorization', operator.bearer);

    expect(res.status).toBe(200);
    expect(verifyCapability(fx.store, victim.token)).toBe(null);
    const rows = auditRows(fx.store, 'capability.revoke');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('revoked');
    expect(rows[0].subject).toBe(victim.capabilityId);
  });
});

describe('POST /self/alias', () => {
  test('a rename whose audit row cannot be written does not take effect', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'before' });

    const disarm = breakAudit(fx.store);
    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias: 'after' });
    disarm();

    expect(res.status).toBe(500);
    // The alias the roster shows and the alias the audit log can account for are
    // the same alias: the one nobody changed.
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('before');
    expect(auditRows(fx.store, 'self.alias')).toEqual([]);
  });

  test('a rename with a working audit table records exactly one row', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'before' });

    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', actor.bearer)
      .send({ alias: 'after' });

    expect(res.status).toBe(200);
    expect(getPrincipal(fx.store, actor.principal.id).displayAlias).toBe('after');
    const rows = auditRows(fx.store, 'self.alias');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('allowed');
    expect(JSON.parse(rows[0].detail)).toEqual({ displayAlias: 'after' });
  });

  test('a refused rename still records its refusal, and changes nothing', async () => {
    // The denial row sits OUTSIDE the transaction on purpose: nothing changed, so
    // it has nothing to be atomic with, and a row written inside the failed
    // transaction would roll straight back out again.
    const fx = createFixture();
    mintActor(fx.store, { alias: 'incumbent' });
    const newcomer = mintActor(fx.store, { alias: 'newcomer' });

    const res = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', newcomer.bearer)
      .send({ alias: 'incumbent' });

    expect(res.status).toBe(409);
    expect(getPrincipal(fx.store, newcomer.principal.id).displayAlias).toBe('newcomer');
    const rows = auditRows(fx.store, 'self.alias');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(JSON.parse(rows[0].detail)).toEqual({ reason: 'conflict' });
  });
});

describe('POST /cursor/ack', () => {
  // A message id the cursor will accept: the route validates the shape, not
  // whether the message exists.
  const MESSAGE_ID = '01HXAAAAAAAAAAAAAAAAAAAAAA';

  test('a cursor move whose audit row cannot be written does not take effect', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'reader' });

    const disarm = breakAudit(fx.store);
    const res = await request(fx.app)
      .post('/cursor/ack')
      .set('Authorization', actor.bearer)
      .send({ id: MESSAGE_ID });
    disarm();

    expect(res.status).toBe(500);
    // The client is told the ack failed, so it will replay it. If the cursor had
    // moved anyway, that replay lands on a cursor already past the message and
    // reads as a no-op — the ack is silently lost.
    expect(cursorRows(fx.store, actor.principal.id)).toEqual([]);
    expect(auditRows(fx.store, 'cursor.ack')).toEqual([]);
  });

  test('a cursor move with a working audit table records exactly one row', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'reader' });

    const res = await request(fx.app)
      .post('/cursor/ack')
      .set('Authorization', actor.bearer)
      .send({ id: MESSAGE_ID });

    expect(res.status).toBe(200);
    expect(cursorRows(fx.store, actor.principal.id).map((r) => r.kind)).toEqual(['ack']);
    const rows = auditRows(fx.store, 'cursor.ack');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('allowed');
  });
});

describe('POST /delegate', () => {
  test('a delegation whose audit row cannot be written mints nothing', async () => {
    const fx = createFixture();
    const root = mintActor(fx.store, {
      role: 'root',
      alias: 'root',
      scopes: ['channel:read', 'enroll:delegate']
    });
    const before = fx.store.db
      .prepare('SELECT count(*) AS n FROM principal WHERE namespace = ?')
      .get(NAMESPACE).n;

    const disarm = breakAudit(fx.store);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', root.bearer)
      .send({ role: 'listener', scopes: ['channel:read'], ttlSeconds: 600 });
    disarm();

    expect(res.status).toBe(500);
    // No half-born identity: no principal row, no capability row, no audit row.
    expect(
      fx.store.db.prepare('SELECT count(*) AS n FROM principal WHERE namespace = ?').get(NAMESPACE)
        .n
    ).toBe(before);
    expect(auditRows(fx.store, 'capability.delegated')).toEqual([]);
  });
});
