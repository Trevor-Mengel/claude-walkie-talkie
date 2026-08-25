// The flagship end-to-end scenario: two REAL principals on one channel, and the four boundaries
// that decide whether the v0.3 authority model actually holds.
//
// v0.2's version of this file walked `join -> talk -> mention -> reply -> edit -> archive ->
// invite -> fulfill` between two MCP children that differed only by the `COLLABCAST_TOOL` string they
// declared at `POST /sessions/join`. Every step of that is now either impossible or means
// something else:
//
//   - there is no join, and no self-declared tool. A session's identity is the capability it was
//     handed, so "two clients" now means two genuinely distinct principals with distinct
//     capabilities — not one identity impersonated twice.
//   - `op.grantPermit({ sessionId })` authorised writes by naming a session id in an
//     unauthenticated body. Publishing is the `channel:publish` scope now.
//   - `op.invite('codex-helper')` reserved an alias for someone who had not enrolled. An alias is
//     claimed by a principal that exists, or not at all.
//
// So this walks the path that replaced it, and asserts the things the old walk could not:
//
//   1. enrollment really is operator-gated: the hook's NDJSON request to the authority socket
//      produces a one-use code, and `POST /enroll/exchange` is the only thing that turns a code
//      into a capability.
//   2. delegation really narrows: the root mints a goal_hub over `POST /delegate`.
//   3. authorship is not transferable: the goal_hub cannot edit the root's message (403 not_owner).
//   4. acknowledgement is per-principal: one client's `collabcast_ack` leaves the other's queue alone.
//   5. revocation is immediate and cascading: the root revoking itself kills the capability it
//      delegated, mid-session, with no restart.
//   6. a capability is bound to its namespace: stack A's token is refused by stack B.

import { describe, test, expect } from 'vitest';
import net from 'node:net';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';
import { ENROLL_OP, ROLE_SCOPES } from '../../src/authority/index.js';

/** One NDJSON round trip against the authority socket, exactly as the OMP hook does it. */
function hookRequest(socketPath, payload, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;
    const settle = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => settle(null, new Error('hook round trip timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (err) => settle(null, err));
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        settle(JSON.parse(buffer.slice(0, newline)), null);
      } catch (err) {
        settle(null, err);
      }
    });
    socket.on('close', () => settle(null, null));
  });
}

