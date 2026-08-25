import { describe, test, expect, afterEach } from 'vitest';
import {
  createPrincipal,
  getPrincipal,
  getPrincipalByAlias,
  setAlias,
  revokePrincipal,
  listPrincipals
} from '../../src/store/principals.js';
import { issueCapability, verifyCapability } from '../../src/store/capabilities.js';
import { grantPermit, listPermits } from '../../src/store/permits.js';
import { recordApproval } from '../../src/store/approvals.js';
import { sha256 } from '../../src/store/digest.js';
import { now } from '../../src/store/clock.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

describe('principals', () => {
  test('mints an immutable prn_ id and resolves by id and alias', () => {
    fixture = createTmpStore();
    const p = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });
    expect(p.id).toMatch(/^prn_[0-9a-f]{16}$/);
    expect(p.role).toBe('goal_hub');
    expect(p.namespace).toBe(fixture.namespace);
    expect(getPrincipal(fixture.store, p.id)).toEqual(p);
    expect(getPrincipalByAlias(fixture.store, 'Main').id).toBe(p.id);
    expect(getPrincipalByAlias(fixture.store, 'nobody')).toBe(null);
  });

  test('rejects an unknown role and a malformed alias', () => {
    fixture = createTmpStore();
    let err;
    try {
      createPrincipal(fixture.store, { role: 'admin' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('invalid_request');
    expect(() =>
      createPrincipal(fixture.store, { role: 'root', displayAlias: 'has space' })
    ).toThrowError(/display alias/);
  });

  test('alias collision on create rejects the newcomer and leaves the incumbent untouched', () => {
    fixture = createTmpStore();
    const incumbent = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });

    let err;
    try {
      createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Main' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('conflict');

    expect(getPrincipalByAlias(fixture.store, 'Main').id).toBe(incumbent.id);
    expect(getPrincipal(fixture.store, incumbent.id).displayAlias).toBe('Main');
    expect(listPrincipals(fixture.store).map((p) => p.id)).toEqual([incumbent.id]);
  });

  test('alias collision on rename rejects the newcomer and neither alias moves', () => {
    fixture = createTmpStore();
    const incumbent = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });
    const newcomer = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });

    let err;
    try {
      setAlias(fixture.store, newcomer.id, 'Main');
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('conflict');

    expect(getPrincipal(fixture.store, incumbent.id).displayAlias).toBe('Main');
    expect(getPrincipal(fixture.store, newcomer.id).displayAlias).toBe('Helper');
    expect(getPrincipalByAlias(fixture.store, 'Main').id).toBe(incumbent.id);
    expect(getPrincipalByAlias(fixture.store, 'Helper').id).toBe(newcomer.id);
  });

  test('renaming carries no authority: capabilities, cursors and permits are untouched', () => {
    fixture = createTmpStore();
    const operator = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
    const hub = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });

    const { capabilityId, token } = issueCapability(fixture.store, {
      principalId: hub.id,
      scopes: ['channel:read', 'channel:publish'],
      ttlSeconds: 600,
      attestationKind: 'operator_cli',
      attestationRef: 'cli:test'
    });
    const approval = recordApproval(fixture.store, {
      kind: 'prune',
      subjectDigest: sha256('plan'),
      approvingPrincipal: operator.id,
      attestationKind: 'operator_cli'
    });
    const permit = grantPermit(fixture.store, {
      principalId: hub.id,
      operation: 'retention.prune',
      resourceId: 'thread-1',
      contentDigest: sha256('plan'),
      approvalId: approval.id,
      ttlSeconds: 600
    });
    const readCursor = '01J000000000000000000000AA';
    fixture.store.db
      .prepare(
        'INSERT INTO cursor (namespace, owner_principal_id, kind, last_message_id, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?)'
      )
      .run(fixture.namespace, hub.id, 'read', readCursor, now());

    const renamed = setAlias(fixture.store, hub.id, 'Coordinator');
    expect(renamed.displayAlias).toBe('Coordinator');
    expect(renamed.id).toBe(hub.id);

    const verified = verifyCapability(fixture.store, token);
    expect(verified.capability.id).toBe(capabilityId);
    expect(verified.principal.id).toBe(hub.id);
    expect(verified.capability.scopes).toEqual(['channel:publish', 'channel:read']);
    expect(listPermits(fixture.store, { principalId: hub.id }).map((p) => p.id)).toEqual([
      permit.id
    ]);
    expect(
      fixture.store.db
        .prepare('SELECT last_message_id FROM cursor WHERE owner_principal_id = ? AND kind = ?')
        .get(hub.id, 'read').last_message_id
    ).toBe(readCursor);
  });

  test('clearing an alias is allowed, and the freed alias can be taken', () => {
    fixture = createTmpStore();
    const a = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });
    setAlias(fixture.store, a.id, null);
    expect(getPrincipalByAlias(fixture.store, 'Main')).toBe(null);
    const b = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Main' });
    expect(getPrincipalByAlias(fixture.store, 'Main').id).toBe(b.id);
  });

  test('revoking frees the alias and hides the principal from alias lookup', () => {
    fixture = createTmpStore();
    const a = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });
    const revoked = revokePrincipal(fixture.store, a.id);
    expect(revoked.revokedAt).toBeTruthy();
    expect(getPrincipalByAlias(fixture.store, 'Helper')).toBe(null);

    const b = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'Helper' });
    expect(getPrincipalByAlias(fixture.store, 'Helper').id).toBe(b.id);

    let err;
    try {
      setAlias(fixture.store, a.id, 'Something');
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('conflict');

    let second;
    try {
      revokePrincipal(fixture.store, a.id);
    } catch (e) {
      second = e;
    }
    expect(second?.code).toBe('conflict');
  });

  test('unknown principal is not_found on rename and revoke', () => {
    fixture = createTmpStore();
    for (const fn of [
      () => setAlias(fixture.store, 'prn_0000000000000000', 'x'),
      () => revokePrincipal(fixture.store, 'prn_0000000000000000')
    ]) {
      let err;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe('not_found');
    }
  });

  test('listPrincipals filters by role and hides revoked by default', () => {
    fixture = createTmpStore();
    const root = createPrincipal(fixture.store, { role: 'root', displayAlias: 'root' });
    createPrincipal(fixture.store, { role: 'listener', displayAlias: 'l1' });
    const gone = createPrincipal(fixture.store, { role: 'listener', displayAlias: 'l2' });
    revokePrincipal(fixture.store, gone.id);

    expect(listPrincipals(fixture.store, { role: 'root' }).map((p) => p.id)).toEqual([root.id]);
    expect(listPrincipals(fixture.store, { role: 'listener' }).length).toBe(1);
    expect(listPrincipals(fixture.store, { role: 'listener', includeRevoked: true }).length).toBe(
      2
    );
  });
});

