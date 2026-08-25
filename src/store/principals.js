import { assertNamespace, context, inTx } from './db.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { now } from '../core/time.js';
import { ALIAS_DESCRIPTION, isValidAlias } from '../core/validate.js';
import { revokeCapabilityClosure } from './revocation.js';

export const ROLES = Object.freeze(['root', 'goal_hub', 'listener', 'operator', 'legacy']);
const ROLE_SET = new Set(ROLES);

const COLUMNS = 'id, namespace, role, display_alias, paseo_agent_id, created_at, revoked_at';

/** @param {object} row */
function mapPrincipal(row) {
  if (!row) return null;
  return {
    id: row.id,
    namespace: row.namespace,
    role: row.role,
    displayAlias: row.display_alias,
    paseoAgentId: row.paseo_agent_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

/**
 * Every alias write — mint and rename alike — goes through here, so there is
 * exactly one grammar and exactly one place that enforces it. v0.3 kept a
 * looser copy of the grammar in this module and never applied `isValidAlias`
 * to the live rename path at all.
 */
function normaliseAlias(alias) {
  if (alias === null || alias === undefined) return null;
  if (typeof alias !== 'string') fail('invalid_request', 'display alias must be a string');
  const trimmed = alias.trim();
  if (trimmed.length === 0) return null;
  if (!isValidAlias(trimmed)) {
    fail('invalid_request', `display alias must be ${ALIAS_DESCRIPTION}`);
  }
  return trimmed;
}

function isUniqueViolation(err) {
  return err && err.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Mints a principal. A display alias is presentation metadata only and carries
 * no authority; colliding with a live incumbent rejects the newcomer.
 *
 * @param {object} store
 * @param {{role:string, displayAlias?:string|null, paseoAgentId?:string|null,
 *          namespace?:string, id?:string}} opts
 */
export function createPrincipal(store, opts = {}) {
  const ctx = context(store);
  const namespace = assertNamespace(ctx, opts.namespace);
  if (!ROLE_SET.has(opts.role)) {
    fail('invalid_request', 'unknown principal role', { role: String(opts.role) });
  }
  const alias = normaliseAlias(opts.displayAlias);
  const id = opts.id || newId('prn');
  const createdAt = now();

  try {
    ctx.db
      .prepare(
        'INSERT INTO principal (id, namespace, role, display_alias, paseo_agent_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, namespace, opts.role, alias, opts.paseoAgentId ?? null, createdAt);
  } catch (err) {
    if (isUniqueViolation(err)) {
      fail('conflict', 'display alias is already held by a live principal', { alias });
    }
    if (err && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      fail('conflict', 'principal id already exists', { id });
    }
    throw err;
  }

  return getPrincipal(ctx, id);
}

/** @param {object} store @param {string} id */
export function getPrincipal(store, id) {
  const ctx = context(store);
  const row = ctx.db
    .prepare(`SELECT ${COLUMNS} FROM principal WHERE id = ? AND namespace = ?`)
    .get(id, ctx.namespace);
  return mapPrincipal(row);
}

/**
 * Resolves a live principal by alias. Revoked principals are never returned —
 * their alias is free for reuse.
 *
 * The comparison is NOCASE, matching the uniqueness index and the case fold
 * mention resolution applies: at most one live principal can answer to a given
 * fold, so a lookup is unambiguous and the partial index still serves it.
 * @param {object} store @param {string} alias
 */
export function getPrincipalByAlias(store, alias) {
  const ctx = context(store);
  if (typeof alias !== 'string' || alias.trim().length === 0) return null;
  const row = ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM principal ` +
        'WHERE namespace = ? AND display_alias = ? COLLATE NOCASE AND revoked_at IS NULL'
    )
    .get(ctx.namespace, alias.trim());
  return mapPrincipal(row);
}

/**
 * Renames a principal. Touches the principal row only: capabilities, cursors
 * and permits are keyed by principal id and must not move. A collision with a
 * live incumbent rejects this rename; the incumbent is never displaced.
 *
 * @param {object} store
 * @param {string} id
 * @param {string|null} alias
 */
export function setAlias(store, id, alias) {
  const ctx = context(store);
  const existing = getPrincipal(ctx, id);
  if (!existing) fail('not_found', 'principal not found', { id });
  if (existing.revokedAt) fail('conflict', 'principal is revoked', { id });

  const next = normaliseAlias(alias);
  if (next === existing.displayAlias) return existing;

  try {
    const res = ctx.db
      .prepare(
        'UPDATE principal SET display_alias = ? WHERE id = ? AND namespace = ? AND revoked_at IS NULL'
      )
      .run(next, id, ctx.namespace);
    if (res.changes !== 1) fail('conflict', 'principal is revoked', { id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      fail('conflict', 'display alias is already held by a live principal', { alias: next });
    }
    throw err;
  }

  return getPrincipal(ctx, id);
}

/**
 * Revokes a principal and everything it delegated.
 *
 * Revocation is the incident-response action, so it has to mean "this identity
 * can no longer act, directly or through anything it minted". v0.3 updated
 * only the principal row: the principal's own capabilities stopped verifying
 * (verifyCapability checks the bearer's principal) but the capabilities it had
 * delegated to OTHER principals kept working, because the ancestor walk only
 * inspected each ancestor capability, never the principal behind it. Sweeping
 * the derivation closure here makes the revocation visible in the rows, and
 * `verifyCapability` re-checks ancestor principals to close the window where a
 * delegation is minted between this sweep's SELECT and its UPDATE.
 *
 * @param {object} store @param {string} id @param {string} [at]
 */
export function revokePrincipal(store, id, at) {
  const ctx = context(store);
  const instant = at || now();

  return inTx(store, () => {
    const res = ctx.db
      .prepare(
        'UPDATE principal SET revoked_at = ? WHERE id = ? AND namespace = ? AND revoked_at IS NULL'
      )
      .run(instant, id, ctx.namespace);
    if (res.changes !== 1) {
      const existing = getPrincipal(ctx, id);
      if (!existing) fail('not_found', 'principal not found', { id });
      fail('conflict', 'principal is already revoked', { id });
    }

    // Indexed by capability_principal(namespace, principal_id).
    const seeds = ctx.db
      .prepare('SELECT id FROM capability WHERE namespace = ? AND principal_id = ?')
      .all(ctx.namespace, id)
      .map((r) => r.id);
    revokeCapabilityClosure(ctx, seeds, 'principal revoked', instant);

    return getPrincipal(ctx, id);
  });
}

/**
 * @param {object} store
 * @param {{role?:string, includeRevoked?:boolean}} [opts]
 */
export function listPrincipals(store, opts = {}) {
  const ctx = context(store);
  const where = ['namespace = ?'];
  const params = [ctx.namespace];
  if (opts.role !== undefined) {
    if (!ROLE_SET.has(opts.role)) {
      fail('invalid_request', 'unknown principal role', { role: String(opts.role) });
    }
    where.push('role = ?');
    params.push(opts.role);
  }
  if (!opts.includeRevoked) where.push('revoked_at IS NULL');
  const rows = ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM principal WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`
    )
    .all(...params);
  return rows.map(mapPrincipal);
}
