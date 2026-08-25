/**
 * Canonical error surface for the store layer.
 *
 * Every failure crossing a module boundary is a StoreError carrying one of the
 * codes below. `toEnvelope` renders the wire shape used by every layer:
 *
 *   { error: { code, message, detail? } }
 *
 * The code vocabulary itself lives in `src/identity/errors.js` and is re-exported
 * here, not redeclared: two hand-maintained copies drifted once already (one gained
 * `unavailable`, the other did not) and nothing caught it.
 *
 * Rule: never place a raw token, a secret, or the filesystem path of a
 * credential file into `message` or `detail`. Use `redactDetail` from audit.js
 * when the payload is not hand-authored.
 */

import { ERROR_CODES } from '../identity/errors.js';

export { ERROR_CODES };

const CODE_SET = new Set(ERROR_CODES);

export class StoreError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable, secret-free
   * @param {object} [detail] structured, secret-free
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'StoreError';
    this.code = CODE_SET.has(code) ? code : 'internal';
    if (!CODE_SET.has(code)) {
      this.detail = { ...(detail || {}), unmapped_code: String(code) };
    } else if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [detail]
 * @returns {StoreError}
 */
export function storeError(code, message, detail) {
  return new StoreError(code, message, detail);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [detail]
 * @returns {never}
 */
export function fail(code, message, detail) {
  throw new StoreError(code, message, detail);
}

/**
 * Renders any thrown value as the canonical wire envelope.
 * Unknown errors collapse to `internal` and their message is dropped, because
 * driver-level messages can contain file paths and bound parameter values.
 * @param {unknown} err
 * @returns {{error:{code:string,message:string,detail?:object}}}
 */
export function toEnvelope(err) {
  if (err instanceof StoreError) {
    const out = { code: err.code, message: err.message };
    if (err.detail !== undefined) out.detail = err.detail;
    return { error: out };
  }
  return { error: { code: 'internal', message: 'internal error' } };
}
