import { describe, test, expect, afterEach } from 'vitest';
import {
  APPROVAL_CONSUMER,
  APPROVING_PRINCIPAL,
  ATTESTATION_KIND,
  canonicaliseGrant,
  exchangeEnrollmentCode,
  grantDigest,
  handleEnrollRequest,
  INVALID_CODE_MESSAGE
} from '../../src/authority/enroll.js';
import { DEFAULT_CODE_TTL_SECONDS, ROLE_SCOPES } from '../../src/authority/policy.js';
import { getApproval, listApprovals } from '../../src/store/approvals.js';
import { hasScope, verifyCapability } from '../../src/store/capabilities.js';
import { listPrincipals } from '../../src/store/principals.js';
import { auditRows, countRows, createFixture, NAMESPACE } from './helpers.js';

let fixture;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const SCOPES = ['channel:read', 'channel:publish', 'self:alias'];

function request(overrides = {}) {
  return { namespace: NAMESPACE, role: 'root', scopes: SCOPES, ttlSeconds: 3600, ...overrides };
}

function issue(overrides = {}, options = {}) {
  return handleEnrollRequest(fixture.store, request(overrides), {
    config: fixture.config,
    ...options
  });
}

/** @returns {{code:string, message:string}|null} */
function failure(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, message: err.message, detail: err.detail };
  }
  return null;
}

/** Rewinds a code's expiry rather than sleeping through a real TTL. */
function expireCodes(store) {
  store.db.prepare("UPDATE enrollment_code SET expires_at = '2000-01-01T00:00:00.000Z'").run();
}

describe('grant digest', () => {
  test('is stable under key and scope ordering', () => {
    const a = canonicaliseGrant({
      namespace: 'n',
      role: 'root',
      scopes: ['b', 'a'],
      ttlSeconds: 60
    });
    const b = canonicaliseGrant({
      namespace: 'n',
      role: 'root',
      scopes: ['a', 'b'],
      ttlSeconds: 60
    });
    expect(a).toBe(b);
    expect(grantDigest({ namespace: 'n', role: 'root', scopes: ['a'], ttlSeconds: 60 })).toEqual(
      grantDigest({ namespace: 'n', role: 'root', scopes: ['a'], ttlSeconds: 60 })
    );
  });

  test('changes when any part of the grant changes', () => {
    const base = { namespace: 'n', role: 'root', scopes: ['a'], ttlSeconds: 60 };
    const digest = grantDigest(base).toString('hex');
    expect(grantDigest({ ...base, ttlSeconds: 61 }).toString('hex')).not.toBe(digest);
    expect(grantDigest({ ...base, scopes: ['a', 'b'] }).toString('hex')).not.toBe(digest);
    expect(grantDigest({ ...base, namespace: 'm' }).toString('hex')).not.toBe(digest);
  });

  test('is domain separated so it cannot be replayed as another digest kind', () => {
    expect(
      canonicaliseGrant({ namespace: 'n', role: 'root', scopes: [], ttlSeconds: 1 })
    ).toContain('walkie.enroll.v1');
  });
});

