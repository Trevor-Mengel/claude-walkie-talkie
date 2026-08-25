import { incrementBase32, monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/**
 * The ULID alphabet: Crockford base32 without I, L, O or U. Two properties this
 * codebase now depends on, so they are stated once, here:
 *
 *   1. Every id is exactly 26 characters, so a comparison never has to reason
 *      about differing lengths.
 *   2. The alphabet's ASCII order IS its numeric order (`0`-`9` then `A`-`Z`,
 *      with the four ambiguous letters simply absent), and the 48-bit
 *      millisecond timestamp occupies the leading 10 characters. So `a < b` as
 *      strings means `a` was minted no later than `b`.
 *
 * (2) is why a cursor is an id rather than an ordinal: it orders messages
 * without counting them. See the note at the top of `src/store/cursors.js`.
 */
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** @returns {string} 26-char Crockford base32 ULID, monotonic within the process */
export function newId() {
  return ulid();
}

/**
 * Is `value` a syntactically valid id — and therefore a usable cursor position?
 *
 * Lowercase is rejected rather than folded: lowercase letters sort ABOVE the
 * uppercase alphabet in ASCII, so accepting a lowercase spelling of an id would
 * make it compare greater than every real id and hide the whole channel behind
 * a cursor.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/**
 * A floor no new id can be placed above.
 *
 * `appendMessage` floors every new id on `highestId(channel.md)`, and that scan is
 * deliberately WIDER than the block parser — so one marker carrying the maximum base32
 * value (26 `Z`s, from a hand-edit, a bad merge, or a forged marker) reached
 * `incrementBase32`, which threw a bare `incorrectly encoded string`. That code is not in
 * the wire vocabulary, so `toWalkie` passed it straight through and every subsequent post
 * returned `500 internal` — for every principal, permanently, with nothing anywhere
 * naming the cause. The poison lives in the FILE, so the remedy is a human edit, and a
 * human edit needs the offending id.
 *
 * `conflict` rather than `internal`: the stored channel contradicts the operation and a
 * repair is what unblocks it — the same call `assertRenderable` makes for a corrupt body
 * fence, and retrying unchanged is pointless until the marker is gone.
 *
 * @param {string} floorId
 */
function floorExhausted(floorId) {
  const err = new Error(
    `channel id space is exhausted at ${floorId}: no id sorts above it, so no new message ` +
      'can be minted until that marker is removed from channel.md by hand'
  );
  err.code = 'conflict';
  err.detail = { floorId };
  return err;
}

/**
 * Mints an id strictly greater than `floorId`.
 *
 * `monotonicFactory` only guarantees monotonicity within one process: a daemon
 * restart re-seeds it from the clock, so an NTP correction (or a VM snapshot
 * restore, or a manual `date`) that steps the clock backwards mints an id below
 * ids that already exist. Under id-anchored cursors that is not a cosmetic
 * ordering wobble — a message minted below every reader's cursor is invisible to
 * all of them, forever, with no error anywhere. Exactly the loss mode that
 * anchoring the cursor to the id was introduced to remove.
 *
 * So the caller supplies the floor it must beat (in practice: the highest id
 * already in the channel, read under the channel write lock) and monotonicity
 * stops depending on the clock at all. When the minted id already clears the
 * floor it is used unchanged; otherwise the floor's immediate successor is used,
 * which is greater than the floor by construction and cannot collide with an
 * existing id (nothing sits between the maximum and its successor). The
 * successor carries the floor's embedded timestamp rather than the current one —
 * the id is an ordering token, and the message's wall-clock time is the marker's
 * own `timestamp` field.
 *
 * @param {string|null|undefined} floorId an id the result must exceed; empty means "no floor"
 * @returns {string}
 */
export function newIdAfter(floorId) {
  if (floorId === undefined || floorId === null || floorId === '') return ulid();
  if (!isId(floorId)) {
    throw new Error(`newIdAfter: floor ${JSON.stringify(floorId)} is not an id`);
  }
  const minted = ulid();
  if (minted > floorId) return minted;
  // `isId` has already guaranteed 26 valid Crockford characters, so the only way the
  // increment can fail is that the floor IS the maximum. Caught rather than pre-checked
  // so no future overflow shape can escape as an unhandled throw: whatever the reason,
  // "this floor has no successor" is the true statement and the operator needs the id.
  try {
    return incrementBase32(floorId);
  } catch {
    throw floorExhausted(floorId);
  }
}
