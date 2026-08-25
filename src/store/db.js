import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.js';
import { now } from '../core/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

export const SCHEMA_VERSION = '6';

/** Credential material lives here: owner-only, always. */
const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

/** Racing writers wait for the write lock rather than erroring with SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 15000;

let cachedSchema = null;

function schemaSql() {
  if (cachedSchema === null) cachedSchema = readFileSync(SCHEMA_PATH, 'utf8');
  return cachedSchema;
}

function chmodQuiet(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // Sidecar may not exist yet, or the filesystem may not support modes.
  }
}

/**
 * Closes an open transaction after a failure, whatever it takes.
 *
 * The plain `ROLLBACK` is the normal path: after a throw from the transaction
 * body, or after a `COMMIT` that failed with SQLITE_BUSY (which leaves the
 * transaction active), it unwinds cleanly. The close is the last resort: an
 * unclosable transaction on a live connection is worse than a closed
 * connection, because `tx()` would keep joining it and reporting success, so
 * the handle is taken out of service rather than left silently lying.
 *
 * @param {import('better-sqlite3').Database} db
 */
function unwind(db) {
  if (!db.inTransaction) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    // Already unwound by SQLite, or unwindable only by closing the handle.
  }
  if (!db.inTransaction) return;
  try {
    db.close();
  } catch {
    // Nothing further is available; the caller's error is about to propagate.
  }
}

/**
 * Unwinds a nested unit's savepoint after a failure, leaving the OUTER transaction
 * open and owned by whoever opened it.
 *
 * `ROLLBACK TO` discards the nested work but keeps the savepoint on the stack, so the
 * `RELEASE` is what actually pops it. If the savepoint is already gone — SQLite unwinds
 * the whole stack on some errors, and an outer frame may have rolled back underneath us
 * — the nested work is already discarded, which is the outcome we wanted anyway.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 */