describe('E2E: two principals on one channel', () => {
  test('enroll -> delegate -> converse -> ownership -> per-principal ack -> revoke -> namespace', async () => {
    // No pre-minted principals: this test owns the whole issuance path.
    const stack = await createStack({
      namespace: 'collabcast-e2e',
      operator: 'Trevor',
      roles: []
    });

    // ── 1. Enrollment is operator-gated ───────────────────────────────────────────────────
    // The hook authenticates with the shared secret; a wrong one is refused opaquely, so a
    // caller cannot probe which namespaces exist.
    const forged = await hookRequest(stack.authoritySocketPath, {
      op: ENROLL_OP,
      namespace: stack.namespace,
      role: 'root',
      scopes: [...ROLE_SCOPES.root],
      ttlSeconds: 3600,
      hookSecret: 'not-the-secret-not-the-secret-not-the'
    });
    expect(forged.error.code).toBe('forbidden');
    expect(forged.code).toBeUndefined();

    const approved = await hookRequest(stack.authoritySocketPath, {
      op: ENROLL_OP,
      namespace: stack.namespace,
      role: 'root',
      scopes: [...ROLE_SCOPES.root],
      ttlSeconds: 3600,
      hookSecret: stack.hookSecret
    });
    expect(approved.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const exchanged = await stack.request('POST', '/enroll/exchange', {
      body: { enrollmentCode: approved.code }
    });
    expect(exchanged.status).toBe(201);
    expect(exchanged.body.role).toBe('root');
    expect(exchanged.body.scopes).toEqual([...ROLE_SCOPES.root].sort());
    const rootToken = exchanged.body.token;
    const rootCapabilityId = exchanged.body.capabilityId;
    const rootId = exchanged.body.principalId;

    // The code is one-use: a replay gets the single opaque refusal, not a second capability.
    const replay = await stack.request('POST', '/enroll/exchange', {
      body: { enrollmentCode: approved.code }
    });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('permit_invalid');

    // ── 2. Delegation narrows ─────────────────────────────────────────────────────────────
    const delegated = await stack.request('POST', '/delegate', {
      token: rootToken,
      body: {
        role: 'goal_hub',
        scopes: ['channel:read', 'channel:publish', 'channel:ack', 'self:alias', 'self:cursor'],
        ttlSeconds: 900
      }
    });
    expect(delegated.status).toBe(201);
    expect(delegated.body.role).toBe('goal_hub');
    // A goal_hub cannot delegate further: `enroll:delegate` was not handed down.
    expect(delegated.body.scopes).not.toContain('enroll:delegate');
    const hubToken = delegated.body.token;
    const hubId = delegated.body.principalId;

    const cannotSubDelegate = await stack.request('POST', '/delegate', {
      token: hubToken,
      body: { role: 'listener', scopes: ['channel:read'], ttlSeconds: 300 }
    });
    expect(cannotSubDelegate.status).toBe(403);
    expect(cannotSubDelegate.body.error.code).toBe('scope_required');

    // ── 3. Two real MCP sessions, one per principal ───────────────────────────────────────
    const rootClient = await spawnMockClient({
      env: stack.childEnv(),
      capability: {
        token: rootToken,
        capabilityId: rootCapabilityId,
        principalId: rootId,
        role: 'root',
        scopes: exchanged.body.scopes,
        expiresAt: exchanged.body.expiresAt
      },
      name: 'root-session'
    });
    const hubClient = await spawnMockClient({
      env: stack.childEnv(),
      capability: hubToken,
      name: 'hub-session'
    });

    try {
      // Each session learns who it is from the server, not from what it was told.
      expect((await rootClient.sessions()).principals.map((p) => p.id).sort()).toEqual(
        [rootId, hubId].sort()
      );

      await rootClient.rename('trev');
      await hubClient.rename('slide-designer');

      // ── 4. They converse, and the mention resolves to a principal id ────────────────────
      const question = await rootClient.talk('@slide-designer demo supports refunds — slide?', {
        type: 'question'
      });
      expect(question.warnings).toEqual([]);

      const hubInbox = await hubClient.inbox();
      expect(hubInbox.mentionedForMe.map((m) => m.id)).toEqual([question.id]);
      expect(hubInbox.mentionedForMe[0].mentions).toEqual([hubId]);

      const answer = await hubClient.reply(question.id, 'keep it scoped to the happy path');
      expect(answer.id).toMatch(/^[0-9A-Z]{26}$/);

      // Each sees both messages, newest-first, with the author's principal id attached.
      const seen = await rootClient.read({ limit: 5 });
      expect(seen.messages.map((m) => m.fromSessionId)).toEqual([hubId, rootId]);

      // ── 5. Authorship is not transferable ──────────────────────────────────────────────
      const hijack = await hubClient.callRaw('collabcast_edit', {
        id: question.id,
        body: 'rewritten by the hub'
      });
      expect(hijack.isError).toBe(true);
      expect(hijack.payload.code).toBe('not_owner');

      const hijackRaw = await stack.request('PATCH', `/channel/message/${question.id}`, {
        token: hubToken,
        body: { body: 'rewritten by the hub' }
      });
      expect(hijackRaw.status).toBe(403);
      expect(hijackRaw.body.error.code).toBe('not_owner');

      // The root can still edit its own, and the body is intact.
      const ownEdit = await rootClient.edit(question.id, '@slide-designer refunds — slide? (v2)');
      expect(ownEdit.revision).toBe(1);

      // ── 6. Acknowledgement is per-principal ────────────────────────────────────────────
      expect(stack.cursors(rootId)).toEqual({ read: '', ack: '' });
      expect(stack.cursors(hubId)).toEqual({ read: '', ack: '' });

      const before = await hubClient.inbox();
      const lastId = before.messages[before.messages.length - 1].id;
      const acked = await hubClient.ack(lastId);
      expect(acked).toEqual({ status: 'acknowledged', lastReadId: lastId, lastAckedId: lastId });

      expect(stack.cursors(hubId)).toEqual({ read: lastId, ack: lastId });
      // The other principal's cursor did not move, and its queue is untouched.
      expect(stack.cursors(rootId)).toEqual({ read: '', ack: '' });
      expect((await hubClient.inbox()).messages).toEqual([]);
      expect((await rootClient.inbox()).messages.length).toBe(2);

      // ── 7. Revocation is immediate, and it cascades ─────────────────────────────────────
      // The root hands its own capability back. `revokeCapability` walks the derivation
      // closure, so the capability it delegated dies with it — a leaked parent cannot be
      // contained by revoking it alone.
      const revoked = await stack.request('DELETE', `/capability/${rootCapabilityId}`, {
        token: rootToken
      });
      expect(revoked.status).toBe(200);

      // Mid-session, with no restart and no reconnect: both sessions stop working.
      for (const [label, client] of [
        ['root', rootClient],
        ['hub', hubClient]
      ]) {
        const dead = await client.callRaw('collabcast_read', {});
        expect(dead.isError, label).toBe(true);
        expect(dead.payload.code, label).toBe('unauthenticated');
      }
      expect(
        (await stack.request('GET', '/self', { token: hubToken })).status
      ).toBe(401);
      expect(
        (await stack.request('GET', '/self', { token: rootToken })).status
      ).toBe(401);

      // And a revoked session cannot post its way back in.
      const posthumous = await hubClient.callRaw('collabcast_talk', { body: 'still here?' });
      expect(posthumous.isError).toBe(true);
      expect(posthumous.payload.code).toBe('unauthenticated');
      expect(posthumous.payload.message).toMatch(/no longer accepted|collabcast_enroll/);
    } finally {
      await hubClient.close();
      await rootClient.close();
    }
  }, 40000);

  test('a capability is bound to its namespace: stack A\'s token is refused by stack B', async () => {
    const alpha = await createStack({ namespace: 'collabcast-e2e-a', roles: ['root'] });
    const beta = await createStack({ namespace: 'collabcast-e2e-b', roles: ['root'] });

    // Each token works against its own service.
    expect((await alpha.request('GET', '/self', { token: alpha.tokens.root })).status).toBe(200);
    expect((await beta.request('GET', '/self', { token: beta.tokens.root })).status).toBe(200);

    // Presented to the other, it is refused — and refused INDISTINGUISHABLY from a token that
    // never existed. `verifyCapability` collapses a namespace mismatch to null before the route
    // ever sees it (src/store/capabilities.js, `capability.namespace !== ctx.namespace`), so a
    // cross-project replay is 401 `unauthenticated`, not 403 `wrong_namespace`.
    //
    // That is the stronger answer and it is the one asserted here: a 403 saying
    // "wrong namespace" would be an oracle, confirming to whoever holds a stolen token that it
    // is genuine and merely pointed at the wrong project. `requireCapability`'s
    // `wrong_namespace` branch is a second fence for the different fault of a service whose
    // namespace disagrees with its own store's — reachable only by constructing that
    // disagreement, which `test/daemon/auth.test.js` does directly.
    const crossed = await beta.request('GET', '/self', { token: alpha.tokens.root });
    expect(crossed.status).toBe(401);
    expect(crossed.body.error.code).toBe('unauthenticated');
    const garbage = await beta.request('GET', '/self', { token: 'not-a-token-at-all' });
    expect(crossed.body).toEqual(garbage.body);
    // Nothing in the refusal hints that the token is valid somewhere else.
    expect(crossed.text).not.toContain('collabcast-e2e-a');
    expect(crossed.text).not.toContain(alpha.tokens.root);
    expect(crossed.text).not.toContain(alpha.principals.root.principalId);

    const write = await beta.request('POST', '/channel/message', {
      token: alpha.tokens.root,
      body: { body: 'crossing over' }
    });
    expect(write.status).toBe(401);
    expect(write.body.error.code).toBe('unauthenticated');
    // Nothing was written into B, and A's own channel is untouched too.
    expect(
      (await beta.request('GET', '/channel/latest', { token: beta.tokens.root })).body.messages
    ).toEqual([]);
    expect(
      (await alpha.request('GET', '/channel/latest', { token: alpha.tokens.root })).body.messages
    ).toEqual([]);

    // An MCP session in B holding A's capability comes up unenrolled and says so, rather than
    // acting with borrowed authority.
    const client = await spawnMockClient({
      env: beta.childEnv(),
      capability: alpha.tokens.root
    });
    try {
      const refused = await client.callRaw('collabcast_read', {});
      expect(refused.isError).toBe(true);
      expect(refused.payload.code).toBe('unauthenticated');
    } finally {
      await client.close();
    }
  }, 30000);
});
