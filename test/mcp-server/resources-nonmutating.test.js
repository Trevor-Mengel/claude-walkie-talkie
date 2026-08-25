// Resource reads are passive.
//
// `walkie://channel/inbox` used to consume the read cursor. An MCP client may read a resource on
// its own initiative — on refresh, on reconnect, on a subscription notification — so a
// consuming read made messages disappear with nobody deciding to acknowledge them.

import { describe, test, expect } from 'vitest';
import { buildResources } from '../../src/mcp-server/resources.js';
import { createCapabilityHolder } from '../../src/mcp-server/capability.js';

const TOKEN = 'RrR9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
const SELF = {
  principalId: 'prn_01',
  role: 'goal_hub',
  displayAlias: 'builder',
  scopes: ['channel:read'],
  capabilityId: 'cap_01',
  expiresAt: null
};

function stubApi() {
  const calls = [];
  const api = {
    self: async () => {
      calls.push('self');
      return SELF;
    },
    inbox: async () => {
      calls.push('inbox');
      return {
        messages: [{ id: '01J000000000000000000000AA' }],
        mentionedForMe: [],
        lastReadId: '',
        lastAckedId: ''
      };
    },
    latest: async (limit, includeArchived) => {
      calls.push(`latest:${limit}:${includeArchived}`);
      return { messages: [] };
    },
    principals: async () => {
      calls.push('principals');
      return { principals: [{ id: 'prn_01', role: 'goal_hub', displayAlias: 'builder', createdAt: 't' }] };
    },
    markRead: async () => {
      calls.push('markRead');
      return { id: '01J000000000000000000000AA' };
    },
    ack: async () => {
      calls.push('ack');
      return { id: '01J000000000000000000000AA' };
    }
  };
  return { api, calls };
}

async function harness({ enrolled = true } = {}) {
  const { api, calls } = stubApi();
  const capability = createCapabilityHolder({
    api,
    tokenBox: { value: null },
    namespace: 'walkie-test',
    env: {},
    warn: () => {}
  });
  if (enrolled) await capability.adopt(TOKEN);
  const notifications = [];
  const resources = buildResources({
    server: { notification: (n) => notifications.push(n) },
    api,
    capability,
    events: async () => ({ close: () => {} })
  });
  return { resources, calls, notifications, capability };
}

describe('walkie:// resources', () => {
  test('the three resource URIs are stable', async () => {
    const { resources } = await harness();
    expect(resources.list().map((r) => r.uri).sort()).toEqual([
      'walkie://channel/inbox',
      'walkie://channel/recent',
      'walkie://sessions/active'
    ]);
  });

  test('reading the inbox resource writes no cursor, however many times it is read', async () => {
    const { resources, calls } = await harness();

    for (let i = 0; i < 3; i += 1) {
      const result = await resources.read({ params: { uri: 'walkie://channel/inbox' } });
      const payload = JSON.parse(result.contents[0].text);
      // Identical every time: nothing was consumed.
      expect(payload.messages).toHaveLength(1);
      expect(payload.lastReadId).toBe('');
    }

    expect(calls.filter((c) => c !== 'self')).toEqual(['inbox', 'inbox', 'inbox']);
    expect(calls).not.toContain('markRead');
    expect(calls).not.toContain('ack');
  });

  test('the roster resource reads the principal list', async () => {
    const { resources, calls } = await harness();
    const result = await resources.read({ params: { uri: 'walkie://sessions/active' } });
    expect(JSON.parse(result.contents[0].text).principals[0].displayAlias).toBe('builder');
    expect(calls).toContain('principals');
  });

  test('the recent resource asks for a bounded, unarchived window', async () => {
    const { resources, calls } = await harness();
    await resources.read({ params: { uri: 'walkie://channel/recent' } });
    expect(calls).toContain('latest:20:false');
  });

  test('an unenrolled session cannot read a resource, and says why', async () => {
    const { resources, calls } = await harness({ enrolled: false });
    await expect(
      resources.read({ params: { uri: 'walkie://channel/inbox' } })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(calls).toEqual([]);
  });

  test('an unknown resource is not_found rather than a bare Error', async () => {
    const { resources } = await harness();
    await expect(
      resources.read({ params: { uri: 'walkie://nope' } })
    ).rejects.toMatchObject({ code: 'not_found', name: 'WalkieError' });
  });

  test('a subscription notifies on other principals posts and stays quiet about our own', async () => {
    const { api } = stubApi();
    const capability = createCapabilityHolder({
      api,
      tokenBox: { value: null },
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    await capability.adopt(TOKEN);
    const notifications = [];
    let emit;
    const resources = buildResources({
      server: { notification: (n) => notifications.push(n) },
      api,
      capability,
      events: async (onEvent) => {
        emit = onEvent;
        return { close: () => {} };
      }
    });

    await resources.subscribe({ params: { uri: 'walkie://channel/inbox' } });
    emit('message.posted', { id: '01H', from: 'prn_01' });
    expect(notifications).toEqual([]);
    emit('message.posted', { id: '01I', from: 'prn_other' });
    expect(notifications).toEqual([
      {
        method: 'notifications/resources/updated',
        params: { uri: 'walkie://channel/inbox' }
      }
    ]);
  });
});

describe('alias refresh', () => {
  test('the holder re-reads its alias from the roster rather than caching a claim', async () => {
    const { api } = stubApi();
    const capability = createCapabilityHolder({
      api,
      tokenBox: { value: null },
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    await capability.adopt(TOKEN);
    expect(capability.identity().displayAlias).toBe('builder');

    api.principals = async () => ({
      principals: [{ id: 'prn_01', role: 'goal_hub', displayAlias: 'renamed-out-of-band', createdAt: 't' }]
    });
    expect(await capability.refreshAlias()).toBe('renamed-out-of-band');
    expect(capability.identity().displayAlias).toBe('renamed-out-of-band');
  });
});
