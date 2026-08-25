import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { EXCHANGE_ACTION, handleEnrollRequest } from '../../../src/authority/enroll.js';
import { ROLE_SCOPES } from '../../../src/authority/policy.js';
import { getCapability, verifyCapability } from '../../../src/store/capabilities.js';
import { listAudit } from '../../../src/store/audit.js';
import { createEnrollmentCode, recordApproval } from '../../../src/store/approvals.js';
import { sha256 } from '../../../src/store/digest.js';
import { createFixture, mintActor, cleanupFixtures, NAMESPACE } from './helpers.js';

/**
 * Audit rows exactly as they sit on disk. `listAudit` parses `detail` back into
 * an object, which is the wrong lens for asserting that a credential is absent
 * from the persisted text.
 */
function rawAudit(fx, action) {
  return fx.store.db
    .prepare(
      'SELECT action, outcome, subject, actor_principal_id, detail FROM audit ' +
        'WHERE namespace = ? AND action = ? ORDER BY id'
    )
    .all(NAMESPACE, action);
}

/** Principal rows in this namespace — used to prove a refusal wrote none. */
function countPrincipals(fx) {
  return fx.store.db
    .prepare('SELECT count(*) AS n FROM principal WHERE namespace = ?')
    .get(NAMESPACE).n;
}

afterEach(cleanupFixtures);

/** An operator-approved enrolment code, minted the way the authority socket does. */
function approvedCode(fx, { role = 'root', scopes, ttlSeconds = 3600 } = {}) {
  return handleEnrollRequest(
    fx.store,
    {
      namespace: NAMESPACE,
      role,
      scopes: scopes ?? ['channel:read', 'channel:publish', 'self:alias', 'enroll:delegate'],
      ttlSeconds
    },
    { config: { namespace: NAMESPACE } }
  );
}

