/**
 * The capability derivation closure, shared by the two things that revoke.
 *
 * It lives in its own module because both `revokeCapability` (capabilities.js)
 * and `revokePrincipal` (principals.js) need it, and capabilities.js already
 * imports principals.js — putting it in either would make that edge circular.
 */

/**
 * Revokes `seedIds` and everything derived from them: children (by
 * `parent_capability_id`) and renewals (by `renewed_from`), transitively.
 *
 * Already-revoked rows keep their original `revoked_at` and reason — the first
 * revocation is the one that happened — but still appear in the returned
 * closure, so a caller can report the full blast radius.
 *
 * The caller must already hold the write transaction.
 *
 * @param {{db:any, namespace:string}} ctx
 * @param {string[]} seedIds
 * @param {string} reason
 * @param {string} at ISO instant
 * @returns {string[]} every capability id in the closure
 */
export function revokeCapabilityClosure(ctx, seedIds, reason, at) {
  const seeds = [...new Set(seedIds)];
  if (seeds.length === 0) return [];

  const seedMarks = seeds.map(() => '?').join(', ');
  const rows = ctx.db
    .prepare(
      'WITH RECURSIVE closure(id) AS (' +
        `  SELECT id FROM capability WHERE id IN (${seedMarks}) AND namespace = ?` +
        '  UNION' +
        '  SELECT c.id FROM capability c JOIN closure ON ' +
        '    (c.parent_capability_id = closure.id OR c.renewed_from = closure.id) ' +
        '  WHERE c.namespace = ?' +
        ') SELECT id FROM closure'
    )
    .all(...seeds, ctx.namespace, ctx.namespace);

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const marks = ids.map(() => '?').join(', ');
  ctx.db
    .prepare(
      'UPDATE capability SET revoked_at = ?, revoked_reason = ? ' +
        `WHERE id IN (${marks}) AND revoked_at IS NULL`
    )
    .run(at, reason, ...ids);

  return ids;
}
