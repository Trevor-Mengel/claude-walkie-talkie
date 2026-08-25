// `collabcast_sessions` / `collabcast_rename` — the principal roster and the alias claim.
//
// The tool NAMES are preserved for compatibility, but what they talk to changed completely, so
// both v0.2 assertions had to be rewritten rather than adjusted:
//
//   - v0.2: `parsed.active` contained an entry whose `tool` was `'claude-code'`, because the
//     child had declared that at `POST /sessions/join`. There is no session table and no
//     self-declared tool; `collabcast_sessions` returns `{ principals: [...] }` off `GET /principals`,
//     and `tool` is derived from the role by the server.
//   - v0.2: rename "updates this session alias" via `POST /sessions/:id/rename`, which took the
//     target from the path — so any session could rename any other — and, on collision, renamed
//     the incumbent out of the way, which made alias theft a supported operation. Renaming is now
//     own-principal-only (`POST /self/alias`) and a collision is a 409 that leaves the incumbent
//     alone.
//
// The collision case is new coverage: v0.2 could not have had it, because there was nothing to
// collide with.

import { describe, test, expect } from 'vitest';
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

describe('collabcast_sessions', () => {
  test('returns the principal roster, including self, with roles and aliases', async () => {
    const { stack, client } = await harness('collabcast-sr1', [
      { name: 'listener', role: 'listener' }
    ]);
    try {
      const parsed = await client.sessions();
      // The shape, not just the contents: `active` is gone.
      expect(Object.keys(parsed)).toEqual(['principals']);
      expect(parsed.active).toBeUndefined();

      const byId = new Map(parsed.principals.map((p) => [p.id, p]));
      expect(byId.get(stack.principals.root.principalId).role).toBe('root');
      expect(byId.get(stack.principals.hub.principalId).role).toBe('goal_hub');
      expect(byId.get(stack.principals.listener.principalId).role).toBe('listener');

      // Presentation only. A roster that leaked capability ids or agent ids would hand every
      // reader the material for a targeted revocation.
      for (const principal of parsed.principals) {
        expect(Object.keys(principal).sort()).toEqual([
          'createdAt',
          'displayAlias',
          'id',
          'role'
        ]);
      }
    } finally {
      await client.close();
    }
  }, 20000);

  test('a session cannot declare its own tool; the server derives it from the role', async () => {
    const { stack, client } = await harness('collabcast-sr2');
    try {
      // v0.2 read this straight off `COLLABCAST_TOOL`. Setting it now changes nothing.
      const declaring = await spawnMockClient({
        env: stack.childEnv({ COLLABCAST_TOOL: 'claude-code', COLLABCAST_ALIAS: 'impostor' }),
        capability: stack.tokens.hub
      });
      try {
        const roster = await declaring.sessions();
        expect(roster.principals.some((p) => p.displayAlias === 'impostor')).toBe(false);

        const self = await stack.request('GET', '/self', { token: stack.tokens.hub });
        expect(self.body.tool).toBe('omp');
        expect(self.body.displayAlias).toBe(null);
      } finally {
        await declaring.close();
      }
    } finally {
      await client.close();
    }
  }, 25000);
});

describe('collabcast_rename', () => {
  test('renames this principal and nobody else', async () => {
    const { stack, client } = await harness('collabcast-sr3', [
      { name: 'other', role: 'goal_hub' }
    ]);
    try {
      const renamed = await client.rename('demo-builder');
      expect(renamed).toEqual({
        id: stack.principals.hub.principalId,
        displayAlias: 'demo-builder'
      });

      const roster = await client.sessions();
      const mine = roster.principals.find((p) => p.id === stack.principals.hub.principalId);
      expect(mine.displayAlias).toBe('demo-builder');
      // Everyone else is untouched.
      for (const principal of roster.principals) {
        if (principal.id === mine.id) continue;
        expect(principal.displayAlias).toBe(null);
      }
    } finally {
      await client.close();
    }
  }, 20000);

  test('an alias already in use is a 409 conflict and the incumbent keeps it', async () => {
    const { stack, client } = await harness('collabcast-sr4', [
      { name: 'other', role: 'goal_hub' }
    ]);
    const other = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.other
    });
    try {
      await client.rename('taken');

      const attempt = await other.callRaw('collabcast_rename', { alias: 'taken' });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('conflict');
      expect(attempt.payload.hint).toMatch(/will not be taken from them/);

      const raw = await stack.request('POST', '/self/alias', {
        token: stack.tokens.other,
        body: { alias: 'taken' }
      });
      expect(raw.status).toBe(409);
      expect(raw.body.error.code).toBe('conflict');

      // The incumbent still holds it and the challenger still holds nothing.
      const roster = await client.sessions();
      const holder = roster.principals.find((p) => p.displayAlias === 'taken');
      expect(holder.id).toBe(stack.principals.hub.principalId);
      const challenger = roster.principals.find(
        (p) => p.id === stack.principals.other.principalId
      );
      expect(challenger.displayAlias).toBe(null);
    } finally {
      await other.close();
      await client.close();
    }
  }, 25000);

  test('renaming is gated on self:alias, so a capability without it is refused', async () => {
    const stack = await createStack({
      namespace: 'collabcast-sr5',
      roles: [
        'root',
        { name: 'noAlias', role: 'goal_hub', scopes: ['channel:read', 'channel:publish'] }
      ]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.noAlias
    });
    try {
      const attempt = await client.callRaw('collabcast_rename', { alias: 'nope' });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('scope_required');
      expect(attempt.payload.detail).toEqual({ scope: 'self:alias' });
    } finally {
      await client.close();
    }
  }, 20000);

  test('an alias claimed by rename becomes a resolvable @mention target', async () => {
    const { stack, client } = await harness('collabcast-sr6');
    try {
      await client.rename('slide-designer');
      const posted = await stack.request('POST', '/channel/message', {
        token: stack.tokens.root,
        body: { body: '@slide-designer can you take this?', type: 'question' }
      });
      expect(posted.status).toBe(201);
      expect(posted.body.warnings).toEqual([]);

      const inbox = await client.inbox();
      expect(inbox.mentionedForMe.map((m) => m.id)).toEqual([posted.body.id]);
      // Mentions are stored as principal ids, so a later rename cannot redirect them.
      expect(inbox.mentionedForMe[0].mentions).toEqual([stack.principals.hub.principalId]);
    } finally {
      await client.close();
    }
  }, 20000);
});
