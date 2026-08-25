/**
 * The two halves of operator-approved enrollment.
 *
 * `handleEnrollRequest` runs when the operator clicks Approve: it records the durable
 * evidence of that decision (an `approval` row carrying the digest of exactly what was
 * approved) and mints a short-lived one-use code. Nothing is granted yet.
 *
 * `exchangeEnrollmentCode` runs when the agent presents that code over HTTP: it burns
 * the code, burns the approval, resolves the principal and issues the capability. The
 * grant is read back off the approval row, never off the exchange request, so the
 * scopes and TTL the operator saw are the scopes and TTL that get issued — the client
 * has no input at all past the code itself.
 *
 * Both halves run in a single `store.tx` (`BEGIN IMMEDIATE`), so a crash or a
 * concurrent racer can never leave a consumed code with no capability, or a capability
 * with an unconsumed approval.
 */

import { CollabcastError } from '../identity/errors.js';
import { sha256 } from '../store/digest.js';
import {
  audit,
  consumeApproval,
  consumeEnrollmentCode,
  createEnrollmentCode,
  createPrincipal,
  getCapability,
  issueCapability,
  listPrincipals,
  recordApproval
} from '../store/index.js';
import { assertEnrollable, ENROLL_ROLE, requireCodeTtlSeconds, scopesForRole } from './policy.js';

/** Domain separator, so an approval digest can never be replayed as some other digest. */
export const DIGEST_DOMAIN = 'collabcast.enroll.v1';

/** The attestation every hook-approved artefact carries. */
export const ATTESTATION_KIND = 'omp_hook_confirm';

/**
 * Recorded as the approving principal. The operator is a human at a dialog, not a
 * principal row: they hold no capability and never appear on the channel.
 */
export const APPROVING_PRINCIPAL = 'operator';

/** Recorded as the approval's consumer when the code is exchanged. */
export const APPROVAL_CONSUMER = 'authority.enroll';

/**
 * Every way a presented code can fail collapses to this one message: replayed,
 * expired, never existed, or attached to an already-consumed approval. A caller who
 * could tell them apart could probe which codes exist and how long they last.
 */
export const INVALID_CODE_MESSAGE = 'enrollment code is invalid, expired, or already used';

/**
 * Audit action for a refused exchange. Success is recorded as `capability.issued`
 * inside the redemption transaction; this action exists so the refusals — the
 * replays, the expiries, the forged codes — leave evidence too.
 */
export const EXCHANGE_ACTION = 'enroll.exchange';

/** Store codes that mean "that code is not usable", as opposed to a real fault. */
const CODE_FAILURE_CODES = new Set(['forbidden', 'conflict', 'not_found', 'permit_invalid']);

/**
 * Canonical serialisation of an approved request. Fixed key order, sorted scopes,
 * explicit TTL — so the digest is a function of the grant and nothing else.
 *
 * @param {{namespace:string, role:string, scopes:string[], ttlSeconds:number}} grant
 * @returns {string}
 */
export function canonicaliseGrant({ namespace, role, scopes, ttlSeconds }) {
  return JSON.stringify({
    domain: DIGEST_DOMAIN,
    namespace,
    role,
    scopes: [...scopes].sort(),
    ttlSeconds
  });
}

/**
 * @param {{namespace:string, role:string, scopes:string[], ttlSeconds:number}} grant
 * @returns {Buffer} sha256 of the canonical grant
 */
export function grantDigest(grant) {
  return sha256(canonicaliseGrant(grant));
}

/**
 * Re-throws a store failure as the single opaque code-invalid error, while letting a
 * genuine fault (a closed database, a constraint we did not anticipate) through
 * unchanged — swallowing those would turn a bug into a mysterious auth denial.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function asCodeFailure(fn) {
  try {
    return fn();
  } catch (err) {
    if (err && CODE_FAILURE_CODES.has(err.code)) {
      throw new CollabcastError('permit_invalid', INVALID_CODE_MESSAGE);
    }
    throw err;
  }
}

/**
 * Records the operator's approval and mints the code that redeems it.
 *
 * @param {object} store the authority store (not a transaction context: this owns its tx)
 * @param {{namespace?:unknown, role?:unknown, scopes?:unknown, ttlSeconds?:unknown}} request
 * @param {{config:{namespace:string}, codeTtlSeconds?:number}} options
 * @returns {{code:string, expiresAt:string, approvalId:string,
 *            role:string, scopes:string[], ttlSeconds:number}}
 */
export function handleEnrollRequest(store, request = {}, { config, codeTtlSeconds } = {}) {
  const grant = assertEnrollable({
    namespace: request.namespace,
    role: request.role,
    scopes: request.scopes,
    ttlSeconds: request.ttlSeconds,
    config
  });
  const codeTtl = requireCodeTtlSeconds(codeTtlSeconds);

  return store.tx((tx) => {
    const approval = recordApproval(tx, {
      namespace: grant.namespace,
      kind: 'enrollment',
      subjectDigest: grantDigest(grant),
      requestedScopes: grant.scopes,
      requestedTtlS: grant.ttlSeconds,
      approvingPrincipal: APPROVING_PRINCIPAL,
      attestationKind: ATTESTATION_KIND
    });

    const { code, expiresAt } = createEnrollmentCode(tx, {
      approvalId: approval.id,
      ttlSeconds: codeTtl
    });

    audit(tx, {
      action: 'enroll.code_issued',
      outcome: 'issued',
      subject: approval.id,
      detail: {
        role: grant.role,
        scopes: grant.scopes,
        ttlSeconds: grant.ttlSeconds,
        // `codeTtlSeconds` survives redaction: `redactDetail` matches `code` only as a
        // key's head noun, and this key's head noun is `seconds`.
        codeTtlSeconds: codeTtl,
        attestationKind: ATTESTATION_KIND
      }
    });

    return {
      code,
      expiresAt,
      approvalId: approval.id,
      role: grant.role,
      scopes: grant.scopes,
      ttlSeconds: grant.ttlSeconds
    };
  });
}

