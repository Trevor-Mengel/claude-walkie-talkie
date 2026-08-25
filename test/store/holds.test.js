import { describe, test, expect, afterEach } from 'vitest';
import { createHold, releaseHold, getHold, activeHoldsFor, isHeld } from '../../src/store/holds.js';
import { createPrincipal } from '../../src/store/principals.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;
let operator;

afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function setup() {
  fixture = createTmpStore();
  operator = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

function hold(overrides = {}) {
  return createHold(fixture.store, {
    subjectKind: 'thread',
    subjectId: 'thread-1',
    reason: 'under review',
    createdBy: operator.id,
    ...overrides
  });
}

describe('holds', () => {
  test('a hold makes its subject held until released', () => {
    setup();
    expect(isHeld(fixture.store, 'thread', 'thread-1')).toBe(false);

    const h = hold();
    expect(h.id).toMatch(/^hld_[0-9a-f]{16}$/);
    expect(h.releasedAt).toBe(null);
    expect(isHeld(fixture.store, 'thread', 'thread-1')).toBe(true);
    expect(activeHoldsFor(fixture.store, 'thread', 'thread-1').map((r) => r.id)).toEqual([h.id]);
    expect(getHold(fixture.store, h.id).reason).toBe('under review');

    const released = releaseHold(fixture.store, h.id);
    expect(released.releasedAt).toBeTruthy();
    expect(isHeld(fixture.store, 'thread', 'thread-1')).toBe(false);
    expect(activeHoldsFor(fixture.store, 'thread', 'thread-1')).toEqual([]);
  });

  test('holds are scoped per subject kind and id, and stack', () => {
    setup();
    const a = hold({ reason: 'legal' });
    const b = hold({ reason: 'incident' });
    hold({ subjectKind: 'event', subjectId: 'thread-1' });

    expect(activeHoldsFor(fixture.store, 'thread', 'thread-1').map((r) => r.id)).toEqual([
      a.id,
      b.id
    ]);
    expect(activeHoldsFor(fixture.store, 'event', 'thread-1').length).toBe(1);
    expect(isHeld(fixture.store, 'thread', 'thread-2')).toBe(false);

    releaseHold(fixture.store, a.id);
    expect(isHeld(fixture.store, 'thread', 'thread-1')).toBe(true);
    releaseHold(fixture.store, b.id);
    expect(isHeld(fixture.store, 'thread', 'thread-1')).toBe(false);
    expect(isHeld(fixture.store, 'event', 'thread-1')).toBe(true);
  });

  test('validates subject kind and required fields', () => {
    setup();
    expect(codeOf(() => hold({ subjectKind: 'message' }))).toBe('invalid_request');
    expect(codeOf(() => hold({ subjectId: '' }))).toBe('invalid_request');
    expect(codeOf(() => hold({ reason: '' }))).toBe('invalid_request');
    expect(codeOf(() => hold({ createdBy: '' }))).toBe('invalid_request');
    expect(codeOf(() => hold({ namespace: 'elsewhere' }))).toBe('wrong_namespace');
    expect(codeOf(() => isHeld(fixture.store, 'message', 'x'))).toBe('invalid_request');
  });

  test('releasing twice conflicts; releasing a stranger is not_found', () => {
    setup();
    const h = hold();
    releaseHold(fixture.store, h.id);
    expect(codeOf(() => releaseHold(fixture.store, h.id))).toBe('conflict');
    expect(codeOf(() => releaseHold(fixture.store, 'hld_0000000000000000'))).toBe('not_found');
    expect(getHold(fixture.store, 'hld_0000000000000000')).toBe(null);
  });
});
