import { WalkieError, describeValue } from './errors.js';

/**
 * A namespace is a stable identity key (e.g. `walkie-talkie`) attached to every credential,
 * event, cursor, lease, permit and audit row. It is host configuration, never request input.
 */
export const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** @param {unknown} value */
export function isNamespace(value) {
  return typeof value === 'string' && NAMESPACE_RE.test(value);
}

/**
 * @param {unknown} value
 * @param {{code?:string, label?:string, detail?:object}} [opts]
 * @returns {string}
 */
export function assertNamespace(value, opts = {}) {
  const { code = 'config_invalid', label = 'namespace', detail } = opts;
  if (!isNamespace(value)) {
    throw new WalkieError(
      code,
      `${label} must match ${NAMESPACE_RE.source} (got ${describeValue(value)})`,
      detail
    );
  }
  return value;
}
