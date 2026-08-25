// `walkie_read`: the newest-first window, and the archived-message opt-in.
//
// Both properties are v0.2's and both are preserved verbatim. What changed underneath is how the
// messages get there: v0.2 posted them with `clientForProject(root).post({ fromSessionId:
// 'operator', ... })` — authorship stated in the request body — and read them back through a
// child that had auto-joined from `WALKIE_TOOL`. Now the poster authenticates with a real
// capability and authorship is derived from it, so this file also incidentally proves the
// ordering survives the identity cutover.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';

/** Boots a stack plus a connected reader holding a goal_hub capability. */
async function harness(namespace) {
  const stack = await createStack({
    namespace,
    roles: ['root', { name: 'hub', role: 'goal_hub' }]
  });
  const client = await spawnMockClient({
    env: stack.childEnv(),
    capability: stack.tokens.hub
  });
  return { stack, client };
}

/** Post as root, over the socket, with a real bearer. */
async function post(stack, body) {
  const res = await stack.request('POST', '/channel/message', {
    token: stack.tokens.root,
    body: { body }
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('walkie_read', () => {
  test('returns the latest N messages newest-first', async () => {
    const { stack, client } = await harness('walkie-read1');
    try {
      for (const body of ['m1', 'm2', 'm3']) await post(stack, body);

      const parsed = await client.read({ limit: 2 });
      expect(parsed.messages.length).toBe(2);
      expect(parsed.messages[0].body.trim()).toBe('m3');
      expect(parsed.messages[1].body.trim()).toBe('m2');

      // The window is a window, not a page: a wider limit shows the whole channel in the
      // same order.
      const all = await client.read({ limit: 10 });
      expect(all.messages.map((m) => m.body.trim())).toEqual(['m3', 'm2', 'm1']);
    } finally {
      await client.close();
    }
  }, 20000);

  test('include_archived=true returns archived messages too', async () => {
    const { stack, client } = await harness('walkie-read2');
    try {
      const id = await post(stack, 'gone');
      const archived = await stack.request('POST', `/channel/message/${id}/archive`, {
        token: stack.tokens.root,
        body: { reason: 'cleanup' }
      });
      expect(archived.status).toBe(200);

      const without = await client.read({});
      expect(without.messages.length).toBe(0);

      const withArchived = await client.read({ include_archived: true });
      expect(withArchived.messages.length).toBe(1);
      expect(withArchived.messages[0].id).toBe(id);
      expect(withArchived.messages[0].archived).toBe(true);
    } finally {
      await client.close();
    }
  }, 20000);

  test('reading is authorship-blind but never anonymous: the author is the posting principal', async () => {
    const { stack, client } = await harness('walkie-read3');
    try {
      await post(stack, 'from root');
      await client.talk('from the hub');

      const parsed = await client.read({ limit: 2 });
      const authors = parsed.messages.map((m) => m.fromSessionId);
      expect(authors).toEqual([
        stack.principals.hub.principalId,
        stack.principals.root.principalId
      ]);
      // No message may claim an author string the caller chose.
      expect(authors).not.toContain('operator');
    } finally {
      await client.close();
    }
  }, 20000);
});
