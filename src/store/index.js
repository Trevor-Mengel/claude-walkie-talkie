/**
 * The v0.3 authority store: principals, capabilities, approvals, permits,
 * holds and audit, on a single namespaced SQLite file.
 *
 * Calling convention: every function takes the store (or a transaction context
 * from `store.tx()`) as its first argument. A transaction context is accepted
 * anywhere a store is, so an entire authority decision can be one atomic unit:
 *
 *   const store = openStore({ path, namespace });
 *   store.tx((tx) => {
 *     consumePermit(tx, { permitId, principalId, operation, resourceId, contentDigest });
 *     audit(tx, { action: 'retention.prune', outcome: 'allowed', ... });
 *   });
 *
 * Secrets (capability tokens, enrolment codes) are returned exactly once by the
 * function that mints them. Only their sha256 is ever written to disk.
 */

export { openStore, context, assertNamespace, inTx, SCHEMA_VERSION } from './db.js';
export { StoreError, storeError, fail, toEnvelope, ERROR_CODES } from './errors.js';
export { newId, isStoreId, ID_PREFIXES } from './ids.js';
export { now, plusSeconds, requireTtl } from './clock.js';
export { sha256, sha256Hex, newSecret, toDigest, digestEquals, SECRET_BYTES } from './digest.js';

export {
  createPrincipal,
  getPrincipal,
  getPrincipalByAlias,
  setAlias,
  revokePrincipal,
  listPrincipals,
  ROLES
} from './principals.js';

export {
  issueCapability,
  verifyCapability,
  renewCapability,
  revokeCapability,
  getCapability,
  listCapabilities,
  hasScope,
  SCOPES,
  ATTESTATION_KINDS
} from './capabilities.js';

export {
  recordApproval,
  getApproval,
  consumeApproval,
  createEnrollmentCode,
  consumeEnrollmentCode,
  listApprovals,
  APPROVAL_KINDS
} from './approvals.js';

export {
  grantPermit,
  consumePermit,
  getPermit,
  revokePermit,
  expirePermits,
  listPermits,
  PERMIT_OPERATIONS,
  PERMIT_STATES
} from './permits.js';

export {
  getCursor,
  getCursors,
  getCursorViews,
  advanceCursor,
  requireMessageId,
  cursorView,
  cursorKindsToAdvance,
  CURSOR_KINDS,
  VIEW_DEFAULT,
  VIEW_WITH_MEMORY,
  NO_CURSOR
} from './cursors.js';

export {
  createHold,
  releaseHold,
  getHold,
  activeHoldsFor,
  isHeld,
  HOLD_SUBJECT_KINDS
} from './holds.js';

export { audit, redactDetail, listAudit } from './audit.js';
