// Digest coercion, and the length it is pinned to.
//
// Every digest this store binds to is a sha256: an approval's `subjectDigest`,
// a permit's `contentDigest`. `digestEquals` returns false on a length mismatch
// and otherwise compares only the bytes it is handed, so a digest accepted at
// one byte turns `consumePermit`'s content binding into an 8-bit check. These
// tests pin the length at the coercion boundary and at both callers that reach
// it, so the guarantee cannot be lost by adding a third caller.

import { afterEach, describe, expect, test } from 'vitest';
import { DIGEST_BYTES, sha256, toDigest } from '../../src/store/digest.js';
import { recordApproval } from '../../src/store/approvals.js';
import { grantPermit } from '../../src/store/permits.js';
import { createTmpStore, cleanupTmpStore, seedActors } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

describe('toDigest', () => {
  test('accepts a 32-byte buffer, a Uint8Array and hex in either case', () => {
    const digest = sha256('prune-plan-v1');
    expect(Buffer.compare(toDigest(digest), digest)).toBe(0);
    expect(Buffer.compare(toDigest(new Uint8Array(digest)), digest)).toBe(0);
    expect(Buffer.compare(toDigest(digest.toString('hex')), digest)).toBe(0);
    expect(Buffer.compare(toDigest(digest.toString('hex').toUpperCase()), digest)).toBe(0);
  });

  test('rejects a digest shorter than a sha256, however well-formed the hex', () => {
    expect(DIGEST_BYTES).toBe(32);
    // One byte of valid, even-length, lowercase hex: the shape check passes and
    // only the length check stands between this and an 8-bit content binding.
    expect(codeOf(() => toDigest('ab', 'contentDigest'))).toBe('invalid_request');
    expect(codeOf(() => toDigest(Buffer.from([0xab]), 'contentDigest'))).toBe('invalid_request');
    expect(codeOf(() => toDigest(sha256('x').subarray(0, 31)))).toBe('invalid_request');
    expect(codeOf(() => toDigest(Buffer.alloc(0)))).toBe('invalid_request');
  });

  test('rejects a digest longer than a sha256', () => {
    expect(codeOf(() => toDigest(Buffer.concat([sha256('x'), Buffer.from([1])])))).toBe(
      'invalid_request'
    );
  });

  test('still rejects a value that is not a digest at all', () => {
    expect(codeOf(() => toDigest('not-hex'))).toBe('invalid_request');
    expect(codeOf(() => toDigest('abc'))).toBe('invalid_request');
    expect(codeOf(() => toDigest(null))).toBe('invalid_request');
    expect(codeOf(() => toDigest(42))).toBe('invalid_request');
  });

  test('names the label it was given, so the caller can tell which field failed', () => {
    try {
      toDigest('ab', 'contentDigest');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err.message).toContain('contentDigest');
    }
  });
});

describe('the callers that bind a digest', () => {
  test('grantPermit refuses a one-byte contentDigest', () => {
    fixture = createTmpStore();
    const { hub, approval } = seedActors(fixture.store);
    const base = {
      principalId: hub.id,
      operation: 'retention.prune',
      resourceId: 'thread-42',
      approvalId: approval.id,
      ttlSeconds: 60
    };
    expect(codeOf(() => grantPermit(fixture.store, { ...base, contentDigest: 'ab' }))).toBe(
      'invalid_request'
    );
    // The same call with a real sha256 succeeds, so the refusal above is about
    // the length and nothing else.
    expect(
      grantPermit(fixture.store, { ...base, contentDigest: sha256('prune-plan-v1') }).id
    ).toBeTruthy();
  });

  test('recordApproval refuses a one-byte subjectDigest', () => {
    fixture = createTmpStore();
    const { operator } = seedActors(fixture.store);
    const base = {
      kind: 'enrollment',
      approvingPrincipal: operator.id,
      attestationKind: 'omp_hook_confirm'
    };
    expect(codeOf(() => recordApproval(fixture.store, { ...base, subjectDigest: 'ab' }))).toBe(
      'invalid_request'
    );
    expect(
      recordApproval(fixture.store, { ...base, subjectDigest: sha256('enroll:listener') }).id
    ).toBeTruthy();
  });
});
