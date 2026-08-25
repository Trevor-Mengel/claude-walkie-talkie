import { describe, test, expect, afterEach } from 'vitest';
import { audit, redactDetail, listAudit, isSecretKey } from '../../src/store/audit.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability } from '../../src/store/capabilities.js';
import { newSecret, sha256 } from '../../src/store/digest.js';
import { newId, ID_PREFIXES } from '../../src/store/ids.js';
import { newId as newMessageId } from '../../src/core/ids.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

describe('redactDetail key matching', () => {
  test('rewrites every secret-bearing key to [redacted] and never drops one', () => {
    const input = {
      token: 'abc',
      authToken: 'abc',
      bearerToken: 'abc',
      secret: 'abc',
      clientSecret: 'abc',
      hookSecret: 'abc',
      code: 'abc',
      enrollmentCode: 'abc',
      password: 'abc',
      Authorization: 'abc',
      AUTHORIZATION_HEADER: 'abc',
      apiKey: 'abc',
      privateKey: 'abc',
      keep: 'visible'
    };
    const out = redactDetail(input);
    // Same key set: a field that vanishes between write and read is indistinguishable
    // from one that was never written, which is the wrong failure mode for an audit log.
    expect(Object.keys(out)).toEqual(Object.keys(input));
    for (const key of Object.keys(input)) {
      if (key === 'keep') continue;
      expect(out[key], key).toBe('[redacted]');
    }
    expect(out.keep).toBe('visible');
  });

  test('keys that merely contain a secret word as a qualifier keep their values', () => {
    // The old rule matched /token|secret|code|password|authorization/i as a substring and
    // dropped the field, so every one of these silently disappeared from the audit row.
    const out = redactDetail({
      errorCode: 'invalid_request',
      statusCode: 401,
      exitCode: 0,
      httpStatusCode: 503,
      codeTtlSeconds: 120,
      tokenCount: 3,
      reasonCode: 'stale_fence',
      cacheKey: 'inbox:main',
      capabilityId: 'cap_0123456789abcdef'
    });
    expect(out).toEqual({
      errorCode: 'invalid_request',
      statusCode: 401,
      exitCode: 0,
      httpStatusCode: 503,
      codeTtlSeconds: 120,
      tokenCount: 3,
      reasonCode: 'stale_fence',
      cacheKey: 'inbox:main',
      capabilityId: 'cap_0123456789abcdef'
    });
  });

  test('isSecretKey is the head-noun rule, not a substring match', () => {
    for (const key of [
      'token',
      'authToken',
      'refresh_token',
      'secret',
      'hookSecret',
      'secretConfigured',
      'code',
      'enrollmentCode',
      'password',
      'authorization',
      'AUTHORIZATION_HEADER',
      'bearerHeader',
      'apiKey',
      'signature',
      'capability'
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of [
      'errorCode',
      'statusCode',
      'exitCode',
      'tokenCount',
      'codeTtlSeconds',
      'capabilityId',
      'parentCapabilityId',
      'cacheKey',
      'scopes',
      'role',
      'reason',
      'attestationKind',
      'approvalId'
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactDetail value matching', () => {
  test('redacts long opaque values regardless of key name', () => {
    const token = newSecret();
    const out = redactDetail({ header: token, short: 'ok', dashes: 'a-b-c' });
    expect(out.header).toBe('[redacted]');
    expect(out.short).toBe('ok');
    expect(out.dashes).toBe('a-b-c');
  });

  test('the 24-character value boundary sits between a store id and a secret', () => {
    // Every store id is a 4-character prefix plus 16 hex characters == 20 characters, and
    // every walkie secret is 32 bytes base64url == 43. The floor lives in the gap. If the
    // id format ever grows past 23 characters this test fails rather than ids silently
    // turning into '[redacted]' in every audit row.
    for (const kind of ['principal', 'capability', 'approval', 'permit']) {
      const id = newId(ID_PREFIXES[kind]);
      expect(id, kind).toHaveLength(20);
      expect(redactDetail({ id }).id, kind).toBe(id);
    }
    expect(newSecret()).toHaveLength(43);

    const at23 = 'a'.repeat(23);
    const at24 = 'a'.repeat(24);
    expect(redactDetail({ v: at23 }).v).toBe(at23);
    expect(redactDetail({ v: at24 }).v).toBe('[redacted]');
  });

  test('a message id survives redaction, so a cursor row can still say where it moved', () => {
    // A message id is a 26-character uppercase Crockford ULID, which trips the 24-character
    // floor above. Redacting it turns every cursor audit row into
    // `{requested: '[redacted]', id: '[redacted]'}` — a row that cannot answer the one
    // question it exists to answer.
    const messageId = newMessageId();
    expect(messageId).toHaveLength(26);
    expect(redactDetail({ requested: messageId, id: messageId })).toEqual({
      requested: messageId,
      id: messageId
    });
    // Nested and in arrays too: the exemption is on the value, not on the key.
    expect(redactDetail({ seen: [messageId], cursor: { last: messageId } })).toEqual({
      seen: [messageId],
      cursor: { last: messageId }
    });
  });

  test('the message-id exemption cannot launder a secret', () => {
    // The exemption is a shape, and no secret this system mints has that shape: 43
    // characters of base64url versus 26 of uppercase Crockford base32.
    for (let i = 0; i < 200; i += 1) {
      const secret = newSecret();
      expect(redactDetail({ v: secret }).v).toBe('[redacted]');
      // Even a 26-character window of one: base64url includes lowercase, and Crockford
      // excludes it along with I, L, O, U, _ and -.
      const window = secret.slice(0, 26);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(window)) {
        expect(redactDetail({ v: window }).v).toBe('[redacted]');
      }
    }
    // A secret-shaped string that is exactly 26 lowercase characters stays redacted.
    expect(redactDetail({ v: 'a'.repeat(26) }).v).toBe('[redacted]');
    // And a key that names a secret is redacted whatever the value's shape.
    expect(redactDetail({ enrollmentCode: newMessageId() }).enrollmentCode).toBe('[redacted]');
  });

  test('a real capability token never survives redaction, by key or by value', () => {
    const token = newSecret();
    const serialised = JSON.stringify(
      redactDetail({ authorization: `Bearer ${token}`, presented: token, list: [token] })
    );
    expect(serialised).not.toContain(token);
    expect(serialised).toBe(
      '{"authorization":"[redacted]","presented":"[redacted]","list":["[redacted]"]}'
    );
  });

  test('byte buffers collapse to a short non-secret-shaped fingerprint', () => {
    const digest = sha256('prune-plan');
    const out = redactDetail({ digest, view: new Uint8Array([1, 2, 3]) });
    expect(out.digest).toBe(`<blob:32:${digest.subarray(0, 8).toString('hex')}>`);
    expect(out.view).toBe('<blob:3:010203>');
    expect(out.digest.length).toBeLessThan(32);
  });

  test('recurses into nested objects and arrays', () => {
    const out = redactDetail({
      outer: { inner: { token: 'x', ok: 1 } },
      rows: [{ secret: 'x', id: 'r1' }, 'plain']
    });
    expect(out).toEqual({
      outer: { inner: { token: '[redacted]', ok: 1 } },
      rows: [{ secret: '[redacted]', id: 'r1' }, 'plain']
    });
  });

  test('survives cycles, deep nesting, primitives and errors', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    expect(redactDetail(cyclic)).toEqual({ name: 'root', self: '[circular]' });

    let deep = { leaf: true };
    for (let i = 0; i < 10; i += 1) deep = { deep };
    expect(JSON.stringify(redactDetail(deep))).toContain('[truncated]');

    expect(redactDetail(null)).toBe(null);
    expect(redactDetail(undefined)).toBe(null);
    expect(redactDetail(7)).toBe(7);
    expect(redactDetail(false)).toBe(false);
    expect(redactDetail(10n)).toBe('10');
    expect(redactDetail({ fn: () => 1 }).fn).toBe('[unserialisable]');
    expect(redactDetail(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
    // a secret-shaped string is redacted outright; ordinary prose is truncated
    expect(redactDetail('x'.repeat(600))).toBe('[redacted]');
    expect(redactDetail('long prose '.repeat(60)).endsWith('…')).toBe(true);
  });
});

describe('audit', () => {
  test('writes a redacted row and reads it back', () => {
    fixture = createTmpStore();
    const actor = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
    const { capabilityId, token } = issueCapability(fixture.store, {
      principalId: actor.id,
      scopes: ['channel:read'],
      ttlSeconds: 60,
      attestationKind: 'operator_cli',
      attestationRef: 'cli:test'
    });

    const id = audit(fixture.store, {
      actorPrincipalId: actor.id,
      action: 'capability.issue',
      subject: capabilityId,
      outcome: 'allowed',
      detail: { token, scopes: ['channel:read'], attempt: 1 }
    });
    expect(id).toBeGreaterThan(0);

    const rows = listAudit(fixture.store);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      namespace: fixture.namespace,
      actorPrincipalId: actor.id,
      action: 'capability.issue',
      subject: capabilityId,
      outcome: 'allowed'
    });
    // Exact equality on the persisted detail: the token key must still be THERE, holding
    // '[redacted]'. A dropped key would make this row indistinguishable from one whose
    // caller never passed a token at all.
    expect(rows[0].detail).toEqual({
      token: '[redacted]',
      scopes: ['channel:read'],
      attempt: 1
    });
    expect(rows[0].at).toBeTruthy();

    const raw = fixture.store.db.prepare('SELECT detail FROM audit').get().detail;
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw)).toEqual({
      token: '[redacted]',
      scopes: ['channel:read'],
      attempt: 1
    });
  });

  test('secret-bearing keys reach SQLite redacted, and diagnostic keys reach it intact', () => {
    fixture = createTmpStore();
    audit(fixture.store, {
      action: 'enroll.exchange',
      outcome: 'denied',
      detail: {
        enrollmentCode: 'e-0123456789',
        hookSecret: 'h-0123456789',
        password: 'hunter2',
        authorization: 'Bearer nope',
        secret: 'nope',
        errorCode: 'permit_invalid',
        statusCode: 403,
        exitCode: 1,
        tokenCount: 2,
        codeTtlSeconds: 120
      }
    });

    // Read the row back out of SQLite, never the input object: the input is unchanged by
    // redaction, so asserting against it proves nothing about what was persisted.
    const raw = fixture.store.db.prepare('SELECT detail FROM audit').get().detail;
    expect(JSON.parse(raw)).toEqual({
      enrollmentCode: '[redacted]',
      hookSecret: '[redacted]',
      password: '[redacted]',
      authorization: '[redacted]',
      secret: '[redacted]',
      errorCode: 'permit_invalid',
      statusCode: 403,
      exitCode: 1,
      tokenCount: 2,
      codeTtlSeconds: 120
    });
    for (const leak of ['e-0123456789', 'h-0123456789', 'hunter2', 'Bearer nope']) {
      expect(raw).not.toContain(leak);
    }
  });

  test('accepts a raw handle, a store, and a transaction context', () => {
    fixture = createTmpStore();
    audit(fixture.store.db, { namespace: fixture.namespace, action: 'a', outcome: 'ok' });
    audit(fixture.store, { action: 'b', outcome: 'ok' });
    fixture.store.tx((tx) => audit(tx, { action: 'c', outcome: 'ok' }));
    expect(listAudit(fixture.store).map((r) => r.action)).toEqual(['c', 'b', 'a']);
  });

  test('an audit row rolls back with the transaction that wrote it', () => {
    fixture = createTmpStore();
    expect(() =>
      fixture.store.tx((tx) => {
        audit(tx, { action: 'doomed', outcome: 'allowed' });
        throw new Error('nope');
      })
    ).toThrowError('nope');
    expect(listAudit(fixture.store)).toEqual([]);
  });

  test('requires a namespace, an action and an outcome', () => {
    fixture = createTmpStore();
    expect(codeOf(() => audit(fixture.store, { outcome: 'ok' }))).toBe('invalid_request');
    expect(codeOf(() => audit(fixture.store, { action: 'a' }))).toBe('invalid_request');
    expect(codeOf(() => audit(fixture.store.db, { action: 'a', outcome: 'ok' }))).toBe(
      'namespace_unresolved'
    );
    expect(codeOf(() => audit(null, { action: 'a', outcome: 'ok' }))).toBe('internal');
  });

  test('a detail-free entry stores null, not the string "undefined"', () => {
    fixture = createTmpStore();
    audit(fixture.store, { action: 'plain', outcome: 'denied' });
    expect(listAudit(fixture.store)[0].detail).toBe(null);
  });

  test('listAudit filters by action and actor and honours limit', () => {
    fixture = createTmpStore();
    const a = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
    audit(fixture.store, { action: 'x', outcome: 'ok', actorPrincipalId: a.id });
    audit(fixture.store, { action: 'y', outcome: 'ok' });
    audit(fixture.store, { action: 'x', outcome: 'ok' });

    expect(listAudit(fixture.store, { action: 'x' }).length).toBe(2);
    expect(listAudit(fixture.store, { actorPrincipalId: a.id }).length).toBe(1);
    expect(listAudit(fixture.store, { limit: 1 }).length).toBe(1);
  });
});
