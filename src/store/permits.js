import { assertNamespace, context } from './db.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { toDigest } from './digest.js';
import { now, plusSeconds, requireTtl } from './clock.js';

/**
 * A permit is exact, one-use, and bound to
 * (namespace, principal, operation, resource_id, content_digest, expires_at).
 * There is no permit for posting — routine publishing is the `channel:publish`
 * standing capability.
 */
export const PERMIT_OPERATIONS = Object.freeze([
  'retention.prune',
  'retention.rollback',
  'capability.widen'
]);
const OPERATION_SET = new Set(PERMIT_OPERATIONS);

export const PERMIT_STATES = Object.freeze(['granted', 'consumed', 'revoked', 'expired']);

const COLUMNS =
  'id, namespace, principal_id, operation, resource_id, content_digest, approval_id, ' +
  'expires_at, state, consumed_at, consumed_ref';

/** @param {object} row */
function mapPermit(row) {
  if (!row) return null;
  return {
    id: row.id,
    namespace: row.namespace,
    principalId: row.principal_id,
    operation: row.operation,
    resourceId: row.resource_id,
    contentDigest: row.content_digest,
    approvalId: row.approval_id,
    expiresAt: row.expires_at,
    state: row.state,
    consumedAt: row.consumed_at,
    consumedRef: row.consumed_ref
  };
}

function requireOperation(operation) {
  if (!OPERATION_SET.has(operation)) {
    fail('invalid_request', 'unknown permit operation', { operation: String(operation) });
  }
  return operation;
}

function requireResourceId(resourceId) {
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    fail('invalid_request', 'resourceId is required');
  }
  return resourceId;
}

/**
 * @param {object} store
 * @param {{namespace?:string, principalId:string, operation:string, resourceId:string,
 *          contentDigest:Buffer|string, approvalId:string, ttlSeconds:number}} opts
 * @returns {object} the granted permit
 */
export function grantPermit(store, opts = {}) {
  const ctx = context(store);
  const namespace = assertNamespace(ctx, opts.namespace);
  const operation = requireOperation(opts.operation);
  const resourceId = requireResourceId(opts.resourceId);
  const digest = toDigest(opts.contentDigest, 'contentDigest');
  const ttl = requireTtl(opts.ttlSeconds);

  if (typeof opts.principalId !== 'string' || opts.principalId.length === 0) {
    fail('invalid_request', 'principalId is required');
  }
  if (typeof opts.approvalId !== 'string' || opts.approvalId.length === 0) {
    fail('invalid_request', 'approvalId is required');
  }

  const id = newId('pmt');
  const expiresAt = plusSeconds(ttl);

  try {
    ctx.db
      .prepare(
        'INSERT INTO permit (id, namespace, principal_id, operation, resource_id, ' +
          'content_digest, approval_id, expires_at, state) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'granted')"
      )
      .run(
        id,
        namespace,
        opts.principalId,
        operation,
        resourceId,
        digest,
        opts.approvalId,
        expiresAt
      );
  } catch (err) {
    if (err && String(err.code).startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
      fail('not_found', 'approval not found', { approvalId: opts.approvalId });
    }
    throw err;
  }

  return getPermit(ctx, id);
}

/** @param {object} store @param {string} id */
export function getPermit(store, id) {
  const ctx = context(store);
  const row = ctx.db
    .prepare(`SELECT ${COLUMNS} FROM permit WHERE id = ? AND namespace = ?`)
    .get(id, ctx.namespace);
  return mapPermit(row);
}

/**
 * Consumes a permit exactly once.
 *
 * This MUST run inside the caller's transaction so the permit burn and the
 * effect it authorises commit or roll back together. The whole decision is a
 * single conditional UPDATE: every binding is in the WHERE clause, so N racing
 * processes produce exactly one `changes === 1` and N-1 `permit_invalid`.
 *
 * @param {{db:any, namespace:string}} tx transaction context from store.tx()
 * @param {{permitId:string, namespace?:string, principalId:string, operation:string,
 *          resourceId:string, contentDigest:Buffer|string, consumedRef?:string}} opts
 * @returns {object} the consumed permit
 */