function unwindSavepoint(db, name) {
  if (!db.inTransaction) return; // the whole transaction is gone; nothing survived
  try {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name};`);
  } catch {
    // Already unwound by SQLite. The caller's error is about to propagate.
  }
}

/**
 * A nested unit, as a savepoint.
 *
 * The join branch used to run `fn` inline with no boundary of its own, which made a
 * nested `store.tx` a lie: if its body threw and an OUTER frame caught that error and
 * went on to commit, the inner unit's partial writes committed with it. `store.tx` is
 * sold as "an entire authority decision is one atomic unit" and `consumePermit` is
 * REQUIRED to run inside its caller's transaction, so composing units is invited by the
 * design — refusing to nest would forbid the composition instead of making it honest.
 * A savepoint makes it honest: the nested unit either lands whole or not at all,
 * independent of what the outer frame decides to do with the error.
 *
 * The commit/rollback of the OUTER transaction still belongs to the outer frame. A
 * released savepoint is not durable on its own — if the outer frame rolls back, this
 * work goes with it, which is what "inside the caller's transaction" means.
 *
 * @template T
 * @param {import('better-sqlite3').Database} db
 * @param {string} namespace
 * @param {(tx:{db:any, namespace:string}) => T} fn
 * @returns {T}
 */
function runSavepoint(db, namespace, fn) {
  // Unique per nesting level on this connection: SAVEPOINT names are identifiers, and
  // a reused name would make `ROLLBACK TO` target the innermost one with that name.
  const name = `collabcast_tx_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name};`);
  let out;
  try {
    out = fn({ db, namespace });
    db.exec(`RELEASE ${name};`);
  } catch (err) {
    unwindSavepoint(db, name);
    throw err;
  }
  return out;
}

/** Monotonic savepoint counter. Module-scoped: names only ever have to be unique. */
let savepointSeq = 0;

/**
 * The transaction discipline, as one unit.
 *
 * Exported so the invariant it enforces — that a transaction is never left open
 * on this connection, whatever `fn` or SQLite does — can be exercised directly
 * against a handle whose `COMMIT` misbehaves. `store.tx` is this function bound
 * to the store's handle and namespace.
 *
 * `COMMIT` is inside the `try` on purpose. SQLite leaves the transaction ACTIVE
 * when a commit fails with SQLITE_BUSY, and the outcome is driver-dependent on
 * SQLITE_FULL/IOERR — so a commit that threw from outside the guard would leave
 * `db.inTransaction` true, and every later call would take the join branch below
 * and run with nobody owning the commit. One transient commit failure would
 * silently turn every subsequent capability issuance, approval, permit burn,
 * cursor move and audit row into a success the caller is told about and the file
 * never receives.
 *
 * A failed commit does NOT poison the handle: the transaction is unwound, the
 * error propagates, and the connection is left exactly as any other rolled-back
 * attempt leaves it — usable, with the lost work lost. Poisoning would turn one
 * transient SQLITE_BUSY into a dead daemon.
 *
 * @template T
 * @param {import('better-sqlite3').Database} db
 * @param {string} namespace
 * @param {(tx:{db:any, namespace:string}) => T} fn
 * @returns {T}
 */
export function runTx(db, namespace, fn) {
  // A transaction already open on this connection belongs to an outer caller, which
  // owns the commit/rollback decision. Join it — but inside a savepoint, so this unit
  // is still all-or-nothing even when the outer frame recovers from its error.
  if (db.inTransaction) return runSavepoint(db, namespace, fn);
  db.exec('BEGIN IMMEDIATE');
  let out;
  try {
    out = fn({ db, namespace });
    db.exec('COMMIT');
  } catch (err) {
    unwind(db);
    throw err;
  }
  // A COMMIT that returns without throwing has closed the transaction. If it
  // somehow has not, returning would hand the next caller the join branch above,
  // so refuse loudly rather than leak an unowned transaction.
  if (db.inTransaction) {
    unwind(db);
    fail('internal', 'transaction was left open after COMMIT');
  }
  return out;
}

/**
 * Opens (creating if absent) the namespaced authority store.
 *
 * @param {{path:string, namespace:string}} opts
 * @returns {{db:import('better-sqlite3').Database, path:string, namespace:string,
 *            close:() => void, tx:<T>(fn:(tx:{db:any,namespace:string}) => T) => T}}
 */
export function openStore({ path, namespace } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    fail('config_invalid', 'store path is required');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    fail('namespace_unresolved', 'store namespace is required');
  }

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
  chmodQuiet(dir, DB_DIR_MODE);

  // Create the file ourselves so it never briefly exists at umask-derived
  // permissions; SQLite copies the main file's mode onto -wal and -shm.
  if (!existsSync(path)) closeSync(openSync(path, 'a', DB_FILE_MODE));
  chmodQuiet(path, DB_FILE_MODE);

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  chmodQuiet(path, DB_FILE_MODE);
  chmodQuiet(`${path}-wal`, DB_FILE_MODE);
  chmodQuiet(`${path}-shm`, DB_FILE_MODE);

  const store = {
    db,
    path,
    namespace,
    close() {
      if (db.open) db.close();
    },
    /**
     * Runs `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back on throw. If a
     * transaction is already open on this connection, `fn` joins it. See
     * `runTx` for why the commit is inside the guard.
     */
    tx(fn) {
      return runTx(db, namespace, fn);
    }
  };

  try {
    // An upgrade runs BEFORE the schema is applied: `CREATE ... IF NOT EXISTS`
    // will neither re-collate an index nor widen a table that is already on
    // disk, so an upgrade drops exactly the objects whose shape changed and
    // lets the schema below rebuild them at the current version.
    migrate(store);
  } catch (err) {
    store.close();
    throw err;
  }

  try {
    db.exec(schemaSql());
  } catch (err) {
    store.close();
    fail('config_invalid', 'store schema could not be applied', { reason: err.message });
  }

  try {
    reconcileMeta(store);
  } catch (err) {
    store.close();
    throw err;
  }

  return store;
}

