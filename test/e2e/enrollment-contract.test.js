// A fresh MCP process acquiring authority for the first time, with nothing handed to it.
//
// This is the one path a real fresh install actually walks, and until now nothing walked it.
// `test/e2e/two-clients.test.js` proves the *authority's* issuance path (hook NDJSON -> code ->
// `POST /enroll/exchange`), but it then hands the resulting token to the MCP child as
// `COLLABCAST_CAPABILITY`. So the child's own `collabcast_enroll` handler — the only route a
// first-run session has — was never exercised end to end, and the tool it advertises could
// describe an enrollment nobody could perform (it did: the schema marked `namespace`, `role` and
// `scopes` optional and named `listener`, a role policy refuses).
//
// The rule this file holds: NO capability is injected and NO credential file is written. The
// enrollment code is not manufactured here either — it is produced by running the real OMP hook
// handler against the real authority socket, with a fake human clicking Approve. That is the only
// arrangement in which "the child enrolled" means the product can enroll.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';
import { ENROLLABLE_ROLES, ROLE_SCOPES } from '../../src/authority/index.js';
import { createEnrollHandler } from '../../omp-extension/collabcast-enroll.js';
import { APPROVE_OPTION, DENY_OPTION } from '../../omp-extension/gate.js';
import { requestEnrollmentCode } from '../../omp-extension/authority.js';

/** OMP namespaces MCP tools; this is the name the gate's allowlist generates for `collabcast`. */
const NAMESPACED_TOOL = 'mcp__collabcast_collabcast_enroll';

/** The scopes a root session actually needs to read, post and acknowledge. */
const REQUESTED_SCOPES = Object.freeze([
  'channel:read',
  'channel:publish',
  'channel:ack',
  'self:alias',
  'self:cursor'
]);

/** A stand-in operator: records what it was shown, answers with `selection`. */
function operatorUI(selection, { hasUI = true } = {}) {
  const shown = [];
  return {
    shown,
    ctx: {
      hasUI,
      ui: {
        select: async (prompt, options) => {
          shown.push({ prompt, options });
          return selection;
        }
      }
    }
  };
}

/** The hook exactly as an operator installs it, pointed at this stack's authority. */
function installedHook(stack, { secret = stack.hookSecret } = {}) {
  return createEnrollHandler({
    env: {
      COLLABCAST_AUTHORITY_SOCKET: stack.authoritySocketPath,
      COLLABCAST_HOOK_SECRET: secret
    }
  });
}

