import { assertNamespace, context, inTx } from './db.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { digestEquals, newSecret, sha256 } from './digest.js';
import { now, plusSeconds, requireTtl } from './clock.js';
import { getPrincipal } from './principals.js';
import { revokeCapabilityClosure } from './revocation.js';

export const SCOPES = Object.freeze([
  'channel:read',
  'channel:publish',
  'channel:ack',
  'self:alias',
  'self:cursor',
  'listener:consume',
  'listener:receipt',
  'permit:administer',
  'enroll:delegate',
  'retention:approve'
]);
const SCOPE_SET = new Set(SCOPES);

export const ATTESTATION_KINDS = Object.freeze(['omp_hook_confirm', 'operator_cli', 'delegation']);
const ATTESTATION_SET = new Set(ATTESTATION_KINDS);

/** Defence against a malformed derivation cycle in the capability graph. */
const MAX_CHAIN_DEPTH = 32;

const COLUMNS =
  'id, namespace, principal_id, token_sha256, scopes, not_before, expires_at, issued_at, ' +
  'attestation_kind, attestation_ref, parent_capability_id, renewed_from, revoked_at, revoked_reason';

/** @param {object} row */
function mapCapability(row) {
  if (!row) return null;
  return {
    id: row.id,
    namespace: row.namespace,
    principalId: row.principal_id,
    scopes: parseScopes(row.scopes),
    notBefore: row.not_before,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    attestationKind: row.attestation_kind,
    attestationRef: row.attestation_ref,
    parentCapabilityId: row.parent_capability_id,
    renewedFrom: row.renewed_from,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason
  };
}

/** @param {string|string[]} scopes */
function parseScopes(scopes) {
  if (Array.isArray(scopes)) return [...scopes];
  if (typeof scopes !== 'string') return [];
  try {
    const parsed = JSON.parse(scopes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Canonical (sorted, de-duplicated) scope serialisation. */
function serialiseScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    fail('invalid_request', 'at least one scope is required');
  }
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (!SCOPE_SET.has(scope)) fail('invalid_request', 'unknown scope', { scope: String(scope) });
  }
  unique.sort();
  return { list: unique, json: JSON.stringify(unique) };
}

/**
 * @param {string[]} child
 * @param {string[]} parent
 */
function isSubset(child, parent) {
  const set = new Set(parent);
  return child.every((scope) => set.has(scope));
}

/**
 * Issues a capability. Returns the one and only copy of the bearer token; the
 * database stores nothing but its sha256.
 *
 * @param {object} store
 * @param {{namespace?:string, principalId:string, scopes:string[], ttlSeconds:number,
 *          attestationKind:string, attestationRef:string, parentCapabilityId?:string|null,
 *          notBefore?:string, renewedFrom?:string|null}} opts
 * @returns {{capabilityId:string, token:string}}
 */
