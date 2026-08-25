import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.js';

/** Length in bytes of every secret this layer mints. */
export const SECRET_BYTES = 32;

/**
 * @param {string|Buffer} input
 * @returns {Buffer} raw sha256
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest();
}

/**
 * @param {string|Buffer} input
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 32 random bytes, base64url. Never persisted — only its sha256 is. */
export function newSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/** Every digest this layer binds to is a sha256, so every digest is this long. */
export const DIGEST_BYTES = 32;

/**
 * Coerces a caller-supplied digest to a Buffer. Accepts a Buffer/Uint8Array or
 * a lowercase-or-uppercase hex string; anything else is a request error.
 *
 * The length is pinned. Every digest in this store is a sha256 — an approval's
 * `subjectDigest`, a permit's `contentDigest` — and both are compared with
 * `digestEquals`, which returns false on a length mismatch and otherwise
 * compares only the bytes it was given. Accepting any even-length hex therefore
 * let a permit be bound to a one-byte digest, reducing `consumePermit`'s binding
 * check from 256 bits of content commitment to 8: a caller who could choose the
 * digest could burn a permit against 1-in-256 arbitrary content. Nothing in P0
 * reaches `grantPermit`, so this is pinned before P1 wires retention rather than
 * after.
 *
 * @param {Buffer|Uint8Array|string} value
 * @param {string} label
 * @returns {Buffer}
 */
export function toDigest(value, label = 'digest') {
  const buf = asBuffer(value);
  if (buf === null) {
    fail('invalid_request', `${label} must be a byte buffer or hex string`);
  }
  if (buf.length !== DIGEST_BYTES) {
    fail('invalid_request', `${label} must be ${DIGEST_BYTES} bytes`, {
      bytes: buf.length
    });
  }
  return buf;
}

/**
 * @param {unknown} value
 * @returns {Buffer|null} null when the shape itself is wrong
 */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value.toLowerCase(), 'hex');
  }
  return null;
}

/**
 * Constant-time equality for two digests of any length.
 * @param {Buffer|Uint8Array} a
 * @param {Buffer|Uint8Array} b
 */
export function digestEquals(a, b) {
  if (!a || !b) return false;
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
