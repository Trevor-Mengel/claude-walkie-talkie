// `collabcast_ack` must report what actually applied.
//
// Wave F finding. `collabcast_ack` performs two cursor writes — `markRead` then `ack` — and used to
// do it like this:
//
//     if (markRead) result.lastReadId = (await api.markRead(id)).id;
//     result.lastAckedId = (await api.ack(id)).id;
//
// If the second call threw, the whole tool returned a flat `{ status: 'error', ... }`. But the
// first call had already committed. So "read cursor moved, nothing acknowledged" and "nothing
// happened at all" produced the same answer, and the only safe reading of an error — retry the
// whole thing — was wrong: the read cursor had already advanced past messages that were never
// acknowledged, so a retry could not recover them and a re-read would not show them.
//
// Two properties are pinned here:
//   1. the ORDER. Acknowledgement commits first, because a lost read-cursor move costs a
//      re-read while a lost ack makes the caller replay work it has already done.
//   2. the REPORT. A partial apply says so, names which half failed and why, and still carries
//      the id that did land — so the caller can retry the failed half alone.

import { describe, test, expect } from 'vitest';
import { buildTools } from '../../src/mcp-server/tools.js';
import { createCapabilityHolder } from '../../src/mcp-server/capability.js';
import { collabcastError } from '../../src/identity/errors.js';

const TOKEN = 'AkP7xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
const ACK_ID = '01J000000000000000000000AA';

const SELF = {
  principalId: 'prn_01',
  role: 'goal_hub',
  displayAlias: 'builder',
  scopes: ['channel:read', 'channel:ack', 'self:cursor'],
  capabilityId: 'cap_01',
  expiresAt: '2030-01-01T00:00:00.000Z'
};

/** @param {{markRead?:Function, ack?:Function}} [overrides] */
function stubApi(overrides = {}) {
  const names = [];
  const api = {
    self: async () => SELF,
    ack: async (...args) => {
      names.push('ack');
      return overrides.ack ? overrides.ack(...args) : { id: ACK_ID };
    },
    markRead: async (...args) => {
      names.push('markRead');
      return overrides.markRead ? overrides.markRead(...args) : { id: ACK_ID };
    }
  };
  api.names = () => names;
  return api;
}

async function toolsFor(api) {
  const holder = createCapabilityHolder({
    api,
    tokenBox: { value: null },
    namespace: 'collabcast-test',
    env: {},
    warn: () => {}
  });
  await holder.adopt(TOKEN);
  return buildTools({ api, capability: holder, namespace: 'collabcast-test' });
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function callAck(tools, args) {
  return tools.call({ params: { name: 'collabcast_ack', arguments: args } });
}

describe('collabcast_ack partial success', () => {
  test('the ack commits before the read cursor moves', async () => {
    const api = stubApi();
    const result = await callAck(await toolsFor(api), { id: ACK_ID });

    expect(api.names()).toEqual(['ack', 'markRead']);
    expect(payloadOf(result)).toEqual({
      status: 'acknowledged',
      lastAckedId: ACK_ID,
      lastReadId: ACK_ID
    });
  });

  test('a failed read-cursor move is a partial success, not a total failure', async () => {
    const api = stubApi({
      markRead: () => Promise.reject(collabcastError('conflict', 'the read cursor only moves forward'))
    });
    const result = await callAck(await toolsFor(api), { id: ACK_ID });

    const payload = payloadOf(result);
    // The distinguishing assertion: NOT `status: 'error'`, and the acked id survives, so the
    // caller knows not to replay the messages it already acknowledged.
    expect(payload.status).toBe('partially_acknowledged');
    expect(payload.lastAckedId).toBe(ACK_ID);
    // The half that failed is named, with a code the caller can branch on.
    expect(payload.markRead).toEqual({
      applied: false,
      code: 'conflict',
      message: 'the read cursor only moves forward'
    });
    // And no phantom read cursor is reported.
    expect(payload.lastReadId).toBeUndefined();
    // Both calls really were attempted, in order.
    expect(api.names()).toEqual(['ack', 'markRead']);
  });

  test('an unexpected throw from markRead is still a partial success, and leaks nothing', async () => {
    const api = stubApi({
      // A driver-level throw. Its message can carry a socket path or a bound parameter, which
      // this surface never surfaces — the same rule as `errorResult`'s non-collabcast branch.
      markRead: () => Promise.reject(new TypeError('connect ECONNREFUSED /tmp/collabcast-secret.sock'))
    });
    const result = await callAck(await toolsFor(api), { id: ACK_ID });

    const payload = payloadOf(result);
    expect(payload.status).toBe('partially_acknowledged');
    expect(payload.lastAckedId).toBe(ACK_ID);
    expect(payload.markRead.applied).toBe(false);
    expect(payload.markRead.code).toBe('internal');
    expect(result.content[0].text).not.toContain('/tmp/collabcast-secret.sock');
    expect(result.content[0].text).not.toContain('ECONNREFUSED');
  });

  test('a failed ack applies nothing, so it is a plain error and the read cursor is untouched', async () => {
    const api = stubApi({
      ack: () => Promise.reject(collabcastError('forbidden', 'this capability may not acknowledge'))
    });
    const result = await callAck(await toolsFor(api), { id: ACK_ID });

    const payload = payloadOf(result);
    // Nothing applied, so "total failure" is the honest report — and the read cursor must not
    // have been moved on the way to it.
    expect(payload.status).toBe('error');
    expect(payload.code).toBe('forbidden');
    expect(api.names()).toEqual(['ack']);
  });

  test('mark_read:false has one call and cannot be partial', async () => {
    const api = stubApi({
      markRead: () => Promise.reject(collabcastError('conflict', 'should never be called'))
    });
    const result = await callAck(await toolsFor(api), { id: ACK_ID, mark_read: false });

    expect(payloadOf(result)).toEqual({ status: 'acknowledged', lastAckedId: ACK_ID });
    expect(api.names()).toEqual(['ack']);
  });
});