describe('E2E: a fresh MCP process enrolls itself', () => {
  test('unauthenticated -> operator approves -> the same process can act', async () => {
    // No pre-minted principals. Nothing in this namespace holds authority yet.
    const stack = await createStack({ namespace: 'collabcast-enroll', roles: [] });

    // A child with NO COLLABCAST_CAPABILITY and no credential file: a first-run session.
    const client = await spawnMockClient({ env: stack.childEnv(), name: 'fresh-session' });
    try {
      // ── 1. An authenticated tool fails, and says the one useful thing ──────────────────
      const refused = await client.callRaw('collabcast_read', {});
      expect(refused.isError).toBe(true);
      expect(refused.payload.code).toBe('unauthenticated');
      expect(refused.payload.hint).toMatch(/collabcast_enroll/);
      expect(client.stderr()).not.toMatch(/COLLABCAST_CAPABILITY/);

      // ...and enrolling with no operator behind it is refused too. `permit_required` here is
      // the honest answer: nobody approved anything, so there is nothing to redeem.
      const unapproved = await client.callRaw('collabcast_enroll', {
        namespace: stack.namespace,
        role: 'root',
        scopes: [...REQUESTED_SCOPES]
      });
      expect(unapproved.payload.code).toBe('permit_required');
      expect(unapproved.payload.message).toMatch(/no operator approved it/);

      // ── 2. The real hook, a real human, the real authority ────────────────────────────
      const requested = {
        namespace: stack.namespace,
        role: 'root',
        scopes: [...REQUESTED_SCOPES],
        ttlSeconds: 900
      };
      const operator = operatorUI(APPROVE_OPTION);
      const verdict = await installedHook(stack)(
        { toolName: NAMESPACED_TOOL, input: requested },
        operator.ctx
      );

      // The operator saw the exact grant — not a summary, not a tool name.
      expect(operator.shown).toHaveLength(1);
      const [{ prompt, options }] = operator.shown;
      expect(options).toEqual([DENY_OPTION, APPROVE_OPTION]);
      expect(prompt).toContain(stack.namespace);
      expect(prompt).toMatch(/Role:\s+root/);
      for (const scope of REQUESTED_SCOPES) expect(prompt).toContain(scope);
      expect(prompt).toMatch(/TTL:\s+900s/);

      // The approval injected a code into the tool's raw input, and changed nothing else.
      expect(verdict.block).toBeUndefined();
      expect(typeof verdict.input.enrollmentCode).toBe('string');
      expect(verdict.input.enrollmentCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect({ ...verdict.input, enrollmentCode: undefined }).toEqual({
        ...requested,
        enrollmentCode: undefined
      });

      // The child redeems it. This is the call the schema describes, argument for argument.
      const enrolled = await client.callRaw('collabcast_enroll', verdict.input);
      expect(enrolled.isError).toBeFalsy();
      expect(enrolled.payload.status).toBe('enrolled');
      expect(enrolled.payload.role).toBe('root');
      expect(enrolled.payload.scopes).toEqual([...REQUESTED_SCOPES].sort());
      // No token, no capability id, no code comes back to the model.
      expect(Object.keys(enrolled.payload).sort()).toEqual([
        'expiresAt',
        'role',
        'scopes',
        'status'
      ]);

      // ── 3. The same process can now act ───────────────────────────────────────────────
      const posted = await client.talk('enrolled the honest way');
      expect(posted.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const read = await client.read({ limit: 5 });
      expect(read.messages.map((m) => m.body)).toContain('enrolled the honest way');

      const roster = await client.sessions();
      expect(roster.principals).toHaveLength(1);
      expect(roster.principals[0].role).toBe('root');

      // The code was one-use: replaying the identical call cannot mint a second capability.
      const replayed = await client.callRaw('collabcast_enroll', verdict.input);
      expect(replayed.isError).toBe(true);
      expect(replayed.payload.code).toBe('permit_invalid');

      // Nothing leaked to stderr — not the token, not the code.
      expect(client.stderr()).not.toContain(verdict.input.enrollmentCode);
    } finally {
      await client.close();
    }
  }, 40000);

  test('no operator UI is a denial, and the child stays unenrolled', async () => {
    const stack = await createStack({ namespace: 'collabcast-noui', roles: [] });
    const operator = operatorUI(APPROVE_OPTION, { hasUI: false });

    const verdict = await installedHook(stack)(
      {
        toolName: NAMESPACED_TOOL,
        input: { namespace: stack.namespace, role: 'root', scopes: [...REQUESTED_SCOPES] }
      },
      operator.ctx
    );
    // Blocked before anything was shown or contacted: a non-interactive session cannot enroll,
    // and "no UI" must never degrade into "no approval needed".
    expect(verdict).toMatchObject({ block: true });
    expect(verdict.input).toBeUndefined();
    expect(operator.shown).toEqual([]);

    // The consequence, in the child: still no authority.
    const client = await spawnMockClient({ env: stack.childEnv(), name: 'headless-session' });
    try {
      expect((await client.callRaw('collabcast_talk', { body: 'hi' })).payload.code).toBe(
        'unauthenticated'
      );
    } finally {
      await client.close();
    }
  }, 40000);

  test('a denied dialog issues no code, so the child cannot enroll', async () => {
    const stack = await createStack({ namespace: 'collabcast-deny', roles: [] });
    const operator = operatorUI(DENY_OPTION);

    const verdict = await installedHook(stack)(
      {
        toolName: NAMESPACED_TOOL,
        input: { namespace: stack.namespace, role: 'root', scopes: [...REQUESTED_SCOPES] }
      },
      operator.ctx
    );
    expect(verdict).toMatchObject({ block: true });
    expect(verdict.input).toBeUndefined();
    // The human was asked; the authority was not.
    expect(operator.shown).toHaveLength(1);
  }, 40000);
});

describe('policy is the source of truth the schema and the docs must match', () => {
  test('a role outside ENROLLABLE_ROLES is refused by the live authority with forbidden', async () => {
    const stack = await createStack({ namespace: 'collabcast-roles', roles: [] });

    for (const role of ['listener', 'goal_hub', 'operator']) {
      expect(ENROLLABLE_ROLES).not.toContain(role);
      let err;
      try {
        await requestEnrollmentCode({
          socketPath: stack.authoritySocketPath,
          payload: {
            op: 'enroll.request',
            namespace: stack.namespace,
            role,
            // The role's own allowlist, so the refusal is about the role and nothing else.
            scopes: [...ROLE_SCOPES[role]],
            ttlSeconds: 900,
            hookSecret: stack.hookSecret
          }
        });
      } catch (caught) {
        err = caught;
      }
      expect(err, role).toBeDefined();
      expect(err.code, role).toBe('forbidden');
      expect(err.message, role).toMatch(/only the namespace root may be enrolled/);
    }

    // And the one role that IS enrollable really is.
    for (const role of ENROLLABLE_ROLES) {
      const issued = await requestEnrollmentCode({
        socketPath: stack.authoritySocketPath,
        payload: {
          op: 'enroll.request',
          namespace: stack.namespace,
          role,
          scopes: [...REQUESTED_SCOPES],
          ttlSeconds: 900,
          hookSecret: stack.hookSecret
        }
      });
      expect(issued.code, role).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  }, 40000);
});