export function issueCapability(store, opts = {}) {
  const ctx = context(store);
  const namespace = assertNamespace(ctx, opts.namespace);
  const ttl = requireTtl(opts.ttlSeconds);
  const { list, json } = serialiseScopes(opts.scopes);

  if (!ATTESTATION_SET.has(opts.attestationKind)) {
    fail('invalid_request', 'unknown attestation kind', {
      attestationKind: String(opts.attestationKind)
    });
  }
  if (typeof opts.attestationRef !== 'string' || opts.attestationRef.length === 0) {
    fail('invalid_request', 'attestationRef is required');
  }

  const principal = getPrincipal(ctx, opts.principalId);
  if (!principal) fail('not_found', 'principal not found', { principalId: opts.principalId });
  if (principal.revokedAt) {
    fail('forbidden', 'principal is revoked', { principalId: opts.principalId });
  }

  const issuedAt = now();
  const notBefore = opts.notBefore || issuedAt;
  const expiresAt = plusSeconds(ttl, issuedAt);

  const parentId = opts.parentCapabilityId ?? null;
  if (parentId) {
    const parent = readCapability(ctx, parentId);
    if (!parent) fail('not_found', 'parent capability not found');
    if (parent.namespace !== namespace)
      fail('wrong_namespace', 'parent capability namespace differs');
    if (parent.revokedAt) fail('forbidden', 'parent capability is revoked');
    if (parent.expiresAt <= issuedAt) fail('forbidden', 'parent capability has expired');
    if (!isSubset(list, parent.scopes)) {
      fail('forbidden', 'a derived capability cannot widen its parent scopes', {
        widened: list.filter((s) => !parent.scopes.includes(s))
      });
    }
    if (expiresAt > parent.expiresAt) {
      fail('forbidden', 'a derived capability cannot outlive its parent');
    }
  }

  const token = newSecret();
  const id = newId('cap');

  ctx.db
    .prepare(
      'INSERT INTO capability (id, namespace, principal_id, token_sha256, scopes, not_before, ' +
        'expires_at, issued_at, attestation_kind, attestation_ref, parent_capability_id, renewed_from) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      namespace,
      principal.id,
      sha256(token),
      json,
      notBefore,
      expiresAt,
      issuedAt,
      opts.attestationKind,
      opts.attestationRef,
      parentId,
      opts.renewedFrom ?? null
    );

  return { capabilityId: id, token };
}

/** @param {object} ctx @param {string} id */
function readCapability(ctx, id) {
  const row = ctx.db.prepare(`SELECT ${COLUMNS} FROM capability WHERE id = ?`).get(id);
  return mapCapability(row);
}

/**
 * @param {object} store
 * @param {string} id
 * @returns {object|null}
 */
export function getCapability(store, id) {
  const ctx = context(store);
  const cap = readCapability(ctx, id);
  if (!cap || cap.namespace !== ctx.namespace) return null;
  return cap;
}

/**
 * Resolves a bearer token to its capability and principal, or null.
 *
 * Every rejection reason collapses to null on purpose: the caller renders
 * `unauthenticated` without telling the bearer which check failed.
 *
 * @param {object} store
 * @param {string} token
 * @param {string} [at] ISO instant to evaluate against, defaults to now
 * @returns {{capability:object, principal:object}|null}
 */
export function verifyCapability(store, token, at) {
  const ctx = context(store);
  if (typeof token !== 'string' || token.length === 0) return null;

  const presented = sha256(token);
  // Indexed single-row lookup: token_sha256 is UNIQUE, never a table scan.
  const row = ctx.db
    .prepare(`SELECT ${COLUMNS} FROM capability WHERE token_sha256 = ?`)
    .get(presented);
  if (!row) return null;
  if (!digestEquals(row.token_sha256, presented)) return null;

  const capability = mapCapability(row);
  const instant = at || now();
  if (capability.namespace !== ctx.namespace) return null;
  if (!isLive(capability, instant)) return null;
  if (capability.notBefore > instant) return null;

  const principal = getPrincipal(ctx, capability.principalId);
  if (!principal || principal.revokedAt) return null;

  // A revoked or expired ancestor invalidates every descendant — and so does a
  // revoked ancestor PRINCIPAL. `revokePrincipal` sweeps the derivation closure
  // at write time; this walk is what makes the guarantee hold for a delegation
  // minted between that sweep's SELECT and its UPDATE.
  //
  // Cost stays bounded: one UNIQUE-index hit on token_sha256, then at most
  // MAX_CHAIN_DEPTH primary-key lookups per side, with issuers memoised so a
  // chain inside one principal costs a single principal read.
  let cursor = capability.parentCapabilityId;
  const seen = new Set([capability.id]);
  const liveIssuers = new Set([principal.id]);
  for (let depth = 0; cursor; depth += 1) {
    if (depth >= MAX_CHAIN_DEPTH || seen.has(cursor)) return null;
    seen.add(cursor);
    const parent = readCapability(ctx, cursor);
    if (!parent) return null;
    if (parent.namespace !== ctx.namespace) return null;
    if (!isLive(parent, instant)) return null;
    if (!liveIssuers.has(parent.principalId)) {
      const issuer = getPrincipal(ctx, parent.principalId);
      if (!issuer || issuer.revokedAt) return null;
      liveIssuers.add(issuer.id);
    }
    cursor = parent.parentCapabilityId;
  }

  return { capability, principal };
}

