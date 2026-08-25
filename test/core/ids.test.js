import { describe, test, expect } from 'vitest';
import { isId, newId, newIdAfter } from '../../src/core/ids.js';

describe('ids', () => {
  test('newId() returns a 26-char Crockford base32 ULID', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('successive calls return monotonically increasing IDs', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test('10,000 generated IDs are all unique', () => {
    const seen = new Set();
    for (let i = 0; i < 10000; i += 1) seen.add(newId());
    expect(seen.size).toBe(10000);
  });
});

describe('isId', () => {
  test('accepts a minted id and nothing shaped differently', () => {
    expect(isId(newId())).toBe(true);
    for (const bad of [
      '',
      null,
      undefined,
      2,
      newId().toLowerCase(),
      `${newId()}X`,
      newId().slice(0, 25),
      // I, L, O and U are not in the alphabet, so they are not ids.
      '01JIIIIIIIIIIIIIIIIIIIIIII'
    ]) {
      expect(isId(bad), String(bad)).toBe(false);
    }
  });
});

// `monotonicFactory` is monotonic within ONE process only. Across a restart it is re-seeded
// from the clock, so an NTP correction or a snapshot restore that steps the clock backwards
// mints an id below ids that already exist — and since a cursor is a message id, such a
// message would sit below every reader's cursor and never be delivered to anyone.
describe('newIdAfter never mints below its floor', () => {
  test('a fresh id is used unchanged when it already clears the floor', () => {
    const floor = newId();
    const next = newIdAfter(floor);
    expect(isId(next)).toBe(true);
    expect(next > floor).toBe(true);
  });

  test('an id from the future is still beaten', () => {
    // A floor minted ~10 years ahead: whatever the clock says, the result must exceed it.
    const future = '0K000000000000000000000000';
    const next = newIdAfter(future);
    expect(isId(next)).toBe(true);
    expect(next > future).toBe(true);
  });

  test('repeated mints against a future floor keep climbing and never collide', () => {
    let floor = '0K000000000000000000000000';
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) {
      const next = newIdAfter(floor);
      expect(next > floor, `${next} > ${floor}`).toBe(true);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      floor = next;
    }
  });

  test('no floor means an ordinary id', () => {
    for (const none of [undefined, null, '']) {
      expect(isId(newIdAfter(none))).toBe(true);
    }
  });

  test('a floor that is not an id is a programming error, not a silent pass', () => {
    for (const bad of [42, 'nope', '01jiiiiiiiiiiiiiiiiiiiiiii']) {
      expect(() => newIdAfter(bad)).toThrow(/not an id/);
    }
  });

  // `appendMessage` floors every new id on `highestId(channel.md)`, and that scan accepts
  // any 26-char Crockford token — so a single marker holding the MAXIMUM value reached
  // `incrementBase32`, which threw a bare `incorrectly encoded string`. Not a WalkieError,
  // and `internal` is not a code an operator can act on, so every subsequent post to that
  // channel returned `500 internal` — for every principal, permanently, with nothing
  // naming the cause. `Z` is in the alphabet, so this is a legal id, not a malformed one.
  test('a floor with no successor is a named domain failure that identifies the id', () => {
    const max = 'Z'.repeat(26);
    expect(isId(max)).toBe(true);
    let thrown;
    try {
      newIdAfter(max);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Repairable stored state, not a bug report: `conflict` is what the channel's other
    // "a human must fix this block" failure (`assertRenderable`) already uses, and it is
    // in the wire vocabulary, so it reaches the client as 409 rather than an opaque 500.
    expect(thrown.code).toBe('conflict');
    // An operator cannot find the poisoned marker without the id, so the id is in both
    // the message and the structured detail.
    expect(thrown.message).toContain(max);
    expect(thrown.message).toContain('channel.md');
    expect(thrown.detail).toEqual({ floorId: max });
  });

  // One below the maximum still has a successor, so the refusal is exactly as narrow as
  // the arithmetic — it does not start rejecting high-but-usable floors.
  test('the floor immediately below the maximum still mints', () => {
    const nearMax = `${'Z'.repeat(25)}Y`;
    expect(newIdAfter(nearMax)).toBe('Z'.repeat(26));
  });
});