describe('POST /enroll/exchange', () => {
  test('redeems a code for a working capability without presenting one', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);

    const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'capabilityId',
      'expiresAt',
      'principalId',
      'role',
      'scopes',
      'token'
    ]);
    expect(res.body.role).toBe('root');
    expect(res.body.scopes).toContain('channel:publish');

    // The token works immediately, and nothing but this response ever held it.
    const resolved = verifyCapability(fx.store, res.body.token);
    expect(resolved.principal.id).toBe(res.body.principalId);
    const whoami = await request(fx.app)
      .get('/self')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(whoami.status).toBe(200);
    expect(whoami.body.principalId).toBe(res.body.principalId);
  });

  test('a code is one-use; replay is refused opaquely', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);
    const first = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(first.status).toBe(201);

    const replay = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('permit_invalid');
    // Unknown and replayed codes answer identically.
    const unknown = await request(fx.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: 'never-issued' });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.message).toBe(replay.body.error.message);
  });

  test('a missing or non-string code is refused, never crashed', async () => {
    const fx = createFixture();
    for (const enrollmentCode of [undefined, null, '', 42]) {
      const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode });
      expect(res.status, `code ${String(enrollmentCode)}`).toBe(403);
    }
  });

  test('extra body fields are rejected', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);
    const res = await request(fx.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: code, role: 'operator' });
    expect(res.status).toBe(400);
    expect(res.body.error.detail.fields).toEqual(['role']);
  });

  test('no audit row records the code or the token', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);
    const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    const serialized = JSON.stringify(listAudit(fx.store, { limit: 50 }));
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(res.body.token);
  });

  // E2c. This is the only unauthenticated route on the surface, and until now it
  // was the only authority decision that recorded nothing when it said no: an
  // operator investigating a leaked enrolment code could not tell from the store
  // whether anyone had tried to redeem it. Every row below is read straight out
  // of SQLite rather than through `listAudit`, so the assertion is about what was
  // persisted, including the raw `detail` text.
  test('a replayed code leaves a denial row behind, without the code in it', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);
    expect(
      (await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code })).status
    ).toBe(201);
    // A success is recorded as capability.issued inside the issuing transaction,
    // so nothing has claimed this action yet.
    expect(rawAudit(fx, EXCHANGE_ACTION)).toEqual([]);

    const replay = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(replay.status).toBe(403);

    const rows = rawAudit(fx, EXCHANGE_ACTION);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(JSON.parse(rows[0].detail)).toEqual({ reason: 'permit_invalid' });
    // The presented code is a credential; it must not be durable anywhere.
    expect(rows[0].detail).not.toContain(code);
    expect(JSON.stringify(rows[0])).not.toContain(code);
  });

  test('a code that never existed is denied on the record too', async () => {
    const fx = createFixture();
    const forged = 'forged-enrollment-code-0000';
    const res = await request(fx.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: forged });
    expect(res.status).toBe(403);

    const rows = rawAudit(fx, EXCHANGE_ACTION);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(JSON.parse(rows[0].detail)).toEqual({ reason: 'permit_invalid' });
    expect(rows[0].detail).not.toContain(forged);
  });

  test('a code whose approval recorded no grant is denied on the record', async () => {
    // A different throw site: this one fires deep inside the transaction, after
    // the code and the approval have already been burned. The burn rolls back
    // with the refusal, and the denial row still has to survive it.
    const fx = createFixture();
    const code = fx.store.tx((tx) => {
      const approval = recordApproval(tx, {
        kind: 'enrollment',
        subjectDigest: sha256('enroll:no-grant'),
        approvingPrincipal: 'operator',
        attestationKind: 'omp_hook_confirm'
      });
      return createEnrollmentCode(tx, { approvalId: approval.id, ttlSeconds: 300 }).code;
    });

    const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(res.status).toBe(403);

    const rows = rawAudit(fx, EXCHANGE_ACTION);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(JSON.parse(rows[0].detail)).toEqual({ reason: 'permit_invalid' });
    expect(rows[0].detail).not.toContain(code);
  });

  test('a malformed code is denied on the record', async () => {
    const fx = createFixture();
    for (const enrollmentCode of [undefined, null, '', 42]) {
      const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode });
      expect(res.status, `code ${String(enrollmentCode)}`).toBe(403);
    }
    const rows = rawAudit(fx, EXCHANGE_ACTION);
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.outcome)).toEqual(['denied', 'denied', 'denied', 'denied']);
  });
});