function isLive(capability, instant) {
  if (capability.revokedAt) return false;
  if (capability.expiresAt <= instant) return false;
  return true;
}

/**
 * Re-issues a live capability with a fresh token and TTL. Scopes, namespace and
 * principal can only narrow — never widen. The predecessor is recorded in
 * `renewed_from`, so revoking it later cascades onto this renewal.
 *
 * @param {object} store
 * @param {string} capabilityId
 * @param {number} ttlSeconds
 * @param {{scopes?:string[], namespace?:string, principalId?:string}} [opts]
 * @returns {{capabilityId:string, token:string}}
 */
export function renewCapability(store, capabilityId, ttlSeconds, opts = {}) {
  const ctx = context(store);
  const ttl = requireTtl(ttlSeconds);
  const existing = getCapability(ctx, capabilityId);
  if (!existing) fail('not_found', 'capability not found', { capabilityId });

  const instant = now();
  if (existing.revokedAt) fail('forbidden', 'capability is revoked', { capabilityId });
  if (existing.expiresAt <= instant) {
    fail('forbidden', 'capability has expired; re-enrolment is required', { capabilityId });
  }
  if (opts.namespace !== undefined && opts.namespace !== existing.namespace) {
    fail('forbidden', 'renewal cannot change namespace');
  }
  if (opts.principalId !== undefined && opts.principalId !== existing.principalId) {
    fail('forbidden', 'renewal cannot change principal');
  }

  let scopes = existing.scopes;
  if (opts.scopes !== undefined) {
    const requested = serialiseScopes(opts.scopes).list;
    if (!isSubset(requested, existing.scopes)) {
      fail('forbidden', 'renewal cannot widen scopes', {
        widened: requested.filter((s) => !existing.scopes.includes(s))
      });
    }
    scopes = requested;
  }

  return issueCapability(ctx, {
    namespace: existing.namespace,
    principalId: existing.principalId,
    scopes,
    ttlSeconds: ttl,
    attestationKind: existing.attestationKind,
    attestationRef: existing.attestationRef,
    parentCapabilityId: existing.parentCapabilityId,
    renewedFrom: existing.id
  });
}

/**
 * Revokes a capability and its entire derivation closure — children (by
 * `parent_capability_id`) and renewals (by `renewed_from`), transitively.
 *
 * @param {object} store
 * @param {string} id
 * @param {string} reason
 * @returns {{revoked:string[]}}
 */
export function revokeCapability(store, id, reason) {
  const ctx = context(store);
  const target = getCapability(ctx, id);
  if (!target) fail('not_found', 'capability not found', { capabilityId: id });

  const at = now();
  const why = typeof reason === 'string' && reason.length > 0 ? reason : 'revoked';

  return inTx(store, () => ({ revoked: revokeCapabilityClosure(ctx, [id], why, at) }));
}

/**
 * @param {{scopes:string[]|string}} capability
 * @param {string} scope
 */
export function hasScope(capability, scope) {
  if (!capability) return false;
  return parseScopes(capability.scopes).includes(scope);
}

/**
 * @param {object} store
 * @param {{principalId?:string, includeRevoked?:boolean}} [opts]
 */
export function listCapabilities(store, opts = {}) {
  const ctx = context(store);
  const where = ['namespace = ?'];
  const params = [ctx.namespace];
  if (opts.principalId !== undefined) {
    where.push('principal_id = ?');
    params.push(opts.principalId);
  }
  if (!opts.includeRevoked) where.push('revoked_at IS NULL');
  return ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM capability WHERE ${where.join(' AND ')} ORDER BY issued_at, rowid`
    )
    .all(...params)
    .map(mapCapability);
}
