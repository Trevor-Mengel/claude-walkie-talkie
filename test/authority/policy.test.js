import { describe, test, expect } from 'vitest';
import {
  assertEnrollable,
  DEFAULT_CODE_TTL_SECONDS,
  DEFAULT_ENROLL_TTL_SECONDS,
  ENROLLABLE_ROLES,
  MAX_ENROLL_TTL_SECONDS,
  MIN_ENROLL_TTL_SECONDS,
  requireCodeTtlSeconds,
  ROLE_SCOPES,
  scopesForRole
} from '../../src/authority/policy.js';
import { SCOPES } from '../../src/store/capabilities.js';
import { ROLES } from '../../src/store/principals.js';
import { NAMESPACE } from './helpers.js';

const config = { namespace: NAMESPACE };

function request(overrides = {}) {
  return {
    namespace: NAMESPACE,
    role: 'root',
    scopes: ['channel:read', 'channel:publish'],
    ttlSeconds: 3600,
    config,
    ...overrides
  };
}

/** @returns {{code:string, detail:object|undefined}|null} */
function failure(overrides) {
  try {
    assertEnrollable(request(overrides));
  } catch (err) {
    return { code: err.code, detail: err.detail, message: err.message };
  }
  return null;
}

describe('policy shape', () => {
  test('only root is enrollable by operator approval', () => {
    expect(ENROLLABLE_ROLES).toEqual(['root']);
  });

  test('every allowlisted scope is a real store scope', () => {
    for (const [role, scopes] of Object.entries(ROLE_SCOPES)) {
      expect(ROLES).toContain(role);
      for (const scope of scopes) expect(SCOPES).toContain(scope);
    }
  });

  test('root cannot reach destructive authority through a dialog', () => {
    // permit:administer and retention:approve are operator-CLI territory. An
    // agent-initiated dialog must never be one click from destroying history.
    expect(ROLE_SCOPES.root).not.toContain('permit:administer');
    expect(ROLE_SCOPES.root).not.toContain('retention:approve');
  });

  test('scopesForRole hands back a copy, not the frozen source', () => {
    const scopes = scopesForRole('root');
    scopes.push('permit:administer');
    expect(ROLE_SCOPES.root).not.toContain('permit:administer');
    expect(() => scopesForRole('operator')).toThrowError(/allowlist/);
  });
});

describe('assertEnrollable', () => {
  test('normalises a valid request: scopes sorted and de-duplicated', () => {
    const grant = assertEnrollable(
      request({ scopes: ['self:alias', 'channel:read', 'channel:read'] })
    );
    expect(grant).toEqual({
      namespace: NAMESPACE,
      role: 'root',
      scopes: ['channel:read', 'self:alias'],
      ttlSeconds: 3600
    });
  });

  test('an absent ttl falls back to the schema default', () => {
    expect(assertEnrollable(request({ ttlSeconds: undefined })).ttlSeconds).toBe(
      DEFAULT_ENROLL_TTL_SECONDS
    );
    expect(assertEnrollable(request({ ttlSeconds: null })).ttlSeconds).toBe(
      DEFAULT_ENROLL_TTL_SECONDS
    );
  });

  test('the namespace must be this authority own', () => {
    const denied = failure({ namespace: 'other-project' });
    expect(denied.code).toBe('wrong_namespace');
    expect(failure({ namespace: '' }).code).toBe('invalid_request');
    expect(failure({ namespace: undefined }).code).toBe('invalid_request');
    expect(failure({ namespace: 42 }).code).toBe('invalid_request');
  });

  test('an authority without a namespace of its own refuses everything', () => {
    expect(failure({ config: {} }).code).toBe('namespace_unresolved');
    expect(failure({ config: { namespace: '' } }).code).toBe('namespace_unresolved');
  });

  test('every role except root is refused, naming what it may do instead', () => {
    for (const role of ROLES.filter((r) => r !== 'root')) {
      const denied = failure({ role });
      expect(denied.code).toBe('forbidden');
      expect(denied.detail).toMatchObject({ role, enrollable: ['root'] });
    }
    expect(failure({ role: 'admin' }).code).toBe('forbidden');
    expect(failure({ role: '' }).code).toBe('invalid_request');
    expect(failure({ role: undefined }).code).toBe('invalid_request');
  });

  test('a scope outside the allowlist is refused and named', () => {
    const denied = failure({ scopes: ['channel:read', 'permit:administer'] });
    expect(denied.code).toBe('forbidden');
    expect(denied.detail).toMatchObject({ scope: 'permit:administer', role: 'root' });
  });

  test('a scope no store recognises is refused as unknown', () => {
    const denied = failure({ scopes: ['channel:read', 'channel:*'] });
    expect(denied.code).toBe('forbidden');
    expect(denied.detail).toMatchObject({ scope: 'channel:*' });
  });

  test('scopes must be a non-empty array of non-empty strings', () => {
    for (const scopes of [[], undefined, null, 'channel:read', {}, [''], [null], [1]]) {
      expect(failure({ scopes }).code).toBe('invalid_request');
    }
  });

  test('ttlSeconds rejects zero, negatives, over-range, strings and floats', () => {
    for (const ttlSeconds of [0, -1, MAX_ENROLL_TTL_SECONDS + 1, '60', 60.5, NaN, Infinity, true]) {
      expect(failure({ ttlSeconds }).code, `ttlSeconds=${String(ttlSeconds)}`).toBe(
        'invalid_request'
      );
    }
    expect(failure({ ttlSeconds: MIN_ENROLL_TTL_SECONDS - 1 }).code).toBe('invalid_request');
  });

  test('the ttl boundaries themselves are accepted', () => {
    expect(assertEnrollable(request({ ttlSeconds: MIN_ENROLL_TTL_SECONDS })).ttlSeconds).toBe(
      MIN_ENROLL_TTL_SECONDS
    );
    expect(assertEnrollable(request({ ttlSeconds: MAX_ENROLL_TTL_SECONDS })).ttlSeconds).toBe(
      MAX_ENROLL_TTL_SECONDS
    );
  });

  test('the whole root allowlist is grantable in one request', () => {
    const grant = assertEnrollable(request({ scopes: [...ROLE_SCOPES.root] }));
    expect(grant.scopes).toEqual([...ROLE_SCOPES.root].sort());
  });
});

describe('requireCodeTtlSeconds', () => {
  test('defaults to a short window and accepts an in-range override', () => {
    expect(requireCodeTtlSeconds(undefined)).toBe(DEFAULT_CODE_TTL_SECONDS);
    expect(requireCodeTtlSeconds(null)).toBe(DEFAULT_CODE_TTL_SECONDS);
    expect(DEFAULT_CODE_TTL_SECONDS).toBe(120);
    expect(requireCodeTtlSeconds(30)).toBe(30);
    expect(requireCodeTtlSeconds(undefined, 45)).toBe(45);
  });

  test('rejects an out-of-range or non-integer window as misconfiguration', () => {
    for (const value of [0, -1, 4, 901, '60', 60.5, NaN]) {
      let code = null;
      try {
        requireCodeTtlSeconds(value);
      } catch (err) {
        code = err.code;
      }
      expect(code, `value=${String(value)}`).toBe('config_invalid');
    }
  });
});
