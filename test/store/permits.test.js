import { describe, test, expect, afterEach } from 'vitest';
import { openStore } from '../../src/store/db.js';
import {
  grantPermit,
  consumePermit,
  getPermit,
  revokePermit,
  expirePermits,
  listPermits
} from '../../src/store/permits.js';
import { createPrincipal } from '../../src/store/principals.js';
import { sha256 } from '../../src/store/digest.js';
import { createTmpStore, cleanupTmpStore, seedActors, sleep } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

const RESOURCE = 'thread-42';
const DIGEST = sha256('prune-plan-v1');

function setup({ ttlSeconds = 600 } = {}) {
  fixture = createTmpStore();
  const { hub, approval, operator } = seedActors(fixture.store);
  const permit = grantPermit(fixture.store, {
    principalId: hub.id,
    operation: 'retention.prune',
    resourceId: RESOURCE,
    contentDigest: DIGEST,
    approvalId: approval.id,
    ttlSeconds
  });
  const args = {
    permitId: permit.id,
    principalId: hub.id,
    operation: 'retention.prune',
    resourceId: RESOURCE,
    contentDigest: DIGEST
  };
  return { hub, operator, approval, permit, args };
}

function consume(overrides = {}, base) {
  return fixture.store.tx((tx) => consumePermit(tx, { ...base, ...overrides }));
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

describe('grantPermit', () => {
  test('grants a bound, one-use pmt_ permit', () => {
    const { permit, hub, approval } = setup();
    expect(permit.id).toMatch(/^pmt_[0-9a-f]{16}$/);
    expect(permit.state).toBe('granted');
    expect(permit.principalId).toBe(hub.id);
    expect(permit.approvalId).toBe(approval.id);
    expect(permit.operation).toBe('retention.prune');
    expect(permit.resourceId).toBe(RESOURCE);
    expect(Buffer.compare(permit.contentDigest, DIGEST)).toBe(0);
    expect(permit.consumedAt).toBe(null);
  });

  test('rejects operations outside the permitted set — there is no permit for posting', () => {
    fixture = createTmpStore();
    const { hub, approval } = seedActors(fixture.store);
    const base = {
      principalId: hub.id,
      resourceId: RESOURCE,
      contentDigest: DIGEST,
      approvalId: approval.id,
      ttlSeconds: 60
    };
    expect(codeOf(() => grantPermit(fixture.store, { ...base, operation: 'message.post' }))).toBe(
      'invalid_request'
    );
    expect(
      codeOf(() => grantPermit(fixture.store, { ...base, operation: 'retention.purge' }))
    ).toBe('invalid_request');
    for (const op of ['retention.prune', 'retention.rollback', 'capability.widen']) {
      expect(grantPermit(fixture.store, { ...base, operation: op }).state).toBe('granted');
    }
  });

  test('validates its inputs and requires a real approval', () => {
    fixture = createTmpStore();
    const { hub, approval } = seedActors(fixture.store);
    const base = {
      principalId: hub.id,
      operation: 'retention.prune',
      resourceId: RESOURCE,
      contentDigest: DIGEST,
      approvalId: approval.id,
      ttlSeconds: 60
    };
    expect(codeOf(() => grantPermit(fixture.store, { ...base, resourceId: '' }))).toBe(
      'invalid_request'
    );
    expect(codeOf(() => grantPermit(fixture.store, { ...base, contentDigest: 'zz' }))).toBe(
      'invalid_request'
    );
    expect(codeOf(() => grantPermit(fixture.store, { ...base, ttlSeconds: -1 }))).toBe(
      'invalid_request'
    );
    expect(codeOf(() => grantPermit(fixture.store, { ...base, principalId: '' }))).toBe(
      'invalid_request'
    );
    expect(codeOf(() => grantPermit(fixture.store, { ...base, namespace: 'elsewhere' }))).toBe(
      'wrong_namespace'
    );
    expect(
      codeOf(() => grantPermit(fixture.store, { ...base, approvalId: 'apr_0000000000000000' }))
    ).toBe('not_found');
  });
});

describe('consumePermit binding', () => {
  test('the happy path burns the permit exactly once', () => {
    const { args, permit } = setup();
    const consumed = consume({ consumedRef: 'prune-run-1' }, args);
    expect(consumed.state).toBe('consumed');
    expect(consumed.consumedRef).toBe('prune-run-1');
    expect(consumed.consumedAt).toBeTruthy();

    expect(codeOf(() => consume({}, args))).toBe('permit_invalid');
    expect(getPermit(fixture.store, permit.id).consumedRef).toBe('prune-run-1');
  });

  test('every binding field is load-bearing: each mismatch alone fails', () => {
    const { args, permit } = setup();
    const other = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });

    const mismatches = {
      contentDigest: { contentDigest: sha256('prune-plan-v2') },
      resourceId: { resourceId: 'thread-43' },
      operation: { operation: 'retention.rollback' },
      principalId: { principalId: other.id },
      permitId: { permitId: 'pmt_0000000000000000' }
    };
    for (const [label, overrides] of Object.entries(mismatches)) {
      expect(
        codeOf(() => consume(overrides, args)),
        label
      ).toBe('permit_invalid');
      expect(getPermit(fixture.store, permit.id).state, label).toBe('granted');
    }

    // a foreign namespace is refused before the UPDATE is even attempted
    expect(codeOf(() => consume({ namespace: 'elsewhere' }, args))).toBe('wrong_namespace');
    expect(getPermit(fixture.store, permit.id).state).toBe('granted');

    // and the exact binding still works afterwards
    expect(consume({}, args).state).toBe('consumed');
  });

  test('an expired permit cannot be consumed', async () => {
    const { args, permit } = setup({ ttlSeconds: 1 });
    await sleep(1200);
    expect(codeOf(() => consume({}, args))).toBe('permit_invalid');
    expect(getPermit(fixture.store, permit.id).state).toBe('granted');

    expect(expirePermits(fixture.store)).toBe(1);
    expect(getPermit(fixture.store, permit.id).state).toBe('expired');
    expect(expirePermits(fixture.store)).toBe(0);
  });

  test('a revoked permit cannot be consumed, and cannot be revoked twice', () => {
    const { args, permit } = setup();
    const revoked = revokePermit(fixture.store, permit.id);
    expect(revoked.state).toBe('revoked');
    expect(codeOf(() => consume({}, args))).toBe('permit_invalid');
    expect(codeOf(() => revokePermit(fixture.store, permit.id))).toBe('conflict');
    expect(codeOf(() => revokePermit(fixture.store, 'pmt_0000000000000000'))).toBe('not_found');
  });

  test('a consumed permit cannot be revoked back into usefulness', () => {
    const { args, permit } = setup();
    consume({}, args);
    expect(codeOf(() => revokePermit(fixture.store, permit.id))).toBe('conflict');
    expect(getPermit(fixture.store, permit.id).state).toBe('consumed');
  });

  test('refuses to run outside a transaction', () => {
    const { args } = setup();
    expect(codeOf(() => consumePermit(fixture.store, args))).toBe('internal');
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  test('the burn rolls back with the act it authorises', () => {
    const { args, permit } = setup();
    expect(() =>
      fixture.store.tx((tx) => {
        consumePermit(tx, args);
        throw new Error('prune failed halfway');
      })
    ).toThrowError('prune failed halfway');

    // the permit was never spent, because the effect never happened
    expect(getPermit(fixture.store, permit.id).state).toBe('granted');
    expect(consume({}, args).state).toBe('consumed');
  });
});

describe('permit durability', () => {
  test('a consumed permit is still consumed after a process restart', () => {
    const { args, permit } = setup();
    consume({ consumedRef: 'run-7' }, args);
    fixture.store.close();

    const reopened = openStore({ path: fixture.path, namespace: fixture.namespace });
    fixture.store = reopened;
    const stored = getPermit(reopened, permit.id);
    expect(stored.state).toBe('consumed');
    expect(stored.consumedRef).toBe('run-7');
    expect(codeOf(() => reopened.tx((tx) => consumePermit(tx, args)))).toBe('permit_invalid');
  });
});

describe('listPermits', () => {
  test('filters by state, principal, operation and resource', () => {
    const { args, permit, hub } = setup();
    const second = grantPermit(fixture.store, {
      principalId: hub.id,
      operation: 'capability.widen',
      resourceId: 'cap_1111111111111111',
      contentDigest: sha256('widen'),
      approvalId: getPermit(fixture.store, permit.id).approvalId,
      ttlSeconds: 60
    });
    consume({}, args);

    expect(listPermits(fixture.store, { state: 'granted' }).map((p) => p.id)).toEqual([second.id]);
    expect(listPermits(fixture.store, { state: 'consumed' }).map((p) => p.id)).toEqual([permit.id]);
    expect(listPermits(fixture.store, { operation: 'capability.widen' }).map((p) => p.id)).toEqual([
      second.id
    ]);
    expect(listPermits(fixture.store, { resourceId: RESOURCE }).map((p) => p.id)).toEqual([
      permit.id
    ]);
    expect(listPermits(fixture.store, { principalId: hub.id }).length).toBe(2);
    expect(codeOf(() => listPermits(fixture.store, { state: 'pending' }))).toBe('invalid_request');
  });
});
