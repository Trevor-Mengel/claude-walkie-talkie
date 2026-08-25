// `collabcast_inbox` is NON-MUTATING. This assertion is deliberately the inverse of v0.2's.
//
// The v0.2 test read:
//
//     test('returns the operator-posted message and then returns empty', ...)
//
// It posted one message, called `collabcast_inbox` twice, and asserted the second call saw nothing.
// That was consume-on-read, and it was the bug: `GET /sessions/:id/inbox` advanced the addressed
// session's read cursor as a side effect of answering. Three consequences followed —
//
//   1. any caller could empty anyone else's queue by naming their session id in a URL;
//   2. a client that crashed while processing the response lost every message it had been handed,
//      with no way to ask for them again;
//   3. an MCP client polling a subscribable resource silently acknowledged traffic no model had
//      looked at.
//
// So the property is inverted here: reading is idempotent, and the ONLY thing that advances a
// cursor is an explicit `collabcast_ack`. The old assertion survives in a different place — after the
// ack, the inbox is empty, which is what "then returns empty" should always have meant.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';

async function harness(namespace) {
  const stack = await createStack({
    namespace,
    roles: ['root', { name: 'hub', role: 'goal_hub' }]
  });
  const client = await spawnMockClient({
    env: stack.childEnv(),
    capability: stack.tokens.hub
  });
  return { stack, client, hub: stack.principals.hub };
}