describe('POST /delegate', () => {
  async function rootActor(fx) {
    const { code } = approvedCode(fx);
    const res = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    expect(res.status).toBe(201);
    return { ...res.body, bearer: `Bearer ${res.body.token}` };
  }

  test('root mints a narrower capability for a new principal', async () => {
    const fx = createFixture();
    const root = await rootActor(fx);

    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', root.bearer)
      .send({ role: 'goal_hub', scopes: ['channel:read', 'channel:publish'], ttlSeconds: 600 });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('goal_hub');
    expect(res.body.scopes).toEqual(['channel:publish', 'channel:read']);
    expect(res.body.principalId).not.toBe(root.principalId);

    const child = getCapability(fx.store, res.body.capabilityId);
    expect(child.parentCapabilityId).toBe(root.capabilityId);
    expect(child.attestationKind).toBe('delegation');
    expect(child.expiresAt <= root.expiresAt).toBe(true);

    const whoami = await request(fx.app)
      .get('/self')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(whoami.body.role).toBe('goal_hub');

    // Persisted detail, read back out of the database: none of these keys or
    // values may be eaten by `redactDetail`.
    const rows = listAudit(fx.store, { action: 'capability.delegated' });
    expect(rows.length).toBe(1);
    expect(rows[0].subject).toBe(res.body.capabilityId);
    expect(rows[0].outcome).toBe('issued');
    expect(rows[0].detail).toEqual({
      role: 'goal_hub',
      scopes: ['channel:publish', 'channel:read'],
      principalId: res.body.principalId,
      parentCapabilityId: root.capabilityId
    });
  });

  test('an operator may delegate too, which is what makes `enroll --recovery` possible', async () => {
    // The break-glass path (`collabcast enroll --recovery`) authenticates with the operator
    // credential and lands on THIS route. While the parent-role fence read `root` alone, the
    // only break-glass command in the product answered `forbidden` to the only credential it is
    // documented to use — and no test noticed, because every fixture delegated as `root`.
    const fx = createFixture();
    // The real operator scope set, as `operator-credential.js` issues it.
    const operator = mintActor(fx.store, {
      role: 'operator',
      scopes: ROLE_SCOPES.operator
    });

    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', operator.bearer)
      .send({ role: 'listener', scopes: ['channel:read', 'self:cursor'], ttlSeconds: 600 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.role).toBe('listener');

    const child = getCapability(fx.store, res.body.capabilityId);
    expect(child.parentCapabilityId).toBe(operator.capabilityId);
    expect(child.attestationKind).toBe('delegation');

    // Still a delegation, so still narrowing: the child cannot outlive or out-scope the operator.
    expect(child.expiresAt <= getCapability(fx.store, operator.capabilityId).expiresAt).toBe(true);
    const widen = await request(fx.app)
      .post('/delegate')
      .set('Authorization', operator.bearer)
      .send({ role: 'listener', scopes: ['channel:publish'], ttlSeconds: 600 });
    expect(widen.status).toBe(403);
  });

  test('a listener holding enroll:delegate still cannot delegate', async () => {
    // The scope is the authority and the role check is the second, independent fence. Widening
    // it to `operator` must not have widened it to "anyone who happens to hold the scope".
    const fx = createFixture();
    const actor = mintActor(fx.store, {
      role: 'listener',
      scopes: ['channel:read', 'enroll:delegate']
    });
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', actor.bearer)
      .send({ role: 'listener', scopes: ['channel:read'], ttlSeconds: 600 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(res.body.error.detail.role).toBe('listener');
    expect(countPrincipals(fx)).toBe(before);
  });

  // E4d. Each refusal below asserts the principal table is untouched, not merely
  // that the status was 4xx. `/delegate` creates the child principal and issues
  // its capability in one `store.tx`, and a refusal must leave neither behind;
  // hoisting `createPrincipal` out of that transaction would leave one orphan
  // principal row per rejected request while every status assertion still passed.
  test('scopes cannot be widened past the parent', async () => {
    const fx = createFixture();
    const root = await rootActor(fx);
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', root.bearer)
      // The root grant above has no channel:ack, so this widens it.
      .send({ role: 'goal_hub', scopes: ['channel:read', 'channel:ack'], ttlSeconds: 600 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(countPrincipals(fx)).toBe(before);
  });

  test('scopes cannot exceed the role allowlist', async () => {
    const fx = createFixture();
    const root = await rootActor(fx);
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', root.bearer)
      // A listener may read but never publish.
      .send({ role: 'listener', scopes: ['channel:read', 'channel:publish'], ttlSeconds: 600 });
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scopes).toEqual(['channel:publish']);
    expect(countPrincipals(fx)).toBe(before);
  });

  test('a delegated capability cannot outlive its parent', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx, {
      scopes: ['channel:read', 'enroll:delegate'],
      ttlSeconds: 120
    });
    const exchanged = await request(fx.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: code });
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', `Bearer ${exchanged.body.token}`)
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 86400 });
    expect(res.status).toBe(403);
    expect(countPrincipals(fx)).toBe(before);
  });

  test('only root and only the delegable roles', async () => {
    const fx = createFixture();
    const root = await rootActor(fx);

    const beforeRoles = countPrincipals(fx);
    for (const role of ['root', 'operator', 'legacy', 'nonsense']) {
      const res = await request(fx.app)
        .post('/delegate')
        .set('Authorization', root.bearer)
        .send({ role, scopes: ['channel:read'], ttlSeconds: 600 });
      expect(res.status, `role ${role}`).toBe(400);
    }
    expect(countPrincipals(fx)).toBe(beforeRoles);

    // A non-root principal holding the scope anyway is still refused.
    const impostor = mintActor(fx.store, {
      role: 'goal_hub',
      scopes: ['channel:read', 'enroll:delegate']
    });
    const beforeImpostor = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', impostor.bearer)
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 600 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(countPrincipals(fx)).toBe(beforeImpostor);
  });

  test('requires enroll:delegate', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { role: 'root', scopes: ['channel:read'] });
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', actor.bearer)
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 600 });
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('enroll:delegate');
    expect(countPrincipals(fx)).toBe(before);
  });

  test('is not reachable without a token', async () => {
    const fx = createFixture();
    const before = countPrincipals(fx);
    const res = await request(fx.app)
      .post('/delegate')
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 600 });
    expect(res.status).toBe(401);
    expect(countPrincipals(fx)).toBe(before);
  });

  test('a bad ttl or scope list is a 400', async () => {
    const fx = createFixture();
    const root = await rootActor(fx);
    const before = countPrincipals(fx);
    const bodies = [
      { role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 0 },
      { role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 1.5 },
      { role: 'goal_hub', scopes: [], ttlSeconds: 600 },
      { role: 'goal_hub', scopes: 'channel:read', ttlSeconds: 600 }
    ];
    for (const body of bodies) {
      const res = await request(fx.app)
        .post('/delegate')
        .set('Authorization', root.bearer)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(countPrincipals(fx)).toBe(before);
  });
});