/**
 * v3 -> v4.
 *
 * - `principal_alias` is rebuilt with a NOCASE collation so `alice` and
 *   `Alice` can no longer both be live. A file that already holds such a pair
 *   cannot be upgraded quietly — one of the two would have to lose its alias —
 *   so the open fails, naming the collisions.
 * - `enrollment_code` gains a `namespace`. Enrolment codes are single-use,
 *   short-TTL secrets, so the table is rebuilt empty rather than back-filled
 *   with a guessed namespace: pending codes must be re-approved.
 *
 * Both are expressed as drops. `schemaSql()` runs immediately afterwards and
 * rebuilds them, which keeps schema.sql the only place either shape is written.
 */
function migrate3to4(store) {
  const collisions = store.db
    .prepare(
      'SELECT namespace, lower(display_alias) AS fold, count(*) AS n FROM principal ' +
        'WHERE revoked_at IS NULL AND display_alias IS NOT NULL ' +
        'GROUP BY namespace, fold HAVING n > 1'
    )
    .all();
  if (collisions.length > 0) {
    fail(
      'config_invalid',
      'store cannot be upgraded: these aliases differ only by case and are no longer ' +
        'allowed to coexist — rename or revoke one principal of each pair, then reopen',
      { from: '3', to: '4', collisions: collisions.map((c) => `${c.namespace}/${c.fold}`) }
    );
  }
  store.db.exec('DROP INDEX IF EXISTS principal_alias; DROP TABLE IF EXISTS enrollment_code;');
}

/**
 * v4 -> v5.
 *
 * `cursor.seq` (an INTEGER ordinal) becomes `cursor.last_message_id` (a message id). The
 * table is rebuilt EMPTY rather than translated, and that is deliberate: a stored ordinal
 * was the position of a message among those that parsed at the moment it was written, so
 * it has no meaningful id to map to — the very reason it is being removed is that the
 * mapping drifted underneath it.
 *
 * Resetting to the BEGINNING, not the end. A reader re-seeing a message it already
 * processed is at-least-once delivery, which this design already accepts and every
 * consumer already dedupes by message id. A reader silently skipping a message is the
 * permanent, unreported loss this whole change exists to eliminate. Anyone tempted to
 * "optimise" this into preserving each reader's position: that is the bug, reintroduced
 * on upgrade day, for every reader at once.
 *
 * `lease` is rebuilt in the same step for an unrelated reason: its `namespace TEXT
 * PRIMARY KEY` was nullable, because SQLite does not imply NOT NULL for a non-INTEGER
 * primary key in a rowid table. `CREATE TABLE IF NOT EXISTS` cannot reshape an existing
 * file, so the declaration alone would have fixed only fresh stores and quietly left
 * every upgraded one nullable. It has no writer anywhere in `src/` yet — it is P1
 * listener fencing — so dropping it loses nothing at all.
 *
 * Both are expressed as drops; `schemaSql()` runs immediately afterwards and rebuilds
 * them, which keeps schema.sql the only place either shape is written.
 */
function migrate4to5(store) {
  store.db.exec('DROP TABLE IF EXISTS cursor;');
  store.db.exec('DROP TABLE IF EXISTS lease;');
}

/**
 * v5 -> v6.
 *
 * `cursor.kind` gains the memory-inclusive view's two kinds. That is a CHECK constraint
 * change, and `CREATE TABLE IF NOT EXISTS` cannot reshape an existing file — the wider
 * declaration alone would have applied to fresh stores only and left every upgraded one
 * silently refusing `read_with_memory`/`ack_with_memory` inserts at the point of use.
 *
 * Rebuilt EMPTY rather than copied forward, and again the direction of the reset is the
 * point: to the BEGINNING. A v5 file's single `ack` mark was a high-water mark over the
 * DEFAULT view, so it says nothing sound about the inclusive view — carrying it into
 * `ack_with_memory` would import exactly the defect being removed, hiding every
 * memory-update below it forever, for every reader, on upgrade day. Resetting means a
 * reader re-sees messages it already processed, which is at-least-once delivery that
 * every consumer already dedupes by message id. Anyone tempted to "preserve each
 * reader's position": that is the bug, reintroduced.
 *
 * Expressed as a drop; `schemaSql()` runs immediately afterwards and rebuilds it, which
 * keeps schema.sql the only place the shape is written.
 */
