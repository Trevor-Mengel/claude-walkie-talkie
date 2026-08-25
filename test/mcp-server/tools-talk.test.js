// `walkie_talk` — posting, and what authorises it.
//
// The central assertion here is INVERTED from v0.2. That file opened with:
//
//     test('blocks autonomous talk when no permit; returns permit_required with hint', ...)
//
// A fresh session could not post until an operator granted a permit, and a `once` permit was
// consumed by the first post. The permit model is gone. It was never a security boundary: the
// permit was addressed by the self-declared `sessionId` in an unauthenticated request body, so
// the session being gated was also the party naming itself — and `autonomous: false` in the body
// bypassed the gate entirely.
//
// What replaced it is a standing authority: `channel:publish` on the caller's own capability,
// checked against a token the caller cannot mint. So the inverse of the v0.2 assertion is the
// property now under test — a capability WITH `channel:publish` posts, repeatedly, with no
// approval dance; a capability WITHOUT it is refused `scope_required` and cannot talk its way in.
//
// The third v0.2 property, unresolved-mention warnings, is preserved unchanged.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';

const ULID = /^[0-9A-Z]{26}$/;

describe('walkie_talk', () => {
  test('a capability holding channel:publish posts immediately, and keeps posting', async () => {
    const stack = await createStack({
      namespace: 'walkie-talk1',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.hub
    });
    try {
      const first = await client.talk('first words');
      expect(first.id).toMatch(ULID);
      expect(first.warnings).toEqual([]);
      // Nothing was consumed: v0.2's `once` permit made the second post fail.
      const second = await client.talk('second');
      expect(second.id).toMatch(ULID);
      const third = await client.talk('third');
      expect(third.id).toMatch(ULID);

      expect((await client.read({ limit: 5 })).messages.map((m) => m.body.trim())).toEqual([
        'third',
        'second',
        'first words'
      ]);
      // And no `permit_required` anywhere in the answer.
      expect(JSON.stringify(first)).not.toMatch(/permit/i);
    } finally {
      await client.close();
    }
  }, 20000);

  test('a capability WITHOUT channel:publish is refused scope_required', async () => {
    const stack = await createStack({
      namespace: 'walkie-talk2',
      roles: [
        'root',
        { name: 'reader', role: 'listener', scopes: ['channel:read', 'self:cursor'] }
      ]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.reader
    });
    try {
      const attempt = await client.callRaw('walkie_talk', { body: 'let me in' });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('scope_required');
      expect(attempt.payload.detail).toEqual({ scope: 'channel:publish' });
      expect(attempt.payload.hint).toMatch(/a new one must be issued/);

      // Reading still works: the refusal is scoped to the write, not the session.
      expect((await client.read({})).messages).toEqual([]);

      // The service agrees, and nothing was written.
      const raw = await stack.request('POST', '/channel/message', {
        token: stack.tokens.reader,
        body: { body: 'let me in' }
      });
      expect(raw.status).toBe(403);
      expect(raw.body.error.code).toBe('scope_required');
      const latest = await stack.request('GET', '/channel/latest', {
        token: stack.tokens.root
      });
      expect(latest.body.messages).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20000);

  test('a session cannot self-authorise by restating v0.2 authority fields', async () => {
    const stack = await createStack({
      namespace: 'walkie-talk3',
      roles: [
        'root',
        { name: 'reader', role: 'listener', scopes: ['channel:read', 'self:cursor'] }
      ]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.reader
    });
    try {
      // `autonomous: false` was v0.2's permit bypass. It is rejected at the tool boundary now,
      // before a request is even formed.
      const bypass = await client.callRaw('walkie_talk', {
        body: 'trust me',
        autonomous: false
      });
      expect(bypass.isError).toBe(true);
      expect(bypass.payload.code).toBe('invalid_request');
      expect(bypass.payload.detail).toEqual({ rejected: ['autonomous'] });

      const forged = await client.callRaw('walkie_talk', {
        body: 'trust me',
        fromSessionId: stack.principals.root.principalId,
        fromAlias: 'root'
      });
      expect(forged.isError).toBe(true);
      expect(forged.payload.code).toBe('invalid_request');
      expect(forged.payload.detail.rejected).toEqual(['fromSessionId', 'fromAlias']);

      const latest = await stack.request('GET', '/channel/latest', {
        token: stack.tokens.root
      });
      expect(latest.body.messages).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20000);

  test('surfaces unresolved-mention warnings', async () => {
    const stack = await createStack({
      namespace: 'walkie-talk4',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.hub
    });
    try {
      const parsed = await client.talk('@unknown please help');
      expect(parsed.warnings).toEqual([{ type: 'unresolved-mention', token: 'unknown' }]);
      // The message still posts: an unresolved mention is information, not a refusal.
      expect(parsed.id).toMatch(ULID);

      // A resolvable alias produces no warning and records the principal id.
      await client.rename('helper');
      const addressed = await stack.request('POST', '/channel/message', {
        token: stack.tokens.root,
        body: { body: '@helper and @nobody' }
      });
      expect(addressed.body.warnings).toEqual([
        { type: 'unresolved-mention', token: 'nobody' }
      ]);
      const inbox = await client.inbox();
      expect(inbox.mentionedForMe.map((m) => m.id)).toEqual([addressed.body.id]);
    } finally {
      await client.close();
    }
  }, 20000);

  test('type and reply_to are honoured; an unknown type is refused', async () => {
    const stack = await createStack({
      namespace: 'walkie-talk5',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.hub
    });
    try {
      const question = await client.talk('is this a question?', { type: 'question' });
      const answer = await client.talk('yes', { type: 'reply', reply_to: question.id });

      const fetched = await stack.request('GET', `/channel/message/${answer.id}`, {
        token: stack.tokens.root
      });
      expect(fetched.body.message.type).toBe('reply');
      expect(fetched.body.message.replyTo).toBe(question.id);

      const bogus = await client.callRaw('walkie_talk', { body: 'x', type: 'decree' });
      expect(bogus.isError).toBe(true);
      expect(bogus.payload.code).toBe('invalid_request');
    } finally {
      await client.close();
    }
  }, 20000);
});
