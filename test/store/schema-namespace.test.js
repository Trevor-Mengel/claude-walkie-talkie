// The one structural invariant the whole authority store rests on: every table
// that holds authority state carries a populated `namespace`, so a single
// database file can never leak authority across projects.
//
// Nothing asserted this before. All twelve authority tables were written with
// the column in place, but a new table shipped without it, a column quietly
// declared nullable, or a write path inserting an empty namespace would have
// failed no test — every existing store test scopes its own queries by
// namespace, so cross-namespace bleed is invisible to them.
//
// The check is written against the live schema rather than a hardcoded table
// list, so a table added next month is covered on the day it lands.
import { describe, test, expect, afterEach } from 'vitest';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability } from '../../src/store/capabilities.js';
import { recordApproval, createEnrollmentCode } from '../../src/store/approvals.js';
import { grantPermit } from '../../src/store/permits.js';
import { createHold } from '../../src/store/holds.js';
import { audit } from '../../src/store/audit.js';
import { sha256 } from '../../src/store/digest.js';
import { advanceCursor } from '../../src/store/cursors.js';
import { newId } from '../../src/core/ids.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

/**
 * Tables that legitimately hold no `namespace`, with the reason. Anything not
 * listed here must carry one.
 */
const EXEMPT_BY_DESIGN = new Map([
  ['schema_meta', 'the file header: it is what NAMES the namespace, so it cannot be scoped by one'],
  ['sqlite_sequence', "SQLite's own AUTOINCREMENT bookkeeping, not ours"]
]);

/**
 * Tables that violate the invariant today. A defect list, not a design exemption: it
 * exists so the sweep can be green while still naming the hole.
 *
 * EMPTY, and the bar for adding an entry is high — an entry means a namespace-scoping
 * hole is shipping, so it must state the defect, why it is not fixed in the same change,
 * and what unblocks it. The one entry this list ever held (`lease`, whose
 * `namespace TEXT PRIMARY KEY` was nullable because SQLite does not imply NOT NULL for a
 * non-INTEGER primary key in a rowid table) named its own unblocking condition — a
 * SCHEMA_VERSION 5 with a drop/rebuild migration — and was closed as soon as v5 landed
 * for the cursor change. That is the intended lifecycle: name it, then close it.
 */
const KNOWN_GAPS = new Map();