function migrate5to6(store) {
  store.db.exec('DROP TABLE IF EXISTS cursor;');
}

/**
 * Upgrade steps, keyed by the version they upgrade FROM. A Map, not an object
 * literal: the key comes off disk, and `MIGRATIONS['constructor']` must be a
 * miss rather than a prototype member.
 */
const MIGRATIONS = new Map([
  ['3', { to: '4', apply: migrate3to4 }],
  ['4', { to: '5', apply: migrate4to5 }],
  ['5', { to: '6', apply: migrate5to6 }]
]);

/**
 * Brings a pre-existing store file up to SCHEMA_VERSION in place, before the
 * schema is applied.
 *
 * A file at a version with no upgrade step is left untouched: `reconcileMeta`
 * then refuses the open with the found/expected pair.
 */
function migrate(store) {
  const hasMeta = store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!hasMeta) return; // fresh file: schema.sql lands at the current version

  const row = store.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
  if (!row) return;

  let version = row.value;
  const applied = new Set();
  while (version !== SCHEMA_VERSION && MIGRATIONS.has(version) && !applied.has(version)) {
    applied.add(version);
    const step = MIGRATIONS.get(version);
    store.tx(() => {
      step.apply(store);
      store.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(step.to);
    });
    version = step.to;
  }
}

function reconcileMeta(store) {
  const { db, namespace } = store;
  const read = db.prepare('SELECT value FROM schema_meta WHERE key = ?');
  const write = db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  store.tx(() => {
    const version = read.get('schema_version');
    if (!version) {
      write.run('schema_version', SCHEMA_VERSION);
    } else if (version.value !== SCHEMA_VERSION) {
      fail('config_invalid', 'store schema version mismatch', {
        found: version.value,
        expected: SCHEMA_VERSION
      });
    }

    const ns = read.get('namespace');
    if (!ns) {
      write.run('namespace', namespace);
    } else if (ns.value !== namespace) {
      fail('config_invalid', 'store belongs to a different namespace', {
        found: ns.value,
        expected: namespace
      });
    }

    if (!read.get('created_at')) write.run('created_at', now());
  });
}

/**
 * Normalises a store or transaction context to `{ db, namespace }`.
 * @param {{db:any, namespace:string}} ctx
 */
export function context(ctx) {
  if (!ctx || !ctx.db || typeof ctx.namespace !== 'string') {
    fail('internal', 'a store or transaction context is required');
  }
  return { db: ctx.db, namespace: ctx.namespace };
}

/**
 * Runs `fn` inside a write transaction when handed a full store; when handed a
 * transaction context (the caller already holds the write lock) it runs inline.
 * @template T
 * @param {{db:any, namespace:string, tx?:Function}} storeOrTx
 * @param {(ctx:{db:any,namespace:string}) => T} fn
 * @returns {T}
 */
export function inTx(storeOrTx, fn) {
  const ctx = context(storeOrTx);
  if (typeof storeOrTx.tx === 'function') return storeOrTx.tx(fn);
  return fn(ctx);
}

/**
 * Asserts an explicitly supplied namespace matches the context's.
 * @param {{namespace:string}} ctx
 * @param {string} [namespace]
 */
export function assertNamespace(ctx, namespace) {
  if (namespace !== undefined && namespace !== ctx.namespace) {
    fail('wrong_namespace', 'namespace does not match this store');
  }
  return ctx.namespace;
}
