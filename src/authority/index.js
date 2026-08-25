/**
 * The authority slice: operator-approved enrollment.
 *
 * Two entry points matter to the rest of the system:
 *
 *   startAuthority({ store, config, runtimeRoot })  — the daemon binds the hook socket
 *   exchangeEnrollmentCode(store, code)             — POST /enroll/exchange redeems a code
 *
 * Everything else exported here is the policy and path vocabulary the transport layer
 * and the CLI share, so neither re-derives a runtime path or a scope allowlist.
 */

export {
  RUNTIME_DIRNAME,
  RUNTIME_ROOT_ENV,
  SOCKET_FILENAME,
  SECRET_FILENAME,
  RUNTIME_DIR_MODE,
  RUNTIME_FILE_MODE,
  MAX_SOCKET_PATH_BYTES,
  authorityRuntimeDir,
  authoritySocketPath,
  hookSecretPath,
  ensureRuntimeDir,
  assertBindablePath
} from './paths.js';

export {
  SECRET_ENV,
  SECRET_BYTES,
  MIN_SECRET_LENGTH,
  compareSecret,
  generateSecret,
  loadSecret,
  ensureSecret
} from './secret.js';

export {
  ENROLL_ROLE,
  ENROLLABLE_ROLES,
  ROLE_SCOPES,
  MIN_ENROLL_TTL_SECONDS,
  MAX_ENROLL_TTL_SECONDS,
  DEFAULT_ENROLL_TTL_SECONDS,
  DEFAULT_CODE_TTL_SECONDS,
  MIN_CODE_TTL_SECONDS,
  MAX_CODE_TTL_SECONDS,
  DENIED_MESSAGE,
  OPAQUE_CODES,
  assertEnrollable,
  scopesForRole,
  requireCodeTtlSeconds
} from './policy.js';

export {
  ATTESTATION_KIND,
  APPROVING_PRINCIPAL,
  APPROVAL_CONSUMER,
  INVALID_CODE_MESSAGE,
  DIGEST_DOMAIN,
  canonicaliseGrant,
  grantDigest,
  handleEnrollRequest,
  exchangeEnrollmentCode
} from './enroll.js';

export {
  ENROLL_OP,
  MAX_REQUEST_BYTES,
  IDLE_TIMEOUT_MS,
  createEnrollHandler,
  readRequestLine,
  replyFor,
  probeSocket,
  startAuthoritySocket
} from './socket.js';

import { startAuthoritySocket } from './socket.js';

/**
 * Starts the authority for one namespace: binds the operator-hook enrollment socket
 * and returns its address plus a close handle. Fails closed — if there is no hook
 * secret, or the address is held by a live authority, it throws rather than serving.
 *
 * @param {object} opts
 * @param {object} opts.store the namespace's authority store
 * @param {{namespace:string}} opts.config
 * @param {string} [opts.runtimeRoot] directory for the socket; see authorityRuntimeDir
 * @param {string} [opts.socketPath] explicit address, bypassing runtimeRoot
 * @param {string} [opts.secret] injected hook secret, bypassing env and file lookup
 * @param {string} [opts.secretPath] explicit secret file
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {number} [opts.codeTtlSeconds] enrollment-code window, default 120
 * @param {number} [opts.idleTimeoutMs] per-connection read budget, default 5000
 * @param {(entry:object) => void} [opts.log] receives redacted, secret-free entries
 * @returns {Promise<{socketPath:string, close:() => Promise<void>}>}
 */
export function startAuthority(opts) {
  return startAuthoritySocket(opts);
}
