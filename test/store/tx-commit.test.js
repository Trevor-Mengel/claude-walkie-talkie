// What happens to the connection when COMMIT itself fails.
//
// SQLite leaves a transaction ACTIVE when COMMIT returns SQLITE_BUSY. If the
// store's transaction runner lets that escape without unwinding, `inTransaction`
// stays true and every later `tx()` takes the "already in a transaction" join
// branch — running its body inline with nobody owning the commit. The damage is
// not the one lost transaction; it is every write after it, each reported to its
// caller as a success and discarded when the process exits.
//
// The failing COMMIT is simulated by replacing `exec` on a REAL better-sqlite3
// handle so the COMMIT statement never reaches SQLite. That is faithful to the
// SQLITE_BUSY case: the transaction is genuinely still open afterwards, which
// the first assertion below pins.

import { afterEach, describe, expect, test } from 'vitest';
import { openStore, runTx } from '../../src/store/db.js';
import { createPrincipal, getPrincipal, listPrincipals } from '../../src/store/principals.js';
import { createTmpStore, cleanupTmpStore } from './helpers.js';

let fixture;

afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = undefined;
});

/**
 * Makes the next COMMIT on `db` throw, without touching any other statement.
 * @returns {() => void} restores the real `exec`
 */
function armCommitFailure(db) {
  const realExec = db.exec.bind(db);
  let armed = true;
  db.exec = (sql) => {
    if (armed && /^\s*COMMIT/i.test(sql)) {
      armed = false;
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return realExec(sql);
  };
  return () => {
    db.exec = realExec;
  };
}

/**
 * Runs one transaction whose COMMIT fails, swallowing the resulting error.
 * @returns {Error} the propagated error
 */
function failOneCommit(store, displayAlias) {
  const restore = armCommitFailure(store.db);
  let thrown;
  try {
    store.tx((tx) => createPrincipal(tx, { role: 'root', displayAlias }));
  } catch (err) {
    thrown = err;
  }
  restore();
  return thrown;
}

describe('store.tx when COMMIT fails', () => {
  test('propagates the error and rolls the work back', () => {
    fixture = createTmpStore();
    const thrown = failOneCommit(fixture.store, 'lost');

    // The caller is told, and told the truth.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/SQLITE_BUSY/);
    expect(listPrincipals(fixture.store)).toEqual([]);
  });

  test('does not leave the transaction open', () => {
    fixture = createTmpStore();
    failOneCommit(fixture.store, 'lost');
    // Left true, the join branch of the next `tx()` runs its body with nobody
    // owning the commit.
    expect(fixture.store.db.inTransaction).toBe(false);
  });

  test('a subsequent independent transaction still commits durably', () => {
    // The assertion that catches the real damage: not the one lost transaction,
    // but every write after it. Without the unwind this write joins the
    // abandoned transaction, hands back a principal id, and never reaches disk.
    fixture = createTmpStore();
    failOneCommit(fixture.store, 'lost');

    const id = fixture.store.tx(
      (tx) => createPrincipal(tx, { role: 'operator', displayAlias: 'operator' }).id
    );

    // Read through a connection that shares no transaction state with the first.
    const second = openStore({ path: fixture.path, namespace: fixture.namespace });
    try {
      expect(getPrincipal(second, id)?.displayAlias).toBe('operator');
    } finally {
      second.close();
    }
  });

  test('a transaction body that throws still rolls back and leaves no open transaction', () => {
    fixture = createTmpStore();
    expect(() =>
      fixture.store.tx((tx) => {
        createPrincipal(tx, { role: 'root', displayAlias: 'doomed' });
        throw new Error('boom');
      })
    ).toThrowError(/boom/);
    expect(fixture.store.db.inTransaction).toBe(false);
    expect(listPrincipals(fixture.store)).toEqual([]);
    expect(fixture.store.tx(() => 'still works')).toBe('still works');
  });
});

describe('runTx exit invariant', () => {
  // better-sqlite3 defines `inTransaction` as a non-configurable own getter, so
  // a handle that reports a still-open transaction after a SUCCESSFUL commit —
  // the driver-dependent SQLITE_FULL/IOERR shape — cannot be simulated on a real
  // handle. This one test uses a stub handle for exactly that case. Everything
  // else in this file runs against real SQLite.
  function stubHandle({ inTransaction }) {
    const calls = [];
    return {
      calls,
      open: true,
      get inTransaction() {
        return inTransaction(calls);
      },
      exec(sql) {
        calls.push(sql);
      },
      close() {
        this.open = false;
      }
    };
  }

  test('refuses to return while a transaction is still open, and takes the handle out of service', () => {
    // Always in a transaction after BEGIN: COMMIT and ROLLBACK both "succeed"
    // and neither closes it.
    const db = stubHandle({ inTransaction: (calls) => calls.length > 0 });

    expect(() => runTx(db, 'walkie-talkie', () => 'body ran')).toThrowError(/left open after COMMIT/);
    expect(db.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
    // An unclosable transaction on a live connection would be joined by the next
    // caller, so the handle is closed rather than left silently lying.
    expect(db.open).toBe(false);
  });

  // Joining still means "the outer frame owns the commit": no BEGIN and no COMMIT here.
  // But the join is no longer bare — a nested unit gets a SAVEPOINT so it is all-or-nothing
  // in its own right, which is what made a nested `store.tx` honest when an OUTER frame
  // recovers from the inner error instead of rolling back.
  test('joins an already-open transaction with a savepoint, never its own BEGIN or COMMIT', () => {
    const db = stubHandle({ inTransaction: () => true });
    expect(runTx(db, 'walkie-talkie', (tx) => tx.namespace)).toBe('walkie-talkie');
    expect(db.calls).toEqual([expect.stringMatching(/^SAVEPOINT /), expect.stringMatching(/^RELEASE /)]);
    expect(db.calls.join(' ')).not.toMatch(/BEGIN|COMMIT/);
    expect(db.open).toBe(true);
  });

  // A savepoint name is an identifier, so a reused one would make `ROLLBACK TO` target the
  // wrong (innermost) frame. Distinct per nesting level, checked rather than assumed.
  test('each nested unit gets its own savepoint name', () => {
    const db = stubHandle({ inTransaction: () => true });
    runTx(db, 'walkie-talkie', () => runTx(db, 'walkie-talkie', () => null));
    const names = db.calls
      .filter((c) => c.startsWith('SAVEPOINT '))
      .map((c) => c.slice('SAVEPOINT '.length));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  // The failure path: the nested unit is undone and the OUTER transaction stays open and
  // owned by whoever opened it. Rolling the whole thing back here would silently discard
  // an outer frame's committed-so-far work on an error it intended to handle.
  test('a throwing nested unit rolls back to its savepoint and leaves the outer open', () => {
    const db = stubHandle({ inTransaction: () => true });
    expect(() =>
      runTx(db, 'walkie-talkie', () => {
        throw new Error('inner boom');
      })
    ).toThrowError('inner boom');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]).toMatch(/^SAVEPOINT (\w+);?$/);
    expect(db.calls[1]).toMatch(/^ROLLBACK TO \w+; RELEASE \w+;$/);
    expect(db.open).toBe(true);
  });
});
