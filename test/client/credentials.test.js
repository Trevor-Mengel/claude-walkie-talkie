// Credential reading: both accepted forms, the file-mode fence, and the rule that a document's
// claims about its own authority are never trusted.

import { describe, test, expect } from 'vitest';
import { chmodSync } from 'node:fs';
import {
  OPERATOR_CREDENTIAL_FILENAME,
  credentialDrift,
  credentialFromEnv,
  operatorCredentialPath,
  parseCredential,
  readOperatorCredential
} from '../../src/client/credentials.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';

const TOKEN = 'PsQ2xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';

describe('parseCredential', () => {
  test('a bare token is a complete credential and claims nothing', () => {
    expect(parseCredential(TOKEN)).toEqual({ token: TOKEN, claimed: null });
  });

  test('the enrollment document is accepted and only its token is kept as authority', () => {
    const parsed = parseCredential(
      JSON.stringify({
        token: TOKEN,
        capabilityId: 'cap_1',
        principalId: 'prn_1',
        role: 'root',
        scopes: ['channel:read'],
        expiresAt: '2030-01-01T00:00:00.000Z'
      })
    );
    expect(parsed.token).toBe(TOKEN);
    expect(parsed.claimed).toEqual({
      capabilityId: 'cap_1',
      principalId: 'prn_1',
      role: 'root',
      scopes: ['channel:read'],
      expiresAt: '2030-01-01T00:00:00.000Z'
    });
  });

  test('a document with no token is rejected without naming a path', () => {
    const err = (() => {
      try {
        parseCredential(JSON.stringify({ role: 'root' }), 'the operator credential');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err.code).toBe('config_invalid');
    expect(err.message).toContain('does not contain a capability token');
    expect(err.message).not.toContain('/');
  });

  test('empty, whitespace-bearing and unparseable inputs are all refused', () => {
    expect(() => parseCredential('')).toThrow(/empty/);
    expect(() => parseCredential('   ')).toThrow(/empty/);
    expect(() => parseCredential('two words')).toThrow(/whitespace/);
    expect(() => parseCredential('{not json')).toThrow(/could not be parsed/);
    expect(() => parseCredential('[]')).toThrow(/bare token or a JSON object/);
  });
});

describe('credentialFromEnv', () => {
  test('absent or blank WALKIE_CAPABILITY yields no credential rather than an error', () => {
    expect(credentialFromEnv({})).toBeNull();
    expect(credentialFromEnv({ WALKIE_CAPABILITY: '  ' })).toBeNull();
  });

  test('a bare token in the environment is adopted', () => {
    expect(credentialFromEnv({ WALKIE_CAPABILITY: TOKEN })).toEqual({
      token: TOKEN,
      claimed: null
    });
  });
});

describe('readOperatorCredential', () => {
  test('reads a 0600 credential file', () => {
    const ns = createRegisteredNamespace();
    ns.writeOperatorCredential(TOKEN);
    expect(readOperatorCredential(ns.runtimeRoot)).toEqual({ token: TOKEN, claimed: null });
  });

  test('a group- or world-readable credential is refused, and the mode is reported', () => {
    const ns = createRegisteredNamespace();
    ns.writeOperatorCredential(TOKEN);
    chmodSync(ns.operatorCredPath, 0o644);
    const err = (() => {
      try {
        readOperatorCredential(ns.runtimeRoot);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err.code).toBe('config_invalid');
    expect(err.message).toContain('644');
    expect(err.message).toContain(OPERATOR_CREDENTIAL_FILENAME);
    // The filename is fine; the absolute path of a credential file is not.
    expect(err.message).not.toContain(ns.runtimeRoot);
  });

  test('a missing credential is unauthenticated, and says what is expected', () => {
    const ns = createRegisteredNamespace();
    const err = (() => {
      try {
        readOperatorCredential(ns.runtimeRoot);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err.code).toBe('unauthenticated');
    expect(err.message).toContain(OPERATOR_CREDENTIAL_FILENAME);
    expect(err.message).toContain('0600');
    expect(err.message).not.toContain(ns.runtimeRoot);
  });

  test('the path is derived, not guessed', () => {
    expect(operatorCredentialPath('/run/walkie')).toBe(`/run/walkie/${OPERATOR_CREDENTIAL_FILENAME}`);
  });
});

describe('credentialDrift', () => {
  const authoritative = {
    capabilityId: 'cap_1',
    principalId: 'prn_1',
    role: 'goal_hub',
    scopes: ['channel:read', 'channel:publish'],
    expiresAt: '2030-01-01T00:00:00.000Z'
  };

  test('a document claiming nothing never drifts', () => {
    expect(credentialDrift(null, authoritative)).toEqual([]);
  });

  test('scope order is not drift, but a different scope set is', () => {
    expect(
      credentialDrift({ scopes: ['channel:publish', 'channel:read'] }, authoritative)
    ).toEqual([]);
    expect(credentialDrift({ scopes: ['channel:read'] }, authoritative)).toEqual(['scopes']);
  });

  test('a renewed or narrowed capability is reported field by field', () => {
    expect(
      credentialDrift(
        { role: 'root', expiresAt: '2020-01-01T00:00:00.000Z', capabilityId: 'cap_1' },
        authoritative
      )
    ).toEqual(['expiresAt', 'role']);
  });
});
