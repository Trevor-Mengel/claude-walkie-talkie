/**
 * Redactor for hook log entries.
 *
 * The hook handles two values the model must never see and the operator's log must never
 * retain: the shared `hookSecret` and the one-use enrollment `code`. Rather than trusting
 * every call site to remember, everything written to the log is funnelled through
 * `redact()`, which drops secret-shaped KEYS and secret-shaped VALUES independently — so
 * a value that leaks in under an unexpected key name is still caught by its shape.
 */

export const REDACTED = '[redacted]';

/** Key names whose value is never logged, matched after case/separator normalisation. */
const SECRET_KEYS = new Set([
  'code',
  'enrollmentcode',
  'hooksecret',
  'secret',
  'token',
  'accesstoken',
  'capability',
  'password',
  'authorization',
  'bearer'
]);

/**
 * Structural fields the audit log exists to record. Their string values are kept
 * verbatim, because the value-shape rule below would otherwise eat exactly the field
 * that matters most: a namespaced tool name like `mcp__walkie-talkie_walkie_enroll` is
 * indistinguishable from a base64url blob by shape alone. The hook never writes a secret
 * under one of these keys — that is what makes the exemption safe rather than convenient.
 */
const STRUCTURAL_KEYS = new Set([
  'at',
  'stage',
  'toolname',
  'namespace',
  'role',
  'scopes',
  'selection',
  'outcome',
  'errorcode'
]);

/**
 * A base64url-ish blob: the shape of a capability token, an enrollment code, or a
 * base64url digest. Short opaque words (`Approve`, `listener`, `walkie-talkie`) stay
 * readable because they fall under the length floor.
 */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{20,}$/;

const MAX_DEPTH = 8;

/** @param {string} key */
function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** @param {string} key */
function isSecretKey(key) {
  return SECRET_KEYS.has(normalizeKey(key));
}

/** @param {string} key */
function isStructuralKey(key) {
  return STRUCTURAL_KEYS.has(normalizeKey(key));
}

/** @param {string} value */
function isTokenShaped(value) {
  return TOKEN_SHAPED.test(value);
}

/**
 * Deep-copy `value` with secrets removed. Never throws: a redactor that fails is a
 * redactor that tempts a call site to log the raw object instead.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @param {boolean} [trusted] set when the value sits under a structural key, which
 *   exempts its strings from the token-shape rule (see `STRUCTURAL_KEYS`).
 * @returns {unknown}
 */
export function redact(value, depth = 0, seen = new WeakSet(), trusted = false) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (trusted) return value;
    return isTokenShaped(value) ? REDACTED : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return REDACTED;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) {
    return { name: value.name, message: String(redact(value.message, depth + 1, seen)) };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, depth + 1, seen, trusted));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) out[key] = REDACTED;
      else out[key] = redact(item, depth + 1, seen, isStructuralKey(key));
    }
    return out;
  }
  return REDACTED;
}
