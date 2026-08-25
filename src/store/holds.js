import { assertNamespace, context } from './db.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { now } from './clock.js';

export const HOLD_SUBJECT_KINDS = Object.freeze(['thread', 'event']);
const KIND_SET = new Set(HOLD_SUBJECT_KINDS);

const COLUMNS =
  'id, namespace, subject_kind, subject_id, reason, created_by, created_at, released_at';

/** @param {object} row */
function mapHold(row) {
  if (!row) return null;
  return {
    id: row.id,
    namespace: row.namespace,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    releasedAt: row.released_at
  };
}

function requireKind(subjectKind) {
  if (!KIND_SET.has(subjectKind)) {
    fail('invalid_request', 'unknown hold subject kind', { subjectKind: String(subjectKind) });
  }
  return subjectKind;
}

/**
 * Places a retention hold on a thread or event. A held subject must survive
 * pruning regardless of any permit.
 *
 * @param {object} store
 * @param {{namespace?:string, subjectKind:string, subjectId:string, reason:string,
 *          createdBy:string}} opts
 * @returns {object} the hold
 */
export function createHold(store, opts = {}) {
  const ctx = context(store);
  const namespace = assertNamespace(ctx, opts.namespace);
  const subjectKind = requireKind(opts.subjectKind);
  if (typeof opts.subjectId !== 'string' || opts.subjectId.length === 0) {
    fail('invalid_request', 'subjectId is required');
  }
  if (typeof opts.reason !== 'string' || opts.reason.length === 0) {
    fail('invalid_request', 'a hold reason is required');
  }
  if (typeof opts.createdBy !== 'string' || opts.createdBy.length === 0) {
    fail('invalid_request', 'createdBy is required');
  }

  const id = newId('hld');
  ctx.db
    .prepare(
      'INSERT INTO hold (id, namespace, subject_kind, subject_id, reason, created_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, namespace, subjectKind, opts.subjectId, opts.reason, opts.createdBy, now());

  return getHold(ctx, id);
}

/** @param {object} store @param {string} id */
export function getHold(store, id) {
  const ctx = context(store);
  const row = ctx.db
    .prepare(`SELECT ${COLUMNS} FROM hold WHERE id = ? AND namespace = ?`)
    .get(id, ctx.namespace);
  return mapHold(row);
}

/**
 * @param {object} store
 * @param {string} id
 * @param {string} [at]
 * @returns {object} the released hold
 */
export function releaseHold(store, id, at) {
  const ctx = context(store);
  const res = ctx.db
    .prepare(
      'UPDATE hold SET released_at = ? WHERE id = ? AND namespace = ? AND released_at IS NULL'
    )
    .run(at || now(), id, ctx.namespace);
  if (res.changes !== 1) {
    const existing = getHold(ctx, id);
    if (!existing) fail('not_found', 'hold not found', { holdId: id });
    fail('conflict', 'hold was already released', { holdId: id });
  }
  return getHold(ctx, id);
}

/**
 * @param {object} store
 * @param {string} subjectKind
 * @param {string} subjectId
 * @returns {object[]} live holds, oldest first
 */
export function activeHoldsFor(store, subjectKind, subjectId) {
  const ctx = context(store);
  requireKind(subjectKind);
  return ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM hold WHERE namespace = ? AND subject_kind = ? AND subject_id = ? ` +
        'AND released_at IS NULL ORDER BY created_at, rowid'
    )
    .all(ctx.namespace, subjectKind, subjectId)
    .map(mapHold);
}

/**
 * @param {object} store
 * @param {string} subjectKind
 * @param {string} subjectId
 * @returns {boolean}
 */
export function isHeld(store, subjectKind, subjectId) {
  const ctx = context(store);
  requireKind(subjectKind);
  const row = ctx.db
    .prepare(
      'SELECT 1 AS held FROM hold WHERE namespace = ? AND subject_kind = ? AND subject_id = ? ' +
        'AND released_at IS NULL LIMIT 1'
    )
    .get(ctx.namespace, subjectKind, subjectId);
  return Boolean(row);
}
