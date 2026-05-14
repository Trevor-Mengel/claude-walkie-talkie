import { describe, test, expect } from 'vitest';
import { newId } from '../../src/core/ids.js';

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
