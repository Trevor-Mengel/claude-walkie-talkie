import { describe, test, expect } from 'vitest';
import { REDACTED, redact } from '../../omp-extension/redact.js';

const SECRET = 's3cr3t-hook-secret-value-0123456789';
const CODE = 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTA';

describe('redact', () => {
  test('drops the enrollment code and the hook secret by key name', () => {
    const out = redact({ code: CODE, hookSecret: SECRET, enrollmentCode: CODE });
    expect(out).toEqual({ code: REDACTED, hookSecret: REDACTED, enrollmentCode: REDACTED });
    expect(JSON.stringify(out)).not.toContain(CODE);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('key matching survives case and separator variation', () => {
    const out = redact({
      HookSecret: SECRET,
      hook_secret: SECRET,
      'hook-secret': SECRET,
      CODE: CODE,
      token: 'short',
      Authorization: 'Bearer abc'
    });
    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  test('drops secret-shaped values even under an innocent key', () => {
    const out = redact({ note: CODE, bearer_blob: SECRET, nested: { anything: CODE } });
    expect(out.note).toBe(REDACTED);
    expect(out.nested.anything).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain(CODE);
  });

  test('keeps the fields an operator actually needs to read', () => {
    const out = redact({
      namespace: 'collabcast',
      role: 'listener',
      scopes: ['channel:read', 'channel:publish'],
      ttlSeconds: 900,
      outcome: 'approved',
      injected: true,
      errorCode: 'forbidden',
      at: '2026-08-24T00:00:00.000Z'
    });
    expect(out).toEqual({
      namespace: 'collabcast',
      role: 'listener',
      scopes: ['channel:read', 'channel:publish'],
      ttlSeconds: 900,
      outcome: 'approved',
      injected: true,
      errorCode: 'forbidden',
      at: '2026-08-24T00:00:00.000Z'
    });
  });

  test('structural keys survive the token-shape rule; secret keys still win over them', () => {
    const out = redact({
      toolName: 'mcp__collabcast_collabcast_enroll',
      namespace: 'a-very-long-namespace-identifier',
      scopes: ['channel_read_extremely_long_scope_name'],
      code: 'mcp__collabcast_collabcast_enroll'
    });
    expect(out.toolName).toBe('mcp__collabcast_collabcast_enroll');
    expect(out.namespace).toBe('a-very-long-namespace-identifier');
    expect(out.scopes).toEqual(['channel_read_extremely_long_scope_name']);
    expect(out.code).toBe(REDACTED);
  });

  test('the exemption does not leak into nested objects under a structural key', () => {
    const out = redact({ namespace: { hookSecret: SECRET, blob: CODE } });
    expect(out.namespace).toEqual({ hookSecret: REDACTED, blob: REDACTED });
  });

  test('recurses arrays and objects, and never throws on hostile input', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: 'root', self: '[circular]' });
    expect(redact([{ code: CODE }, 'plain'])).toEqual([{ code: REDACTED }, 'plain']);
    expect(redact(undefined)).toBeUndefined();
    expect(redact(null)).toBeNull();
    expect(redact(() => CODE)).toBe(REDACTED);
    expect(redact(7n)).toBe('7');
  });

  test('errors are reduced to name plus message', () => {
    const err = new Error('could not reach the collabcast authority');
    err.code = 'internal';
    expect(redact({ err })).toEqual({
      err: { name: 'Error', message: 'could not reach the collabcast authority' }
    });
  });

  test('deeply nested secrets are cut off by the depth cap, not leaked', () => {
    let deep = { code: CODE };
    for (let i = 0; i < 20; i += 1) deep = { level: deep };
    expect(JSON.stringify(redact(deep))).not.toContain(CODE);
  });
});
