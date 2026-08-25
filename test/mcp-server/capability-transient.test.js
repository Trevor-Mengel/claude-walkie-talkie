// A credential is only invalidated by a refusal.
//
// Wave F blocker. The holder resolved identity with `GET /self` and treated EVERY failure of
// that call as credential invalidity — `clear('invalid')` on any throw, in both `adopt` and
// `adoptInjected`. So a service that was simply not running made a freshly issued capability
// get discarded:
//
//   - the token was wiped out of the box, so the live capability in the store was orphaned;
//   - minting it had already consumed a ONE-USE operator approval, so recovering meant asking
//     a human to click approve a second time;
//   - and `requireActive` then told the model the capability was "expired or revoked" and to
//     call `collabcast_enroll` again — which is both a lie and the most expensive possible advice.
//
// The rule under test: only an authentication/authorization refusal may invalidate. Everything
// else keeps the credential and surfaces a distinguishable error. Both directions are asserted
// in every case, because a test that only proved "transient does not invalidate" would also
// pass on a holder that had stopped invalidating at all.

import { describe, test, expect } from 'vitest';
import { createCapabilityHolder } from '../../src/mcp-server/capability.js';
import { collabcastError } from '../../src/identity/errors.js';

const TOKEN = 'TrN4xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';

const SELF = {
  principalId: 'prn_01',
  role: 'goal_hub',
  displayAlias: 'builder',
  scopes: ['channel:read', 'channel:publish'],
  capabilityId: 'cap_01',
  expiresAt: '2030-01-01T00:00:00.000Z'
};

/**
 * An api whose `self` fails a set number of times before answering. `selfCalls` doubles as the
 * proof that a recovery did NOT go back through enrollment: `enrollExchange` is counted too,
 * and a re-enrollment is what burns a second operator approval.
 */
function api({ failures = 0, error = collabcastError('unavailable', 'the service is not listening') } = {}) {
  const counts = { self: 0, enrollExchange: 0 };
  return {
    counts,
    self: async () => {
      counts.self += 1;
      if (counts.self <= failures) throw error;
      return SELF;
    },
    enrollExchange: async () => {
      counts.enrollExchange += 1;
      return { token: TOKEN };
    },
    principals: async () => ({ principals: [] })
  };
}

function holderFor(stub, env = {}) {
  const tokenBox = { value: null };
  const holder = createCapabilityHolder({
    api: stub,
    tokenBox,
    namespace: 'collabcast-test',
    env,
    warn: () => {}
  });
  return { holder, tokenBox };
}

/** Every non-refusal a real client can produce out of `GET /self`. */
const TRANSIENT = [
  // `unavailable` is what src/client/api.js raises for ECONNREFUSED / ENOENT / timeout.
  collabcastError('unavailable', 'the collabcast-svc service is not accepting connections'),
  // `internal` is the socket failure it cannot classify, and an unreadable 5xx body.
  collabcastError('internal', 'the collabcast service connection failed'),
  // Not a CollabcastError at all: a driver-level throw must be the most conservative case of all.
  new TypeError('socket hang up')
];

/** Answers that really are the server refusing this credential. */
const REFUSALS = [
  collabcastError('unauthenticated', 'capability not accepted'),
  collabcastError('forbidden', 'this principal may not resolve itself'),
  collabcastError('wrong_namespace', 'that capability belongs to another channel')
];

describe('adopt: a transient GET /self failure', () => {
  test.each(TRANSIENT)('keeps the credential and does not re-enroll (%s)', async (error) => {
    const stub = api({ failures: 1, error });
    const { holder, tokenBox } = await holderFor(stub);

    await expect(holder.adopt(TOKEN)).rejects.toThrow();

    // The capability is still held: the token is in the box, so the live capability in the
    // store is not orphaned and the operator approval that bought it is not wasted.
    expect(tokenBox.value).toBe(TOKEN);
    expect(holder.state()).toBe('unverified');
    expect(stub.counts.enrollExchange).toBe(0);

    // ...and it is usable the moment the service answers, with no new approval.
    const identity = await holder.revalidate();
    expect(identity.principalId).toBe(SELF.principalId);
    expect(holder.state()).toBe('active');
    expect(stub.counts.enrollExchange).toBe(0);
    expect(holder.requireActive().capabilityId).toBe('cap_01');
  });

  test.each(TRANSIENT)('surfaces a distinguishable, non-refusal error (%s)', async (error) => {
    const stub = api({ failures: 1, error });
    const { holder } = await holderFor(stub);

    const thrown = await holder.adopt(TOKEN).catch((err) => err);
    // NOT `unauthenticated`. That is the whole point: a model must be able to tell
    // "the service isn't there, retry" from "your credential was refused, re-enroll".
    expect(thrown.code).not.toBe('unauthenticated');
    expect(thrown.code).toBe(error.code ?? 'internal');
    expect(thrown.detail).toMatchObject({ capabilityState: 'unverified', credentialRetained: true });
    expect(thrown.message).not.toContain(TOKEN);

    // And the message the tools will show says "do not enroll again" rather than the opposite.
    const blocked = (() => {
      try {
        holder.requireActive();
      } catch (err) {
        return err;
      }
    })();
    expect(blocked.code).toBe('unavailable');
    expect(blocked.message).toMatch(/do NOT call collabcast_enroll/);
    expect(blocked.message).not.toMatch(/expired or revoked/);
    expect(blocked.detail).toEqual({ capabilityState: 'unverified' });
  });
});

