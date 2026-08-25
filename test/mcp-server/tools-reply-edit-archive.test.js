// `walkie_reply` / `walkie_edit` / `walkie_archive`.
//
// The three v0.2 properties are preserved: a reply carries `type: 'reply'` and its `replyTo`, an
// edit of your own message bumps the revision, and an archived message drops out of a default
// read. What is gone from the setup is the permit dance every one of them opened with —
//
//     const me = (await http.sessions()).active[0];
//     await http.grantPermit({ sessionId: me.sessionId, mode: 'always' });
//
// — which is how v0.2 authorised a write: look up whoever happens to be first in a public session
// list, then grant them blanket permission over an unauthenticated route. Writing is now the
// `channel:publish` scope on the caller's own capability.
//
// Added here, because v0.2 had no coverage for it at all: the cross-owner refusal. `PATCH
// /channel/message/:id` has no operator override by design — an operator may moderate by
// archiving, but nobody, operator included, may rewrite another principal's words.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';

const ULID = /^[0-9A-Z]{26}$/;

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

describe('walkie_reply / walkie_edit / walkie_archive', () => {
  test('reply sets type=reply and replyTo', async () => {
    const { stack, client } = await harness('walkie-red1');
    try {
      const seed = await stack.request('POST', '/channel/message', {
        token: stack.tokens.root,
        body: { body: 'q?', type: 'question' }
      });
      expect(seed.status).toBe(201);

      const parsed = await client.reply(seed.body.id, 'answer');
      expect(parsed.id).toMatch(ULID);

      const fetched = await stack.request(
        'GET',
        `/channel/message/${encodeURIComponent(parsed.id)}`,
        { token: stack.tokens.root }
      );
      expect(fetched.status).toBe(200);
      expect(fetched.body.message.type).toBe('reply');
      expect(fetched.body.message.replyTo).toBe(seed.body.id);
      // Authorship is the capability's principal, not a string the client chose.
      expect(fetched.body.message.fromSessionId).toBe(stack.principals.hub.principalId);
    } finally {
      await client.close();
    }
  }, 20000);

  test('edit bumps revision on own message', async () => {
    const { stack, client } = await harness('walkie-red2');
    try {
      const posted = await client.talk('original');
      const edited = await client.edit(posted.id, 'revised');
      expect(edited).toEqual({ id: posted.id, revision: 1 });

      const again = await client.edit(posted.id, 'revised twice');
      expect(again.revision).toBe(2);

      const fetched = await stack.request(
        'GET',
        `/channel/message/${encodeURIComponent(posted.id)}`,
        { token: stack.tokens.root }
      );
      expect(fetched.body.message.body.trim()).toBe('revised twice');
      // The prior bodies are preserved rather than overwritten.
      expect(fetched.body.history.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  }, 20000);

  test('archive marks the message and excludes it from default reads', async () => {
    const { client } = await harness('walkie-red3');
    try {
      const posted = await client.talk('temp');
      const archived = await client.archive(posted.id, 'test');
      expect(archived).toEqual({ ok: true });

      const read = await client.read({});
      expect(read.messages.find((m) => m.id === posted.id)).toBeUndefined();

      const withArchived = await client.read({ include_archived: true });
      expect(withArchived.messages.find((m) => m.id === posted.id)?.archived).toBe(true);
    } finally {
      await client.close();
    }
  }, 20000);

  test('a different principal cannot edit the first principal\'s message: 403 not_owner', async () => {
    const { stack, client } = await harness('walkie-red4', [
      { name: 'other', role: 'goal_hub' }
    ]);
    const other = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.other
    });
    try {
      const posted = await client.talk('mine, not yours');

      const attempt = await other.callRaw('walkie_edit', { id: posted.id, body: 'hijacked' });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('not_owner');
      expect(attempt.payload.detail).toEqual({ id: posted.id });
      expect(attempt.payload.hint).toMatch(/reply to it instead/);

      // The refusal is at the service, so the stored body is untouched.
      const raw = await stack.request('PATCH', `/channel/message/${posted.id}`, {
        token: stack.tokens.other,
        body: { body: 'hijacked' }
      });
      expect(raw.status).toBe(403);
      expect(raw.body.error.code).toBe('not_owner');

      const fetched = await stack.request('GET', `/channel/message/${posted.id}`, {
        token: stack.tokens.root
      });
      expect(fetched.body.message.body.trim()).toBe('mine, not yours');
      expect(fetched.body.message.revision ?? 0).toBe(0);
    } finally {
      await other.close();
      await client.close();
    }
  }, 25000);

  test('archiving another principal\'s message is not_owner, but an operator may moderate', async () => {
    const { stack, client } = await harness('walkie-red5', [
      { name: 'other', role: 'goal_hub' },
      'operator'
    ]);
    const other = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.other
    });
    try {
      const posted = await client.talk('moderate me');

      const attempt = await other.callRaw('walkie_archive', { id: posted.id });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('not_owner');
      expect(attempt.payload.hint).toMatch(/operator moderating the channel/);

      // Editing has no operator override; archiving does.
      const operatorEdit = await stack.request('PATCH', `/channel/message/${posted.id}`, {
        token: stack.tokens.operator,
        body: { body: 'rewritten by the operator' }
      });
      expect(operatorEdit.status).toBe(403);
      expect(operatorEdit.body.error.code).toBe('not_owner');

      const operatorArchive = await stack.request(
        'POST',
        `/channel/message/${posted.id}/archive`,
        { token: stack.tokens.operator, body: { reason: 'moderated' } }
      );
      expect(operatorArchive.status).toBe(200);
      expect((await client.read({})).messages.find((m) => m.id === posted.id)).toBeUndefined();
    } finally {
      await other.close();
      await client.close();
    }
  }, 25000);
});
