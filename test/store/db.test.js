import { describe, test, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { BUSY_TIMEOUT_MS, openStore, SCHEMA_VERSION } from '../../src/store/db.js';
import { createPrincipal, getPrincipal, listPrincipals } from '../../src/store/principals.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

function mode(path) {
  return statSync(path).mode & 0o777;
}

describe('openStore', () => {
  test('credential material is owner-only: db file 0600, parent directory 0700', () => {
    fixture = createTmpStore();
    expect(mode(fixture.path).toString(8)).toBe('600');
    expect(mode(fixture.dir).toString(8)).toBe('700');
  });

  test('records schema version and namespace, and reopens idempotently', () => {
    fixture = createTmpStore();
    const read = (key) =>
      fixture.store.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key).value;
    expect(read('schema_version')).toBe(SCHEMA_VERSION);
    // Pinned as a literal as well as against the constant, so a version bump has
    // to be a deliberate edit here rather than a silently-satisfied tautology.
    expect(read('schema_version')).toBe('6');
    expect(read('namespace')).toBe(fixture.namespace);

    const principal = createPrincipal(fixture.store, { role: 'root', displayAlias: 'root' });
    fixture.store.close();

    const reopened = openStore({ path: fixture.path, namespace: fixture.namespace });
    fixture.store = reopened;
    expect(getPrincipal(reopened, principal.id).displayAlias).toBe('root');
    expect(mode(fixture.path).toString(8)).toBe('600');
  });

  test('refuses to open a store belonging to another namespace', () => {
    fixture = createTmpStore();
    fixture.store.close();
    let err;
    try {
      openStore({ path: fixture.path, namespace: 'some-other-project' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('config_invalid');
    expect(err.detail).toEqual({ found: 'collabcast', expected: 'some-other-project' });
    // reopen under the right namespace so cleanup has a live handle
    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
  });

  test('refuses to open a store written by a different schema version', () => {
    fixture = createTmpStore();
    fixture.store.db
      .prepare("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'")
      .run();
    fixture.store.close();
    let err;
    try {
      openStore({ path: fixture.path, namespace: fixture.namespace });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('config_invalid');
    expect(err.detail.found).toBe('2');
    expect(err.detail.expected).toBe('6');
  });

  test('requires a path and a namespace', () => {
    expect(() => openStore({ namespace: 'x' })).toThrowError(/store path is required/);
    let err;
    try {
      openStore({ path: join('/tmp', 'never-created.db') });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('namespace_unresolved');
  });

  // Named, not counted: the previous title said "the three load-bearing PRAGMAs"
  // and that count was itself the defect — `busy_timeout` was added later and the
  // test kept passing without it, so deleting the line would have come back as
  // intermittent SQLITE_BUSY under concurrency instead of a red test.
  test('applies every load-bearing PRAGMA: WAL, foreign_keys, synchronous, busy_timeout', () => {
    fixture = createTmpStore();
    // The same handle openStore returned. busy_timeout and foreign_keys are
    // per-connection, so a second connection to the same file would report the
    // defaults and fail for a reason unrelated to the invariant.
    const pragma = (name) => fixture.store.db.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('synchronous')).toBe(2); // FULL
    // Read from the constant, so the assertion is that the value SQLite holds is
    // the one the source configured — and pinned as a literal as well, because a
    // constant-only compare passes just as happily at busy_timeout = 0, which is
    // exactly the regression this defends (racing writers erroring with
    // SQLITE_BUSY instead of waiting for the write lock).
    expect(pragma('busy_timeout')).toBe(BUSY_TIMEOUT_MS);
    expect(BUSY_TIMEOUT_MS).toBe(15000);
  });
});

/**
 * The v4 shape (a NOCASE alias index, a namespaced `enrollment_code`) cannot be
 * reached by `CREATE ... IF NOT EXISTS`, so an existing file has to be upgraded.
 */
describe('upgrading a v3 store', () => {
  /** Rewinds a freshly created store to exactly the v3 on-disk shape. */
  function downgradeToV3(store) {
    store.db.exec(
      'DROP INDEX principal_alias;' +
        'CREATE UNIQUE INDEX principal_alias ' +
        '  ON principal(namespace, display_alias) WHERE revoked_at IS NULL;' +
        'DROP TABLE enrollment_code;' +
        'CREATE TABLE enrollment_code (' +
        '  code_sha256 BLOB PRIMARY KEY,' +
        '  approval_id TEXT NOT NULL REFERENCES approval(id),' +
        '  expires_at TEXT NOT NULL,' +
        '  consumed_at TEXT);'
    );
    store.db.prepare("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'").run();
  }

  function columns(db, table) {
    return db.pragma(`table_info(${table})`).map((c) => c.name);
  }

  test('reopening a v3 file upgrades it in place', () => {
    fixture = createTmpStore();
    const kept = createPrincipal(fixture.store, { role: 'root', displayAlias: 'alice' });
    downgradeToV3(fixture.store);
    expect(columns(fixture.store.db, 'enrollment_code')).not.toContain('namespace');
    fixture.store.close();

    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
    // A v3 file walks the WHOLE chain, 3 -> 4 -> 5 -> 6, not just the first step.
    expect(
      fixture.store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
        .value
    ).toBe('6');

    // The upgraded file enforces the v4 rules, and kept its rows.
    expect(getPrincipal(fixture.store, kept.id).displayAlias).toBe('alice');
    let err;
    try {
      createPrincipal(fixture.store, { role: 'listener', displayAlias: 'ALICE' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('conflict');
    expect(columns(fixture.store.db, 'enrollment_code')).toContain('namespace');
  });

  test('a v3 file holding case-variant aliases refuses to open, naming the pair', () => {
    fixture = createTmpStore();
    downgradeToV3(fixture.store);
    // Only possible under v3's BINARY collation, which is the whole point.
    const insert = fixture.store.db.prepare(
      'INSERT INTO principal (id, namespace, role, display_alias, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('prn_aaaaaaaaaaaaaaaa', fixture.namespace, 'root', 'alice', '2026-01-01T00:00:00Z');
    insert.run('prn_bbbbbbbbbbbbbbbb', fixture.namespace, 'listener', 'ALICE', '2026-01-01T00:00:00Z');
    fixture.store.close();

    let err;
    try {
      openStore({ path: fixture.path, namespace: fixture.namespace });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('config_invalid');
    expect(err.message).toMatch(/differ only by case/);
    expect(err.detail.collisions).toEqual([`${fixture.namespace}/alice`]);

    // Refusing rolled back: the file is still a readable v3 store, so the
    // operator can rename or revoke one of the pair and try again.
    const raw = new Database(fixture.path);
    expect(raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value).toBe(
      '3'
    );
    expect(raw.prepare('SELECT count(*) AS n FROM principal').get().n).toBe(2);
    raw.close();
  });
});

describe('upgrading a v4 store', () => {
  const LEASE_INSERT =
    'INSERT INTO lease (namespace, holder_principal_id, epoch, acquired_at, expires_at) ' +
    'VALUES (?, ?, ?, ?, ?)';

  /** Rewinds `lease` to the v4 shape, whose `namespace` was nullable. */
  function downgradeLeaseToV4(store) {
    store.db.exec(
      'DROP TABLE lease;' +
        'CREATE TABLE lease (' +
        '  namespace TEXT PRIMARY KEY,' +
        '  holder_principal_id TEXT NOT NULL,' +
        '  epoch INTEGER NOT NULL,' +
        '  acquired_at TEXT NOT NULL,' +
        '  expires_at TEXT NOT NULL);'
    );
    store.db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema_version'").run();
  }

  const nsNotNull = (db) =>
    db.pragma('table_info(lease)').find((c) => c.name === 'namespace').notnull;

  test('a nullable lease namespace is rebuilt, not left to fresh files only', () => {
    fixture = createTmpStore();
    downgradeLeaseToV4(fixture.store);

    // The v4 file genuinely accepts the row the invariant forbids: SQLite does not
    // imply NOT NULL for a non-INTEGER PRIMARY KEY in a rowid table. Asserted rather
    // than assumed, because it is the premise of the whole migration.
    expect(nsNotNull(fixture.store.db)).toBe(0);
    fixture.store.db.prepare(LEASE_INSERT).run(null, 'prn_aaaaaaaaaaaaaaaa', 1, 'now', 'later');
    fixture.store.close();

    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
    expect(nsNotNull(fixture.store.db)).toBe(1);
    // Dropped with the table. `lease` has no writer in src/ — it is P1 listener
    // fencing — so an unscoped row in it is meaningless, not data to preserve.
    expect(fixture.store.db.prepare('SELECT count(*) AS n FROM lease').get().n).toBe(0);

    expect(() =>
      fixture.store.db.prepare(LEASE_INSERT).run(null, 'prn_bbbbbbbbbbbbbbbb', 1, 'now', 'later')
    ).toThrow(/NOT NULL/i);
  });
});

/**
 * The v6 shape widens `cursor.kind`'s CHECK to carry the memory-inclusive `/inbox` view's
 * own marks. A CHECK is unreachable by `CREATE TABLE IF NOT EXISTS`, so without a
 * migration the wider constraint would have applied to FRESH stores only and every
 * upgraded file would have gone on refusing `ack_with_memory` at the point of use — the
 * same fresh-file-only blind spot the v4 `lease` block above exists to close.
 */
describe('upgrading a v5 store', () => {
  const KIND_INSERT =
    'INSERT INTO cursor (namespace, owner_principal_id, kind, last_message_id, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?)';

  /** Rewinds `cursor` to the v5 shape, whose CHECK allowed only `read` and `ack`. */
  function downgradeCursorToV5(store) {
    store.db.exec(
      'DROP TABLE cursor;' +
        'CREATE TABLE cursor (' +
        '  namespace TEXT NOT NULL,' +
        '  owner_principal_id TEXT NOT NULL,' +
        "  kind TEXT NOT NULL CHECK(kind IN ('read','ack'))," +
        "  last_message_id TEXT NOT NULL DEFAULT ''," +
        '  updated_at TEXT NOT NULL,' +
        '  PRIMARY KEY(namespace, owner_principal_id, kind));'
    );
    store.db.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'").run();
  }

  const checkClause = (db) =>
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cursor'").get().sql;

  // The single highest-consequence line in the S1 fix. A v5 `ack` is a high-water mark
  // over the DEFAULT view, which excludes memory-updates, so it is not evidence about the
  // memory-inclusive view at all. Carrying it into `ack_with_memory` would hide every
  // memory-update below it forever, for every reader, on upgrade day — reintroducing on
  // day one the exact defect the whole change removes. The reset direction is therefore
  // the property under test, not an implementation detail: to the BEGINNING.
  test('a stored ack is reset to the beginning, never carried into the new view', () => {
    fixture = createTmpStore();
    const owner = 'prn_0000000000000001';
    downgradeCursorToV5(fixture.store);

    // The v5 file genuinely refuses the new kind — asserted rather than assumed, because
    // it is the premise of the migration existing at all.
    expect(() =>
      fixture.store.db
        .prepare(KIND_INSERT)
        .run(fixture.namespace, owner, 'ack_with_memory', '', 'now')
    ).toThrow(/CHECK/i);

    // An ack high enough to hide a memory-update minted before it. This exact value is
    // what a naive "preserve the reader's position" migration would copy forward.
    const hides = '01J000000000000000000000CC';
    fixture.store.db.prepare(KIND_INSERT).run(fixture.namespace, owner, 'ack', hides, 'now');
    fixture.store.close();

    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
    expect(
      fixture.store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
        .value
    ).toBe('6');

    // Rebuilt EMPTY. Not "ack preserved and ack_with_memory reset", not "both set to
    // `hides`" — no row at all, in either view, for anyone.
    expect(fixture.store.db.prepare('SELECT count(*) AS n FROM cursor').get().n).toBe(0);
    expect(
      fixture.store.db.prepare('SELECT count(*) AS n FROM cursor WHERE last_message_id = ?').get(hides)
        .n
    ).toBe(0);
  });

  test('the widened kind CHECK reaches an upgraded file, not just a fresh one', () => {
    fixture = createTmpStore();
    downgradeCursorToV5(fixture.store);
    expect(checkClause(fixture.store.db)).not.toContain('ack_with_memory');
    fixture.store.close();

    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
    const insert = fixture.store.db.prepare(KIND_INSERT);
    for (const kind of ['read', 'ack', 'read_with_memory', 'ack_with_memory']) {
      expect(() =>
        insert.run(fixture.namespace, 'prn_0000000000000002', kind, '', 'now')
      ).not.toThrow();
    }
    // And still exactly those four: the CHECK was widened, not removed.
    expect(() =>
      insert.run(fixture.namespace, 'prn_0000000000000002', 'ack_with_everything', '', 'now')
    ).toThrow(/CHECK/i);
  });

  test('a file from an unknown FUTURE version is refused, with the handle closed', () => {
    fixture = createTmpStore();
    fixture.store.db.prepare("UPDATE schema_meta SET value = '7' WHERE key = 'schema_version'").run();
    fixture.store.close();

    let err;
    try {
      openStore({ path: fixture.path, namespace: fixture.namespace });
    } catch (e) {
      err = e;
    }
    // No migration step leads out of '7', so `migrate` leaves it alone and reconcileMeta
    // refuses with the pair. Downgrading a store is not something this can guess at.
    expect(err?.code).toBe('config_invalid');
    expect(err.detail).toEqual({ found: '7', expected: '6' });

    // The refused open left no handle behind. Observable rather than asserted about
    // internals: an EXCLUSIVE locker can only take the file when nothing else holds it,
    // and a leaked handle — even a completely idle reader — makes this SQLITE_BUSY.
    const raw = new Database(fixture.path);
    raw.pragma('busy_timeout = 200');
    raw.pragma('locking_mode = exclusive');
    expect(() => raw.exec('BEGIN IMMEDIATE; COMMIT;')).not.toThrow();
    // And the refusal changed nothing: still a readable v7 file the operator can act on.
    expect(raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value).toBe(
      '7'
    );
    raw.close();

    // Reopen at the right version so the fixture teardown has a live handle.
    const reopen = new Database(fixture.path);
    reopen.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'").run();
    reopen.close();
    fixture.store = openStore({ path: fixture.path, namespace: fixture.namespace });
  });
});

describe('store.tx', () => {
  test('rolls back every write when the body throws', () => {
    fixture = createTmpStore();
    expect(() =>
      fixture.store.tx(() => {
        createPrincipal(fixture.store, { role: 'root', displayAlias: 'doomed' });
        throw new Error('boom');
      })
    ).toThrowError('boom');

    expect(listPrincipals(fixture.store)).toEqual([]);
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  test('commits and returns the body value', () => {
    fixture = createTmpStore();
    const id = fixture.store.tx(
      (tx) => createPrincipal(tx, { role: 'operator', displayAlias: 'operator' }).id
    );
    expect(getPrincipal(fixture.store, id)).toBeTruthy();
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  test('a nested tx joins the outer transaction rather than deadlocking', () => {
    fixture = createTmpStore();
    const seen = fixture.store.tx(() => fixture.store.tx((tx) => tx.db.inTransaction));
    expect(seen).toBe(true);
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  // The join branch used to run a nested unit inline with no boundary of its own, so
  // `store.tx` was a lie whenever an OUTER frame recovered from the inner error: the
  // inner unit's partial writes rode the outer commit out to disk. `store.tx` is sold as
  // "an entire authority decision can be one atomic unit" and `consumePermit` is required
  // to run inside its caller's transaction, so nesting is invited by the design and has to
  // be honest rather than forbidden.
  test('a nested tx that throws is undone even when the outer frame recovers', () => {
    fixture = createTmpStore();
    const kept = fixture.store.tx(() => {
      try {
        fixture.store.tx(() => {
          createPrincipal(fixture.store, { role: 'listener', displayAlias: 'inner-partial' });
          throw new Error('inner boom');
        });
      } catch {
        // The outer frame swallows it and commits its own work — the case that used to
        // carry `inner-partial` along with it.
      }
      return createPrincipal(fixture.store, { role: 'operator', displayAlias: 'outer' }).id;
    });

    expect(listPrincipals(fixture.store).map((p) => p.displayAlias)).toEqual(['outer']);
    expect(getPrincipal(fixture.store, kept)).toBeTruthy();
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  // The other direction, so nobody reads RELEASE as a commit: a nested unit that succeeded
  // is still the outer transaction's to keep or discard. That is what "runs inside the
  // caller's transaction" has to mean for `consumePermit` to be safe.
  test('a completed nested tx is still discarded when the outer transaction rolls back', () => {
    fixture = createTmpStore();
    expect(() =>
      fixture.store.tx(() => {
        fixture.store.tx(() =>
          createPrincipal(fixture.store, { role: 'listener', displayAlias: 'nested' })
        );
        throw new Error('outer boom');
      })
    ).toThrowError('outer boom');

    expect(listPrincipals(fixture.store)).toEqual([]);
    expect(fixture.store.db.inTransaction).toBe(false);
  });
});
