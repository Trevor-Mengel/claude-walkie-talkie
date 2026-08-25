import { describe, test, expect } from 'vitest';
import * as store from '../../src/store/index.js';

// A typo in the barrel is a load-time failure for every wave-B consumer, so the
// public surface is asserted explicitly.
const FUNCTIONS = [
  'openStore',
  'context',
  'assertNamespace',
  'inTx',
  'storeError',
  'fail',
  'toEnvelope',
  'newId',
  'isStoreId',
  'now',
  'plusSeconds',
  'requireTtl',
  'sha256',
  'sha256Hex',
  'newSecret',
  'toDigest',
  'digestEquals',
  'createPrincipal',
  'getPrincipal',
  'getPrincipalByAlias',
  'setAlias',
  'revokePrincipal',
  'listPrincipals',
  'issueCapability',
  'verifyCapability',
  'renewCapability',
  'revokeCapability',
  'getCapability',
  'listCapabilities',
  'hasScope',
  'recordApproval',
  'getApproval',
  'consumeApproval',
  'createEnrollmentCode',
  'consumeEnrollmentCode',
  'listApprovals',
  'grantPermit',
  'consumePermit',
  'getPermit',
  'revokePermit',
  'expirePermits',
  'listPermits',
  'createHold',
  'releaseHold',
  'getHold',
  'activeHoldsFor',
  'isHeld',
  'audit',
  'redactDetail',
  'listAudit'
];

describe('store public surface', () => {
  test('every documented function is exported', () => {
    const missing = FUNCTIONS.filter((name) => typeof store[name] !== 'function');
    expect(missing).toEqual([]);
  });

  test('the vocabulary constants are exported and frozen', () => {
    expect(store.SCHEMA_VERSION).toBe('6');
    expect(store.ROLES).toEqual(['root', 'goal_hub', 'listener', 'operator', 'legacy']);
    expect(store.PERMIT_OPERATIONS).toEqual([
      'retention.prune',
      'retention.rollback',
      'capability.widen'
    ]);
    expect(store.APPROVAL_KINDS).toEqual(['enrollment', 'prune', 'rollback', 'scope_widen']);
    expect(store.HOLD_SUBJECT_KINDS).toEqual(['thread', 'event']);
    expect(store.ATTESTATION_KINDS).toEqual(['omp_hook_confirm', 'operator_cli', 'delegation']);
    expect(store.SCOPES).toEqual([
      'channel:read',
      'channel:publish',
      'channel:ack',
      'self:alias',
      'self:cursor',
      'listener:consume',
      'listener:receipt',
      'permit:administer',
      'enroll:delegate',
      'retention:approve'
    ]);
    for (const frozen of [store.ROLES, store.SCOPES, store.PERMIT_OPERATIONS, store.ERROR_CODES]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });

  test('toEnvelope renders the canonical error shape and hides unknown failures', () => {
    const err = store.storeError('permit_invalid', 'permit does not authorise this operation', {
      permitId: 'pmt_0000000000000000'
    });
    expect(store.toEnvelope(err)).toEqual({
      error: {
        code: 'permit_invalid',
        message: 'permit does not authorise this operation',
        detail: { permitId: 'pmt_0000000000000000' }
      }
    });
    expect(
      store.toEnvelope(new Error('SQLITE_CANTOPEN: /Users/someone/.collabcast/store'))
    ).toEqual({
      error: { code: 'internal', message: 'internal error' }
    });
    expect(store.storeError('made_up', 'x').code).toBe('internal');
  });

  test('ids are prefixed 16-hex and validated', () => {
    for (const prefix of Object.values(store.ID_PREFIXES)) {
      const id = store.newId(prefix);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{16}$`));
      expect(store.isStoreId(id)).toBe(true);
    }
    expect(store.isStoreId('prn_NOTHEX0000000000')).toBe(false);
    expect(store.isStoreId('xyz_0000000000000000')).toBe(false);
    expect(store.isStoreId(null)).toBe(false);
  });

  test('secrets are 32 bytes of base64url and hashing is stable', () => {
    const secret = store.newSecret();
    expect(Buffer.from(secret, 'base64url').length).toBe(store.SECRET_BYTES);
    expect(store.sha256(secret)).toEqual(store.sha256(secret));
    expect(store.sha256Hex('abc')).toBe(store.sha256('abc').toString('hex'));
    expect(store.digestEquals(store.sha256('a'), store.sha256('a'))).toBe(true);
    expect(store.digestEquals(store.sha256('a'), store.sha256('b'))).toBe(false);
    expect(store.digestEquals(store.sha256('a'), Buffer.alloc(4))).toBe(false);
    expect(store.digestEquals(null, null)).toBe(false);
  });
});