describe('handleEnrollRequest', () => {
  test('records the approval with its attestation and mints one code', () => {
    fixture = createFixture();
    const issued = issue();

    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.role).toBe('root');
    expect(issued.scopes).toEqual([...SCOPES].sort());
    expect(issued.ttlSeconds).toBe(3600);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());

    const approval = getApproval(fixture.store, issued.approvalId);
    expect(approval).toMatchObject({
      kind: 'enrollment',
      attestationKind: ATTESTATION_KIND,
      approvingPrincipal: APPROVING_PRINCIPAL,
      requestedTtlS: 3600,
      consumedAt: null
    });
    expect(approval.requestedScopes).toEqual([...SCOPES].sort());
    // The digest binds the approval to exactly this grant.
    expect(Buffer.from(approval.subjectDigest)).toEqual(
      grantDigest({ namespace: NAMESPACE, role: 'root', scopes: SCOPES, ttlSeconds: 3600 })
    );
    expect(countRows(fixture.store, 'enrollment_code')).toBe(1);
    // Nothing is granted yet: no principal, no capability.
    expect(countRows(fixture.store, 'principal')).toBe(0);
    expect(countRows(fixture.store, 'capability')).toBe(0);
  });

  test('the code window defaults to 120 seconds and honours an override', () => {
    fixture = createFixture();
    const now = Date.now();
    const dflt = issue();
    expect(Date.parse(dflt.expiresAt) - now).toBeLessThanOrEqual(
      DEFAULT_CODE_TTL_SECONDS * 1000 + 1000
    );

    const short = issue({}, { codeTtlSeconds: 10 });
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThanOrEqual(11000);
  });

  test('audits the issuance without recording the code', () => {
    fixture = createFixture();
    const issued = issue();
    const rows = auditRows(fixture.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'enroll.code_issued',
      outcome: 'issued',
      subject: issued.approvalId
    });
    expect(rows[0].detail).toEqual({
      role: 'root',
      scopes: [...SCOPES].sort(),
      ttlSeconds: 3600,
      codeTtlSeconds: DEFAULT_CODE_TTL_SECONDS,
      attestationKind: ATTESTATION_KIND
    });
    expect(JSON.stringify(rows)).not.toContain(issued.code);
  });

  test('a policy refusal writes nothing at all', () => {
    fixture = createFixture();
    for (const overrides of [
      { namespace: 'somewhere-else' },
      { role: 'goal_hub' },
      { scopes: ['permit:administer'] },
      { ttlSeconds: 0 },
      { ttlSeconds: '3600' }
    ]) {
      expect(failure(() => issue(overrides))).not.toBeNull();
    }
    expect(countRows(fixture.store, 'approval')).toBe(0);
    expect(countRows(fixture.store, 'enrollment_code')).toBe(0);
    expect(auditRows(fixture.store)).toHaveLength(0);
  });

  test('a bad code window is a configuration error, not a request error', () => {
    fixture = createFixture();
    expect(failure(() => issue({}, { codeTtlSeconds: 100000 })).code).toBe('config_invalid');
    expect(countRows(fixture.store, 'approval')).toBe(0);
  });
});

