// `walkie://` resources, driven through a real MCP child against a real service.
//
// Three of the four v0.2 properties survive: the URI set is stable, `channel/recent` returns the
// latest messages, and a subscription produces `notifications/resources/updated` when a message
// arrives. The fourth changed shape — `walkie://sessions/active` used to prove "the auto-joined
// session is listed", and there is no auto-join and no session table, so it now proves the
// principal roster is served.
//
// And the property v0.2 could not have tested, because it was the bug: reading
// `walkie://channel/inbox` MOVES NO CURSOR. A resource read is a passive fetch an MCP client may
// perform on its own initiative — on refresh, on reconnect, on a subscription notification — so a
// consuming read made messages vanish with no model having decided to acknowledge them. This file
// asserts it against real cursor rows in the store, and re-reads to prove idempotence.
//
// `test/mcp-server/resources-nonmutating.test.js` covers the same invariant at unit level against
// a recording stub; this is the end-to-end counterpart, which is what catches a route that
// acknowledges server-side.

import { describe, test, expect } from 'vitest';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';

async function harness(namespace, extraRoles = []) {
  const stack = await createStack({
    namespace,
    roles: ['root', { name: 'hub', role: 'goal_hub' }, ...extraRoles]
  });
  const client = await spawnMockClient({
    env: stack.childEnv(),
    capability: stack.tokens.hub
  });
  return { stack, client };
}

async function postAsRoot(stack, body) {
  const res = await stack.request('POST', '/channel/message', {
    token: stack.tokens.root,
    body: { body }
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('walkie:// resources', () => {
  test('lists three resources', async () => {
    const { client } = await harness('walkie-res1');
    try {
      const resources = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual([
        'walkie://channel/inbox',
        'walkie://channel/recent',
        'walkie://sessions/active'
      ]);
      for (const resource of resources) {
        expect(resource.mimeType).toBe('application/json');
        expect(resource.description).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  }, 20000);

  test('reading channel/recent returns latest messages', async () => {
    const { stack, client } = await harness('walkie-res2');
    try {
      await postAsRoot(stack, 'hi');
      await postAsRoot(stack, 'and again');

      const payload = await client.readResource('walkie://channel/recent');
      expect(payload.messages.map((m) => m.body.trim())).toEqual(['and again', 'hi']);
    } finally {
      await client.close();
    }
  }, 20000);

  test('reading sessions/active returns the principal roster', async () => {
    const { stack, client } = await harness('walkie-res3');
    try {
      const payload = await client.readResource('walkie://sessions/active');
      // v0.2 asserted `payload.active` held an auto-joined session. There is no auto-join.
      expect(payload.active).toBeUndefined();
      const ids = payload.principals.map((p) => p.id).sort();
      expect(ids).toEqual(
        [stack.principals.root.principalId, stack.principals.hub.principalId].sort()
      );
    } finally {
      await client.close();
    }
  }, 20000);

  test('reading the inbox resource moves no cursor, however many times it is read', async () => {
    const { stack, client } = await harness('walkie-res4');
    const hubId = stack.principals.hub.principalId;
    try {
      await postAsRoot(stack, 'unread one');
      const two = await postAsRoot(stack, 'unread two');

      for (let i = 0; i < 3; i += 1) {
        const payload = await client.readResource('walkie://channel/inbox');
        expect(payload.messages.map((m) => m.body.trim())).toEqual([
          'unread one',
          'unread two'
        ]);
        expect(payload.lastReadId).toBe('');
        expect(payload.lastAckedId).toBe('');
        expect(stack.cursors(hubId)).toEqual({ read: '', ack: '' });
      }

      // Reading the OTHER resources cannot move it either.
      await client.readResource('walkie://channel/recent');
      await client.readResource('walkie://sessions/active');
      expect(stack.cursors(hubId)).toEqual({ read: '', ack: '' });

      // Only the explicit tool does.
      await client.ack(two);
      expect(stack.cursors(hubId)).toEqual({ read: two, ack: two });
      expect((await client.readResource('walkie://channel/inbox')).messages).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20000);

  test('subscribe emits resources/updated when another principal posts', async () => {
    const { stack, client } = await harness('walkie-res5');
    try {
      /** @type {string[]} */
      const updated = [];
      client.raw.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        updated.push(n.params.uri);
      });
      await client.subscribe('walkie://channel/inbox');

      await postAsRoot(stack, 'live');

      for (let i = 0; i < 40 && updated.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(updated).toContain('walkie://channel/inbox');

      // The notification is a nudge, not a delivery: the cursor is still where it was.
      expect(stack.cursors(stack.principals.hub.principalId)).toEqual({ read: '', ack: '' });
    } finally {
      await client.close();
    }
  }, 20000);

  test('a subscriber is not woken by its own post', async () => {
    const { stack, client } = await harness('walkie-res6');
    try {
      /** @type {string[]} */
      const updated = [];
      client.raw.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        updated.push(n.params.uri);
      });
      await client.subscribe('walkie://channel/inbox');

      await client.talk('my own words');
      await new Promise((r) => setTimeout(r, 300));
      expect(updated).toEqual([]);

      // But someone else's post still wakes it, so the stream is alive.
      await postAsRoot(stack, 'from root');
      for (let i = 0; i < 40 && updated.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(updated).toContain('walkie://channel/inbox');
    } finally {
      await client.close();
    }
  }, 20000);

  test('an unknown resource is not_found rather than a crash', async () => {
    const { client } = await harness('walkie-res7');
    try {
      await expect(client.readResource('walkie://channel/secrets')).rejects.toThrow(
        /no walkie resource/
      );
    } finally {
      await client.close();
    }
  }, 20000);
});
