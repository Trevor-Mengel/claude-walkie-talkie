import { assertNamespace, context } from './db.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { newSecret, sha256, toDigest } from './digest.js';
import { now, plusSeconds, requireTtl } from './clock.js';

export const APPROVAL_KINDS = Object.freeze(['enrollment', 'prune', 'rollback', 'scope_widen']);
const KIND_SET = new Set(APPROVAL_KINDS);

export const ATTESTATION_KINDS = Object.freeze(['omp_hook_confirm', 'operator_cli', 'delegation']);
const ATTESTATION_SET = new Set(ATTESTATION_KINDS);

const COLUMNS =
  'id, namespace, kind, subject_digest, requested_scopes, requested_ttl_s, approved_at, ' +
  'approving_principal, attestation_kind, consumed_at, consumed_by';

/** @param {object} row */
function mapApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    subjectDigest: row.subject_digest,
    requestedScopes: parseScopes(row.requested_scopes),
    requestedTtlS: row.requested_ttl_s,
    approvedAt: row.approved_at,
    approvingPrincipal: row.approving_principal,
    attestationKind: row.attestation_kind,
    consumedAt: row.consumed_at,
    consumedBy: row.consumed_by
  };
}

function parseScopes(value) {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Records a human approval. Approvals are the durable evidence behind every
 * permit and every enrolment; they are one-use.
 *
 * @param {object} store
 * @param {{namespace?:string, kind:string, subjectDigest:Buffer|string,
 *          requestedScopes?:string[]|null, requestedTtlS?:number|null,
 *          approvingPrincipal:string, attestationKind:string, approvedAt?:string}} opts
 * @returns {object} the approval
 */
export function recordApproval(store, opts = {}) {
  const ctx = context(store);
  const namespace = assertNamespace(ctx, opts.namespace);
  if (!KIND_SET.has(opts.kind)) {
    fail('invalid_request', 'unknown approval kind', { kind: String(opts.kind) });
  }
  if (!ATTESTATION_SET.has(opts.attestationKind)) {
    fail('invalid_request', 'unknown attestation kind', {
      attestationKind: String(opts.attestationKind)
    });
  }
  if (typeof opts.approvingPrincipal !== 'string' || opts.approvingPrincipal.length === 0) {
    fail('invalid_request', 'approvingPrincipal is required');
  }
  const digest = toDigest(opts.subjectDigest, 'subjectDigest');
  const ttl =
    opts.requestedTtlS === null || opts.requestedTtlS === undefined
      ? null
      : requireTtl(opts.requestedTtlS, 'requestedTtlS');
  const scopes =
    opts.requestedScopes === null || opts.requestedScopes === undefined
      ? null
      : JSON.stringify([...new Set(opts.requestedScopes)].sort());

  const id = newId('apr');
  ctx.db
    .prepare(
      'INSERT INTO approval (id, namespace, kind, subject_digest, requested_scopes, ' +
        'requested_ttl_s, approved_at, approving_principal, attestation_kind) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      namespace,
      opts.kind,
      digest,
      scopes,
      ttl,
      opts.approvedAt || now(),
      opts.approvingPrincipal,
      opts.attestationKind
    );

  return getApproval(ctx, id);
}

/** @param {object} store @param {string} id */
export function getApproval(store, id) {
  const ctx = context(store);
  const row = ctx.db
    .prepare(`SELECT ${COLUMNS} FROM approval WHERE id = ? AND namespace = ?`)
    .get(id, ctx.namespace);
  return mapApproval(row);
}

/**
 * Burns an approval exactly once via a single conditional UPDATE.
 *
 * Like `consumePermit`, this MUST run inside the caller's transaction: the burn and
 * whatever it authorises have to commit or roll back together, or a rejected effect
 * leaves a spent approval behind — or worse, a committed effect leaves a live one.
 *
 * @param {{db:any, namespace:string}} storeOrTx transaction context from store.tx()
 * @param {string} id
 * @param {string} consumedBy
 * @returns {object} the consumed approval
 */
export function consumeApproval(storeOrTx, id, consumedBy) {
  const ctx = context(storeOrTx);
  if (!ctx.db.inTransaction) {
    fail('internal', 'consumeApproval must run inside a write transaction');
  }
  if (typeof consumedBy !== 'string' || consumedBy.length === 0) {
    fail('invalid_request', 'consumedBy is required');
  }
  const res = ctx.db
    .prepare(
      'UPDATE approval SET consumed_at = ?, consumed_by = ? ' +
        'WHERE id = ? AND namespace = ? AND consumed_at IS NULL'
    )
    .run(now(), consumedBy, id, ctx.namespace);
  if (res.changes !== 1) {
    const existing = getApproval(ctx, id);
    if (!existing) fail('not_found', 'approval not found', { approvalId: id });
    fail('conflict', 'approval was already consumed', { approvalId: id });
  }
  return getApproval(ctx, id);
}

/**
 * Mints a one-use enrolment code for an approval. Returns the only copy of the
 * code; the database keeps nothing but its sha256.
 *
 * @param {object} store
 * @param {{approvalId:string, ttlSeconds:number}} opts
 * @returns {{code:string, expiresAt:string}}
 */
export function createEnrollmentCode(store, opts = {}) {
  const ctx = context(store);
  const ttl = requireTtl(opts.ttlSeconds);
  const approval = getApproval(ctx, opts.approvalId);
  if (!approval) fail('not_found', 'approval not found', { approvalId: opts.approvalId });
  if (approval.kind !== 'enrollment') {
    fail('invalid_request', 'enrolment codes require an enrollment approval', {
      kind: approval.kind
    });
  }
  if (approval.consumedAt) {
    fail('conflict', 'approval was already consumed', { approvalId: approval.id });
  }

  const code = newSecret();
  const expiresAt = plusSeconds(ttl);
  ctx.db
    .prepare(
      'INSERT INTO enrollment_code (code_sha256, namespace, approval_id, expires_at) ' +
        'VALUES (?, ?, ?, ?)'
    )
    .run(sha256(code), ctx.namespace, approval.id, expiresAt);

  return { code, expiresAt };
}

/**
 * Burns an enrolment code and returns the approval behind it.
 *
 * Unknown, expired and already-used codes all fail identically so a caller
 * cannot use the error to probe which codes exist.
 *
 * Two properties this function owns rather than delegates. First, it MUST run inside
 * the caller's transaction: the burn and the capability it authorises commit together
 * or not at all. Second, the burn itself carries the namespace predicate — deferring
 * that to the `getApproval` lookup below would let a caller in namespace B spend a
 * code minted in namespace A and rely on an enclosing rollback to undo it. The burn
 * is the security decision, so the scoping belongs in the burn.
 *
 * @param {{db:any, namespace:string}} storeOrTx transaction context from store.tx()
 * @param {string} code
 * @returns {object} the approval
 */
export function consumeEnrollmentCode(storeOrTx, code) {
  const ctx = context(storeOrTx);
  if (!ctx.db.inTransaction) {
    fail('internal', 'consumeEnrollmentCode must run inside a write transaction');
  }
  if (typeof code !== 'string' || code.length === 0) {
    fail('forbidden', 'enrolment code is invalid or already used');
  }
  const at = now();
  const digest = sha256(code);
  const res = ctx.db
    .prepare(
      'UPDATE enrollment_code SET consumed_at = ? ' +
        'WHERE code_sha256 = ? AND namespace = ? AND consumed_at IS NULL AND expires_at > ?'
    )
    .run(at, digest, ctx.namespace, at);
  if (res.changes !== 1) {
    fail('forbidden', 'enrolment code is invalid or already used');
  }
  const row = ctx.db
    .prepare('SELECT approval_id FROM enrollment_code WHERE code_sha256 = ? AND namespace = ?')
    .get(digest, ctx.namespace);
  const approval = getApproval(ctx, row.approval_id);
  if (!approval) fail('forbidden', 'enrolment code is invalid or already used');
  return approval;
}

/**
 * @param {object} store
 * @param {{kind?:string, consumed?:boolean}} [opts]
 */
export function listApprovals(store, opts = {}) {
  const ctx = context(store);
  const where = ['namespace = ?'];
  const params = [ctx.namespace];
  if (opts.kind !== undefined) {
    if (!KIND_SET.has(opts.kind)) {
      fail('invalid_request', 'unknown approval kind', { kind: String(opts.kind) });
    }
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.consumed === true) where.push('consumed_at IS NOT NULL');
  if (opts.consumed === false) where.push('consumed_at IS NULL');
  return ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM approval WHERE ${where.join(' AND ')} ORDER BY approved_at, rowid`
    )
    .all(...params)
    .map(mapApproval);
}
