import { randomBytes } from 'node:crypto';

/** Prefixes used by the v0.3 authority layer. Event ids stay ULIDs (src/core/ids.js). */
export const ID_PREFIXES = Object.freeze({
  principal: 'prn',
  capability: 'cap',
  approval: 'apr',
  permit: 'pmt',
  hold: 'hld'
});

const ID_RE = /^(prn|cap|apr|pmt|hld)_[0-9a-f]{16}$/;

/**
 * `<prefix>_<16 lowercase hex>`.
 * @param {string} prefix
 * @returns {string}
 */
export function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** @param {unknown} id */
export function isStoreId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}
