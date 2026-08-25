import { now } from '../core/time.js';
import { fail } from './errors.js';

export { now };

/**
 * The largest lifetime any store record may be given: one year of seconds.
 *
 * `requireTtl` previously checked only "positive integer", which let a caller mint a
 * credential expiring in the year 33715 — and, past `Date`'s representable range, made
 * `plusSeconds` throw a bare `RangeError` whose `code` is `undefined`, so `toWalkie` passed it
 * through and a plainly invalid `ttlSeconds` on `POST /delegate` was reported to the caller as
 * `500 internal`. This is the one surface where a caller is minting credentials, so a client
 * error must never read as a server fault. A year is already far past any legitimate TTL —
 * enrollment caps at a day (MAX_ENROLL_TTL_SECONDS) — so the bound costs nothing real.
 */
export const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * ISO timestamp `seconds` in the future. All store timestamps use the same
 * `Date#toISOString` shape so lexicographic comparison in SQL is a valid
 * chronological comparison — and that shape is only stable while the year stays four digits.
 * `Date` happily renders `+033715-05-22T08:08:58.119Z`, which sorts BEFORE every real
 * timestamp, so an unbounded offset silently breaks every expiry comparison in the store
 * rather than failing loudly. Past `Date`'s representable range it stops being silent and
 * becomes a bare `RangeError` with no `code`, which the route layer can only report as 500.
 *
 * Bounding the offset to `MAX_TTL_SECONDS` closes both: the offset is the only unbounded
 * input, and every caller passes a validated TTL.
 *
 * @param {number} seconds
 * @param {string} [from] ISO base, defaults to now
 * @returns {string}
 */
export function plusSeconds(seconds, from) {
  const base = from ? Date.parse(from) : Date.now();
  if (!Number.isFinite(base)) fail('invalid_request', 'invalid base timestamp');
  if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_TTL_SECONDS) {
    fail('invalid_request', `offset must be within ${MAX_TTL_SECONDS} seconds (one year)`, {
      seconds,
      max: MAX_TTL_SECONDS
    });
  }
  return new Date(base + seconds * 1000).toISOString();
}

/**
 * @param {unknown} seconds
 * @param {string} label
 * @returns {number}
 */
export function requireTtl(seconds, label = 'ttlSeconds') {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    fail('invalid_request', `${label} must be a positive integer number of seconds`);
  }
  if (seconds > MAX_TTL_SECONDS) {
    fail(
      'invalid_request',
      `${label} must not exceed ${MAX_TTL_SECONDS} seconds (one year)`,
      { field: label, [label]: seconds, max: MAX_TTL_SECONDS }
    );
  }
  return seconds;
}
