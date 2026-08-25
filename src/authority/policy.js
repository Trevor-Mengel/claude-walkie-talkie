/**
 * What an operator approval is allowed to authorise.
 *
 * The hook proves *a human clicked Approve*. It does not prove the request the human
 * saw was reasonable, and the request itself arrives from an agent-controlled tool
 * call. So the authority re-checks every field against a fixed policy before it
 * records anything: role, scopes and TTL are validated here, not in the socket
 * handler and not in the store.
 *
 * The single most important rule: hook enrollment mints a `root` principal and
 * nothing else. Goal hubs and listeners are *delegated* by an enrolled root through
 * `POST /delegate`, where the store enforces scope-subset and expiry-ceiling against
 * the parent capability. An operator dialog is not a delegation graph, and letting it
 * mint arbitrary roles would put every future principal one dialog away from root's
 * authority.
 */

import { CollabcastError } from '../identity/errors.js';
import { SCOPES } from '../store/capabilities.js';

/** The only role hook enrollment may mint. */
export const ENROLL_ROLE = 'root';

/** Roles a hook approval may enroll. Kept as a set for symmetry with the store. */
export const ENROLLABLE_ROLES = Object.freeze([ENROLL_ROLE]);

/**
 * The widest grant each role may hold. `root` deliberately excludes
 * `permit:administer` and `retention:approve`: destructive authority is reached
 * through an operator CLI attestation, never through an agent-initiated dialog.
 *
 * `operator` is that attestation, so it holds every scope the store defines. Two consequences
 * worth stating out loud. It is the only role that reaches the destructive scopes, which is what
 * "through an operator CLI attestation" above has always meant and now names. And a break-glass
 * `enroll --recovery` can hand down any delegable role's full allowlist, because
 * `issueCapability` refuses a child scope the parent does not hold — an operator missing
 * `listener:consume` could not mint a working listener, which is exactly the credential a
 * break-glass path exists to produce.
 *
 * `operator` is NOT in `ENROLLABLE_ROLES` or the delegation allowlist: it is minted only by the
 * service, for the human whose uid owns the runtime directory (see `operator-credential.js`).
 */
export const ROLE_SCOPES = Object.freeze({
  operator: Object.freeze([...SCOPES]),
  root: Object.freeze([
    'channel:read',
    'channel:publish',
    'channel:ack',
    'self:alias',
    'self:cursor',
    'enroll:delegate'
  ]),
  goal_hub: Object.freeze([
    'channel:read',
    'channel:publish',
    'channel:ack',
    'self:alias',
    'self:cursor'
  ]),
  listener: Object.freeze([
    'channel:read',
    'listener:consume',
    'listener:receipt',
    'self:alias',
    'self:cursor'
  ])
});

/** Capability lifetime bounds for a hook-enrolled capability. */
export const MIN_ENROLL_TTL_SECONDS = 60;
export const MAX_ENROLL_TTL_SECONDS = 86400;
export const DEFAULT_ENROLL_TTL_SECONDS = 3600;

/**
 * Enrollment-code lifetime. The code is a bearer secret in flight between the hook
 * and the MCP client, so its window is seconds-to-minutes, not hours.
 */
export const DEFAULT_CODE_TTL_SECONDS = 120;
export const MIN_CODE_TTL_SECONDS = 5;
export const MAX_CODE_TTL_SECONDS = 900;

/**
 * The one message every refusal that must not be distinguishable shares. A bad
 * secret and an unknown namespace are both "someone who should not be talking to
 * this socket is talking to this socket"; telling them apart would let a caller
 * enumerate namespaces, or confirm a stolen secret against the wrong project.
 * The audit row records which one it really was.
 */
export const DENIED_MESSAGE = 'enrollment request was refused';

/** Error codes whose reply collapses to DENIED_MESSAGE on the wire. */
export const OPAQUE_CODES = Object.freeze(['wrong_namespace', 'unauthenticated']);

const STORE_SCOPES = new Set(SCOPES);

