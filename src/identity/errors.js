/**
 * The single error vocabulary for the walkie authority layer.
 *
 * Every layer (store, identity, config, transport, routes, MCP, CLI) surfaces failures as
 * `{ error: { code, message, detail? } }`. `code` is drawn from ERROR_CODES; anything else is a
 * programming mistake and throws at construction time so it cannot leak to a client.
 *
 * Never place a token, a secret, or the path of a credential file into `message` or `detail`.
 */

export const ERROR_CODES = Object.freeze([
  'unauthenticated',
  'forbidden',
  'not_owner',
  'wrong_namespace',
  'scope_required',
  'permit_required',
  'permit_invalid',
  'stale_fence',
  'invalid_request',
  'not_found',
  'conflict',
  'config_invalid',
  'namespace_unresolved',
  // The write lost a race and nothing was changed: retrying the SAME request shortly is
  // the correct remedy. Deliberately not `conflict`, which means the request contradicts
  // current state and retrying it unchanged is pointless — a caller that cannot tell the
  // two apart either abandons a write that would have succeeded or hammers one that never
  // will. Deliberately not `internal`, which is what the channel lock used to surface and
  // is a report-a-bug signal, so an agent had no way to know retrying was right.
  'busy',
  // The service this client must reach is not listening. Distinct from `internal`: nothing
  // failed, the supervised process simply is not there, and the caller's remedy is different.
  'unavailable',
  'internal'
]);

export class WalkieError extends Error {
  /**
   * @param {string} code - one of ERROR_CODES
   * @param {string} message - human-readable, secret-free
   * @param {object} [detail] - structured, secret-free context
   */
  constructor(code, message, detail) {
    super(message);
    if (!ERROR_CODES.includes(code)) {
      throw new Error(`unknown walkie error code: ${String(code)}`);
    }
    this.name = 'WalkieError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** @returns {{error:{code:string,message:string,detail?:object}}} */
  toEnvelope() {
    const error = { code: this.code, message: this.message };
    if (this.detail !== undefined) error.detail = this.detail;
    return { error };
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [detail]
 * @returns {WalkieError}
 */
export function walkieError(code, message, detail) {
  return new WalkieError(code, message, detail);
}

/** @param {unknown} value */
export function isWalkieError(value) {
  return value instanceof WalkieError;
}

/**
 * Renders an untrusted value for an error message without dumping large structures.
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value.length > 64 ? `${value.slice(0, 61)}...` : value);
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return t === 'object' ? 'object' : t;
}
