import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/** @returns {string} 26-char Crockford base32 ULID, monotonic within the process */
export function newId() {
  return ulid();
}
