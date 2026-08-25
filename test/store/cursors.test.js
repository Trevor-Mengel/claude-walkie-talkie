import { describe, test, expect, afterEach } from 'vitest';
import {
  advanceCursor,
  getCursor,
  getCursors,
  getCursorViews,
  cursorView,
  cursorKindsToAdvance,
  CURSOR_KINDS,
  VIEW_DEFAULT,
  VIEW_WITH_MEMORY,
  NO_CURSOR
} from '../../src/store/cursors.js';
import { createPrincipal } from '../../src/store/principals.js';
import { newId } from '../../src/core/ids.js';
import { openStore } from '../../src/store/db.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture = null;

afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

// A cursor position is a message id. These are minted in ascending order, so `A < B < C`
// as strings — the ordering the store's UPSERT predicate relies on.
const A = newId();
const B = newId();
const C = newId();

function setup() {
  fixture = createTmpStore();
  const principal = createPrincipal(fixture.store, { role: 'goal_hub', displayAlias: 'Main' });
  return { ...fixture, principal };
}

describe('cursors', () => {
  test('minted ids are ascending, which is what the store compares', () => {
    expect(A < B).toBe(true);
    expect(B < C).toBe(true);
    // And NO_CURSOR is below every id, so "never acked" needs no special case.
    expect(NO_CURSOR < A).toBe(true);
  });

  test('an unset cursor reads as NO_CURSOR without creating a row', () => {
    const { store, principal } = setup();
    expect(getCursor(store, principal.id, 'read')).toBe(NO_CURSOR);
    expect(getCursors(store, principal.id)).toEqual({ read: NO_CURSOR, ack: NO_CURSOR });
    expect(store.db.prepare('SELECT COUNT(*) c FROM cursor').get().c).toBe(0);
  });

  test('advancing is monotonic and idempotent', () => {
    const { store, principal } = setup();
    expect(
      advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: B })
    ).toEqual({ messageId: B, advanced: true });
    // Lower, then equal: both report the surviving value and neither advances.
    expect(
      advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: A })
    ).toEqual({ messageId: B, advanced: false });
    expect(
      advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: B })
    ).toEqual({ messageId: B, advanced: false });
    expect(
      advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: C })
    ).toEqual({ messageId: C, advanced: true });
  });

  test('read and ack are separate rows', () => {
    const { store, principal } = setup();
    advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'read', messageId: C });
    advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: A });
    expect(getCursors(store, principal.id)).toEqual({ read: C, ack: A });
    // Four kinds, not two: `GET /inbox` serves two differently-filtered sets and a scalar
    // high-water mark is sound only over the set it was recorded against.
    expect(CURSOR_KINDS).toEqual(['read', 'ack', 'read_with_memory', 'ack_with_memory']);
  });

  test('a foreign-namespace row is invisible and never overwritten', () => {
    const { store, principal } = setup();
    // The store file is pinned to one namespace, so a foreign row can only get
    // there out of band. Plant one under the SAME principal id and prove the
    // namespace predicate on every read and the UPSERT keeps them apart.
    store.db
      .prepare(
        'INSERT INTO cursor (namespace, owner_principal_id, kind, last_message_id, updated_at) ' +
          "VALUES ('other-project', ?, 'ack', ?, '2020-01-01T00:00:00.000Z')"
      )
      .run(principal.id, C);

    expect(getCursor(store, principal.id, 'ack')).toBe(NO_CURSOR);
    expect(getCursors(store, principal.id)).toEqual({ read: NO_CURSOR, ack: NO_CURSOR });

    advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: A });
    expect(getCursor(store, principal.id, 'ack')).toBe(A);
    const foreign = store.db
      .prepare(
        "SELECT last_message_id FROM cursor WHERE namespace = 'other-project' AND kind = 'ack'"
      )
      .get();
    expect(foreign.last_message_id).toBe(C);
  });

  test('an unknown kind, a missing owner and a non-id position all fail closed', () => {
    const { store, principal } = setup();
    expect(() => getCursor(store, principal.id, 'nonsense')).toThrow(/cursor kind/);
    expect(() => getCursor(store, '', 'read')).toThrow(/ownerPrincipalId/);
    // An ordinal is the specific thing a cursor must never be again: `2` meant "the second
    // message that currently parses", which moved whenever an older message stopped parsing.
    for (const messageId of [2, -1, 1.5, '2', null, undefined, Number.NaN, NO_CURSOR]) {
      expect(() =>
        advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId })
      ).toThrow(/messageId/);
    }
    expect(store.db.prepare('SELECT COUNT(*) c FROM cursor').get().c).toBe(0);
  });

  // The store half of the S1 fix: the two views are separate rows, so neither can drag
  // the other's mark forward. A single scalar mark over two differently-filtered sets put
  // an undelivered memory-update permanently below the cutoff.
  test('the two views are independent rows and read back independently', () => {
    const { store, principal } = setup();
    advanceCursor(store, { ownerPrincipalId: principal.id, kind: 'ack', messageId: C });

    expect(getCursors(store, principal.id)).toEqual({ read: NO_CURSOR, ack: C });
    // The memory-inclusive view is untouched: nothing was ever delivered in it.
    expect(getCursors(store, principal.id, { includeMemoryUpdates: true })).toEqual({
      read: NO_CURSOR,
      ack: NO_CURSOR
    });
    expect(getCursorViews(store, principal.id)).toEqual({
      default: { read: NO_CURSOR, ack: C },
      withMemoryUpdates: { read: NO_CURSOR, ack: NO_CURSOR }
    });

    // And the reverse: the inclusive mark does not leak into the default reader either.
    advanceCursor(store, {
      ownerPrincipalId: principal.id,
      kind: 'ack_with_memory',
      messageId: B
    });
    expect(getCursors(store, principal.id)).toEqual({ read: NO_CURSOR, ack: C });
    expect(getCursors(store, principal.id, { includeMemoryUpdates: true })).toEqual({
      read: NO_CURSOR,
      ack: B
    });
  });

  // The asymmetry is the design, not an oversight, so it is asserted rather than left to
  // the route to imply: reading the inclusive view is evidence for both marks, reading the
  // default view is no evidence at all about the memory-updates it hid.
  test('a write against the inclusive view advances both marks, the default view one', () => {
    expect(cursorView(false)).toBe(VIEW_DEFAULT);
    expect(cursorView(true)).toBe(VIEW_WITH_MEMORY);

    expect(cursorKindsToAdvance(false, 'ack')).toEqual(['ack']);
    expect(cursorKindsToAdvance(true, 'ack')).toEqual(['ack', 'ack_with_memory']);
    expect(cursorKindsToAdvance(false, 'read')).toEqual(['read']);
    expect(cursorKindsToAdvance(true, 'read')).toEqual(['read', 'read_with_memory']);

    // Anything that is not exactly `true` is the default view. A flag arriving as the
    // string 'true' from a query string must not widen a cursor write by accident.
    for (const raw of [undefined, null, 0, '', 'true', 'false', 1]) {
      expect(cursorKindsToAdvance(raw, 'ack')).toEqual(['ack']);
    }
  });
});

