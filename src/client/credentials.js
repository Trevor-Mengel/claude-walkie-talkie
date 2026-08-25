/**
 * Reading a capability credential, and refusing to believe what it says about itself.
 *
 * A credential is accepted in two forms:
 *
 *   1. a bare token string — sufficient on its own, because `GET /self` resolves the rest;
 *   2. the JSON document `/enroll/exchange` returns, so a supervisor that already holds that
 *      object can pass it straight through.
 *
 * In form 2 ONLY the `token` field is authority. Role, scopes and expiry are read from the
 * server, never from the document: a document goes stale the moment the capability is renewed,
 * narrowed or revoked, and a client that trusted its own copy would keep asserting authority
 * it no longer has. When the document's claims disagree with the server we record the drift
 * once — a stale injection is a real signal, not noise to swallow.
 *
 * Nothing in this module ever puts a token, or the path of a credential file, into an error.
 */

import { readFileSync, statSync } from 'node:fs';
import { collabcastError } from '../identity/errors.js';
import { OPERATOR_CREDENTIAL_FILENAME, operatorCredentialPath } from '../authority/paths.js';

/** Fields a credential document may claim. Only `token` is ever trusted. */
const CLAIM_KEYS = Object.freeze([
  'capabilityId',
  'principalId',
  'role',
  'scopes',
  'expiresAt',
  'namespace'
]);

function requireToken(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw collabcastError('config_invalid', `${label} does not contain a capability token`);
  }
  const token = value.trim();
  if (/\s/.test(token)) {
    throw collabcastError('config_invalid', `${label} contains whitespace inside the token`);
  }
  return token;
}

/**
 * Parse either credential form.
 *
 * @param {unknown} raw
 * @param {string} label how to name the source in an error; MUST NOT be a filesystem path
 * @returns {{token:string, claimed:Record<string,unknown>|null}}
 */
export function parseCredential(raw, label = 'the credential') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw collabcastError('config_invalid', `${label} is empty`);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    // A JSON array is neither form; treating it as a token would send `[]` as a bearer.
    throw collabcastError('config_invalid', `${label} must be a bare token or a JSON object`);
  }
  if (!trimmed.startsWith('{')) {
    return { token: requireToken(trimmed, label), claimed: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw collabcastError(
      'config_invalid',
      `${label} looks like JSON but could not be parsed; supply either a bare token or the ` +
        'object returned by enrollment'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw collabcastError('config_invalid', `${label} must be a bare token or a JSON object`);
  }
  const token = requireToken(parsed.token, label);
  const claimed = {};
  for (const key of CLAIM_KEYS) {
    if (parsed[key] !== undefined) claimed[key] = parsed[key];
  }
  return { token, claimed: Object.keys(claimed).length === 0 ? null : claimed };
}

/**
 * Read `COLLABCAST_CAPABILITY`, if the supervisor injected one.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{token:string, claimed:Record<string,unknown>|null}|null}
 */
export function credentialFromEnv(env = process.env) {
  const raw = env.COLLABCAST_CAPABILITY;
  if (raw === undefined || raw.trim() === '') return null;
  return parseCredential(raw, 'COLLABCAST_CAPABILITY');
}

/**
 * Read the operator break-glass credential. The file must not be readable by group or other:
 * it holds a root capability, and a loose mode is a finding, not a warning.
 *
 * @param {string} runtimeRoot
 * @returns {{token:string, claimed:Record<string,unknown>|null}}
 */
export function readOperatorCredential(runtimeRoot) {
  const path = operatorCredentialPath(runtimeRoot);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw collabcastError(
      'unauthenticated',
      `no operator credential found in the collabcast runtime directory for this namespace ` +
        `(expected ${OPERATOR_CREDENTIAL_FILENAME}, mode 0600)`
    );
  }
  if (!stat.isFile()) {
    throw collabcastError(
      'config_invalid',
      `${OPERATOR_CREDENTIAL_FILENAME} in the collabcast runtime directory is not a regular file`
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw collabcastError(
      'config_invalid',
      `${OPERATOR_CREDENTIAL_FILENAME} is readable beyond its owner ` +
        `(mode ${(stat.mode & 0o777).toString(8)}); it holds a root capability and must be 0600`
    );
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw collabcastError(
      'config_invalid',
      `${OPERATOR_CREDENTIAL_FILENAME} in the collabcast runtime directory could not be read`
    );
  }
  return parseCredential(raw, `the operator credential (${OPERATOR_CREDENTIAL_FILENAME})`);
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.every((value, index) => value === right[index]);
  }
  return a === b;
}

/**
 * Which claimed fields disagree with what the server reports. `namespace` is compared
 * separately by the caller, which knows its own namespace.
 *
 * @param {Record<string,unknown>|null} claimed
 * @param {Record<string,unknown>} authoritative from `GET /self`
 * @returns {string[]} field names, sorted
 */
export function credentialDrift(claimed, authoritative) {
  if (!claimed) return [];
  const drifted = [];
  for (const key of CLAIM_KEYS) {
    if (key === 'namespace') continue;
    if (claimed[key] === undefined) continue;
    if (!sameValue(claimed[key], authoritative?.[key])) drifted.push(key);
  }
  return drifted.sort();
}