describe('exchangeEnrollmentCode', () => {
  test('issues a working capability carrying exactly the approved grant', () => {
    fixture = createFixture();
    const issued = issue();
    const result = exchangeEnrollmentCode(fixture.store, issued.code);

    expect(result.scopes).toEqual([...SCOPES].sort());
    expect(result.role).toBe('root');
    expect(result.approvalId).toBe(issued.approvalId);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());

    const verified = verifyCapability(fixture.store, result.token);
    expect(verified).not.toBeNull();
    expect(verified.capability.id).toBe(result.capabilityId);
    expect(verified.capability.scopes).toEqual([...SCOPES].sort());
    expect(verified.capability.attestationKind).toBe(ATTESTATION_KIND);
    // The capability points back at the human decision that authorised it.
    expect(verified.capability.attestationRef).toBe(issued.approvalId);
    expect(verified.principal.id).toBe(result.principalId);
    expect(verified.principal.role).toBe('root');
    expect(hasScope(verified.capability, 'channel:publish')).toBe(true);
    expect(hasScope(verified.capability, 'enroll:delegate')).toBe(false);
  });

  test('burns the approval so it can never authorise a second capability', () => {
    fixture = createFixture();
    const issued = issue();
    exchangeEnrollmentCode(fixture.store, issued.code);
    const approval = getApproval(fixture.store, issued.approvalId);
    expect(approval.consumedAt).not.toBeNull();
    expect(approval.consumedBy).toBe(APPROVAL_CONSUMER);
    expect(listApprovals(fixture.store, { consumed: false })).toHaveLength(0);
  });

  test('a replayed code fails as permit_invalid and issues nothing', () => {
    fixture = createFixture();
    const issued = issue();
    exchangeEnrollmentCode(fixture.store, issued.code);
    expect(countRows(fixture.store, 'capability')).toBe(1);

    const replay = failure(() => exchangeEnrollmentCode(fixture.store, issued.code));
    expect(replay).toEqual({
      code: 'permit_invalid',
      message: INVALID_CODE_MESSAGE,
      detail: undefined
    });
    expect(countRows(fixture.store, 'capability')).toBe(1);
    expect(countRows(fixture.store, 'principal')).toBe(1);
  });

  test('an expired code fails as permit_invalid and issues nothing', () => {
    fixture = createFixture();
    const issued = issue();
    expireCodes(fixture.store);

    expect(failure(() => exchangeEnrollmentCode(fixture.store, issued.code)).code).toBe(
      'permit_invalid'
    );
    expect(countRows(fixture.store, 'capability')).toBe(0);
    expect(countRows(fixture.store, 'principal')).toBe(0);
    // The approval survives unconsumed: nothing redeemed it.
    expect(getApproval(fixture.store, issued.approvalId).consumedAt).toBeNull();
  });

  test('an unknown, empty or non-string code is indistinguishable from a replay', () => {
    fixture = createFixture();
    issue();
    for (const code of ['not-a-real-code', '', undefined, null, 42, {}]) {
      const denied = failure(() => exchangeEnrollmentCode(fixture.store, code));
      expect(denied.code, `code=${String(code)}`).toBe('permit_invalid');
      expect(denied.message).toBe(INVALID_CODE_MESSAGE);
    }
    expect(countRows(fixture.store, 'capability')).toBe(0);
  });

  test('a code whose approval was consumed out of band is permit_invalid', () => {
    fixture = createFixture();
    const issued = issue();
    fixture.store.db
      .prepare("UPDATE approval SET consumed_at = '2020-01-01T00:00:00.000Z', consumed_by = 'x'")
      .run();
    expect(failure(() => exchangeEnrollmentCode(fixture.store, issued.code)).code).toBe(
      'permit_invalid'
    );
    expect(countRows(fixture.store, 'capability')).toBe(0);
  });

  test('re-enrollment reuses the root principal rather than fragmenting identity', () => {
    fixture = createFixture();
    const first = exchangeEnrollmentCode(fixture.store, issue().code);
    const second = exchangeEnrollmentCode(fixture.store, issue().code);

    expect(second.principalId).toBe(first.principalId);
    expect(second.capabilityId).not.toBe(first.capabilityId);
    expect(second.token).not.toBe(first.token);
    expect(listPrincipals(fixture.store, { role: 'root' })).toHaveLength(1);
    // Both capabilities are live: recovery enrollment does not strand the old client.
    expect(verifyCapability(fixture.store, first.token)).not.toBeNull();
    expect(verifyCapability(fixture.store, second.token)).not.toBeNull();
  });

  test('the root principal is created without an alias to claim', () => {
    fixture = createFixture();
    const result = exchangeEnrollmentCode(fixture.store, issue().code);
    const [principal] = listPrincipals(fixture.store, { role: 'root' });
    expect(principal.id).toBe(result.principalId);
    expect(principal.displayAlias).toBeNull();
  });

  test('audits the issuance without recording the token', () => {
    fixture = createFixture();
    const issued = issue();
    const result = exchangeEnrollmentCode(fixture.store, issued.code);
    const rows = auditRows(fixture.store);
    expect(rows.map((row) => row.action)).toEqual(['enroll.code_issued', 'capability.issued']);
    expect(rows[1]).toMatchObject({
      outcome: 'issued',
      subject: result.capabilityId,
      actorPrincipalId: result.principalId
    });
    // Strict equality on the PERSISTED detail, not toMatchObject: `redactDetail` rewrites
    // secret-bearing keys to '[redacted]', so a loose assertion would pass while a field
    // arrived hollowed out.
    expect(rows[1].detail).toEqual({
      role: 'root',
      scopes: [...SCOPES].sort(),
      ttlSeconds: 3600,
      approvalId: issued.approvalId,
      attestationKind: ATTESTATION_KIND
    });
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain(result.token);
    expect(rendered).not.toContain(issued.code);
  });

  test('scopes narrowed since the approval are refused at redemption', () => {
    fixture = createFixture();
    const issued = issue();
    // Simulate the allowlist tightening between approval and redemption: an approval
    // recorded under a wider policy must not be redeemable afterwards.
    fixture.store.db
      .prepare('UPDATE approval SET requested_scopes = ? WHERE id = ?')
      .run(JSON.stringify(['channel:read', 'permit:administer']), issued.approvalId);

    const denied = failure(() => exchangeEnrollmentCode(fixture.store, issued.code));
    expect(denied.code).toBe('forbidden');
    expect(denied.detail).toEqual({ scopes: ['permit:administer'] });
    expect(countRows(fixture.store, 'capability')).toBe(0);
  });

  test('an approval with no recorded grant cannot be redeemed', () => {
    fixture = createFixture();
    const issued = issue();
    fixture.store.db
      .prepare('UPDATE approval SET requested_scopes = NULL WHERE id = ?')
      .run(issued.approvalId);
    expect(failure(() => exchangeEnrollmentCode(fixture.store, issued.code)).code).toBe(
      'permit_invalid'
    );
    expect(countRows(fixture.store, 'capability')).toBe(0);
  });

  test('the full root allowlist survives the round trip intact', () => {
    fixture = createFixture();
    const issued = issue({ scopes: [...ROLE_SCOPES.root] });
    const result = exchangeEnrollmentCode(fixture.store, issued.code);
    expect(result.scopes).toEqual([...ROLE_SCOPES.root].sort());
    const { capability } = verifyCapability(fixture.store, result.token);
    for (const scope of ROLE_SCOPES.root) expect(hasScope(capability, scope)).toBe(true);
  });
});