// The v4 -> v5 upgrade replaces the ordinal column with a message id, and v5 -> v6 widens
// `kind` for the memory-inclusive view. There is no honest translation of a stored ordinal
// — it named a position among whatever parsed at the moment it was written — so the table
// is rebuilt empty. The direction of that reset is the point: to the BEGINNING, so a reader
// re-sees messages it already processed (at-least-once, which every consumer dedupes by
// id), never to the END, which would skip messages that were never delivered — the exact
// loss this change exists to remove. A v4 file has to walk BOTH hops, so this also pins
// that the chain does not stop one short.
describe('upgrading a v4 store', () => {
  test('walks 4 -> 5 -> 6 and resets every cursor rather than translating it', () => {
    const { store, path, namespace } = setup();
    const principalId = 'prn_0000000000000001';
    // Rewind the file to the v4 shape: the old ordinal column, with a position in it.
    store.db.exec('DROP TABLE cursor');
    store.db.exec(
      'CREATE TABLE cursor (namespace TEXT NOT NULL, owner_principal_id TEXT NOT NULL, ' +
        "kind TEXT NOT NULL CHECK(kind IN ('read','ack')), seq INTEGER NOT NULL DEFAULT 0, " +
        'updated_at TEXT NOT NULL, PRIMARY KEY(namespace, owner_principal_id, kind))'
    );
    store.db
      .prepare(
        'INSERT INTO cursor (namespace, owner_principal_id, kind, seq, updated_at) ' +
          "VALUES (?, ?, 'ack', 7, '2020-01-01T00:00:00.000Z')"
      )
      .run(namespace, principalId);
    store.db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
    store.close();

    const upgraded = openStore({ path, namespace });
    try {
      expect(
        upgraded.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
          .value
      ).toBe('6');
      expect(upgraded.db.prepare('SELECT COUNT(*) c FROM cursor').get().c).toBe(0);
      expect(getCursors(upgraded, principalId)).toEqual({ read: NO_CURSOR, ack: NO_CURSOR });
      // And the new column is what the rebuilt table has.
      const columns = upgraded.db
        .prepare("SELECT name FROM pragma_table_info('cursor')")
        .all()
        .map((r) => r.name);
      expect(columns).toContain('last_message_id');
      expect(columns).not.toContain('seq');

      // v6's kinds are usable on a file that arrived here through v5, not only on a fresh
      // one — and the v4 ordinal is gone from both views, not carried into either.
      expect(getCursors(upgraded, principalId, { includeMemoryUpdates: true })).toEqual({
        read: NO_CURSOR,
        ack: NO_CURSOR
      });
      advanceCursor(upgraded, {
        ownerPrincipalId: principalId,
        kind: 'ack_with_memory',
        messageId: A
      });
      expect(getCursorViews(upgraded, principalId)).toEqual({
        default: { read: NO_CURSOR, ack: NO_CURSOR },
        withMemoryUpdates: { read: NO_CURSOR, ack: A }
      });
    } finally {
      upgraded.close();
    }
  });
});
