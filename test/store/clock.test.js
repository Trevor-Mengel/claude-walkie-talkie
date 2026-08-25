// `requireTtl` / `plusSeconds` bounds.
//
// Wave F blocker: `requireTtl` checked only "positive integer", so `requireTtl(1e18)` passed
// and the very next call — `plusSeconds(1e18)` — threw a bare `RangeError: Invalid time value`
// whose `code` is `undefined`. `toCollabcast` only translates a thrown value that already carries a
// recognised code, so an absurd `ttlSeconds` on `POST /delegate` reached the client as
// `500 internal`: a client error reported as a server fault, on the one surface where the
// caller is minting credentials. Slightly smaller values were worse than a 500 — they
// *succeeded*, so `requireTtl(999999999999)` minted a capability expiring in the year 33715.
//
// These assertions pin both halves: the bound refuses, and everything legitimate still passes.

import { describe, test, expect } from 'vitest';
import { requireTtl, plusSeconds, MAX_TTL_SECONDS } from '../../src/store/clock.js';
import { MAX_ENROLL_TTL_SECONDS } from '../../src/authority/policy.js';

describe('requireTtl upper bound', () => {
  test('a ttl past one year is invalid_request naming the field, not a bare RangeError', () => {
    for (const seconds of [MAX_TTL_SECONDS + 1, 999999999999, 1e18, Number.MAX_SAFE_INTEGER]) {
      let thrown;
      try {
        requireTtl(seconds);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `ttl ${seconds} must be refused`).toBeDefined();
      // The point of the fix: a *coded* failure. A `RangeError` has `code === undefined`,
      // which is exactly what collapsed to 500.
      expect(thrown.code, `ttl ${seconds}`).toBe('invalid_request');
      expect(thrown).not.toBeInstanceOf(RangeError);
      // The field is named, both in the message and structurally.
      expect(thrown.message).toContain('ttlSeconds');
      expect(thrown.detail).toMatchObject({ field: 'ttlSeconds', max: MAX_TTL_SECONDS });
    }
  });

  test('the label names the caller\'s own field, so an approval blames requestedTtlS', () => {
    let thrown;
    try {
      requireTtl(1e18, 'requestedTtlS');
    } catch (err) {
      thrown = err;
    }
    expect(thrown.code).toBe('invalid_request');
    expect(thrown.message).toContain('requestedTtlS');
    expect(thrown.detail).toMatchObject({ field: 'requestedTtlS', requestedTtlS: 1e18 });
  });

  test('every legitimate ttl still passes, and the bound is well clear of the enrol cap', () => {
    for (const seconds of [1, 60, 600, 3600, 86400, MAX_TTL_SECONDS]) {
      expect(requireTtl(seconds), `ttl ${seconds}`).toBe(seconds);
      // And the value it was validated for is actually representable.
      expect(plusSeconds(seconds)).toMatch(/^\d{4}-/);
    }
    expect(MAX_TTL_SECONDS).toBeGreaterThan(MAX_ENROLL_TTL_SECONDS);
  });

  test('the old failure modes are gone: no year-33715 expiry, no uncoded throw', () => {
    // Previously: plusSeconds(999999999999) === '+033715-05-22T...' — a valid ISO string
    // outside the four-digit year shape every store timestamp is compared against.
    let overflow;
    try {
      plusSeconds(999999999999);
    } catch (err) {
      overflow = err;
    }
    expect(overflow?.code).toBe('invalid_request');

    let range;
    try {
      plusSeconds(1e18);
    } catch (err) {
      range = err;
    }
    expect(range).not.toBeInstanceOf(RangeError);
    expect(range?.code).toBe('invalid_request');
  });
});