async function postAsRoot(stack, body, type) {
  const payload = { body };
  if (type !== undefined) payload.type = type;
  const res = await stack.request('POST', '/channel/message', {
    token: stack.tokens.root,
    body: payload
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('collabcast_inbox', () => {
  test('returns the posted message, and keeps returning it: reading acknowledges nothing', async () => {
    const { stack, client, hub } = await harness('collabcast-inbox1');
    try {
      await postAsRoot(stack, 'hello');

      const first = await client.inbox();
      expect(first.messages.length).toBe(1);
      expect(first.messages[0].body.trim()).toBe('hello');
      expect(first.lastReadId).toBe('');
      expect(first.lastAckedId).toBe('');

      // INVERTED from v0.2, which asserted this was empty.
      const second = await client.inbox();
      expect(second.messages.length).toBe(1);
      expect(second.messages[0].id).toBe(first.messages[0].id);

      const third = await client.inbox();
      expect(third.messages.length).toBe(1);

      // And nothing was written: not the read cursor, not the ack cursor.
      expect(stack.cursors(hub.principalId)).toEqual({ read: '', ack: '' });
    } finally {
      await client.close();
    }
  }, 20000);

  test('an explicit collabcast_ack is what advances the cursors and empties the inbox', async () => {
    const { stack, client, hub } = await harness('collabcast-inbox2');
    try {
      await postAsRoot(stack, 'first');
      await postAsRoot(stack, 'second');

      const before = await client.inbox();
      const bodies = before.messages.map((m) => m.body.trim());
      expect(bodies).toEqual(['first', 'second']);
      // An inbox is a queue: oldest first, so the client acks the id of the last message
      // it processed. No ordinal is served — an ordinal was a value that silently moved.
      expect(before.messages.every((m) => m.seq === undefined)).toBe(true);
      const second_ = before.messages[1].id;

      const acked = await client.ack(second_);
      expect(acked).toEqual({
        status: 'acknowledged',
        lastReadId: second_,
        lastAckedId: second_
      });
      expect(stack.cursors(hub.principalId)).toEqual({ read: second_, ack: second_ });

      const after = await client.inbox();
      expect(after.messages).toEqual([]);
      expect(after.lastAckedId).toBe(second_);

      // A later message is delivered again; the cursor gates, it does not silence.
      await postAsRoot(stack, 'third');
      const next = await client.inbox();
      expect(next.messages.map((m) => m.body.trim())).toEqual(['third']);
    } finally {
      await client.close();
    }
  }, 20000);

  test('acking an earlier id is a safe no-op, so a retry cannot rewind the queue', async () => {
    const { stack, client, hub } = await harness('collabcast-inbox3');
    try {
      const a = await postAsRoot(stack, 'a');
      const b = await postAsRoot(stack, 'b');
      await client.ack(b);

      const replay = await client.ack(a);
      expect(replay).toEqual({ status: 'acknowledged', lastReadId: b, lastAckedId: b });
      expect(stack.cursors(hub.principalId)).toEqual({ read: b, ack: b });
      expect((await client.inbox()).messages).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20000);

  test('mark_read=false acknowledges without moving the read cursor', async () => {
    const { stack, client, hub } = await harness('collabcast-inbox4');
    try {
      const only = await postAsRoot(stack, 'only');

      const acked = await client.ack(only, { mark_read: false });
      expect(acked).toEqual({ status: 'acknowledged', lastAckedId: only });
      expect(acked.lastReadId).toBeUndefined();
      expect(stack.cursors(hub.principalId)).toEqual({ read: '', ack: only });
    } finally {
      await client.close();
    }
  }, 20000);

  test("one principal's ack leaves every other principal's inbox untouched", async () => {
    const stack = await createStack({
      namespace: 'collabcast-inbox5',
      roles: [
        'root',
        { name: 'hub', role: 'goal_hub' },
        { name: 'other', role: 'goal_hub' }
      ]
    });
    const hub = await spawnMockClient({ env: stack.childEnv(), capability: stack.tokens.hub });
    const other = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.other
    });
    try {
      const posted = await postAsRoot(stack, 'for everyone');
      await hub.ack(posted);

      expect((await hub.inbox()).messages).toEqual([]);
      // v0.2's consuming read let any caller burn another session's queue. It cannot be
      // expressed now: the cursor moved is always the caller's own.
      expect((await other.inbox()).messages.map((m) => m.body.trim())).toEqual(['for everyone']);
      expect(stack.cursors(stack.principals.other.principalId)).toEqual({ read: '', ack: '' });
    } finally {
      await hub.close();
      await other.close();
    }
  }, 25000);

  // The MCP twin of the route-level blind spot: this used to post two messages with NO ack
  // between them, so the cutoff filtered nothing and it passed identically whether the
  // category filter ran before or after it. The acked case is the whole point, and it is
  // here rather than in a sibling test so the blind spot cannot survive the repair.
  test('memory updates are excluded by default, included on request, and survive an ack', async () => {
    const { stack, client, hub } = await harness('collabcast-inbox6');
    try {
      const one = await postAsRoot(stack, 'ordinary');
      const noted = await postAsRoot(stack, 'remember this', 'memory-update');
      const three = await postAsRoot(stack, 'later');

      expect((await client.inbox()).messages.map((m) => m.body.trim())).toEqual([
        'ordinary',
        'later'
      ]);
      expect(
        (await client.inbox({ include_memory_updates: true })).messages.map((m) => m.body.trim())
      ).toEqual(['ordinary', 'remember this', 'later']);

      // Ack the last message the model was actually handed — exactly what the collabcast_ack
      // description instructs. Under one shared mark this buried `noted` for good.
      await client.ack(three);
      expect((await client.inbox()).messages).toEqual([]);
      expect(stack.cursors(hub.principalId)).toEqual({ read: three, ack: three });

      const inclusive = await client.inbox({ include_memory_updates: true });
      expect(inclusive.messages.map((m) => m.id)).toContain(noted);
      // The inclusive view's own marks are still at the beginning, and reported so the
      // model can tell "not yet acked here" from "lost".
      expect(inclusive.cursors.withMemoryUpdates).toEqual({ lastReadId: '', lastAckedId: '' });
      expect(inclusive.cursors.default).toEqual({ lastReadId: three, lastAckedId: three });

      // Acking THAT view empties it, and is reachable from the tool rather than only from
      // the HTTP route — a flag no client can set would be an unreachable fix.
      const acked = await client.ack(three, { include_memory_updates: true });
      expect(acked.status).toBe('acknowledged');
      expect((await client.inbox({ include_memory_updates: true })).messages).toEqual([]);
      expect((await client.inbox()).messages).toEqual([]);
      expect(one < noted && noted < three).toBe(true);
    } finally {
      await client.close();
    }
  }, 25000);
});