/**
 * @param {string} role
 * @returns {string[]} the role's scope allowlist
 */
export function scopesForRole(role) {
  const allowed = ROLE_SCOPES[role];
  if (!allowed) {
    throw new CollabcastError('forbidden', 'role has no scope allowlist', { role: String(role) });
  }
  return [...allowed];
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireTtlSeconds(value) {
  if (value === undefined || value === null) return DEFAULT_ENROLL_TTL_SECONDS;
  // A string, a float and a boolean are all rejected: `Number.isInteger` is the whole
  // check, deliberately without coercion, so `'60'` cannot become 60 somewhere in the
  // chain and quietly widen an approval the operator read as seconds.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CollabcastError('invalid_request', 'ttlSeconds must be an integer number of seconds', {
      min: MIN_ENROLL_TTL_SECONDS,
      max: MAX_ENROLL_TTL_SECONDS
    });
  }
  if (value < MIN_ENROLL_TTL_SECONDS || value > MAX_ENROLL_TTL_SECONDS) {
    throw new CollabcastError('invalid_request', 'ttlSeconds is outside the permitted range', {
      ttlSeconds: value,
      min: MIN_ENROLL_TTL_SECONDS,
      max: MAX_ENROLL_TTL_SECONDS
    });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function requireCodeTtlSeconds(value, fallback = DEFAULT_CODE_TTL_SECONDS) {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CODE_TTL_SECONDS ||
    value > MAX_CODE_TTL_SECONDS
  ) {
    throw new CollabcastError('config_invalid', 'the enrollment window is outside the permitted range', {
      min: MIN_CODE_TTL_SECONDS,
      max: MAX_CODE_TTL_SECONDS
    });
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} role
 * @returns {string[]} sorted, de-duplicated
 */
function requireScopes(value, role) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CollabcastError('invalid_request', 'scopes must be a non-empty array of scope names');
  }
  const allowed = new Set(scopesForRole(role));
  const seen = new Set();
  for (const scope of value) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new CollabcastError('invalid_request', 'every scope must be a non-empty string');
    }
    if (!STORE_SCOPES.has(scope)) {
      throw new CollabcastError('forbidden', 'unknown scope', { scope });
    }
    if (!allowed.has(scope)) {
      throw new CollabcastError('forbidden', 'scope is not permitted for this role', { scope, role });
    }
    seen.add(scope);
  }
  return [...seen].sort();
}

/**
 * Validates an enrollment request against policy and returns the normalised grant.
 *
 * Throws rather than returning a verdict object: every caller must fail closed, and a
 * boolean return is one forgotten `if` away from an authority bypass.
 *
 * @param {{namespace?:unknown, role?:unknown, scopes?:unknown, ttlSeconds?:unknown,
 *          config:{namespace:string}}} request
 * @returns {{namespace:string, role:string, scopes:string[], ttlSeconds:number}}
 */
export function assertEnrollable({ namespace, role, scopes, ttlSeconds, config } = {}) {
  const expected = config?.namespace;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new CollabcastError('namespace_unresolved', 'the authority has no namespace of its own');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new CollabcastError('invalid_request', 'namespace is required');
  }
  if (namespace !== expected) {
    // Opaque on the wire (see DENIED_MESSAGE); the detail is for the audit row only.
    throw new CollabcastError('wrong_namespace', 'namespace does not match this authority', {
      requested: namespace
    });
  }
  if (typeof role !== 'string' || role.length === 0) {
    throw new CollabcastError('invalid_request', 'role is required');
  }
  if (!ENROLLABLE_ROLES.includes(role)) {
    throw new CollabcastError(
      'forbidden',
      'only the namespace root may be enrolled by operator approval; ' +
        'other roles are delegated by an enrolled root',
      { role, enrollable: [...ENROLLABLE_ROLES] }
    );
  }
  return {
    namespace,
    role,
    scopes: requireScopes(scopes, role),
    ttlSeconds: requireTtlSeconds(ttlSeconds)
  };
}
