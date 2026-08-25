import { describe, test, expect, afterEach } from 'vitest';
import {
  recordApproval,
  getApproval,
  consumeApproval,
  createEnrollmentCode,
  consumeEnrollmentCode,
  listApprovals
} from '../../src/store/approvals.js';
import { createPrincipal } from '../../src/store/principals.js';
import { sha256 } from '../../src/store/digest.js';
import { createTmpStore, cleanupTmpStore, sleep } from './helpers.js';

let fixture;
let operator;

afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function setup() {
  fixture = createTmpStore();
  operator = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

function approval(overrides = {}) {
  return recordApproval(fixture.store, {
    kind: 'enrollment',
    subjectDigest: sha256('enroll:listener'),
    approvingPrincipal: operator.id,
    attestationKind: 'omp_hook_confirm',
    requestedScopes: ['channel:read', 'channel:ack'],
    requestedTtlS: 900,
    ...overrides
  });
}

describe('approvals', () => {
  test('records the human decision with its attestation and requested grant', () => {
    setup();
    const a = approval();
    expect(a.id).toMatch(/^apr_[0-9a-f]{16}$/);
    expect(a.kind).toBe('enrollment');
    expect(a.attestationKind).toBe('omp_hook_confirm');
    expect(a.approvingPrincipal).toBe(operator.id);
    expect(a.requestedScopes).toEqual(['channel:ack', 'channel:read']);
    expect(a.requestedTtlS).toBe(900);
    expect(Buffer.compare(a.subjectDigest, sha256('enroll:listener'))).toBe(0);
    expect(a.consumedAt).toBe(null);
    expect(getApproval(fixture.store, a.id).id).toBe(a.id);
  });

  test('validates kind, attestation, approver, digest and ttl', () => {
    setup();
    expect(codeOf(() => approval({ kind: 'whatever' }))).toBe('invalid_request');
    expect(codeOf(() => approval({ attestationKind: 'trust-me' }))).toBe('invalid_request');
    expect(codeOf(() => approval({ approvingPrincipal: '' }))).toBe('invalid_request');
    expect(codeOf(() => approval({ subjectDigest: 'not-hex' }))).toBe('invalid_request');
    expect(codeOf(() => approval({ requestedTtlS: 0 }))).toBe('invalid_request');
    expect(codeOf(() => approval({ namespace: 'elsewhere' }))).toBe('wrong_namespace');
    expect(approval({ requestedScopes: null, requestedTtlS: null }).requestedScopes).toBe(null);
  });

  test('an approval is one-use', () => {
    setup();
    const a = approval();
    const consumed = fixture.store.tx((tx) => consumeApproval(tx, a.id, 'cap_1111111111111111'));
    expect(consumed.consumedAt).toBeTruthy();
    expect(consumed.consumedBy).toBe('cap_1111111111111111');

    expect(
      codeOf(() =>
        fixture.store.tx((tx) => consumeApproval(tx, a.id, 'cap_2222222222222222'))
      )
    ).toBe('conflict');
    expect(getApproval(fixture.store, a.id).consumedBy).toBe('cap_1111111111111111');
    expect(
      codeOf(() => fixture.store.tx((tx) => consumeApproval(tx, 'apr_0000000000000000', 'x')))
    ).toBe('not_found');
    expect(codeOf(() => fixture.store.tx((tx) => consumeApproval(tx, a.id, '')))).toBe(
      'invalid_request'
    );
  });

  test('listApprovals filters by kind and consumption', () => {
    setup();
    const a = approval();
    approval({ kind: 'prune' });
    fixture.store.tx((tx) => consumeApproval(tx, a.id, 'x'));

    expect(listApprovals(fixture.store, { kind: 'prune' }).length).toBe(1);
    expect(listApprovals(fixture.store, { consumed: true }).map((r) => r.id)).toEqual([a.id]);
    expect(listApprovals(fixture.store, { consumed: false }).length).toBe(1);
    expect(codeOf(() => listApprovals(fixture.store, { kind: 'nope' }))).toBe('invalid_request');
  });
});

describe('enrolment codes', () => {
  test('returns the code once, stores only its sha256, and resolves the approval', () => {
    setup();
    const a = approval();
    const { code, expiresAt } = createEnrollmentCode(fixture.store, {
      approvalId: a.id,
      ttlSeconds: 300
    });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBeTruthy();

    const row = fixture.store.db.prepare('SELECT code_sha256 FROM enrollment_code').get();
    expect(Buffer.compare(row.code_sha256, sha256(code))).toBe(0);
    expect(fixture.store.db.prepare('SELECT * FROM enrollment_code').get().code).toBeUndefined();

    expect(fixture.store.tx((tx) => consumeEnrollmentCode(tx, code)).id).toBe(a.id);
  });

  test('a code is one-use, and unknown codes fail identically', () => {
    setup();
    const a = approval();
    const { code } = createEnrollmentCode(fixture.store, { approvalId: a.id, ttlSeconds: 300 });
    fixture.store.tx((tx) => consumeEnrollmentCode(tx, code));

    for (const bad of [code, 'made-up-code', '', null]) {
      expect(codeOf(() => fixture.store.tx((tx) => consumeEnrollmentCode(tx, bad)))).toBe(
        'forbidden'
      );
    }
  });

  test('an expired code is refused', async () => {
    setup();
    const a = approval();
    const { code } = createEnrollmentCode(fixture.store, { approvalId: a.id, ttlSeconds: 1 });
    await sleep(1200);
    expect(codeOf(() => fixture.store.tx((tx) => consumeEnrollmentCode(tx, code)))).toBe(
      'forbidden'
    );
    expect(
      fixture.store.db.prepare('SELECT consumed_at FROM enrollment_code').get().consumed_at
    ).toBe(null);
  });

  test('only an unconsumed enrollment approval can back a code', () => {
    setup();
    const prune = approval({ kind: 'prune' });
    expect(
      codeOf(() => createEnrollmentCode(fixture.store, { approvalId: prune.id, ttlSeconds: 60 }))
    ).toBe('invalid_request');
    expect(
      codeOf(() =>
        createEnrollmentCode(fixture.store, { approvalId: 'apr_0000000000000000', ttlSeconds: 60 })
      )
    ).toBe('not_found');

    const spent = approval();
    fixture.store.tx((tx) => consumeApproval(tx, spent.id, 'x'));
    expect(
      codeOf(() => createEnrollmentCode(fixture.store, { approvalId: spent.id, ttlSeconds: 60 }))
    ).toBe('conflict');
  });
});