describe('adopt: a genuine refusal still invalidates, exactly as before', () => {
  test.each(REFUSALS)('discards the credential (%s)', async (error) => {
    const stub = api({ failures: 1, error });
    const { holder, tokenBox } = await holderFor(stub);

    const thrown = await holder.adopt(TOKEN).catch((err) => err);
    expect(thrown.code).toBe(error.code);

    expect(tokenBox.value).toBeNull();
    expect(holder.state()).toBe('invalid');
    expect(holder.identity()).toBeNull();

    // The advice for a refused credential IS to enroll again, and `revalidate` must not
    // pretend a discarded token can be re-confirmed.
    const blocked = await holder.revalidate().catch((err) => err);
    expect(blocked.code).toBe('unauthenticated');
    expect(blocked.message).toMatch(/expired or revoked/);
    expect(blocked.message).toMatch(/collabcast_enroll/);
  });
});

describe('adoptInjected: the same rule, same both directions', () => {
  const env = { COLLABCAST_CAPABILITY: TOKEN };

  test.each(TRANSIENT)('a transient failure keeps the injected credential (%s)', async (error) => {
    const stub = api({ failures: 1, error });
    const { holder, tokenBox } = await holderFor(stub, env);

    await expect(holder.adoptInjected()).rejects.toThrow();
    expect(tokenBox.value).toBe(TOKEN);
    expect(holder.state()).toBe('unverified');

    expect((await holder.revalidate()).principalId).toBe(SELF.principalId);
    expect(holder.state()).toBe('active');
  });

  test.each(REFUSALS)('a refusal discards the injected credential (%s)', async (error) => {
    const stub = api({ failures: 1, error });
    const { holder, tokenBox } = await holderFor(stub, env);

    await expect(holder.adoptInjected()).rejects.toThrow();
    expect(tokenBox.value).toBeNull();
    expect(holder.state()).toBe('invalid');
  });

  test('nothing injected is still not an error', async () => {
    const stub = api();
    const { holder, tokenBox } = await holderFor(stub, {});
    expect(await holder.adoptInjected()).toBe(false);
    expect(tokenBox.value).toBeNull();
    expect(holder.state()).toBe('unenrolled');
    expect(stub.counts.self).toBe(0);
  });
});

describe('the states stay distinct', () => {
  test('a 401 arriving later still invalidates an unverified holder', async () => {
    const stub = api({ failures: 1 });
    const { holder, tokenBox } = await holderFor(stub);
    await holder.adopt(TOKEN).catch(() => {});
    expect(holder.state()).toBe('unverified');

    holder.noteUnauthenticated();
    expect(holder.state()).toBe('invalid');
    expect(tokenBox.value).toBeNull();
  });

  test('unenrolled is untouched: no credential means enroll, not retry', async () => {
    const stub = api();
    const { holder } = await holderFor(stub);
    const blocked = await holder.revalidate().catch((err) => err);
    expect(blocked.code).toBe('unauthenticated');
    expect(blocked.detail).toEqual({ capabilityState: 'unenrolled' });
    expect(stub.counts.self).toBe(0);
  });

  test('a persistent outage keeps the credential across repeated retries', async () => {
    const stub = api({ failures: 3 });
    const { holder, tokenBox } = await holderFor(stub);

    await holder.adopt(TOKEN).catch(() => {});
    await holder.revalidate().catch(() => {});
    await holder.revalidate().catch(() => {});
    expect(tokenBox.value).toBe(TOKEN);
    expect(holder.state()).toBe('unverified');

    expect((await holder.revalidate()).role).toBe('goal_hub');
    expect(stub.counts.self).toBe(4);
    expect(stub.counts.enrollExchange).toBe(0);
  });
});