function tablesOf(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function namespaceColumn(db, table) {
  return db.pragma(`table_info("${table}")`).find((col) => col.name === 'namespace') || null;
}

/** Tables that should carry a namespace and whose column is missing or nullable. */
function schemaOffenders(db) {
  return tablesOf(db)
    .filter((table) => !EXEMPT_BY_DESIGN.has(table))
    .filter((table) => {
      const col = namespaceColumn(db, table);
      return !col || col.notnull !== 1;
    });
}

/** `table:count` for every table holding a row with a null or empty namespace. */
function unscopedRows(db) {
  const found = [];
  for (const table of tablesOf(db)) {
    if (!namespaceColumn(db, table)) continue;
    const { c } = db
      .prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE namespace IS NULL OR namespace = ''`)
      .get();
    if (c > 0) found.push(`${table}:${c}`);
  }
  return found;
}

/** Tables carrying at least one row, so the sweep's reach is visible. */
function populatedTables(db) {
  return tablesOf(db).filter(
    (table) => db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c > 0
  );
}

/**
 * Exercises the real write path of every table reachable from `src/store`'s
 * public API. `event`, `thread`, `handoff` and `lease` have no writer in `src/`
 * at all — the sweeps above still cover them, they are simply empty here.
 */
function seedEveryReachableTable(fixture) {
  const store = fixture.store;
  const operator = createPrincipal(store, { role: 'operator', displayAlias: 'operator' });
  const hub = createPrincipal(store, { role: 'goal_hub', displayAlias: 'Main' });
  issueCapability(store, {
    principalId: hub.id,
    scopes: ['channel:read'],
    ttlSeconds: 600,
    attestationKind: 'operator_cli',
    attestationRef: 'schema-sweep'
  });
  const approval = recordApproval(store, {
    kind: 'prune',
    subjectDigest: sha256('prune-plan'),
    approvingPrincipal: operator.id,
    attestationKind: 'operator_cli'
  });
  const enrollment = recordApproval(store, {
    kind: 'enrollment',
    subjectDigest: sha256('enrol-main'),
    approvingPrincipal: operator.id,
    attestationKind: 'operator_cli'
  });
  createEnrollmentCode(store, { approvalId: enrollment.id, ttlSeconds: 300 });
  grantPermit(store, {
    principalId: hub.id,
    operation: 'retention.prune',
    resourceId: 'thread-1',
    contentDigest: sha256('prune-plan'),
    approvalId: approval.id,
    ttlSeconds: 120
  });
  createHold(store, {
    subjectKind: 'thread',
    subjectId: 'thread-1',
    reason: 'under review',
    createdBy: operator.id
  });
  audit(store, { action: 'schema.sweep', outcome: 'allowed', actorPrincipalId: operator.id });
  advanceCursor(store, { ownerPrincipalId: hub.id, kind: 'read', messageId: newId() });
}

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

describe('every authority table is namespace-scoped', () => {
  test('the set of tables missing a NOT NULL namespace is exactly the known gaps', () => {
    fixture = createTmpStore();
    expect(
      schemaOffenders(fixture.store.db),
      'a table without a NOT NULL `namespace` column: add the column, or — if it genuinely ' +
        'cannot be scoped — document it in EXEMPT_BY_DESIGN. If a KNOWN_GAP was just fixed, ' +
        'delete it from that map.'
    ).toEqual([...KNOWN_GAPS.keys()]);
  });

  test('the namespace column is TEXT everywhere it exists', () => {
    fixture = createTmpStore();
    const wrongType = tablesOf(fixture.store.db)
      .map((table) => [table, namespaceColumn(fixture.store.db, table)])
      .filter(([, col]) => col && col.type !== 'TEXT')
      .map(([table, col]) => `${table}:${col.type}`);
    expect(wrongType).toEqual([]);
  });

  test('no write path leaves a null or empty namespace behind', () => {
    fixture = createTmpStore();
    seedEveryReachableTable(fixture);

    // Stated explicitly so a table that silently stops being exercised is
    // visible rather than passing as a vacuous zero.
    expect(populatedTables(fixture.store.db)).toEqual([
      'approval',
      'audit',
      'capability',
      'cursor',
      'enrollment_code',
      'hold',
      'permit',
      'principal',
      'schema_meta',
      // SQLite's own AUTOINCREMENT bookkeeping, materialised by the seeded rows.
      'sqlite_sequence'
    ]);
    expect(unscopedRows(fixture.store.db)).toEqual([]);
  });

  test('the sweep has teeth: it reports a namespace-less table and an unscoped row', () => {
    fixture = createTmpStore();
    const db = fixture.store.db;
    // Exactly the two mistakes this file exists to catch, on a scratch schema.
    db.exec('CREATE TABLE forgotten (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    db.exec('CREATE TABLE nullable_ns (id TEXT PRIMARY KEY, namespace TEXT)');
    expect(schemaOffenders(db)).toEqual(['forgotten', ...KNOWN_GAPS.keys(), 'nullable_ns']);

    db.prepare('INSERT INTO nullable_ns (id, namespace) VALUES (?, NULL)').run('a');
    db.prepare('INSERT INTO nullable_ns (id, namespace) VALUES (?, ?)').run('b', '');
    db.prepare('INSERT INTO nullable_ns (id, namespace) VALUES (?, ?)').run('c', 'collabcast');
    expect(unscopedRows(db)).toEqual(['nullable_ns:2']);
  });
});
