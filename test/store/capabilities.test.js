import { describe, test, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { openStore } from '../../src/store/db.js';
import {
  issueCapability,
  verifyCapability,
  renewCapability,
  revokeCapability,
  getCapability,
  listCapabilities,
  hasScope,
  SCOPES
} from '../../src/store/capabilities.js';
import { createPrincipal, getPrincipal, revokePrincipal } from '../../src/store/principals.js';
import { plusSeconds, now } from '../../src/store/clock.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function hub(store, alias = 'Main') {
  return createPrincipal(store, { role: 'goal_hub', displayAlias: alias });
}

function issue(store, principalId, overrides = {}) {
  return issueCapability(store, {
    principalId,
    scopes: ['channel:read', 'channel:publish'],
    ttlSeconds: 3600,
    attestationKind: 'operator_cli',
    attestationRef: 'cli:test',
    ...overrides
  });
}

describe('capability issue and verify', () => {
  test('issue → verify round-trip returns the capability and its principal', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const { capabilityId, token } = issue(fixture.store, p.id);

    expect(capabilityId).toMatch(/^cap_[0-9a-f]{16}$/);
    // 32 random bytes, base64url
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const out = verifyCapability(fixture.store, token);
    expect(out.capability.id).toBe(capabilityId);
    expect(out.capability.scopes).toEqual(['channel:publish', 'channel:read']);
    expect(out.capability.attestationKind).toBe('operator_cli');
    expect(out.principal.id).toBe(p.id);

    expect(hasScope(out.capability, 'channel:publish')).toBe(true);
    expect(hasScope(out.capability, 'permit:administer')).toBe(false);
    expect(hasScope({ scopes: JSON.stringify(['channel:ack']) }, 'channel:ack')).toBe(true);
    expect(hasScope(null, 'channel:ack')).toBe(false);
  });

  test('the raw token is nowhere in the database files — only its sha256 is stored', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const { token } = issue(fixture.store, p.id);

    const stored = fixture.store.db
      .prepare('SELECT token_sha256 FROM capability')
      .get().token_sha256;
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored.length).toBe(32);

    fixture.store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${fixture.path}${suffix}`;
      if (!existsSync(path)) continue;
      expect(readFileSync(path).includes(token)).toBe(false);
    }
    // sanity: the assertion above can actually fail — the hash IS present
    expect(readFileSync(fixture.path).includes(stored)).toBe(true);
    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
  });

  test('verification is a single indexed lookup, never a table scan', () => {
    fixture = createTmpStore();
    const plan = fixture.store.db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM capability WHERE token_sha256 = ?')
      .all(Buffer.alloc(32))
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toMatch(/SEARCH capability USING INDEX/);
    expect(plan).not.toMatch(/SCAN capability/);
  });

  test('a garbage or empty token verifies to null', () => {
    fixture = createTmpStore();
    hub(fixture.store);
    expect(verifyCapability(fixture.store, '')).toBe(null);
    expect(verifyCapability(fixture.store, 'not-a-real-token')).toBe(null);
    expect(verifyCapability(fixture.store, undefined)).toBe(null);
  });

  test('expired, not-yet-valid, revoked and orphaned-by-principal tokens all fail', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);

    const short = issue(fixture.store, p.id, { ttlSeconds: 60 });
    expect(verifyCapability(fixture.store, short.token)).toBeTruthy();
    expect(verifyCapability(fixture.store, short.token, plusSeconds(120))).toBe(null);

    const future = issue(fixture.store, p.id, { notBefore: plusSeconds(300) });
    expect(verifyCapability(fixture.store, future.token)).toBe(null);
    expect(verifyCapability(fixture.store, future.token, plusSeconds(360))).toBeTruthy();

    const revoked = issue(fixture.store, p.id);
    revokeCapability(fixture.store, revoked.capabilityId, 'operator revoked');
    expect(verifyCapability(fixture.store, revoked.token)).toBe(null);
    expect(getCapability(fixture.store, revoked.capabilityId).revokedReason).toBe(
      'operator revoked'
    );

    const live = issue(fixture.store, p.id);
    expect(verifyCapability(fixture.store, live.token)).toBeTruthy();
    revokePrincipal(fixture.store, p.id);
    expect(verifyCapability(fixture.store, live.token)).toBe(null);
  });

  test('a capability from another namespace never verifies in this store', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const { token } = issue(fixture.store, p.id);
    fixture.store.db.prepare("UPDATE capability SET namespace = 'other-project'").run();
    expect(verifyCapability(fixture.store, token)).toBe(null);
  });

  test('rejects unknown scopes, unknown attestation kinds and empty scope sets', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const cases = [
      [{ scopes: ['channel:teleport'] }, 'invalid_request'],
      [{ scopes: [] }, 'invalid_request'],
      [{ attestationKind: 'vibes' }, 'invalid_request'],
      [{ attestationRef: '' }, 'invalid_request'],
      [{ ttlSeconds: 0 }, 'invalid_request'],
      [{ ttlSeconds: 1.5 }, 'invalid_request'],
      [{ principalId: 'prn_0000000000000000' }, 'not_found']
    ];
    for (const [overrides, code] of cases) {
      let err;
      try {
        issue(fixture.store, p.id, overrides);
      } catch (e) {
        err = e;
      }
      expect(err?.code, JSON.stringify(overrides)).toBe(code);
    }
    expect(SCOPES).toContain('channel:publish');
  });
});

describe('capability derivation', () => {
  test('a child cannot widen or outlive its parent', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const parent = issue(fixture.store, p.id, { scopes: ['channel:read'], ttlSeconds: 600 });

    let widen;
    try {
      issue(fixture.store, p.id, {
        scopes: ['channel:read', 'channel:publish'],
        parentCapabilityId: parent.capabilityId,
        attestationKind: 'delegation',
        attestationRef: `cap:${parent.capabilityId}`
      });
    } catch (e) {
      widen = e;
    }
    expect(widen?.code).toBe('forbidden');

    let outlive;
    try {
      issue(fixture.store, p.id, {
        scopes: ['channel:read'],
        ttlSeconds: 9000,
        parentCapabilityId: parent.capabilityId,
        attestationKind: 'delegation',
        attestationRef: `cap:${parent.capabilityId}`
      });
    } catch (e) {
      outlive = e;
    }
    expect(outlive?.code).toBe('forbidden');

    const child = issue(fixture.store, p.id, {
      scopes: ['channel:read'],
      ttlSeconds: 60,
      parentCapabilityId: parent.capabilityId,
      attestationKind: 'delegation',
      attestationRef: `cap:${parent.capabilityId}`
    });
    expect(verifyCapability(fixture.store, child.token)).toBeTruthy();
  });

  test('a revoked or expired ancestor invalidates its descendants', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const gp = issue(fixture.store, p.id, { scopes: ['channel:read'], ttlSeconds: 600 });
    const parent = issue(fixture.store, p.id, {
      scopes: ['channel:read'],
      ttlSeconds: 300,
      parentCapabilityId: gp.capabilityId,
      attestationKind: 'delegation',
      attestationRef: `cap:${gp.capabilityId}`
    });
    const child = issue(fixture.store, p.id, {
      scopes: ['channel:read'],
      ttlSeconds: 120,
      parentCapabilityId: parent.capabilityId,
      attestationKind: 'delegation',
      attestationRef: `cap:${parent.capabilityId}`
    });

    expect(verifyCapability(fixture.store, child.token)).toBeTruthy();

    // an ancestor that has merely lapsed (not revoked) still kills the chain
    expect(verifyCapability(fixture.store, child.token, plusSeconds(400))).toBe(null);

    // revoke the grandparent only; the child must stop verifying too
    fixture.store.db
      .prepare('UPDATE capability SET revoked_at = ? WHERE id = ?')
      .run(now(), gp.capabilityId);
    expect(verifyCapability(fixture.store, child.token)).toBe(null);
    expect(verifyCapability(fixture.store, parent.token)).toBe(null);
  });

  test('revocation cascades over children and renewals, transitively', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const parent = issue(fixture.store, p.id, { scopes: ['channel:read'], ttlSeconds: 600 });
    const child = issue(fixture.store, p.id, {
      scopes: ['channel:read'],
      ttlSeconds: 300,
      parentCapabilityId: parent.capabilityId,
      attestationKind: 'delegation',
      attestationRef: `cap:${parent.capabilityId}`
    });
    const renewedChild = renewCapability(fixture.store, child.capabilityId, 120);

    const unrelated = issue(fixture.store, p.id);

    const { revoked } = revokeCapability(fixture.store, parent.capabilityId, 'compromised');
    expect(new Set(revoked)).toEqual(
      new Set([parent.capabilityId, child.capabilityId, renewedChild.capabilityId])
    );

    expect(verifyCapability(fixture.store, parent.token)).toBe(null);
    expect(verifyCapability(fixture.store, child.token)).toBe(null);
    expect(verifyCapability(fixture.store, renewedChild.token)).toBe(null);
    expect(verifyCapability(fixture.store, unrelated.token)).toBeTruthy();

    for (const id of revoked) {
      expect(getCapability(fixture.store, id).revokedReason).toBe('compromised');
    }

    let err;
    try {
      revokeCapability(fixture.store, 'cap_0000000000000000', 'nope');
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('not_found');
  });
});

describe('renewCapability', () => {
  test('mints a fresh token, records renewed_from and keeps the same principal', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const original = issue(fixture.store, p.id, { scopes: ['channel:read', 'channel:publish'] });

    const renewed = renewCapability(fixture.store, original.capabilityId, 900);
    expect(renewed.capabilityId).not.toBe(original.capabilityId);
    expect(renewed.token).not.toBe(original.token);

    const row = getCapability(fixture.store, renewed.capabilityId);
    expect(row.renewedFrom).toBe(original.capabilityId);
    expect(row.principalId).toBe(p.id);
    expect(row.namespace).toBe(fixture.namespace);
    expect(row.scopes).toEqual(['channel:publish', 'channel:read']);
    expect(verifyCapability(fixture.store, renewed.token).capability.id).toBe(renewed.capabilityId);
  });

  test('refuses to widen scopes, change namespace or change principal', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const other = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });
    const original = issue(fixture.store, p.id, { scopes: ['channel:read'] });

    const cases = [
      [{ scopes: ['channel:read', 'permit:administer'] }, 'forbidden'],
      [{ namespace: 'other-project' }, 'forbidden'],
      [{ principalId: other.id }, 'forbidden']
    ];
    for (const [opts, code] of cases) {
      let err;
      try {
        renewCapability(fixture.store, original.capabilityId, 300, opts);
      } catch (e) {
        err = e;
      }
      expect(err?.code, JSON.stringify(opts)).toBe(code);
    }
  });

  test('narrowing scopes on renewal is allowed; renewing a revoked capability is not', () => {
    fixture = createTmpStore();
    const p = hub(fixture.store);
    const original = issue(fixture.store, p.id, { scopes: ['channel:read', 'channel:publish'] });

    const narrowed = renewCapability(fixture.store, original.capabilityId, 300, {
      scopes: ['channel:read']
    });
    expect(getCapability(fixture.store, narrowed.capabilityId).scopes).toEqual(['channel:read']);

    revokeCapability(fixture.store, narrowed.capabilityId, 'done');
    let err;
    try {
      renewCapability(fixture.store, narrowed.capabilityId, 300);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('forbidden');

    let missing;
    try {
      renewCapability(fixture.store, 'cap_0000000000000000', 300);
    } catch (e) {
      missing = e;
    }
    expect(missing?.code).toBe('not_found');
  });
});

describe('listCapabilities', () => {
  test('filters by principal and hides revoked by default', () => {
    fixture = createTmpStore();
    const a = hub(fixture.store, 'Main');
    const b = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });
    issue(fixture.store, a.id);
    const gone = issue(fixture.store, a.id);
    issue(fixture.store, b.id);
    revokeCapability(fixture.store, gone.capabilityId, 'x');

    expect(listCapabilities(fixture.store, { principalId: a.id }).length).toBe(1);
    expect(
      listCapabilities(fixture.store, { principalId: a.id, includeRevoked: true }).length
    ).toBe(2);
    expect(listCapabilities(fixture.store).length).toBe(2);
  });
});

/** F4 regression: revoking a principal must invalidate what it delegated. */
describe('principal revocation cascades over delegations', () => {
  // A derived capability may not outlive its parent, so each level narrows.
  function delegate(store, parent, principalId, ttlSeconds = 600) {
    return issueCapability(store, {
      principalId,
      scopes: ['channel:read'],
      ttlSeconds,
      attestationKind: 'delegation',
      attestationRef: `cap:${parent}`,
      parentCapabilityId: parent
    });
  }

  test('revoking a principal kills its own capability, its delegations and their renewals', () => {
    fixture = createTmpStore();
    const root = createPrincipal(fixture.store, { role: 'root', displayAlias: 'root' });
    const goalHub = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'goal.hub' });
    const listener = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'ear' });

    const rootCap = issue(fixture.store, root.id);
    const hubCap = delegate(fixture.store, rootCap.capabilityId, goalHub.id, 1800);
    const hubRenewal = renewCapability(fixture.store, hubCap.capabilityId, 900);
    const grandchild = delegate(fixture.store, hubRenewal.capabilityId, listener.id);

    for (const t of [rootCap, hubCap, hubRenewal, grandchild]) {
      expect(verifyCapability(fixture.store, t.token)).toBeTruthy();
    }

    revokePrincipal(fixture.store, root.id);

    // The bearer's own capability, the capability it minted for another
    // principal, that delegation's renewal, and everything below.
    for (const t of [rootCap, hubCap, hubRenewal, grandchild]) {
      expect(verifyCapability(fixture.store, t.token)).toBe(null);
    }

    // ...and the rows say so, so an operator listing capabilities sees it too.
    for (const t of [rootCap, hubCap, hubRenewal, grandchild]) {
      const row = getCapability(fixture.store, t.capabilityId);
      expect(row.revokedAt).toBeTruthy();
      expect(row.revokedReason).toBe('principal revoked');
    }
    expect(listCapabilities(fixture.store).length).toBe(0);

    // The delegatees themselves are untouched: revocation reaches authority the
    // revoked principal handed out, not identities it never owned.
    expect(getPrincipal(fixture.store, goalHub.id).revokedAt).toBe(null);
    expect(getPrincipal(fixture.store, listener.id).revokedAt).toBe(null);
  });

  test('an unrelated principal keeps its capability when another is revoked', () => {
    fixture = createTmpStore();
    const a = hub(fixture.store, 'a');
    const b = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'b' });
    const keep = issue(fixture.store, b.id);
    issue(fixture.store, a.id);

    revokePrincipal(fixture.store, a.id);
    expect(verifyCapability(fixture.store, keep.token)).toBeTruthy();
  });

  test('a delegation minted after the sweep still fails: the walk checks ancestor principals', () => {
    fixture = createTmpStore();
    const root = createPrincipal(fixture.store, { role: 'root', displayAlias: 'root' });
    const listener = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'ear' });
    const rootCap = issue(fixture.store, root.id);
    const child = delegate(fixture.store, rootCap.capabilityId, listener.id);

    // Simulates the race window: `revokePrincipal` marked the principal, but a
    // delegation minted between its SELECT and its UPDATE never got swept. The
    // whole chain is forced back to live so nothing except the principal's own
    // revocation is left to catch it.
    revokePrincipal(fixture.store, root.id);
    fixture.store.db
      .prepare('UPDATE capability SET revoked_at = NULL, revoked_reason = NULL')
      .run();
    expect(getCapability(fixture.store, rootCap.capabilityId).revokedAt).toBe(null);
    expect(getCapability(fixture.store, child.capabilityId).revokedAt).toBe(null);

    // The bearer is `listener`, which is NOT revoked — only the principal behind
    // the parent capability is.
    expect(getPrincipal(fixture.store, listener.id).revokedAt).toBe(null);
    expect(verifyCapability(fixture.store, child.token)).toBe(null);
  });

  test('verification stays bounded: no statement it runs scans a table', () => {
    fixture = createTmpStore();
    const root = createPrincipal(fixture.store, { role: 'root', displayAlias: 'root' });
    const mid = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'mid' });
    const leafPrincipal = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'leaf' });
    for (let i = 0; i < 60; i += 1) {
      createPrincipal(fixture.store, { role: 'listener', displayAlias: `filler-${i}` });
    }

    const rootCap = issue(fixture.store, root.id);
    const midCap = delegate(fixture.store, rootCap.capabilityId, mid.id, 1200);
    const leafCap = delegate(fixture.store, midCap.capabilityId, leafPrincipal.id, 600);

    const executed = [];
    const counted = {
      namespace: fixture.namespace,
      db: {
        prepare(sql) {
          executed.push(sql);
          return fixture.store.db.prepare(sql);
        }
      }
    };

    expect(verifyCapability(counted, leafCap.token).capability.id).toBe(leafCap.capabilityId);

    // One token lookup, then at most one capability + one principal read per
    // ancestor. A cost that grew with the roster would blow this budget.
    expect(executed.length).toBeLessThanOrEqual(1 + 2 * 3);
    for (const sql of new Set(executed)) {
      const plan = fixture.store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...new Array(sql.split('?').length - 1).fill(null))
        .map((row) => row.detail)
        .join(' | ');
      expect(plan, sql).toMatch(/SEARCH/);
      expect(plan, sql).not.toMatch(/SCAN/);
    }
  });
});