/**
 * Resolves the namespace root principal, creating it the first time.
 *
 * Reuse is the point: a second approved enrollment is a *recovery* enrollment. It
 * issues a fresh capability to the same principal so the channel's authorship history
 * stays attributable to one identity rather than fragmenting into root-1, root-2.
 *
 * @param {{db:object, namespace:string}} tx
 * @returns {object} the principal
 */
function resolveEnrollmentPrincipal(tx) {
  const [existing] = listPrincipals(tx, { role: ENROLL_ROLE });
  if (existing) return existing;
  // No display alias: an alias is presentation metadata claimed later through
  // `POST /self/alias`, and claiming one here could collide with a live incumbent.
  return createPrincipal(tx, { role: ENROLL_ROLE, displayAlias: null });
}

/**
 * Records a refused exchange.
 *
 * This is the only unauthenticated route's authority decision, and until now it
 * was the only one that recorded nothing when it said no — an operator chasing a
 * leaked enrollment code could not tell from the store whether anyone had tried
 * to redeem it.
 *
 * Written in its own statement, deliberately NOT inside the redemption
 * transaction: that transaction has already rolled back by the time we get here
 * (`store.tx` unwinds before it rethrows), so a row written inside it would be
 * discarded along with the refusal it was meant to evidence. Nothing changed, so
 * there is nothing for the row to be atomic with.
 *
 * The presented code never appears in `detail` — only the code-shaped reason the
 * refusal collapsed to. A failed audit write is swallowed for the same reason
 * `auditReject` in `src/daemon/auth.js` swallows one: the caller is
 * unauthenticated, the refusal already stands, and turning a broken audit table
 * into a different status would tell a prober about the health of the store.
 *
 * @param {object} store
 * @param {unknown} err
 */
function auditExchangeDenied(store, err) {
  try {
    audit(store, {
      action: EXCHANGE_ACTION,
      outcome: 'denied',
      detail: { reason: (err && err.code) || 'internal' }
    });
  } catch {
    // See above: the refusal itself is the security-relevant outcome.
  }
}

/**
 * Redeems an enrollment code for a capability. One transaction, one use.
 *
 * Every refusal leaves an `enroll.exchange` / `denied` row behind; success is
 * recorded as `capability.issued` inside the transaction that issues it.
 *
 * @param {object} store
 * @param {unknown} code
 * @returns {{token:string, capabilityId:string, principalId:string, role:string,
 *            scopes:string[], expiresAt:string, approvalId:string}}
 */
export function exchangeEnrollmentCode(store, code) {
  try {
    return redeem(store, code);
  } catch (err) {
    auditExchangeDenied(store, err);
    throw err;
  }
}

/**
 * @param {object} store
 * @param {unknown} code
 */
function redeem(store, code) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new CollabcastError('permit_invalid', INVALID_CODE_MESSAGE);
  }

  return store.tx((tx) => {
    const approval = asCodeFailure(() => consumeEnrollmentCode(tx, code));
    if (approval.kind !== 'enrollment' || approval.attestationKind !== ATTESTATION_KIND) {
      throw new CollabcastError('permit_invalid', INVALID_CODE_MESSAGE);
    }
    asCodeFailure(() => consumeApproval(tx, approval.id, APPROVAL_CONSUMER));

    const scopes = Array.isArray(approval.requestedScopes) ? approval.requestedScopes : null;
    const ttlSeconds = approval.requestedTtlS;
    if (!scopes || scopes.length === 0 || !Number.isInteger(ttlSeconds)) {
      // An enrollment approval without a recorded grant cannot be honoured: there is
      // nothing to prove the operator saw these scopes.
      throw new CollabcastError('permit_invalid', INVALID_CODE_MESSAGE);
    }
    // Re-check against policy at redemption time, so an approval recorded under an
    // older, wider allowlist cannot be redeemed after the allowlist narrows.
    const allowed = new Set(scopesForRole(ENROLL_ROLE));
    const widened = scopes.filter((scope) => !allowed.has(scope));
    if (widened.length > 0) {
      throw new CollabcastError('forbidden', 'approved scopes are no longer permitted for this role', {
        scopes: widened
      });
    }

    const principal = resolveEnrollmentPrincipal(tx);
    // `attestationRef` is the approval id: every capability points back at the exact
    // human decision that authorised it, and the approval is one-use, so no two
    // capabilities can ever share an attestation.
    const { capabilityId, token } = issueCapability(tx, {
      principalId: principal.id,
      scopes,
      ttlSeconds,
      attestationKind: ATTESTATION_KIND,
      attestationRef: approval.id
    });
    const capability = getCapability(tx, capabilityId);

    audit(tx, {
      action: 'capability.issued',
      outcome: 'issued',
      actorPrincipalId: principal.id,
      subject: capabilityId,
      detail: {
        role: principal.role,
        scopes,
        ttlSeconds,
        approvalId: approval.id,
        attestationKind: ATTESTATION_KIND
      }
    });

    return {
      token,
      capabilityId,
      principalId: principal.id,
      role: principal.role,
      scopes: [...capability.scopes],
      expiresAt: capability.expiresAt,
      approvalId: approval.id
    };
  });
}