export function consumePermit(tx, opts = {}) {
  const ctx = context(tx);
  if (!ctx.db.inTransaction) {
    fail('internal', 'consumePermit must run inside a write transaction');
  }
  const namespace = assertNamespace(ctx, opts.namespace);
  const operation = requireOperation(opts.operation);
  const resourceId = requireResourceId(opts.resourceId);
  const digest = toDigest(opts.contentDigest, 'contentDigest');
  if (typeof opts.permitId !== 'string' || opts.permitId.length === 0) {
    fail('invalid_request', 'permitId is required');
  }
  if (typeof opts.principalId !== 'string' || opts.principalId.length === 0) {
    fail('invalid_request', 'principalId is required');
  }

  const at = now();
  const res = ctx.db
    .prepare(
      "UPDATE permit SET state = 'consumed', consumed_at = ?, consumed_ref = ? " +
        "WHERE id = ? AND state = 'granted' AND expires_at > ? AND namespace = ? " +
        'AND principal_id = ? AND operation = ? AND resource_id = ? AND content_digest = ?'
    )
    .run(
      at,
      opts.consumedRef ?? null,
      opts.permitId,
      at,
      namespace,
      opts.principalId,
      operation,
      resourceId,
      digest
    );

  // One row means we won the race. Anything else — wrong binding, expired,
  // revoked, already consumed, or lost the race — is indistinguishable on
  // purpose: the caller learns only that this permit does not authorise this act.
  if (res.changes !== 1) {
    fail('permit_invalid', 'permit does not authorise this operation', {
      permitId: opts.permitId
    });
  }

  return getPermit(ctx, opts.permitId);
}

/**
 * @param {object} store
 * @param {string} id
 * @returns {object} the revoked permit
 */
export function revokePermit(store, id) {
  const ctx = context(store);
  const res = ctx.db
    .prepare(
      "UPDATE permit SET state = 'revoked' WHERE id = ? AND namespace = ? AND state = 'granted'"
    )
    .run(id, ctx.namespace);
  if (res.changes !== 1) {
    const existing = getPermit(ctx, id);
    if (!existing) fail('not_found', 'permit not found', { permitId: id });
    fail('conflict', 'permit is no longer revocable', { permitId: id, state: existing.state });
  }
  return getPermit(ctx, id);
}

/**
 * Marks every lapsed grant as expired. Consumption already refuses lapsed
 * permits; this only keeps the visible state honest.
 *
 * @param {object} store
 * @param {string} [at] ISO instant, defaults to now
 * @returns {number} rows transitioned
 */
export function expirePermits(store, at) {
  const ctx = context(store);
  const instant = at || now();
  const res = ctx.db
    .prepare(
      "UPDATE permit SET state = 'expired' " +
        "WHERE namespace = ? AND state = 'granted' AND expires_at <= ?"
    )
    .run(ctx.namespace, instant);
  return res.changes;
}

/**
 * @param {object} store
 * @param {{principalId?:string, state?:string, operation?:string, resourceId?:string}} [opts]
 */
export function listPermits(store, opts = {}) {
  const ctx = context(store);
  const where = ['namespace = ?'];
  const params = [ctx.namespace];
  if (opts.principalId !== undefined) {
    where.push('principal_id = ?');
    params.push(opts.principalId);
  }
  if (opts.state !== undefined) {
    if (!PERMIT_STATES.includes(opts.state)) {
      fail('invalid_request', 'unknown permit state', { state: String(opts.state) });
    }
    where.push('state = ?');
    params.push(opts.state);
  }
  if (opts.operation !== undefined) {
    where.push('operation = ?');
    params.push(requireOperation(opts.operation));
  }
  if (opts.resourceId !== undefined) {
    where.push('resource_id = ?');
    params.push(opts.resourceId);
  }
  return ctx.db
    .prepare(`SELECT ${COLUMNS} FROM permit WHERE ${where.join(' AND ')} ORDER BY rowid`)
    .all(...params)
    .map(mapPermit);
}
