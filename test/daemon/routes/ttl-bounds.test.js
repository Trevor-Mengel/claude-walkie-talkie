// A caller-supplied TTL that is out of range is the caller's fault.
//
// `POST /delegate` validates only `Number.isInteger(ttlSeconds) && ttlSeconds > 0`, and left
// the rest to the store. `requireTtl` had no upper bound, so the value flowed through to
// `plusSeconds`, where `new Date(base + 1e21).toISOString()` threw a bare
// `RangeError: Invalid time value`. `toCollabcast` only translates a thrown value already carrying
// a recognised code, so the RangeError fell through to the fixed `internal` body and the client
// was told `500` — a server fault — for a request it got wrong. On the one route where a caller
// is minting a credential, that is the difference between "fix your argument" and "the
// authority is broken, escalate".
//
// The status is the whole assertion. A 400 that mints nothing is the contract.

import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createFixture, mintActor, cleanupFixtures, NAMESPACE } from './helpers.js';
import { MAX_TTL_SECONDS } from '../../../src/store/clock.js';

afterEach(cleanupFixtures);

function countCapabilities(fx) {
  return fx.store.db
    .prepare('SELECT count(*) AS n FROM capability WHERE namespace = ?')
    .get(NAMESPACE).n;
}

describe('POST /delegate with an out-of-range ttlSeconds', () => {
  test('an absurd ttl is a 400 naming the field, not a 500', async () => {
    const fx = createFixture();
    const root = mintActor(fx.store, {
      role: 'root',
      alias: 'root',
      scopes: ['channel:read', 'enroll:delegate']
    });
    const before = countCapabilities(fx);

    // 1e18 used to reach `plusSeconds` and throw an uncoded RangeError -> 500.
    // 999999999999 used to SUCCEED, minting a capability expiring in the year 33715.
    for (const ttlSeconds of [MAX_TTL_SECONDS + 1, 999999999999, 1e18]) {
      const res = await request(fx.app)
        .post('/delegate')
        .set('Authorization', root.bearer)
        .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds });

      expect(res.status, `ttlSeconds ${ttlSeconds}`).toBe(400);
      expect(res.body.error.code, `ttlSeconds ${ttlSeconds}`).toBe('invalid_request');
      // The refusal has to be actionable: it names the field the caller got wrong.
      expect(res.body.error.message).toContain('ttlSeconds');
      // And nothing was minted on the way to the refusal.
      expect(countCapabilities(fx), `ttlSeconds ${ttlSeconds}`).toBe(before);
    }
  });

  test('a ttl just inside the bound still mints, so the fence is not over-tight', async () => {
    const fx = createFixture();
    const root = mintActor(fx.store, {
      role: 'root',
      alias: 'root',
      scopes: ['channel:read', 'enroll:delegate'],
      // A delegated capability may not outlive its parent, so the parent holds the bound
      // exactly and the child asks for a minute less.
      ttlSeconds: MAX_TTL_SECONDS
    });

    const res = await request(fx.app)
      .post('/delegate')
      .set('Authorization', root.bearer)
      .send({ role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: MAX_TTL_SECONDS - 60 });

    expect(res.status).toBe(201);
    // Four-digit year: the ISO shape every lexicographic timestamp comparison in the store
    // depends on. `+033715-...` would sort before every real timestamp.
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