describe('DELETE /capability/:id', () => {
  test('a principal may revoke its own capability', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store, { alias: 'self' });
    const res = await request(fx.app)
      .delete(`/capability/${actor.capabilityId}`)
      .set('Authorization', actor.bearer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The token it just used is now dead.
    const after = await request(fx.app).get('/self').set('Authorization', actor.bearer);
    expect(after.status).toBe(401);
  });

  test('an operator may revoke anyone', async () => {
    const fx = createFixture();
    const op = mintActor(fx.store, { alias: 'operator', role: 'operator' });
    const victim = mintActor(fx.store, { alias: 'victim' });

    const res = await request(fx.app)
      .delete(`/capability/${victim.capabilityId}`)
      .set('Authorization', op.bearer);
    expect(res.status).toBe(200);
    expect(verifyCapability(fx.store, victim.token)).toBe(null);
    const rows = listAudit(fx.store, { action: 'capability.revoke' });
    expect(rows[0].outcome).toBe('revoked');
    expect(rows[0].detail).toEqual({ self: false });
  });

  test('a non-operator may not revoke someone else', async () => {
    const fx = createFixture();
    const a = mintActor(fx.store, { alias: 'a' });
    const b = mintActor(fx.store, { alias: 'b' });
    const res = await request(fx.app)
      .delete(`/capability/${b.capabilityId}`)
      .set('Authorization', a.bearer);
    expect(res.status).toBe(403);
    expect(verifyCapability(fx.store, b.token)).not.toBe(null);
    expect(listAudit(fx.store, { action: 'capability.revoke' })[0].outcome).toBe('denied');
  });

  test('revocation cascades to delegated children', async () => {
    const fx = createFixture();
    const { code } = approvedCode(fx);
    const root = await request(fx.app).post('/enroll/exchange').send({ enrollmentCode: code });
    const child = await request(fx.app)
      .post('/delegate')
      .set('Authorization', `Bearer ${root.body.token}`)
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 600 });
    expect(child.status).toBe(201);

    const res = await request(fx.app)
      .delete(`/capability/${root.body.capabilityId}`)
      .set('Authorization', `Bearer ${root.body.token}`);
    expect(res.status).toBe(200);
    expect(verifyCapability(fx.store, child.body.token)).toBe(null);
  });

  test('an unknown id is 404 and reveals nothing', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    const res = await request(fx.app)
      .delete('/capability/cap_ffffffffffffffff')
      .set('Authorization', actor.bearer);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  test('is not reachable without a token', async () => {
    const fx = createFixture();
    const actor = mintActor(fx.store);
    const res = await request(fx.app).delete(`/capability/${actor.capabilityId}`);
    expect(res.status).toBe(401);
    expect(verifyCapability(fx.store, actor.token)).not.toBe(null);
  });
});