/** F2/F3 regressions: one alias grammar, and uniqueness on the fold the resolver uses. */
describe('alias grammar and case folding', () => {
  function codeOf(fn) {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  }

  function mint(alias, role = 'listener') {
    return createPrincipal(fixture.store, { role, displayAlias: alias });
  }

  test('the store enforces the shared grammar, not a looser private copy', () => {
    fixture = createTmpStore();
    // Every one of these was ACCEPTED by the store's private grammar while
    // `isValidAlias` rejected it — an alias may not begin or end on punctuation,
    // because the mention scanner drops trailing punctuation to read a token.
    for (const alias of ['trailing.', 'trailing-', 'trailing_', 'x'.repeat(65)]) {
      expect(codeOf(() => mint(alias)), alias).toBe('invalid_request');
    }
    for (const alias of ['.leading', '-leading', 'has space', '@nope', 'a<b']) {
      expect(codeOf(() => mint(alias)), alias).toBe('invalid_request');
    }
    // ...and the shapes a real alias takes still mint.
    for (const alias of ['a', 'ops.hub', 'Main', 'demo-builder', 'under_score', 'x'.repeat(64)]) {
      expect(mint(alias).displayAlias, alias).toBe(alias);
    }
  });

  test('an alias differing from a live one only by case is a conflict, not a second identity', () => {
    fixture = createTmpStore();
    const incumbent = mint('alice', 'goal_hub');
    expect(codeOf(() => mint('Alice'))).toBe('conflict');
    // A fold-equal pair differing in more than one character position.
    expect(codeOf(() => mint('ALICE'))).toBe('conflict');

    const dotted = mint('ops.hub');
    expect(codeOf(() => mint('OpS.HuB'))).toBe('conflict');

    // The incumbents keep their aliases, and a lookup still finds them.
    expect(getPrincipal(fixture.store, incumbent.id).displayAlias).toBe('alice');
    expect(getPrincipalByAlias(fixture.store, 'alice').id).toBe(incumbent.id);
    expect(getPrincipalByAlias(fixture.store, 'Alice').id).toBe(incumbent.id);
    expect(getPrincipalByAlias(fixture.store, 'ops.hub').id).toBe(dotted.id);
    expect(listPrincipals(fixture.store).map((p) => p.id)).toEqual([incumbent.id, dotted.id]);
  });

  test('a rename cannot take a case variant of a live alias either', () => {
    fixture = createTmpStore();
    const incumbent = mint('alice', 'goal_hub');
    const other = mint('bob');

    expect(codeOf(() => setAlias(fixture.store, other.id, 'ALICE'))).toBe('conflict');
    expect(getPrincipal(fixture.store, other.id).displayAlias).toBe('bob');
    expect(getPrincipalByAlias(fixture.store, 'alice').id).toBe(incumbent.id);

    // Recasing your OWN alias is not a collision with yourself.
    expect(setAlias(fixture.store, incumbent.id, 'Alice').displayAlias).toBe('Alice');
    expect(getPrincipalByAlias(fixture.store, 'alice').id).toBe(incumbent.id);
  });

  test('a revoked principal frees its alias for every casing of it', () => {
    fixture = createTmpStore();
    const gone = mint('alice');
    revokePrincipal(fixture.store, gone.id);
    const next = mint('ALICE');
    expect(getPrincipalByAlias(fixture.store, 'alice').id).toBe(next.id);
  });
});
