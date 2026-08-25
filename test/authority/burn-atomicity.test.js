// The two burns behind enrollment, and the invariants nothing else enforces.
//
// `exchangeEnrollmentCode` spends a code and then an approval, and it happens to do
// both inside `store.tx`. That is why there is no live defect today — but "happens
// to" is not an invariant. Two things are asserted here, both about the burn
// primitives themselves rather than about the one caller that currently gets it
// right:
//
//   1. Neither burn may run outside a write transaction. `consumePermit` has always
//      asserted this (src/store/permits.js:133-135); these two did not, so a future
//      caller could spend a code, fail to mint the capability, and leave the code
//      spent with nothing to show for it.
//   2. The code burn carries its own namespace predicate. Scoping used to arrive
//      only afterwards, via `getApproval`, which meant the UPDATE that spends the
//      code matched on the digest alone — a caller composed over another
//      namespace's store spent a foreign code and relied on an enclosing rollback
//      to put it back. The rollback is why that was survivable; the predicate is
//      why it is now refused.
//
// The namespace assertions below read the row *inside* the transaction, before it
// unwinds. Reading after the rollback would pass with or without the predicate,
// which is precisely the gap being closed.

import { describe, test, expect, afterEach } from 'vitest';
import {
  consumeApproval,
  consumeEnrollmentCode,
  createEnrollmentCode,
  recordApproval
} from '../../src/store/approvals.js';
import { createPrincipal } from '../../src/store/principals.js';
import { sha256 } from '../../src/store/digest.js';
import { createFixture } from './helpers.js';

/** A namespace this store does not belong to. */
const FOREIGN = 'someone-elses-project';

let fixture;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function setup() {
  fixture = createFixture();
  const operator = createPrincipal(fixture.store, { role: 'operator', displayAlias: 'operator' });
  const approval = recordApproval(fixture.store, {
    kind: 'enrollment',
    subjectDigest: sha256('enroll:listener'),
    approvingPrincipal: operator.id,
    attestationKind: 'omp_hook_confirm',
    requestedScopes: ['channel:read'],
    requestedTtlS: 900
  });
  return { approval };
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

/** `consumed_at` for a code, read on the handle the caller gives us. */
function consumedAt(db, code) {
  return db
    .prepare('SELECT consumed_at FROM enrollment_code WHERE code_sha256 = ?')
    .get(sha256(code)).consumed_at;
}

describe('the enrollment burns require a transaction', () => {
  test('consumeEnrollmentCode refuses to run outside one', () => {
    const { approval } = setup();
    const { code } = createEnrollmentCode(fixture.store, {
      approvalId: approval.id,
      ttlSeconds: 300
    });

    // A bare store is not a transaction context: `store.tx` is what opens one.
    expect(codeOf(() => consumeEnrollmentCode(fixture.store, code))).toBe('internal');
    // And the refusal came before the row was touched.
    expect(consumedAt(fixture.store.db, code)).toBe(null);

    // The same call inside a transaction is the supported path and still works.
    expect(fixture.store.tx((tx) => consumeEnrollmentCode(tx, code)).id).toBe(approval.id);
  });

  test('consumeEnrollmentCode checks the transaction before the code itself', () => {
    setup();
    // An unknown code outside a transaction is a caller bug, not a failed
    // redemption: the ordering matters, or the real fault is reported as
    // 'forbidden' and a broken caller looks like a rejected credential forever.
    expect(codeOf(() => consumeEnrollmentCode(fixture.store, 'made-up-code'))).toBe('internal');
    expect(codeOf(() => consumeEnrollmentCode(fixture.store, ''))).toBe('internal');
  });

  test('consumeApproval refuses to run outside one', () => {
    const { approval } = setup();

    expect(codeOf(() => consumeApproval(fixture.store, approval.id, 'cap_1111111111111111'))).toBe(
      'internal'
    );
    expect(
      fixture.store.db.prepare('SELECT consumed_at FROM approval WHERE id = ?').get(approval.id)
        .consumed_at
    ).toBe(null);

    const consumed = fixture.store.tx((tx) =>
      consumeApproval(tx, approval.id, 'cap_1111111111111111')
    );
    expect(consumed.consumedBy).toBe('cap_1111111111111111');
  });

  test('consumeApproval checks the transaction before its arguments', () => {
    const { approval } = setup();
    expect(codeOf(() => consumeApproval(fixture.store, approval.id, ''))).toBe('internal');
  });
});

describe('the enrollment code burn is namespace-scoped', () => {
  test('a code minted for one namespace is not spent by a burn in another', () => {
    const { approval } = setup();
    const { code } = createEnrollmentCode(fixture.store, {
      approvalId: approval.id,
      ttlSeconds: 300
    });

    // A caller composed over this store while believing it serves FOREIGN — the
    // swapped socket-to-store mapping the wrong_namespace fence exists for.
    const observed = fixture.store.tx((tx) => {
      const failure = codeOf(() => consumeEnrollmentCode({ db: tx.db, namespace: FOREIGN }, code));
      // Read before the rollback. After it, an unscoped burn is indistinguishable
      // from a refused one, and this test would pass against the old code.
      return { failure, consumedAt: consumedAt(tx.db, code) };
    });

    expect(observed.failure).toBe('forbidden');
    expect(observed.consumedAt).toBe(null);

    // Untouched, so still spendable where it was minted.
    expect(fixture.store.tx((tx) => consumeEnrollmentCode(tx, code)).id).toBe(approval.id);
  });

  test('two namespaces sharing one file burn only their own codes', () => {
    const { approval } = setup();
    const { code: home } = createEnrollmentCode(fixture.store, {
      approvalId: approval.id,
      ttlSeconds: 300
    });

    // The same handle, driven as if it served FOREIGN. Both codes now live in one
    // `enrollment_code` table, distinguishable only by the column the mint stamps.
    const foreignCtx = { db: fixture.store.db, namespace: FOREIGN };
    const foreignApproval = recordApproval(foreignCtx, {
      kind: 'enrollment',
      subjectDigest: sha256('enroll:intruder'),
      approvingPrincipal: 'prn_ffffffffffffffff',
      attestationKind: 'omp_hook_confirm',
      requestedScopes: ['channel:read'],
      requestedTtlS: 900
    });
    const { code: away } = createEnrollmentCode(foreignCtx, {
      approvalId: foreignApproval.id,
      ttlSeconds: 300
    });

    // FOREIGN reaches for the home code first. The refusal has to survive the
    // rollback check: read inside the transaction, before it unwinds.
    const observed = fixture.store.tx((tx) => {
      const failure = codeOf(() => consumeEnrollmentCode({ db: tx.db, namespace: FOREIGN }, home));
      return { failure, home: consumedAt(tx.db, home), away: consumedAt(tx.db, away) };
    });
    expect(observed.failure).toBe('forbidden');
    expect(observed.home).toBe(null);
    expect(observed.away).toBe(null);

    // And that refusal was about the namespace, not about FOREIGN being unable to
    // burn anything: its own code, one row over, still redeems to its own approval.
    expect(
      fixture.store.tx((tx) => consumeEnrollmentCode({ db: tx.db, namespace: FOREIGN }, away)).id
    ).toBe(foreignApproval.id);
    expect(consumedAt(fixture.store.db, away)).not.toBe(null);

    // The home code was never touched by any of it.
    expect(consumedAt(fixture.store.db, home)).toBe(null);
    expect(fixture.store.tx((tx) => consumeEnrollmentCode(tx, home)).id).toBe(approval.id);
  });
});
